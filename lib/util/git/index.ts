import URL from 'node:url';
import { setTimeout } from 'timers/promises';
import is from '@sindresorhus/is';
import fs from 'fs-extra';
import semver from 'semver';
import type { Options, SimpleGit, TaskOptions } from 'simple-git';
import { ResetMode, simpleGit } from 'simple-git';
import upath from 'upath';
import { configFileNames } from '../../config/app-strings';
import { GlobalConfig } from '../../config/global';
import type { RenovateConfig } from '../../config/types';
import {
  CONFIG_VALIDATION,
  INVALID_PATH,
  REPOSITORY_CHANGED,
  REPOSITORY_DISABLED,
  REPOSITORY_EMPTY,
  SYSTEM_INSUFFICIENT_DISK_SPACE,
  TEMPORARY_ERROR,
  UNKNOWN_ERROR,
} from '../../constants/error-messages';
import { logger } from '../../logger';
import { ExternalHostError } from '../../types/errors/external-host-error';
import type { GitProtocol } from '../../types/git';
import { incLimitedValue } from '../../workers/global/limits';
import { getCache } from '../cache/repository';
import { getEnv } from '../env';
import { newlineRegex, regEx } from '../regex';
import { matchRegexOrGlobList } from '../string-match';
import { parseGitAuthor } from './author';
import {
  getCachedBehindBaseResult,
  setCachedBehindBaseResult,
} from './behind-base-branch-cache';
import { getNoVerify, simpleGitConfig } from './config';
import {
  getCachedConflictResult,
  setCachedConflictResult,
} from './conflicts-cache';
import {
  bulkChangesDisallowed,
  checkForPlatformFailure,
  handleCommitError,
} from './error';
import {
  getCachedModifiedResult,
  setCachedModifiedResult,
} from './modified-cache';
import { configSigningKey, writePrivateKey } from './private-key';
import type {
  CommitFilesConfig,
  CommitResult,
  LocalConfig,
  LongCommitSha,
  PushFilesConfig,
  StatusResult,
  StorageConfig,
  TreeItem,
} from './types';

export { setNoVerify } from './config';
export { setPrivateKey } from './private-key';

// Retry parameters
const retryCount = 5;
const delaySeconds = 3;
const delayFactor = 2;

export const RENOVATE_FORK_UPSTREAM = 'renovate-fork-upstream';

// A generic wrapper for simpleGit.* calls to make them more fault-tolerant
export async function gitRetry<T>(gitFunc: () => Promise<T>): Promise<T> {
  let round = 0;
  let lastError: Error | undefined;

  while (round <= retryCount) {
    if (round > 0) {
      logger.debug(`gitRetry round ${round}`);
    }
    try {
      const res = await gitFunc();
      if (round > 1) {
        logger.debug('Successful retry of git function');
      }
      return res;
    } catch (err) {
      lastError = err;
      logger.debug({ err }, `Git function thrown`);
      // Try to transform the Error to ExternalHostError
      const errChecked = checkForPlatformFailure(err);
      if (errChecked instanceof ExternalHostError) {
        logger.debug(
          { err: errChecked },
          `ExternalHostError thrown in round ${
            round + 1
          } of ${retryCount} - retrying in the next round`,
        );
      } else {
        throw err;
      }
    }

    const nextDelay = delayFactor ^ ((round - 1) * delaySeconds);
    logger.trace({ nextDelay }, `Delay next round`);
    await setTimeout(1000 * nextDelay);

    round++;
  }

  // Can't be `undefined` here.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw lastError;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function getDefaultBranch(git: SimpleGit): Promise<string> {
  logger.debug('getDefaultBranch()');
  // see https://stackoverflow.com/a/62352647/3005034
  try {
    let res = await git.raw(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
    /* v8 ignore start -- TODO: add test */
    if (!res) {
      logger.debug('Could not determine default branch using git rev-parse');
      const headPrefix = 'HEAD branch: ';
      res = (await git.raw(['remote', 'show', 'origin']))
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith(headPrefix))!
        .replace(headPrefix, '');
    }
    /* v8 ignore stop */
    return res.replace('origin/', '').trim();
    /* v8 ignore start -- TODO: add test */
  } catch (err) {
    logger.debug({ err }, 'Error getting default branch');
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    if (
      err.message.startsWith(
        'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
      )
    ) {
      throw new Error(REPOSITORY_EMPTY);
    }
    if (err.message.includes("fatal: ambiguous argument 'origin/HEAD'")) {
      logger.warn('Error getting default branch');
      throw new Error(TEMPORARY_ERROR);
    }
    throw err;
  }
  /* v8 ignore stop */
}

let config: LocalConfig = {} as any;

// TODO: can be undefined
let git: SimpleGit;
let gitInitialized: boolean;
let submodulesInitizialized: boolean;

let privateKeySet = false;

export const GIT_MINIMUM_VERSION = '2.33.0'; // git show-current

export async function validateGitVersion(): Promise<boolean> {
  let version: string | undefined;
  const globalGit = simpleGit();
  try {
    const { major, minor, patch, installed } = await globalGit.version();
    /* v8 ignore next 4 -- TODO: add test */
    if (!installed) {
      logger.error('Git not installed');
      return false;
    }
    version = `${major}.${minor}.${patch}`;
    /* v8 ignore next 4 */
  } catch (err) {
    logger.error({ err }, 'Error fetching git version');
    return false;
  }
  /* v8 ignore next 7 -- TODO: add test */
  if (!(version && semver.gte(version, GIT_MINIMUM_VERSION))) {
    logger.error(
      { detectedVersion: version, minimumVersion: GIT_MINIMUM_VERSION },
      'Git version needs upgrading',
    );
    return false;
  }
  logger.debug(`Found valid git version: ${version}`);
  return true;
}

async function fetchBranchCommits(preferUpstream = true): Promise<void> {
  config.branchCommits = {};
  const url =
    preferUpstream && config.upstreamUrl ? config.upstreamUrl : config.url;
  logger.debug(`fetchBranchCommits(): url=${url}`);
  const opts = ['ls-remote', '--heads', url];
  if (config.extraCloneOpts) {
    Object.entries(config.extraCloneOpts).forEach((e) =>
      // TODO: types (#22198)
      opts.unshift(e[0], `${e[1]!}`),
    );
  }
  try {
    const lsRemoteRes = await gitRetry(() => git.raw(opts));
    logger.trace({ lsRemoteRes }, 'git ls-remote result');
    lsRemoteRes
      .split(newlineRegex)
      .filter(Boolean)
      .map((line) => line.trim().split(regEx(/\s+/)))
      .forEach(([sha, ref]) => {
        config.branchCommits[ref.replace('refs/heads/', '')] =
          sha as LongCommitSha;
      });
    logger.trace({ branchCommits: config.branchCommits }, 'branch commits');
    /* v8 ignore next 11 -- TODO: add test */
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    logger.debug({ err }, 'git error');
    if (err.message?.includes('Please ask the owner to check their account')) {
      throw new Error(REPOSITORY_DISABLED);
    }
    throw err;
  }
}

export async function fetchRevSpec(revSpec: string): Promise<void> {
  await gitRetry(() => git.fetch(['origin', revSpec]));
}

export async function initRepo(args: StorageConfig): Promise<void> {
  config = { ...args } as any;
  config.ignoredAuthors = [];
  config.additionalBranches = [];
  config.branchIsModified = {};
  // TODO: safe to pass all env variables? use `getChildEnv` instead?
  git = simpleGit(GlobalConfig.get('localDir'), simpleGitConfig()).env({
    ...getEnv(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  });
  gitInitialized = false;
  submodulesInitizialized = false;
  await fetchBranchCommits();
}

async function resetToBranch(branchName: string): Promise<void> {
  logger.debug(`resetToBranch(${branchName})`);
  await git.raw(['reset', '--hard']);
  await gitRetry(() => git.checkout(branchName));
  await git.raw(['reset', '--hard', 'origin/' + branchName]);
  await git.raw(['clean', '-fd']);
}

/* v8 ignore next 4 -- TODO: add test */
export async function resetToCommit(commit: LongCommitSha): Promise<void> {
  logger.debug(`resetToCommit(${commit})`);
  await git.raw(['reset', '--hard', commit]);
}

async function deleteLocalBranch(branchName: string): Promise<void> {
  await git.branch(['-D', branchName]);
}

async function cleanLocalBranches(): Promise<void> {
  const existingBranches = (await git.raw(['branch']))
    .split(newlineRegex)
    .map((branch) => branch.trim())
    .filter((branch) => branch.length > 0 && !branch.startsWith('* '));
  logger.debug({ existingBranches });
  for (const branchName of existingBranches) {
    await deleteLocalBranch(branchName);
  }
}

export function setGitAuthor(gitAuthor: string | undefined): void {
  const gitAuthorParsed = parseGitAuthor(
    gitAuthor ?? 'Renovate Bot <renovate@whitesourcesoftware.com>',
  );
  if (!gitAuthorParsed) {
    const error = new Error(CONFIG_VALIDATION);
    error.validationSource = 'None';
    error.validationError = 'Invalid gitAuthor';
    error.validationMessage = `\`gitAuthor\` is not parsed as valid RFC5322 format: \`${gitAuthor!}\``;
    throw error;
  }
  config.gitAuthorName = gitAuthorParsed.name;
  config.gitAuthorEmail = gitAuthorParsed.address;
}

export async function writeGitAuthor(): Promise<void> {
  const { gitAuthorName, gitAuthorEmail, writeGitDone } = config;
  /* v8 ignore next 3 -- TODO: add test */
  if (writeGitDone) {
    return;
  }
  config.writeGitDone = true;
  try {
    if (gitAuthorName) {
      logger.debug(`Setting git author name: ${gitAuthorName}`);
      await git.addConfig('user.name', gitAuthorName);
    }
    if (gitAuthorEmail) {
      logger.debug(`Setting git author email: ${gitAuthorEmail}`);
      await git.addConfig('user.email', gitAuthorEmail);
    }
    /* v8 ignore next 11 -- TODO: add test */
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    logger.debug(
      { err, gitAuthorName, gitAuthorEmail },
      'Error setting git author config',
    );
    throw new Error(TEMPORARY_ERROR);
  }
}

export function setUserRepoConfig({
  gitIgnoredAuthors,
  gitAuthor,
}: RenovateConfig): void {
  config.ignoredAuthors = gitIgnoredAuthors ?? [];
  setGitAuthor(gitAuthor);
}

export async function getSubmodules(): Promise<string[]> {
  try {
    return (
      (await git.raw([
        'config',
        '--file',
        '.gitmodules',
        '--get-regexp',
        '\\.path',
      ])) || ''
    )
      .trim()
      .split(regEx(/[\n\s]/))
      .filter((_e: string, i: number) => i % 2);
    /* v8 ignore next 4 -- TODO: add test */
  } catch (err) {
    logger.warn({ err }, 'Error getting submodules');
    return [];
  }
}

export async function cloneSubmodules(
  shouldClone: boolean,
  cloneSubmodulesFilter: string[] | undefined,
): Promise<void> {
  if (!shouldClone || submodulesInitizialized) {
    return;
  }
  submodulesInitizialized = true;
  await syncGit();
  const submodules = await getSubmodules();
  for (const submodule of submodules) {
    if (!matchRegexOrGlobList(submodule, cloneSubmodulesFilter ?? ['*'])) {
      logger.debug(
        { cloneSubmodulesFilter },
        `Skipping submodule ${submodule}`,
      );
      continue;
    }
    try {
      logger.debug(`Cloning git submodule at ${submodule}`);
      await gitRetry(() =>
        git.submoduleUpdate(['--init', '--recursive', submodule]),
      );
    } catch (err) {
      logger.warn({ err, submodule }, `Unable to initialise git submodule`);
    }
  }
}

export function isCloned(): boolean {
  return gitInitialized;
}

export async function syncGit(): Promise<void> {
  if (gitInitialized) {
    /* v8 ignore next 3 -- TODO: add test */
    if (getEnv().RENOVATE_X_CLEAR_HOOKS) {
      await git.raw(['config', 'core.hooksPath', '/dev/null']);
    }
    return;
  }
  /* v8 ignore next 3 -- failsafe TODO: add test */
  if (GlobalConfig.get('platform') === 'local') {
    throw new Error('Cannot sync git when platform=local');
  }
  gitInitialized = true;
  const localDir = GlobalConfig.get('localDir')!;
  logger.debug(`syncGit(): Initializing git repository into ${localDir}`);
  const gitHead = upath.join(localDir, '.git/HEAD');
  let clone = true;

  if (await fs.pathExists(gitHead)) {
    logger.debug(
      `syncGit(): Found existing git repository, attempting git fetch`,
    );
    try {
      await git.raw(['remote', 'set-url', 'origin', config.url]);
      const fetchStart = Date.now();
      await gitRetry(() => git.fetch(['--prune', 'origin']));
      config.currentBranch =
        config.currentBranch || (await getDefaultBranch(git));
      await resetToBranch(config.currentBranch);
      await cleanLocalBranches();
      const durationMs = Math.round(Date.now() - fetchStart);
      logger.info({ durationMs }, 'git fetch completed');
      clone = false;
      /* v8 ignore next 6 -- TODO: add test */
    } catch (err) {
      if (err.message === REPOSITORY_EMPTY) {
        throw err;
      }
      logger.info({ err }, 'git fetch error, falling back to git clone');
    }
  }
  if (clone) {
    const cloneStart = Date.now();
    try {
      const opts: string[] = [];
      if (config.defaultBranch) {
        opts.push('-b', config.defaultBranch);
      }
      if (config.fullClone) {
        logger.debug('Performing full clone');
      } else {
        logger.debug('Performing blobless clone');
        opts.push('--filter=blob:none');
      }
      if (config.extraCloneOpts) {
        Object.entries(config.extraCloneOpts).forEach((e) =>
          // TODO: types (#22198)
          opts.push(e[0], `${e[1]!}`),
        );
      }
      const emptyDirAndClone = async (): Promise<void> => {
        await fs.emptyDir(localDir);
        await git.clone(config.url, '.', opts);
      };
      await gitRetry(() => emptyDirAndClone());
      /* v8 ignore next 10 -- TODO: add test */
    } catch (err) {
      logger.debug({ err }, 'git clone error');
      if (err.message?.includes('No space left on device')) {
        throw new Error(SYSTEM_INSUFFICIENT_DISK_SPACE);
      }
      if (err.message === REPOSITORY_EMPTY) {
        throw err;
      }
      throw new ExternalHostError(err, 'git');
    }
    const durationMs = Math.round(Date.now() - cloneStart);
    logger.debug({ durationMs }, 'git clone completed');
  }
  try {
    config.currentBranchSha = (
      await git.raw(['rev-parse', 'HEAD'])
    ).trim() as LongCommitSha;
    /* v8 ignore next 6 -- TODO: add test */
  } catch (err) {
    if (err.message?.includes('fatal: not a git repository')) {
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  }
  // This will only happen now if set in global config
  await cloneSubmodules(!!config.cloneSubmodules, config.cloneSubmodulesFilter);
  try {
    const latestCommit = (await git.log({ n: 1 })).latest;
    logger.debug({ latestCommit }, 'latest repository commit');
    /* v8 ignore next 10 -- TODO: add test */
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    if (err.message.includes('does not have any commits yet')) {
      throw new Error(REPOSITORY_EMPTY);
    }
    logger.warn({ err }, 'Cannot retrieve latest commit');
  }
  config.currentBranch =
    config.currentBranch ??
    config.defaultBranch ??
    (await getDefaultBranch(git));
  /* v8 ignore next -- TODO: add test */
  delete getCache()?.semanticCommits;

  // If upstreamUrl is set then the bot is running in fork mode
  // The "upstream" remote is the original repository which was forked from
  if (config.upstreamUrl) {
    logger.debug(
      `Bringing default branch up-to-date with ${RENOVATE_FORK_UPSTREAM}, to get latest config`,
    );
    // Add remote if it does not exist
    const remotes = await git.getRemotes(true);
    if (!remotes.some((remote) => remote.name === RENOVATE_FORK_UPSTREAM)) {
      logger.debug(`Adding remote ${RENOVATE_FORK_UPSTREAM}`);
      await git.addRemote(RENOVATE_FORK_UPSTREAM, config.upstreamUrl);
    }
    await syncForkWithUpstream(config.currentBranch);
    await fetchBranchCommits(false);
  }

  config.currentBranchSha = (
    await git.revparse('HEAD')
  ).trim() as LongCommitSha;
  logger.debug(`Current branch SHA: ${config.currentBranchSha}`);
}

export async function getRepoStatus(path?: string): Promise<StatusResult> {
  if (is.string(path)) {
    const localDir = GlobalConfig.get('localDir');
    const localPath = upath.resolve(localDir, path);
    if (!localPath.startsWith(upath.resolve(localDir))) {
      logger.warn(
        { localPath, localDir },
        'Preventing access to file outside the local directory',
      );
      throw new Error(INVALID_PATH);
    }
  }

  await syncGit();
  return git.status(path ? [path] : []);
}

export function branchExists(branchName: string): boolean {
  return !!config.branchCommits[branchName];
}

// Return the commit SHA for a branch
export function getBranchCommit(branchName: string): LongCommitSha | null {
  return config.branchCommits[branchName] || null;
}

export async function getCommitMessages(): Promise<string[]> {
  logger.debug('getCommitMessages');
  if (GlobalConfig.get('platform') !== 'local') {
    await syncGit();
  }
  try {
    const res = await git.log({
      n: 20,
      format: { message: '%s' },
    });
    return res.all.map((commit) => commit.message);
    /* v8 ignore next 3 -- TODO: add test */
  } catch {
    return [];
  }
}

export async function checkoutBranch(
  branchName: string,
): Promise<LongCommitSha> {
  logger.debug(`Setting current branch to ${branchName}`);
  await syncGit();
  try {
    await gitRetry(() =>
      git.checkout(
        submodulesInitizialized
          ? ['-f', '--recurse-submodules', branchName, '--']
          : ['-f', branchName, '--'],
      ),
    );
    config.currentBranch = branchName;
    config.currentBranchSha = (
      await git.raw(['rev-parse', 'HEAD'])
    ).trim() as LongCommitSha;
    const latestCommitDate = (await git.log({ n: 1 }))?.latest?.date;
    if (latestCommitDate) {
      logger.debug(
        { branchName, latestCommitDate, sha: config.currentBranchSha },
        'latest commit',
      );
    }
    await git.reset(ResetMode.HARD);
    return config.currentBranchSha;
    /* v8 ignore next 11 -- TODO: add test */
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    if (err.message?.includes('fatal: ambiguous argument')) {
      logger.warn({ err }, 'Failed to checkout branch');
      throw new Error(TEMPORARY_ERROR);
    }
    throw err;
  }
}

export async function checkoutBranchFromRemote(
  branchName: string,
  remoteName: string,
): Promise<LongCommitSha> {
  logger.debug(`Checking out branch ${branchName} from remote ${remoteName}`);
  await syncGit();
  try {
    await gitRetry(() =>
      git.checkoutBranch(branchName, `${remoteName}/${branchName}`),
    );
    config.currentBranch = branchName;
    config.currentBranchSha = (
      await git.revparse('HEAD')
    ).trim() as LongCommitSha;
    logger.debug(`Checked out branch ${branchName} from remote ${remoteName}`);
    config.branchCommits[branchName] = config.currentBranchSha;
    return config.currentBranchSha;
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    /* v8 ignore next 3 -- hard to test */
    if (errChecked) {
      throw errChecked;
    }
    if (err.message?.includes('fatal: ambiguous argument')) {
      logger.warn({ err }, 'Failed to checkout branch');
      throw new Error(TEMPORARY_ERROR);
    }
    throw err;
  }
}

export async function resetHardFromRemote(
  remoteAndBranch: string,
): Promise<void> {
  try {
    const resetLog = await git.reset(['--hard', remoteAndBranch]);
    logger.debug({ resetLog }, 'git reset log');
  } catch (err) {
    logger.error({ err }, 'Error during git reset --hard');
    throw err;
  }
}

export async function forcePushToRemote(
  branchName: string,
  remote: string,
): Promise<void> {
  try {
    const pushLog = await git.push([remote, branchName, '--force']);
    logger.debug({ pushLog }, 'git push log');
  } catch (err) {
    logger.error({ err }, 'Error during git push --force');
    throw err;
  }
}

export async function getFileList(): Promise<string[]> {
  await syncGit();
  const branch = config.currentBranch;
  let files: string;
  try {
    files = await git.raw(['ls-tree', '-r', `refs/heads/${branch}`]);
    /* v8 ignore next 10 -- TODO: add test */
  } catch (err) {
    if (err.message?.includes('fatal: Not a valid object name')) {
      logger.debug(
        { err },
        'Branch not found when checking branch list - aborting',
      );
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  }
  /* v8 ignore next 3 -- TODO: add test */
  if (!files) {
    return [];
  }
  // submodules are starting with `160000 commit`
  return files
    .split(newlineRegex)
    .filter(is.string)
    .filter((line) => line.startsWith('100'))
    .map((line) => line.split(regEx(/\t/)).pop()!);
}

export function getBranchList(): string[] {
  return Object.keys(config.branchCommits ?? {});
}

export async function isBranchBehindBase(
  branchName: string,
  baseBranch: string,
): Promise<boolean> {
  const baseBranchSha = getBranchCommit(baseBranch);
  const branchSha = getBranchCommit(branchName);
  let isBehind = getCachedBehindBaseResult(
    branchName,
    branchSha,
    baseBranch,
    baseBranchSha,
  );
  if (isBehind !== null) {
    logger.debug(`branch.isBehindBase(): using cached result "${isBehind}"`);
    return isBehind;
  }

  logger.debug('branch.isBehindBase(): using git to calculate');

  await syncGit();
  try {
    const behindCount = (
      await git.raw(['rev-list', '--count', `${branchSha!}..${baseBranchSha!}`])
    ).trim();
    isBehind = behindCount !== '0';
    logger.debug(
      { baseBranch, branchName },
      `branch.isBehindBase(): ${isBehind}`,
    );
    setCachedBehindBaseResult(branchName, isBehind);
    return isBehind;
    /* v8 ignore next 7 -- TODO: add test */
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    throw err;
  }
}

export async function isBranchModified(
  branchName: string,
  baseBranch: string,
): Promise<boolean> {
  if (!branchExists(branchName)) {
    logger.debug('branch.isModified(): no cache');
    return false;
  }
  // First check local config
  if (config.branchIsModified[branchName] !== undefined) {
    return config.branchIsModified[branchName];
  }
  // Second check repository cache
  const isModified = getCachedModifiedResult(
    branchName,
    getBranchCommit(branchName), // branch sha
  );
  if (isModified !== null) {
    logger.debug(`branch.isModified(): using cached result "${isModified}"`);
    config.branchIsModified[branchName] = isModified;
    return isModified;
  }

  logger.debug('branch.isModified(): using git to calculate');

  await syncGit();
  const committedAuthors = new Set<string>();
  try {
    const commits = await git.log([
      `origin/${baseBranch}..origin/${branchName}`,
    ]);

    for (const commit of commits.all) {
      committedAuthors.add(commit.author_email);
    }
    /* v8 ignore next 10 -- TODO: add test */
  } catch (err) {
    if (err.message?.includes('fatal: bad revision')) {
      logger.debug(
        { err },
        'Remote branch not found when checking last commit author - aborting run',
      );
      throw new Error(REPOSITORY_CHANGED);
    }
    logger.warn({ err }, 'Error checking last author for isBranchModified');
  }
  const { gitAuthorEmail, ignoredAuthors } = config;

  const includedAuthors = new Set(committedAuthors);

  if (gitAuthorEmail) {
    includedAuthors.delete(gitAuthorEmail);
  }

  for (const ignoredAuthor of ignoredAuthors) {
    includedAuthors.delete(ignoredAuthor);
  }

  if (includedAuthors.size === 0) {
    // authors all match - branch has not been modified
    logger.trace(
      {
        branchName,
        baseBranch,
        committedAuthors: [...committedAuthors],
        includedAuthors: [...includedAuthors],
        gitAuthorEmail,
        ignoredAuthors,
      },
      'branch.isModified() = false',
    );
    logger.debug('branch.isModified() = false');
    config.branchIsModified[branchName] = false;
    setCachedModifiedResult(branchName, false);
    return false;
  }
  logger.trace(
    {
      branchName,
      baseBranch,
      committedAuthors: [...committedAuthors],
      includedAuthors: [...includedAuthors],
      gitAuthorEmail,
      ignoredAuthors,
    },
    'branch.isModified() = true',
  );
  logger.debug(
    { branchName, unrecognizedAuthors: [...includedAuthors] },
    'branch.isModified() = true',
  );
  config.branchIsModified[branchName] = true;
  setCachedModifiedResult(branchName, true);
  return true;
}

export async function isBranchConflicted(
  baseBranch: string,
  branch: string,
): Promise<boolean> {
  logger.debug(`isBranchConflicted(${baseBranch}, ${branch})`);

  const baseBranchSha = getBranchCommit(baseBranch);
  const branchSha = getBranchCommit(branch);
  if (!baseBranchSha || !branchSha) {
    logger.warn(
      { baseBranch, branch },
      'isBranchConflicted: branch does not exist',
    );
    return true;
  }

  const isConflicted = getCachedConflictResult(
    branch,
    branchSha,
    baseBranch,
    baseBranchSha,
  );
  if (is.boolean(isConflicted)) {
    logger.debug(
      `branch.isConflicted(): using cached result "${isConflicted}"`,
    );
    return isConflicted;
  }

  logger.debug('branch.isConflicted(): using git to calculate');

  let result = false;
  await syncGit();
  await writeGitAuthor();

  const origBranch = config.currentBranch;
  try {
    await git.reset(ResetMode.HARD);
    //TODO: see #18600
    if (origBranch !== baseBranch) {
      await git.checkout(baseBranch);
    }
    await git.merge(['--no-commit', '--no-ff', `origin/${branch}`]);
  } catch (err) {
    result = true;
    /* v8 ignore next 6 -- TODO: add test */
    if (!err?.git?.conflicts?.length) {
      logger.debug(
        { baseBranch, branch, err },
        'isBranchConflicted: unknown error',
      );
    }
  } finally {
    try {
      await git.merge(['--abort']);
      if (origBranch !== baseBranch) {
        await git.checkout(origBranch);
      }
      /* v8 ignore next 6 -- TODO: add test */
    } catch (err) {
      logger.debug(
        { baseBranch, branch, err },
        'isBranchConflicted: cleanup error',
      );
    }
  }

  setCachedConflictResult(branch, result);
  logger.debug(`branch.isConflicted(): ${result}`);
  return result;
}

export async function deleteBranch(branchName: string): Promise<void> {
  await syncGit();
  try {
    const deleteCommand = ['push', '--delete', 'origin', branchName];

    if (getNoVerify().includes('push')) {
      deleteCommand.push('--no-verify');
    }

    await gitRetry(() => git.raw(deleteCommand));
    logger.debug(`Deleted remote branch: ${branchName}`);
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    /* v8 ignore next 3 -- TODO: add test */
    if (errChecked) {
      throw errChecked;
    }
    logger.debug(`No remote branch to delete with name: ${branchName}`);
  }
  try {
    /* v8 ignore next 2 -- TODO: add test (always throws) */
    await deleteLocalBranch(branchName);
    logger.debug(`Deleted local branch: ${branchName}`);
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    /* v8 ignore next 3 -- TODO: add test */
    if (errChecked) {
      throw errChecked;
    }
    logger.debug(`No local branch to delete with name: ${branchName}`);
  }
  delete config.branchCommits[branchName];
}

export async function mergeToLocal(refSpecToMerge: string): Promise<void> {
  let status: StatusResult | undefined;
  try {
    await syncGit();
    await writeGitAuthor();
    await git.reset(ResetMode.HARD);
    await gitRetry(() =>
      git.checkout([
        '-B',
        config.currentBranch,
        'origin/' + config.currentBranch,
      ]),
    );
    status = await git.status();
    await fetchRevSpec(refSpecToMerge);
    await gitRetry(() => git.merge(['FETCH_HEAD']));
  } catch (err) {
    logger.debug(
      {
        baseBranch: config.currentBranch,
        baseSha: config.currentBranchSha,
        refSpecToMerge,
        status,
        err,
      },
      'mergeLocally error',
    );
    throw err;
  }
}

export async function mergeBranch(branchName: string): Promise<void> {
  let status: StatusResult | undefined;
  try {
    await syncGit();
    await writeGitAuthor();
    await git.reset(ResetMode.HARD);
    await gitRetry(() =>
      git.checkout(['-B', branchName, 'origin/' + branchName]),
    );
    await gitRetry(() =>
      git.checkout([
        '-B',
        config.currentBranch,
        'origin/' + config.currentBranch,
      ]),
    );
    status = await git.status();
    await gitRetry(() => git.merge(['--ff-only', branchName]));
    await gitRetry(() => git.push('origin', config.currentBranch));
    incLimitedValue('Commits');
  } catch (err) {
    logger.debug(
      {
        baseBranch: config.currentBranch,
        baseSha: config.currentBranchSha,
        branchName,
        branchSha: getBranchCommit(branchName),
        status,
        err,
      },
      'mergeBranch error',
    );
    throw err;
  }
}

export async function getBranchLastCommitTime(
  branchName: string,
): Promise<Date> {
  await syncGit();
  try {
    const time = await git.show(['-s', '--format=%ai', 'origin/' + branchName]);
    return new Date(Date.parse(time));
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    /* v8 ignore next 3 -- TODO: add test */
    if (errChecked) {
      throw errChecked;
    }
    return new Date();
  }
}

export function getBranchFiles(branchName: string): Promise<string[] | null> {
  return getBranchFilesFromRef(`origin/${branchName}`);
}

export function getBranchFilesFromCommit(
  referenceCommit: LongCommitSha,
): Promise<string[] | null> {
  return getBranchFilesFromRef(referenceCommit);
}

async function getBranchFilesFromRef(
  refName: string,
): Promise<string[] | null> {
  await syncGit();
  try {
    const diff = await gitRetry(() =>
      git.diffSummary([refName, `${refName}^`]),
    );
    return diff.files.map((file) => file.file);
    /* v8 ignore next 8 -- TODO: add test */
  } catch (err) {
    logger.warn({ err }, 'getBranchFilesFromRef error');
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    return null;
  }
}

export async function getFile(
  filePath: string,
  branchName?: string,
): Promise<string | null> {
  await syncGit();
  try {
    const content = await git.show([
      'origin/' + (branchName ?? config.currentBranch) + ':' + filePath,
    ]);
    return content;
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    /* v8 ignore next 3 -- TODO: add test */
    if (errChecked) {
      throw errChecked;
    }
    return null;
  }
}

export async function getFiles(
  fileNames: string[],
): Promise<Record<string, string | null>> {
  const fileContentMap: Record<string, string | null> = {};

  for (const fileName of fileNames) {
    fileContentMap[fileName] = await getFile(fileName);
  }

  return fileContentMap;
}

export async function hasDiff(
  sourceRef: string,
  targetRef: string,
): Promise<boolean> {
  await syncGit();
  try {
    return (
      (await gitRetry(() => git.diff([sourceRef, targetRef, '--']))) !== ''
    );
  } catch {
    return true;
  }
}

async function handleCommitAuth(localDir: string): Promise<void> {
  if (!privateKeySet) {
    await writePrivateKey();
    privateKeySet = true;
  }
  await configSigningKey(localDir);
  await writeGitAuthor();
}

/**
 *
 * Prepare local branch with commit
 *
 * 0. Hard reset
 * 1. Creates local branch with `origin/` prefix
 * 2. Perform `git add` (respecting mode) and `git remove` for each file
 * 3. Perform commit
 * 4. Check whether resulting commit is empty or not (due to .gitignore)
 * 5. If not empty, return commit info for further processing
 *
 */
export async function prepareCommit({
  branchName,
  files,
  message,
  force = false,
}: CommitFilesConfig): Promise<CommitResult | null> {
  const localDir = GlobalConfig.get('localDir')!;
  await syncGit();
  logger.debug(`Preparing files for committing to branch ${branchName}`);
  await handleCommitAuth(localDir);
  try {
    await git.reset(ResetMode.HARD);
    await git.raw(['clean', '-fd']);
    const parentCommitSha = config.currentBranchSha;
    await gitRetry(() =>
      git.checkout(['-B', branchName, 'origin/' + config.currentBranch]),
    );
    const deletedFiles: string[] = [];
    const addedModifiedFiles: string[] = [];
    const ignoredFiles: string[] = [];
    for (const file of files) {
      const fileName = file.path;
      if (file.type === 'deletion') {
        try {
          await git.rm([fileName]);
          deletedFiles.push(fileName);
          /* v8 ignore next 8 -- TODO: add test */
        } catch (err) {
          const errChecked = checkForPlatformFailure(err);
          if (errChecked) {
            throw errChecked;
          }
          logger.trace({ err, fileName }, 'Cannot delete file');
          ignoredFiles.push(fileName);
        }
      } else {
        if (await isDirectory(upath.join(localDir, fileName))) {
          // This is usually a git submodule update
          logger.trace({ fileName }, 'Adding directory commit');
        } else if (file.contents === null) {
          continue;
        } else {
          let contents: Buffer;
          if (typeof file.contents === 'string') {
            contents = Buffer.from(file.contents);
            /* v8 ignore next 3 -- TODO: add test */
          } else {
            contents = file.contents;
          }
          // some file systems including Windows don't support the mode
          // so the index should be manually updated after adding the file
          if (file.isSymlink) {
            await fs.symlink(file.contents, upath.join(localDir, fileName));
          } else {
            await fs.outputFile(upath.join(localDir, fileName), contents, {
              mode: file.isExecutable ? 0o777 : 0o666,
            });
          }
        }
        try {
          /* v8 ignore next 2 -- TODO: add test */
          const addParams =
            fileName === configFileNames[0] ? ['-f', fileName] : fileName;
          await git.add(addParams);
          if (file.isExecutable) {
            await git.raw(['update-index', '--chmod=+x', fileName]);
          }
          addedModifiedFiles.push(fileName);
          /* v8 ignore next 11 -- TODO: add test */
        } catch (err) {
          if (
            !err.message.includes(
              'The following paths are ignored by one of your .gitignore files',
            )
          ) {
            throw err;
          }
          logger.debug(`Cannot commit ignored file: ${fileName}`);
          ignoredFiles.push(file.path);
        }
      }
    }

    const commitOptions: Options = {};
    if (getNoVerify().includes('commit')) {
      commitOptions['--no-verify'] = null;
    }

    const commitRes = await git.commit(message, [], commitOptions);
    if (
      commitRes.summary &&
      commitRes.summary.changes === 0 &&
      commitRes.summary.insertions === 0 &&
      commitRes.summary.deletions === 0
    ) {
      logger.warn({ commitRes }, 'Detected empty commit - aborting git push');
      return null;
    }
    logger.debug(
      { deletedFiles, ignoredFiles, result: commitRes },
      `git commit`,
    );
    if (!force && !(await hasDiff('HEAD', `origin/${branchName}`))) {
      logger.debug(
        { branchName, deletedFiles, addedModifiedFiles, ignoredFiles },
        'No file changes detected. Skipping commit',
      );
      return null;
    }

    const commitSha = (
      await git.revparse([branchName])
    ).trim() as LongCommitSha;
    const result: CommitResult = {
      parentCommitSha,
      commitSha,
      files: files.filter((fileChange) => {
        if (fileChange.type === 'deletion') {
          return deletedFiles.includes(fileChange.path);
        }
        return addedModifiedFiles.includes(fileChange.path);
      }),
    };

    return result;
    /* v8 ignore next 3 -- TODO: add test */
  } catch (err) {
    return handleCommitError(err, branchName, files);
  }
}

export async function pushCommit({
  sourceRef,
  targetRef,
  files,
  pushOptions,
}: PushFilesConfig): Promise<boolean> {
  await syncGit();
  logger.debug(`Pushing refSpec ${sourceRef}:${targetRef ?? sourceRef}`);
  let result = false;
  try {
    const gitOptions: TaskOptions = {
      '--force-with-lease': null,
      '-u': null,
    };
    if (getNoVerify().includes('push')) {
      gitOptions['--no-verify'] = null;
    }
    if (pushOptions) {
      gitOptions['--push-option'] = pushOptions;
    }

    const pushRes = await gitRetry(() =>
      git.push('origin', `${sourceRef}:${targetRef ?? sourceRef}`, gitOptions),
    );
    delete pushRes.repo;
    logger.debug({ result: pushRes }, 'git push');
    incLimitedValue('Commits');
    result = true;
    /* v8 ignore next 3 -- TODO: add test */
  } catch (err) {
    handleCommitError(err, sourceRef, files);
  }
  return result;
}

export async function fetchBranch(
  branchName: string,
): Promise<LongCommitSha | null> {
  await syncGit();
  logger.debug(`Fetching branch ${branchName}`);
  try {
    const ref = `refs/heads/${branchName}:refs/remotes/origin/${branchName}`;
    await gitRetry(() => git.pull(['origin', ref, '--force']));
    const commit = (await git.revparse([branchName])).trim() as LongCommitSha;
    config.branchCommits[branchName] = commit;
    config.branchIsModified[branchName] = false;
    return commit;
    /* v8 ignore next 3 -- TODO: add test */
  } catch (err) {
    return handleCommitError(err, branchName);
  }
}

export async function commitFiles(
  commitConfig: CommitFilesConfig,
): Promise<LongCommitSha | null> {
  try {
    const commitResult = await prepareCommit(commitConfig);
    if (commitResult) {
      const pushResult = await pushCommit({
        sourceRef: commitConfig.branchName,
        files: commitConfig.files,
      });
      if (pushResult) {
        const { branchName } = commitConfig;
        const { commitSha } = commitResult;
        config.branchCommits[branchName] = commitSha;
        config.branchIsModified[branchName] = false;
        return commitSha;
      }
    }
    return null;
    /* v8 ignore next 6 -- TODO: add test */
  } catch (err) {
    if (err.message.includes('[rejected] (stale info)')) {
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  }
}

export function getUrl({
  protocol,
  auth,
  hostname,
  host,
  repository,
}: {
  protocol?: GitProtocol;
  auth?: string;
  hostname?: string;
  host?: string;
  repository: string;
}): string {
  if (protocol === 'ssh') {
    // TODO: types (#22198)
    return `git@${hostname!}:${repository}.git`;
  }
  return URL.format({
    protocol: protocol ?? 'https',
    auth,
    hostname,
    host,
    pathname: repository + '.git',
  });
}

let remoteRefsExist = false;

/**
 *
 * Non-branch refs allow us to store git objects without triggering CI pipelines.
 * It's useful for API-based branch rebasing.
 *
 * @see https://stackoverflow.com/questions/63866947/pushing-git-non-branch-references-to-a-remote/63868286
 *
 */
export async function pushCommitToRenovateRef(
  commitSha: string,
  refName: string,
): Promise<void> {
  const fullRefName = `refs/renovate/branches/${refName}`;
  await git.raw(['update-ref', fullRefName, commitSha]);
  await git.push(['--force', 'origin', fullRefName]);
  remoteRefsExist = true;
}

/**
 *
 * Removes all remote "refs/renovate/branches/*" refs in two steps:
 *
 * Step 1: list refs
 *
 *   $ git ls-remote origin "refs/renovate/branches/*"
 *
 *   > cca38e9ea6d10946bdb2d0ca5a52c205783897aa        refs/renovate/branches/foo
 *   > 29ac154936c880068994e17eb7f12da7fdca70e5        refs/renovate/branches/bar
 *   > 3fafaddc339894b6d4f97595940fd91af71d0355        refs/renovate/branches/baz
 *   > ...
 *
 * Step 2:
 *
 *   $ git push --delete origin refs/renovate/branches/foo refs/renovate/branches/bar refs/renovate/branches/baz
 *
 * If Step 2 fails because the repo doesn't allow bulk changes, we'll remove them one by one instead:
 *
 *   $ git push --delete origin refs/renovate/branches/foo
 *   $ git push --delete origin refs/renovate/branches/bar
 *   $ git push --delete origin refs/renovate/branches/baz
 */
export async function clearRenovateRefs(): Promise<void> {
  if (!gitInitialized || !remoteRefsExist) {
    return;
  }

  logger.debug(`Cleaning up Renovate refs: refs/renovate/branches/*`);
  const renovateRefs: string[] = [];

  try {
    const rawOutput = await git.listRemote([
      config.url,
      'refs/renovate/branches/*',
    ]);
    const refs = rawOutput
      .split(newlineRegex)
      .map((line) => line.replace(regEx(/[0-9a-f]+\s+/i), '').trim())
      .filter((line) => line.startsWith('refs/renovate/branches/'));
    renovateRefs.push(...refs);
    /* v8 ignore next 3 -- TODO: add test */
  } catch (err) {
    logger.warn({ err }, `Renovate refs cleanup error`);
  }

  if (renovateRefs.length) {
    try {
      const pushOpts = ['--delete', 'origin', ...renovateRefs];
      await git.push(pushOpts);
    } catch (err) {
      if (bulkChangesDisallowed(err)) {
        for (const ref of renovateRefs) {
          try {
            const pushOpts = ['--delete', 'origin', ref];
            await git.push(pushOpts);
            /* v8 ignore next 4 -- TODO: add test */
          } catch (err) {
            logger.debug({ err }, 'Error deleting "refs/renovate/branches/*"');
            break;
          }
        }
        /* v8 ignore next 3 -- TODO: add test */
      } else {
        logger.warn({ err }, 'Error deleting "refs/renovate/branches/*"');
      }
    }
  }

  remoteRefsExist = false;
}

const treeItemRegex = regEx(
  /^(?<mode>\d{6})\s+(?<type>blob|tree|commit)\s+(?<sha>[0-9a-f]{40})\s+(?<path>.*)$/,
);

const treeShaRegex = regEx(/tree\s+(?<treeSha>[0-9a-f]{40})\s*/);

/**
 *
 * Obtain top-level items of commit tree.
 * We don't need subtree items, so here are 2 steps only.
 *
 * Step 1: commit SHA -> tree SHA
 *
 *   $ git cat-file -p <commit-sha>
 *
 *   > tree <tree-sha>
 *   > parent 59b8b0e79319b7dc38f7a29d618628f3b44c2fd7
 *   > ...
 *
 * Step 2: tree SHA -> tree items (top-level)
 *
 *   $ git cat-file -p <tree-sha>
 *
 *   > 040000 tree 389400684d1f004960addc752be13097fe85d776    src
 *   > ...
 *   > 100644 blob 7d2edde437ad4e7bceb70dbfe70e93350d99c98b    package.json
 *
 */
export async function listCommitTree(
  commitSha: LongCommitSha,
): Promise<TreeItem[]> {
  const commitOutput = await git.catFile(['-p', commitSha]);
  const { treeSha } =
    /* v8 ignore next -- will never happen ? */
    treeShaRegex.exec(commitOutput)?.groups ?? {};
  const contents = await git.catFile(['-p', treeSha]);
  const lines = contents.split(newlineRegex);
  const result: TreeItem[] = [];
  for (const line of lines) {
    const matchGroups = treeItemRegex.exec(line)?.groups;
    if (matchGroups) {
      const { path, mode, type, sha } = matchGroups;
      result.push({ path, mode, type, sha: sha as LongCommitSha });
    }
  }
  return result;
}

async function localBranchExists(branchName: string): Promise<boolean> {
  await syncGit();
  const localBranches = await git.branchLocal();
  return localBranches.all.includes(branchName);
}

/**
 * Synchronize a forked branch with its upstream counterpart.
 *
 * syncForkWithUpstream updates the fork's branch, to match the corresponding branch in the upstream repository.
 * The steps are:
 * 1. Check if the branch exists locally.
 * 2. If the branch exists locally: checkout the local branch.
 * 3. If the branch does _not_ exist locally: checkout the upstream branch.
 * 4. Reset the local branch to match the upstream branch.
 * 5. Force push the (updated) local branch to the origin repository.
 *
 * @param {string} branchName - The name of the branch to synchronize.
 * @returns A promise that resolves to True if the synchronization is successful, or `false` if an error occurs.
 */
export async function syncForkWithUpstream(branchName: string): Promise<void> {
  if (!config.upstreamUrl) {
    return;
  }
  logger.debug(
    `Synchronizing fork with "${RENOVATE_FORK_UPSTREAM}" remote for branch ${branchName}`,
  );
  const remotes = await getRemotes();
  /* v8 ignore next 3 -- this should not be possible if upstreamUrl exists */
  if (!remotes.some((r) => r === RENOVATE_FORK_UPSTREAM)) {
    throw new Error('No upstream remote exists, cannot sync fork');
  }
  try {
    await git.fetch([RENOVATE_FORK_UPSTREAM]);
    if (await localBranchExists(branchName)) {
      await checkoutBranch(branchName);
    } else {
      await checkoutBranchFromRemote(branchName, RENOVATE_FORK_UPSTREAM);
    }
    await resetHardFromRemote(`${RENOVATE_FORK_UPSTREAM}/${branchName}`);
    await forcePushToRemote(branchName, 'origin');
  } catch (err) /* v8 ignore next 3 -- shouldn't happen */ {
    logger.error({ err }, 'Error synchronizing fork');
    throw new Error(UNKNOWN_ERROR);
  }
}

export async function getRemotes(): Promise<string[]> {
  logger.debug('git.getRemotes()');
  try {
    await syncGit();
    const remotes = await git.getRemotes();
    logger.debug(`Found remotes: ${remotes.map((r) => r.name).join(', ')}`);
    return remotes.map((remote) => remote.name);
  } catch (err) /* v8 ignore start */ {
    logger.error({ err }, 'Error getting remotes');
    throw err;
  } /* v8 ignore stop */
}

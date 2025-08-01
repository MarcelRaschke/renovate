import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { ExternalHostError } from '../../../types/errors/external-host-error';
import { cache } from '../../../util/cache/package/decorator';
import { HttpError } from '../../../util/http';
import { regEx } from '../../../util/regex';
import { asTimestamp } from '../../../util/timestamp';
import { id as semverId } from '../../versioning/semver';
import { Datasource } from '../datasource';
import type { GetReleasesConfig, ReleaseResult } from '../types';
import { datasource, defaultRegistryUrl } from './common';
import type { PackageType } from './types';

export class HexpmBobDatasource extends Datasource {
  static readonly id = datasource;

  constructor() {
    super(datasource);
  }

  override readonly customRegistrySupport = true;

  override readonly defaultRegistryUrls = [defaultRegistryUrl];

  override readonly caching = true;

  override readonly defaultVersioning = semverId;

  override readonly releaseTimestampSupport = true;
  override readonly releaseTimestampNote =
    'The release timestamp is determined from the `buildDate` field in the results.';
  override readonly sourceUrlSupport = 'package';
  override readonly sourceUrlNote =
    'We use the URL https://github.com/elixir-lang/elixir.git for the `elixir` package and the https://github.com/erlang/otp.git URL for the `erlang` package.';

  @cache({
    namespace: `datasource-${datasource}`,
    key: ({ registryUrl, packageName }: GetReleasesConfig) =>
      `${registryUrl}:${packageName}`,
  })
  async getReleases({
    registryUrl,
    packageName,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    const packageType = HexpmBobDatasource.getPackageType(packageName);

    if (!packageType) {
      return null;
    }

    logger.trace(
      { registryUrl, packageName },
      `fetching hex.pm bob ${packageName} release`,
    );

    const url = `${registryUrl!}/builds/${packageName}/builds.txt`;

    const result: ReleaseResult = {
      releases: [],
      ...HexpmBobDatasource.getPackageDetails(packageType),
    };
    try {
      const { body } = await this.http.getText(url);
      result.releases = body
        .split('\n')
        .map((line) => line.trim())
        .filter(is.nonEmptyString)
        .map((line) => {
          const [version, gitRef, buildDate] = line.split(' ');

          return {
            gitRef,
            isStable: HexpmBobDatasource.isStable(version, packageType),
            releaseTimestamp: asTimestamp(buildDate),
            version: HexpmBobDatasource.cleanVersion(version, packageType),
          };
        });
    } catch (err) {
      if (err instanceof HttpError && err.response?.statusCode !== 404) {
        throw new ExternalHostError(err);
      }
      this.handleGenericErrors(err);
    }

    return result.releases.length > 0 ? result : null;
  }

  private static getPackageType(packageName: string): PackageType | null {
    if (packageName === 'elixir') {
      return 'elixir';
    }
    if (/^otp\/\w+-\d+\.\d+$/.test(packageName)) {
      return 'erlang';
    }
    return null;
  }

  private static cleanVersion(
    version: string,
    packageType: PackageType,
  ): string {
    switch (packageType) {
      case 'elixir':
        return version.replace(/^v/, '');
      case 'erlang':
        return version.replace(/^OTP-/, '');
    }
  }

  private static isStable(version: string, packageType: PackageType): boolean {
    switch (packageType) {
      case 'elixir':
        return regEx(/^v\d+\.\d+\.\d+($|-otp)/).test(version);
      case 'erlang':
        return version.startsWith('OTP-');
    }
  }

  private static getPackageDetails(
    packageType: PackageType,
  ): Omit<ReleaseResult, 'releases'> {
    switch (packageType) {
      case 'elixir':
        return {
          homepage: 'https://elixir-lang.org/',
          sourceUrl: 'https://github.com/elixir-lang/elixir.git',
        };
      case 'erlang':
        return {
          homepage: 'https://www.erlang.org/',
          sourceUrl: 'https://github.com/erlang/otp.git',
        };
    }
  }
}

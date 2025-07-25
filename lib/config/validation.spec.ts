import { getManagerList } from '../modules/manager';
import { configFileNames } from './app-strings';
import { GlobalConfig } from './global';
import type { RenovateConfig } from './types';
import * as configValidation from './validation';
import { partial } from '~test/util';

const managerList = getManagerList().sort();

describe('config/validation', () => {
  describe('validateConfig(config)', () => {
    it('returns deprecation warnings', async () => {
      const config = {
        prTitle: 'something',
      };
      const { warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings).toMatchSnapshot();
    });

    it('allow enabled field in vulnerabilityAlerts', async () => {
      const config = {
        vulnerabilityAlerts: {
          enabled: false,
        },
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toHaveLength(0);
      expect(warnings).toHaveLength(0);
    });

    it('catches global options in repo config', async () => {
      const config = {
        binarySource: 'something',
        username: 'user',
      };
      const { warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(2);
      expect(warnings).toMatchObject([
        {
          message: `The "binarySource" option is a global option reserved only for Renovate's global configuration and cannot be configured within a repository's config file.`,
        },
        {
          message: `The "username" option is a global option reserved only for Renovate's global configuration and cannot be configured within a repository's config file.`,
        },
      ]);
    });

    it('catches global options in inherit config', async () => {
      const config = {
        binarySource: 'something',
        username: 'user',
      };
      const { warnings } = await configValidation.validateConfig(
        'inherit',
        config,
      );
      expect(warnings).toHaveLength(2);
      expect(warnings).toMatchObject([
        {
          message: `The "binarySource" option is a global option reserved only for Renovate's global configuration and cannot be configured within a repository's config file.`,
        },
        {
          message: `The "username" option is a global option reserved only for Renovate's global configuration and cannot be configured within a repository's config file.`,
        },
      ]);
    });

    it('only warns for actual globals in repo config', async () => {
      const config = {
        hostRules: [
          {
            username: 'user',
            token: 'token',
            password: 'pass',
          },
        ],
      };
      const { warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
    });

    it('does not warn for valid inheritConfig', async () => {
      const config = {
        onboarding: false,
      };
      const { warnings } = await configValidation.validateConfig(
        'inherit',
        config,
      );
      expect(warnings).toHaveLength(0);
    });

    it('does not warn for valid platformConfig', async () => {
      const config = {
        platformConfig: 'auto',
      };
      const { warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
    });

    it('warns for invalid platformConfig', async () => {
      const config = {
        platformConfig: 'invalid',
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toHaveLength(1);
    });

    it('catches invalid templates', async () => {
      const config = {
        commitMessage: '{{{something}}',
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toHaveLength(1);
      expect(errors).toMatchSnapshot();
    });

    it('catches invalid jsonata expressions', async () => {
      const config = {
        packageRules: [
          {
            matchJsonata: ['packageName = "foo"', '{{{something wrong}'],
            enabled: true,
          },
        ],
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Invalid JSONata expression');
    });

    it('catches invalid allowedVersions regex', async () => {
      const config = {
        packageRules: [
          {
            matchPackageNames: ['foo'],
            allowedVersions: '/^2/',
          },
          {
            matchPackageNames: ['bar'],
            allowedVersions: '/***$}{]][/',
          },
          {
            matchPackageNames: ['baz'],
            allowedVersions: '!/^2/',
          },
          {
            matchPackageNames: ['quack'],
            allowedVersions: '!/***$}{]][/',
          },
          {
            matchPackageNames: ['quack'],
            allowedVersions: '/quaCk/i',
          },
        ],
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toHaveLength(2);
      expect(errors).toMatchSnapshot();
    });

    it('catches invalid matchCurrentValue', async () => {
      const config = {
        packageRules: [
          {
            matchPackageNames: ['foo'],
            matchCurrentValue: '/^2/',
            enabled: true,
          },
          {
            matchPackageNames: ['bar'],
            matchCurrentValue: '^1',
            enabled: true,
          },
          {
            matchPackageNames: ['quack'],
            matchCurrentValue: '<1.0.0',
            enabled: true,
          },
          {
            matchPackageNames: ['foo'],
            matchCurrentValue: '/^2/i',
            enabled: true,
          },
          {
            matchPackageNames: ['bad'],
            matchNewValue: '/^2(/',
            enabled: true,
          },
        ],
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toHaveLength(1);
    });

    it('catches invalid matchNewValue', async () => {
      const config = {
        packageRules: [
          {
            matchPackageNames: ['foo'],
            matchNewValue: '/^2/',
            enabled: true,
          },
          {
            matchPackageNames: ['bar'],
            matchNewValue: '^1',
            enabled: true,
          },
          {
            matchPackageNames: ['quack'],
            matchNewValue: '<1.0.0',
            enabled: true,
          },
          {
            matchPackageNames: ['foo'],
            matchNewValue: '/^2/i',
            enabled: true,
          },
          {
            matchPackageNames: ['bad'],
            matchNewValue: '/^2(/',
            enabled: true,
          },
        ],
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toHaveLength(1);
    });

    it('validates matchBaseBranches', async () => {
      const config = {
        baseBranchPatterns: ['foo'],
        packageRules: [
          {
            matchBaseBranches: ['foo'],
            addLabels: ['foo'],
          },
        ],
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toHaveLength(0);
      expect(warnings).toHaveLength(0);
    });

    it('catches invalid matchBaseBranches when baseBranchPatterns is not defined', async () => {
      const config = {
        packageRules: [
          {
            matchBaseBranches: ['foo'],
            addLabels: ['foo'],
          },
        ],
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toHaveLength(0);
      expect(warnings).toHaveLength(1);
    });

    it('catches invalid matchCurrentVersion regex', async () => {
      const config = {
        packageRules: [
          {
            matchPackageNames: ['foo'],
            matchCurrentVersion: '/^2/',
            enabled: true,
          },
          {
            matchPackageNames: ['bar'],
            matchCurrentVersion: '/***$}{]][/',
            enabled: true,
          },
          {
            matchPackageNames: ['baz'],
            matchCurrentVersion: '!/^2/',
            enabled: true,
          },
          {
            matchPackageNames: ['quack'],
            matchCurrentVersion: '!/***$}{]][/',
            enabled: true,
          },
          {
            matchPackageNames: ['foo'],
            matchCurrentVersion: '/^2/i',
            enabled: true,
          },
        ],
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toHaveLength(2);
      expect(errors).toMatchSnapshot();
    });

    it('catches invalid customDatasources content', async () => {
      const config = {
        customDatasources: {
          foo: {
            description: 3,
            randomKey: '',
            defaultRegistryUrlTemplate: [],
            transformTemplates: [{}],
          },
          bar: {
            description: 'foo',
            defaultRegistryUrlTemplate: 'bar',
            transformTemplates: ['foo = "bar"', 'bar[0'],
          },
        },
      } as any;
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toMatchObject([
        {
          message:
            'Invalid `customDatasources.defaultRegistryUrlTemplate` configuration: is a string',
        },
        {
          message:
            'Invalid `customDatasources.description` configuration: is not an array of strings',
        },
        {
          message:
            'Invalid `customDatasources.randomKey` configuration: key is not allowed',
        },
        {
          message:
            'Invalid `customDatasources.transformTemplates` configuration: is not an array of string',
        },
      ]);
    });

    it('validates invalid statusCheckNames', async () => {
      const config = {
        statusCheckNames: {
          randomKey: '',
          mergeConfidence: 10,
          configValidation: '',
          artifactError: null,
        },
      };
      // @ts-expect-error invalid options
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toMatchObject([
        {
          message:
            'Invalid `statusCheckNames.mergeConfidence` configuration: status check is not a string.',
        },
        {
          message:
            'Invalid `statusCheckNames.statusCheckNames.randomKey` configuration: key is not allowed.',
        },
      ]);
      expect(errors).toHaveLength(2);
    });

    it('catches invalid customDatasources record type', async () => {
      const config = {
        customDatasources: {
          randomKey: '',
        },
      } as any;
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toMatchObject([
        {
          message:
            'Invalid `customDatasources.randomKey` configuration: customDatasource is not an object',
        },
      ]);
    });

    it('catches invalid baseBranchPatterns regex', async () => {
      const config = {
        baseBranchPatterns: ['/***$}{]][/', '/branch/i'],
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toEqual([
        {
          topic: 'Configuration Error',
          message: 'Invalid regExp for baseBranchPatterns: `/***$}{]][/`',
        },
      ]);
    });

    it('returns nested errors', async () => {
      const config: RenovateConfig = {
        foo: 1,
        schedule: ['after 5pm'],
        timezone: 'Asia/Singapore',
        packageRules: [
          {
            matchPackageNames: [
              '*',
              '/abc ([a-z]+) ([a-z]+))/',
              '!/abc ([a-z]+) ([a-z]+))/',
            ],
            enabled: true,
          },
        ],
        lockFileMaintenance: {
          bar: 2,
        },
        major: null,
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(4);
      expect(errors).toMatchSnapshot();
    });

    it('included managers of the wrong type', async () => {
      const config = {
        packageRules: [
          {
            matchManagers: 'string not an array',
            enabled: true,
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as any,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors).toMatchSnapshot();
    });

    it.each([
      ['empty configuration', {}],
      ['configuration with enabledManagers empty', { enabledManagers: [] }],
      ['single enabled manager', { enabledManagers: ['npm'] }],
      [
        'multiple enabled managers',
        {
          enabledManagers: ['npm', 'gradle', 'maven', 'custom.regex'],
        },
      ],
    ])('validates enabled managers for %s', async (_case, config) => {
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it.each([
      ['single not supported manager', { enabledManagers: ['foo'] }],
      ['multiple not supported managers', { enabledManagers: ['foo', 'bar'] }],
      [
        'combined supported and not supported managers',
        { enabledManagers: ['foo', 'npm', 'gradle', 'maven'] },
      ],
    ])(
      'errors if included not supported enabled managers for %s',
      async (_case, config) => {
        const { warnings, errors } = await configValidation.validateConfig(
          'repo',
          config,
        );
        expect(warnings).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors).toMatchSnapshot();
      },
    );

    it('errors for all types', async () => {
      const config: RenovateConfig = {
        allowedVersions: 'foo',
        enabled: 1 as any,
        enabledManagers: ['npm'],
        schedule: ['every 15 mins every weekday'],
        timezone: 'Asia',
        labels: 5 as any,
        azureWorkItemId: false as any,
        semanticCommitType: 7 as any,
        lockFileMaintenance: false as any,
        extends: [':timezone(Europe/Brussel)'],
        packageRules: [
          {
            foo: 1,
          },
          'what?' as any,
          {
            matchPackageNames: '/abc ([a-z]+) ([a-z]+))/',
            matchDepNames: ['abc ([a-z]+) ([a-z]+))'],
            enabled: false,
          },
        ],
        major: null,
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(1);
      expect(errors).toMatchSnapshot();
      expect(errors).toHaveLength(12);
    });

    it('selectors outside packageRules array trigger errors', async () => {
      const config = {
        matchDepNames: ['angular'],
        matchPackageNames: ['angular'],
        meteor: {
          packageRules: [
            {
              matchDepNames: ['meteor'],
              matchPackageNames: ['meteor'],
              enabled: true,
            },
          ],
        },
        ansible: {
          minor: {
            matchDepNames: ['meteor'],
            matchPackageNames: ['testPackage'],
          },
        },
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(4);
      expect(errors).toMatchSnapshot();
      expect(errors).toHaveLength(4);
    });

    it('ignore packageRule nesting validation for presets', async () => {
      const config = {
        description: ['All angular.js packages'],
        matchPackageNames: [
          'angular',
          'angular-animate',
          'angular-scroll',
          'angular-sanitize',
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchSnapshot();
      expect(errors).toHaveLength(0);
    });

    it('errors for unsafe managerFilePatterns', async () => {
      const config = {
        npm: {
          managerFilePatterns: ['/abc ([a-z]+) ([a-z]+))/'],
        },
        dockerfile: {
          managerFilePatterns: ['/x?+/'],
        },
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(2);
      expect(errors).toMatchSnapshot();
    });

    it('validates regEx for each managerFilePatterns of format regex', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['/js/', '/***$}{]][/'],
            matchStrings: ['^(?<depName>foo)(?<currentValue>bar)$'],
            datasourceTemplate: 'maven',
            versioningTemplate: 'gradle',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors).toMatchSnapshot();
    });

    it('errors if customManager has empty managerFilePatterns', async () => {
      const config = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: [],
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as any,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "message": "Each Custom Manager must contain a non-empty managerFilePatterns array",
            "topic": "Configuration Error",
          },
        ]
      `);
    });

    it('errors if no customManager customType', async () => {
      const config = {
        customManagers: [
          {
            managerFilePatterns: ['some-file'],
            matchStrings: ['^(?<depName>foo)(?<currentValue>bar)$'],
            datasourceTemplate: 'maven',
            versioningTemplate: 'gradle',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as any,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "message": "Each Custom Manager must contain a non-empty customType string",
            "topic": "Configuration Error",
          },
        ]
      `);
    });

    it('errors if invalid customManager customType', async () => {
      const config = {
        customManagers: [
          {
            customType: 'unknown',
            managerFilePatterns: ['some-file'],
            matchStrings: ['^(?<depName>foo)(?<currentValue>bar)$'],
            datasourceTemplate: 'maven',
            versioningTemplate: 'gradle',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as any,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "message": "Invalid customType: unknown. Key is not a custom manager",
            "topic": "Configuration Error",
          },
        ]
      `);
    });

    it('errors if empty customManager matchStrings', async () => {
      const config = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['foo'],
            matchStrings: [],
            depNameTemplate: 'foo',
            datasourceTemplate: 'bar',
            currentValueTemplate: 'baz',
          },
          {
            customType: 'jsonata',
            fileFormat: 'json',
            managerFilePatterns: ['foo'],
            depNameTemplate: 'foo',
            datasourceTemplate: 'bar',
            currentValueTemplate: 'baz',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as RenovateConfig,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(2);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "message": "Each Custom Manager \`matchStrings\` array must have at least one item.",
            "topic": "Configuration Error",
          },
          {
            "message": "Each Custom Manager must contain a non-empty matchStrings array",
            "topic": "Configuration Error",
          },
        ]
      `);
    });

    it('errors if no customManager managerFilePatterns', async () => {
      const config = {
        customManagers: [
          {
            matchStrings: ['^(?<depName>foo)(?<currentValue>bar)$'],
            datasourceTemplate: 'maven',
            versioningTemplate: 'gradle',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as any,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('validates regEx for each matchStrings', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['Dockerfile'],
            matchStrings: ['***$}{]]['],
            depNameTemplate: 'foo',
            datasourceTemplate: 'bar',
            currentValueTemplate: 'baz',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('error if no fileFormat in custom JSONata manager', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'jsonata',
            managerFilePatterns: ['package.json'],
            matchStrings: [
              'packages.{"depName": name, "currentValue": version, "datasource": "npm"}',
            ],
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          topic: 'Configuration Error',
          message: 'Each JSONata manager must contain a fileFormat field.',
        },
      ]);
    });

    it('validates JSONata query for each matchStrings', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'jsonata',
            fileFormat: 'json',
            managerFilePatterns: ['package.json'],
            matchStrings: ['packages.{'],
            depNameTemplate: 'foo',
            datasourceTemplate: 'bar',
            currentValueTemplate: 'baz',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          topic: 'Configuration Error',
          message: `Invalid JSONata query for customManagers: \`packages.{\``,
        },
      ]);
    });

    // testing if we get all errors at once or not (possible), this does not include customType or managerFilePatterns
    // since they are common to all custom managers
    it('validates all possible regex manager options', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['Dockerfile'],
            matchStrings: ['***$}{]]['], // invalid matchStrings regex, no depName, datasource and currentValue
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(4);
    });

    it('passes if customManager fields are present', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['Dockerfile'],
            matchStrings: ['ENV (?<currentValue>.*?)\\s'],
            depNameTemplate: 'foo',
            datasourceTemplate: 'bar',
            registryUrlTemplate: 'foobar',
            extractVersionTemplate: '^(?<version>v\\d+\\.\\d+)',
            depTypeTemplate: 'apple',
          },
          {
            customType: 'jsonata',
            fileFormat: 'json',
            managerFilePatterns: ['package.json'],
            matchStrings: [
              'packages.{"depName": depName, "currentValue": version, "datasource": "npm"}',
            ],
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('errors if extra customManager fields are present', async () => {
      const config = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['Dockerfile'],
            matchStrings: ['ENV (?<currentValue>.*?)\\s'],
            depNameTemplate: 'foo',
            datasourceTemplate: 'bar',
            depTypeTemplate: 'apple',
            automerge: true,
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as any,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('errors if customManager fields are missing', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['Dockerfile'],
            matchStrings: ['ENV (.*?)\\s'],
            depNameTemplate: 'foo',
            datasourceTemplate: 'bar',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchSnapshot();
      expect(errors).toHaveLength(1);
    });

    it('errors if customManager fields are missing: JSONataManager', async () => {
      const config: RenovateConfig = {
        customManagers: [
          {
            customType: 'jsonata',
            fileFormat: 'json',
            managerFilePatterns: ['package.json'],
            matchStrings: ['packages'],
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          topic: 'Configuration Error',
          message: `JSONata Managers must contain currentValueTemplate configuration or currentValue in the query `,
        },
        {
          topic: 'Configuration Error',
          message: `JSONata Managers must contain datasourceTemplate configuration or datasource in the query `,
        },
        {
          topic: 'Configuration Error',
          message: `JSONata Managers must contain depName or packageName in the query or their templates`,
        },
      ]);
    });

    it('ignore keys', async () => {
      const config = {
        $schema: 'renovate.json',
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('validates timezone preset', async () => {
      const config = {
        extends: [':timezone', ':timezone(Europe/Berlin)'],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('does not validate constraints children', async () => {
      const config = {
        constraints: { packageRules: [{}] },
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config as never, // TODO: #15963
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('validates object with ignored children', async () => {
      const config = {
        prBodyDefinitions: {},
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('validates valid registryAlias objects', async () => {
      const config = {
        registryAliases: {
          example1: 'http://www.example.com',
          example2: 'https://www.example2.com/example',
        },
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('errors if registryAliases depth is more than 1', async () => {
      const config = {
        registryAliases: {
          sample: {
            example1: 'http://www.example.com',
          } as unknown as string, // intentional incorrect config to check error message
        },
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          message:
            'Invalid `registryAliases.registryAliases.sample` configuration: value is not a string',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('errors if registryAliases have invalid value', async () => {
      const config = {
        registryAliases: {
          example1: 123 as never,
          example2: 'http://www.example.com',
        },
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          message:
            'Invalid `registryAliases.registryAliases.example1` configuration: value is not a string',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('errors if managerFilePatterns has wrong parent', async () => {
      const config: RenovateConfig = {
        managerFilePatterns: ['foo'],
        npm: {
          managerFilePatterns: ['package\\.json'],
          minor: {
            managerFilePatterns: ['bar'],
          },
        },
        customManagers: [
          {
            customType: 'regex',
            managerFilePatterns: ['build.gradle'],
            matchStrings: ['^(?<depName>foo)(?<currentValue>bar)$'],
            datasourceTemplate: 'maven',
            versioningTemplate: 'gradle',
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );

      expect(errors).toHaveLength(0);
      expect(warnings).toHaveLength(2);
      expect(warnings).toMatchSnapshot();
    });

    it('errors if manager objects are nested', async () => {
      const config = {
        pyenv: {
          enabled: false,
        },
        maven: {
          gradle: {
            enabled: false,
          },
        },
      } as never;
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toHaveLength(1);
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchSnapshot();
    });

    it('warns if hostType has the wrong parent', async () => {
      const config = {
        hostType: 'npm',
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings).toMatchSnapshot();
    });

    it('validates preset values', async () => {
      const config = {
        extends: ['foo', 'bar', 42] as never,
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('warns if only selectors in packageRules', async () => {
      const config = {
        packageRules: [{ matchDepTypes: ['foo'], matchPackageNames: ['bar'] }],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings).toMatchSnapshot();
      expect(errors).toHaveLength(0);
    });

    it('errors if invalid combinations in packageRules', async () => {
      const config = {
        packageRules: [
          {
            matchUpdateTypes: ['major'],
            registryUrls: ['https://registry.npmjs.org'],
          },
        ],
      } as any;
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors).toMatchSnapshot();
    });

    it('warns on nested group packageRules', async () => {
      const config = {
        extends: ['group:fortawesome'],
        packageRules: [
          {
            automerge: true,
            extends: ['group:fortawesome'],
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(errors).toHaveLength(0);
      expect(warnings).toHaveLength(1);
    });

    // adding this test explicitly because we used to validate the customEnvVariables inside repo config previously
    it('warns if customEnvVariables are found in repo config', async () => {
      const config = {
        customEnvVariables: {
          example1: 'abc',
          example2: 123,
        },
      };
      const { warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toMatchObject([
        {
          topic: 'Configuration Error',
          message: `The "customEnvVariables" option is a global option reserved only for Renovate's global configuration and cannot be configured within a repository's config file.`,
        },
      ]);
    });

    it('errors if schedule is cron and has no * minutes', async () => {
      const config = {
        schedule: ['30 5 * * *'],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          message:
            'Invalid schedule: `Invalid schedule: "30 5 * * *" has cron syntax, but doesn\'t have * as minutes`',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('errors if invalid matchHost values in hostRules', async () => {
      GlobalConfig.set({ allowedHeaders: ['X-*'] });

      const config = {
        hostRules: [
          {
            matchHost: '://',
            token: 'token',
          },
          {
            matchHost: '',
            token: 'token',
          },
          {
            matchHost: undefined,
            token: 'token',
          },
          {
            hostType: 'github',
            token: 'token',
          },
        ],
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toMatchObject([
        {
          topic: 'Configuration Error',
          message:
            'Configuration option `hostRules[2].matchHost` should be a string',
        },
        {
          topic: 'Configuration Error',
          message:
            'Invalid value for hostRules matchHost. It cannot be an empty string.',
        },
        {
          topic: 'Configuration Error',
          message: 'hostRules matchHost `://` is not a valid URL.',
        },
      ]);
    });

    it('errors if forbidden header in hostRules', async () => {
      GlobalConfig.set({ allowedHeaders: ['X-*'] });

      const config = {
        hostRules: [
          {
            matchHost: 'https://domain.com/all-versions',
            headers: {
              'X-Auth-Token': 'token',
              unallowedHeader: 'token',
            },
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          message:
            "hostRules header `unallowedHeader` is not allowed by this bot's `allowedHeaders`.",
          topic: 'Configuration Error',
        },
      ]);
    });

    it('errors if headers values are not string', async () => {
      GlobalConfig.set({ allowedHeaders: ['X-*'] });

      const config = {
        hostRules: [
          {
            matchHost: 'https://domain.com/all-versions',
            headers: {
              'X-Auth-Token': 10,
            } as unknown as Record<string, string>,
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          message:
            'Invalid hostRules headers value configuration: header must be a string.',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('errors if allowedHeaders is empty or not defined', async () => {
      GlobalConfig.set({});

      const config = {
        hostRules: [
          {
            matchHost: 'https://domain.com/all-versions',
            headers: {
              'X-Auth-Token': 'token',
            },
          },
        ],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toMatchObject([
        {
          message:
            "hostRules header `X-Auth-Token` is not allowed by this bot's `allowedHeaders`.",
          topic: 'Configuration Error',
        },
      ]);
    });

    it('catches invalid variable name in env config option', async () => {
      GlobalConfig.set({ allowedEnv: ['SOME*'] });
      const config = {
        env: {
          randomKey: '',
          SOME_VAR: 'some_value',
          SOME_OTHER_VAR: 10,
        },
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'repo',
        // @ts-expect-error: testing invalid values in env object
        config,
      );
      expect(errors).toMatchObject([
        {
          message:
            "Env variable name `randomKey` is not allowed by this bot's `allowedEnv`.",
        },
        {
          message:
            'Invalid env variable value: `env.SOME_OTHER_VAR` must be a string.',
        },
      ]);
      expect(errors).toHaveLength(2);
      expect(warnings).toHaveLength(0);
    });

    it('catches env config option if configured inside a parent', async () => {
      GlobalConfig.set({ allowedEnv: ['SOME*'] });
      const config = {
        npm: {
          env: {
            SOME_VAR: 'some_value',
          },
        },
        packageRules: [
          {
            matchManagers: ['regex'],
            env: {
              SOME_VAR: 'some_value',
            },
          },
        ],
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toMatchObject([
        {
          message:
            'The "env" object can only be configured at the top level of a config but was found inside "npm"',
          topic: 'Configuration Error',
        },
        {
          message:
            'The "env" object can only be configured at the top level of a config but was found inside "packageRules[0]"',
          topic: 'Configuration Error',
        },
      ]);
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(2);
    });

    it('catches when * or ** is combined with others patterns in a regexOrGlob option', async () => {
      const config = {
        packageRules: [
          {
            matchRepositories: ['groupA/**', 'groupB/**'], // valid
            enabled: false,
          },
          {
            matchRepositories: ['*', 'repo'], // invalid
            enabled: true,
          },
        ],
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toMatchObject([
        {
          message:
            'packageRules[1].matchRepositories: Your input contains * or ** along with other patterns. Please remove them, as * or ** matches all patterns.',
          topic: 'Configuration Error',
        },
      ]);
      expect(errors).toHaveLength(1);
      expect(warnings).toHaveLength(0);
    });

    it('catches when negative number is used for integer type', async () => {
      const config = {
        azureWorkItemId: -2,
      };
      const { errors } = await configValidation.validateConfig('repo', config);
      expect(errors).toMatchObject([
        {
          message:
            'Configuration option `azureWorkItemId` should be a positive integer. Found negative value instead.',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates prPriority', async () => {
      const config = {
        packageRules: [
          {
            matchDepNames: ['somedep'],
            prPriority: -2,
          },
          {
            matchDepNames: ['some-other-dep'],
            prPriority: 2,
          },
        ],
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'repo',
        config,
      );
      expect(errors).toBeEmptyArray();
      expect(warnings).toBeEmptyArray();
    });
  });

  describe('validateConfig() -> globaOnly options', () => {
    it('returns errors for invalid options', async () => {
      const config = {
        logFile: 'something',
        logFileLevel: 'DEBUG',
      };
      const { errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(errors).toMatchObject([
        {
          message: 'Invalid configuration option: logFile',
          topic: 'Configuration Error',
        },
        {
          message: 'Invalid configuration option: logFileLevel',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates hostRules.headers', async () => {
      const config = {
        hostRules: [
          {
            matchHost: 'https://domain.com/all-versions',
            headers: {
              'X-Auth-Token': 'token',
            },
          },
        ],
        allowedHeaders: ['X-Auth-Token'],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('errors if hostRules.headers is defined but allowedHeaders is not', async () => {
      const config = {
        hostRules: [
          {
            matchHost: 'https://domain.com/all-versions',
            headers: {
              'X-Auth-Token': 'token',
            },
          },
        ],
      };
      const { errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(errors).toMatchObject([
        {
          message:
            "hostRules header `X-Auth-Token` is not allowed by this bot's `allowedHeaders`.",
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates env', async () => {
      const config = {
        env: {
          SOME_VAR: 'SOME_VALUE',
        },
        allowedEnv: ['SOME*'],
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('errors if env object is defined but allowedEnv is empty or undefined', async () => {
      const config = {
        env: {
          SOME_VAR: 'SOME_VALUE',
        },
      };
      const { errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(errors).toMatchObject([
        {
          message:
            "Env variable name `SOME_VAR` is not allowed by this bot's `allowedEnv`.",
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates options with different type but defaultValue=null', async () => {
      const config = {
        minimumReleaseAge: null,
        groupName: null,
        groupSlug: null,
        dependencyDashboardLabels: null,
        defaultRegistryUrls: null,
        registryUrls: null,
        hostRules: [
          {
            artifactAuth: null,
            concurrentRequestLimit: null,
            httpsCertificate: null,
            httpsPrivateKey: null,
            httpsCertificateAuthority: null,
          },
        ],
        encrypted: null,
        milestone: null,
        branchConcurrentLimit: null,
        hashedBranchLength: null,
        assigneesSampleSize: null,
        reviewersSampleSize: null,
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        // @ts-expect-error: contains invalid values
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  });

  describe('validate globalOptions()', () => {
    it('binarySource', async () => {
      const config = {
        binarySource: 'invalid' as never,
      };
      const { warnings } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toEqual([
        {
          message:
            'Invalid value `invalid` for `binarySource`. The allowed values are docker, global, install, hermit.',
          topic: 'Configuration Error',
        },
      ]);
    });

    describe('validates string type options', () => {
      it('binarySource', async () => {
        const config = {
          binarySource: 'invalid' as never,
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            message:
              'Invalid value `invalid` for `binarySource`. The allowed values are docker, global, install, hermit.',
            topic: 'Configuration Error',
          },
        ]);
      });

      it('baseDir', async () => {
        const config = {
          baseDir: false as never,
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            message: 'Configuration option `baseDir` should be a string.',
            topic: 'Configuration Error',
          },
        ]);
      });

      it('requireConfig', async () => {
        const config = {
          requireConfig: 'invalid' as never,
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            message:
              'Invalid value `invalid` for `requireConfig`. The allowed values are required, optional, ignored.',
            topic: 'Configuration Error',
          },
        ]);
      });

      it('dryRun', async () => {
        const config = {
          dryRun: 'invalid' as never,
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            message:
              'Invalid value `invalid` for `dryRun`. The allowed values are extract, lookup, full.',
            topic: 'Configuration Error',
          },
        ]);
      });

      it('repositoryCache', async () => {
        const config = {
          repositoryCache: 'invalid' as never,
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            message:
              'Invalid value `invalid` for `repositoryCache`. The allowed values are enabled, disabled, reset.',
            topic: 'Configuration Error',
          },
        ]);
      });

      it('onboardingConfigFileName', async () => {
        const config = {
          onboardingConfigFileName: 'invalid' as never,
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            message: `Invalid value \`invalid\` for \`onboardingConfigFileName\`. The allowed values are ${configFileNames.join(', ')}.`,
            topic: 'Configuration Error',
          },
        ]);
      });

      it('onboardingConfig', async () => {
        const config = {
          onboardingConfig: {
            extends: ['config:recommended'],
            binarySource: 'global', // should not allow globalOnly options inside onboardingConfig
            managerFilePatterns: ['somefile'], // invalid at top level
          },
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect.assertions(1);
        expect(warnings).toEqual([
          {
            topic: 'Configuration Error',
            message: `The "binarySource" option is a global option reserved only for Renovate's global configuration and cannot be configured within a repository's config file.`,
          },
          {
            topic: 'managerFilePatterns',
            message: `managerFilePatterns should only be configured within one of "${managerList.join(' or ')} or customManagers" objects. Was found in .`,
          },
        ]);
      });

      it('force', async () => {
        const config = {
          force: {
            extends: ['config:recommended'],
            binarySource: 'global',
            managerFilePatterns: ['somefile'], // invalid at top level
            constraints: {
              python: '2.7',
            },
          },
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            topic: 'managerFilePatterns',
            message: `managerFilePatterns should only be configured within one of "${managerList.join(' or ')} or customManagers" objects. Was found in .`,
          },
        ]);
      });

      it('gitUrl', async () => {
        const config = {
          gitUrl: 'invalid' as never,
        };
        const { warnings } = await configValidation.validateConfig(
          'global',
          config,
        );
        expect(warnings).toEqual([
          {
            message:
              'Invalid value `invalid` for `gitUrl`. The allowed values are default, ssh, endpoint.',
            topic: 'Configuration Error',
          },
        ]);
      });
    });

    it('validates boolean type options', async () => {
      const config = {
        unicodeEmoji: false,
        detectGlobalManagerConfig: 'invalid-type',
      };
      const { warnings } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toMatchObject([
        {
          message: `Configuration option \`detectGlobalManagerConfig\` should be a boolean. Found: ${JSON.stringify(
            'invalid-type',
          )} (string).`,
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates integer type options', async () => {
      const config = {
        prCommitsPerRunLimit: 2,
        gitTimeout: 'invalid-type',
      };
      const { warnings } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toMatchObject([
        {
          message: `Configuration option \`gitTimeout\` should be an integer. Found: ${JSON.stringify(
            'invalid-type',
          )} (string).`,
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates array type options', async () => {
      const config = {
        allowedCommands: ['cmd'],
        checkedBranches: 'invalid-type',
        gitNoVerify: ['invalid'],
        mergeConfidenceDatasources: [1],
      };
      const { warnings } = await configValidation.validateConfig(
        'global',
        // @ts-expect-error: contains invalid values
        config,
      );
      expect(warnings).toMatchObject([
        {
          message:
            'Configuration option `checkedBranches` should be a list (Array).',
          topic: 'Configuration Error',
        },
        {
          topic: 'Configuration Error',
          message:
            'Invalid value `1` for `mergeConfidenceDatasources`. The allowed values are go, maven, npm, nuget, packagist, pypi, rubygems.',
        },
        {
          message:
            'Invalid value for `gitNoVerify`. The allowed values are commit, push.',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates object type options', async () => {
      const config = {
        productLinks: {
          documentation: 'https://docs.renovatebot.com/',
          help: 'https://github.com/renovatebot/renovate/discussions',
          homepage: 'https://github.com/renovatebot/renovate',
        },
        secrets: 'invalid-type',
        cacheTtlOverride: {
          someField: false,
        },
      };
      const { warnings } = await configValidation.validateConfig(
        'global',
        // @ts-expect-error: contains invalid values
        config,
      );
      expect(warnings).toMatchObject([
        {
          topic: 'Configuration Error',
          message:
            'Configuration option `cacheTtlOverride.someField` should be an integer. Found: false (boolean).',
        },
        {
          message: 'Configuration option `secrets` should be a JSON object.',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('warns if negative number is used for integer type', async () => {
      const config = {
        prCommitsPerRunLimit: -2,
      };
      const { warnings } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toMatchObject([
        {
          message:
            'Configuration option `prCommitsPerRunLimit` should be a positive integer. Found negative value instead.',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('warns on invalid customEnvVariables objects', async () => {
      const config = {
        customEnvVariables: {
          example1: 'abc',
          example2: 123,
        },
      };
      const { warnings } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toMatchObject([
        {
          message:
            'Invalid `customEnvVariables.example2` configuration: value must be a string.',
          topic: 'Configuration Error',
        },
      ]);
    });

    it('validates valid customEnvVariables objects', async () => {
      const config = {
        customEnvVariables: {
          example1: 'abc',
          example2: 'https://www.example2.com/example',
        },
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('validates options with different type but defaultValue=null', async () => {
      const config = {
        onboardingCommitMessage: null,
        dryRun: null,
        logContext: null,
        endpoint: null,
        skipInstalls: null,
        autodiscoverFilter: null,
        autodiscoverNamespaces: null,
        autodiscoverTopics: null,
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        // @ts-expect-error: contains invalid values
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('fails for missing reportPath if reportType is "s3"', async () => {
      const config: RenovateConfig = {
        reportType: 's3',
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('validates reportPath if reportType is "s3"', async () => {
      const config: RenovateConfig = {
        reportType: 's3',
        reportPath: 's3://bucket-name/key-name',
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('fails for missing reportPath if reportType is "file"', async () => {
      const config: RenovateConfig = {
        reportType: 'file',
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('validates reportPath if reportType is "file"', async () => {
      const config: RenovateConfig = {
        reportType: 'file',
        reportPath: './report.json',
      };
      const { warnings, errors } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('catches when * or ** is combined with others patterns in a regexOrGlob option', async () => {
      const config = {
        packageRules: [
          {
            matchRepositories: ['*', 'repo'], // invalid
            enabled: false,
          },
        ],
        allowedHeaders: ['*', '**'], // invalid
        autodiscoverProjects: ['**', 'project'], // invalid
        allowedEnv: ['env_var'], // valid
      };
      const { errors, warnings } = await configValidation.validateConfig(
        'global',
        config,
      );
      expect(warnings).toMatchObject([
        {
          message:
            'allowedHeaders: Your input contains * or ** along with other patterns. Please remove them, as * or ** matches all patterns.',
          topic: 'Configuration Error',
        },
        {
          message:
            'autodiscoverProjects: Your input contains * or ** along with other patterns. Please remove them, as * or ** matches all patterns.',
          topic: 'Configuration Error',
        },
      ]);

      expect(errors).toMatchObject([
        {
          message:
            'packageRules[0].matchRepositories: Your input contains * or ** along with other patterns. Please remove them, as * or ** matches all patterns.',
          topic: 'Configuration Error',
        },
      ]);
      expect(warnings).toHaveLength(2);
      expect(errors).toHaveLength(1);
    });

    it('errors if no bumpVersion filePattern is provided', async () => {
      const config = partial<RenovateConfig>({
        bumpVersion: {
          matchStrings: ['^(?<depName>foo)(?<currentValue>bar)$'],
          bumpType: 'patch',
        },
        packageRules: [
          {
            matchPackageNames: ['foo'],
            bumpVersion: {
              matchStrings: ['^(?<depName>foo)(?<currentValue>bar)$'],
              bumpType: 'patch',
            },
          },
        ],
      });
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(2);
    });

    it('errors if no matchStrings are provided for bumpVersion', async () => {
      const config = partial<RenovateConfig>({
        bumpVersion: {
          filePatterns: ['foo'],
        },
        packageRules: [
          {
            matchPackageNames: ['foo'],
            bumpVersion: {
              filePatterns: ['bar'],
            },
          },
        ],
      });
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(2);
    });

    it('allow bumpVersion ', async () => {
      const config = partial<RenovateConfig>({
        bumpVersion: {
          filePatterns: ['foo'],
        },
        packageRules: [
          {
            matchPackageNames: ['foo'],
            bumpVersion: {
              filePatterns: ['bar'],
            },
          },
        ],
      });
      const { warnings, errors } = await configValidation.validateConfig(
        'repo',
        config,
        true,
      );
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(2);
    });
  });
});

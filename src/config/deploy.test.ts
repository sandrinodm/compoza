import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { buildingRoles } from '../roles.ts';
import {
  composeFilesOf,
  DeployConfig,
  directoriesOf,
  environmentOf,
  ingressOf,
  loadApp,
  removedRolesOf,
  roleRemovalIssue,
  rolesOf,
  selectDestination,
  workingDirectoryOf,
} from './deploy.ts';

/**
 * Runs `use` with a fresh temporary folder and removes the folder afterwards, whether `use`
 * succeeds or fails.
 */
function withTempDir<A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-'))),
    (directory) => use(directory.path),
    (directory) => Effect.promise(() => directory.remove()),
  );
}

const valid = {
  name: 'demo',
  host: 'atlas',
  roles: {
    builder: { build: { target: 'builder' } },
    web: { build: { target: 'web' }, environment: { MODE: 'a' }, secrets: ['TOKEN'] },
  },
  composeFiles: ['compose.yaml', 'compose.production.yaml'],
  ingress: {
    caddy: { domain: 'demo.example.com', upstream: 'demo-web:80', healthPath: '/healthz' },
  },
  directories: ['/srv/demo/data'],
  content: { demo: '/srv/demo/data/demo' },
  environment: { DEMO_PORT: '8090' },
  local: { composeFiles: ['compose.yaml'], environment: { DEMO_SOURCES_PATH: '../sources' } },
};

const caddy = valid.ingress.caddy;

describe('DeployConfig', () => {
  it.effect('accepts a complete config', () =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(DeployConfig)(valid);
      assert.strictEqual(config.name, 'demo');
      assert.deepStrictEqual(directoriesOf(config), ['/srv/demo/data', '/srv/demo/data/demo']);
      assert.deepStrictEqual(composeFilesOf(config), ['compose.yaml', 'compose.production.yaml']);
      assert.deepStrictEqual(composeFilesOf(config, { local: true }), ['compose.yaml']);
      assert.deepStrictEqual(environmentOf(config, { local: true }), {
        DEMO_PORT: '8090',
        DEMO_SOURCES_PATH: '../sources',
      });
      assert.strictEqual(ingressOf(config).mode, 'caddy');
    }),
  );

  it.effect.each([
    [undefined, '/deployment'],
    ['../app source', '/app source'],
    ['/absolute/app', '/absolute/app'],
    ['~/app', join(homedir(), 'app')],
  ] as const)(
    'resolves workingDirectory %s without requiring the checkout',
    ([workingDirectory, expected]) =>
      Effect.gen(function* () {
        const config = yield* Schema.decodeUnknownEffect(DeployConfig)({
          ...valid,
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
        });
        assert.strictEqual(workingDirectoryOf({ dir: '/deployment', config }), expected);
      }),
  );

  it.effect.each([
    [
      'destination overrides of the shared source directory',
      { dev: { workingDirectory: '/other' } },
    ],
    ['a destination envFile', { dev: { envFile: 'dev.env' } }],
    [
      'a destination remote.envFile',
      { dev: { remote: { stackDir: '/srv', envFile: '/srv/.env' } } },
    ],
  ] as const)('rejects %s', ([, destinations]) =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(DeployConfig, { onExcessProperty: 'error' })({
        ...valid,
        destinations,
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
    }),
  );

  it.effect.each([
    ['a top-level envFile', { ...valid, envFile: 'secrets.env' }],
    ['remote.envFile', { ...valid, remote: { stackDir: '/srv/demo', envFile: '/srv/demo/.env' } }],
    ['a local envFile', { ...valid, local: { ...valid.local, envFile: 'dev.env' } }],
  ] as const)('rejects %s', ([, input]) =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(DeployConfig, { onExcessProperty: 'error' });
      const error = yield* decode(input).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
    }),
  );

  it.effect('defaults the ingress to none', () =>
    Effect.gen(function* () {
      const { ingress: _ingress, ...withoutIngress } = valid;
      const config = yield* Schema.decodeUnknownEffect(DeployConfig)(withoutIngress);
      assert.deepStrictEqual(ingressOf(config), { mode: 'none' });

      const { directories: _directories, content: _content, ...bare } = config;
      assert.deepStrictEqual(directoriesOf(bare), []);
    }),
  );

  it.effect.each([
    ...['', '   ', 'app\nsource', 'app\tpath', 'app\x00', 'app\x7f'].map((workingDirectory) => [
      'workingDirectory',
      { ...valid, workingDirectory },
    ]),
    ['name', { ...valid, name: 'Docs App' }],
    ['host', { ...valid, host: undefined }],
    ['domain', { ...valid, ingress: { caddy: { ...caddy, domain: 'https://demo.example.com' } } }],
    ['upstream', { ...valid, ingress: { caddy: { ...caddy, upstream: 'demo-web' } } }],
    ['healthPath', { ...valid, ingress: { caddy: { ...caddy, healthPath: 'healthz' } } }],
    [
      'healthPath with whitespace',
      { ...valid, ingress: { caddy: { ...caddy, healthPath: '/health z' } } },
    ],
    ['directories', { ...valid, directories: ['relative/path'] }],
    ['role build target', { ...valid, roles: { web: { build: { target: 'Bad' } } } }],
    ['role environment value', { ...valid, roles: { web: { environment: { A: 1 } } } }],
    ['role secrets', { ...valid, roles: { web: { secrets: 'TOKEN' } } }],
    ['role workingDirectory', { ...valid, roles: { web: { build: { workingDirectory: ' ' } } } }],
    ['environment', { ...valid, environment: { DEMO_PORT: 8090 } }],
  ])('rejects an invalid %s', ([, input]) =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(DeployConfig)(input).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
    }),
  );
});

describe('roles', () => {
  const decode = (input: unknown) => Schema.decodeUnknownEffect(DeployConfig)(input);

  it.effect.each([
    ['an invalid role name', { Web: {} }],
    ['a role name ending in a separator', { web_: {} }],
    ['a role name mixing separators', { 'a_-b': {} }],
    ['a role name starting with a separator', { '-web': {} }],
    ['an unknown role field', { web: { ports: [] } }],
    ['an unknown build field', { web: { build: { image: 'x' } } }],
  ] as const)('rejects %s', ([, roles]) =>
    Effect.gen(function* () {
      const decodeStrict = Schema.decodeUnknownEffect(DeployConfig, { onExcessProperty: 'error' });
      const error = yield* decodeStrict({ ...valid, roles }).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
    }),
  );

  it.effect.each([
    ['destination', { destinations: { dev: { roles: { web: { build: {} } } } } }],
    ['local', { local: { roles: { web: { build: {} } } } }],
  ] as const)('rejects a build in %s roles', ([, input]) =>
    Effect.gen(function* () {
      const decodeStrict = Schema.decodeUnknownEffect(DeployConfig, { onExcessProperty: 'error' });
      const error = yield* decodeStrict({ ...valid, ...input }).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
    }),
  );

  it.effect('accepts build fields, roles without a build and destination or local settings', () =>
    Effect.gen(function* () {
      const config = yield* decode({
        ...valid,
        workingDirectory: '../repo',
        dockerfile: 'infra/Dockerfile',
        context: '.',
        roles: {
          ...valid.roles,
          worker: {
            build: {
              target: 'worker',
              workingDirectory: '../other',
              dockerfile: 'worker.Dockerfile',
              context: 'src',
            },
          },
          postgres: { environment: { POSTGRES_USER: 'demo' } },
          'my_role-1': {},
        },
        destinations: { dev: { roles: { web: { environment: { MODE: 'b' }, secrets: [] } } } },
        local: { roles: { postgres: { secrets: ['PG_PASSWORD'] } } },
      });
      assert.deepStrictEqual(Object.keys(config.roles ?? {}), [
        'builder',
        'web',
        'worker',
        'postgres',
        'my_role-1',
      ]);
      assert.strictEqual(config.roles?.worker?.build?.dockerfile, 'worker.Dockerfile');
    }),
  );

  it.effect('does not require roles', () =>
    Effect.gen(function* () {
      const { roles: _roles, ...bare } = valid;
      const config = yield* decode(bare);
      assert.deepStrictEqual(rolesOf(config), {});
    }),
  );

  it.effect('rolls the working directory of a role over the top-level one', () =>
    Effect.gen(function* () {
      const app = {
        dir: '/deployment',
        config: yield* decode({
          ...valid,
          workingDirectory: '../repo',
          roles: { web: { build: { workingDirectory: '~/other' } }, api: { build: {} } },
        }),
      };
      assert.strictEqual(workingDirectoryOf(app), '/repo');
      assert.strictEqual(workingDirectoryOf(app, '~/other'), join(homedir(), 'other'));
    }),
  );

  it.effect('merges destination roles over the app roles', () =>
    Effect.gen(function* () {
      const config = yield* decode({
        ...valid,
        destinations: {
          dev: {
            roles: {
              web: { environment: { EXTRA: 'x' }, secrets: ['OTHER'] },
              builder: { environment: { ONLY: 'dest' } },
              sidecar: { environment: { SIDE: '1' } },
            },
          },
        },
      });
      const { config: selected } = selectDestination({ dir: '/d', config }, 'dev');
      assert.deepStrictEqual(selected.roles?.web, {
        build: { target: 'web' },
        environment: { MODE: 'a', EXTRA: 'x' },
        secrets: ['OTHER'],
      });
      assert.deepStrictEqual(selected.roles?.builder, {
        build: { target: 'builder' },
        environment: { ONLY: 'dest' },
      });
      assert.deepStrictEqual(selected.roles?.sidecar, { environment: { SIDE: '1' } });
      assert.deepStrictEqual(buildingRoles(selected), ['builder', 'web']);
    }),
  );

  it.effect('keeps the app roles when the destination sets none', () =>
    Effect.gen(function* () {
      const config = yield* decode({ ...valid, destinations: { dev: { host: 'other' } } });
      const { config: selected } = selectDestination({ dir: '/d', config }, 'dev');
      assert.deepStrictEqual(selected.roles, config.roles);
    }),
  );

  it.effect(
    'merges local roles over the roles of the run, with an empty list clearing secrets',
    () =>
      Effect.gen(function* () {
        const config = yield* decode({
          ...valid,
          local: {
            roles: {
              web: { environment: { MODE: 'local' }, secrets: [] },
              sidecar: { secrets: ['SIDE_TOKEN'] },
            },
          },
        });
        assert.deepStrictEqual(rolesOf(config).web?.secrets, ['TOKEN']);
        assert.deepStrictEqual(rolesOf(config, { local: true }).web, {
          build: { target: 'web' },
          environment: { MODE: 'local' },
          secrets: [],
        });
        assert.deepStrictEqual(rolesOf(config, { local: true }).sidecar, {
          secrets: ['SIDE_TOKEN'],
        });
        assert.deepStrictEqual(buildingRoles(config), ['builder', 'web']);
      }),
  );
});

describe('role removal', () => {
  const decode = (input: unknown) => Schema.decodeUnknownEffect(DeployConfig)(input);

  it.effect('accepts null under destination and local roles only', () =>
    Effect.gen(function* () {
      const config = yield* decode({
        ...valid,
        destinations: { dev: { roles: { builder: null } } },
        local: { roles: { web: null } },
      });
      assert.strictEqual(config.destinations?.dev?.roles?.builder, null);
      assert.strictEqual(config.local?.roles?.web, null);

      const error = yield* decode({ ...valid, roles: { web: null } }).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
    }),
  );

  it.effect('removes a role from the selected destination, including its build', () =>
    Effect.gen(function* () {
      const config = yield* decode({
        ...valid,
        destinations: { dev: { roles: { builder: null, web: { environment: { X: '1' } } } } },
      });
      const { config: selected } = selectDestination({ dir: '/d', config }, 'dev');
      assert.notProperty(selected.roles ?? {}, 'builder');
      assert.deepStrictEqual(Object.keys(selected.roles ?? {}), ['web']);
      assert.deepStrictEqual(buildingRoles(selected), ['web']);
      assert.deepStrictEqual(buildingRoles(config), ['builder', 'web']);
    }),
  );

  it.effect('drops the roles key when a destination removes every role', () =>
    Effect.gen(function* () {
      const config = yield* decode({
        ...valid,
        destinations: { dev: { roles: { builder: null, web: null } } },
      });
      const { config: selected } = selectDestination({ dir: '/d', config }, 'dev');
      assert.notProperty(selected, 'roles');
      assert.deepStrictEqual(buildingRoles(selected), []);
    }),
  );

  it.effect('keeps a role the destination removed out of a local run with the destination', () =>
    Effect.gen(function* () {
      const both = yield* decode({
        ...valid,
        destinations: { dev: { roles: { builder: null } } },
        local: { roles: { builder: null } },
      });
      const selectedBoth = selectDestination({ dir: '/d', config: both }, 'dev');
      assert.deepStrictEqual(Object.keys(rolesOf(selectedBoth.config, { local: true })), ['web']);

      const settings = yield* decode({
        ...valid,
        destinations: { dev: { roles: { builder: null } } },
        local: {
          roles: { builder: { environment: { X: '1' } }, web: { environment: { Y: '2' } } },
        },
      });
      const selectedSettings = selectDestination({ dir: '/d', config: settings }, 'dev');
      const local = rolesOf(selectedSettings.config, { local: true });
      assert.deepStrictEqual(Object.keys(local), ['web']);
      assert.strictEqual(local.web?.environment?.Y, '2');
      assert.deepStrictEqual(removedRolesOf(selectedSettings, { local: true }), ['builder']);

      const onlyLocal = yield* decode({
        ...valid,
        destinations: { dev: { environment: { A: '1' } } },
        local: { roles: { builder: null } },
      });
      const selectedLocal = selectDestination({ dir: '/d', config: onlyLocal }, 'dev');
      assert.deepStrictEqual(Object.keys(rolesOf(selectedLocal.config, { local: true })), ['web']);
      assert.deepStrictEqual(Object.keys(rolesOf(selectedLocal.config)), ['builder', 'web']);
      assert.deepStrictEqual(removedRolesOf(selectedLocal, { local: true }), ['builder']);
      assert.deepStrictEqual(removedRolesOf(selectedLocal), []);
    }),
  );

  it.effect('names the first removal of a role the app does not define', () =>
    Effect.gen(function* () {
      const destination = yield* decode({
        ...valid,
        destinations: { dev: { roles: { wrker: null } } },
      });
      assert.strictEqual(
        roleRemovalIssue(destination),
        'Destination "dev" removes role "wrker", which is not a role; roles: builder, web',
      );

      const local = yield* decode({ ...valid, local: { roles: { wrker: null } } });
      assert.strictEqual(
        roleRemovalIssue(local),
        'local.roles removes role "wrker", which is not a role; roles: builder, web',
      );

      const valid2 = yield* decode({
        ...valid,
        destinations: { dev: { roles: { builder: null, other: { environment: { A: '1' } } } } },
        local: { roles: { web: null } },
      });
      assert.isUndefined(roleRemovalIssue(valid2));

      const bare = yield* decode({
        name: 'demo',
        host: 'atlas',
        composeFiles: ['c.yaml'],
        local: { roles: { a: null } },
      });
      assert.include(roleRemovalIssue(bare), 'roles: none');
    }),
  );

  it.effect('removes a role for local runs only', () =>
    Effect.gen(function* () {
      const config = yield* decode({ ...valid, local: { roles: { builder: null } } });
      assert.deepStrictEqual(Object.keys(rolesOf(config, { local: true })), ['web']);
      assert.deepStrictEqual(buildingRoles(config, { local: true }), ['web']);
      assert.deepStrictEqual(Object.keys(rolesOf(config)), ['builder', 'web']);
      assert.deepStrictEqual(buildingRoles(config), ['builder', 'web']);
    }),
  );
});

describe('loadApp', () => {
  it.effect('reads a folder or the file itself and resolves the folder', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(dir, 'deploy.yaml'), YAML.stringify(valid)));

        const fromFolder = yield* loadApp(dir);
        const fromFile = yield* loadApp(join(dir, 'deploy.yaml'));

        assert.strictEqual(fromFolder.dir, dir);
        assert.strictEqual(fromFile.dir, dir);
        assert.strictEqual(fromFile.config.name, 'demo');
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('names the missing file', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const error = yield* loadApp(dir).pipe(Effect.flip);
        assert.strictEqual(error._tag, 'DeployError');
        assert.include(error.message, join(dir, 'deploy.yaml'));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('reports invalid YAML and invalid contents with the file name', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(dir, 'deploy.yaml'), '{'));

        const invalidJson = yield* loadApp(dir).pipe(Effect.flip);
        assert.include(invalidJson.message, 'not valid YAML');

        yield* Effect.promise(() =>
          writeFile(join(dir, 'deploy.yaml'), YAML.stringify({ name: 'x' })),
        );

        const invalidConfig = yield* loadApp(dir).pipe(Effect.flip);
        assert.include(invalidConfig.message, join(dir, 'deploy.yaml'));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'reports a role removal of an undefined role in any destination as a config error',
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const file = join(dir, 'deploy.yml');
          yield* Effect.promise(() =>
            writeFile(
              file,
              YAML.stringify({ ...valid, destinations: { dev: { roles: { wrker: null } } } }),
            ),
          );

          const error = yield* loadApp(dir).pipe(Effect.flip);

          assert.strictEqual(
            error.message,
            `${file}: Destination "dev" removes role "wrker", which is not a role; ` +
              'roles: builder, web',
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('fails with the dedicated message when targets is still configured', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(dir, 'deploy.yaml'), YAML.stringify({ ...valid, targets: ['web'] })),
        );

        const error = yield* loadApp(dir).pipe(Effect.flip);
        assert.strictEqual(error._tag, 'DeployError');
        assert.strictEqual(
          error.message,
          `${join(dir, 'deploy.yaml')}: targets was replaced by roles: give each built Compose ` +
            'service a role with build.target, and remove image: ${<TARGET>_IMAGE} from Compose ' +
            "files; compoza now sets each built service's image",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('discovers deploy.yml and prefers deploy.yaml when both exist', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const alternate = join(dir, 'deploy.yml');
        yield* Effect.promise(() => writeFile(alternate, YAML.stringify(valid)));

        assert.strictEqual((yield* loadApp(dir)).file, alternate);
        assert.strictEqual((yield* loadApp(alternate)).file, alternate);

        yield* Effect.promise(() => writeFile(join(dir, 'deploy.yaml'), YAML.stringify(valid)));

        assert.strictEqual((yield* loadApp(dir)).file, join(dir, 'deploy.yaml'));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

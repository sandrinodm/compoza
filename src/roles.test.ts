import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, type FileSystem } from 'effect';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import type { App, DeployConfig } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import {
  buildingRoles,
  buildSettingsOf,
  roleOverride,
  validateRoles,
  validateRoleSettings,
} from './roles.ts';

const host: HostConfig = {
  ssh: 'deploy@atlas.example.com',
  platform: 'linux/arm64',
  transport: { mode: 'registry', registry: 'registry.example.com' },
};

const config: DeployConfig = {
  name: 'demo',
  host: 'atlas',
  composeFiles: ['compose.yaml'],
  workingDirectory: '../repo',
  dockerfile: 'infra/Dockerfile',
  roles: {
    web: { build: { target: 'server' }, secrets: ['READ_TOKEN'] },
    worker: {
      build: { workingDirectory: '/srv/worker', dockerfile: 'worker.Dockerfile', context: 'src' },
      environment: {
        MY_API_BASE_URL: 'https://api.example.com/v1',
        LOG_FORMAT: '$remote_addr ${status}',
      },
    },
    postgres: { environment: { POSTGRES_USER: 'demo' } },
  },
};

const { roles: _roles, ...withoutRoles } = config;

const app: App = { dir: '/deployments/demo', config };

describe('buildSettingsOf', () => {
  it('inherits the top-level build fields and resolves them against the working directory', () => {
    assert.deepStrictEqual(buildSettingsOf(app, 'web'), {
      role: 'web',
      target: 'server',
      workingDirectory: '/deployments/repo',
      workingDirectoryConfigured: true,
      dockerfile: '/deployments/repo/infra/Dockerfile',
      context: undefined,
    });
  });

  it('lets a role override the working directory, dockerfile and context', () => {
    assert.deepStrictEqual(buildSettingsOf(app, 'worker'), {
      role: 'worker',
      target: undefined,
      workingDirectory: '/srv/worker',
      workingDirectoryConfigured: true,
      dockerfile: '/srv/worker/worker.Dockerfile',
      context: '/srv/worker/src',
    });
  });

  it('defaults to the deploy folder and a Dockerfile there', () => {
    const { workingDirectory: _workingDirectory, dockerfile: _dockerfile, ...rest } = config;
    const bare: App = { dir: '/d', config: { ...rest, roles: { api: { build: {} } } } };
    assert.deepStrictEqual(buildSettingsOf(bare, 'api'), {
      role: 'api',
      target: undefined,
      workingDirectory: '/d',
      workingDirectoryConfigured: false,
      dockerfile: '/d/Dockerfile',
      context: undefined,
    });
  });

  it('keeps absolute paths and rejects a role without a build', () => {
    const absolute: App = {
      ...app,
      config: {
        ...config,
        roles: { api: { build: { dockerfile: '/abs/Dockerfile', context: '/abs' } } },
      },
    };
    assert.strictEqual(buildSettingsOf(absolute, 'api').dockerfile, '/abs/Dockerfile');
    assert.strictEqual(buildSettingsOf(absolute, 'api').context, '/abs');
    assert.throws(() => buildSettingsOf(app, 'postgres'), 'Role "postgres" has no build');
  });

  it('lists the building roles in configuration order', () => {
    assert.deepStrictEqual(buildingRoles(config), ['web', 'worker']);
    assert.deepStrictEqual(buildingRoles(withoutRoles), []);
  });
});

describe('roleOverride', () => {
  const tags = { web: 'abc', worker: 'def' };

  it('sets the image, literal environment and secret references per role', () => {
    const override = roleOverride({ app, host, tags });
    assert.deepStrictEqual(parse(override ?? ''), {
      services: {
        web: {
          image: 'registry.example.com/demo-web:abc',
          environment: { READ_TOKEN: '${READ_TOKEN}' },
        },
        worker: {
          image: 'registry.example.com/demo-worker:def',
          environment: {
            MY_API_BASE_URL: 'https://api.example.com/v1',
            LOG_FORMAT: '$$remote_addr $${status}',
          },
        },
        postgres: { environment: { POSTGRES_USER: 'demo' } },
      },
    });
  });

  it('reads a building role named like an Object.prototype member only from its own tag', () => {
    const roles = { constructor: { build: {} } };
    const override = roleOverride({
      app: { ...app, config: { ...app.config, roles } },
      host,
      tags: { constructor: 'abc' },
    });
    assert.include(override, 'registry.example.com/demo-constructor:abc');
    assert.throws(
      () => roleOverride({ app: { ...app, config: { ...app.config, roles } }, host, tags: {} }),
      'No tag for role "constructor"',
    );
  });

  it('double-quotes values that YAML 1.1 readers would turn into numbers or dates', () => {
    const odd = { A: '1_000', B: '0b101', C: '2001-12-14', D: '1_0.5', E: 'yes' };
    const override =
      roleOverride({
        app: { ...app, config: { ...app.config, roles: { web: { environment: odd } } } },
        host,
        tags: {},
      }) ?? '';

    for (const [key, value] of Object.entries(odd)) {
      assert.include(override, `${key}: "${value}"`);
    }
  });

  it('names images without a registry for local runs and gives roles without a build no image', () => {
    const local = parse(roleOverride({ app, host, tags, local: true }) ?? '');
    assert.strictEqual(local.services.web.image, 'demo-web:abc');
    assert.notProperty(local.services.postgres, 'image');
  });

  it('merges the local roles for a local run', () => {
    const local: App = {
      ...app,
      config: {
        ...config,
        local: { roles: { postgres: { environment: { EXTRA: '1' }, secrets: ['PG_PASSWORD'] } } },
      },
    };
    const merged = parse(roleOverride({ app: local, host, tags, local: true }) ?? '');
    assert.deepStrictEqual(merged.services.postgres.environment, {
      POSTGRES_USER: 'demo',
      EXTRA: '1',
      PG_PASSWORD: '${PG_PASSWORD}',
    });

    const remote = parse(roleOverride({ app: local, host, tags }) ?? '');
    assert.deepStrictEqual(remote.services.postgres.environment, { POSTGRES_USER: 'demo' });
  });

  it('never contains a secret value, only references', () => {
    const override = roleOverride({ app, host, tags }) ?? '';
    assert.include(override, '${READ_TOKEN}');
  });

  it('is absent without roles or settings', () => {
    assert.isUndefined(roleOverride({ app: { ...app, config: withoutRoles }, host, tags }));
    assert.isUndefined(
      roleOverride({ app: { ...app, config: { ...config, roles: { idle: {} } } }, host, tags }),
    );
  });

  it('fails for a building role without a tag', () => {
    assert.throws(
      () => roleOverride({ app, host, tags: { web: 'abc' } }),
      'No tag for role "worker"',
    );
  });
});

describe('validateRoleSettings', () => {
  it.each([
    [{ web: { environment: { '1BAD': 'x' } } }, 'Role "web" environment name 1BAD is not portable'],
    [{ web: { environment: { 'A-B': 'x' } } }, 'environment name A-B is not portable'],
    [
      { web: { environment: { A: 'one\ntwo' } } },
      'Role "web" environment A has a multi-line value',
    ],
    [{ web: { environment: { A: 'one\rtwo' } } }, 'environment A has a multi-line value'],
    [{ web: { environment: { A: 'one\0' } } }, 'environment A has a multi-line value'],
    [{ web: { secrets: ['bad name'] } }, 'Role "web" secret name bad name is not portable'],
    [
      { web: { environment: { TOKEN: 'x' }, secrets: ['TOKEN'] } },
      'Role "web" lists TOKEN in both environment and secrets',
    ],
  ] as const)('rejects %j', (roles, message) => {
    assert.throws(() => validateRoleSettings(roles), message);
  });

  it('never repeats an environment value in the message', () => {
    try {
      validateRoleSettings({ web: { environment: { TOKEN: 'SENTINEL\nSECOND' } } });
      assert.fail('Expected a failure');
    } catch (error) {
      assert.notInclude((error as Error).message, 'SENTINEL');
    }
  });
});

describe('validateRoles', () => {
  /**
   * Runs `use` with an app whose deploy folder holds `files`.
   */
  function withCompose<A, E>(
    files: Readonly<Record<string, string>>,
    roles: DeployConfig['roles'],
    use: (app: App) => Effect.Effect<A, E, FileSystem.FileSystem>,
    extra: Partial<DeployConfig> = {},
  ) {
    return Effect.acquireUseRelease(
      Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-roles-'))),
      ({ path: dir }) =>
        Effect.gen(function* () {
          for (const [name, text] of Object.entries(files)) {
            yield* Effect.promise(async () => {
              await mkdir(dirname(join(dir, name)), { recursive: true });
              await writeFile(join(dir, name), text);
            });
          }

          const { roles: _roles, ...base } = config;
          const names = Object.keys(files);
          return yield* use({
            dir,
            config: {
              ...base,
              secrets: { 'env-file': { path: 'dev.env' } },
              composeFiles: [names[0] ?? 'compose.yaml', ...names.slice(1)],
              ...(roles === undefined ? {} : { roles }),
              ...extra,
            },
          });
        }),
      (directory) => Effect.promise(() => directory.remove()),
    ).pipe(Effect.provide(NodeServices.layer));
  }

  it.effect('accepts roles that name services in any selected Compose file', () =>
    withCompose(
      { 'compose.yaml': 'services: {web: {image: a}}', 'extra.yaml': 'services: {worker: {}}' },
      { web: { environment: { A: '1' } }, worker: { secrets: ['B'] } },
      (app) => validateRoles(app),
    ),
  );

  it.effect('reads nothing for an app without roles', () =>
    withCompose({}, undefined, (app) =>
      validateRoles({ ...app, config: { ...app.config, composeFiles: ['missing.yaml'] } }),
    ),
  );

  it.effect('names the known services when a role is not one of them', () =>
    withCompose(
      { 'compose.yaml': 'services: {web: {image: a}, worker: {image: b}}' },
      { wbe: { environment: { A: '1' } } },
      (app) =>
        Effect.gen(function* () {
          const error = yield* validateRoles(app).pipe(Effect.flip);
          assert.strictEqual(
            error.message,
            'Role "wbe" is not a service in the Compose files; services: web, worker',
          );
        }),
    ),
  );

  it.effect('checks the local Compose files for a local run', () =>
    withCompose(
      { 'compose.yaml': 'services: {web: {}}', 'local.yaml': 'services: {web: {}, db: {}}' },
      { db: { environment: { A: '1' } } },
      (app) =>
        Effect.gen(function* () {
          const error = yield* validateRoles(app).pipe(Effect.flip);
          assert.include(error.message, 'Role "db" is not a service');
          yield* validateRoles(app, { local: true });
        }),
      { composeFiles: ['compose.yaml'], local: { composeFiles: ['local.yaml'] } },
    ),
  );

  it.effect('rejects invalid role settings before reading files', () =>
    withCompose(
      { 'compose.yaml': 'services: {web: {}}' },
      { web: { secrets: ['bad name'] } },
      (app) =>
        Effect.gen(function* () {
          const error = yield* validateRoles(app).pipe(Effect.flip);
          assert.include(error.message, 'secret name bad name is not portable');
        }),
    ),
  );

  it.effect.each([
    ['map form', 'services: {web: {environment: {MODE: x}}}', { environment: { MODE: 'y' } }],
    [
      'list form KEY=value',
      'services: {web: {environment: ["MODE=x"]}}',
      { environment: { MODE: 'y' } },
    ],
    ['list form KEY', 'services: {web: {environment: [MODE]}}', { environment: { MODE: 'y' } }],
    ['a role secret', 'services: {web: {environment: {TOKEN: x}}}', { secrets: ['TOKEN'] }],
  ] as const)('rejects a variable the service also sets in %s', ([, compose, role]) =>
    withCompose({ 'compose.yaml': compose }, { web: role }, (app) =>
      Effect.gen(function* () {
        const error = yield* validateRoles(app).pipe(Effect.flip);
        assert.match(
          error.message,
          /^Role "web" sets (MODE|TOKEN), which service web also sets in environment in compose\.yaml; set it in only one place$/,
        );
      }),
    ),
  );

  it.effect('resolves YAML merge keys when finding the services own environment', () =>
    withCompose(
      {
        'compose.yaml':
          'x-env: &env {MODE: x}\nservices:\n  web:\n    environment:\n      <<: *env\n',
      },
      { web: { environment: { MODE: 'y' } } },
      (app) =>
        Effect.gen(function* () {
          const error = yield* validateRoles(app).pipe(Effect.flip);
          assert.include(error.message, 'sets MODE');
        }),
    ),
  );

  it.effect('sees environment and extends inherited through a service-level merge key', () =>
    Effect.gen(function* () {
      yield* withCompose(
        { 'compose.yaml': 'x-base: &base {environment: {MODE: x}}\nservices: {web: {<<: *base}}' },
        { web: { environment: { MODE: 'y' } } },
        (app) =>
          Effect.gen(function* () {
            const error = yield* validateRoles(app).pipe(Effect.flip);
            assert.include(error.message, 'sets MODE');
          }),
      );
      yield* withCompose(
        {
          'compose.yaml':
            'x-ext: &ext {extends: base}\nservices:\n  base: {environment: {MODE: x}}\n  web: {<<: *ext}',
        },
        { web: { environment: { MODE: 'y' } } },
        (app) =>
          Effect.gen(function* () {
            const error = yield* validateRoles(app).pipe(Effect.flip);
            assert.include(error.message, 'sets MODE');
          }),
      );
    }),
  );

  it.effect('lets an explicit environment on the service win over a merged one', () =>
    withCompose(
      {
        'compose.yaml':
          'x-base: &base {environment: {MODE: x}}\nservices: {web: {<<: *base, environment: {OTHER: z}}}',
      },
      { web: { environment: { MODE: 'y' } } },
      (app) => validateRoles(app),
    ),
  );

  it.effect('treats a whole-environment !reset as dropping its payload too', () =>
    withCompose(
      {
        'compose.yaml': 'services: {web: {environment: {MODE: x}}}',
        'override.yaml': 'services: {web: {environment: !reset {MODE: x}}}',
      },
      { web: { environment: { MODE: 'y' } } },
      (app) => validateRoles(app),
    ),
  );

  it.effect('keeps the payload of a whole-environment !override', () =>
    withCompose(
      {
        'compose.yaml': 'services: {web: {image: a}}',
        'override.yaml': 'services: {web: {environment: !override {MODE: x}}}',
      },
      { web: { environment: { MODE: 'y' } } },
      (app) =>
        Effect.gen(function* () {
          const error = yield* validateRoles(app).pipe(Effect.flip);
          assert.include(error.message, 'sets MODE');
        }),
    ),
  );

  it.effect('follows include for a local run even when the app deploys over SSH', () =>
    withCompose(
      {
        'compose.yaml': 'include: [inc.yaml]\nservices: {web: {image: a}}',
        'inc.yaml': 'services: {db: {image: b}}',
      },
      { db: { environment: { A: '1' } } },
      (app) =>
        Effect.gen(function* () {
          const error = yield* validateRoles(app).pipe(Effect.flip);
          assert.include(error.message, 'Role "db" is not a service');
          yield* validateRoles(app, { local: true });
        }),
      { execution: 'ssh', composeFiles: ['compose.yaml'] },
    ),
  );

  it.effect('fails when a role takes secrets but the run has no secret source', () =>
    withCompose(
      { 'compose.yaml': 'services: {web: {}}' },
      { web: { secrets: ['TOKEN'] } },
      (app) =>
        Effect.gen(function* () {
          const expected =
            'Role "web" takes secrets, but the run has no secret source; ' +
            'configure secrets (or local.secrets for --local) with a provider';
          const none = yield* validateRoles(app).pipe(Effect.flip);
          assert.strictEqual(none.message, expected);

          const { secrets: _secrets, ...rest } = app.config;
          const absent = yield* validateRoles({ ...app, config: rest }).pipe(Effect.flip);
          assert.strictEqual(absent.message, expected);
        }),
      { secrets: { none: {} } },
    ),
  );

  it.effect('rejects reserved role secrets and names an environment variable already set', () =>
    withCompose(
      { 'compose.yaml': 'services: {web: {}}' },
      { web: { secrets: ['COMPOSE_FILE'] } },
      (app) =>
        Effect.gen(function* () {
          const reserved = yield* validateRoles(app).pipe(Effect.flip);
          assert.strictEqual(
            reserved.message,
            'Role "web" secret COMPOSE_FILE is a reserved variable; rename it',
          );

          const colliding = yield* validateRoles({
            ...app,
            config: { ...app.config, roles: { web: { secrets: ['SHARED'] } } },
          }).pipe(Effect.flip);
          assert.include(
            colliding.message,
            'Role "web" secret SHARED has the name of an environment',
          );
        }),
      { environment: { SHARED: 'x' } },
    ),
  );

  it.effect('does not report a variable that a later file clears with !reset or !override', () =>
    withCompose(
      {
        'compose.yaml': 'services: {web: {environment: {A: x, B: x, C: x}}}',
        'overlay.yaml': 'services:\n  web:\n    environment:\n      A: !reset null\n      D: y\n',
      },
      { web: { environment: { A: '1' } } },
      (app) =>
        Effect.gen(function* () {
          yield* validateRoles(app);

          const kept = yield* validateRoles({
            ...app,
            config: { ...app.config, roles: { web: { environment: { B: '1' } } } },
          }).pipe(Effect.flip);
          assert.include(kept.message, 'sets B');
          assert.include(kept.message, 'in compose.yaml');

          const added = yield* validateRoles({
            ...app,
            config: { ...app.config, roles: { web: { environment: { D: '1' } } } },
          }).pipe(Effect.flip);
          assert.include(added.message, 'in overlay.yaml');
        }),
    ),
  );

  it.effect.each([
    ['!reset', '!reset []'],
    ['!override', '!override {Z: z}'],
  ] as const)('follows %s on a whole environment in a later file', ([, tagged]) =>
    withCompose(
      {
        'compose.yaml': 'services: {web: {environment: {A: x}}}',
        'overlay.yaml': `services: {web: {environment: ${tagged}}}`,
      },
      { web: { environment: { A: '1' } } },
      (app) => validateRoles(app),
    ),
  );

  it.effect('reports a variable inherited through extends, in the same or another file', () =>
    withCompose(
      {
        'compose.yaml':
          'services:\n  base: {environment: [A=1]}\n  web: {extends: base}\n' +
          '  api: {extends: {service: remote, file: lib/shared.yaml}}\n',
        'lib/shared.yaml': 'services: {remote: {environment: {B: x}}}',
      },
      { web: { environment: { A: '1' } } },
      (app) =>
        Effect.gen(function* () {
          const same = yield* validateRoles(app).pipe(Effect.flip);
          assert.include(same.message, 'Role "web" sets A');

          const other = yield* validateRoles({
            ...app,
            config: { ...app.config, roles: { api: { secrets: ['B'] } } },
          }).pipe(Effect.flip);
          assert.include(other.message, 'Role "api" sets B');
          assert.include(other.message, 'in lib/shared.yaml');

          yield* validateRoles({
            ...app,
            config: { ...app.config, roles: { api: { environment: { A: '1' } } } },
          });
        }),
      { composeFiles: ['compose.yaml'] },
    ),
  );

  it.effect('counts services of included files under client execution only', () =>
    withCompose(
      {
        'compose.yaml':
          'include:\n  - sub/db.yaml\n  - path: [sub/cache.yaml]\nservices: {web: {}}',
        'sub/db.yaml': 'services: {db: {environment: {PG: x}}}',
        'sub/cache.yaml': 'services: {cache: {}}',
      },
      { db: { environment: { A: '1' } }, cache: { environment: { A: '1' } } },
      (app) =>
        Effect.gen(function* () {
          yield* validateRoles(app);

          const clash = yield* validateRoles({
            ...app,
            config: { ...app.config, roles: { db: { environment: { PG: '1' } } } },
          }).pipe(Effect.flip);
          assert.include(clash.message, 'in sub/db.yaml');

          const ssh = yield* validateRoles({
            ...app,
            config: { ...app.config, execution: 'ssh' },
          }).pipe(Effect.flip);
          assert.include(ssh.message, 'Role "db" is not a service');
        }),
      { composeFiles: ['compose.yaml'] },
    ),
  );

  it.effect('reports an unreadable or unparsable Compose file', () =>
    withCompose({ 'compose.yaml': 'services: [' }, { web: {} }, (app) =>
      Effect.gen(function* () {
        const bad = yield* validateRoles(app).pipe(Effect.flip);
        assert.strictEqual(bad.message, 'Cannot parse compose.yaml; check its YAML syntax');

        const missing = yield* validateRoles({
          ...app,
          config: { ...app.config, composeFiles: ['nope.yaml'] },
        }).pipe(Effect.flip);
        assert.strictEqual(missing.message, 'Cannot read Compose file nope.yaml');
      }),
    ),
  );
});

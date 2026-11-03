import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from './deploy.ts';

import { OnePasswordReader } from '../extensions/1password/index.ts';
import { DryRun } from '../services/Shell.ts';
import { deploymentScript } from '../ssh-plan.ts';
import { selectDestination, validateSecretSettings } from './deploy.ts';
import { parseEnvFile } from './env-file.ts';
import { readSecrets, secretSource, validateSecrets } from './secrets.ts';

const app: App = {
  dir: '/nonexistent',
  config: {
    name: 'app',
    host: 'atlas',
    targets: ['web'],
    composeFiles: ['compose.yaml'],
    secrets: { provider: '1password', environmentId: 'fictional-environment' },
  },
};

const allowlisted = (variables: ReadonlyArray<string>): App => ({
  ...app,
  config: {
    ...app.config,
    execution: 'ssh',
    remote: { stackDir: '/srv/app' },
    secrets: { '1password': { environmentId: 'fictional-environment', variables } },
  },
});

describe('secret sources', () => {
  it('replaces the entire inherited source and legacy source at destinations', () => {
    const selected = selectDestination(
      {
        ...app,
        config: {
          ...app.config,
          destinations: { cedar: { secrets: { provider: 'env-file', path: 'dev.env' } } },
        },
      },
      'cedar',
    );
    assert.deepStrictEqual(secretSource(selected), { provider: 'env-file', path: 'dev.env' });

    const { secrets: _source, ...legacyConfig } = app.config;
    const legacy = selectDestination(
      {
        ...app,
        config: {
          ...legacyConfig,
          envFile: 'legacy.env',
          destinations: { cedar: { secrets: { provider: 'none' } } },
        },
      },
      'cedar',
    );
    assert.deepStrictEqual(secretSource(legacy), { provider: 'none' });
    assert.isUndefined(legacy.config.envFile);
  });

  it('rejects ambiguous aliases and requires explicit local source selection', () => {
    assert.throws(
      () => validateSecretSettings({ ...app.config, envFile: 'legacy.env' }),
      'Ambiguous',
    );
    assert.throws(
      () =>
        validateSecretSettings({
          ...app.config,
          remote: { stackDir: '/srv/app', envFile: '/srv/app/.env' },
        }),
      'Ambiguous',
    );
    assert.throws(() => secretSource(app, { local: true }), 'local.secrets');
    assert.deepStrictEqual(
      secretSource(
        { ...app, config: { ...app.config, local: { secrets: { provider: 'none' } } } },
        { local: true },
      ),
      { provider: 'none' },
    );
  });

  it.effect('imports every masked and unmasked variable without interpolation or disclosure', () =>
    Effect.gen(function* () {
      const values = yield* readSecrets(app);
      assert.deepStrictEqual(values, { TOKEN: '$HOME "literal"', EMPTY: '' });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async (id) => {
        assert.strictEqual(id, 'fictional-environment');

        return [
          { name: 'TOKEN', value: '$HOME "literal"', masked: true },
          { name: 'EMPTY', value: '', masked: false },
        ];
      }),
    ),
  );

  it.effect('allowlists exact names before validation and SSH dotenv serialization', () =>
    Effect.gen(function* () {
      const selected = allowlisted(['TOKEN', 'EMPTY']);
      const values = yield* readSecrets(selected);
      assert.deepStrictEqual(values, { TOKEN: '$HOME "literal"', EMPTY: '' });

      const plan = deploymentScript(
        selected,
        { ssh: 'fixture', platform: 'linux/arm64', transport: { mode: 'ssh-load' } },
        'one',
        [],
        values,
      );
      const uploaded = plan.input
        .trim()
        .split('\n')
        .map((line) => Buffer.from(line, 'base64').toString())
        .join('\n');
      assert.include(uploaded, String.raw`TOKEN="$$HOME \"literal\""`);
      assert.include(uploaded, 'EMPTY=""');
      assert.include(uploaded, 'WEB_IMAGE="app-web:one"');
      for (const excluded of ['OTHER', 'SENTINEL_EXCLUDED', 'PATH', 'WEB_IMAGE_SECRET', 'token']) {
        assert.notInclude(uploaded, excluded);
      }

      assert.notInclude(plan.script, '$HOME "literal"');
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async () => [
        { name: 'TOKEN', value: '$HOME "literal"', masked: true },
        { name: 'EMPTY', value: '', masked: false },
        { name: 'OTHER', value: 'SENTINEL_EXCLUDED', masked: true },
        { name: 'PATH', value: 'SENTINEL_EXCLUDED', masked: true },
        { name: 'WEB_IMAGE', value: 'WEB_IMAGE_SECRET', masked: true },
        { name: 'token', value: 'SENTINEL_EXCLUDED\nmultiline', masked: true },
      ]),
    ),
  );

  it.effect('fails closed when any allowlisted name is absent without echoing values', () =>
    Effect.gen(function* () {
      const error = yield* readSecrets(allowlisted(['TOKEN', 'MISSING'])).pipe(Effect.flip);
      assert.include(error.message, 'Missing 1Password variables: MISSING');
      assert.notInclude(JSON.stringify(error), 'SENTINEL_SECRET');
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async () => [
        { name: 'TOKEN', value: 'SENTINEL_SECRET', masked: true },
        { name: 'missing', value: 'SENTINEL_SECRET', masked: true },
      ]),
    ),
  );

  it.effect('imports nothing for an empty allowlist without loading the SDK', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readSecrets(allowlisted([])), {});
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async () => {
        throw new Error('Empty allowlist must not access the SDK');
      }),
    ),
  );

  it.effect('still rejects duplicate selected variables and unsafe selected values', () =>
    Effect.gen(function* () {
      const duplicate = yield* readSecrets(allowlisted(['TOKEN'])).pipe(
        Effect.provideService(OnePasswordReader, async () => [
          { name: 'TOKEN', value: 'SENTINEL_SECRET', masked: true },
          { name: 'TOKEN', value: 'other', masked: false },
        ]),
        Effect.flip,
      );
      assert.include(duplicate.message, 'duplicate');
      assert.notInclude(JSON.stringify(duplicate), 'SENTINEL_SECRET');

      for (const [name, value, message] of [
        ['PATH', 'SENTINEL_SECRET', 'Reserved'],
        ['TOKEN', 'SENTINEL_SECRET\nsecond', 'Unsupported'],
      ]) {
        const error = yield* readSecrets(allowlisted([name!])).pipe(
          Effect.provideService(OnePasswordReader, async () => [
            { name: name!, value: value!, masked: true },
          ]),
          Effect.flip,
        );
        assert.include(error.message, message!);
        assert.notInclude(JSON.stringify(error), 'SENTINEL_SECRET');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('replaces SDK exception contents with a safe message', () =>
    Effect.gen(function* () {
      const error = yield* readSecrets(app).pipe(Effect.flip);
      assert.include(error.message, '1Password Environment access failed');
      assert.notInclude(error.message, 'SENTINEL_SECRET');
      assert.notInclude(JSON.stringify(error), 'SENTINEL_SECRET');
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async () => {
        throw new Error('SENTINEL_SECRET');
      }),
    ),
  );

  it.effect('rejects duplicate variables without echoing values', () =>
    Effect.gen(function* () {
      const error = yield* readSecrets(app).pipe(Effect.flip);
      assert.include(error.message, 'duplicate');
      assert.notInclude(error.message, 'SENTINEL_SECRET');
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async () => [
        { name: 'TOKEN', value: 'SENTINEL_SECRET', masked: true },
        { name: 'TOKEN', value: 'other', masked: true },
      ]),
    ),
  );

  it.effect('dry-runs without loading either provider or a missing env file', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readSecrets(app), {});
      assert.deepStrictEqual(yield* readSecrets(allowlisted(['MISSING'])), {});
      assert.deepStrictEqual(
        yield* readSecrets({
          ...app,
          config: { ...app.config, secrets: { provider: 'env-file', path: '/does-not-exist' } },
        }),
        {},
      );
    }).pipe(
      Effect.provideService(DryRun, true),
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async () => {
        throw new Error('Provider must not be called');
      }),
    ),
  );

  it.effect(
    'resolves a provider env file relative to the deploy folder and preserves literals',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-secrets-'))),
        ({ path: dir }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              writeFile(join(dir, 'local.env'), 'TOKEN=\'$HOME "quote"\'\nEMPTY=\n'),
            );

            assert.deepStrictEqual(
              yield* readSecrets({
                dir,
                config: { ...app.config, secrets: { provider: 'env-file', path: 'local.env' } },
              }),
              { TOKEN: '$HOME "quote"', EMPTY: '' },
            );
          }),
        (directory) => Effect.promise(() => directory.remove()),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.each([
    'WEB_IMAGE',
    'COMPOSE_PROJECT_NAME',
    'DOCKER_HOST',
    'BUILDX_BUILDER',
    'OP_SERVICE_ACCOUNT_TOKEN',
    'PATH',
    'BASH_ENV',
    'NODE_OPTIONS',
  ])('rejects the reserved secret key %s', (key) => {
    assert.throws(() => validateSecrets(app, { [key]: 'SENTINEL_SECRET' }), 'Reserved');
  });

  it('rejects collisions and unsupported values without secret-bearing error text', () => {
    assert.throws(
      () =>
        validateSecrets(
          { ...app, config: { ...app.config, environment: { TOKEN: 'public' } } },
          { TOKEN: 'secret' },
        ),
      'collides',
    );

    for (const value of ['first\nsecond', 'first\rsecond', 'first\0second']) {
      assert.throws(() => validateSecrets(app, { TOKEN: value }), 'Unsupported');
    }

    assert.throws(() => validateSecrets(app, { 'SENTINEL_SECRET invalid': 'value' }), 'entry 1');
  });

  it.effect('rejects malformed, duplicate and multiline dotenv without echoing raw lines', () =>
    Effect.gen(function* () {
      for (const text of [
        'SENTINEL_SECRET',
        'TOKEN=one\nTOKEN=SENTINEL_SECRET',
        'TOKEN="SENTINEL_SECRET\nsecond',
      ]) {
        const error = yield* parseEnvFile(text).pipe(Effect.flip);
        assert.notInclude(error.message, 'SENTINEL_SECRET');
        assert.include(error.message, 'line');
      }
    }),
  );
});

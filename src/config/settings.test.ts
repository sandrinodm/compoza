import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deleteSetting,
  editSettings,
  loadSettings,
  SETTING_KEYS,
  SettingsFile,
  settingValue,
} from './settings.ts';

const ACCOUNT = SETTING_KEYS['1password.account'];

/**
 * A scratch folder whose `nested/config.yaml` is the settings file for the test, removed
 * afterwards.
 */
const scratchSettings = Effect.gen(function* () {
  const { path: dir } = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-settings-'))),
    (directory) => Effect.promise(() => directory.remove()),
  );
  return join(dir, 'nested', 'config.yaml');
});

/**
 * Runs a settings test against its own scratch settings file.
 */
function withSettings<A, E>(test: (file: string) => Effect.Effect<A, E, never>) {
  return Effect.gen(function* () {
    const file = yield* scratchSettings;
    return yield* test(file).pipe(Effect.provideService(SettingsFile, file));
  }).pipe(Effect.scoped);
}

describe('settings', () => {
  it.effect('reads a missing settings file as no settings', () =>
    withSettings(() =>
      Effect.gen(function* () {
        const settings = yield* loadSettings();
        assert.deepStrictEqual(settings, {});
        assert.isUndefined(settingValue(settings, '1password.account'));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect('creates the file and its folder, then sets and unsets a value', () =>
    withSettings((file) =>
      Effect.gen(function* () {
        const written = yield* editSettings((document) => document.setIn(ACCOUNT, 'Atlas'));
        assert.strictEqual(written, file);
        assert.strictEqual(settingValue(yield* loadSettings(), '1password.account'), 'Atlas');

        yield* editSettings((document) => deleteSetting(document, ACCOUNT));
        assert.deepStrictEqual(yield* loadSettings(), {});
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect('keeps comments and other settings when editing', () =>
    withSettings((file) =>
      Effect.gen(function* () {
        yield* editSettings((document) => document.setIn(['hosts', 'links'], ['/srv/hosts']));
        const original = yield* Effect.promise(() => readFile(file, 'utf8'));
        yield* Effect.promise(() => writeFile(file, `# mine\n${original}`));

        yield* editSettings((document) => document.setIn(ACCOUNT, 'Atlas'));

        const text = yield* Effect.promise(() => readFile(file, 'utf8'));
        assert.include(text, '# mine');
        assert.deepStrictEqual(yield* loadSettings(), {
          hosts: { links: ['/srv/hosts'] },
          '1password': { account: 'Atlas' },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect('writes nothing when an edit would leave an invalid file', () =>
    withSettings((file) =>
      Effect.gen(function* () {
        yield* editSettings((document) => document.setIn(ACCOUNT, 'Atlas'));

        const error = yield* editSettings((document) => document.setIn(ACCOUNT, '')).pipe(
          Effect.flip,
        );
        assert.include(error.message, file);
        assert.strictEqual(settingValue(yield* loadSettings(), '1password.account'), 'Atlas');
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect('rejects unknown fields and invalid YAML, naming the file', () =>
    withSettings((file) =>
      Effect.gen(function* () {
        yield* editSettings((document) => document.setIn(ACCOUNT, 'Atlas'));
        yield* Effect.promise(() => writeFile(file, 'acount: typo\n'));

        const unknown = yield* loadSettings().pipe(Effect.flip);
        assert.include(unknown.message, file);

        yield* Effect.promise(() => writeFile(file, '{'));

        const invalid = yield* editSettings(() => undefined).pipe(Effect.flip);
        assert.include(invalid.message, file);
        assert.include(invalid.message, 'not valid YAML');
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsFile } from '../../config/settings.ts';
import { OnePasswordReader, onePasswordProvider } from './index.ts';

const AUTH_VARIABLES = ['OP_SERVICE_ACCOUNT_TOKEN', 'COMPOZA_1PASSWORD_ACCOUNT'] as const;

const source = { provider: '1password', environmentId: 'fictional-environment' } as const;

/**
 * Reads the fixture Environment with `environment` as the only 1Password authentication variables
 * and `settings` as the settings file, returning the desktop account handed to the SDK reader.
 */
function accountFor(
  environment: Partial<Record<(typeof AUTH_VARIABLES)[number], string>>,
  settings: string,
) {
  return Effect.gen(function* () {
    const { path: dir } = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-1password-'))),
      (directory) => Effect.promise(() => directory.remove()),
    );
    const file = join(dir, 'config.yaml');
    yield* Effect.promise(() => writeFile(file, settings));

    const previous = AUTH_VARIABLES.map((name) => [name, process.env[name]] as const);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [name, value] of previous) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }),
    );

    for (const name of AUTH_VARIABLES) {
      const value = environment[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    let account: string | undefined;
    yield* onePasswordProvider.read(source, dir).pipe(
      Effect.provideService(SettingsFile, file),
      Effect.provideService(OnePasswordReader, async (_id, selected) => {
        account = selected;
        return [];
      }),
    );
    return account;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
}

describe('onePasswordProvider account', () => {
  it.effect('uses the saved account when no environment variable is set', () =>
    Effect.gen(function* () {
      const settings = '1password:\n  account: Saved\n';
      assert.strictEqual(yield* accountFor({}, settings), 'Saved');
    }),
  );

  it.effect('prefers COMPOZA_1PASSWORD_ACCOUNT over the saved account', () =>
    Effect.gen(function* () {
      const settings = '1password:\n  account: Saved\n';
      const account = yield* accountFor({ COMPOZA_1PASSWORD_ACCOUNT: 'Override' }, settings);
      assert.strictEqual(account, 'Override');
    }),
  );

  it.effect('ignores the settings file when a service-account token is set', () =>
    Effect.gen(function* () {
      const account = yield* accountFor({ OP_SERVICE_ACCOUNT_TOKEN: 'fictional' }, '{');
      assert.isUndefined(account);
    }),
  );
});

import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeployConfig } from './deploy.ts';
import { parseEnvFile } from './env-file.ts';
import { readSecrets } from './secrets.ts';

describe('parseEnvFile', () => {
  it.effect('reads values, skips comments and blanks, and strips matching quotes', () =>
    Effect.gen(function* () {
      const values = yield* parseEnvFile(`
# secrets
PG_PASSWORD=s3cret
QUOTED="with spaces"
SINGLE='single'
EQUALS=a=b
  SPACED =  padded
`);
      assert.deepStrictEqual(values, {
        PG_PASSWORD: 's3cret',
        QUOTED: 'with spaces',
        SINGLE: 'single',
        EQUALS: 'a=b',
        SPACED: 'padded',
      });
    }),
  );

  it.effect('rejects a line without a key', () =>
    Effect.gen(function* () {
      const error = yield* parseEnvFile('=value').pipe(Effect.flip);
      assert.include(error.message, 'line 1');
      assert.notInclude(error.message, '=value');
    }),
  );
});

describe('readSecrets', () => {
  it.effect('resolves a relative envFile against the deploy folder, not the working directory', () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), 'compoza-'))),
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(dir, 'secrets.env'), 'PG_PASSWORD=s3cret\n'));
          const config = yield* Schema.decodeUnknownEffect(DeployConfig)({
            name: 'demo',
            host: 'atlas',
            targets: ['web'],
            composeFiles: ['compose.yaml'],
            envFile: 'secrets.env',
          });
          assert.notStrictEqual(process.cwd(), dir);
          assert.deepStrictEqual(yield* readSecrets({ dir, config }), { PG_PASSWORD: 's3cret' });
        }),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('reads nothing when the app has no envFile', () =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(DeployConfig)({
        name: 'demo',
        host: 'atlas',
        targets: ['web'],
        composeFiles: ['compose.yaml'],
      });
      assert.deepStrictEqual(yield* readSecrets({ dir: '/nonexistent', config }), {});
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

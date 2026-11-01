import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonFile } from './json-file.ts';

const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });

describe('readJsonFile', () => {
  it.effect('decodes the file with the schema', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'compoza-')));
      const file = join(dir, 'point.json');
      yield* Effect.promise(() => writeFile(file, JSON.stringify({ x: 1, y: 2 })));
      assert.deepStrictEqual(yield* readJsonFile(file, Point, 'missing'), { x: 1, y: 2 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('rejects unknown keys, naming the file', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'compoza-')));
      const file = join(dir, 'point.json');
      yield* Effect.promise(() => writeFile(file, JSON.stringify({ x: 1, y: 2, domain: 'old.example.com' })));
      const error = yield* readJsonFile(file, Point, 'missing').pipe(Effect.flip);
      assert.strictEqual(error._tag, 'DeployError');
      assert.include(error.message, file);
      assert.include(error.message, 'domain');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('fails with the given message when the file is missing', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'compoza-')));
      const error = yield* readJsonFile(join(dir, 'point.json'), Point, 'No point here.').pipe(Effect.flip);
      assert.strictEqual(error._tag, 'DeployError');
      assert.strictEqual(error.message, 'No point here.');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('names the file when it is not JSON or does not match the schema', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'compoza-')));
      const file = join(dir, 'point.json');
      yield* Effect.promise(() => writeFile(file, '{'));
      const invalidJson = yield* readJsonFile(file, Point, 'missing').pipe(Effect.flip);
      assert.isTrue(invalidJson.message.startsWith(`${file} is not valid JSON: `));
      yield* Effect.promise(() => writeFile(file, JSON.stringify({ x: 1 })));
      const invalidContents = yield* readJsonFile(file, Point, 'missing').pipe(Effect.flip);
      assert.isTrue(invalidContents.message.startsWith(`${file}: `));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

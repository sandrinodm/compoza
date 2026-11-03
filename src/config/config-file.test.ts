import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { parseConfig, readConfigFile } from './config-file.ts';

const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });

/**
 * A document whose 101 aliases exceed the parser's alias limit of 100.
 */
const EXCESSIVE_ALIASES = 'x: &a [1, 2]\ny: [' + Array(101).fill('*a').join(', ') + ']\n';

/**
 * Keeps each loader fixture alive for the test's Effect scope, including failure and interruption
 * cleanup.
 */
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-'))),
  (directory) => Effect.promise(() => directory.remove()),
).pipe(Effect.map((directory) => directory.path));

describe('readConfigFile', () => {
  it.effect('decodes the file with the schema', () =>
    Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, 'point.yaml');
      yield* Effect.promise(() => writeFile(file, YAML.stringify({ x: 1, y: 2 })));

      assert.deepStrictEqual(yield* readConfigFile(file, Point, 'missing'), { x: 1, y: 2 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('rejects unknown keys, naming the file', () =>
    Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, 'point.yaml');
      yield* Effect.promise(() =>
        writeFile(file, YAML.stringify({ x: 1, y: 2, domain: 'old.example.com' })),
      );

      const error = yield* readConfigFile(file, Point, 'missing').pipe(Effect.flip);
      assert.strictEqual(error._tag, 'DeployError');
      assert.include(error.message, file);
      assert.include(error.message, 'domain');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('fails with the given message when the file is missing', () =>
    Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const error = yield* readConfigFile(join(dir, 'point.yaml'), Point, 'No point here.').pipe(
        Effect.flip,
      );
      assert.strictEqual(error._tag, 'DeployError');
      assert.strictEqual(error.message, 'No point here.');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('names the file when it is not YAML or does not match the schema', () =>
    Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, 'point.yaml');
      yield* Effect.promise(() => writeFile(file, '{'));

      const invalidYaml = yield* readConfigFile(file, Point, 'missing').pipe(Effect.flip);
      assert.isTrue(invalidYaml.message.startsWith(`${file} is not valid YAML: `));

      yield* Effect.promise(() => writeFile(file, YAML.stringify({ x: 1 })));

      const invalidContents = yield* readConfigFile(file, Point, 'missing').pipe(Effect.flip);
      assert.isTrue(invalidContents.message.startsWith(`${file}: `));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    'x: 1\nx: 2\ny: 3\n',
    'x: 1\ny: 2\n---\nx: 3\ny: 4\n',
    'x: !unknown 1\ny: 2\n',
    'x: [\ny: 2\n',
    'x: 1\ny: "2"\n',
    'null',
    '- 1\n- 2\n',
    EXCESSIVE_ALIASES,
  ])('rejects invalid or unsafe YAML: %s', (text) =>
    Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, 'point.yaml');
      yield* Effect.promise(() => writeFile(file, text));

      const error = yield* readConfigFile(file, Point, 'missing').pipe(Effect.flip);
      assert.include(error.message, file);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('redacts private syntax and schema errors', () =>
    Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, 'point.yaml');

      for (const text of ['x: [SENTINEL_SECRET', 'x: SENTINEL_SECRET\ny: 2']) {
        yield* Effect.promise(() => writeFile(file, text));

        const error = yield* readConfigFile(file, Point, 'missing', { privateInput: true }).pipe(
          Effect.flip,
        );
        assert.include(error.message, file);
        assert.notInclude(error.message, 'SENTINEL_SECRET');
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe('parseConfig', () => {
  it.each(['x: 1\nx: 2\n', 'x: 1\n---\nx: 2\n', 'x: !unknown 1\n', 'x: [\n'])(
    'rejects invalid YAML syntax before schema validation: %s',
    (text) => {
      assert.throws(() => parseConfig(text));
    },
  );

  it('bounds alias expansion while allowing ordinary anchors', () => {
    assert.deepStrictEqual(parseConfig('x: &value 1\ny: *value\n'), { x: 1, y: 1 });
    assert.throws(() => parseConfig(EXCESSIVE_ALIASES), 'Excessive alias count');
  });
});

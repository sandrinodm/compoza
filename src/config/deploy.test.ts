import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { composeFilesOf, DeployConfig, directoriesOf, environmentOf, ingressOf, loadApp } from './deploy.ts';

/**
 * Runs `use` with a fresh temporary folder and removes the folder afterwards, whether `use` succeeds or fails.
 */
function withTempDir<A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'compoza-'))),
    use,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
}

const valid = {
  name: 'demo',
  host: 'atlas',
  targets: ['builder', 'web'],
  composeFiles: ['compose.yaml', 'compose.production.yaml'],
  ingress: { mode: 'caddy-sites', domain: 'demo.example.com', upstream: 'demo-web:80', healthPath: '/healthz' },
  directories: ['/srv/demo/data'],
  content: { demo: '/srv/demo/data/demo' },
  environment: { DEMO_PORT: '8090' },
  local: { composeFiles: ['compose.yaml'], environment: { DEMO_SOURCES_PATH: '../sources' } },
};

describe('DeployConfig', () => {
  it.effect('accepts a complete config', () =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(DeployConfig)(valid);
      assert.strictEqual(config.name, 'demo');
      assert.deepStrictEqual(directoriesOf(config), ['/srv/demo/data', '/srv/demo/data/demo']);
      assert.deepStrictEqual(composeFilesOf(config, false), ['compose.yaml', 'compose.production.yaml']);
      assert.deepStrictEqual(composeFilesOf(config, true), ['compose.yaml']);
      assert.deepStrictEqual(environmentOf(config, true), { DEMO_PORT: '8090', DEMO_SOURCES_PATH: '../sources' });
      assert.strictEqual(ingressOf(config).mode, 'caddy-sites');
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
    ['name', { ...valid, name: 'Docs App' }],
    ['host', { ...valid, host: undefined }],
    ['domain', { ...valid, ingress: { ...valid.ingress, domain: 'https://demo.example.com' } }],
    ['upstream', { ...valid, ingress: { ...valid.ingress, upstream: 'demo-web' } }],
    ['healthPath', { ...valid, ingress: { ...valid.ingress, healthPath: 'healthz' } }],
    ['healthPath with whitespace', { ...valid, ingress: { ...valid.ingress, healthPath: '/health z' } }],
    ['directories', { ...valid, directories: ['relative/path'] }],
    ['targets', { ...valid, targets: ['Invalid'] }],
    ['environment', { ...valid, environment: { DEMO_PORT: 8090 } }],
  ])('rejects an invalid %s', ([, input]) =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(DeployConfig)(input).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
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
        yield* Effect.promise(() => writeFile(join(dir, 'deploy.yaml'), YAML.stringify({ name: 'x' })));
        const invalidConfig = yield* loadApp(dir).pipe(Effect.flip);
        assert.include(invalidConfig.message, join(dir, 'deploy.yaml'));
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

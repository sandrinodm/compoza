import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, FileSystem, Result } from 'effect';
import { mkdtempDisposable, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from './config/deploy.ts';

import { bundlePath, readBundle, validateComposeAssets } from './bundle.ts';
import { DeployError } from './errors.ts';

/**
 * Runs one bundle reader fixture and removes its local files afterwards.
 */
function withBundle(
  use: (app: App) => Effect.Effect<void, unknown, FileSystem.FileSystem>,
): Effect.Effect<void, unknown> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-bundle-'))),
    ({ path: dir }) =>
      use({
        dir,
        config: {
          name: 'app',
          host: 'host',
          targets: [],
          composeFiles: ['compose.yaml'],
          assets: ['settings.txt'],
        },
      }),
    (directory) => Effect.promise(() => directory.remove()),
  ).pipe(Effect.provide(NodeServices.layer));
}

describe('bounded Compose bundle', () => {
  it.effect(
    'reads external Compose files directly and keeps assets beside the deployment YAML',
    () =>
      withBundle((app) =>
        Effect.gen(function* () {
          const dir = yield* Effect.promise(() => realpath(app.dir));
          const source = join(dir, 'source');
          yield* Effect.promise(() => mkdir(source));
          const compose = 'services: {web: {build: ., volumes: ["./settings.txt:/settings:ro"]}}';
          const overlay = 'services: {web: {build: !reset null, image: "${WEB_IMAGE:?required}"}}';
          yield* Effect.promise(() => writeFile(join(source, 'compose.yaml'), compose));
          yield* Effect.promise(() => writeFile(join(source, 'production.yaml'), overlay));
          yield* Effect.promise(() => writeFile(join(dir, 'settings.txt'), 'deploy asset'));
          const files = yield* readBundle({
            ...app,
            config: {
              ...app.config,
              composeFiles: [join(source, 'compose.yaml'), join(source, 'production.yaml')],
            },
          });
          assert.deepStrictEqual(
            files.map((file) => file.path),
            ['compose.yaml', 'production.yaml', 'settings.txt'],
          );
          assert.strictEqual(Buffer.from(files[0]!.encoded, 'base64').toString(), compose);
          assert.strictEqual(Buffer.from(files[1]!.encoded, 'base64').toString(), overlay);
          assert.strictEqual(Buffer.from(files[2]!.encoded, 'base64').toString(), 'deploy asset');
        }),
      ),
  );

  it.effect('rejects external basename collisions before reading files', () =>
    withBundle((app) =>
      Effect.gen(function* () {
        for (const composeFiles of [
          ['/one/compose.yaml', '/two/compose.yaml'],
          ['/source/compose.yaml', 'compose.yaml'],
          ['/source/settings.txt'],
        ] as const) {
          const error = yield* readBundle({ ...app, config: { ...app.config, composeFiles } }).pipe(
            Effect.flip,
          );
          assert.include(error.message, 'upload paths must be distinct');
        }
      }),
    ),
  );

  it.effect(
    'rejects external source symlinks, traversal and secret sources without allowing absolute assets',
    () =>
      withBundle((app) =>
        Effect.gen(function* () {
          const dir = yield* Effect.promise(() => realpath(app.dir));
          yield* Effect.promise(() => mkdir(join(dir, 'source')));
          yield* Effect.promise(() => writeFile(join(dir, 'source/compose.yaml'), 'services: {}'));
          yield* Effect.promise(() => symlink('source', join(dir, 'linked')));
          for (const file of ['linked/compose.yaml', 'source/../source/compose.yaml']) {
            const error = yield* readBundle({
              ...app,
              config: { ...app.config, assets: [], composeFiles: [`${dir}/${file}`] },
            }).pipe(Effect.flip);
            assert.match(error.message, /symlinks|dot or empty components/);
          }
          const secret = yield* readBundle({
            ...app,
            config: {
              ...app.config,
              assets: [],
              composeFiles: [join(dir, 'source/compose.yaml')],
              secrets: { 'env-file': { path: join(dir, 'source/compose.yaml') } },
            },
          }).pipe(Effect.flip);
          assert.include(secret.message, 'Secret source files cannot be included');
          const asset = yield* readBundle({
            ...app,
            config: { ...app.config, assets: [join(dir, 'source/compose.yaml')] },
          }).pipe(Effect.flip);
          assert.include(asset.message, 'Unsafe bundle path');
        }),
      ),
  );

  it.effect(
    'uploads only selected files, preserving binary assets while ignoring a local dotenv file',
    () =>
      withBundle((app) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(
              join(app.dir, 'compose.yaml'),
              'services:\n  web:\n    image: nginx\n    volumes: ["./settings.txt:/etc/settings:ro"]\n',
            ),
          );
          yield* Effect.promise(() =>
            writeFile(join(app.dir, 'settings.txt'), Buffer.from([0, 1, 255])),
          );
          yield* Effect.promise(() => writeFile(join(app.dir, '.env'), 'SECRET=never-read'));

          const files = yield* readBundle(app);
          assert.deepStrictEqual(
            files.map((file) => file.path),
            ['compose.yaml', 'settings.txt'],
          );
          assert.deepStrictEqual(
            Buffer.from(files[1]!.encoded, 'base64'),
            Buffer.from([0, 1, 255]),
          );
        }),
      ),
  );

  it.effect.each([
    '../compose.yaml',
    '/compose.yaml',
    'a/../compose.yaml',
    'a//b',
    './compose.yaml',
    '.env',
    'a/.env',
    '.compoza.json',
    '.deploy-lock/file',
  ])('rejects unsafe or reserved path %s', (path) =>
    Effect.gen(function* () {
      const error = yield* bundlePath(path).pipe(Effect.flip);
      assert.instanceOf(error, DeployError);
      assert.include(error.message, 'Unsafe bundle path');
    }),
  );

  it.effect(
    'rejects regular-file and parent-directory symlinks before reading their contents',
    () =>
      withBundle((app) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(app.dir, 'compose.yaml'), 'services: {}'));
          yield* Effect.promise(() => writeFile(join(app.dir, 'source'), 'secret'));
          yield* Effect.promise(() => symlink('source', join(app.dir, 'settings.txt')));

          assert.include((yield* readBundle(app).pipe(Effect.flip)).message, 'symlinks');

          yield* Effect.promise(() => mkdir(join(app.dir, 'actual')));
          yield* Effect.promise(() => symlink('actual', join(app.dir, 'linked')));

          const nested: App = {
            ...app,
            config: { ...app.config, assets: ['linked/settings.txt'] },
          };
          assert.include((yield* readBundle(nested).pipe(Effect.flip)).message, 'symlinks');
        }),
      ),
  );

  it.effect.each([
    ['configs: {web: {file: missing.conf}}', 'declare non-secret file'],
    ['secrets: {web: {file: settings.txt}}', 'declare non-secret file'],
    ['services: {web: {image: nginx, env_file: .env}}', 'env_file paths must be absolute'],
    ['services: {web: {image: nginx, volumes: ["./data:/data"]}}', 'declared read-only asset'],
    [
      'services: {web: {image: nginx, volumes: ["./missing:/config:ro"]}}',
      'declared read-only asset',
    ],
    ['include: compose.other.yaml', 'explicit composeFiles'],
    ['services: {web: {extends: {file: ../outside.yaml, service: web}}}', 'explicit composeFiles'],
    ['null', 'Compose document must be a mapping'],
    ['- services', 'Compose document must be a mapping'],
    ['services: []', 'services must be a mapping'],
    ['services: {web: null}', 'service web must be a mapping'],
    ['services: {web: {volumes: {source: settings.txt}}}', 'volumes must be a list'],
    ['services: {web: {volumes: [false]}}', 'volumes must contain strings or mappings'],
    ['config: &loop {self: *loop}', 'cyclic YAML references'],
    [
      'configs: {web: &asset {file: settings.txt}}\nsecrets: {web: *asset}',
      'declare non-secret file',
    ],
  ] as const)(
    'reports invalid Compose assets through the typed error channel: %s',
    ([yaml, message]) =>
      Effect.gen(function* () {
        const error = yield* validateComposeAssets(
          yaml,
          'compose.yaml',
          new Set(['compose.yaml', 'settings.txt']),
        ).pipe(Effect.flip);
        assert.instanceOf(error, DeployError);
        assert.include(error.message, `compose.yaml: `);
        assert.include(error.message, message);
      }),
  );

  it.effect(
    'allows declared read-only assets, host paths, variables and shared noncyclic YAML aliases',
    () =>
      validateComposeAssets(
        'services: {web: &web {image: nginx, volumes: ["./settings.txt:/config:ro", "${DATA_PATH:?absolute path}:/data", {type: bind, source: settings.txt, target: /config, read_only: true}], env_file: /srv/app/.env}, worker: *web}',
        'compose.yaml',
        new Set(['settings.txt']),
      ),
  );

  it.effect.each([
    'services: [PRIVATE_INPUT',
    'value: &a [1, 2]\nitems: [' + Array(101).fill('*a').join(', ') + ']\n',
  ])('redacts YAML syntax and alias-expansion exceptions', (text) =>
    Effect.gen(function* () {
      const error = yield* validateComposeAssets(text, 'compose.yaml', new Set()).pipe(Effect.flip);
      assert.instanceOf(error, DeployError);
      assert.strictEqual(error.message, 'Cannot parse compose.yaml; check its YAML syntax');
      assert.notInclude(error.message, 'PRIVATE_INPUT');
    }),
  );

  it.effect('keeps filesystem failures recoverable with the bundle context', () =>
    withBundle((app) =>
      Effect.gen(function* () {
        const message = yield* readBundle(app).pipe(
          Effect.catchTag('DeployError', (error) => Effect.succeed(error.message)),
        );
        assert.isString(message);
        assert.include(message, 'Compose bundle: ');
        assert.include(message, 'compose.yaml');
      }),
    ),
  );

  it.effect('rejects symlinked deploy folders and non-file assets as typed failures', () =>
    withBundle((app) =>
      Effect.gen(function* () {
        const linked = join(app.dir, 'linked');
        yield* Effect.promise(() => symlink(app.dir, linked));

        const root = yield* readBundle({ ...app, dir: linked }).pipe(Effect.flip);
        assert.strictEqual(
          root.message,
          'Compose bundle: Deploy folder cannot be a symlink for SSH bundles',
        );

        yield* Effect.promise(() => writeFile(join(app.dir, 'compose.yaml'), 'services: {}'));
        yield* Effect.promise(() => mkdir(join(app.dir, 'settings.txt')));

        const asset = yield* readBundle(app).pipe(Effect.flip);
        assert.include(asset.message, 'Compose bundle: Bundle must contain regular files');
      }),
    ),
  );

  it.effect(
    'rejects file-count, individual-size and cumulative-size violations through the typed channel',
    () =>
      withBundle((app) =>
        Effect.gen(function* () {
          const many = {
            ...app,
            config: {
              ...app.config,
              assets: Array.from({ length: 128 }, (_, index) => `asset-${index}`),
            },
          };
          const count = yield* readBundle(many).pipe(Effect.flip);
          assert.strictEqual(
            count.message,
            'Compose bundle: Compose bundles allow at most 128 files',
          );

          yield* Effect.promise(() => writeFile(join(app.dir, 'compose.yaml'), 'services: {}'));
          yield* Effect.promise(() =>
            writeFile(join(app.dir, 'settings.txt'), Buffer.alloc(4 * 1024 * 1024 + 1)),
          );

          const large = yield* readBundle(app).pipe(Effect.flip);
          assert.include(large.message, 'totalling at most 4194304 bytes: settings.txt');

          yield* Effect.promise(() =>
            writeFile(join(app.dir, 'settings.txt'), Buffer.alloc(2 * 1024 * 1024)),
          );
          yield* Effect.promise(() =>
            writeFile(join(app.dir, 'second.txt'), Buffer.alloc(2 * 1024 * 1024)),
          );

          const combined = yield* readBundle({
            ...app,
            config: { ...app.config, assets: ['settings.txt', 'second.txt'] },
          }).pipe(Effect.flip);
          assert.include(combined.message, 'totalling at most 4194304 bytes: second.txt');
        }),
      ),
  );

  it.effect(
    'excludes a canonical secret source and rejects ambiguous sources without exposing contents',
    () =>
      withBundle((app) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(app.dir, 'compose.yaml'), 'services: {}'));
          yield* Effect.promise(() =>
            writeFile(join(app.dir, 'settings.txt'), 'TOKEN=PRIVATE_CONTENT'),
          );
          yield* Effect.promise(() => symlink('settings.txt', join(app.dir, 'secrets.env')));

          const selected: App = {
            ...app,
            config: { ...app.config, secrets: { 'env-file': { path: 'secrets.env' } } },
          };
          const secret = yield* readBundle(selected).pipe(Effect.flip);
          assert.strictEqual(
            secret.message,
            'Compose bundle: Secret source files cannot be included in stack assets',
          );
          assert.notInclude(secret.message, 'PRIVATE_CONTENT');

          const ambiguous = yield* readBundle({
            ...selected,
            config: { ...selected.config, envFile: 'legacy.env' },
          }).pipe(Effect.flip);
          assert.include(ambiguous.message, 'Compose bundle: Ambiguous secret sources');
        }),
      ),
  );

  it.effect('keeps unexpected filesystem and validation bugs as defects', () =>
    Effect.gen(function* () {
      const bug = new Error('unexpected programming bug');
      const fs = FileSystem.makeNoop({ lstat: () => Effect.die(bug) });
      const app: App = {
        dir: '/unused',
        config: { name: 'app', host: 'host', targets: [], composeFiles: ['compose.yaml'] },
      };
      const filesystem = yield* readBundle(app).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.exit,
      );
      assert.deepStrictEqual(Exit.findDefect(filesystem), Result.succeed(bug));
      assert.strictEqual(Exit.findErrorOption(filesystem)._tag, 'None');

      const declared = new Set<string>();
      declared.has = () => {
        throw bug;
      };

      const validation = yield* validateComposeAssets(
        'configs: {web: {file: settings.txt}}',
        'compose.yaml',
        declared,
      ).pipe(Effect.exit);
      assert.deepStrictEqual(Exit.findDefect(validation), Result.succeed(bug));
      assert.strictEqual(Exit.findErrorOption(validation)._tag, 'None');
    }),
  );
});

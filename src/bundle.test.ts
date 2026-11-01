import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from './config/deploy.ts';

import { bundlePath, readBundle, validateComposeAssets } from './bundle.ts';

/**
 * Runs one bundle reader fixture and removes its local files afterwards.
 */
function withBundle(use: (app: App) => Effect.Effect<void, unknown>): Effect.Effect<void, unknown> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'dd-bundle-'))),
    (dir) =>
      use({
        dir,
        config: { name: 'app', host: 'host', targets: [], composeFiles: ['compose.yaml'], assets: ['settings.txt'] },
      }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
}

describe('bounded Compose bundle', () => {
  it.effect('uploads only selected files, preserving binary assets while ignoring a local dotenv file', () =>
    withBundle((app) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(
            join(app.dir, 'compose.yaml'),
            'services:\n  web:\n    image: nginx\n    volumes: ["./settings.txt:/etc/settings:ro"]\n',
          ),
        );
        yield* Effect.promise(() => writeFile(join(app.dir, 'settings.txt'), Buffer.from([0, 1, 255])));
        yield* Effect.promise(() => writeFile(join(app.dir, '.env'), 'SECRET=never-read'));
        const files = yield* readBundle(app);
        assert.deepStrictEqual(
          files.map((file) => file.path),
          ['compose.yaml', 'settings.txt'],
        );
        assert.deepStrictEqual(Buffer.from(files[1]!.encoded, 'base64'), Buffer.from([0, 1, 255]));
      }),
    ),
  );

  it.each([
    '../compose.yaml',
    '/compose.yaml',
    'a/../compose.yaml',
    'a//b',
    './compose.yaml',
    '.env',
    'a/.env',
    'compose.sh',
    'route.sh',
    'successful',
    'manifest.json',
  ])('rejects unsafe or reserved path %s', (path) => {
    assert.throws(() => bundlePath(path), 'Unsafe bundle path');
  });

  it.effect('rejects regular-file and parent-directory symlinks before reading their contents', () =>
    withBundle((app) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(app.dir, 'compose.yaml'), 'services: {}'));
        yield* Effect.promise(() => writeFile(join(app.dir, 'source'), 'secret'));
        yield* Effect.promise(() => symlink('source', join(app.dir, 'settings.txt')));
        assert.include((yield* readBundle(app).pipe(Effect.flip)).message, 'symlinks');
        yield* Effect.promise(() => mkdir(join(app.dir, 'actual')));
        yield* Effect.promise(() => symlink('actual', join(app.dir, 'linked')));
        const nested: App = { ...app, config: { ...app.config, assets: ['linked/settings.txt'] } };
        assert.include((yield* readBundle(nested).pipe(Effect.flip)).message, 'symlinks');
      }),
    ),
  );

  it('rejects undeclared config files, relative dotenv, includes and mutable release binds', () => {
    for (const yaml of [
      'configs: {web: {file: missing.conf}}',
      'secrets: {web: {file: settings.txt}}',
      'services: {web: {image: nginx, env_file: .env}}',
      'services: {web: {image: nginx, volumes: ["./data:/data"]}}',
      'include: compose.other.yaml',
      'services: {web: {extends: {file: ../outside.yaml, service: web}}}',
    ]) {
      assert.throws(() => validateComposeAssets(yaml, 'compose.yaml', new Set(['compose.yaml', 'settings.txt'])));
    }
    assert.doesNotThrow(() =>
      validateComposeAssets(
        'services: {web: {image: nginx, volumes: ["./settings.txt:/config:ro", "${DATA_PATH:?absolute path}:/data"], env_file: /srv/app/.env}}',
        'compose.yaml',
        new Set(['settings.txt']),
      ),
    );
  });
});

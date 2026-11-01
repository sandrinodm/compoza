import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository whose runtime assets must survive packing without changes.
 */
const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * The tarball supplied by CI or a local pnpm pack command.
 */
const tarball = process.argv[2];
assert.ok(tarball, 'Usage: pnpm test:package /absolute/path/to/compoza.tgz');

/**
 * An isolated consumer directory outside the checkout and its development dependencies.
 */
const consumer = mkdtempSync(join(tmpdir(), 'compoza-package-'));

try {
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', consumer, resolve(tarball)], {
    cwd: consumer,
    stdio: 'inherit',
    timeout: 180_000,
  });
  const installed = join(consumer, 'node_modules/compoza');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, sourceManifest.version);
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const version of Object.values(manifest[section] ?? {})) {
      assert.ok(!version.startsWith('catalog:'), 'pnpm must resolve catalog dependencies before publishing');
    }
  }
  for (const name of readdirSync(join(root, 'src'), { recursive: true })) {
    if (/\.(sh|jq|tmpl)$/.test(name)) {
      assert.deepEqual(
        readFileSync(join(installed, 'dist/src', name)),
        readFileSync(join(root, 'src', name)),
        `Missing or changed runtime asset: ${name}`,
      );
    }
  }
  assert.ok(!readdirSync(join(installed, 'dist'), { recursive: true }).some((name) => /\.(ts|tsx)$/.test(name)));
  const executable = join(consumer, 'node_modules/.bin/compoza');
  const options = { cwd: consumer, encoding: 'utf8', timeout: 30_000 };
  assert.match(execFileSync(executable, ['--help'], options), /setup-proxy/);
  assert.equal(execFileSync(executable, ['--version'], options).trim(), `compoza v${manifest.version}`);
  console.log(`Installed compoza ${manifest.version}: CLI and all runtime assets verified.`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

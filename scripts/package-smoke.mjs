import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempDisposableSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The repository whose runtime assets must survive packing without changes.
 */
const root = resolve(import.meta.dirname, '..');

/**
 * The tarball supplied by CI or a local pnpm pack command.
 */
const tarball = process.argv[2];
assert.ok(tarball, 'Usage: pnpm test:package /absolute/path/to/compoza.tgz');

/**
 * An isolated consumer directory outside the checkout and its development dependencies.
 */
using temporary = mkdtempDisposableSync(join(tmpdir(), 'compoza-package-'));
const consumer = temporary.path;

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
const help = execFileSync(executable, ['--help'], options);
assert.match(help, /setup-proxy/);
assert.doesNotMatch(help, /rollback/);
assert.equal(execFileSync(executable, ['--version'], options).trim(), `compoza v${manifest.version}`);

const hosts = join(consumer, 'hosts.yaml');
writeFileSync(
  hosts,
  `fixture:
  ssh: never-contact.invalid
  platform: linux/arm64
  transport:
    mode: ssh-load
  ingress:
    cloudflare-tunnel:
      accountId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      tunnelId: 12345678-1234-1234-1234-123456789abc
      routing: manual
      dir: /srv/fixture-cloudflare
      container: cloudflared
      network: fixture-edge
      provision:
        secrets:
          1password:
            environmentId: must-not-fetch
`,
);

const preview = execFileSync(executable, ['--hosts', hosts, 'setup-proxy', 'fixture', '--dry-run'], options);
assert.match(preview, /provision Cloudflare connector/);
assert.match(preview, /cloudflare\/cloudflared/);
assert.match(preview, /read_only/);

const { deploymentScript } = await import(join(installed, 'dist/src/ssh-plan.mjs'));
const flat = deploymentScript(
  {
    dir: consumer,
    config: {
      name: 'fixture',
      host: 'fixture',
      targets: [],
      composeFiles: ['compose.yaml'],
      execution: 'ssh',
      remote: { stackDir: '/srv/fixture-stack' },
    },
  },
  { ssh: 'fixture', platform: 'linux/arm64', transport: { mode: 'ssh-load' } },
  'known',
  [{ path: 'compose.yaml', encoded: Buffer.from('services: {}').toString('base64') }],
);
assert.match(flat.script, /normalized\.yaml/);
assert.match(flat.script, /\.compoza\.json/);
assert.doesNotMatch(flat.script, /releases\/|\.activations\/|previous_id|compoza_promote/);

console.log(
  `Installed compoza ${manifest.version}: CLI, runtime assets and Cloudflare setup preview and flat SSH planning verified.`,
);

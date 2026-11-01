import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as YAML from 'yaml';

import { ingressConfigOf, loadHosts, proxyOf } from './config/hosts.ts';
import { defaultConfigTemplate, defaultSiteTemplate } from './extensions/caddy/templates.ts';
import { defaultComposeTemplate } from './extensions/cloudflare-tunnel/templates.ts';

const caddy = {
  dir: '/srv/caddy',
  container: 'caddy',
  network: 'caddy-edge',
  provision: { image: 'caddy:2' },
};
const cloudflare = {
  accountId: 'a'.repeat(32),
  tunnelId: '12345678-1234-1234-1234-123456789abc',
  routing: 'manual' as const,
  dir: '/srv/cloudflare',
  container: 'cloudflared',
  network: 'cloudflare-edge',
  provision: { secrets: { 'env-file': { path: './missing-credentials.env' } } },
};
const host = {
  ssh: 'never-contact.invalid',
  platform: 'linux/arm64',
  transport: { mode: 'ssh-load' },
  ingress: { caddy, 'cloudflare-tunnel': cloudflare },
} as const;

/**
 * Exercises real referenced host loading with both providers' templates and a host-relative secret source.
 */
const loadedFixture = Effect.gen(function* () {
  const temporary = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-multi-host-'))),
    (directory) => Effect.promise(() => directory.remove()),
  );
  const directory = temporary.path;
  const hostDirectory = join(directory, 'macmini-server');
  mkdirSync(hostDirectory);
  writeFileSync(
    join(directory, 'hosts.yaml'),
    YAML.stringify({ 'macmini-server': { $ref: './macmini-server/host.yaml' } }),
  );
  writeFileSync(join(hostDirectory, 'site.tmpl'), defaultSiteTemplate);
  writeFileSync(join(hostDirectory, 'Caddyfile.tmpl'), defaultConfigTemplate);
  writeFileSync(join(hostDirectory, 'compose.tmpl'), defaultComposeTemplate);
  writeFileSync(join(hostDirectory, 'route.tmpl'), 'hostname: {{domain}}\nservice: {{service}}\n');
  writeFileSync(
    join(hostDirectory, 'host.yaml'),
    YAML.stringify({
      ...host,
      ingress: {
        caddy: { ...caddy, templates: { site: './site.tmpl', config: './Caddyfile.tmpl' } },
        'cloudflare-tunnel': { ...cloudflare, templates: { compose: './compose.tmpl', route: './route.tmpl' } },
      },
    }),
  );

  const hosts = yield* loadHosts(join(directory, 'hosts.yaml'));
  const selected = hosts['macmini-server']!;
  const caddySettings = yield* proxyOf(selected, 'macmini-server');
  assert.deepStrictEqual(caddySettings.templates?.site, { inline: defaultSiteTemplate });
  assert.deepStrictEqual(caddySettings.templates?.config, { inline: defaultConfigTemplate });
  const tunnel = ingressConfigOf(selected, 'cloudflare-tunnel');
  assert.strictEqual(tunnel?.provider, 'cloudflare-tunnel');
  if (tunnel?.provider !== 'cloudflare-tunnel') {
    return assert.fail('Expected Cloudflare settings alongside Caddy');
  }

  assert.deepStrictEqual(tunnel.templates?.compose, { inline: defaultComposeTemplate });
  assert.deepStrictEqual(tunnel.templates?.route, { inline: 'hostname: {{domain}}\nservice: {{service}}\n' });
  assert.deepStrictEqual(tunnel.provision?.secrets, {
    'env-file': { path: join(hostDirectory, 'missing-credentials.env') },
  });
});

describe('multiple host ingress providers', () => {
  it.effect('loads and preserves both providers from one referenced host file', () =>
    loadedFixture.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.each([
    { selector: ['--ingress', 'caddy', '--dry-run'], expected: 'provision Caddy', success: true },
    { selector: ['--ingress', 'cloudflare-tunnel', '--dry-run'], expected: 'provision Cloudflare', success: true },
    { selector: [], expected: 'select --ingress', success: false },
    { selector: ['--ingress', 'nginx'], expected: 'nginx', success: false },
  ])('selects setup safely with $selector', ({ selector, expected, success }) => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'compoza-ingress-cli-'));
    const directory = temporary.path;
    const hosts = join(directory, 'hosts.yaml');
    const marker = join(directory, 'ssh-called');
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeFileSync(hosts, YAML.stringify({ server: host }));
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\ntouch "$SSH_MARKER"\nexit 99\n', { mode: 0o700 });
    const result = spawnSync(
      process.execPath,
      [resolve('bin/compoza.ts'), '--hosts', hosts, 'setup-proxy', 'server', ...selector],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_MARKER: marker },
      },
    );
    assert.strictEqual(result.status === 0, success, result.stderr);
    assert.include(result.stdout + result.stderr, expected);
    assert.isFalse(existsSync(marker));
    if (success) {
      assert.notInclude(result.stdout, expected === 'provision Caddy' ? 'provision Cloudflare' : 'provision Caddy');
    }
  });
});

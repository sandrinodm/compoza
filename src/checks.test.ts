import { assert, describe, it } from '@effect/vitest';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { blocking, evaluateChecks, formatChecks } from './checks.ts';
import { sha256, siteFile } from './extensions/caddy/scripts.ts';
import { parseCheck } from './probe.ts';

const app: App = {
  dir: '/repo/infra',
  config: {
    name: 'demo',
    host: 'atlas',
    targets: ['web'],
    composeFiles: ['compose.yaml'],
    ingress: { mode: 'caddy-sites', domain: 'demo.example.com', upstream: 'demo-web:80' },
  },
};

const host: HostConfig & { proxy: import('./extensions/caddy/config.ts').ProxyConfig } = {
  ssh: 'deploy@atlas.example.com',
  address: '192.0.2.42',
  platform: 'linux/arm64',
  transport: { mode: 'registry', registry: 'registry.example.com' },
  proxy: { dir: '/srv/proxy', container: 'caddy', network: 'edge' },
};

const ready = {
  proxy_dir: 'present',
  caddyfile_import: 'yes',
  compose_mount: 'yes',
  running_mount: 'yes',
  container_running: 'yes',
  container_health: 'none',
  network: 'yes',
  site_sha256: sha256(
    siteFile('demo', { mode: 'caddy-sites', domain: 'demo.example.com', upstream: 'demo-web:80' }, host.proxy!),
  ),
  registry_login: 'yes',
};

describe('evaluateChecks', () => {
  it('allows DNS without an IP assertion and compares both IP families', () => {
    const { address: _address, ...withoutAddress } = host;
    assert.isTrue(evaluateChecks(app, withoutAddress, ['2001:db8::1'], ready)[0]!.ok);
    assert.isFalse(evaluateChecks(app, withoutAddress, [], ready)[0]!.ok);

    const ipv6 = { ...withoutAddress, proxy: { ...host.proxy, address: '2001:db8:0:0::1' } };
    assert.isTrue(evaluateChecks(app, ipv6, ['2001:db8::1'], ready)[0]!.ok);
    assert.isFalse(evaluateChecks(app, ipv6, ['2001:db8::2'], ready)[0]!.ok);
  });

  it('blocks stopped or unhealthy Caddy even when its site mount exists', () => {
    for (const state of [
      { container_running: 'no', container_health: 'none' },
      { container_running: 'yes', container_health: 'unhealthy' },
      { container_running: 'yes', container_health: 'starting' },
    ]) {
      const check = evaluateChecks(app, host, [host.address!], { ...ready, ...state })[1]!;
      assert.isFalse(check.ok);
      assert.include(check.detail, 'Caddy is not ready');
    }

    const provisioned = { ...host, proxy: { ...host.proxy, provision: { image: 'caddy:2' } } };
    assert.isFalse(evaluateChecks(app, provisioned, [host.address!], ready)[1]!.ok);
    assert.isTrue(evaluateChecks(app, provisioned, [host.address!], { ...ready, container_health: 'healthy' })[1]!.ok);
  });

  it('passes everything on a ready host', () => {
    const checks = evaluateChecks(app, host, ['192.0.2.42'], ready);
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.ok]),
      [
        ['dns', true],
        ['proxy', true],
        ['network', true],
        ['route', true],
        ['registry', true],
      ],
    );
    assert.deepStrictEqual(blocking(checks), []);
  });

  it('names the fix for each failure and never blocks on the route', () => {
    const checks = evaluateChecks(app, host, [], {
      ...ready,
      caddyfile_import: 'no',
      network: 'no',
      site_sha256: 'none',
      registry_login: 'no',
    });
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.ok, check.fix]),
      [
        ['dns', false, 'dns'],
        ['proxy', false, 'setup-proxy'],
        ['network', false, 'manual'],
        ['route', false, 'deploy'],
        ['registry', false, 'manual'],
      ],
    );
    assert.deepStrictEqual(
      blocking(checks).map((check) => check.name),
      ['dns', 'proxy', 'network', 'registry'],
    );
    assert.include(formatChecks(checks), 'FAIL dns: demo.example.com has no A or AAAA answer; expected 192.0.2.42');
  });

  it('reports a wrong address and a missing proxy folder as manual', () => {
    const checks = evaluateChecks(app, host, ['198.51.100.99'], { ...ready, proxy_dir: 'missing' });
    assert.strictEqual(checks[0]?.detail, 'demo.example.com → 198.51.100.99, expected 192.0.2.42');
    assert.strictEqual(checks[1]?.fix, 'manual');
  });

  it('blocks a caddy-sites app on a host without a proxy entry', () => {
    const { proxy: _proxy, ...bare } = host;
    const checks = evaluateChecks(app, bare, [], { registry_login: 'yes' });
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.ok, check.fix]),
      [
        ['proxy', false, 'manual'],
        ['registry', true, 'manual'],
      ],
    );
    assert.deepStrictEqual(
      blocking(checks).map((check) => check.name),
      ['proxy'],
    );
    assert.include(checks[0]?.detail, 'host "atlas" has no proxy entry');
  });

  it('still measures the network and registry when the proxy folder is missing', () => {
    const probe = parseCheck('proxy_dir=missing\nrunning_mount=no\nnetwork=yes\nregistry_login=yes\n');
    const checks = evaluateChecks(app, host, ['192.0.2.42'], probe);
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.ok, check.detail]),
      [
        ['dns', true, 'demo.example.com → 192.0.2.42'],
        ['proxy', false, 'proxy folder /srv/proxy not found'],
        ['network', true, 'edge exists'],
        ['route', false, 'sites/demo.caddy was not probed: proxy folder /srv/proxy not found'],
        ['registry', true, 'host is logged in to registry.example.com'],
      ],
    );
    assert.deepStrictEqual(
      blocking(checks).map((check) => check.name),
      ['proxy'],
    );
  });

  it('says a key the probe did not print was not probed, without passing it', () => {
    const checks = evaluateChecks(app, host, ['192.0.2.42'], {});
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.ok, check.detail]),
      [
        ['dns', true, 'demo.example.com → 192.0.2.42'],
        ['proxy', false, 'proxy folder /srv/proxy was not probed'],
        ['network', false, 'Docker network edge was not probed'],
        ['route', false, 'sites/demo.caddy was not probed'],
        ['registry', false, 'stored login for registry.example.com was not probed'],
      ],
    );
  });

  it('produces only the registry check without ingress, and nothing for ssh-load', () => {
    const plain: App = { ...app, config: { ...app.config, ingress: { mode: 'none' } } };
    assert.deepStrictEqual(
      evaluateChecks(plain, host, [], { registry_login: 'yes' }).map((check) => check.name),
      ['registry'],
    );

    const sshHost: HostConfig = { ...host, transport: { mode: 'ssh-load' } };
    assert.deepStrictEqual(evaluateChecks(plain, sshHost, [], {}), []);
  });
});

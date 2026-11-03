import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import type { App } from '../config/deploy.ts';
import type { HostConfig } from '../config/hosts.ts';

import { blocking } from '../checks.ts';
import { DeployConfig, ingressOf, loadApp, selectDestination } from '../config/deploy.ts';
import { Hosts, ingressConfigOf, loadHosts } from '../config/hosts.ts';
import { readSecrets, secretSource } from '../config/secrets.ts';
import { DryRun } from '../services/Shell.ts';
import { deploymentScript } from '../ssh-plan.ts';
import { OnePasswordReader } from './1password/index.ts';
import { hostIngress, ingressFor } from './ingress.ts';

const caddy = { domain: 'app.example.com', upstream: 'web:80', healthPath: '/health' };
const caddyHost = { address: '192.0.2.1', dir: '/srv/caddy', container: 'caddy', network: 'edge' };
const cloudflare = { domain: 'app.example.com', service: 'http://web:80' };

const cloudflareHost = {
  accountId: 'a'.repeat(32),
  tunnelId: '12345678-1234-1234-1234-123456789abc',
  apiTokenFile: '/srv/cloudflare/token',
  stateDir: '/srv/cloudflare/state',
};

/**
 * Decodes app configuration the way the CLI does, rejecting unknown fields.
 */
const decodeDeployConfig = Schema.decodeUnknownSync(DeployConfig, { onExcessProperty: 'error' });

/**
 * Decodes a hosts file the way the CLI does, rejecting unknown fields.
 */
const decodeHosts = Schema.decodeUnknownSync(Hosts, { onExcessProperty: 'error' });

const app: App = {
  dir: '/repo',
  config: {
    name: 'app',
    host: 'server',
    targets: [],
    composeFiles: ['compose.yaml'],
    execution: 'ssh',
    remote: { stackDir: '/srv/app' },
    ingress: { caddy },
    secrets: { none: {} },
  },
};

const host: HostConfig = {
  ssh: 'server',
  platform: 'linux/amd64',
  transport: { mode: 'ssh-load' },
  ingress: { caddy: caddyHost },
};

/**
 * Reads real YAML files through the same loaders used by the CLI.
 */
const loadFixture = Effect.fn(function* () {
  const directory = yield* Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-config-')));
  const dir = directory.path;
  return yield* Effect.gen(function* () {
    yield* Effect.promise(() => writeFile(join(dir, 'deploy.yaml'), YAML.stringify(app.config)));
    yield* Effect.promise(() =>
      writeFile(join(dir, 'hosts.yaml'), YAML.stringify({ server: host })),
    );

    const loadedApp = yield* loadApp(dir);
    const loadedHosts = yield* loadHosts(join(dir, 'hosts.yaml'));

    assert.deepStrictEqual(loadedApp.config, app.config);
    assert.deepStrictEqual(loadedHosts.server, host);
    assert.strictEqual(ingressFor(loadedApp), hostIngress(loadedHosts.server!));

    yield* Effect.promise(() =>
      writeFile(
        join(dir, 'deploy.yaml'),
        YAML.stringify({ ...app.config, ingress: { caddy, 'cloudflare-tunnel': cloudflare } }),
      ),
    );

    const invalidApp = yield* loadApp(dir).pipe(Effect.flip);
    assert.include(invalidApp.message, 'invalid configuration');

    yield* Effect.promise(() =>
      writeFile(join(dir, 'hosts.yaml'), YAML.stringify({ server: { ...host, proxy: caddyHost } })),
    );

    const invalidHost = yield* loadHosts(join(dir, 'hosts.yaml')).pipe(Effect.flip);
    assert.include(invalidHost.message, 'never both');
  }).pipe(Effect.ensuring(Effect.promise(() => directory.remove())));
});

describe('named extension configuration', () => {
  it.effect('loads app and host extension settings through the real YAML loaders', () =>
    loadFixture().pipe(Effect.provide(NodeServices.layer)),
  );

  it('keeps Caddy planning and frozen SSH releases equivalent to legacy configuration', () => {
    const canonical = decodeDeployConfig(app.config);
    const hosts = decodeHosts({ server: host });

    assert.deepStrictEqual(ingressOf(canonical), { mode: 'caddy', ...caddy });
    assert.deepStrictEqual(ingressConfigOf(hosts.server!), { provider: 'caddy', ...caddyHost });

    const { address, ...proxy } = caddyHost;
    const { ingress: _hostIngress, ...baseHost } = host;
    const legacyHost: HostConfig = { ...baseHost, address, proxy };
    const legacyApp: App = {
      ...app,
      config: {
        ...app.config,
        ingress: { mode: 'caddy', ...caddy },
        secrets: { provider: 'none' },
      },
    };

    const extension = ingressFor(app)!;
    assert.deepStrictEqual(extension.plan(app, host), extension.plan(legacyApp, legacyHost));
    assert.deepStrictEqual(extension.setup(host), extension.setup(legacyHost));
    assert.deepStrictEqual(
      deploymentScript(app, host, 'one', []),
      deploymentScript(legacyApp, legacyHost, 'one', []),
    );

    const checks = extension.checks(app, host, [address], {
      proxy_dir: 'present',
      caddyfile_import: 'yes',
      compose_mount: 'yes',
      running_mount: 'yes',
      container_running: 'yes',
      container_health: 'none',
      network: 'yes',
    });
    assert.deepStrictEqual(blocking(checks), []);
  });

  it('selects Cloudflare from named app and host settings', () => {
    const selected: App = {
      ...app,
      config: decodeDeployConfig({
        ...app.config,
        ingress: { 'cloudflare-tunnel': cloudflare },
      }),
    };

    const namedHost = decodeHosts({
      server: { ...host, ingress: { 'cloudflare-tunnel': cloudflareHost } },
    }).server!;
    const extension = ingressFor(selected)!;
    assert.strictEqual(extension.id, 'cloudflare-tunnel');
    assert.strictEqual(hostIngress(namedHost), extension);
    assert.strictEqual(extension.plan(selected, namedHost).healthUrl, 'https://app.example.com/');

    const { ingress: _hostIngress, ...baseHost } = namedHost;
    const legacyHost: HostConfig = {
      ...baseHost,
      proxy: { provider: 'cloudflare-tunnel', ...cloudflareHost },
    };
    const legacyApp: App = {
      ...selected,
      config: { ...selected.config, ingress: { mode: 'cloudflare-tunnel', ...cloudflare } },
    };
    assert.deepStrictEqual(
      deploymentScript(selected, namedHost, 'one', []),
      deploymentScript(legacyApp, legacyHost, 'one', []),
    );
  });

  for (const [name, ingress] of [
    ['empty selection', {}],
    ['unknown extension', { nginx: caddy }],
    ['missing required app settings', { caddy: { domain: caddy.domain } }],
    ['unknown app setting', { caddy: { ...caddy, typo: true } }],
    ['multiple selected extensions', { caddy, 'cloudflare-tunnel': cloudflare }],
    ['none mixed with an extension', { none: {}, caddy }],
    ['retired Caddy identifier', { mode: 'caddy-sites', ...caddy }],
    ['legacy and nested settings', { mode: 'caddy', ...caddy, caddy }],
    ['settings on none', { none: { domain: caddy.domain } }],
  ] as const) {
    it(`rejects ${name}`, () =>
      assert.throws(() =>
        decodeDeployConfig({
          ...app.config,
          ingress,
        }),
      ));
  }

  it('rejects missing, unknown and ambiguous host extension settings', () => {
    for (const ingress of [
      {},
      { nginx: {} },
      { caddy: { dir: '/srv/caddy' } },
      { caddy: { ...caddyHost, wrong: true } },
      { none: {}, caddy: caddyHost },
      { none: {}, 'cloudflare-tunnel': cloudflareHost },
      { caddy: caddyHost, 'cloudflare-tunnel': { ...cloudflareHost, apiTokenFile: undefined } },
      {
        caddy: caddyHost,
        'cloudflare-tunnel': { ...cloudflareHost, provision: { secrets: { none: {} } } },
      },
    ]) {
      assert.throws(() =>
        decodeHosts({
          server: { ...host, ingress },
        }),
      );
    }

    assert.throws(
      () =>
        decodeHosts({
          server: { ...host, proxy: caddyHost },
        }),
      'never both',
    );
    assert.throws(() => ingressConfigOf({ ...host, proxy: caddyHost }), 'never both');

    const { ingress: _ingress, ...legacyHost } = host;
    assert.throws(() =>
      decodeHosts({
        server: { ...legacyHost, proxy: { ...caddyHost, provider: 'caddy-sites' } },
      }),
    );
  });

  it('selects each app provider independently on a host with both ingress capabilities', () => {
    const combined = decodeHosts({
      server: { ...host, ingress: { caddy: caddyHost, 'cloudflare-tunnel': cloudflareHost } },
    }).server!;
    assert.throws(() => ingressConfigOf(combined), 'select --ingress');
    assert.throws(() => hostIngress(combined), 'select --ingress');

    for (const [selectedApp, singleHost] of [
      [app, host],
      [
        { ...app, config: { ...app.config, ingress: { 'cloudflare-tunnel': cloudflare } } },
        { ...host, ingress: { 'cloudflare-tunnel': cloudflareHost } },
      ],
    ] as const) {
      const extension = ingressFor(selectedApp)!;
      assert.strictEqual(hostIngress(combined, extension.id), extension);
      assert.deepStrictEqual(
        extension.plan(selectedApp, combined),
        extension.plan(selectedApp, singleHost),
      );
      assert.strictEqual(
        extension.probe(selectedApp, combined),
        extension.probe(selectedApp, singleHost),
      );
      assert.strictEqual(
        extension.domain(selectedApp, combined),
        extension.domain(selectedApp, singleHost),
      );
      assert.deepStrictEqual(
        extension.checks(selectedApp, combined, [], {}),
        extension.checks(selectedApp, singleHost, [], {}),
      );
      assert.deepStrictEqual(
        deploymentScript(selectedApp, combined, 'one', []),
        deploymentScript(selectedApp, singleHost, 'one', []),
      );
    }

    assert.isUndefined(ingressConfigOf(host, 'cloudflare-tunnel'));
    assert.throws(() => hostIngress(host, 'cloudflare-tunnel'), 'no cloudflare-tunnel ingress');
  });

  it('replaces complete ingress and secret selections at destinations and honors explicit none', () => {
    const selected = selectDestination(
      {
        ...app,
        config: {
          ...app.config,
          secrets: { '1password': { environmentId: 'production' } },
          destinations: {
            staging: {
              ingress: { 'cloudflare-tunnel': cloudflare },
              secrets: { 'env-file': { path: 'staging.env' } },
            },
            private: { ingress: { none: {} }, secrets: { none: {} } },
          },
        },
      },
      'staging',
    );
    assert.deepStrictEqual(selected.config.ingress, { 'cloudflare-tunnel': cloudflare });
    assert.deepStrictEqual(secretSource(selected), { provider: 'env-file', path: 'staging.env' });

    const privateApp = selectDestination(selected, 'private');
    assert.isUndefined(ingressFor(privateApp));
    assert.deepStrictEqual(secretSource(privateApp), { provider: 'none' });
    assert.isUndefined(ingressConfigOf({ ...host, ingress: { none: {} } }));
    assert.throws(() => hostIngress({ ...host, ingress: { none: {} } }), 'Host has no proxy');
  });

  it('preserves 1Password allowlists in named, legacy, destination and local selections', () => {
    for (const secrets of [
      { '1password': { environmentId: 'prod', variables: ['TOKEN'] } },
      { provider: '1password', environmentId: 'prod', variables: ['TOKEN'] },
    ]) {
      const config = decodeDeployConfig({
        ...app.config,
        secrets,
        destinations: {
          staging: { secrets: { '1password': { environmentId: 'stage', variables: [] } } },
        },
        local: { secrets: { '1password': { environmentId: 'dev', variables: ['LOCAL_TOKEN'] } } },
      });
      const selected = { ...app, config };
      assert.deepStrictEqual(secretSource(selected), {
        provider: '1password',
        environmentId: 'prod',
        variables: ['TOKEN'],
      });
      assert.deepStrictEqual(secretSource(selected, { local: true }), {
        provider: '1password',
        environmentId: 'dev',
        variables: ['LOCAL_TOKEN'],
      });
      assert.deepStrictEqual(secretSource(selectDestination(selected, 'staging')), {
        provider: '1password',
        environmentId: 'stage',
        variables: [],
      });
    }
  });

  it('rejects invalid 1Password variable allowlists', () => {
    for (const variables of ['TOKEN', [123], [''], ['BAD-NAME'], ['TOKEN*'], ['TOKEN\n']]) {
      for (const secrets of [
        { '1password': { environmentId: 'prod', variables } },
        { provider: '1password', environmentId: 'prod', variables },
      ]) {
        assert.throws(() =>
          decodeDeployConfig({
            ...app.config,
            secrets,
          }),
        );
      }
    }
  });

  it('rejects ambiguous, unknown or incomplete credential selections', () => {
    for (const secrets of [
      {},
      { vault: {} },
      { '1password': {} },
      { '1password': { environmentId: 'prod', token: 'never-allowed' } },
      { '1password': { environmentId: 'prod' }, 'env-file': { path: 'dev.env' } },
      { provider: 'none', 'env-file': { path: 'dev.env' } },
      { none: {}, '1password': { environmentId: 'prod' } },
    ]) {
      assert.throws(() =>
        decodeDeployConfig({
          ...app.config,
          secrets,
        }),
      );
    }
  });

  it.effect(
    'resolves a named provider while keeping local source isolation and dry-run guarantees',
    () =>
      Effect.gen(function* () {
        const selected: App = {
          ...app,
          config: {
            ...app.config,
            secrets: { '1password': { environmentId: 'prod' } },
            local: { secrets: { none: {} } },
          },
        };

        let calls = 0;
        const read = readSecrets(selected).pipe(
          Effect.provideService(OnePasswordReader, async (id) => {
            calls++;

            assert.strictEqual(id, 'prod');

            return [{ name: 'TOKEN', value: 'fake', masked: true }];
          }),
        );
        assert.deepStrictEqual(yield* read.pipe(Effect.provideService(DryRun, true)), {});
        assert.strictEqual(calls, 0);
        assert.deepStrictEqual(yield* read, { TOKEN: 'fake' });
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(yield* readSecrets(selected, { local: true }), {});

        const { local: _local, ...config } = selected.config;
        assert.throws(
          () => secretSource({ ...selected, config }, { local: true }),
          'local.secrets',
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('resolves named dotenv paths relative to the deployment directory', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtempDisposable(join(tmpdir(), 'dd-nested-env-')),
      );
      const dir = directory.path;
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(dir, 'dev.env'), 'TOKEN=literal-$HOME\n'));

        const values = yield* readSecrets({
          dir,
          config: { ...app.config, secrets: { 'env-file': { path: 'dev.env' } } },
        });
        assert.deepStrictEqual(values, { TOKEN: 'literal-$HOME' });
      }).pipe(Effect.ensuring(Effect.promise(() => directory.remove())));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

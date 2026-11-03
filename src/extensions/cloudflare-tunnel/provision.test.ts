import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

import type { CloudflareProxy } from './config.ts';

import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { Hosts, loadHosts } from '../../config/hosts.ts';
import { setupOperationInput } from '../../ingress-setup.ts';
import { OnePasswordReader } from '../1password/index.ts';
import { cloudflareIngress } from './index.ts';
import { DEFAULT_CLOUDFLARED_IMAGE, provisionOperation } from './provision.ts';
import { defaultComposeTemplate, routeRule } from './templates.ts';

const accountId = 'a'.repeat(32);
const tunnelId = '12345678-1234-1234-1234-123456789abc';
const secret = 'SYNTHETIC_CONNECTOR_SECRET';
const token = Buffer.from(JSON.stringify({ a: accountId, t: tunnelId, s: secret })).toString(
  'base64',
);

/**
 * How long one bootstrap run may take against the fake daemon before it counts as hung.
 */
const SCRIPT_TIMEOUT_MILLIS = 10_000;

/**
 * Each test runs the real bootstrap script several times, so it gets more than the default five
 * seconds.
 */
const INTEGRATION_TIMEOUT_MILLIS = 15_000;

/**
 * Compose parser checks need only the installed CLI, never a running Docker daemon.
 */
const hasCompose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;

/**
 * Runs the actual host bootstrap against a disposable fake daemon without connecting to Cloudflare.
 */
function fixture(
  use: (f: {
    dir: string;
    proxy: CloudflareProxy;
    run: (proxy?: CloudflareProxy, credentials?: string) => ReturnType<typeof spawnSync>;
    calls: () => string[][];
  }) => void,
): void {
  using temporary = mkdtempDisposableSync(join(realpathSync(tmpdir()), 'compoza-cloudflare-'));
  const dir = temporary.path;

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'credentials.env'), `TUNNEL_TOKEN=${token}\n`, { mode: 0o600 });
  writeFileSync(
    join(bin, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const has = (name) => fs.existsSync(path.join(dir, name));
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n');
const fail = () => {
  console.error(${JSON.stringify(token)});
  process.exit(1);
};
if (args[0] === 'info') {
  process.exit(0);
}
if (args[0] === 'inspect') {
  if (!has('container.json')) {
    process.exit(1);
  }
  if (args.includes('-f')) {
    console.log('true healthy');
  } else {
    console.log(fs.readFileSync(path.join(dir, 'container.json'), 'utf8'));
  }
  process.exit(0);
}
if (args[0] === 'network') {
  if (args[1] === 'inspect') {
    process.exit(has('network') ? 0 : 1);
  }
  if (args[1] === 'create') {
    fs.writeFileSync(path.join(dir, 'network'), 'yes');
    process.exit(0);
  }
}
if (args[0] === 'compose') {
  const target = args[args.indexOf('-f') + 1];
  const text = fs.readFileSync(target, 'utf8');
  const match = text.match(/path: (?:"([^"\\n]+)"|([^\\n]+))/);
  const env = fs.readFileSync(match[1] || match[2], 'utf8');
  if (args.includes('config')) {
    if (has('fail-config')) {
      fail();
    }
    console.log(JSON.stringify({
      services: {
        connector: { environment: { TUNNEL_TOKEN: env.trim().slice('TUNNEL_TOKEN='.length) } },
      },
    }));
    process.exit(0);
  }
  if (args.includes('up')) {
    if (has('fail-up')) {
      fail();
    }
    fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify([
      {
        Config: {
          Labels: {
            'com.docker.compose.project': 'cf-ingress',
            'com.docker.compose.service': 'connector',
            'com.docker.compose.project.working_dir': path.join(dir, 'proxy'),
          },
        },
      },
    ]));
    process.exit(0);
  }
}
process.exit(95);
`,
    { mode: 0o700 },
  );

  const proxy: CloudflareProxy = {
    provider: 'cloudflare-tunnel',
    accountId,
    tunnelId,
    routing: 'manual',
    stateDir: join(dir, 'state'),
    dir: join(dir, 'proxy'),
    container: 'cf',
    network: 'cf_edge',
    provision: { envFile: join(dir, 'credentials.env') },
  };

  use({
    dir,
    proxy,
    calls: () =>
      existsSync(join(dir, 'calls'))
        ? readFileSync(join(dir, 'calls'), 'utf8')
            .trim()
            .split('\n')
            .map((s) => JSON.parse(s))
        : [],
    run: (selected = proxy, credentials) => {
      const operation = provisionOperation(selected);
      return spawnSync(
        '/bin/bash',
        ['-c', operation.script.replace(REMOTE_PATH, `export PATH=${shellQuote(bin)}:$PATH`)],
        {
          input: JSON.stringify({
            ...JSON.parse(operation.input!),
            ...(credentials === undefined ? {} : { credentials }),
          }),
          encoding: 'utf8',
          timeout: SCRIPT_TIMEOUT_MILLIS,
        },
      );
    },
  });
}

/**
 * Assertions intentionally exclude token values even when fake Docker emits them on failure.
 */
function succeeded(result: ReturnType<typeof spawnSync>): void {
  assert.strictEqual(result.status, 0, String(result.stderr));
  assert.notInclude(String(result.stdout) + String(result.stderr), token);
}

/**
 * Every host failure must retain safe diagnostics and release its setup lock.
 */
function failed(result: ReturnType<typeof spawnSync>): void {
  assert.notStrictEqual(result.status, 0);
  assert.notInclude(String(result.stdout) + String(result.stderr), token);
}

describe('Cloudflare connector provisioning', { timeout: INTEGRATION_TIMEOUT_MILLIS }, () => {
  it('can retry managed credential setup after Compose validation fails', () =>
    fixture((f) => {
      const proxy = {
        ...f.proxy,
        provision: { secrets: { '1password': { environmentId: 'test' } } },
      };
      writeFileSync(join(f.dir, 'fail-config'), 'yes');
      failed(f.run(proxy, `TUNNEL_TOKEN=${token}\n`));
      rmSync(join(f.dir, 'fail-config'));
      succeeded(f.run(proxy, `TUNNEL_TOKEN=${token}\n`));

      assert.isTrue(existsSync(join(f.proxy.dir!, 'compose.yaml')));
    }));

  it('provisions a hardened connector, rechecks ownership on rerun and waits for readiness', () =>
    fixture((f) => {
      succeeded(f.run());
      succeeded(f.run());

      const compose = YAML.parse(readFileSync(join(f.proxy.dir!, 'compose.yaml'), 'utf8'));
      const connector = compose.services.connector;
      assert.strictEqual(connector.image, DEFAULT_CLOUDFLARED_IMAGE);
      assert.strictEqual(connector.user, '65532:65532');
      assert.isTrue(connector.read_only);
      assert.deepStrictEqual(connector.cap_drop, ['ALL']);
      assert.deepStrictEqual(connector.security_opt, ['no-new-privileges:true']);
      assert.strictEqual(connector.stop_grace_period, '40s');
      assert.strictEqual(connector.mem_limit, '128m');
      assert.strictEqual(connector.pids_limit, 64);
      assert.isUndefined(connector.ports);
      assert.isUndefined(connector.environment);
      assert.isUndefined(connector.volumes);
      assert.include(connector.healthcheck.test, 'ready');
      assert.isTrue(
        f
          .calls()
          .filter((a) => a.includes('up'))
          .every((a) => a.includes('--wait') && a.includes('--force-recreate')),
      );
      assert.include(
        f.calls().find((a) => a[1] === 'create')!,
        '--internal',
      );
      assert.isFalse(existsSync(join(f.proxy.dir!, '.compoza-cloudflare.lock')));
    }));

  it('stages only selected credentials privately and rotates them without changing configuration', () =>
    fixture((f) => {
      const proxy = {
        ...f.proxy,
        provision: { secrets: { '1password': { environmentId: 'test' } } },
      };
      succeeded(f.run(proxy, `TUNNEL_TOKEN=${token}\n`));

      const env = join(f.proxy.dir!, '.credentials.env');
      assert.strictEqual(statSync(env).mode & 0o777, 0o600);
      assert.strictEqual(readFileSync(env, 'utf8'), `TUNNEL_TOKEN=${token}\n`);

      succeeded(f.run(proxy, `TUNNEL_TOKEN=${token}\n`));

      assert.notInclude(readFileSync(join(f.proxy.dir!, 'compose.yaml'), 'utf8'), token);
      assert.notInclude(readFileSync(join(f.dir, 'calls'), 'utf8'), token);
    }));

  it('refuses foreign containers, changed configuration, symlinks and permissive credentials', () =>
    fixture((f) => {
      writeFileSync(join(f.dir, 'credentials.env'), `TUNNEL_TOKEN=${token}\n`, { mode: 0o600 });
      chmodSync(join(f.dir, 'credentials.env'), 0o644);
      failed(f.run());
      chmodSync(join(f.dir, 'credentials.env'), 0o600);
      succeeded(f.run());
      writeFileSync(join(f.dir, 'container.json'), JSON.stringify([{ Config: { Labels: {} } }]));
      failed(f.run());
      rmSync(join(f.dir, 'container.json'));
      writeFileSync(join(f.proxy.dir!, 'compose.yaml'), 'foreign');
      failed(f.run());
      rmSync(join(f.proxy.dir!, 'compose.yaml'));
      symlinkSync(join(f.dir, 'credentials.env'), join(f.proxy.dir!, 'compose.yaml'));
      failed(f.run());
      symlinkSync(f.proxy.dir!, join(f.dir, 'link'));
      failed(f.run({ ...f.proxy, dir: join(f.dir, 'link', 'nested') }));

      assert.isFalse(existsSync(join(f.dir, 'link', 'nested')));
    }));

  it('rejects installation commands and credentials for another tunnel before starting a container', () =>
    fixture((f) => {
      for (const value of [
        `cloudflared.exe service install ${token}`,
        Buffer.from(JSON.stringify({ a: accountId, t: 'other', s: secret })).toString('base64'),
      ]) {
        writeFileSync(join(f.dir, 'credentials.env'), `TUNNEL_TOKEN=${value}\n`);
        failed(f.run());
      }

      assert.isFalse(f.calls().some((a) => a.includes('up')));
    }));

  it('suppresses daemon diagnostics on failure and allows a later retry', () =>
    fixture((f) => {
      for (const flag of ['fail-config', 'fail-up']) {
        writeFileSync(join(f.dir, flag), 'yes');
        failed(f.run());
        rmSync(join(f.dir, flag));

        assert.isFalse(existsSync(join(f.proxy.dir!, '.compoza-cloudflare.lock')));
      }

      succeeded(f.run());
    }));

  it('renders custom templates but preserves credential, identity and isolation invariants', () =>
    fixture((f) => {
      const custom = defaultComposeTemplate
        .replace('128m', '256m')
        .replace(', run]', ', --protocol, http2, run]');

      const operation = provisionOperation({
        ...f.proxy,
        templates: { compose: { inline: custom } },
      });
      assert.strictEqual(
        YAML.parse(JSON.parse(operation.input!).compose).services.connector.mem_limit,
        '256m',
      );

      for (const text of [
        custom.replace('read_only: true', 'read_only: false'),
        custom.replace(', http2, run]', ', http2, --token=literal-secret, run]'),
        custom.replace('max-size: 10m', 'max-size: 0'),
        custom.replace('stop_grace_period: {{stopGracePeriod}}', 'stop_grace_period: 1s'),
        custom.replace('128m', '0').replace('256m', '0'),
        custom.replace('{{container}}', '"foreign"'),
        custom.replace('{{image}}', '{{typo}}'),
      ]) {
        assert.throws(() =>
          provisionOperation({ ...f.proxy, templates: { compose: { inline: text } } }),
        );
      }
    }));

  it.skipIf(!hasCompose)(
    'is accepted by the real Compose parser with a read-only connector and private env file',
    () =>
      fixture((f) => {
        const operation = provisionOperation(f.proxy);
        mkdirSync(f.proxy.dir!);

        const file = join(f.proxy.dir!, 'compose.yaml');
        writeFileSync(file, JSON.parse(operation.input!).compose);

        const result = spawnSync(
          'docker',
          ['compose', '--env-file', '/dev/null', '-f', file, 'config', '--quiet'],
          { encoding: 'utf8' },
        );
        assert.strictEqual(result.status, 0, result.stderr);
      }),
  );

  it('validates new settings while preserving existing managed host configuration', () =>
    fixture((f) => {
      const { provider: _provider, ...settings } = f.proxy;
      const host = {
        ssh: 'fixture',
        platform: 'linux/arm64',
        transport: { mode: 'ssh-load' },
        ingress: { 'cloudflare-tunnel': settings },
      };
      assert.isDefined(
        Schema.decodeUnknownSync(Hosts, { onExcessProperty: 'error' })({ fixture: host }),
      );

      for (const provision of [
        {},
        { envFile: '/tmp/env', secrets: { '1password': { environmentId: 'x' } } },
        { envFile: '/tmp/env', image: '-bad' },
        { envFile: '/tmp/env', user: '0:0' },
      ]) {
        assert.throws(() =>
          Schema.decodeUnknownSync(Hosts, { onExcessProperty: 'error' })({
            fixture: { ...host, ingress: { 'cloudflare-tunnel': { ...f.proxy, provision } } },
          }),
        );
      }
    }));

  it('keeps manual routes untouched without API access while still probing the host connector', () =>
    fixture((f) => {
      const app = {
        dir: f.dir,
        config: {
          name: 'app',
          host: 'fixture',
          targets: [],
          composeFiles: ['compose.yaml'] as [string],
          ingress: { 'cloudflare-tunnel': { domain: 'app.example.com', service: 'http://app:80' } },
        },
      };

      const host = {
        ssh: 'fixture',
        platform: 'linux/arm64',
        transport: { mode: 'ssh-load' as const },
        proxy: f.proxy,
      };
      const plan = cloudflareIngress.plan(app, host);
      assert.notInclude(plan.route.script, 'curl');
      assert.notInclude(plan.unroute.script, 'curl');
      assert.notInclude(cloudflareIngress.probe(app, host)!, 'api.cloudflare.com');
      assert.deepStrictEqual(
        cloudflareIngress
          .checks(app, host, ['1.2.3.4'], { cf_connector: 'yes', cf_network: 'yes' })
          .filter((c) => !c.ok),
        [],
      );
    }));

  it('renders per-app origin settings while rejecting route ownership changes', () =>
    fixture((f) => {
      const app = {
        dir: f.dir,
        config: {
          name: 'app',
          host: 'fixture',
          targets: [],
          composeFiles: ['compose.yaml'] as [string],
          ingress: {
            'cloudflare-tunnel': { domain: 'app.example.com', service: 'https://app:443' },
          },
        },
      };

      const template = {
        inline: [
          'hostname: {{domain}}',
          'service: {{service}}',
          'originRequest:',
          '  connectTimeout: 20',
          '  httpHostHeader: origin.example.com',
          '',
        ].join('\n'),
      };
      const rule = routeRule({ ...f.proxy, templates: { route: template } }, app, 'app');
      assert.deepStrictEqual(rule.originRequest, {
        connectTimeout: 20,
        httpHostHeader: 'origin.example.com',
      });
      assert.throws(() =>
        routeRule(
          {
            ...f.proxy,
            templates: {
              route: { inline: template.inline.replace('{{domain}}', '"other.example.com"') },
            },
          },
          app,
          'app',
        ),
      );
    }));

  it.effect('uses the native credential provider and discards unrelated variables', () =>
    Effect.gen(function* () {
      let calls = 0;
      const input = yield* setupOperationInput({
        label: 'fixture',
        script: 'true',
        input: '{"compose":"safe"}',
        secrets: { '1password': { environmentId: 'fixture' } },
        secretVariables: { TUNNEL_TOKEN: 'CLOUDFLARE_TUNNEL_TOKEN' },
      }).pipe(
        Effect.provideService(OnePasswordReader, async () => {
          calls++;

          return [
            { name: 'CLOUDFLARE_TUNNEL_TOKEN', value: token, masked: true },
            { name: 'OTHER_SECRET', value: 'discard', masked: true },
          ];
        }),
      );

      assert.strictEqual(calls, 1);
      assert.strictEqual(JSON.parse(input!).credentials, `TUNNEL_TOKEN=${token}\n`);
      assert.notInclude(input!, 'discard');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('loads templates and dotenv sources relative to external host files', () =>
    Effect.gen(function* () {
      const { path: dir } = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-cloudflare-load-'))),
        (directory) => Effect.promise(() => directory.remove()),
      );

      writeFileSync(join(dir, 'connector.tmpl'), defaultComposeTemplate);
      writeFileSync(
        join(dir, 'host.yaml'),
        YAML.stringify({
          ssh: 'fixture',
          platform: 'linux/arm64',
          transport: { mode: 'ssh-load' },
          ingress: {
            'cloudflare-tunnel': {
              accountId,
              tunnelId,
              routing: 'manual',
              stateDir: '/srv/state',
              dir: '/srv/cloudflared',
              container: 'cf',
              network: 'edge',
              provision: { secrets: { 'env-file': { path: 'credentials.env' } } },
              templates: { compose: 'connector.tmpl' },
            },
          },
        }),
      );
      writeFileSync(join(dir, 'hosts.yaml'), YAML.stringify({ fixture: { $ref: 'host.yaml' } }));

      const hosts = yield* loadHosts(join(dir, 'hosts.yaml'));

      const selected = hosts.fixture!.ingress!;
      assert.isTrue('cloudflare-tunnel' in selected);

      if ('cloudflare-tunnel' in selected) {
        assert.deepStrictEqual(selected['cloudflare-tunnel'].templates?.compose, {
          inline: defaultComposeTemplate,
        });
        assert.deepStrictEqual(selected['cloudflare-tunnel'].provision?.secrets, {
          'env-file': { path: join(dir, 'credentials.env') },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it('previews setup through the CLI without SSH or provider access', () =>
    fixture((f) => {
      const hosts = join(f.dir, 'hosts.yaml');
      writeFileSync(
        hosts,
        YAML.stringify({
          fixture: {
            ssh: 'never-contact.invalid',
            platform: 'linux/arm64',
            transport: { mode: 'ssh-load' },
            proxy: {
              ...f.proxy,
              provision: { secrets: { '1password': { environmentId: 'must-not-fetch' } } },
            },
          },
        }),
      );
      writeFileSync(join(f.dir, 'bin', 'ssh'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });

      const result = spawnSync(
        process.execPath,
        [resolve('bin/compoza.ts'), '--hosts', hosts, 'setup-proxy', 'fixture', '--dry-run'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${join(f.dir, 'bin')}:${process.env.PATH}`,
            COMPOZA_1PASSWORD_ACCOUNT: '',
          },
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, 'provision Cloudflare');
      assert.notInclude(result.stdout, token);
      assert.isFalse(existsSync(f.proxy.dir!));
      assert.deepStrictEqual(f.calls(), []);
    }));
});

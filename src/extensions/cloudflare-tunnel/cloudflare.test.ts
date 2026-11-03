import { assert, describe, it } from '@effect/vitest';
import { Schema } from 'effect';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from '../../config/deploy.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { CloudflareProxy } from './config.ts';

import { blocking } from '../../checks.ts';
import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { DeployConfig } from '../../config/deploy.ts';
import { Hosts } from '../../config/hosts.ts';
import { parseCheck } from '../../probe.ts';
import { deploymentScript } from '../../ssh-plan.ts';
import { hostIngress, ingressFor } from '../ingress.ts';
import { cloudflareIngress } from './index.ts';

const accountId = 'a'.repeat(32);
const tunnelId = '12345678-1234-1234-1234-123456789abc';
const sentinel = 'SENTINEL_CLOUDFLARE_TOKEN';

/**
 * How long one host script may run against the fake API before it counts as hung.
 */
const SCRIPT_TIMEOUT_MILLIS = 10_000;

/**
 * Each test runs several real Bash/jq scripts, so it gets more than the default five seconds.
 */
const INTEGRATION_TIMEOUT_MILLIS = 15_000;

/**
 * A route template that adds origin settings to the required hostname and service.
 */
const ORIGIN_ROUTE_TEMPLATE = [
  'hostname: {{domain}}',
  'service: {{service}}',
  'originRequest:',
  '  connectTimeout: 20',
  '  httpHostHeader: origin.example.com',
  '',
].join('\n');

const unrelated = {
  hostname: 'other.example.com',
  service: 'https://other:443',
  originRequest: { connectTimeout: 20 },
};

/**
 * Runs the real extension scripts with a fake curl API, never contacting Cloudflare or Docker.
 */
function fixture(
  use: (f: {
    dir: string;
    app: App;
    host: HostConfig;
    tunnel: CloudflareProxy;
    root: string;
    run: (script: string) => ReturnType<typeof spawnSync>;
    state: () => any;
    setState: (value: unknown) => void;
  }) => void,
): void {
  using temporary = mkdtempDisposableSync(join(tmpdir(), 'dd-cloudflare-'));
  const dir = temporary.path;
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'token'), sentinel + '\n', { mode: 0o600 });
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      version: 1,
      config: {
        originRequest: { connectTimeout: 10 },
        ingress: [unrelated, { service: 'http_status:404' }],
      },
    }),
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const auth = fs.readFileSync(0, 'utf8');
const method = args[args.indexOf('--request') + 1];
const url = args[args.indexOf('--url') + 1];
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify({method, url, args}) + '\\n');
if (args[0] !== '--disable' || args.includes(${JSON.stringify(sentinel)}) || process.env.cf_token !== undefined || auth !== 'header = "Authorization: Bearer ${sentinel}"\\n') process.exit(92);
const get = (name) => fs.existsSync(path.join(dir, name));
if (get('fail-api')) { console.error(${JSON.stringify(sentinel)}); console.log(JSON.stringify({success:false,errors:[{message:${JSON.stringify(sentinel)}}]})); process.exit(0); }
let state = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
if (!url.endsWith('/configurations')) {
  console.log(JSON.stringify({success:true,result:{config_src:get('local')?'local':'cloudflare',status:get('down')?'down':'healthy',deleted_at:null}}));
} else if (method === 'GET') {
  if (get('concurrent') && get('seen-config')) { state.version++; state.config.originRequest.connectTimeout++; fs.writeFileSync(path.join(dir,'api.json'),JSON.stringify(state)); }
  if (get('concurrent')) fs.writeFileSync(path.join(dir,'seen-config'),'yes');
  console.log(JSON.stringify({success:true,result:state}));
} else {
  if (get('reject-put')) { console.log(JSON.stringify({success:false,errors:[{message:${JSON.stringify(sentinel)}}]})); process.exit(0); }
  const file = args[args.indexOf('--data-binary') + 1].slice(1);
  const request = JSON.parse(fs.readFileSync(file, 'utf8'));
  state = {version:state.version+1,config:request.config};
  fs.writeFileSync(path.join(dir,'api.json'), JSON.stringify(state));
  if (get('timeout-put')) process.exit(28);
  console.log(JSON.stringify({success:true,result:state}));
}
`,
    { mode: 0o700 },
  );

  const tunnel: CloudflareProxy = {
    accountId,
    tunnelId,
    apiTokenFile: join(dir, 'token'),
    stateDir: join(dir, 'state'),
  };
  const host: HostConfig = {
    ssh: 'fixture',
    platform: 'linux/arm64',
    transport: { mode: 'ssh-load' },
    ingress: { 'cloudflare-tunnel': tunnel },
  };
  const app: App = {
    dir,
    config: {
      name: 'app',
      projectName: 'app-staging',
      host: 'fixture',
      targets: [],
      composeFiles: ['compose.yaml'],
      execution: 'ssh',
      remote: { stackDir: join(dir, 'stack') },
      ingress: {
        'cloudflare-tunnel': { domain: 'app.example.com', service: 'http://web:8080' },
      },
    },
  };

  const run = (script: string) =>
    spawnSync(
      '/bin/bash',
      ['-c', script.replaceAll(REMOTE_PATH, `export PATH=${shellQuote(bin)}:$PATH`)],
      { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MILLIS },
    );

  use({
    dir,
    host,
    tunnel,
    app,
    root: join(dir, 'state', `${accountId}-${tunnelId}`),
    run,
    state: () => JSON.parse(readFileSync(join(dir, 'api.json'), 'utf8')),
    setState: (value) => writeFileSync(join(dir, 'api.json'), JSON.stringify(value)),
  });
}

/**
 * Asserts that a script succeeded without printing the API token.
 */
function succeeded(result: ReturnType<typeof spawnSync>) {
  assert.strictEqual(result.status, 0, String(result.stderr));
  assert.notInclude(String(result.stdout) + String(result.stderr), sentinel);
}

/**
 * Asserts that a script failed without printing the API token.
 */
function failed(result: ReturnType<typeof spawnSync>) {
  assert.notStrictEqual(result.status, 0);
  assert.notInclude(String(result.stdout) + String(result.stderr), sentinel);
}

describe('Cloudflare Tunnel extension', { timeout: INTEGRATION_TIMEOUT_MILLIS }, () => {
  it('applies templated origin settings through the real merge and rejects subsequent external edits', () =>
    fixture(({ app, host, tunnel, run, state, setState }) => {
      const selected: HostConfig = {
        ...host,
        ingress: {
          'cloudflare-tunnel': {
            ...tunnel,
            templates: { route: { inline: ORIGIN_ROUTE_TEMPLATE } },
          },
        },
      };
      succeeded(run(cloudflareIngress.setup(selected).script));

      const plan = cloudflareIngress.plan(app, selected);
      succeeded(run(plan.route.script));

      assert.deepStrictEqual(state().config.ingress[0].originRequest, {
        connectTimeout: 20,
        httpHostHeader: 'origin.example.com',
      });

      succeeded(run(plan.route.script));

      const changed = state();
      changed.config.ingress[0].originRequest.connectTimeout = 99;
      setState(changed);
      failed(run(plan.unroute.script));

      assert.deepStrictEqual(state(), changed);
    }));

  it('decodes without a public origin address and rejects invalid identifiers and credential-bearing URLs', () =>
    fixture(({ app, host, tunnel }) => {
      assert.deepStrictEqual(Schema.decodeUnknownSync(Hosts)({ fixture: host }), { fixture: host });
      assert.strictEqual(ingressFor(app), cloudflareIngress);
      assert.strictEqual(hostIngress(host), cloudflareIngress);

      for (const service of [
        'https://user:pass@web',
        'http://web/path',
        'http://web?token=secret',
        'file:///tmp/app',
        'http://web\n',
      ]) {
        assert.throws(() =>
          Schema.decodeUnknownSync(DeployConfig)({
            ...app.config,
            ingress: {
              'cloudflare-tunnel': { domain: 'app.example.com', service },
            },
          }),
        );
      }

      assert.throws(() =>
        Schema.decodeUnknownSync(Hosts)({
          fixture: {
            ...host,
            ingress: { 'cloudflare-tunnel': { ...tunnel, accountId: '../other' } },
          },
        }),
      );
    }));

  it('probes without creating files, prepares private storage, and distinguishes edge DNS from the host IP', () =>
    fixture(({ app, host, tunnel, root, run, dir }) => {
      const probe = cloudflareIngress.probe(app, host)!;
      assert.notInclude(probe, sentinel);

      succeeded(run(probe));

      assert.isFalse(existsSync(root));
      assert.notInclude(readFileSync(join(dir, 'calls'), 'utf8'), '"PUT"');

      succeeded(run(cloudflareIngress.setup(host).script));

      assert.strictEqual(statSync(root).mode & 0o777, 0o700);

      const result = run(probe);
      succeeded(result);

      const caddy = {
        address: '192.0.2.1',
        dir: '/srv/caddy',
        container: 'caddy',
        network: 'edge',
      };
      const checks = cloudflareIngress.checks(
        app,
        { ...host, ingress: { caddy, 'cloudflare-tunnel': tunnel } },
        ['198.51.100.10'],
        parseCheck(String(result.stdout)),
      );
      assert.deepStrictEqual(blocking(checks), []);
      assert.isFalse(checks.find((check) => check.name === 'route')!.ok);
    }));

  it('retains deployed removal metadata and supports route updates and idempotent removal without changing other apps', () =>
    fixture(({ app, host, run, state, dir }) => {
      succeeded(run(cloudflareIngress.setup(host).script));

      const plan = cloudflareIngress.plan(app, host);
      const deployment = deploymentScript(app, host, 'one', []);
      assert.notInclude(deployment.script + deployment.input, sentinel);

      const records = deployment.input
        .split('\n')
        .map((line) => Buffer.from(line, 'base64').toString('utf8'));
      const metadata = JSON.parse(records[0]!);
      assert.strictEqual(metadata.unroute, plan.unroute.script);
      assert.include(deployment.script, shellQuote(plan.route.script));
      succeeded(run(plan.route.script));

      assert.deepStrictEqual(state().config.ingress, [
        { hostname: 'app.example.com', service: 'http://web:8080' },
        unrelated,
        { service: 'http_status:404' },
      ]);
      assert.deepStrictEqual(state().config.originRequest, { connectTimeout: 10 });

      const version = state().version;
      succeeded(run(plan.route.script));

      assert.strictEqual(state().version, version);

      const next: App = {
        ...app,
        config: {
          ...app.config,
          ingress: {
            'cloudflare-tunnel': { domain: 'new.example.com', service: 'https://new:443' },
          },
        },
      };
      succeeded(run(cloudflareIngress.plan(next, host).route.script));

      assert.strictEqual(state().config.ingress[0].hostname, 'new.example.com');

      succeeded(run(plan.route.script));

      assert.strictEqual(state().config.ingress[0].hostname, 'app.example.com');

      succeeded(run(plan.unroute.script));
      succeeded(run(plan.unroute.script));

      assert.deepStrictEqual(state().config.ingress, [unrelated, { service: 'http_status:404' }]);
      assert.notInclude(readFileSync(join(dir, 'calls'), 'utf8'), sentinel);
    }));

  it('refuses unowned hostnames and external edits without changing remote configuration', () =>
    fixture(({ app, host, run, state, setState }) => {
      succeeded(run(cloudflareIngress.setup(host).script));

      const before = state();
      before.config.ingress.unshift({
        hostname: 'app.example.com',
        service: 'http://someone-else:80',
      });
      setState(before);
      failed(run(cloudflareIngress.plan(app, host).route.script));

      assert.deepStrictEqual(state(), before);

      before.config.ingress.shift();
      setState(before);
      succeeded(run(cloudflareIngress.plan(app, host).route.script));

      const changed = state();
      changed.config.ingress[0].originRequest = { noTLSVerify: true };
      setState(changed);
      failed(run(cloudflareIngress.plan(app, host).unroute.script));

      assert.deepStrictEqual(state(), changed);
    }));

  it('keeps ownership across an ambiguous PUT timeout and safely retries and removes the accepted route', () =>
    fixture(({ app, host, run, state, dir, root }) => {
      succeeded(run(cloudflareIngress.setup(host).script));
      writeFileSync(join(dir, 'timeout-put'), 'yes');
      failed(run(cloudflareIngress.plan(app, host).route.script));

      assert.strictEqual(state().config.ingress[0].hostname, 'app.example.com');
      assert.isFalse(existsSync(join(root, '.lock')));

      rmSync(join(dir, 'timeout-put'));
      succeeded(run(cloudflareIngress.plan(app, host).route.script));
      succeeded(run(cloudflareIngress.plan(app, host).unroute.script));

      assert.deepStrictEqual(state().config.ingress, [unrelated, { service: 'http_status:404' }]);
    }));

  it('retains the prior configuration on API rejection and never emits API or authentication diagnostics', () =>
    fixture(({ app, host, run, state, dir }) => {
      succeeded(run(cloudflareIngress.setup(host).script));

      const before = state();
      writeFileSync(join(dir, 'reject-put'), 'yes');
      failed(run(cloudflareIngress.plan(app, host).route.script));

      assert.deepStrictEqual(state(), before);

      rmSync(join(dir, 'reject-put'));
      writeFileSync(join(dir, 'fail-api'), 'yes');
      succeeded(run(cloudflareIngress.probe(app, host)!));
      failed(run(cloudflareIngress.plan(app, host).route.script));
    }));

  it('blocks shared-tunnel races, second-project ownership and locally managed tunnels', () =>
    fixture(({ app, host, run, dir, root, state }) => {
      succeeded(run(cloudflareIngress.setup(host).script));
      mkdirSync(join(root, '.lock'));
      failed(run(cloudflareIngress.plan(app, host).route.script));

      assert.isTrue(existsSync(join(root, '.lock')));

      rmSync(join(root, '.lock'), { recursive: true });
      writeFileSync(join(dir, 'concurrent'), 'yes');
      failed(run(cloudflareIngress.plan(app, host).route.script));

      assert.deepStrictEqual(state().config.ingress, [unrelated, { service: 'http_status:404' }]);

      rmSync(join(dir, 'concurrent'));

      const second: App = { ...app, config: { ...app.config, projectName: 'second-app' } };
      failed(run(cloudflareIngress.plan(second, host).route.script));
      succeeded(run(cloudflareIngress.plan(app, host).route.script));
      writeFileSync(join(dir, 'local'), 'yes');
      failed(run(cloudflareIngress.plan(app, host).route.script));

      assert.deepStrictEqual(readdirSync(root).sort(), ['routes']);
    }));

  it('reports incompatible host extensions as readiness failures', () =>
    fixture(({ app, host }) => {
      const caddyHost: HostConfig = {
        ...host,
        ingress: { caddy: { dir: '/srv/caddy', container: 'caddy', network: 'edge' } },
      };
      assert.isUndefined(cloudflareIngress.probe(app, caddyHost));
      assert.isAbove(blocking(cloudflareIngress.checks(app, caddyHost, [], {})).length, 0);
      assert.throws(() => cloudflareIngress.plan(app, caddyHost), 'matching host proxy');

      const caddyApp: App = {
        ...app,
        config: {
          ...app.config,
          ingress: { caddy: { domain: 'app.example.com', upstream: 'web:80' } },
        },
      };
      const caddy = ingressFor(caddyApp)!;
      assert.isUndefined(caddy.probe(caddyApp, host));
      assert.isAbove(blocking(caddy.checks(caddyApp, host, [], {})).length, 0);
    }));
});

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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

import type { ProxyConfig } from './config.ts';

import { REMOTE_PATH } from '../../command.ts';
import { HostConfig } from '../../config/hosts.ts';
import { caddyIngress } from './index.ts';
import { provisionOperation } from './provision.ts';

/**
 * Compose config validation needs only the installed CLI, never a running Docker daemon.
 */
const hasCompose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;

/**
 * Runs the real Bash 3.2-compatible bootstrap with synthetic credentials and a fake Docker
 * executable.
 */
function fixture(
  use: (f: {
    dir: string;
    proxy: ProxyConfig;
    run: (proxy?: ProxyConfig) => ReturnType<typeof spawnSync>;
    calls: () => string[][];
  }) => void,
): void {
  using temporary = mkdtempDisposableSync(join(tmpdir(), 'dd-caddy-'));
  const dir = temporary.path;
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'credentials.env'), 'CLOUDFLARE_API_TOKEN=FAKE_SECRET_$literal\n');
  writeFileSync(
    join(bin, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const has = name => fs.existsSync(path.join(dir, name));
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n');
const fail = () => { console.error('FAKE_SECRET_$literal'); process.exit(1); };
if (args[0] === 'info') process.exit(0);
if (args[0] === 'inspect') {
  if (!has('container.json')) process.exit(1);
  const owner = JSON.parse(fs.readFileSync(path.join(dir, 'container.json'), 'utf8'));
  if (args.includes('-f')) console.log(args[args.indexOf('-f')+1].includes('working_dir') ? owner.directory : args[args.indexOf('-f')+1].includes('project') ? owner.project : owner.service);
  process.exit(0);
}
if (args[0] === 'network') {
  if (args[1] === 'inspect') process.exit(has('network') ? 0 : 1);
  if (args[1] !== 'create') process.exit(90);
  fs.writeFileSync(path.join(dir, 'network'), 'yes'); process.exit(0);
}
if (args[0] === 'run') {
  if (has('fail-validate')) fail();
  if (!args.includes('--entrypoint') || !args.includes('validate')) process.exit(91);
  const mounts = args.filter((v,i)=>args[i-1]==='-v');
  if (!mounts.some(v=>v.endsWith(':/etc/caddy/Caddyfile:ro')) || !mounts.some(v=>v.endsWith(':/etc/caddy/sites:ro'))) process.exit(92);
  process.exit(0);
}
if (args[0] === 'compose') {
  if (!fs.existsSync(args[args.indexOf('-f')+1])) process.exit(93);
  if (args.includes('config')) { if (has('fail-compose')) fail(); process.exit(0); }
  if (args.includes('up')) {
    if (has('fail-start')) fail();
    fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify({project:args[args.indexOf('--project-name')+1], service:args.at(-1), directory:args[args.indexOf('--project-directory')+1]}));
    process.exit(0);
  }
}
process.exit(94);
`,
    { mode: 0o700 },
  );

  const proxy: ProxyConfig = {
    dir: join(dir, 'proxy'),
    container: 'caddy',
    service: 'ingress',
    composeFile: 'compose.yml',
    network: 'fixture_edge',
    logSnippet: 'request_log',
    provision: {
      image: 'ghcr.io/caddybuilds/caddy-cloudflare:latest',
      envFile: join(dir, 'credentials.env'),
      acmeDns: 'cloudflare {env.CLOUDFLARE_API_TOKEN}',
      networkAliases: ['notes.example.com'],
    },
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
    run: (selected = proxy) => {
      const op = provisionOperation(selected);
      return spawnSync('/bin/bash', ['-c', op.script.replace(REMOTE_PATH, '')], {
        input: op.input,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    },
  });
}

describe('Caddy provisioning', { timeout: 15000 }, () => {
  it('installs a rendered custom config and refuses subsequent template changes', () =>
    fixture((f) => {
      const selected = {
        ...f.proxy,
        templates: { config: { inline: '# custom Caddyfile\n{{sitesImport}}\n' } },
      };
      assert.strictEqual(f.run(selected).status, 0);

      const original = readFileSync(join(f.proxy.dir, 'Caddyfile'), 'utf8');
      assert.strictEqual(original, '# custom Caddyfile\nimport /etc/caddy/sites/*.caddy\n');

      const changed = {
        ...selected,
        templates: { config: { inline: '# changed\n{{sitesImport}}\n' } },
      };
      assert.notStrictEqual(f.run(changed).status, 0);
      assert.strictEqual(readFileSync(join(f.proxy.dir, 'Caddyfile'), 'utf8'), original);
    }));

  it.skipIf(!hasCompose)(
    'accepts generated Compose with literal env-file credentials in the real parser',
    () =>
      fixture((f) => {
        mkdirSync(f.proxy.dir);

        const input = JSON.parse(provisionOperation(f.proxy).input!);
        writeFileSync(join(f.proxy.dir, 'compose.yml'), input.compose);
        writeFileSync(join(f.proxy.dir, '.env'), 'CLOUDFLARE_API_TOKEN=WRONG_IMPLICIT_VALUE\n');

        const result = spawnSync(
          'docker',
          [
            'compose',
            '--env-file',
            '/dev/null',
            '-f',
            join(f.proxy.dir, 'compose.yml'),
            'config',
            '--format',
            'json',
          ],
          { encoding: 'utf8' },
        );
        assert.strictEqual(result.status, 0, result.stderr);

        const config = JSON.parse(result.stdout);
        // Compose escapes dollar signs when rendering a model for reuse as configuration.
        assert.strictEqual(
          config.services.ingress.environment.CLOUDFLARE_API_TOKEN.replaceAll('$$', '$'),
          'FAKE_SECRET_$literal',
        );
        assert.strictEqual(
          config.services.ingress.volumes.find((v: { target: string }) => v.target === '/data')
            .source,
          join(f.proxy.dir, 'data'),
        );
      }),
  );

  it('creates the proxy layout, validates before starting, and preserves routes and data on rerun', () =>
    fixture((f) => {
      const result = f.run();
      assert.strictEqual(result.status, 0, String(result.stderr));

      const compose = YAML.parse(readFileSync(join(f.proxy.dir, 'compose.yml'), 'utf8'));
      const service = compose.services.ingress;
      assert.deepStrictEqual(service.ports, [
        '0.0.0.0:80:80',
        '0.0.0.0:443:443',
        '0.0.0.0:443:443/udp',
      ]);
      assert.deepStrictEqual(service.volumes, [
        './Caddyfile:/etc/caddy/Caddyfile:ro',
        './sites:/etc/caddy/sites:ro',
        './data:/data',
        './config:/config',
      ]);
      assert.strictEqual(service.restart, 'unless-stopped');
      assert.strictEqual(service.read_only, true);
      assert.deepStrictEqual(service.security_opt, ['no-new-privileges:true']);
      assert.deepStrictEqual(service.entrypoint, ['caddy']);
      assert.deepStrictEqual(service.command, [
        'run',
        '--config',
        '/etc/caddy/Caddyfile',
        '--adapter',
        'caddyfile',
      ]);
      assert.deepStrictEqual(service.logging, {
        driver: 'json-file',
        options: { 'max-size': '10m', 'max-file': '3' },
      });
      assert.strictEqual(service.stop_grace_period, '40s');
      assert.deepStrictEqual(service.healthcheck.test, [
        'CMD',
        'wget',
        '-q',
        '-T',
        '3',
        '-O',
        '/dev/null',
        'http://127.0.0.1:2019/config/',
      ]);
      assert.strictEqual(service.env_file[0].format, 'raw');
      assert.deepStrictEqual(service.networks.edge.aliases, ['notes.example.com']);
      assert.deepStrictEqual(compose.networks.edge, { external: true, name: 'fixture_edge' });

      const caddy = readFileSync(join(f.proxy.dir, 'Caddyfile'), 'utf8');

      for (const directive of [
        'admin localhost:2019',
        'metrics',
        'grace_period 30s',
        'acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
        '(request_log)',
        'roll_size 100mb',
        'roll_keep 10',
        'roll_keep_for 720h',
        'format json',
        'import /etc/caddy/sites/*.caddy',
      ]) {
        assert.include(caddy, directive);
      }

      const calls = f.calls();
      assert.isBelow(
        calls.findIndex((a) => a[0] === 'run'),
        calls.findIndex((a) => a.includes('up')),
      );
      assert.include(
        calls.find((a) => a.includes('up'))!,
        '--wait',
      );
      assert.strictEqual(statSync(join(f.proxy.dir, 'data')).mode & 0o777, 0o700);

      writeFileSync(
        join(f.proxy.dir, 'sites', 'app.caddy'),
        'app.example.com {\nrespond "ok"\n}\n',
      );
      writeFileSync(join(f.proxy.dir, 'data', 'certificate'), 'persistent');

      const before = statSync(join(f.proxy.dir, 'Caddyfile')).mtimeMs;

      assert.strictEqual(f.run().status, 0);
      assert.strictEqual(statSync(join(f.proxy.dir, 'Caddyfile')).mtimeMs, before);
      assert.strictEqual(
        readFileSync(join(f.proxy.dir, 'data', 'certificate'), 'utf8'),
        'persistent',
      );
      assert.include(readFileSync(join(f.proxy.dir, 'sites', 'app.caddy'), 'utf8'), 'respond');
      assert.strictEqual(
        f.calls().filter((a) => a[0] === 'network' && a[1] === 'create').length,
        1,
      );
      assert.isFalse(readdirSync(f.proxy.dir).some((s) => s.startsWith('.compoza')));
      assert.notInclude(
        JSON.stringify(f.calls()) + result.stdout + result.stderr,
        'FAKE_SECRET_$literal',
      );
    }));

  it('keeps the Docker stop budget above the rendered Caddy drain period', () =>
    fixture((f) => {
      const selected = { ...f.proxy, provision: { ...f.proxy.provision!, gracePeriodSeconds: 90 } };
      const input = JSON.parse(provisionOperation(selected).input!);
      assert.include(input.caddyfile, 'grace_period 90s');
      assert.strictEqual(YAML.parse(input.compose).services.ingress.stop_grace_period, '100s');

      for (const seconds of [0, -1, 1.5, 3601]) {
        assert.throws(() =>
          Schema.decodeUnknownSync(HostConfig)({
            ssh: 'user@host',
            platform: 'linux/arm64',
            transport: { mode: 'ssh-load' },
            ingress: {
              caddy: {
                ...selected,
                provision: { ...selected.provision, gracePeriodSeconds: seconds },
              },
            },
          }),
        );
      }
    }));

  it('accepts omitted or IPv6 DNS assertions and rejects invalid addresses', () =>
    fixture((f) => {
      const decode = (extra: Record<string, unknown>) =>
        Schema.decodeUnknownSync(HostConfig)({
          ssh: 'user@host',
          platform: 'linux/arm64',
          transport: { mode: 'ssh-load' },
          ingress: { caddy: { ...f.proxy, ...extra } },
        });
      assert.doesNotThrow(() => decode({}));
      assert.doesNotThrow(() => decode({ address: '2001:db8::1' }));
      assert.throws(() => decode({ address: '999.999.999.999' }));
      assert.throws(() => decode({ address: 'fe80::1%en0' }));
    }));

  it('preserves existing custom configuration without invoking Docker', () =>
    fixture((f) => {
      mkdirSync(f.proxy.dir);
      writeFileSync(join(f.proxy.dir, 'Caddyfile'), 'existing routes');

      const result = f.run();
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'Existing Caddyfile differs');
      assert.strictEqual(readFileSync(join(f.proxy.dir, 'Caddyfile'), 'utf8'), 'existing routes');
      assert.deepStrictEqual(f.calls(), []);
      assert.isFalse(existsSync(join(f.proxy.dir, 'compose.yml')));
    }));

  it.each(['fail-compose', 'fail-validate'])(
    'leaves no generated config or leaked diagnostics after %s',
    (flag) =>
      fixture((f) => {
        writeFileSync(join(f.dir, flag), 'yes');

        const result = f.run();
        assert.notStrictEqual(result.status, 0);
        assert.notInclude(String(result.stdout) + String(result.stderr), 'FAKE_SECRET_$literal');
        assert.isFalse(existsSync(join(f.proxy.dir, 'Caddyfile')));
        assert.isFalse(existsSync(join(f.proxy.dir, 'compose.yml')));
        assert.isFalse(
          f.calls().some((a) => a.includes('up') || (a[0] === 'network' && a[1] === 'create')),
        );
        assert.isFalse(readdirSync(f.proxy.dir).some((s) => s.startsWith('.compoza')));
      }),
  );

  it('retains generated files on startup failure and supports a safe retry', () =>
    fixture((f) => {
      writeFileSync(join(f.dir, 'fail-start'), 'yes');

      const result = f.run();
      assert.notStrictEqual(result.status, 0);
      assert.notInclude(String(result.stdout) + String(result.stderr), 'FAKE_SECRET_$literal');
      assert.isTrue(existsSync(join(f.proxy.dir, 'Caddyfile')));

      rmSync(join(f.dir, 'fail-start'));

      assert.strictEqual(f.run().status, 0);
    }));

  it('refuses another stack’s container and missing credential files', () =>
    fixture((f) => {
      writeFileSync(
        join(f.dir, 'container.json'),
        JSON.stringify({
          project: 'caddy-ingress',
          service: 'ingress',
          directory: '/another-stack',
        }),
      );

      const conflict = f.run();
      assert.notStrictEqual(conflict.status, 0);
      assert.include(String(conflict.stderr), 'another stack');
      assert.isFalse(f.calls().some((a) => a[0] === 'run' || a.includes('up')));

      rmSync(join(f.dir, 'credentials.env'));

      assert.include(String(f.run().stderr), 'envFile must already exist');
    }));

  it('refuses concurrent provisioning and symlinked generated files', () =>
    fixture((f) => {
      mkdirSync(f.proxy.dir);
      mkdirSync(join(f.proxy.dir, '.compoza-caddy.lock'));

      assert.include(String(f.run().stderr), 'already locked');

      rmSync(join(f.proxy.dir, '.compoza-caddy.lock'), { recursive: true });
      symlinkSync(join(f.dir, 'credentials.env'), join(f.proxy.dir, 'Caddyfile'));

      assert.include(String(f.run().stderr), 'symlinked');
      assert.include(readFileSync(join(f.dir, 'credentials.env'), 'utf8'), 'FAKE_SECRET_$literal');
      assert.deepStrictEqual(f.calls(), []);
    }));

  it('supports ordinary Caddy without a DNS env file or logging snippet', () =>
    fixture((f) => {
      const { logSnippet: _logSnippet, ...base } = f.proxy;
      const bare = { ...base, provision: { image: 'caddy:2' } };
      assert.strictEqual(f.run(bare).status, 0);

      const compose = YAML.parse(readFileSync(join(f.proxy.dir, 'compose.yml'), 'utf8'));
      assert.isUndefined(compose.services.ingress.env_file);
      assert.notInclude(readFileSync(join(f.proxy.dir, 'Caddyfile'), 'utf8'), 'acme_dns');
      assert.isFalse(
        f
          .calls()
          .find((a) => a[0] === 'run')!
          .includes('--env-file'),
      );
    }));

  it('selects provisioning only when configured and rejects malformed settings', () =>
    fixture((f) => {
      const host = {
        ssh: 'fixture',
        platform: 'linux/arm64',
        transport: { mode: 'ssh-load' },
        ingress: { caddy: { address: '192.0.2.1', ...f.proxy } },
      } as const;
      const decoded = Schema.decodeUnknownSync(HostConfig, { onExcessProperty: 'error' })(host);
      assert.isDefined(caddyIngress.setup(decoded).input);

      const { provision: _provision, ...existing } = f.proxy;
      const { ingress: _ingress, ...baseHost } = decoded;
      assert.isUndefined(caddyIngress.setup({ ...baseHost, proxy: existing }).input);

      for (const provision of [
        {},
        { image: '-bad' },
        { image: 'caddy:2', envFile: '.env' },
        { image: 'caddy:2', typo: true },
      ]) {
        assert.throws(() =>
          Schema.decodeUnknownSync(HostConfig, { onExcessProperty: 'error' })({
            ...host,
            ingress: { caddy: { ...host.ingress.caddy, provision } },
          }),
        );
      }

      assert.throws(() => provisionOperation({ ...f.proxy, composeFile: '../compose.yaml' }));
    }));

  it('previews through the CLI without opening an SSH connection', () =>
    fixture((f) => {
      const hosts = join(f.dir, 'hosts.yaml');
      writeFileSync(
        hosts,
        YAML.stringify({
          fixture: {
            ssh: 'never-contact.invalid',
            platform: 'linux/arm64',
            transport: { mode: 'ssh-load' },
            proxy: f.proxy,
          },
        }),
      );
      writeFileSync(join(f.dir, 'bin', 'ssh'), '#!/bin/sh\necho unexpected-ssh >&2\nexit 90\n', {
        mode: 0o700,
      });

      const result = spawnSync(
        process.execPath,
        [resolve('bin/compoza.ts'), '--hosts', hosts, 'setup-proxy', 'fixture', '--dry-run'],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${join(f.dir, 'bin')}:${process.env.PATH}` },
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, 'provision Caddy');
      assert.include(result.stdout, 'roll_keep_for 720h');
      assert.notInclude(result.stderr, 'unexpected-ssh');
      assert.isFalse(existsSync(f.proxy.dir));
      assert.deepStrictEqual(f.calls(), []);
    }));
});

import { assert, describe, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vite-plus/test';

import type { BundleFile } from './bundle.ts';
import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { REMOTE_PATH, shellQuote } from './command.ts';
import { cloudflareIngress } from './extensions/cloudflare-tunnel/index.ts';
import { deployedScript, deploymentScript, generatedEnvironment, sshReadinessScript } from './ssh-plan.ts';

const host: HostConfig = { ssh: 'fixture', platform: 'linux/arm64', transport: { mode: 'ssh-load' } };

const source: BundleFile = {
  path: 'compose.yaml',
  encoded: Buffer.from('services: {web: {image: "${WEB_IMAGE}"}}').toString('base64'),
};

/**
 * Exercises actual Bash/jq transactions against a disposable fake Docker daemon.
 */
function fixture(
  use: (f: {
    app: App;
    dir: string;
    root: string;
    run: (script: string, input?: string) => ReturnType<typeof spawnSync>;
    deploy: (
      tag?: string,
      secrets?: Readonly<Record<string, string>>,
      bundle?: ReadonlyArray<BundleFile>,
    ) => ReturnType<typeof spawnSync>;
  }) => void,
): void {
  using temporary = mkdtempDisposableSync(join(realpathSync(tmpdir()), 'dd-flat-'));
  const dir = temporary.path;
  const root = join(dir, "stack'$(literal)");
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'model.json'), JSON.stringify({ services: { web: { image: 'fixture' } } }));
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> ${shellQuote(join(dir, 'calls'))}
printf 'CALLER_SECRET=%s\\n' "\${CALLER_SECRET-}" > ${shellQuote(join(dir, 'environment'))}
case " $* " in
  *' up --help '*) echo --wait-timeout;;
  *' config --help '*) echo --no-env-resolution --no-path-resolution --no-interpolate;;
  *' config --no-interpolate '*) while [ "$1" != --file ]; do shift; done; cat "$2";;
  *' config --quiet '*) if [ -f ${shellQuote(join(dir, 'invalid'))} ]; then echo PRIVATE_DIAGNOSTIC >&2; exit 1; fi;;
  *' config --format json '*) cat ${shellQuote(join(dir, 'model.json'))};;
  *' up '*) if [ -f ${shellQuote(join(dir, 'up-fail'))} ]; then echo PRIVATE_DIAGNOSTIC >&2; exit 1; fi;;
  *' ps '*) cat ${shellQuote(join(dir, 'status.json'))};;
  *' stop '*) echo PRIVATE_DIAGNOSTIC;;
esac
`,
    { mode: 0o700 },
  );

  const app: App = {
    dir,
    config: {
      name: 'fixture',
      host: 'host',
      targets: ['web'],
      composeFiles: ['compose.yaml'],
      execution: 'ssh',
      remote: { stackDir: root },
      secrets: { none: {} },
    },
  };

  const path = `export PATH=${shellQuote(bin)}:/usr/bin:/bin`;
  const run = (script: string, input?: string) =>
    spawnSync('/bin/bash', ['-c', script.replaceAll(REMOTE_PATH, path)], {
      input,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, CALLER_SECRET: 'never-inherit' },
    });
  const deploy = (
    tag = 'one',
    secrets?: Readonly<Record<string, string>>,
    bundle = [source] as ReadonlyArray<BundleFile>,
  ) => {
    const plan = deploymentScript(app, host, tag, bundle, secrets);
    return run(plan.script, plan.input);
  };

  use({ app, dir, root, run, deploy });
}

/**
 * Asserts success while exposing only the synthetic fixture's diagnostic output on failure.
 */
function succeeded(result: ReturnType<typeof spawnSync>): void {
  assert.strictEqual(result.status, 0, String(result.stderr));
}

describe('flat SSH stack transactions', { timeout: 15_000 }, () => {
  it('keeps only Compose, private dotenv, assets and one metadata file, replacing image tags without history', () =>
    fixture(({ app, dir, root, deploy, run }) => {
      const asset = { path: 'settings.txt', encoded: Buffer.from([0, 1, 255]).toString('base64') };
      succeeded(deploy('one', { TOKEN: 'private-token', EMPTY: '' }, [source, asset]));

      assert.deepStrictEqual(readdirSync(root).sort(), ['.compoza.json', '.env', 'compose.yaml', 'settings.txt']);
      assert.deepStrictEqual(readFileSync(join(root, 'settings.txt')), Buffer.from([0, 1, 255]));
      assert.strictEqual(statSync(join(root, '.env')).mode & 0o777, 0o600);
      assert.strictEqual(statSync(join(root, '.compoza.json')).mode & 0o777, 0o600);
      assert.include(readFileSync(join(root, '.env'), 'utf8'), 'fixture-web:one');
      assert.notInclude(readFileSync(join(root, 'compose.yaml'), 'utf8'), 'private-token');
      assert.notInclude(readFileSync(join(root, '.compoza.json'), 'utf8'), 'private-token');
      assert.include(readFileSync(join(dir, 'environment'), 'utf8'), 'CALLER_SECRET=\n');

      succeeded(deploy('older', { TOKEN: 'rotated-token' }, [source, asset]));

      assert.include(readFileSync(join(root, '.env'), 'utf8'), 'fixture-web:older');
      assert.notInclude(readFileSync(join(root, '.env'), 'utf8'), 'private-token');

      succeeded(run(deployedScript(app, ['stop'], true)));

      assert.isFalse(existsSync(join(root, '.deploy-lock')));
    }));

  it('validates before replacing stack files and never prints secret-bearing diagnostics', () =>
    fixture(({ dir, root, deploy }) => {
      succeeded(deploy('good', { TOKEN: 'active-token' }));

      const before = readFileSync(join(root, '.env'), 'utf8');
      writeFileSync(join(dir, 'invalid'), 'yes');

      const result = deploy('bad', { TOKEN: 'candidate-token' });
      assert.notStrictEqual(result.status, 0);
      assert.notInclude(String(result.stdout) + String(result.stderr), 'PRIVATE_DIAGNOSTIC');
      assert.notInclude(String(result.stdout) + String(result.stderr), 'candidate-token');
      assert.strictEqual(readFileSync(join(root, '.env'), 'utf8'), before);
      assert.isFalse(existsSync(join(root, '.deploy-lock')));
      assert.isFalse(readFileSync(join(dir, 'calls'), 'utf8').includes('fixture-web:bad'));
    }));

  it('cleans interrupted staging and preserves existing stack files', () =>
    fixture(({ app, root, deploy, run }) => {
      succeeded(deploy());

      const before = readFileSync(join(root, '.env'), 'utf8');
      const plan = deploymentScript(app, host, 'bad', [source]);
      const result = run(plan.script, plan.input.split('\n')[0] + '\n');
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'Interrupted stack upload');
      assert.strictEqual(readFileSync(join(root, '.env'), 'utf8'), before);
      assert.isFalse(existsSync(join(root, '.deploy-lock')));
    }));

  it('preserves host env, overlay, data and old deployment directories', () =>
    fixture(({ app, root, deploy }) => {
      mkdirSync(root);

      const envFile = join(root, 'operator.env');
      const overlayFile = join(root, 'operator.yaml');
      Object.assign(app.config, { remote: { stackDir: root, envFile, overlayFile } });

      for (const name of ['operator.env', 'operator.yaml', 'data.txt']) {
        writeFileSync(join(root, name), 'operator-owned');
      }

      for (const name of ['releases', '.activations']) {
        mkdirSync(join(root, name));
      }

      symlinkSync('releases/old', join(root, 'current'));
      succeeded(deploy());

      for (const name of ['operator.env', 'operator.yaml', 'data.txt']) {
        assert.strictEqual(readFileSync(join(root, name), 'utf8'), 'operator-owned');
      }

      assert.isTrue(existsSync(join(root, 'releases')));
      assert.isTrue(existsSync(join(root, '.activations')));
    }));

  it('refuses unowned dotenv and symlinked outputs without changing their contents', () =>
    fixture(({ dir, root, deploy }) => {
      mkdirSync(root);
      writeFileSync(join(root, '.env'), 'TOKEN=operator');

      const result = deploy();
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'remote.envFile');
      assert.strictEqual(readFileSync(join(root, '.env'), 'utf8'), 'TOKEN=operator');

      rmSync(join(root, '.env'));
      writeFileSync(join(dir, 'outside'), 'untouched');
      symlinkSync(join(dir, 'outside'), join(root, 'compose.yaml'));

      assert.notStrictEqual(deploy().status, 0);
      assert.strictEqual(readFileSync(join(dir, 'outside'), 'utf8'), 'untouched');
    }));

  it('serializes mutations and leaves an operator-held lock alone', () =>
    fixture(({ root, deploy }) => {
      mkdirSync(join(root, '.deploy-lock'), { recursive: true });
      writeFileSync(join(root, '.deploy-lock/owner'), 'operator');

      const result = deploy();
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'Stack is locked');
      assert.strictEqual(readFileSync(join(root, '.deploy-lock/owner'), 'utf8'), 'operator');
    }));

  it('uses deployed profiles and removal operation after local config edits, preserving files on delete', () =>
    fixture(({ app, dir, root, deploy, run }) => {
      Object.assign(app.config, { profiles: ['production'] });
      succeeded(deploy());

      const file = join(root, '.compoza.json');
      const metadata = JSON.parse(readFileSync(file, 'utf8'));
      metadata.unroute = `printf removed > ${shellQuote(join(dir, 'unrouted'))}`;
      writeFileSync(file, JSON.stringify(metadata));
      Object.assign(app.config, { composeFiles: ['not-deployed.yaml'], profiles: ['unshipped'] });
      succeeded(run(deployedScript(app, ['down', '--remove-orphans'], true)));

      assert.strictEqual(readFileSync(join(dir, 'unrouted'), 'utf8'), 'removed');

      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      assert.include(calls, '--profile production');
      assert.notInclude(calls, 'unshipped');
      assert.isTrue(existsSync(join(root, '.env')));
      assert.isTrue(existsSync(join(root, 'compose.yaml')));
    }));

  it('redacts managed status and suppresses mutating Compose output', () =>
    fixture(({ app, dir, root, deploy, run }) => {
      succeeded(deploy('good', { TOKEN: 'a.b' }));
      writeFileSync(
        join(dir, 'status.json'),
        JSON.stringify([
          { Service: 'a.b-worker', State: 'running', Health: 'healthy', ExitCode: 0, Command: 'private' },
        ]),
      );

      const result = run(deployedScript(app, ['ps', '--all'], false));
      succeeded(result);

      assert.deepStrictEqual(JSON.parse(String(result.stdout)), {
        service: '***-worker',
        state: 'running',
        health: 'healthy',
        exitCode: 0,
      });
      assert.notInclude(String(run(deployedScript(app, ['stop'], true)).stdout), 'PRIVATE_DIAGNOSTIC');
      assert.isFalse(existsSync(join(root, '.deploy-lock')));

      chmodSync(join(root, '.env'), 0o644);

      assert.notStrictEqual(run(deployedScript(app, ['ps', '--all'], false)).status, 0);
    }));

  it('blocks malformed metadata or live Compose configuration before lifecycle actions', () =>
    fixture(({ app, dir, root, deploy, run }) => {
      succeeded(deploy());
      writeFileSync(join(root, '.compoza.json'), '{}');

      const before = readFileSync(join(dir, 'calls'), 'utf8');

      assert.notStrictEqual(run(deployedScript(app, ['stop'], true)).status, 0);
      assert.strictEqual(readFileSync(join(dir, 'calls'), 'utf8'), before);

      rmSync(join(root, '.compoza.json'));
      rmSync(join(root, '.env'));
      rmSync(join(root, 'compose.yaml'));
      succeeded(deploy());
      writeFileSync(join(dir, 'invalid'), 'yes');

      for (const args of [['ps', '--all'], ['logs', '--follow'], ['stop'], ['down']]) {
        const result = run(deployedScript(app, args, args[0] === 'stop' || args[0] === 'down'));
        assert.notStrictEqual(result.status, 0);
        assert.notInclude(String(result.stdout) + String(result.stderr), 'PRIVATE_DIAGNOSTIC');
      }
    }));

  it('checks resolved model paths, declared read-only assets and optional host env files', () =>
    fixture(({ dir, root, deploy }) => {
      const asset = { path: 'settings.txt', encoded: Buffer.from('safe').toString('base64') };
      const model = (value: unknown) => writeFileSync(join(dir, 'model.json'), JSON.stringify(value));
      model({
        services: {
          web: {
            volumes: [{ type: 'bind', source: './settings.txt', target: '/settings', read_only: true }],
            env_file: [{ path: join(dir, 'optional.env'), required: false }],
          },
        },
      });
      succeeded(deploy('good', undefined, [source, asset]));

      for (const value of [
        { services: { web: { volumes: [{ type: 'bind', source: './settings.txt', target: '/settings' }] } } },
        {
          services: {
            web: { volumes: [{ type: 'bind', source: join(root, '.env'), target: '/secrets', read_only: true }] },
          },
        },
        { configs: { config: { file: 'undeclared.conf' } } },
        { secrets: { config: { file: './settings.txt' } } },
        { services: { web: { env_file: [{ path: join(dir, 'optional.env'), required: true }] } } },
        { services: [] },
      ]) {
        model(value);

        assert.notStrictEqual(deploy('bad', undefined, [source, asset]).status, 0, JSON.stringify(value));
      }

      for (const text of ['', 'not-json']) {
        writeFileSync(join(dir, 'model.json'), text);

        assert.notStrictEqual(deploy('bad').status, 0);
      }
    }));

  it('keeps stack cleanup independent of an ingress operation trap', () =>
    fixture(({ app, root, deploy }) => {
      Object.assign(app.config, {
        ingress: { 'cloudflare-tunnel': { domain: 'app.example.com', service: 'http://web:80' } },
      });

      const plan = vi.spyOn(cloudflareIngress, 'plan').mockReturnValue({
        description: 'fixture',
        route: { label: 'route', script: 'trap : EXIT\ntrue\n' },
        unroute: { label: 'unroute', script: 'true\n' },
      });

      try {
        succeeded(deploy());

        assert.isFalse(existsSync(join(root, '.deploy-lock')));
      } finally {
        plan.mockRestore();
      }
    }));

  it('reports partial Compose failures without retaining backups', () =>
    fixture(({ dir, root, deploy }) => {
      succeeded(deploy('good'));
      writeFileSync(join(dir, 'up-fail'), 'yes');

      const result = deploy('bad');
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'known image tag');
      assert.notInclude(String(result.stdout) + String(result.stderr), 'PRIVATE_DIAGNOSTIC');
      assert.include(readFileSync(join(root, '.env'), 'utf8'), 'fixture-web:bad');
      assert.deepStrictEqual(readdirSync(root).sort(), ['.compoza.json', '.env', 'compose.yaml']);
    }));

  it('checks readiness without creating stack paths', () =>
    fixture(({ app, root, run }) => {
      const result = run(sshReadinessScript(app, host));
      succeeded(result);

      assert.include(String(result.stdout), 'jq=yes');
      assert.isFalse(existsSync(root));
    }));

  it('keeps secrets out of script arguments even with inherited xtrace', () =>
    fixture(({ app, run }) => {
      const plan = deploymentScript(app, host, 'one', [source], { TOKEN: 'SENTINEL_PRIVATE' });
      assert.notInclude(plan.script, 'SENTINEL_PRIVATE');

      const result = run('set -x\n' + plan.script, plan.input);
      succeeded(result);

      assert.notInclude(String(result.stdout) + String(result.stderr), 'SENTINEL_PRIVATE');
      assert.notInclude(
        String(result.stdout) + String(result.stderr),
        Buffer.from('SENTINEL_PRIVATE').toString('base64'),
      );
    }));

  it('encodes literal configured values and rejects reserved image variables', () => {
    const environment = { DOLLAR: '$HOME ${OTHER}', QUOTE: 'a"b', BACK: 'ends\\', EMPTY: '' };
    const app: App = {
      dir: '/app',
      config: { name: 'app', host: 'host', targets: [], composeFiles: ['compose.yaml'], environment },
    };

    for (const [index, value] of Object.values(environment).entries()) {
      const encoded = generatedEnvironment(app).trim().split('\n')[index]!.split('=').slice(1).join('=');
      assert.strictEqual(JSON.parse(encoded).replaceAll('$$', '$'), value);
    }

    assert.throws(
      () =>
        generatedEnvironment({
          ...app,
          config: { ...app.config, targets: ['web'], environment: { WEB_IMAGE: 'bad' } },
        }),
      'reserved',
    );
  });
});

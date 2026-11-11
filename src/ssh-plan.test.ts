import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
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
import { readSecrets } from './config/secrets.ts';
import { OnePasswordReader } from './extensions/1password/index.ts';
import { cloudflareIngress } from './extensions/cloudflare-tunnel/index.ts';
import {
  deployedScript,
  deploymentScript,
  generatedEnvironment,
  sshReadinessScript,
  stackRoot,
} from './ssh-plan.ts';

/**
 * Each fixture runs real Bash, jq and a fake Docker CLI several times; the headroom keeps a loaded
 * machine from turning a slow but passing transaction into a timeout.
 */
const FIXTURE_TIMEOUT_MS = 15_000;

const host: HostConfig = {
  ssh: 'fixture',
  platform: 'linux/arm64',
  transport: { mode: 'ssh-load' },
};

const source: BundleFile = {
  path: 'compose.yaml',
  encoded: Buffer.from('services: {web: {image: nginx}}').toString('base64'),
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
  writeFileSync(
    join(dir, 'model.json'),
    JSON.stringify({ services: { web: { image: 'fixture' } } }),
  );
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
  *' config --services '*) printf 'web\\nworker\\n';;
  *' logs --follow '*) echo $$ > ${shellQuote(join(dir, 'follow.pid'))}; exec sleep 30;;
  *' logs '*) echo LOGS_PRINTED;;
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
      roles: { web: { build: { target: 'web' } } },
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
      timeout: FIXTURE_TIMEOUT_MS,
      env: { ...process.env, CALLER_SECRET: 'never-inherit' },
    });
  const deploy = (
    tag = 'one',
    secrets?: Readonly<Record<string, string>>,
    bundle = [source] as ReadonlyArray<BundleFile>,
  ) => {
    const plan = deploymentScript(app, host, { web: tag }, bundle, secrets);
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

describe('flat SSH stack transactions', { timeout: FIXTURE_TIMEOUT_MS }, () => {
  it.effect('writes only allowlisted provider secrets to the private stack dotenv', () =>
    Effect.gen(function* () {
      const values = yield* readSecrets({
        dir: '/nonexistent',
        config: {
          name: 'fixture',
          host: 'host',
          roles: { web: { build: { target: 'web' } } },
          composeFiles: ['compose.yaml'],
          secrets: { '1password': { environmentId: 'fictional', variables: ['TOKEN'] } },
        },
      });
      fixture(({ root, deploy }) => {
        succeeded(deploy('one', values));
        const environment = readFileSync(join(root, '.env'), 'utf8');
        assert.include(environment, 'TOKEN="included-secret"');
        assert.deepStrictEqual(
          environment
            .trim()
            .split('\n')
            .map((line) => line.slice(0, line.indexOf('=')))
            .sort((left, right) => left.localeCompare(right)),
          ['TOKEN'],
        );
        assert.notInclude(environment, 'excluded-secret');
        assert.strictEqual(statSync(join(root, '.env')).mode & 0o777, 0o600);
      });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OnePasswordReader, async () => [
        { name: 'TOKEN', value: 'included-secret', masked: true },
        { name: 'OTHER_TOKEN', value: 'excluded-secret', masked: true },
      ]),
    ),
  );

  it('keeps only Compose, private dotenv, assets and one metadata file, replacing image tags without history', () =>
    fixture(({ app, dir, root, deploy, run }) => {
      const asset = { path: 'settings.txt', encoded: Buffer.from([0, 1, 255]).toString('base64') };
      succeeded(deploy('one', { TOKEN: 'private-token', EMPTY: '' }, [source, asset]));

      assert.deepStrictEqual(readdirSync(root).sort(), [
        '.compoza.json',
        '.env',
        'compose.yaml',
        'settings.txt',
      ]);
      assert.deepStrictEqual(readFileSync(join(root, 'settings.txt')), Buffer.from([0, 1, 255]));
      assert.strictEqual(statSync(join(root, '.env')).mode & 0o777, 0o600);
      assert.strictEqual(statSync(join(root, '.compoza.json')).mode & 0o777, 0o600);
      assert.deepStrictEqual(JSON.parse(readFileSync(join(root, '.compoza.json'), 'utf8')).tags, {
        web: 'one',
      });
      assert.notInclude(readFileSync(join(root, 'compose.yaml'), 'utf8'), 'private-token');
      assert.notInclude(readFileSync(join(root, '.compoza.json'), 'utf8'), 'private-token');
      assert.include(readFileSync(join(dir, 'environment'), 'utf8'), 'CALLER_SECRET=\n');

      succeeded(deploy('older', { TOKEN: 'rotated-token' }, [source, asset]));

      assert.deepStrictEqual(JSON.parse(readFileSync(join(root, '.compoza.json'), 'utf8')).tags, {
        web: 'older',
      });
      assert.notInclude(readFileSync(join(root, '.env'), 'utf8'), 'private-token');

      succeeded(run(deployedScript(app, ['stop'], true)));

      assert.isFalse(existsSync(join(root, '.deploy-lock')));
    }));

  it('normalizes the generated roles override last and installs only the flat stack file', () =>
    fixture(({ app, dir, root, deploy }) => {
      Object.assign(app.config, {
        roles: {
          web: {
            build: { target: 'web' },
            environment: { MODE: 'a$b' },
            secrets: ['TOKEN'],
          },
        },
      });
      succeeded(deploy('one', { TOKEN: 'private-token' }));

      const normalize = readFileSync(join(dir, 'calls'), 'utf8')
        .split('\n')
        .find((call) => call.includes('--no-interpolate'));
      const files = [...(normalize ?? '').matchAll(/--file (\S+)/g)].map((match) => match[1]);
      assert.lengthOf(files, 2);
      assert.match(files[0]!, /\/upload\/compose\.yaml$/);
      assert.match(files[1]!, /\/upload\/compoza\.roles\.yaml$/);
      assert.deepStrictEqual(readdirSync(root).sort(), ['.compoza.json', '.env', 'compose.yaml']);
      assert.isFalse(
        JSON.parse(readFileSync(join(root, '.compoza.json'), 'utf8')).files.includes(
          'compoza.roles.yaml',
        ),
      );
      assert.notInclude(readFileSync(join(root, 'compose.yaml'), 'utf8'), 'private-token');
      assert.include(readFileSync(join(root, '.env'), 'utf8'), 'TOKEN="private-token"');
    }));

  it('rejects a Compose file or asset that uses the reserved override name', () =>
    fixture(({ app }) => {
      Object.assign(app.config, { roles: { web: { build: {} } } });
      assert.throws(
        () =>
          deploymentScript(app, host, { web: 'one' }, [
            source,
            { ...source, path: 'compoza.roles.yaml' },
          ]),
        'compoza.roles.yaml is reserved for the generated roles override',
      );
    }));

  it('sends no override without roles', () =>
    fixture(({ app, dir, run }) => {
      const { roles: _roles, ...config } = app.config;
      const plan = deploymentScript({ ...app, config }, host, {}, [source]);
      succeeded(run(plan.script, plan.input));

      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      assert.notInclude(calls, 'compoza.roles.yaml');
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

  it('retains asset ownership across removal and reintroduction without expanding the active allowlist', () =>
    fixture(({ dir, root, deploy }) => {
      const asset = { path: 'settings.txt', encoded: Buffer.from('original').toString('base64') };
      succeeded(deploy('one', undefined, [source, asset]));

      const metadataFile = join(root, '.compoza.json');
      succeeded(deploy('two'));

      const retained = readFileSync(metadataFile, 'utf8');
      assert.deepStrictEqual(JSON.parse(retained).files, ['compose.yaml']);
      assert.deepStrictEqual(JSON.parse(retained).ownedFiles, ['compose.yaml', 'settings.txt']);
      assert.strictEqual(readFileSync(join(root, 'settings.txt'), 'utf8'), 'original');

      writeFileSync(
        join(dir, 'model.json'),
        JSON.stringify({
          services: {
            web: { volumes: [{ type: 'bind', source: './settings.txt', read_only: true }] },
          },
        }),
      );
      assert.notStrictEqual(deploy('invalid').status, 0);
      assert.strictEqual(readFileSync(metadataFile, 'utf8'), retained);

      writeFileSync(
        join(dir, 'model.json'),
        JSON.stringify({ services: { web: { image: 'fixture' } } }),
      );
      writeFileSync(join(root, 'operator.txt'), 'operator');
      assert.notStrictEqual(
        deploy('invalid', undefined, [
          source,
          { path: 'operator.txt', encoded: Buffer.from('replace').toString('base64') },
        ]).status,
        0,
      );
      assert.strictEqual(readFileSync(join(root, 'operator.txt'), 'utf8'), 'operator');
      assert.strictEqual(readFileSync(metadataFile, 'utf8'), retained);

      succeeded(
        deploy('three', undefined, [
          source,
          { ...asset, encoded: Buffer.from('updated').toString('base64') },
        ]),
      );
      assert.strictEqual(readFileSync(join(root, 'settings.txt'), 'utf8'), 'updated');
      assert.deepStrictEqual(JSON.parse(readFileSync(metadataFile, 'utf8')).files, [
        'compose.yaml',
        'settings.txt',
      ]);
    }));

  it('rejects malformed retained ownership before replacing deployed files', () =>
    fixture(({ root, deploy }) => {
      succeeded(deploy());
      const metadataFile = join(root, '.compoza.json');
      const original = JSON.parse(readFileSync(metadataFile, 'utf8'));
      const environment = readFileSync(join(root, '.env'), 'utf8');

      for (const ownedFiles of [
        undefined,
        null,
        {},
        [],
        ['../outside'],
        ['/outside'],
        ['.env'],
        ['a//b'],
        [42],
      ]) {
        const malformed = JSON.stringify({ ...original, ownedFiles });
        writeFileSync(metadataFile, malformed);
        const result = deploy('replacement');
        assert.notStrictEqual(result.status, 0, JSON.stringify(ownedFiles));
        assert.include(String(result.stderr), 'Invalid deployed lifecycle metadata');
        assert.strictEqual(readFileSync(metadataFile, 'utf8'), malformed);
        assert.strictEqual(readFileSync(join(root, '.env'), 'utf8'), environment);
      }
    }));

  it('cleans interrupted staging and preserves existing stack files', () =>
    fixture(({ app, root, deploy, run }) => {
      succeeded(deploy());

      const before = readFileSync(join(root, '.env'), 'utf8');
      const plan = deploymentScript(app, host, { web: 'bad' }, [source]);
      const result = run(plan.script, plan.input.split('\n')[0] + '\n');
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'Interrupted stack upload');
      assert.strictEqual(readFileSync(join(root, '.env'), 'utf8'), before);
      assert.isFalse(existsSync(join(root, '.deploy-lock')));
    }));

  it('preserves host env, overlay, data and old deployment directories', () =>
    fixture(({ app, root, deploy }) => {
      mkdirSync(root);

      const overlayFile = join(root, 'operator.yaml');
      Object.assign(app.config, { remote: { stackDir: root, overlayFile } });

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
      assert.include(String(result.stderr), 'absolute env_file path');
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
          {
            Service: 'a.b-worker',
            State: 'running',
            Health: 'healthy',
            ExitCode: 0,
            Command: 'private',
          },
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
      assert.notInclude(
        String(run(deployedScript(app, ['stop'], true)).stdout),
        'PRIVATE_DIAGNOSTIC',
      );
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

  it('names the deployed services when a requested one is missing, even with managed secrets', () =>
    fixture(({ app, dir, root, deploy, run }) => {
      succeeded(deploy('one', { TOKEN: 'private-token' }));
      assert.isTrue(JSON.parse(readFileSync(join(root, '.compoza.json'), 'utf8')).managed);

      const missing = run(
        deployedScript(app, ['logs', '--tail', '5', 'wbe'], false, { service: 'wbe' }),
      );
      assert.notStrictEqual(missing.status, 0);
      assert.include(
        String(missing.stderr),
        'No service "wbe" in the deployed stack; services: web, worker',
      );
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      assert.notInclude(calls, ' logs ');

      // Services of profiles the deployment does not select still have logs to read.
      assert.match(calls, /--profile \* --env-file \S+ config --services/);

      const found = run(
        deployedScript(app, ['logs', '--tail', '5', 'web'], false, { service: 'web' }),
      );
      succeeded(found);
      assert.include(String(found.stdout), 'LOGS_PRINTED');
    }));

  it('ends a followed command with status 0 on Ctrl-C only when it is interruptible', () =>
    fixture(({ app, dir, deploy, run }) => {
      succeeded(deploy());
      const pidFile = join(dir, 'follow.pid');

      // Ctrl-C reaches the terminal's whole foreground group: the host script and Compose.
      const interrupt = [
        `(while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.1; done`,
        `kill -INT "$$" "$(cat ${shellQuote(pidFile)})") &`,
      ].join('; ');
      const follow = (interruptible: boolean) => {
        rmSync(pidFile, { force: true });
        const script = deployedScript(app, ['logs', '--follow'], false, { interruptible });
        return run(`${interrupt}\n${script}`);
      };

      assert.strictEqual(follow(true).status, 0);
      assert.notStrictEqual(follow(false).status, 0);
    }));

  it('checks resolved model paths, declared read-only assets and optional host env files', () =>
    fixture(({ dir, root, deploy }) => {
      const asset = { path: 'settings.txt', encoded: Buffer.from('safe').toString('base64') };
      const model = (value: unknown) =>
        writeFileSync(join(dir, 'model.json'), JSON.stringify(value));
      model({
        services: {
          web: {
            volumes: [
              { type: 'bind', source: './settings.txt', target: '/settings', read_only: true },
            ],
            env_file: [{ path: join(dir, 'optional.env'), required: false }],
          },
        },
      });
      succeeded(deploy('good', undefined, [source, asset]));

      for (const value of [
        {
          services: {
            web: { volumes: [{ type: 'bind', source: './settings.txt', target: '/settings' }] },
          },
        },
        {
          services: {
            web: {
              volumes: [
                { type: 'bind', source: join(root, '.env'), target: '/secrets', read_only: true },
              ],
            },
          },
        },
        { configs: { config: { file: 'undeclared.conf' } } },
        { secrets: { config: { file: './settings.txt' } } },
        { services: { web: { env_file: [{ path: join(dir, 'optional.env'), required: true }] } } },
        { services: [] },
      ]) {
        model(value);

        assert.notStrictEqual(
          deploy('bad', undefined, [source, asset]).status,
          0,
          JSON.stringify(value),
        );
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
      assert.deepStrictEqual(JSON.parse(readFileSync(join(root, '.compoza.json'), 'utf8')).tags, {
        web: 'bad',
      });
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
      const plan = deploymentScript(app, host, { web: 'one' }, [source], {
        TOKEN: 'SENTINEL_PRIVATE',
      });
      assert.notInclude(plan.script, 'SENTINEL_PRIVATE');

      const result = run('set -x\n' + plan.script, plan.input);
      succeeded(result);

      assert.notInclude(String(result.stdout) + String(result.stderr), 'SENTINEL_PRIVATE');
      assert.notInclude(
        String(result.stdout) + String(result.stderr),
        Buffer.from('SENTINEL_PRIVATE').toString('base64'),
      );
    }));

  it('encodes literal configured values', () => {
    const environment = { DOLLAR: '$HOME ${OTHER}', QUOTE: 'a"b', BACK: 'ends\\', EMPTY: '' };
    const app: App = {
      dir: '/app',
      config: {
        name: 'app',
        host: 'host',
        composeFiles: ['compose.yaml'],
        environment,
      },
    };

    for (const [index, value] of Object.values(environment).entries()) {
      const encoded = generatedEnvironment(app)
        .trim()
        .split('\n')
        [index]!.split('=')
        .slice(1)
        .join('=');
      assert.strictEqual(JSON.parse(encoded).replaceAll('$$', '$'), value);
    }
  });

  it('names the first requirement a configured environment variable fails', () => {
    const withEnvironment = (environment: Record<string, string>): App => ({
      dir: '/app',
      config: {
        name: 'app',
        host: 'host',
        composeFiles: ['compose.yaml'],
        environment,
      },
    });
    const cases: ReadonlyArray<readonly [Record<string, string>, string]> = [
      [{ '1TOKEN': 'value' }, 'Environment variable name 1TOKEN is not portable; use a letter'],
      [{ 'BAD-NAME': 'value' }, 'Environment variable name BAD-NAME is not portable'],
      [{ PATH: '/bin' }, 'Environment variable PATH is reserved by Compose, Docker or the shell'],
      [{ COMPOSE_FILE: 'x.yaml' }, 'COMPOSE_FILE is reserved by Compose, Docker or the shell'],
      [{ DOCKER_HOST: 'tcp://x' }, 'DOCKER_HOST is reserved by Compose, Docker or the shell'],
      [
        { TOKEN: 'SENTINEL_VALUE\nsecond' },
        'Environment variable TOKEN has a multi-line value; it must',
      ],
      [{ TOKEN: 'SENTINEL_VALUE\0' }, 'without line breaks or NUL'],
      [
        { OK: 'a', 'BAD NAME': 'b', PATH: '/bin' },
        'Environment variable name BAD NAME is not portable',
      ],
    ];

    for (const [environment, message] of cases) {
      assert.throws(() => generatedEnvironment(withEnvironment(environment)), message);
    }

    try {
      generatedEnvironment(withEnvironment({ TOKEN: 'SENTINEL_VALUE\r' }));
      assert.fail('Expected a multi-line value to be rejected');
    } catch (error) {
      assert.notInclude((error as Error).message, 'SENTINEL_VALUE');
    }
  });

  it('accepts only absolute stack roots below the filesystem root', () => {
    const withStackDir = (stackDir: string): App => ({
      dir: '/app',
      config: {
        name: 'app',
        host: 'host',
        composeFiles: ['compose.yaml'],
        remote: { stackDir },
      },
    });
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['stacks/app', 'remote.stackDir must be an absolute path'],
      ['./app', 'remote.stackDir must be an absolute path'],
      ['/', 'remote.stackDir must not be the filesystem root'],
      ['/srv/../etc', 'remote.stackDir must not contain . or .. components'],
      ['/srv/./app', 'remote.stackDir must not contain . or .. components'],
      ['/srv/app\nx', 'remote.stackDir must not contain line breaks or NUL'],
      ['/srv/app\0', 'remote.stackDir must not contain line breaks or NUL'],
    ];

    assert.strictEqual(stackRoot(withStackDir('/srv/app/')), '/srv/app');
    for (const [stackDir, message] of cases) {
      assert.throws(() => stackRoot(withStackDir(stackDir)), message);
    }
  });

  it('requires remote.stackDir for SSH execution', () => {
    const app: App = {
      dir: '/app',
      config: { name: 'app', host: 'host', composeFiles: ['compose.yaml'] },
    };

    assert.throws(() => stackRoot(app), 'SSH execution requires remote.stackDir; set it');
  });
});

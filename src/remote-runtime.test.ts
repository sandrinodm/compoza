import { assert, describe, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempDisposableSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { REMOTE_PATH, shellQuote } from './command.ts';
import { deployedScript, deploymentScript } from './ssh-plan.ts';

const docker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
const composeAvailable = docker !== '' && spawnSync(docker, ['compose', 'version'], { stdio: 'ignore' }).status === 0;
const host: HostConfig = { ssh: 'fixture', platform: 'linux/arm64', transport: { mode: 'ssh-load' } };

/**
 * Runs real Compose parsing with a wrapper that never starts containers or contacts a daemon.
 */
function composeFixture(
  use: (f: {
    app: App;
    dir: string;
    root: string;
    run: (script: string, input?: string) => ReturnType<typeof spawnSync>;
  }) => void,
): void {
  using temporary = mkdtempDisposableSync(join(realpathSync(tmpdir()), 'dd-flat-compose-'));
  const dir = temporary.path;
  const root = join(dir, 'stack');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
set -eu
case " $* " in *' up '*|*' stop '*|*' down '*) printf '%s\\n' "$*" >> ${shellQuote(join(dir, 'calls'))}; exit 0;; esac
exec ${shellQuote(docker)} "$@"
`,
    { mode: 0o700 },
  );

  const app: App = {
    dir,
    config: {
      name: 'fixture',
      host: 'host',
      targets: ['web'],
      composeFiles: ['compose.yaml', 'production.yaml'],
      execution: 'ssh',
      remote: { stackDir: root },
      secrets: { none: {} },
    },
  };

  const path = `export PATH=${shellQuote(bin)}:$PATH`;
  const run = (script: string, input?: string) =>
    spawnSync('/bin/bash', ['-c', script.replaceAll(REMOTE_PATH, path)], {
      input,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, WEB_IMAGE: 'wrong-session-image', TOKEN: 'wrong-session-token' },
    });

  use({ app, dir, root, run });
}

describe.skipIf(!composeAvailable)('flat stack with the actual Compose parser', { timeout: 15_000 }, () => {
  it('normalizes absolute Compose sources in order without retaining workstation paths or build definitions', () =>
    composeFixture(({ app, root, run }) => {
      Object.assign(app.config, {
        composeFiles: ['/workstation/project/compose.yaml', '/workstation/project/production.yaml'],
      });
      const plan = deploymentScript(app, host, 'external', [
        {
          path: 'compose.yaml',
          encoded: Buffer.from('services: {web: {build: /workstation/project, environment: {MODE: base}}}').toString(
            'base64',
          ),
        },
        {
          path: 'production.yaml',
          encoded: Buffer.from(
            'services: {web: {build: !reset null, image: "${WEB_IMAGE:?required}", environment: {MODE: production}}}',
          ).toString('base64'),
        },
      ]);
      const result = run(plan.script, plan.input);
      assert.strictEqual(result.status, 0, String(result.stderr));
      const installed = readFileSync(join(root, 'compose.yaml'), 'utf8');
      assert.notInclude(installed, '/workstation');
      assert.notInclude(installed, 'build:');
      assert.include(YAML.parse(installed).services.web.environment, 'MODE=production');
      assert.include(installed, '${WEB_IMAGE:?required}');
      assert.deepStrictEqual(JSON.parse(readFileSync(join(root, '.compoza.json'), 'utf8')).files, ['compose.yaml']);
      assert.isFalse(existsSync(join(root, 'production.yaml')));
    }));

  it('recreates services after replacing assets even when Compose hashes and image tags stay unchanged', () =>
    composeFixture(({ app, dir, root, run }) => {
      Object.assign(app.config, { composeFiles: ['compose.yaml'] });
      const source = {
        path: 'compose.yaml',
        encoded: Buffer.from(
          'services: {web: {image: nginx:alpine, volumes: ["./settings.txt:/settings:ro"]}}',
        ).toString('base64'),
      };
      const deployAsset = (value: string) => {
        const plan = deploymentScript(app, host, 'same', [
          source,
          { path: 'settings.txt', encoded: Buffer.from(value).toString('base64') },
        ]);
        const result = run(plan.script, plan.input);
        assert.strictEqual(result.status, 0, String(result.stderr));
      };
      const hash = () => {
        const result = spawnSync(docker, ['compose', '--file', join(root, 'compose.yaml'), 'config', '--hash', 'web'], {
          encoding: 'utf8',
        });
        assert.strictEqual(result.status, 0, result.stderr);
        return result.stdout;
      };
      deployAsset('old');
      const beforeHash = hash();
      const beforeInode = statSync(join(root, 'settings.txt')).ino;
      const previous = openSync(join(root, 'settings.txt'), 'r');
      try {
        deployAsset('new');
        assert.strictEqual(hash(), beforeHash);
        assert.notStrictEqual(statSync(join(root, 'settings.txt')).ino, beforeInode);
        assert.strictEqual(readFileSync(previous, 'utf8'), 'old');
        assert.strictEqual(readFileSync(join(root, 'settings.txt'), 'utf8'), 'new');
        const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
        assert.strictEqual(calls.length, 2);
        for (const call of calls) {
          assert.include(call, 'up --detach --force-recreate');
        }
      } finally {
        closeSync(previous);
      }
    }));

  it('allows normalized.yaml as a Compose source and as an asset', () =>
    composeFixture(({ app, root, run }) => {
      Object.assign(app.config, { composeFiles: ['normalized.yaml'] });
      const source = Buffer.from('services: {web: {image: nginx:alpine}}').toString('base64');
      const first = deploymentScript(app, host, 'one', [{ path: 'normalized.yaml', encoded: source }]);
      const firstResult = run(first.script, first.input);
      assert.strictEqual(firstResult.status, 0, String(firstResult.stderr));
      assert.include(readFileSync(join(root, 'compose.yaml'), 'utf8'), 'nginx:alpine');

      Object.assign(app.config, { composeFiles: ['compose.yaml'] });
      const second = deploymentScript(app, host, 'two', [
        {
          path: 'compose.yaml',
          encoded: Buffer.from(
            'services: {web: {image: nginx:alpine, volumes: ["./normalized.yaml:/settings:ro"]}}',
          ).toString('base64'),
        },
        { path: 'normalized.yaml', encoded: Buffer.from('asset content').toString('base64') },
      ]);
      const secondResult = run(second.script, second.input);
      assert.strictEqual(secondResult.status, 0, String(secondResult.stderr));
      assert.strictEqual(readFileSync(join(root, 'normalized.yaml'), 'utf8'), 'asset content');
      assert.isFalse(existsSync(join(root, '.deploy-lock')));
    }));

  it('merges selected files, preserves interpolation and raw env files, and resolves assets from the flat stack', () =>
    composeFixture(({ app, dir, root, run }) => {
      const external = join(dir, 'service.env');
      writeFileSync(external, 'RAW=$LITERAL "quoted"\n');

      const compose = `services:
  web:
    image: \${WEB_IMAGE:?required image}
    environment:
      TOKEN: \${TOKEN:?required token}
      LITERAL: $$literal
    env_file:
      - path: ${external}
        format: raw
    volumes:
      - ./settings.txt:/etc/settings:ro
`;

      const production = 'services:\n  web:\n    environment:\n      MODE: production\n';
      const bundle = [
        { path: 'compose.yaml', encoded: Buffer.from(compose).toString('base64') },
        { path: 'production.yaml', encoded: Buffer.from(production).toString('base64') },
        { path: 'settings.txt', encoded: Buffer.from('settings').toString('base64') },
      ];
      const plan = deploymentScript(app, host, 'known', bundle, { TOKEN: '$private "quoted" \\ trailing\\' });
      const result = run(plan.script, plan.input);
      assert.strictEqual(result.status, 0, String(result.stderr));

      const installed = readFileSync(join(root, 'compose.yaml'), 'utf8');
      assert.include(installed, '${WEB_IMAGE:?required image}');
      assert.include(installed, '${TOKEN:?required token}');
      assert.notInclude(installed, '$private');
      assert.notInclude(installed, '.deploy-lock');

      const model = YAML.parse(installed);
      assert.include(model.services.web.environment, 'MODE=production');
      assert.strictEqual(model.services.web.env_file[0].format, 'raw');
      assert.strictEqual(model.services.web.volumes[0].source, './settings.txt');

      const resolved = spawnSync(
        docker,
        [
          'compose',
          '--project-directory',
          root,
          '--env-file',
          join(root, '.env'),
          '--file',
          join(root, 'compose.yaml'),
          'config',
          '--format',
          'json',
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      );
      assert.strictEqual(resolved.status, 0, resolved.stderr);

      const service = JSON.parse(resolved.stdout).services.web;
      assert.strictEqual(service.image, 'fixture-web:known');
      assert.strictEqual(service.environment.TOKEN.replaceAll('$$', '$'), '$private "quoted" \\ trailing\\');
      assert.strictEqual(service.environment.RAW.replaceAll('$$', '$'), '$LITERAL "quoted"');
      assert.strictEqual(service.environment.LITERAL.replaceAll('$$', '$'), '$literal');
      assert.strictEqual(service.volumes[0].source, join(root, 'settings.txt'));
      assert.deepStrictEqual(readdirSync(root).sort(), ['.compoza.json', '.env', 'compose.yaml', 'settings.txt']);
    }));

  it('keeps live operator overlays separate and suppresses malformed dotenv diagnostics during inspection', () =>
    composeFixture(({ app, dir, root, run }) => {
      const envFile = join(dir, 'operator.env');
      const overlayFile = join(dir, 'operator.yaml');
      writeFileSync(envFile, 'TOKEN=operator\n');
      writeFileSync(overlayFile, 'services: {web: {environment: {MODE: live}}}');
      Object.assign(app.config, { composeFiles: ['compose.yaml'], remote: { stackDir: root, envFile, overlayFile } });

      const plan = deploymentScript(app, host, 'known', [
        {
          path: 'compose.yaml',
          encoded: Buffer.from('services: {web: {image: "${WEB_IMAGE}", environment: {TOKEN: "${TOKEN}"}}}').toString(
            'base64',
          ),
        },
      ]);
      const result = run(plan.script, plan.input);
      assert.strictEqual(result.status, 0, String(result.stderr));
      assert.notInclude(readFileSync(join(root, 'compose.yaml'), 'utf8'), 'MODE');

      writeFileSync(envFile, 'TOKEN="PRIVATE_UNTERMINATED\n');

      for (const args of [['ps', '--all'], ['logs', '--follow'], ['stop']]) {
        const inspection = run(deployedScript(app, args, args[0] === 'stop'));
        assert.notStrictEqual(inspection.status, 0);
        assert.notInclude(String(inspection.stdout) + String(inspection.stderr), 'PRIVATE_UNTERMINATED');
      }

      assert.isFalse(existsSync(join(root, '.deploy-lock')));
      assert.strictEqual(readFileSync(overlayFile, 'utf8'), 'services: {web: {environment: {MODE: live}}}');
    }));
});

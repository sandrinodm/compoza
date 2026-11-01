import { assert, describe, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
case " $* " in *' up '*|*' stop '*|*' down '*) exit 0;; esac
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

import { assert, describe, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { bundlePath } from './bundle.ts';
import { REMOTE_PATH, shellQuote } from './command.ts';
import { deployedScript, deploymentScript, rollbackScript, sshReadinessScript } from './ssh-plan.ts';

/**
 * Runs public host plans with Bash 3.2-compatible syntax, fake Docker, and failing Python executables.
 *
 * The isolated stack deliberately contains shell metacharacters, so every action exercises path quoting without
 * touching a Docker daemon, SSH host, provider or operator configuration.
 */
function isolatedHost(
  use: (fixture: {
    readonly app: App;
    readonly host: HostConfig;
    readonly dir: string;
    readonly root: string;
    readonly run: (script: string, input?: string) => ReturnType<typeof spawnSync>;
    readonly deploy: (id: string, secrets?: Readonly<Record<string, string>>) => ReturnType<typeof spawnSync>;
  }) => void,
): void {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dd-no-python-'));
  const root = join(dir, "stack'$(printf_oops)");
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'model.json'), JSON.stringify({ services: { web: { image: 'fixture' } } }));
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> ${shellQuote(join(dir, 'calls'))}
case " $* " in
  *' up --help '*) printf '%s\\n' --wait-timeout;;
  *' config --help '*) printf '%s\\n' --no-env-resolution --no-path-resolution;;
  *' config --format json '*) cat ${shellQuote(join(dir, 'model.json'))};;
  *' ps '*) cat ${shellQuote(join(dir, 'status.json'))};;
esac
`,
    { mode: 0o700 },
  );
  for (const name of ['python', 'python3']) {
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\nprintf '%s\\n' Python-was-invoked >> ${shellQuote(join(dir, 'python-invoked'))}\nexit 97\n`,
      { mode: 0o700 },
    );
  }
  const app: App = {
    dir,
    config: {
      name: 'fixture',
      host: 'fixture',
      targets: [],
      composeFiles: ['compose.yaml'],
      execution: 'ssh',
      remote: { stackDir: root },
      secrets: { provider: 'none' },
    },
  };
  const host: HostConfig = {
    ssh: 'fixture',
    address: '192.0.2.1',
    platform: 'linux/arm64',
    transport: { mode: 'ssh-load' },
  };
  const path = `export PATH=${shellQuote(bin)}:/usr/bin:/bin`;
  const run = (script: string, input?: string) =>
    spawnSync('/bin/bash', ['-c', script.replaceAll(REMOTE_PATH, path)], {
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
  const deploy = (id: string, secrets?: Readonly<Record<string, string>>) => {
    const planned = deploymentScript(
      app,
      host,
      id,
      id,
      [{ path: 'compose.yaml', encoded: Buffer.from('services: {}').toString('base64') }],
      secrets,
    );
    const input = planned.input
      .split('\n')
      .map((line) =>
        Buffer.from(Buffer.from(line, 'base64').toString('utf8').replaceAll(REMOTE_PATH, path)).toString('base64'),
      )
      .join('\n');
    return run(planned.script, input);
  };
  try {
    use({ app, host, dir, root, run, deploy });
    assert.isFalse(existsSync(join(dir, 'python-invoked')), 'Host actions must never execute Python');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Bash and jq host runtime', { timeout: 15_000 }, () => {
  it('deploys, replaces directory symlinks, rolls back and recovers with literal secrets and no Python', () =>
    isolatedHost(({ app, host, dir, root, run, deploy }) => {
      const readiness = run(sshReadinessScript(app, host));
      assert.strictEqual(readiness.status, 0, String(readiness.stderr));
      assert.include(String(readiness.stdout), 'jq=yes');
      assert.notInclude(String(readiness.stdout), 'python=');
      const secrets = { TAB: '\tliteral', TOKEN: 'a.b', LITERAL: '$cash \'single\' "double" \\backslash', EMPTY: '' };
      Object.assign(app.config, { secrets: { provider: '1password', environmentId: 'fictional' } });
      const first = deploy('one', secrets);
      assert.strictEqual(first.status, 0, String(first.stderr));
      const oldPointer = readlinkSync(join(root, 'current'));
      const snapshot = readFileSync(join(root, '.secrets/one.env'), 'utf8');
      assert.strictEqual(
        snapshot,
        'TAB="\tliteral"\nTOKEN="a.b"\nLITERAL="$$cash \'single\' \\"double\\" \\\\backslash"\nEMPTY=""\n',
      );
      assert.strictEqual(statSync(join(root, '.secrets/one.env')).mode & 0o777, 0o600);
      assert.notInclude(String(first.stdout) + String(first.stderr), secrets.LITERAL);
      const second = deploy('two', secrets);
      assert.strictEqual(second.status, 0, String(second.stderr));
      assert.notStrictEqual(readlinkSync(join(root, 'current')), oldPointer);
      assert.strictEqual(readlinkSync(join(root, 'current/previous')), '../../releases/one');
      assert.isFalse(readdirSync(join(root, oldPointer)).some((name) => name.startsWith('.current-')));
      writeFileSync(
        join(dir, 'status.json'),
        JSON.stringify([
          { Service: 'a.b-worker', State: 'running', Health: 'healthy', ExitCode: 0, Command: secrets.LITERAL },
          { Service: 'axb-worker', State: 'exited', Health: 'unexpected', ExitCode: 3, Image: 'secret-image' },
        ]),
      );
      const status = run(deployedScript(app, ['ps', '--all'], false));
      assert.strictEqual(status.status, 0, String(status.stderr));
      const rows = String(status.stdout)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepStrictEqual(rows, [
        { service: '***-worker', state: 'running', health: 'healthy', exitCode: 0 },
        { service: 'axb-worker', state: 'exited', health: 'unknown', exitCode: 3 },
      ]);
      assert.strictEqual(run(rollbackScript(app, 'one')).status, 0);
      assert.strictEqual(readlinkSync(join(root, 'current/release')), '../../releases/one');
      assert.include(readFileSync(join(root, 'current/secret-source.json'), 'utf8'), '/.secrets/two.env');
      const pointer = readlinkSync(join(root, 'current'));
      assert.strictEqual(run(rollbackScript(app, 'one')).status, 0);
      assert.strictEqual(readlinkSync(join(root, 'current')), pointer);
      const direct = run(`bash ${shellQuote(join(root, 'current/compose.sh'))} stop`);
      assert.strictEqual(direct.status, 0, String(direct.stderr));
      assert.include(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').at(-1), '/.secrets/two.env');
    }));

  it('rejects malformed activation secret policy before any Docker action and without inspection writes', () =>
    isolatedHost(({ app, dir, root, run, deploy }) => {
      assert.strictEqual(deploy('one').status, 0);
      const source = join(root, 'current/secret-source.json');
      const original = readFileSync(source, 'utf8');
      const before = readFileSync(join(dir, 'calls'), 'utf8');
      for (const metadata of [
        null,
        {},
        { required: false, managed: false },
        { path: null, required: true, managed: true },
        { path: null, required: true, managed: false },
        { path: null, required: 'false', managed: false },
        { path: [], required: false, managed: false },
      ]) {
        writeFileSync(source, JSON.stringify(metadata));
        const result = run(deployedScript(app, ['ps', '--all'], false));
        assert.notStrictEqual(result.status, 0, JSON.stringify(metadata));
        assert.strictEqual(readFileSync(join(dir, 'calls'), 'utf8'), before);
        assert.isFalse(existsSync(join(root, '.deploy-lock')));
      }
      writeFileSync(source, original);
    }));

  it('reserves every host runtime asset from user bundle paths', () => {
    for (const path of ['runtime.sh', 'model.jq', 'status.jq', 'compose.json']) {
      assert.throws(() => bundlePath(path), 'Unsafe bundle path');
    }
    assert.strictEqual(bundlePath('assets/runtime.sh'), 'assets/runtime.sh');
  });

  it('rejects unknown or malformed launch metadata before Docker through the CLI and direct recovery', () =>
    isolatedHost(({ app, dir, root, run, deploy }) => {
      assert.strictEqual(deploy('one').status, 0);
      const path = join(root, 'releases/one/compose.json');
      const metadata = JSON.parse(readFileSync(path, 'utf8'));
      const before = readFileSync(join(dir, 'calls'), 'utf8');
      for (const invalid of [
        { ...metadata, version: 999 },
        { ...metadata, arguments: {} },
        { ...metadata, images: [{ name: 'PATH', value: '/untrusted' }] },
      ]) {
        writeFileSync(path, JSON.stringify(invalid));
        for (const script of [
          deployedScript(app, ['stop'], true),
          `bash ${shellQuote(join(root, 'current/compose.sh'))} stop`,
        ]) {
          const result = run(script);
          assert.notStrictEqual(result.status, 0, JSON.stringify(invalid));
          assert.strictEqual(readFileSync(join(dir, 'calls'), 'utf8'), before);
        }
      }
    }));

  it('keeps the active pointer and skips Compose up when resolved model output is absent or malformed', () =>
    isolatedHost(({ dir, root, deploy }) => {
      assert.strictEqual(deploy('one').status, 0);
      const pointer = readlinkSync(join(root, 'current'));
      const before = readFileSync(join(dir, 'calls'), 'utf8')
        .split('\n')
        .filter((line) => line.includes(' up '));
      for (const [index, model] of ['', 'not-json', '{"services":[]}'].entries()) {
        writeFileSync(join(dir, 'model.json'), model);
        const result = deploy(`invalid-${index}`);
        assert.notStrictEqual(result.status, 0, model);
        assert.strictEqual(readlinkSync(join(root, 'current')), pointer);
        assert.deepStrictEqual(
          readFileSync(join(dir, 'calls'), 'utf8')
            .split('\n')
            .filter((line) => line.includes(' up ')),
          before,
        );
      }
    }));
});

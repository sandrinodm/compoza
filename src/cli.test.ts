import { assert, describe, it } from '@effect/vitest';
import { type Command } from 'effect/cli';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { cli } from './cli.ts';

/**
 * How long one CLI run may take: starting Node and loading the CLI under full-suite load can take
 * seconds, and printing help never contacts a host.
 */
const CLI_TIMEOUT_MS = 10_000;

/**
 * How long one test may take. A test starts the CLI up to three times, and each start may use the
 * whole `CLI_TIMEOUT_MS` under full-suite load, so Vitest's default of five seconds is too short.
 */
const CLI_TEST_TIMEOUT_MS = 3 * CLI_TIMEOUT_MS;

/**
 * The widest a description line may be, matching `helpText`.
 */
const HELP_WIDTH_COLUMNS = 80;

/**
 * Runs the CLI with `args` and colors off, returning its exit status and output. `env` adds to or
 * replaces variables of this process's environment.
 */
function runCli(args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) {
  const result = spawnSync(process.execPath, [resolve('bin/compoza.ts'), ...args], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Every command below the root, as the words that name it, with the command itself.
 */
function commandPaths(
  command: Command.Command.Any,
  prefix: ReadonlyArray<string> = [],
): Array<{ path: ReadonlyArray<string>; command: Command.Command.Any }> {
  return command.subcommands
    .flatMap(({ commands }) => commands)
    .flatMap((subcommand) => {
      const path = [...prefix, subcommand.name];
      return [{ path, command: subcommand }, ...commandPaths(subcommand, path)];
    });
}

/**
 * The lines of the `DESCRIPTION` section of formatted help.
 */
function descriptionLines(help: string): Array<string> {
  const lines = help.split('\n');
  const end = lines.indexOf('USAGE');
  return lines.slice(1, end).filter((line) => line !== '');
}

describe('compoza --help', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('lists every top-level command with a short description', () => {
    const { status, stdout } = runCli(['--help']);

    assert.strictEqual(status, 0);

    for (const { path, command } of commandPaths(cli).filter(({ path }) => path.length === 1)) {
      assert.isDefined(command.shortDescription, path.join(' '));
      assert.include(stdout, command.shortDescription ?? '', path.join(' '));
    }
  });

  it.each(commandPaths(cli))('explains $path in its own help', ({ path, command }) => {
    const { status, stdout, stderr } = runCli([...path, '--help']);
    const description = descriptionLines(stdout);

    assert.strictEqual(status, 0, stderr);
    assert.isDefined(command.shortDescription);
    assert.include(stdout, `USAGE\n  compoza ${path.join(' ')}`);
    assert.include(stdout, 'EXAMPLES');
    assert.isNotEmpty(description);

    for (const line of description) {
      assert.isAtMost(line.length, HELP_WIDTH_COLUMNS, line);
    }
  });

  it('hides the shared flags a command does not read', () => {
    const config = runCli(['config', 'set', '--help']).stdout;
    const hosts = runCli(['hosts', 'list', '--help']).stdout;
    const deploy = runCli(['deploy', '--help']).stdout;

    assert.notInclude(config, 'INHERITED FLAGS');
    assert.notInclude(hosts, '--destination');
    assert.include(hosts, '--hosts');
    assert.include(deploy, '--destination');
  });
});

describe('compoza help', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('prints the same help as --help', () => {
    for (const path of [[], ['deploy'], ['hosts', 'link']]) {
      const viaCommand = runCli(['help', ...path]);

      assert.strictEqual(viaCommand.status, 0, viaCommand.stderr);
      assert.strictEqual(viaCommand.stdout, runCli([...path, '--help']).stdout, path.join(' '));
    }
  });

  it('resolves an alias to its command', () => {
    assert.include(runCli(['help', 'down']).stdout, 'USAGE\n  compoza delete');
  });

  it('fails on an unknown command and suggests the closest one', () => {
    const { status, stdout, stderr } = runCli(['help', 'hosts', 'lnk']);

    assert.strictEqual(status, 1);
    assert.include(stdout + stderr, 'Unknown subcommand "lnk" for "compoza hosts"');
    assert.include(stdout + stderr, 'link');
  });
});

describe('compoza hosts list', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('reads only the selected hosts file, ignoring a broken settings file', () => {
    using home = mkdtempDisposableSync(join(tmpdir(), 'compoza-home-'));
    const settings = join(home.path, '.config', 'compoza');
    const hostsFile = join(home.path, 'hosts.yaml');
    mkdirSync(settings, { recursive: true });
    writeFileSync(join(settings, 'config.yaml'), 'hosts: [\n');
    writeFileSync(
      hostsFile,
      'juniper:\n  ssh: deploy@juniper.example.com\n  platform: linux/amd64\n' +
        '  transport:\n    mode: ssh-load\n',
    );

    const environment = { HOME: home.path };
    const viaFlag = runCli(['hosts', 'list', '--hosts', hostsFile], environment);
    const viaVariable = runCli(['hosts', 'list'], { ...environment, COMPOZA_HOSTS: hostsFile });

    for (const result of [viaFlag, viaVariable]) {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, `juniper  ${hostsFile}`);
      assert.notInclude(result.stdout + result.stderr, 'config.yaml');
    }
  });
});

describe('compoza logs --follow', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  /**
   * Waits until `condition` holds, checking every 50 ms, and fails after `CLI_TIMEOUT_MS`.
   */
  async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + CLI_TIMEOUT_MS;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${what}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Whether a process with this id is still running.
   */
  function isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('stops the followed ssh when the terminal closes (SIGHUP)', async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'compoza-follow-'));
    const dir = temporary.path;
    const bin = join(dir, 'bin');
    const pidFile = join(dir, 'ssh.pid');
    mkdirSync(bin);

    // A stand-in ssh that records its pid and waits like a followed command.
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 60\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    writeFileSync(
      join(dir, 'hosts.yaml'),
      'host:\n  ssh: deploy@host.example.com\n  platform: linux/amd64\n' +
        '  transport:\n    mode: ssh-load\n',
    );
    writeFileSync(
      join(dir, 'deploy.yaml'),
      'name: app\nhost: host\ntargets: []\nexecution: ssh\ncomposeFiles: [compose.yaml]\n' +
        'remote:\n  stackDir: /srv/app\n',
    );

    const child = spawn(process.execPath, [resolve('bin/compoza.ts'), 'logs', dir, '-f'], {
      env: {
        ...process.env,
        NO_COLOR: '1',
        COMPOZA_HOSTS: join(dir, 'hosts.yaml'),
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
      stdio: 'ignore',
    });
    const exited = new Promise<NodeJS.Signals | null>((done) =>
      child.once('exit', (_code, signal) => done(signal)),
    );
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'ssh');
    const ssh = Number(readFileSync(pidFile, 'utf8'));

    child.kill('SIGHUP');

    // compoza handles the hangup itself instead of dying from it, and stops ssh on the way out.
    assert.isNull(await exited);
    await until(() => !isRunning(ssh), 'ssh to stop');
    assert.isFalse(isRunning(ssh));
  });
});

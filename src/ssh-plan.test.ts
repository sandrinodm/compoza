import { assert, describe, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { REMOTE_PATH, shellQuote } from './command.ts';
import { deployedScript, deploymentScript, generatedEnvironment, rollbackScript } from './ssh-plan.ts';
import { readStateScript } from './ssh-state.ts';

const host: HostConfig = {
  ssh: 'fixture',
  address: '192.0.2.1',
  platform: 'linux/arm64',
  transport: { mode: 'remote-build' },
};

/**
 * Runs real generated Bash/jq scripts against an isolated fake Docker executable.
 */
function fixture(
  use: (
    app: App,
    deploy: (
      id: string,
      input?: string,
      transform?: (script: string) => string,
      secrets?: Readonly<Record<string, string>>,
    ) => ReturnType<typeof spawnSync>,
    root: string,
    run: (script: string) => ReturnType<typeof spawnSync>,
  ) => void,
): void {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dd-ssh-script-'));
  const root = join(dir, 'stack');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(root);
  writeFileSync(join(dir, 'model.json'), JSON.stringify({ services: { web: { image: 'fixture' } } }));
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> ${shellQuote(join(dir, 'calls'))}
printf 'WEB_IMAGE=%s\\nCALLER_SECRET=%s\\n' "\${WEB_IMAGE-}" "\${CALLER_SECRET-}" > ${shellQuote(join(dir, 'environment'))}
case " $* " in
  *' config --quiet '*) if [ -f ${shellQuote(join(dir, 'invalid'))} ]; then echo 'sentinel-secret-in-validation' >&2; exit 1; fi;;
  *' config --format json '*) cat ${shellQuote(join(dir, 'model.json'))};;
  *' ps '*) if [ -f ${shellQuote(join(dir, 'status.json'))} ]; then cat ${shellQuote(join(dir, 'status.json'))}; fi;;
  *' stop '*) if [ -f ${shellQuote(join(dir, 'noisy'))} ]; then cat ${shellQuote(join(dir, 'noisy'))}; cat ${shellQuote(join(dir, 'noisy'))} >&2; fi;;
  *' up '*) printf '%s' "\${WEB_IMAGE-}" > ${shellQuote(join(dir, 'running-image'))}; if [ -f ${shellQuote(join(dir, 'up-fail'))} ]; then exit 1; fi;;
esac
`,
  );
  const executable = spawnSync('chmod', ['+x', join(bin, 'docker')]);
  assert.strictEqual(executable.status, 0);
  const app: App = {
    dir,
    config: {
      name: 'fixture',
      host: 'fixture',
      targets: ['web'],
      composeFiles: ['compose.yaml'],
      execution: 'ssh',
      remote: { stackDir: root },
    },
  };
  const path = `export PATH=${shellQuote(bin)}:$PATH`;
  const run = (script: string, input?: string) =>
    spawnSync('bash', ['-c', script.replaceAll(REMOTE_PATH, path)], {
      input,
      encoding: 'utf8',
      timeout: SSH_TRANSACTION_TIMEOUT_MILLIS,
      env: { ...process.env, CALLER_SECRET: 'must-not-leak', WEB_IMAGE: 'wrong-shell-image' },
    });
  const deploy = (
    id: string,
    truncated?: string,
    transform?: (script: string) => string,
    secrets?: Readonly<Record<string, string>>,
  ) => {
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
    return run(transform?.(planned.script) ?? planned.script, truncated ?? input);
  };
  try {
    use(app, deploy, dir, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The fifteen-second deadline for each SSH transaction fixture, in milliseconds.
 *
 * These cases run multiple Bash/jq transactions or the real-Compose privacy workflow; process startup under load needs
 * more time than the five seconds retained by pure tests and single-purpose Compose parser checks.
 */
const SSH_TRANSACTION_TIMEOUT_MILLIS = 15_000;

describe('SSH release scripts', { timeout: SSH_TRANSACTION_TIMEOUT_MILLIS }, () => {
  it('binds protected snapshots to activation, preserves them on failure, and reuses current secrets across rollback', () =>
    fixture((app, deploy, dir, run) => {
      Object.assign(app.config, { secrets: { provider: '1password', environmentId: 'fictional' } });
      assert.strictEqual(deploy('one', undefined, undefined, { TOKEN: 'OLD_SENTINEL' }).status, 0);
      const first = JSON.parse(readFileSync(join(dir, 'stack/current/secret-source.json'), 'utf8'));
      assert.strictEqual(first.path, join(dir, 'stack/.secrets/one.env'));
      assert.strictEqual(statSync(first.path).mode & 0o777, 0o600);
      assert.strictEqual(statSync(join(dir, 'stack/.secrets')).mode & 0o777, 0o700);
      assert.strictEqual(deploy('two', undefined, undefined, { TOKEN: 'CURRENT_SENTINEL' }).status, 0);
      const current = readFileSync(join(dir, 'stack/current/secret-source.json'), 'utf8');
      writeFileSync(join(dir, 'invalid'), 'yes');
      const failed = deploy('failed', undefined, undefined, { TOKEN: 'FAILED_SENTINEL' });
      assert.notStrictEqual(failed.status, 0);
      assert.notInclude(String(failed.stdout) + String(failed.stderr), 'sentinel-secret-in-validation');
      assert.strictEqual(readFileSync(join(dir, 'stack/current/secret-source.json'), 'utf8'), current);
      assert.isFalse(readdirSync(join(dir, 'stack/releases/failed')).includes('validation.log'));
      rmSync(join(dir, 'invalid'));
      assert.strictEqual(run(rollbackScript(app, 'one')).status, 0);
      assert.strictEqual(readFileSync(join(dir, 'stack/current/secret-source.json'), 'utf8'), current);
      assert.include(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').at(-1), '/.secrets/two.env');
      assert.strictEqual(run(deployedScript(app, ['stop'], true)).status, 0);
      for (const id of ['one', 'two', 'failed']) {
        for (const file of readdirSync(join(dir, 'stack/releases', id))) {
          const contents = readFileSync(join(dir, 'stack/releases', id, file), 'utf8');
          assert.notInclude(contents, 'OLD_SENTINEL');
          assert.notInclude(contents, 'CURRENT_SENTINEL');
          assert.notInclude(contents, 'FAILED_SENTINEL');
        }
      }
    }));

  it('rejects existing snapshot symlinks, directories and FIFOs before reading upload bytes', () =>
    fixture((app, deploy, dir) => {
      Object.assign(app.config, { secrets: { provider: '1password', environmentId: 'fictional' } });
      assert.strictEqual(deploy('active', undefined, undefined, { TOKEN: 'CURRENT' }).status, 0);
      const current = readlinkSync(join(dir, 'stack/current'));
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      for (const kind of ['symlink', 'directory', 'fifo']) {
        const path = join(dir, 'stack/.secrets', `${kind}.env`);
        if (kind === 'symlink') {
          symlinkSync(join(dir, 'unowned'), path);
        } else if (kind === 'directory') {
          mkdirSync(path);
        } else {
          assert.strictEqual(spawnSync('mkfifo', [path]).status, 0);
        }
        const result = deploy(kind, undefined, undefined, { TOKEN: 'CANDIDATE' });
        assert.notStrictEqual(result.status, 0);
        assert.include(String(result.stderr), 'Secret snapshot staging failed');
        assert.strictEqual(readlinkSync(join(dir, 'stack/current')), current);
        assert.strictEqual(readFileSync(join(dir, 'calls'), 'utf8'), calls);
      }
    }));

  it('clears managed snapshots for explicit none and explicit legacy transitions without fallback', () =>
    fixture((app, deploy, dir, run) => {
      Object.assign(app.config, { secrets: { provider: '1password', environmentId: 'fictional' } });
      assert.strictEqual(deploy('managed', undefined, undefined, { TOKEN: 'SENTINEL' }).status, 0);
      Object.assign(app.config, { secrets: { provider: 'none' } });
      assert.strictEqual(deploy('none').status, 0);
      assert.isNull(JSON.parse(readFileSync(join(dir, 'stack/current/secret-source.json'), 'utf8')).path);
      assert.strictEqual(run(rollbackScript(app, 'managed')).status, 0);
      assert.notInclude(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').at(-1), '/.secrets/');
      Object.assign(app.config, {
        secrets: undefined,
        remote: { stackDir: join(dir, 'stack'), envFile: join(dir, 'legacy.env') },
      });
      writeFileSync(join(dir, 'legacy.env'), 'TOKEN=HOST_CURRENT');
      assert.strictEqual(deploy('legacy').status, 0);
      assert.strictEqual(
        JSON.parse(readFileSync(join(dir, 'stack/current/secret-source.json'), 'utf8')).path,
        join(dir, 'legacy.env'),
      );
      assert.strictEqual(run(rollbackScript(app, 'managed')).status, 0);
      assert.include(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').at(-1), 'legacy.env');
    }));

  it('rejects archived shell wrappers before rollback while a fresh deployment upgrades current state', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('legacy').status, 0);
      const wrapper = join(dir, 'stack/releases/legacy/compose.sh');
      const release = join(dir, 'stack/releases/legacy');
      const oldInner = `set -eu\nexport WEB_IMAGE='fixture-web:legacy'\nargs=()\nif [ -f '${join(dir, 'old.env')}' ]; then args+=(--env-file '${join(dir, 'old.env')}'); fi\nargs+=(--env-file '${release}/release.env')\nexec docker compose --project-name fixture --file '${release}/compose.yaml' "\${args[@]}" "$@"`;
      const old = `#!/usr/bin/env bash\nset -eu\nexport PATH=${shellQuote(join(dir, 'bin'))}:$PATH\nexec env -i HOME="$HOME" PATH="$PATH" bash -c ${shellQuote(oldInner)} -- "$@"\n`;
      writeFileSync(wrapper, old);
      Object.assign(app.config, { secrets: { provider: '1password', environmentId: 'fictional' } });
      assert.strictEqual(deploy('new', undefined, undefined, { TOKEN: 'CURRENT_SENTINEL' }).status, 0);
      const rollback = run(rollbackScript(app, 'legacy'));
      assert.notStrictEqual(rollback.status, 0);
      assert.include(String(rollback.stderr), 'redeploy');
      assert.strictEqual(readFileSync(wrapper, 'utf8'), old);
      const direct = run(`bash ${shellQuote(join(dir, 'stack/current/compose.sh'))} up --detach`);
      assert.strictEqual(direct.status, 0, String(direct.stderr));
      assert.include(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').at(-1), '/.secrets/new.env');
      assert.notInclude(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').at(-1), 'old.env');
    }));

  it('projects managed status fields and discards lifecycle diagnostics containing interpolated secrets', () =>
    fixture((app, deploy, dir, run) => {
      Object.assign(app.config, { secrets: { provider: '1password', environmentId: 'fictional' } });
      assert.strictEqual(
        deploy('managed', undefined, undefined, { TOKEN: 'STATUS_SENTINEL', TABBED: 'literal\tvalue' }).status,
        0,
      );
      writeFileSync(
        join(dir, 'status.json'),
        JSON.stringify([
          {
            Service: 'web',
            Name: 'STATUS_SENTINEL',
            Command: 'redis --requirepass STATUS_SENTINEL',
            Image: 'STATUS_SENTINEL',
            State: 'running',
            Health: 'healthy',
            ExitCode: 0,
          },
        ]),
      );
      const status = run(deployedScript(app, ['ps', '--all'], false));
      assert.strictEqual(status.status, 0, String(status.stderr));
      assert.notInclude(String(status.stdout) + String(status.stderr), 'STATUS_SENTINEL');
      assert.deepStrictEqual(JSON.parse(String(status.stdout)), {
        service: 'web',
        state: 'running',
        health: 'healthy',
        exitCode: 0,
      });
      writeFileSync(join(dir, 'noisy'), 'STATUS_SENTINEL');
      const stop = run(deployedScript(app, ['stop'], true));
      assert.strictEqual(stop.status, 0);
      assert.notInclude(String(stop.stdout) + String(stop.stderr), 'STATUS_SENTINEL');
      const direct = run(`bash ${shellQuote(join(dir, 'stack/current/compose.sh'))} stop`);
      assert.strictEqual(direct.status, 0);
      assert.notInclude(String(direct.stdout) + String(direct.stderr), 'STATUS_SENTINEL');
    }));

  it.each([false, true])(
    'rejects old activation runtime without guessing its missing dotenv selection (required=%s)',
    (required) =>
      fixture((app, deploy, dir, run) => {
        assert.strictEqual(deploy('one').status, 0);
        assert.strictEqual(deploy('two').status, 0);
        for (const id of ['one', 'two']) {
          const release = join(dir, 'stack/releases', id);
          const source = join(dir, `${id}.env`);
          writeFileSync(source, 'TOKEN=HOST_ONLY');
          const block = required
            ? `test -f ${shellQuote(source)} || { echo 'Configured host env file is missing' >&2; exit 1; }\nargs+=(--env-file ${shellQuote(source)})`
            : `if [ -f ${shellQuote(source)} ]; then args+=(--env-file ${shellQuote(source)}); fi`;
          const inner = `set -eu\nargs=()\n${block}\nargs+=(--env-file ${shellQuote(join(release, 'release.env'))})\nexec docker compose --project-name fixture --file ${shellQuote(join(release, 'compose.yaml'))} "\${args[@]}" "$@"`;
          writeFileSync(
            join(release, 'compose.sh'),
            `#!/usr/bin/env bash\nset -eu\nexport PATH=${shellQuote(join(dir, 'bin'))}:$PATH\nexec env -i HOME="$HOME" PATH="$PATH" bash -c ${shellQuote(inner)} -- "$@"\n`,
          );
        }
        rmSync(join(dir, 'stack/current/secret-source.json'));
        const calls = readFileSync(join(dir, 'calls'), 'utf8');
        const rollback = run(rollbackScript(app));
        assert.notStrictEqual(rollback.status, 0);
        assert.include(String(rollback.stderr), 'redeploy');
        assert.strictEqual(readFileSync(join(dir, 'calls'), 'utf8'), calls);
        const inspect = run(deployedScript(app, ['ps', '--all'], false));
        assert.notStrictEqual(inspect.status, 0);
        assert.strictEqual(readFileSync(join(dir, 'calls'), 'utf8'), calls);
        assert.strictEqual(deploy('upgraded').status, 0);
        assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/upgraded');
      }),
  );

  it('refuses rollback without an active source even if a successful orphan release survives', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('one').status, 0);
      rmSync(join(dir, 'stack/current'));
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      const result = run(rollbackScript(app, 'one'));
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'No active release or secret source');
      assert.strictEqual(readFileSync(join(dir, 'calls'), 'utf8'), calls);
    }));

  it('promotes successive releases atomically and rolls back their frozen config and image refs', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('one').status, 0);
      const first = readFileSync(join(dir, 'stack/releases/one/compose.json'), 'utf8');
      assert.include(first, 'fixture-web:one');
      assert.strictEqual(deploy('two').status, 0);
      assert.strictEqual(deploy('three').status, 0);
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/three');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/previous')), '../../releases/two');
      const result = run(rollbackScript(app, 'one'));
      assert.strictEqual(result.status, 0, String(result.stderr));
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/one');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/previous')), '../../releases/three');
      assert.include(readFileSync(join(dir, 'environment'), 'utf8'), 'WEB_IMAGE=fixture-web:one');
      assert.include(readFileSync(join(dir, 'environment'), 'utf8'), 'CALLER_SECRET=\n');
    }));

  it('keeps current after validation failure and keeps secret diagnostics exclusively on the host', () =>
    fixture((_app, deploy, dir) => {
      assert.strictEqual(deploy('good').status, 0);
      writeFileSync(join(dir, 'invalid'), 'yes');
      const result = deploy('invalid');
      assert.notStrictEqual(result.status, 0);
      assert.notInclude(String(result.stdout) + String(result.stderr), 'sentinel-secret-in-validation');
      assert.include(
        readFileSync(join(dir, 'stack/releases/invalid/validation.log'), 'utf8'),
        'sentinel-secret-in-validation',
      );
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/good');
      assert.notInclude(readFileSync(join(dir, 'calls'), 'utf8').split('\n').at(-2), 'up');
    }));

  it('reports partial Compose failure and retains the previous successful pointer', () =>
    fixture((_app, deploy, dir) => {
      assert.strictEqual(deploy('good').status, 0);
      writeFileSync(join(dir, 'up-fail'), 'yes');
      const result = deploy('partial');
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'partially updated');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/good');
      assert.strictEqual(deploy('interrupted', 'eA==\n').status, 1);
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/good');
    }));

  it('serializes mutations with a portable lock, preserving operator files and all release data on down', () =>
    fixture((app, deploy, dir, run) => {
      writeFileSync(join(dir, 'stack/.env'), 'KEEP=secret');
      mkdirSync(join(dir, 'stack/data'));
      writeFileSync(join(dir, 'stack/data/value'), 'keep');
      assert.strictEqual(deploy('good').status, 0);
      mkdirSync(join(dir, 'stack/.deploy-lock'));
      const locked = deploy('blocked');
      assert.notStrictEqual(locked.status, 0);
      assert.include(String(locked.stderr), 'locked');
      rmSync(join(dir, 'stack/.deploy-lock'), { recursive: true });
      const edited: App = {
        ...app,
        config: { ...app.config, composeFiles: ['not-deployed.yaml'], profiles: ['not-deployed'] },
      };
      assert.strictEqual(run(deployedScript(edited, ['down', '--remove-orphans'], true)).status, 0);
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      assert.notInclude(calls, 'not-deployed');
      assert.include(calls, 'releases/good/compose.yaml');
      assert.notInclude(calls, '--volumes');
      assert.strictEqual(readFileSync(join(dir, 'stack/.env'), 'utf8'), 'KEEP=secret');
      assert.strictEqual(readFileSync(join(dir, 'stack/data/value'), 'utf8'), 'keep');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/good');
    }));

  it('rejects writable release binds after host-side interpolation and refuses symlinked roots', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('good').status, 0);
      writeFileSync(
        join(dir, 'model.json'),
        JSON.stringify({
          services: {
            web: { volumes: [{ type: 'bind', source: join(dir, 'stack/releases/bad/data'), target: '/data' }] },
          },
        }),
      );
      const result = deploy('bad');
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'Unsafe Compose paths');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/good');
      const alias = join(dir, 'alias');
      symlinkSync(join(dir, 'stack'), alias);
      const linked: App = { ...app, config: { ...app.config, remote: { stackDir: alias } } };
      assert.notStrictEqual(run(rollbackScript(linked, 'good')).status, 0);
    }));

  it('preserves a coherent current/predecessor pair across interruption at the sole promotion commit', () =>
    fixture((app, deploy, dir, run) => {
      const state = () =>
        String(
          run(`root=${shellQuote(join(dir, 'stack'))}\n${readStateScript()}printf '%s %s' "$release_id" "$previous_id"`)
            .stdout,
        );
      assert.strictEqual(deploy('one').status, 0);
      assert.strictEqual(deploy('two').status, 0);
      const records = readdirSync(join(dir, 'stack/.activations')).length;
      assert.strictEqual(run(rollbackScript(app, 'two')).status, 0);
      assert.strictEqual(state(), 'two one');
      assert.lengthOf(readdirSync(join(dir, 'stack/.activations')), records);
      const before = deploy('before', undefined, (script) =>
        script.replace(
          '  mv "$move_mode" "$next_current" "$root/current"',
          '  exit 99\n  mv "$move_mode" "$next_current" "$root/current"',
        ),
      );
      assert.strictEqual(before.status, 99);
      assert.strictEqual(state(), 'two one');
      assert.strictEqual(run(rollbackScript(app)).status, 0);
      assert.strictEqual(state(), 'one two');
      const after = deploy('after', undefined, (script) =>
        script.replace(
          '  next_previous="$root/.previous-$activation"',
          '  exit 99\n  next_previous="$root/.previous-$activation"',
        ),
      );
      assert.strictEqual(after.status, 99);
      assert.strictEqual(state(), 'after one');
      assert.strictEqual(run(rollbackScript(app)).status, 0);
      assert.strictEqual(state(), 'one after');
      assert.include(readFileSync(join(dir, 'stack/current/manifest.json'), 'utf8'), '"id":"one"');
    }));

  it('reapplies the current successful release after a partially changed failed candidate without losing its predecessor', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('one').status, 0);
      assert.strictEqual(deploy('good').status, 0);
      const current = readlinkSync(join(dir, 'stack/current'));
      const predecessor = readlinkSync(join(dir, 'stack/current/previous'));
      writeFileSync(join(dir, 'up-fail'), 'yes');
      assert.notStrictEqual(deploy('partial').status, 0);
      assert.strictEqual(readFileSync(join(dir, 'running-image'), 'utf8'), 'fixture-web:partial');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current')), current);
      rmSync(join(dir, 'up-fail'));
      const result = run(rollbackScript(app, 'good'));
      assert.strictEqual(result.status, 0, String(result.stderr));
      assert.strictEqual(readFileSync(join(dir, 'running-image'), 'utf8'), 'fixture-web:good');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current')), current);
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/previous')), predecessor);
      assert.include(String(result.stdout), 'Reapplied current release; predecessor retained');
    }));

  it('chooses default rollback from the locked activation state at execution time', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('one').status, 0);
      assert.strictEqual(deploy('two').status, 0);
      const plannedBeforeConcurrentPromotion = rollbackScript(app);
      assert.strictEqual(deploy('three').status, 0);
      assert.strictEqual(run(plannedBeforeConcurrentPromotion).status, 0);
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/two');
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/previous')), '../../releases/three');
    }));

  it('rejects an activation release link that escapes the checked release store', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('good').status, 0);
      const activation = readlinkSync(join(dir, 'stack/current'));
      const link = join(dir, 'stack', activation, 'release');
      rmSync(link);
      symlinkSync('../../releases/../outside', link);
      const result = run(deployedScript(app, ['ps', '--all'], false));
      assert.notStrictEqual(result.status, 0);
      assert.include(String(result.stderr), 'Unsafe or missing deployed release state');
    }));

  it('honors optional absolute service env files without weakening required or relative-path checks', () =>
    fixture((_app, deploy, dir) => {
      const model = (path: string, required: boolean) =>
        writeFileSync(
          join(dir, 'model.json'),
          JSON.stringify({ services: { web: { env_file: [{ path, required }] } } }),
        );
      const missing = join(dir, 'not-provisioned.env');
      model(missing, false);
      assert.strictEqual(deploy('optional-missing').status, 0);
      const present = join(dir, 'optional.env');
      writeFileSync(present, 'TOKEN=host-only');
      model(present, false);
      assert.strictEqual(deploy('optional-present').status, 0);
      model(missing, true);
      assert.notStrictEqual(deploy('required-missing').status, 0);
      model('../relative.env', false);
      assert.notStrictEqual(deploy('relative-optional').status, 0);
      assert.strictEqual(readlinkSync(join(dir, 'stack/current/release')), '../../releases/optional-present');
    }));

  it('blocks malformed live configuration before inspection, follow logs or lifecycle mutations without writes', () =>
    fixture((app, deploy, dir, run) => {
      assert.strictEqual(deploy('good').status, 0);
      writeFileSync(join(dir, 'invalid'), 'yes');
      const before = readFileSync(join(dir, 'stack/releases/good/validation.log'), 'utf8');
      for (const args of [['ps', '--all'], ['logs', '--follow'], ['stop'], ['down']]) {
        const result = run(deployedScript(app, args, args[0] === 'stop' || args[0] === 'down'));
        assert.notStrictEqual(result.status, 0);
        assert.notInclude(String(result.stdout) + String(result.stderr), 'sentinel-secret-in-validation');
        assert.include(String(result.stderr), 'inspect host env and overlay privately');
      }
      assert.strictEqual(readFileSync(join(dir, 'stack/releases/good/validation.log'), 'utf8'), before);
    }));

  it('encodes literal configured dollars, quotes and trailing backslashes as valid double-quoted dotenv', () => {
    const environment = {
      APOS: "it's literal",
      BACK: 'C:\\temp\\path',
      DOLLAR: '$HOME ${OTHER}',
      TRAIL: 'ends\\',
      BOTH: "slash\\'quote",
      EMPTY: '',
    };
    const app: App = {
      dir: '/app',
      config: { name: 'app', host: 'host', targets: [], composeFiles: ['compose.yaml'], environment },
    };
    const lines = generatedEnvironment(app).trim().split('\n');
    for (const [index, [key, value]] of Object.entries(environment).entries()) {
      const encoded = lines[index]!.slice(key.length + 1);
      assert.strictEqual(JSON.parse(encoded).replaceAll('$$', '$'), value);
    }
    assert.include(generatedEnvironment(app), 'DOLLAR="$$HOME $${OTHER}"');
  });

  it('rejects reserved image variables and target variable collisions', () => {
    const app: App = {
      dir: '/app',
      config: {
        name: 'app',
        host: 'host',
        targets: ['web'],
        composeFiles: ['compose.yaml'],
        environment: { WEB_IMAGE: 'wrong' },
      },
    };
    assert.throws(() => generatedEnvironment(app), 'reserved');
    assert.throws(
      () =>
        generatedEnvironment({ ...app, config: { ...app.config, targets: ['foo-bar', 'foo_bar'], environment: {} } }),
      'distinct',
    );
  });
});

/**
 * The installed Compose availability; the real-parser regression remains optional on machines without Docker.
 */
const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

it.skipIf(!composeAvailable)(
  'suppresses actual Compose malformed-secret diagnostics during read-only deployed inspection',
  { timeout: SSH_TRANSACTION_TIMEOUT_MILLIS },
  () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'dd-compose-secret-'));
    const release = join(root, 'releases/one');
    const secret = 'SENTINEL_UNTERMINATED_PRODUCTION_SECRET';
    const app: App = {
      dir: root,
      config: {
        name: 'fixture',
        host: 'fixture',
        targets: [],
        composeFiles: ['compose.yaml'],
        execution: 'ssh',
        remote: { stackDir: root, envFile: join(root, '.env') },
      },
    };
    try {
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, 'compose.yaml'), 'services: {web: {image: nginx, environment: {TOKEN: "${TOKEN}"}}}');
      writeFileSync(join(release, 'release.env'), '');
      writeFileSync(join(release, 'manifest.json'), '{}');
      writeFileSync(join(release, 'successful'), 'successful');
      const staged = deploymentScript(app, host, 'one', 'one', []);
      const names = [...staged.script.matchAll(/compoza_decode > '([^']+)'/g)].map((match) => match[1]!);
      const records = staged.input.trimEnd().split('\n');
      for (const [index, name] of names.entries()) {
        writeFileSync(name, Buffer.from(records[index]!, 'base64'));
      }
      writeFileSync(join(release, 'successful'), 'successful');
      writeFileSync(join(root, '.env'), 'TOKEN=valid');
      assert.strictEqual(
        spawnSync('bash', [join(release, 'compose.sh'), 'config', '--quiet'], { encoding: 'utf8' }).status,
        0,
      );
      const record = join(root, '.activations', 'a'.repeat(32));
      mkdirSync(record, { recursive: true });
      symlinkSync('../../releases/one', join(record, 'release'));
      symlinkSync('release/manifest.json', join(record, 'manifest.json'));
      symlinkSync('release/compose.sh', join(record, 'compose.sh'));
      writeFileSync(
        join(record, 'secret-source.json'),
        JSON.stringify({ path: join(root, '.env'), required: true, managed: false }),
      );
      symlinkSync(`.activations/${'a'.repeat(32)}`, join(root, 'current'));
      writeFileSync(join(root, '.env'), `TOKEN="${secret}\n`);
      const raw = spawnSync('bash', [join(release, 'compose.sh'), 'config', '--quiet'], { encoding: 'utf8' });
      assert.notStrictEqual(raw.status, 0);
      assert.include(raw.stderr, secret);
      const before = readdirSync(release).sort();
      for (const args of [
        ['ps', '--all'],
        ['logs', '--follow'],
      ]) {
        const result = spawnSync('bash', ['-c', deployedScript(app, args, false)], { encoding: 'utf8' });
        assert.notStrictEqual(result.status, 0);
        assert.notInclude(result.stdout + result.stderr, secret);
        assert.include(result.stderr, 'inspect host env and overlay privately');
      }
      const direct = spawnSync('bash', [join(release, 'compose.sh'), 'ps', '--all'], { encoding: 'utf8' });
      assert.notInclude(direct.stdout + direct.stderr, secret);
      assert.notStrictEqual(direct.status, 0);
      assert.deepStrictEqual(readdirSync(release).sort(), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!composeAvailable)('round-trips provider literals through the actual Compose dotenv parser', async () => {
  const { secretEnvironment } = await import('./config/secrets.ts');
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dd-compose-literals-'));
  const values = { TOKEN: '$HOME ${OTHER} "quoted" \\ trailing\\', APOS: "it's a literal", EMPTY: '' };
  try {
    writeFileSync(join(dir, 'secrets.env'), secretEnvironment(values));
    writeFileSync(
      join(dir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n    environment:\n      TOKEN: ${TOKEN}\n      APOS: ${APOS}\n      EMPTY: ${EMPTY}\n',
    );
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--project-name',
        'fixture',
        '--env-file',
        join(dir, 'secrets.env'),
        '--file',
        join(dir, 'compose.yaml'),
        'config',
        '--environment',
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    );
    assert.strictEqual(result.status, 0, result.stderr);
    const loaded = Object.fromEntries(
      result.stdout
        .split('\n')
        .filter((line) => Object.hasOwn(values, line.slice(0, line.indexOf('='))))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    assert.deepStrictEqual(loaded, values);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!composeAvailable)(
  'prevents explicit local none and development sources from loading production .env implicitly',
  async () => {
    const { planDeployment } = await import('./plan.ts');
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dd-local-none-'));
    try {
      writeFileSync(join(dir, '.env'), 'TOKEN=FICTIONAL_PRODUCTION_SENTINEL\n');
      writeFileSync(
        join(dir, 'compose.yaml'),
        'services: {web: {image: nginx, environment: {TOKEN: "${TOKEN-unset}", DEV: "${DEV-unset}"}}}',
      );
      for (const provider of ['none', 'env-file'] as const) {
        const app: App = {
          dir,
          config: {
            name: 'fixture',
            host: 'atlas',
            targets: [],
            composeFiles: ['compose.yaml'],
            secrets: { provider: 'env-file', path: '.env' },
            local: { secrets: provider === 'none' ? { provider: 'none' } : { provider: 'env-file', path: 'dev.env' } },
          },
        };
        const plan = planDeployment({
          app,
          host,
          tag: 'test',
          context: dir,
          local: true,
          reuseImages: true,
          secrets: provider === 'none' ? {} : { DEV: 'development' },
        });
        const command = plan[0]!;
        assert.isTrue('program' in command);
        if ('program' in command) {
          const args = [...command.args.slice(0, command.args.indexOf('up')), 'config', '--format', 'json'];
          const result = spawnSync(command.program, args, {
            encoding: 'utf8',
            cwd: dir,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, ...command.env },
          });
          assert.strictEqual(result.status, 0, result.stderr);
          const environment = JSON.parse(result.stdout).services.web.environment;
          assert.strictEqual(environment.TOKEN, 'unset');
          assert.strictEqual(environment.DEV, provider === 'none' ? 'unset' : 'development');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

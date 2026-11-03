import { assert, describe, it } from '@effect/vitest';
import { spawn, spawnSync } from 'node:child_process';
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
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { REMOTE_PATH } from '../../command.ts';
import { routeScript, unrouteScript, setupScript } from './scripts.ts';

/**
 * The per-test limit; each test spawns a few short Bash and fake Docker processes.
 */
const ROUTE_TEST_TIMEOUT_MS = 15_000;

/**
 * How long `until` waits for a lock or child exit, generous for process startup under full-suite
 * load.
 */
const UNTIL_DEADLINE_MS = 5_000;

/**
 * How often `until` re-checks its predicate.
 */
const UNTIL_POLL_INTERVAL_MS = 10;

/**
 * Runs the actual host scripts with a fake Docker that can reject a reload or fail its recovery.
 */
async function fixture(
  use: (f: ReturnType<typeof createFixture>) => void | Promise<void>,
): Promise<void> {
  using temporary = mkdtempDisposableSync(join(tmpdir(), 'dd-caddy-route-'));
  const f = createFixture(temporary.path);
  await use(f);
}

/**
 * Creates an isolated shared proxy directory; Docker invocations see only synthetic site content
 * and credentials.
 */
function createFixture(dir: string) {
  mkdirSync(join(dir, 'sites'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(
    join(dir, 'bin', 'docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n');
if (args[0] === 'compose' && args.includes('config')) { console.error('SYNTHETIC_EXPANDED_SECRET'); process.exit(1); }
if (args.join(' ') !== 'exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile') process.exit(90);
const flag = path.join(dir, 'reject');
if (fs.existsSync(flag)) {
  const mode = fs.readFileSync(flag, 'utf8');
  if (mode === 'once') fs.unlinkSync(flag);
  console.error('SYNTHETIC_EXPANDED_SECRET');
  process.exit(1);
}
fs.writeFileSync(path.join(dir, 'active'), fs.existsSync(path.join(dir,'sites','app.caddy')) ? fs.readFileSync(path.join(dir,'sites','app.caddy')) : 'removed');
`,
    { mode: 0o700 },
  );

  const proxy = { dir, container: 'caddy', network: 'edge' };
  const script = (remove = false) =>
    (remove ? unrouteScript(proxy, 'app') : routeScript(proxy, 'app')).replace(REMOTE_PATH, '');
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` };
  return {
    dir,
    file: join(dir, 'sites', 'app.caddy'),
    lock: join(dir, '.compoza-caddy.lock'),
    script,
    env,
    run: (remove = false) =>
      spawnSync('/bin/bash', ['-c', script(remove)], { env, input: 'candidate', encoding: 'utf8' }),
  };
}

/**
 * Waits for a lock or child exit with a bounded deadline instead of assuming process startup
 * timing.
 */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + UNTIL_DEADLINE_MS;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for route process');
    }

    await setTimeout(UNTIL_POLL_INTERVAL_MS);
  }
}

describe('Caddy route transactions', { timeout: ROUTE_TEST_TIMEOUT_MS }, () => {
  it('shares the setup lock and restores legacy files without printing Compose diagnostics', () =>
    fixture((f) => {
      const caddyfile = '# existing config\n';
      const compose =
        'services:\n  caddy:\n    volumes:\n      - ./Caddyfile:/etc/caddy/Caddyfile:ro\n';
      writeFileSync(join(f.dir, 'Caddyfile'), caddyfile);
      writeFileSync(join(f.dir, 'docker-compose.yaml'), compose);

      const script = setupScript({ dir: f.dir, container: 'caddy', network: 'edge' }).replace(
        REMOTE_PATH,
        '',
      );
      mkdirSync(f.lock);

      const locked = spawnSync('/bin/bash', ['-c', script], { env: f.env, encoding: 'utf8' });
      assert.notStrictEqual(locked.status, 0);
      assert.include(locked.stderr, 'Caddy is locked');
      assert.isFalse(existsSync(join(f.dir, 'calls')));

      rmSync(f.lock, { recursive: true });

      const result = spawnSync('/bin/bash', ['-c', script], { env: f.env, encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0);
      assert.include(result.stderr, 'Compose validation failed');
      assert.notInclude(result.stdout + result.stderr, 'SYNTHETIC_EXPANDED_SECRET');
      assert.strictEqual(readFileSync(join(f.dir, 'Caddyfile'), 'utf8'), caddyfile);
      assert.strictEqual(readFileSync(join(f.dir, 'docker-compose.yaml'), 'utf8'), compose);
      assert.isFalse(existsSync(f.lock));
    }));

  it('installs and removes complete files with one reload per change', () =>
    fixture((f) => {
      assert.strictEqual(f.run().status, 0);
      assert.strictEqual(readFileSync(f.file, 'utf8'), 'candidate');
      assert.strictEqual(readFileSync(join(f.dir, 'active'), 'utf8'), 'candidate');
      assert.strictEqual(statSync(f.file).mode & 0o777, 0o600);
      assert.strictEqual(f.run(true).status, 0);
      assert.isFalse(existsSync(f.file));
      assert.strictEqual(readFileSync(join(f.dir, 'active'), 'utf8'), 'removed');
      assert.strictEqual(f.run(true).status, 0);
      assert.strictEqual(readFileSync(join(f.dir, 'calls'), 'utf8').trim().split('\n').length, 2);
      assert.isFalse(existsSync(f.lock));
      assert.deepStrictEqual(readdirSync(join(f.dir, 'sites')), []);
    }));

  it.each([false, true])(
    'restores the previous file and active config after rejected removal=%s',
    (remove) =>
      fixture((f) => {
        writeFileSync(f.file, 'previous');
        writeFileSync(join(f.dir, 'reject'), 'once');

        const result = f.run(remove);
        assert.notStrictEqual(result.status, 0);
        assert.strictEqual(readFileSync(f.file, 'utf8'), 'previous');
        assert.strictEqual(readFileSync(join(f.dir, 'active'), 'utf8'), 'previous');
        assert.notInclude(result.stdout + result.stderr, 'SYNTHETIC_EXPANDED_SECRET');
        assert.isFalse(existsSync(f.lock));
        assert.deepStrictEqual(readdirSync(join(f.dir, 'sites')), ['app.caddy']);
      }),
  );

  it('removes a rejected new route and reloads the previous configuration', () =>
    fixture((f) => {
      writeFileSync(join(f.dir, 'reject'), 'once');

      assert.notStrictEqual(f.run().status, 0);
      assert.isFalse(existsSync(f.file));
      assert.strictEqual(readFileSync(join(f.dir, 'active'), 'utf8'), 'removed');
    }));

  it('retains a private recovery directory and shared lock when recovery fails', () =>
    fixture((f) => {
      writeFileSync(f.file, 'previous');
      writeFileSync(join(f.dir, 'reject'), 'always');

      const result = f.run();
      assert.notStrictEqual(result.status, 0);
      assert.include(result.stderr, 'recovery reload failed');
      assert.notInclude(result.stdout + result.stderr, 'SYNTHETIC_EXPANDED_SECRET');
      assert.strictEqual(readFileSync(f.file, 'utf8'), 'previous');
      assert.isTrue(existsSync(f.lock));

      const stage = readdirSync(join(f.dir, 'sites')).find((name) =>
        name.startsWith('.compoza-route.'),
      )!;
      assert.strictEqual(statSync(join(f.dir, 'sites', stage)).mode & 0o777, 0o700);
      assert.strictEqual(readFileSync(join(f.dir, 'sites', stage, 'previous'), 'utf8'), 'previous');
      assert.include(f.run().stderr, 'Caddy is locked');
    }));

  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'blocks another app while staging and preserves the prior file on %s',
    (signal) =>
      fixture(async (f) => {
        writeFileSync(f.file, 'previous');

        const child = spawn('/bin/bash', ['-c', f.script()], {
          env: f.env,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

        try {
          await until(() => existsSync(f.lock));
          child.stdin.write('incomplete');

          const other = routeScript(
            { dir: f.dir, container: 'caddy', network: 'edge' },
            'other',
          ).replace(REMOTE_PATH, '');
          const blocked = spawnSync('/bin/bash', ['-c', other], {
            env: f.env,
            input: 'other',
            encoding: 'utf8',
          });
          assert.notStrictEqual(blocked.status, 0);
          assert.include(blocked.stderr, 'Caddy is locked');
          assert.strictEqual(readFileSync(f.file, 'utf8'), 'previous');

          child.kill(signal);
          child.stdin.end();
          await exited;

          assert.strictEqual(readFileSync(f.file, 'utf8'), 'previous');
          assert.isFalse(existsSync(f.lock));
          assert.isFalse(existsSync(join(f.dir, 'calls')));
        } finally {
          child.kill('SIGTERM');
          child.stdin.end();
          await exited;
        }
      }),
  );

  it('rejects symlink routes without modifying their target', () =>
    fixture((f) => {
      const target = join(f.dir, 'unrelated');
      writeFileSync(target, 'untouched');
      symlinkSync(target, f.file);

      assert.notStrictEqual(f.run().status, 0);
      assert.strictEqual(readFileSync(target, 'utf8'), 'untouched');
      assert.isFalse(existsSync(f.lock));
      assert.isFalse(existsSync(join(f.dir, 'calls')));
    }));
});

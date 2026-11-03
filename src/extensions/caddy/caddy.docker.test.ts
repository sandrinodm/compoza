import { assert, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

import { REMOTE_PATH } from '../../command.ts';
import { parseCheck } from '../../probe.ts';
import { provisionOperation } from './provision.ts';
import { checkScript, routeScript, unrouteScript } from './scripts.ts';

/**
 * Opt-in local image references; the ordinary suite neither pulls images nor starts Docker
 * containers.
 */
const images = process.env.COMPOZA_TEST_CADDY_IMAGES?.split(',').filter(Boolean) ?? [];

/**
 * The limit for one Docker or curl command, above the 60-second `--wait-timeout` the stack start
 * uses so Compose reports an unhealthy stack before the command is killed.
 */
const COMMAND_TIMEOUT_MS = 70_000;

/**
 * The limit for the whole smoke test, which starts and tears down a real Caddy stack per image.
 */
const SMOKE_TEST_TIMEOUT_MS = 180_000;

/**
 * The limit for the route script run that Caddy is expected to reject.
 */
const REJECTED_ROUTE_TIMEOUT_MS = 15_000;

/**
 * The limit for the best-effort `docker compose down`, so a stuck Docker cannot hang the suite.
 */
const STACK_DOWN_TIMEOUT_MS = 30_000;

/**
 * The limit for the best-effort removal of the test network.
 */
const NETWORK_REMOVE_TIMEOUT_MS = 10_000;

/**
 * Runs a bounded smoke-test command, returning diagnostics only from this disposable,
 * credential-free stack.
 */
function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS });
  assert.strictEqual(result.status, 0, `${command}: ${result.error ?? result.stderr}`);

  return result.stdout;
}

it.skipIf(images.length === 0)(
  'runs hardened Compose, health, metrics and transactional reloads with real Caddy',
  { timeout: SMOKE_TEST_TIMEOUT_MS },
  () => {
    for (const image of images) {
      using temporary = mkdtempDisposableSync(join(tmpdir(), 'dd-caddy-smoke-'));
      const dir = temporary.path;
      const name = `dd-caddy-smoke-${randomBytes(6).toString('hex')}`;
      const proxy = {
        dir,
        container: name,
        network: `${name}-edge`,
        logSnippet: 'request_log',
        provision: { image },
      };
      const generated = JSON.parse(provisionOperation(proxy).input!);
      const compose = YAML.parse(generated.compose);
      // Keep production settings; isolate only the test's HTTP port, project identity and image
      // selection.
      compose.services[name].ports = ['127.0.0.1::8080'];

      for (const folder of ['sites', 'data', 'config']) {
        mkdirSync(join(dir, folder), { mode: 0o700 });
      }

      writeFileSync(join(dir, 'compose.yaml'), YAML.stringify(compose));
      writeFileSync(join(dir, 'Caddyfile'), generated.caddyfile, { mode: 0o600 });
      writeFileSync(
        join(dir, 'sites', 'app.caddy'),
        ':8080 {\n import request_log app\n respond "initial"\n}\n',
      );

      const args = [
        'compose',
        '--project-name',
        name,
        '--env-file',
        '/dev/null',
        '-f',
        join(dir, 'compose.yaml'),
      ];

      try {
        run('docker', ['network', 'create', proxy.network]);
        run('docker', [...args, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '60']);

        const address = run('docker', [...args, 'port', name, '8080']).trim();
        const request = () =>
          run('curl', [
            '--fail',
            '--silent',
            '--show-error',
            '--max-time',
            '5',
            `http://${address}`,
          ]);
        assert.strictEqual(request(), 'initial');

        const probe = parseCheck(
          run('/bin/bash', [
            '-c',
            checkScript({ proxy: { ...proxy, composeFile: 'compose.yaml' }, name: 'app' }).replace(
              REMOTE_PATH,
              '',
            ),
          ]),
        );
        assert.strictEqual(probe.container_running, 'yes');
        assert.strictEqual(probe.container_health, 'healthy');

        const metrics = run('docker', [
          'exec',
          name,
          'wget',
          '-qO-',
          'http://127.0.0.1:2019/metrics',
        ]);
        assert.include(metrics, 'caddy_http_requests_total');
        assert.isTrue(existsSync(join(dir, 'data', 'app.log')));

        const script = routeScript(proxy, 'app').replace(REMOTE_PATH, '');
        const updated = ':8080 {\n import request_log app\n respond "updated"\n}\n';
        run('/bin/bash', ['-c', script], updated);

        assert.strictEqual(request(), 'updated');

        const rejected = spawnSync('/bin/bash', ['-c', script], {
          input: ':8080 {\n invalid_SYNTHETIC_SECRET\n}\n',
          encoding: 'utf8',
          timeout: REJECTED_ROUTE_TIMEOUT_MS,
        });
        assert.notStrictEqual(rejected.status, 0);
        assert.notInclude(rejected.stdout + rejected.stderr, 'SYNTHETIC_SECRET');
        assert.strictEqual(readFileSync(join(dir, 'sites', 'app.caddy'), 'utf8'), updated);
        assert.strictEqual(request(), 'updated');
        assert.isFalse(existsSync(join(dir, '.compoza-caddy.lock')));

        run('/bin/bash', ['-c', unrouteScript(proxy, 'app').replace(REMOTE_PATH, '')]);

        assert.isFalse(existsSync(join(dir, 'sites', 'app.caddy')));
      } finally {
        spawnSync('docker', [...args, 'down', '--timeout', '5'], {
          stdio: 'ignore',
          timeout: STACK_DOWN_TIMEOUT_MS,
        });
        spawnSync('docker', ['network', 'rm', proxy.network], {
          stdio: 'ignore',
          timeout: NETWORK_REMOVE_TIMEOUT_MS,
        });
      }
    }
  },
);

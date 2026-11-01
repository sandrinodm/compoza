import { assert, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

import { provisionOperation } from './provision.ts';

/**
 * Explicitly opt into a local connector image; ordinary tests never pull images or use Cloudflare credentials.
 */
const image = process.env.COMPOZA_TEST_CLOUDFLARED_IMAGE;

/**
 * Runs bounded native probes; every diagnostic belongs to an isolated container using a synthetic token.
 */
function run(args: string[], required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });

  if (required) {
    assert.strictEqual(result.status, 0, result.stderr);
  }

  return result;
}

it.skipIf(image === undefined)(
  'runs the pinned native connector with production isolation and account-free readiness probes',
  { timeout: 60000 },
  () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'compoza-cloudflare-native-'));
    const dir = temporary.path;

    const name = `compoza-cf-${randomBytes(6).toString('hex')}`;
    const accountId = 'a'.repeat(32);

    const tunnelId = '12345678-1234-1234-1234-123456789abc';
    const envFile = join(dir, 'token.env');
    writeFileSync(
      envFile,
      `TUNNEL_TOKEN=${Buffer.from(JSON.stringify({ a: accountId, t: tunnelId, s: Buffer.alloc(32).toString('base64') })).toString('base64')}\n`,
      { mode: 0o600 },
    );

    const operation = provisionOperation({
      provider: 'cloudflare-tunnel',
      routing: 'manual',
      accountId,
      tunnelId,
      dir,
      container: name,
      network: `${name}-edge`,
      provision: { image: image!, envFile },
    });

    const model = YAML.parse(JSON.parse(operation.input!).compose);
    // Isolate the fixture from every external network; real connection success needs a separately authorized account.
    model.services.connector.network_mode = 'none';
    delete model.services.connector.networks;
    delete model.networks;

    const file = join(dir, 'compose.yaml');
    writeFileSync(file, YAML.stringify(model));

    const args = ['compose', '--project-name', `${name}-ingress`, '--env-file', '/dev/null', '-f', file];

    try {
      run([...args, 'up', '--detach', '--pull', 'never']);

      const info = JSON.parse(run(['inspect', name]).stdout)[0];
      assert.isTrue(info.HostConfig.ReadonlyRootfs);
      assert.deepStrictEqual(info.HostConfig.CapDrop, ['ALL']);
      assert.include(info.HostConfig.SecurityOpt, 'no-new-privileges:true');
      assert.strictEqual(info.Config.User, '65532:65532');
      assert.strictEqual(info.HostConfig.PidsLimit, 64);
      assert.strictEqual(info.HostConfig.Memory, 128 * 1024 * 1024);

      const version = run(['run', '--rm', '--network', 'none', image!, '--version']).stdout;
      assert.include(version, 'cloudflared version');

      const help = run(['run', '--rm', '--network', 'none', image!, 'tunnel', 'ready', '--help']).stdout;
      assert.include(help, '--metrics');
      assert.isTrue(info.State.Running);

      const logResult = run(['logs', name]);

      const logs = logResult.stdout + logResult.stderr;
      assert.notInclude(logs, 'flag provided but not defined');
      assert.include(logs, 'Starting tunnel');
      assert.include(logs, 'grace-period:30s');
      // No external connection means ready must fail; this proves process-running alone is not readiness.
      assert.notStrictEqual(
        run(['exec', name, 'cloudflared', 'tunnel', '--metrics', '127.0.0.1:20241', 'ready'], false).status,
        0,
      );
    } finally {
      run([...args, 'down', '--remove-orphans', '--timeout', '3']);
    }
  },
);

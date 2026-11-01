import { NodeServices } from '@effect/platform-node';
import { assert, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vite-plus/test';
import * as YAML from 'yaml';

import type { Step } from './command.ts';
import type { HostConfig } from './config/hosts.ts';

import { evaluateChecks } from './checks.ts';
import { printableStep } from './command.ts';
import { deploy, resolve } from './deploy.ts';
import { sha256, siteFile } from './extensions/caddy/scripts.ts';
import { remove } from './lifecycle.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';

vi.mock('node:dns/promises', () => ({
  Resolver: class {
    setServers() {}
    resolve4() {
      return Promise.resolve(['192.0.2.1']);
    }
    resolve6() {
      return Promise.reject(new Error('No AAAA record'));
    }
  },
}));

it.effect('uses the destination project identity consistently for client route creation, checks and deletion', () => {
  const scripts: Array<{
    readonly script: string;
    readonly input?: string | undefined;
    readonly label?: string | undefined;
  }> = [];

  const probes: Array<string> = [];
  const steps: Array<Step> = [];
  const host: HostConfig & { proxy: import('./extensions/caddy/config.ts').ProxyConfig } = {
    ssh: 'fixture',
    address: '192.0.2.1',
    platform: 'linux/arm64',
    transport: { mode: 'ssh-load' },
    proxy: { dir: '/srv/proxy', container: 'caddy', network: 'edge' },
  };

  const ingress = { mode: 'caddy' as const, domain: 'app.example.com', upstream: 'web:80' };
  const probe = {
    proxy_dir: 'present',
    caddyfile_import: 'yes',
    compose_mount: 'yes',
    running_mount: 'yes',
    container_running: 'yes',
    container_health: 'none',
    network: 'yes',
    site_sha256: sha256(siteFile('app-dev', ingress, host.proxy!)),
  };

  const noGit = () => Effect.die('Third-party stack must not consult Git');
  const services = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Layer.succeed(Git, Git.of({ root: noGit, hasCommits: noGit, isDirty: noGit, shortSha: noGit })),
    Layer.succeed(
      Shell,
      Shell.of({
        run: (step) =>
          Effect.sync(() => {
            steps.push(step);
          }),
        capture: () => Effect.die('No shell probes expected'),
      }),
    ),
    Layer.succeed(
      Remote,
      Remote.of({
        run: (_host, script, input, label) =>
          Effect.sync(() => {
            scripts.push({ script, input, label });

            return '';
          }),
        probe: (_host, script) =>
          Effect.sync(() => {
            probes.push(script);

            return Object.entries(probe)
              .map(([key, value]) => `${key}=${value}`)
              .join('\n');
          }),
      }),
    ),
  );
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-client-destination-'))),
    ({ path: dir }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(
            join(dir, 'deploy.yaml'),
            YAML.stringify({
              name: 'app',
              host: 'host',
              targets: [],
              execution: 'client',
              composeFiles: ['compose.yaml'],
              ingress,
              destinations: { dev: { projectName: 'app-dev' } },
            }),
          ),
        );

        const hosts = Option.some(join(dir, 'hosts.yaml'));
        yield* Effect.promise(() => writeFile(join(dir, 'hosts.yaml'), YAML.stringify({ host })));
        yield* deploy({
          target: dir,
          hosts,
          dryRun: true,
          local: false,
          allowDirty: false,
          tag: Option.none(),
          destination: 'dev',
        });

        const resolved = yield* resolve(dir, hosts, 'dev');
        const route = evaluateChecks(resolved.app, host, ['192.0.2.1'], probe).find((check) => check.name === 'route');
        assert.isTrue(route?.ok);

        yield* remove(resolved, false);

        assert.lengthOf(scripts, 2);
        assert.include(scripts[0]!.script, "file='app-dev.caddy'");
        assert.include(scripts[0]!.input, 'Managed by compoza for app-dev');
        assert.include(scripts[1]!.script, "file='app-dev.caddy'");
        assert.include(probes[0], 'sites/app-dev.caddy');
        assert.notInclude(scripts.map((entry) => entry.script).join('\n'), 'sites/app.caddy');
        assert.isTrue(steps.every((step) => printableStep(step).includes('--project-name app-dev')));
      }).pipe(Effect.provide(services), Effect.provideService(DryRun, true)),
    (directory) => Effect.promise(() => directory.remove()),
  );
});

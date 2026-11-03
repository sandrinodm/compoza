import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { selectDestination } from './config/deploy.ts';
import { deploy } from './deploy.ts';
import { planDeployment } from './plan.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';

const app: App = {
  dir: '/app',
  config: {
    name: 'app',
    host: 'atlas',
    workingDirectory: '/source-app',
    targets: ['web'],
    composeFiles: ['compose.yaml'],
    execution: 'ssh',
    remote: { stackDir: '/srv/app' },
    profiles: ['default'],
    destinations: {
      borealis: {
        host: 'borealis',
        projectName: 'app-dev',
        profiles: ['dev'],
        ingress: { mode: 'none' },
        remote: { stackDir: '/home/deploy/stacks/app' },
        environment: { DATA_PATH: '/home/deploy/data' },
      },
    },
  },
};

const host: HostConfig = {
  ssh: 'host',
  address: '192.0.2.1',
  platform: 'linux/arm64',
  transport: { mode: 'registry', registry: 'registry.test' },
};

describe('SSH deployment selection and transports', () => {
  it('selects a destination without changing the image prefix and rejects unknown names', () => {
    const selected = selectDestination(app, 'borealis');
    assert.strictEqual(selected.config.host, 'borealis');
    assert.strictEqual(selected.config.name, 'app');
    assert.strictEqual(selected.config.projectName, 'app-dev');
    assert.deepStrictEqual(selected.config.profiles, ['dev']);
    assert.deepStrictEqual(selected.config.remote, { stackDir: '/home/deploy/stacks/app' });
    assert.deepStrictEqual(selected.config.ingress, { mode: 'none' });
    assert.throws(() => selectDestination(app, 'unknown'), 'Unknown destination');
  });

  it.each(['registry', 'ssh-load', 'remote-build'] as const)(
    'keeps %s image transport independent of host Compose execution',
    (mode) => {
      const selectedHost: HostConfig = {
        ...host,
        transport: mode === 'registry' ? host.transport : { mode },
      };
      const steps = planDeployment({
        app,
        host: selectedHost,
        tag: 'abc',
        local: false,
        reuseImages: false,
        context: '/source',
        secrets: {},
      });
      const build = steps[0]!;
      assert.isTrue('program' in build);

      if ('program' in build) {
        assert.strictEqual(build.cwd, '/source-app');
        assert.include(build.args, '/source-app/Dockerfile');
        assert.include(build.args, mode === 'registry' ? '--push' : '--load');

        if (mode === 'remote-build') {
          assert.deepStrictEqual(build.args.slice(0, 6), [
            '--host',
            'ssh://host',
            'buildx',
            'build',
            '--builder',
            'default',
          ]);
          assert.deepStrictEqual(build.env, {
            DOCKER_CONTEXT: '',
            BUILDX_BUILDER: '',
            BUILDX_HOST: '',
          });
        }
      }

      assert.lengthOf(steps, mode === 'ssh-load' ? 3 : 2);

      const reused = planDeployment({
        app,
        host: selectedHost,
        tag: 'abc',
        local: false,
        reuseImages: true,
        context: '/source',
        secrets: {},
      });
      assert.lengthOf(reused, 1);
    },
  );

  it.effect(
    'dry-runs a third-party stack outside Git without building, staging, locks or local secret reads',
    () => {
      const writes: Array<string> = [];
      const probes: Array<string> = [];
      const noGit = () => Effect.die('Git must not be consulted for third-party-only stacks');
      const services = Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        Layer.succeed(
          Git,
          Git.of({ root: noGit, hasCommits: noGit, isDirty: noGit, shortSha: noGit }),
        ),
        Layer.succeed(
          Shell,
          Shell.of({
            run: () =>
              Effect.sync(() => {
                writes.push('build');
              }),
            capture: () => Effect.die('No local probes required'),
          }),
        ),
        Layer.succeed(
          Remote,
          Remote.of({
            run: (_host, _script, _input, label) =>
              Effect.gen(function* () {
                assert.isTrue(yield* DryRun);
                assert.include(label, 'stage');

                return '';
              }),
            probe: (_host, script) =>
              Effect.sync(() => {
                probes.push(script);

                return 'docker=yes\ncompose=yes\njq=yes\nstack_path=yes\nhost_env=yes\nhost_overlay=yes\ncurl=yes\nbuildkit=yes\n';
              }),
          }),
        ),
      );
      return Effect.acquireUseRelease(
        Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-dry-'))),
        ({ path: dir }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              writeFile(join(dir, 'compose.yaml'), 'services: {web: {image: nginx}}'),
            );
            yield* Effect.promise(() =>
              writeFile(
                join(dir, 'deploy.yaml'),
                YAML.stringify({
                  name: 'third-party',
                  workingDirectory: '/missing/app-checkout',
                  host: 'host',
                  targets: [],
                  execution: 'ssh',
                  remote: {
                    stackDir: '/srv/third-party',
                    envFile: '/host/secrets/never-local.env',
                  },
                  composeFiles: ['compose.yaml'],
                }),
              ),
            );
            yield* Effect.promise(() =>
              writeFile(
                join(dir, 'hosts.yaml'),
                YAML.stringify({ host: { ...host, transport: { mode: 'remote-build' } } }),
              ),
            );
            yield* deploy({
              target: dir,
              hosts: Option.some(join(dir, 'hosts.yaml')),
              dryRun: true,
              local: false,
              allowDirty: false,
              tag: Option.none(),
            });

            assert.lengthOf(writes, 0);
            assert.lengthOf(probes, 1);
          }).pipe(Effect.provide(services), Effect.provideService(DryRun, true)),
        (directory) => Effect.promise(() => directory.remove()),
      );
    },
  );
});

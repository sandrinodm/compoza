import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import type { Command } from './command.ts';
import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { selectDestination } from './config/deploy.ts';
import { deploy } from './deploy.ts';
import { planDeployment } from './plan.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { inspectSsh } from './ssh-deploy.ts';

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
        ingress: { none: {} },
        remote: { stackDir: '/home/deploy/stacks/app' },
        environment: { DATA_PATH: '/home/deploy/data' },
      },
    },
  },
};

const host: HostConfig = {
  ssh: 'host',
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
    assert.deepStrictEqual(selected.config.ingress, { none: {} });
    assert.throws(() => selectDestination(app, 'unknown'), 'Unknown destination');

    for (const name of ['constructor', 'toString']) {
      assert.throws(() => selectDestination(app, name), `Unknown destination "${name}"`);
    }
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
            run: (_host, _script, { label } = {}) =>
              Effect.gen(function* () {
                assert.isTrue(yield* DryRun);
                assert.include(label, 'stage');

                return '';
              }),
            probe: (_host, script) =>
              Effect.sync(() => {
                probes.push(script);

                return 'docker=yes\ncompose=yes\njq=yes\nstack_path=yes\nhost_overlay=yes\ncurl=yes\nbuildkit=yes\n';
              }),
          }),
        ),
      );
      return Effect.acquireUseRelease(
        Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-dry-'))),
        ({ path: dir }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              writeFile(
                join(dir, 'compose.yaml'),
                'services: {web: {image: nginx, env_file: [/host/secrets/never-local.env]}}',
              ),
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
                  remote: { stackDir: '/srv/third-party' },
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

describe('inspectSsh', () => {
  /**
   * Runs `inspectSsh` against a shell that records the SSH command instead of running it.
   */
  const inspected = (args: ReadonlyArray<string>, options: Parameters<typeof inspectSsh>[3]) => {
    const steps: Array<Command> = [];
    const shell = Shell.of({
      run: (step) =>
        Effect.sync(() => {
          steps.push(step as Command);
        }),
      capture: () => Effect.die('inspection captures nothing'),
    });
    return inspectSsh(app, host, args, options).pipe(
      Effect.provideService(Shell, shell),
      Effect.as(steps),
    );
  };

  /**
   * The host script of a recorded `ssh ... bash -c '<script>'` command, with its quoting undone.
   */
  const remoteScript = (step: Command) =>
    step.args
      .at(-1)!
      .replace(/^bash -c '/, '')
      .replace(/'$/, '')
      .replaceAll("'\\''", "'");

  it.effect('checks a named service before reading logs, without a terminal', () =>
    Effect.gen(function* () {
      const [step] = yield* inspected(['logs', '--tail', '5', 'web'], { service: 'web' });
      const script = remoteScript(step!);

      assert.deepStrictEqual(step!.args.slice(0, 2), ['-o', 'BatchMode=yes']);
      assert.include(script, "compoza_require_service 'web'");
      assert.notInclude(script, "trap 'exit 0' INT");
    }),
  );

  it.effect('follows under a pseudo-terminal that ends with the connection or Ctrl-C', () =>
    Effect.gen(function* () {
      const args = ['logs', '--tail', '5', '--follow'];
      const [terminal] = yield* inspected(args, { follow: true, outputIsTerminal: true });
      const [piped] = yield* inspected(args, { follow: true, outputIsTerminal: false });

      for (const step of [terminal!, piped!]) {
        assert.deepStrictEqual(step.args.slice(0, 3), ['-tt', '-o', 'LogLevel=ERROR']);
        assert.include(remoteScript(step), "trap 'exit 0' INT");
      }

      // Output piped to another program keeps plain newlines and no colors.
      assert.notInclude(remoteScript(terminal!), 'stty -onlcr');
      assert.notInclude(remoteScript(terminal!), '--no-color');
      assert.include(remoteScript(piped!), 'stty -onlcr');
      assert.include(remoteScript(piped!), "'logs' '--no-color' '--tail'");
    }),
  );
});

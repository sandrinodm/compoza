import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import type { Command, Step } from './command.ts';
import type { DeployConfig } from './config/deploy.ts';

import { readBundle } from './bundle.ts';
import { workingDirectoryOf } from './config/deploy.ts';
import { readSecrets } from './config/secrets.ts';
import { deploy, resolve } from './deploy.ts';
import { lifecycle } from './lifecycle.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';

/**
 * Keeps deployment configuration outside the app repository, with a source subdirectory inside its
 * Git root.
 */
const fixture = Effect.gen(function* () {
  const { path: root } = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-working-directory-'))),
    (directory) => Effect.promise(() => directory.remove()),
  );
  const directory = join(root, 'deployments/compose/foo');
  const repository = join(root, 'foo');
  const source = join(repository, 'app source');
  const file = join(directory, 'production.yaml');
  const hosts = join(root, 'hosts.yaml');
  yield* Effect.promise(async () => {
    await mkdir(directory, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(
      hosts,
      YAML.stringify({
        host: { ssh: 'fixture', platform: 'linux/arm64', transport: { mode: 'ssh-load' } },
      }),
    );
    await writeFile(join(directory, 'compose.yaml'), 'services: {web: {image: nginx}}');
    await writeFile(join(directory, 'asset.txt'), 'deployment asset');
    await writeFile(join(directory, 'secret.env'), 'TOKEN=deployment-secret');
  });

  const steps: Array<Step> = [];
  const gitCommands: Array<Command> = [];
  const gitState = { dirty: false };
  const shell = Layer.succeed(
    Shell,
    Shell.of({
      run: (step) =>
        Effect.sync(() => {
          steps.push(step);
        }),
      capture: (command) =>
        Effect.sync(() => {
          gitCommands.push(command);
          assert.strictEqual(command.program, 'git');
          return gitOutput(command.args.slice(2).join(' '), repository, gitState.dirty);
        }),
    }),
  );

  const services = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    shell,
    Git.layer.pipe(Layer.provide(shell)),
    Layer.succeed(
      Remote,
      Remote.of({
        run: () => Effect.die('No remote writes expected'),
        probe: () => Effect.die('No remote probes expected'),
      }),
    ),
  );

  const config: DeployConfig = {
    name: 'foo',
    host: 'host',
    targets: ['web'],
    composeFiles: ['compose.yaml'],
    workingDirectory: '../../../foo/app source',
    destinations: { development: { projectName: 'foo-dev' } },
  };
  const writeConfig = (changes: Partial<DeployConfig> = {}) =>
    Effect.promise(() => writeFile(file, YAML.stringify({ ...config, ...changes })));

  const options = {
    target: file,
    hosts: Option.some(hosts),
    local: true,
    dryRun: true,
    allowDirty: false,
    tag: Option.none<string>(),
    destination: 'development',
  };
  return {
    directory,
    repository,
    source,
    file,
    hosts,
    steps,
    gitCommands,
    gitState,
    services,
    writeConfig,
    options,
  };
});

/**
 * What the fake Git prints for the arguments after `-C <dir>`: the repository root, the porcelain
 * status (one changed file when `dirty`), and a fixed short commit for anything else.
 */
function gitOutput(args: string, repository: string, dirty: boolean): string {
  if (args === 'rev-parse --show-toplevel') {
    return repository;
  }

  if (args === 'status --porcelain') {
    return dirty ? ' M changed' : '';
  }

  return '123456789abc';
}

describe('separate working directory', () => {
  it.effect.each([undefined, './context'])(
    'uses the source Git checkout and build directory with context %s',
    (context) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.writeConfig({
          ...(context === undefined ? {} : { context }),
          dockerfile: 'docker/Dockerfile',
        });
        yield* deploy(f.options).pipe(Effect.provide(f.services));

        assert.deepStrictEqual(
          f.gitCommands.map((command) => command.args[1]),
          [f.source, f.repository, f.repository, f.repository],
        );
        assert.lengthOf(f.steps, 2);
        const [build, compose] = f.steps;
        assert.isDefined(build);
        assert.isDefined(compose);
        if (
          build === undefined ||
          compose === undefined ||
          !('program' in build) ||
          !('program' in compose)
        ) {
          return assert.fail('Expected a build and a Compose command');
        }

        assert.strictEqual(build.cwd, f.source);
        assert.include(build.args, join(f.source, 'docker/Dockerfile'));
        assert.strictEqual(
          build.args.at(-1),
          context === undefined ? f.repository : join(f.source, context),
        );
        assert.include(build.args, 'foo-web:123456789abc');
        assert.strictEqual(compose.cwd, f.directory);
        assert.include(compose.args, f.directory);
        assert.include(compose.args, join(f.directory, 'compose.yaml'));
        assert.include(compose.args, 'foo-dev');
      }).pipe(Effect.scoped, Effect.provideService(DryRun, true)),
  );

  it.effect('checks the source checkout for changes and uses its dirty image tag', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.gitState.dirty = true;
      yield* f.writeConfig();
      const error = yield* deploy({ ...f.options, local: false }).pipe(
        Effect.provide(f.services),
        Effect.flip,
      );
      assert.include(error.message, 'Commit your changes first');
      assert.lengthOf(f.steps, 0);

      yield* deploy(f.options).pipe(Effect.provide(f.services));
      const build = f.steps[0];
      assert.isTrue(
        build !== undefined &&
          'program' in build &&
          build.args.includes('foo-web:123456789abc-dirty'),
      );
      assert.isTrue(
        f.gitCommands
          .filter((command) => command.args.includes('status'))
          .every((command) => command.args[1] === f.repository),
      );
    }).pipe(Effect.scoped, Effect.provideService(DryRun, true)),
  );

  it.effect('keeps secrets and bundled files beside the selected configuration file', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.writeConfig({
        assets: ['asset.txt'],
        secrets: { 'env-file': { path: './secret.env' } },
      });
      const { app } = yield* resolve(f.file, Option.some(f.hosts), 'development');
      assert.strictEqual(app.file, f.file);
      assert.strictEqual(app.dir, f.directory);
      assert.strictEqual(workingDirectoryOf(app), f.source);
      assert.deepStrictEqual(yield* readSecrets(app, { local: false }), {
        TOKEN: 'deployment-secret',
      });
      const files = yield* readBundle(app);
      assert.deepStrictEqual(
        files.map((file) => file.path),
        ['compose.yaml', 'asset.txt'],
      );
      assert.strictEqual(Buffer.from(files[1]!.encoded, 'base64').toString(), 'deployment asset');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(['missing', 'asset.txt'])(
    'rejects a %s source directory before consulting Git or running commands',
    (path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.writeConfig({ workingDirectory: path });
        const error = yield* deploy(f.options).pipe(Effect.provide(f.services), Effect.flip);
        assert.strictEqual(error._tag, 'DeployError');
        assert.include(error.message.toLowerCase(), 'working directory');
        assert.include(error.message, join(f.directory, path));
        assert.lengthOf(f.gitCommands, 0);
        assert.lengthOf(f.steps, 0);
      }).pipe(Effect.scoped, Effect.provideService(DryRun, true)),
  );

  it.effect.each(['tag', 'third-party'] as const)(
    'allows %s deployments and lifecycle commands without the checkout',
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.writeConfig({
          workingDirectory: '/missing/app-checkout',
          ...(mode === 'third-party' ? { targets: [] } : {}),
        });
        yield* deploy({
          ...f.options,
          tag: mode === 'tag' ? Option.some('known') : Option.none(),
        }).pipe(Effect.provide(f.services));
        const resolved = yield* resolve(f.file, Option.some(f.hosts), 'development').pipe(
          Effect.provide(f.services),
        );
        yield* lifecycle(resolved, 'stop').pipe(Effect.provide(f.services));
        assert.lengthOf(f.gitCommands, 0);
        assert.lengthOf(f.steps, 2);
        assert.isTrue(f.steps.every((step) => 'program' in step && !step.args.includes('buildx')));
      }).pipe(Effect.scoped, Effect.provideService(DryRun, true)),
  );
});

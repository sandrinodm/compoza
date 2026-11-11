import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestConsole } from 'effect/testing';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import type { Step } from './command.ts';

import { deploy } from './deploy.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';

/**
 * Two Git repositories (`web-repo` and `worker-repo`) and a deploy folder, with Git and the shell
 * replaced by recorders.
 */
const fixture = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'compoza-roles-deploy-'))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  const deployDir = join(root, 'deploy');
  const webRepo = join(root, 'web-repo');
  const workerRepo = join(root, 'worker-repo');
  const hosts = join(root, 'hosts.yaml');
  yield* Effect.promise(async () => {
    for (const directory of [deployDir, webRepo, workerRepo]) {
      await mkdir(directory, { recursive: true });
    }

    await writeFile(
      hosts,
      YAML.stringify({
        host: { ssh: 'fixture', platform: 'linux/arm64', transport: { mode: 'ssh-load' } },
      }),
    );
    await writeFile(
      join(deployDir, 'compose.yaml'),
      'services: {web: {image: base}, worker: {image: base}, db: {image: postgres}}',
    );
  });

  const steps: Array<Step> = [];
  const overrides: Array<string> = [];
  const overrideFiles: Array<string> = [];
  const gitCalls: Array<string> = [];
  const dirty = new Set<string>();
  const shas: Record<string, string> = { [webRepo]: 'aaaaaaaaaaaa', [workerRepo]: 'bbbbbbbbbbbb' };
  const shell = Layer.succeed(
    Shell,
    Shell.of({
      run: (step) =>
        Effect.sync(() => {
          steps.push(step);
          if ('program' in step && step.args.includes('up')) {
            const file = step.args.filter((arg, index) => step.args[index - 1] === '--file').at(-1);
            if (file !== undefined && file.endsWith('compoza.roles.yaml') && existsSync(file)) {
              overrideFiles.push(file);
              overrides.push(readFileSync(file, 'utf8'));
            }
          }
        }),
      capture: () => Effect.die('Git is replaced'),
    }),
  );
  const git = Layer.succeed(
    Git,
    Git.of({
      root: (dir) =>
        Effect.sync(() => {
          gitCalls.push(`root ${dir}`);
          return dir.startsWith(workerRepo) ? workerRepo : webRepo;
        }),
      hasCommits: (repository) =>
        Effect.sync(() => {
          gitCalls.push(`hasCommits ${repository}`);
          return true;
        }),
      isDirty: (repository) =>
        Effect.sync(() => {
          gitCalls.push(`isDirty ${repository}`);
          return dirty.has(repository);
        }),
      shortSha: (repository) => Effect.succeed(shas[repository] ?? ''),
    }),
  );
  const services = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    shell,
    git,
    Layer.succeed(
      Remote,
      Remote.of({
        run: () => Effect.die('No remote writes expected'),
        probe: () => Effect.die('No remote probes expected'),
      }),
    ),
  );
  const write = (config: unknown) =>
    Effect.promise(() =>
      writeFile(
        join(deployDir, 'deploy.yaml'),
        YAML.stringify({
          name: 'demo',
          host: 'host',
          composeFiles: ['compose.yaml'],
          ...(config as object),
        }),
      ),
    );
  const options = {
    target: deployDir,
    hosts: Option.some(hosts),
    local: true,
    dryRun: false,
    allowDirty: false,
    tags: [] as ReadonlyArray<string>,
  };
  return {
    deployDir,
    webRepo,
    workerRepo,
    steps,
    overrides,
    overrideFiles,
    gitCalls,
    dirty,
    services,
    write,
    options,
  };
});

const roles = {
  web: { build: { target: 'server', workingDirectory: '../web-repo' }, secrets: [] },
  worker: {
    build: { workingDirectory: '../worker-repo', dockerfile: 'worker.Dockerfile' },
    environment: { MY_API_BASE_URL: 'https://api.example.com/v1', LOG_FORMAT: '$remote_addr' },
  },
  db: { environment: { POSTGRES_USER: 'demo' } },
};

describe('deploying roles', () => {
  it.effect('tags each role with the commit of its own repository and checks each once', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles });
      yield* deploy(f.options).pipe(Effect.provide(f.services));
      const lines = yield* TestConsole.logLines;

      const builds = f.steps.filter((step) => 'program' in step && step.args.includes('buildx'));
      assert.lengthOf(builds, 2);
      const [web, worker] = builds as ReadonlyArray<Extract<Step, { program: string }>>;
      assert.include(web!.args, 'demo-web:aaaaaaaaaaaa');
      assert.strictEqual(web!.cwd, f.webRepo);
      assert.strictEqual(web!.args.at(-1), f.webRepo);
      assert.include(worker!.args, 'demo-worker:bbbbbbbbbbbb');
      assert.include(worker!.args, join(f.workerRepo, 'worker.Dockerfile'));
      assert.notInclude(worker!.args, '--target');
      assert.strictEqual(worker!.cwd, f.workerRepo);
      assert.deepStrictEqual(
        f.gitCalls.filter((call) => call.startsWith('hasCommits')),
        [`hasCommits ${f.webRepo}`, `hasCommits ${f.workerRepo}`],
      );
      assert.strictEqual(
        lines[0],
        'Deploying demo web=aaaaaaaaaaaa worker=bbbbbbbbbbbb to local Docker',
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect('checks a repository shared by two roles once and shares its tag', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({
        workingDirectory: '../web-repo',
        roles: { web: { build: {} }, worker: { build: {} } },
      });
      yield* deploy(f.options).pipe(Effect.provide(f.services));
      const lines = yield* TestConsole.logLines;

      assert.lengthOf(
        f.gitCalls.filter((call) => call.startsWith('isDirty')),
        1,
      );
      assert.strictEqual(lines[0], 'Deploying demo aaaaaaaaaaaa to local Docker');
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect('refuses a dirty repository of any role unless allowed', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles });
      f.dirty.add(f.workerRepo);
      const error = yield* deploy({ ...f.options, local: false }).pipe(
        Effect.provide(f.services),
        Effect.flip,
      );
      assert.include(error.message, `Commit your changes in ${f.workerRepo} first`);
      assert.lengthOf(f.steps, 0);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer), Effect.provideService(DryRun, true)),
  );

  it.effect('writes the override as the last Compose file, then removes it', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles });
      yield* deploy(f.options).pipe(Effect.provide(f.services));

      assert.lengthOf(f.overrides, 1);
      assert.deepStrictEqual(YAML.parse(f.overrides[0]!), {
        services: {
          web: { image: 'demo-web:aaaaaaaaaaaa' },
          worker: {
            image: 'demo-worker:bbbbbbbbbbbb',
            environment: {
              MY_API_BASE_URL: 'https://api.example.com/v1',
              LOG_FORMAT: '$$remote_addr',
            },
          },
          db: { environment: { POSTGRES_USER: 'demo' } },
        },
      });
      assert.isFalse(existsSync(f.overrideFiles[0]!));
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect('reuses images with per-role tags without consulting Git', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles });
      yield* deploy({ ...f.options, tags: ['known', 'worker=older'] }).pipe(
        Effect.provide(f.services),
      );
      const lines = yield* TestConsole.logLines;

      assert.lengthOf(f.gitCalls, 0);
      assert.lengthOf(f.steps, 1);
      assert.lengthOf(f.overrides, 1);
      const parsed = YAML.parse(f.overrides[0]!);
      assert.strictEqual(parsed.services.web.image, 'demo-web:known');
      assert.strictEqual(parsed.services.worker.image, 'demo-worker:older');
      assert.strictEqual(lines[0], 'Deploying demo web=known worker=older to local Docker');
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    [['ghost=1'], 'Unknown role "ghost" in --tag'],
    [['db=1', 'x'], 'Role "db" has no build'],
    [['web=1'], 'No tag for role "worker"'],
    [['a', 'b'], 'Only one --tag without a role is allowed'],
  ] as const)('rejects --tag %j before building', ([tags, message]) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles });
      const error = yield* deploy({ ...f.options, tags }).pipe(
        Effect.provide(f.services),
        Effect.flip,
      );
      assert.include(error.message, message);
      assert.lengthOf(f.steps, 0);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect('builds nothing and uses the third-party tag without building roles', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles: { db: roles.db } });
      yield* deploy(f.options).pipe(Effect.provide(f.services));
      const lines = yield* TestConsole.logLines;

      assert.lengthOf(f.gitCalls, 0);
      assert.lengthOf(f.steps, 1);
      assert.lengthOf(f.overrides, 1);
      assert.strictEqual(lines[0], 'Deploying demo third-party to local Docker');
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect('fails before building when a role is not a Compose service', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles: { ...roles, wbe: { environment: { A: '1' } } } });
      const error = yield* deploy(f.options).pipe(Effect.provide(f.services), Effect.flip);
      assert.strictEqual(
        error.message,
        'Role "wbe" is not a service in the Compose files; services: web, worker, db',
      );
      assert.lengthOf(f.steps, 0);
      assert.lengthOf(f.gitCalls, 0);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect('prints the override on a dry run without writing it', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles });
      yield* deploy(f.options).pipe(Effect.provide(f.services));
      const lines = yield* TestConsole.logLines;

      assert.lengthOf(f.overrideFiles, 0);
      const printed = lines.find((line) => String(line).startsWith('Roles override '));
      assert.isDefined(printed);
      assert.include(String(printed), 'compoza.roles.yaml:');
      assert.include(String(printed), 'image: "demo-web:aaaaaaaaaaaa"');
      assert.include(String(printed), 'LOG_FORMAT: "$$remote_addr"');
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer), Effect.provideService(DryRun, true)),
  );

  it.effect('prints the override on an SSH dry run', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ roles, execution: 'ssh', remote: { stackDir: '/srv/demo' } });
      const remote = Remote.of({
        run: () => Effect.succeed(''),
        probe: () =>
          Effect.succeed('docker=yes\ncompose=yes\njq=yes\nstack_path=yes\nhost_overlay=yes\n'),
      });
      yield* deploy({ ...f.options, local: false, dryRun: true }).pipe(
        Effect.provideService(Remote, remote),
        Effect.provide(f.services),
      );
      const lines = yield* TestConsole.logLines;

      const printed = lines.find((line) => String(line).startsWith('Roles override '));
      assert.isDefined(printed);
      assert.include(String(printed), 'compoza.roles.yaml:');
      assert.include(String(printed), 'LOG_FORMAT: "$$remote_addr"');
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer), Effect.provideService(DryRun, true)),
  );
});

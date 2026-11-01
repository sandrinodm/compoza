import { assert, describe, it } from '@effect/vitest';
import { Deferred, Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestConsole } from 'effect/testing';

import { command } from '../command.ts';
import { DryRun, Shell } from './Shell.ts';

/**
 * How the fake spawner answers one program: its exit code and what it writes to standard output.
 */
interface Answer {
  /**
   * The exit code the program reports.
   */
  readonly code: number;

  /**
   * The standard output; empty when left out.
   */
  readonly stdout?: string;

  /**
   * Whether the program keeps running until it is killed, like a `docker save` whose reader has gone; it then reports
   * `code`.
   */
  readonly hangs?: boolean;
}

/**
 * A `Shell` over a spawner that runs nothing: every spawn is recorded in `spawned` by program name and answers from
 * `answers`, defaulting to a silent exit 0 for a program not listed. A program that `hangs` reports its code only once
 * killed, and `isRunning` is true until then.
 */
function fakeShell(spawned: Array<string>, answers: Readonly<Record<string, Answer>> = {}): Layer.Layer<Shell> {
  const spawner = ChildProcessSpawner.make((child) => {
    const program = ChildProcess.isStandardCommand(child) ? child.command : 'piped';
    spawned.push(program);

    const answer = answers[program] ?? { code: 0 };
    const exited = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>();
    const exit = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(answer.code));
    return Effect.as(
      answer.hangs === true ? Effect.void : exit,
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(spawned.length),
        exitCode: Deferred.await(exited),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: () => Effect.asVoid(exit),
        stdin: Sink.drain,
        stdout: answer.stdout === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(answer.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  return Shell.layer.pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
}

/**
 * The transport pipeline of an SSH deployment, short enough to read in an assertion.
 */
const transport = {
  stages: [command('docker', ['save', 'web:abc']), command('gzip', []), command('ssh', ['host', 'load'])],
};

describe('Shell.run', () => {
  it.effect('prints the line and spawns nothing under DryRun', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      yield* shell.run(command('docker', ['compose', 'up'], { env: { TOKEN: 'x' }, secret: ['TOKEN'] }));
      yield* shell.run(transport);

      assert.lengthOf(spawned, 0);
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        '$ TOKEN=*** docker compose up',
        '$ docker save web:abc | gzip | ssh host load',
      ]);
    }).pipe(Effect.provideService(DryRun, true), Effect.provide(Layer.merge(fakeShell(spawned), TestConsole.layer)));
  });

  it.effect('prints and runs an alwaysRun step even under DryRun', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      yield* shell.run(command('rsync', ['--dry-run', 'a/', 'host:b/']), { alwaysRun: true });

      assert.deepStrictEqual(spawned, ['rsync']);
      assert.deepStrictEqual(yield* TestConsole.logLines, ['$ rsync --dry-run a/ host:b/']);
    }).pipe(Effect.provideService(DryRun, true), Effect.provide(Layer.merge(fakeShell(spawned), TestConsole.layer)));
  });

  it.effect('fails naming the program when it exits non-zero', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      const error = yield* shell.run(command('docker', ['compose', 'up'])).pipe(Effect.flip);
      assert.strictEqual(error.message, 'docker exited with 2');
      assert.deepStrictEqual(spawned, ['docker']);
    }).pipe(Effect.provide(Layer.merge(fakeShell(spawned, { docker: { code: 2 } }), TestConsole.layer)));
  });

  it.effect('spawns every stage of a pipeline and succeeds when all exit zero', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      yield* shell.run(transport);

      assert.deepStrictEqual(spawned, ['docker', 'gzip', 'ssh']);
    }).pipe(Effect.provide(Layer.merge(fakeShell(spawned), TestConsole.layer)));
  });

  it.effect('names the first failing stage of a pipeline, not the last', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      const error = yield* shell.run(transport).pipe(Effect.flip);
      assert.strictEqual(error.message, 'docker exited with 1');
    }).pipe(
      Effect.provide(Layer.merge(fakeShell(spawned, { docker: { code: 1 }, ssh: { code: 1 } }), TestConsole.layer)),
    );
  });

  it.effect('blames the stage that exited, not the upstream stages it left without a reader', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      const error = yield* shell.run(transport).pipe(Effect.flip);
      assert.strictEqual(error.message, 'ssh exited with 255');
    }).pipe(
      Effect.provide(
        Layer.merge(
          fakeShell(spawned, {
            docker: { code: 143, hangs: true },
            gzip: { code: 143, hangs: true },
            ssh: { code: 255 },
          }),
          TestConsole.layer,
        ),
      ),
    );
  });

  it.effect('names a failing middle stage', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      const error = yield* shell.run(transport).pipe(Effect.flip);
      assert.strictEqual(error.message, 'gzip exited with 1');
    }).pipe(Effect.provide(Layer.merge(fakeShell(spawned, { gzip: { code: 1 } }), TestConsole.layer)));
  });
});

describe('Shell.capture', () => {
  it.effect('returns standard output, even under DryRun', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      const output = yield* shell.capture(command('git', ['status', '--porcelain']));
      assert.strictEqual(output, ' M src/plan.ts\n');
      assert.deepStrictEqual(spawned, ['git']);
      assert.deepStrictEqual(yield* TestConsole.logLines, []);
    }).pipe(
      Effect.provideService(DryRun, true),
      Effect.provide(
        Layer.merge(fakeShell(spawned, { git: { code: 0, stdout: ' M src/plan.ts\n' } }), TestConsole.layer),
      ),
    );
  });

  it.effect('fails naming the command when it exits non-zero', () => {
    const spawned: Array<string> = [];
    return Effect.gen(function* () {
      const shell = yield* Shell;
      const error = yield* shell.capture(command('git', ['rev-parse', 'HEAD'])).pipe(Effect.flip);
      assert.strictEqual(error.message, 'git rev-parse HEAD exited with 128');
    }).pipe(Effect.provide(Layer.merge(fakeShell(spawned, { git: { code: 128 } }), TestConsole.layer)));
  });
});

describe('secret-safe subprocess boundary', () => {
  it.effect(
    'suppresses all secret-bearing Compose stdout and stderr and strips provider auth from child environments',
    () => {
      const commands: Array<ChildProcess.StandardCommand> = [];
      const spawner = ChildProcessSpawner.make((child) => {
        assert.isTrue(ChildProcess.isStandardCommand(child));

        if (ChildProcess.isStandardCommand(child)) {
          commands.push(child);
        }

        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
      });
      return Effect.gen(function* () {
        const shell = yield* Shell;
        yield* shell.run(
          command('docker', ['compose', 'up'], {
            env: {
              TOKEN: 'SENTINEL_SECRET',
              OP_SERVICE_ACCOUNT_TOKEN: 'AUTH_SENTINEL',
              COMPOZA_1PASSWORD_ACCOUNT: 'operator',
            },
            secret: ['TOKEN', 'OP_SERVICE_ACCOUNT_TOKEN'],
            sensitive: true,
          }),
        );

        const child = commands[0]!;
        assert.strictEqual(child.options.stdout, 'ignore');
        assert.strictEqual(child.options.stderr, 'ignore');
        assert.isUndefined(child.options.env?.OP_SERVICE_ACCOUNT_TOKEN);
        assert.isUndefined(child.options.env?.COMPOZA_1PASSWORD_ACCOUNT);
        assert.strictEqual(child.options.env?.TOKEN, 'SENTINEL_SECRET');
        assert.notInclude((yield* TestConsole.logLines).join('\n'), 'SENTINEL');
      }).pipe(
        Effect.provide(
          Shell.layer.pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
        ),
        Effect.provide(TestConsole.layer),
      );
    },
  );
});

import type { PlatformError } from 'effect/PlatformError';

import { Console, Context, Effect, Layer, Result, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { type Command, isPipeline, printableStep, type Step } from '../command.ts';
import { DeployError, platformFailure } from '../errors.ts';
import { isCredentialEnvironment } from '../extensions/credentials.ts';

/**
 * Whether commands that change something are printed instead of run. `false` unless `--dry-run` sets it.
 *
 * Read-only commands (`git status`, probes over SSH) run either way, so a dry run still reports real readiness.
 */
export const DryRun = Context.Reference<boolean>('compoza/DryRun', { defaultValue: () => false });

/**
 * The environment a command runs with: this process's, plus the command's own variables.
 *
 * `DOCKER_CONTEXT` passes through. Docker commands aimed at a host carry `--host`, which selects the default context
 * with that endpoint and overrides `DOCKER_CONTEXT` (`DOCKER_CONTEXT=does-not-exist docker --host ssh://… version`
 * succeeds), so `--host` is what makes the explicit host win. Commands without a host (`deploy --local`, `buildx
 * --load`, `docker save`) then use a context chosen through the environment, as `docker` itself would.
 */
export function childEnvironment(command?: Command): Record<string, string | undefined> {
  const environment = { ...process.env, ...command?.env };
  for (const key of Object.keys(environment)) {
    if (isCredentialEnvironment(key)) {
      delete environment[key];
    }
  }
  return environment;
}

/**
 * The stdio wiring of a command.
 */
interface Stdio {
  /**
   * Where standard input comes from: this process's, nothing, or the output of the previous pipeline stage.
   */
  readonly stdin: 'inherit' | 'ignore' | Stream.Stream<Uint8Array, PlatformError>;

  /**
   * Where standard output goes.
   */
  readonly stdout: 'inherit' | 'pipe' | 'ignore';
}

/**
 * Turns a command description into a child process, normally inheriting standard error for useful diagnostics.
 *
 * Sensitive Compose commands discard both output streams because third-party messages can contain resolved secrets.
 */
function childProcess(command: Command, stdio: Stdio): ChildProcess.StandardCommand {
  return ChildProcess.make(command.program, [...command.args], {
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    env: childEnvironment(command),
    stdin: stdio.stdin,
    stdout: command.sensitive === true ? 'ignore' : stdio.stdout,
    stderr: command.sensitive === true ? 'ignore' : 'inherit',
  });
}

/**
 * What `collect` read from a process: its standard output and its exit code.
 */
export interface Collected {
  /**
   * The whole standard output, decoded as UTF-8.
   */
  readonly output: string;

  /**
   * The exit code, which may be non-zero: deciding what that means is the caller's job.
   */
  readonly code: number;
}

/**
 * Spawns `child` with standard output piped, reads all of it as text, then waits for the exit code, failing with a
 * `DeployError` that opens with `label` when the process cannot be spawned or awaited.
 *
 * A non-zero exit is returned rather than raised because `Shell.capture` and `Remote` word their errors differently,
 * and `Remote` prints the output first. The output is read before the exit is awaited, so a program that writes more
 * than a pipe buffers is never left blocked on a full pipe. The scope closes before this returns, so the process never
 * outlives the call.
 */
export function collect(
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
  child: ChildProcess.Command,
  label: string,
  stream = false,
): Effect.Effect<Collected, DeployError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(child);
      const decoded = Stream.decodeText(handle.stdout);
      const output = yield* stream
        ? decoded.pipe(
            Stream.runForEach((chunk) => Console.log(chunk.trimEnd())),
            Effect.as(''),
          )
        : Stream.mkString(decoded);
      const code = yield* handle.exitCode;
      return { output, code };
    }),
  ).pipe(Effect.mapError(platformFailure(label)));
}

/**
 * How `Shell.run` treats one step.
 */
export interface RunOptions {
  /**
   * Whether the step runs even under `DryRun`, for commands whose own dry-run flag is the preview, such as `rsync
   * --dry-run`; the `$ …` line is still printed.
   *
   * The caller then owes that flag whenever `DryRun` is set, or a dry run would change something. `false` when left
   * out.
   */
  readonly alwaysRun?: boolean;
}

/**
 * How long a pipeline stage stopped by `runPipeline` gets to exit after `SIGTERM` before it is sent `SIGKILL`.
 *
 * Five seconds is ample for `docker save` or `gzip` to exit; the bound only matters for a program that ignores
 * `SIGTERM`, which would otherwise keep the deployment waiting forever.
 */
const STOP_GRACE = '5 seconds';

/**
 * Runs pipeline stages connected stdout to stdin and fails with a `DeployError` naming the first stage, in pipeline
 * order, that exited non-zero, as `docker save exited with 1`.
 *
 * `ChildProcess.pipeTo` reports only the last stage's exit code, so a failing `docker save` showed up as a failing
 * `ssh`. Here each stage is spawned with the previous stage's `stdout` stream as its `stdin`, which is what `pipeTo`
 * does internally (the spawner forks a fiber in the scope that runs the stream into the child's input), and every
 * stage's exit code is awaited.
 *
 * When a stage exits, earlier stages still running have lost their reader and would block on a full pipe forever, so
 * they are stopped, as a shell's `SIGPIPE` would, and not blamed: when `ssh` fails to connect, the error names `ssh`,
 * not the `docker save` it cut off. A stage is only stopped if it is still running at that moment. The stages after a
 * stage see the end of their input only once it has closed its output, which it does by exiting, so a stage that failed
 * on its own has exited before a later one can and keeps its status.
 */
function runPipeline(
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
  stages: ReadonlyArray<Command>,
): Effect.Effect<void, DeployError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];
      for (const [index, stage] of stages.entries()) {
        const upstream = handles.at(-1);
        const stdio: Stdio = {
          stdin: upstream === undefined ? 'ignore' : upstream.stdout,
          stdout: index === stages.length - 1 ? 'inherit' : 'pipe',
        };
        handles.push(
          yield* spawner.spawn(childProcess(stage, stdio)).pipe(Effect.mapError(platformFailure(stage.program))),
        );
      }

      const stopped = new Set<number>();
      const stopUpstream = (index: number) =>
        Effect.forEach(
          handles.slice(0, index),
          (handle, upstream) =>
            Effect.gen(function* () {
              if (stopped.has(upstream) || !(yield* handle.isRunning)) {
                return;
              }
              stopped.add(upstream);
              yield* handle.kill({ forceKillAfter: STOP_GRACE });
            }).pipe(Effect.ignore),
          { concurrency: 'unbounded', discard: true },
        );

      const results = yield* Effect.forEach(
        handles,
        (handle, index) =>
          handle.exitCode.pipe(
            Effect.mapError(platformFailure(stages[index]?.program ?? 'pipeline')),
            Effect.result,
            Effect.tap(() => stopUpstream(index)),
          ),
        { concurrency: 'unbounded' },
      );

      for (const [index, result] of results.entries()) {
        if (stopped.has(index)) {
          continue;
        }
        if (Result.isFailure(result)) {
          return yield* result.failure;
        }
        if (result.success !== 0) {
          return yield* new DeployError({ message: `${stages[index]?.program} exited with ${result.success}` });
        }
      }
    }),
  );
}

/**
 * Runs programs on this machine: Docker, Git, rsync and ssh.
 *
 * Every command that changes something goes through `run`, which prints the command line first (secrets masked) and
 * does nothing else under `DryRun`; that is what makes `--dry-run` a faithful preview. The one exception, `alwaysRun`,
 * is for a program whose own dry-run flag previews better than a printed line can. `capture` is for reading state and
 * runs regardless. Both fail with a `DeployError` naming the program when it exits non-zero, so callers never check
 * exit codes themselves.
 */
export class Shell extends Context.Service<
  Shell,
  {
    /**
     * Prints the step, then runs it with this process's stdio unless `DryRun` is set and `options.alwaysRun` is not.
     * Fails when the program exits non-zero; for a pipeline, every stage's exit code is collected and the error names
     * the first stage that failed (see `runPipeline`).
     */
    run(step: Step, options?: RunOptions): Effect.Effect<void, DeployError>;

    /**
     * Runs the command and returns its standard output, always, even under `DryRun`. Fails when it exits non-zero.
     */
    capture(command: Command): Effect.Effect<string, DeployError>;
  }
>()('compoza/Shell') {
  /**
   * The service over the platform's process spawner.
   */
  static readonly layer: Layer.Layer<Shell, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
    Shell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn('Shell.run')(function* (step: Step, options: RunOptions = {}) {
        const line = printableStep(step);
        yield* Console.log(`$ ${line}`);
        if (options.alwaysRun !== true && (yield* DryRun)) {
          return;
        }
        if (isPipeline(step)) {
          return yield* runPipeline(spawner, step.stages);
        }
        const code = yield* spawner
          .exitCode(childProcess(step, { stdin: 'inherit', stdout: 'inherit' }))
          .pipe(
            Effect.mapError(
              step.sensitive === true
                ? () => new DeployError({ message: 'Secret-bearing Compose command could not run; details suppressed' })
                : platformFailure(line),
            ),
          );
        if (code !== 0) {
          return yield* new DeployError({ message: `${step.program} exited with ${code}` });
        }
      });

      const capture = Effect.fn('Shell.capture')(function* (command: Command) {
        const label = `${command.program} ${command.args.join(' ')}`;
        const { output, code } = yield* collect(
          spawner,
          childProcess(command, { stdin: 'ignore', stdout: 'pipe' }),
          label,
        );
        if (code !== 0) {
          return yield* new DeployError({ message: `${label} exited with ${code}` });
        }
        return output;
      });

      return Shell.of({ run, capture });
    }),
  );
}

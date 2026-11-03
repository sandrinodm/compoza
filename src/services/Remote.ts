import { Console, Context, Effect, Layer, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import type { HostConfig } from '../config/hosts.ts';

import { shellQuote } from '../command.ts';
import { DeployError } from '../errors.ts';
import { childEnvironment, collect, DryRun } from './Shell.ts';

/**
 * Shortens a script to the text printed after `$ ssh <host>` when `Remote.run` is given no label:
 * its first non-empty line, followed by ` …` when more lines follow.
 *
 * One-line scripts such as `mkdir -p …` print in full; longer ones usually open with `set -eu`,
 * which says nothing, so their callers pass a label instead.
 */
export function scriptLabel(script: string): string {
  const lines = script.split('\n').filter((line) => line.trim() !== '');
  const first = lines[0]?.trim() ?? '';
  return lines.length > 1 ? `${first} …` : first;
}

/**
 * Runs scripts on a Docker host over SSH.
 *
 * Every script runs under `bash -c` on the host, whatever the login shell there is: the hosts seen
 * so far log in with zsh, which does not word-split unquoted variables, and a script written for
 * bash silently misbehaves under it. `BatchMode=yes` makes a missing key an error instead of a
 * password prompt, so a deployment never hangs waiting for input nobody will type.
 *
 * Like `Shell`, the service has two members so that `--dry-run` stays a faithful preview: `run` is
 * for scripts that change the host, prints a `$ ssh …` line and does nothing else under `DryRun`;
 * `probe` is for read-only scripts and runs regardless, so a dry run still reports real readiness.
 * The cost is that the caller decides which a script is: a changing script sent through `probe`
 * would run during a dry run.
 *
 * Standard error is passed through to the terminal; standard output is returned, because the
 * scripts report with `key=value` lines that the caller parses.
 */
export class Remote extends Context.Service<
  Remote,
  {
    /**
     * Prints `$ ssh <host> <label>`, then runs `script` on `host` under `bash -c` unless `DryRun`
     * is set, feeding `input` to its standard input when given, and returns its standard output.
     *
     * Under `DryRun` nothing runs and the output is `''`. `label` defaults to the script's first
     * line (see `scriptLabel`). When the script exits non-zero its output is printed first, so a
     * failing step is never silent.
     */
    run(
      host: HostConfig,
      script: string,
      input?: string,
      label?: string,
      stream?: boolean,
    ): Effect.Effect<string, DeployError>;

    /**
     * Runs the read-only `script` on `host` under `bash -c`, always, even under `DryRun`, and
     * returns its standard output. Nothing is printed before it runs; a non-zero exit prints the
     * output and fails, as with `run`.
     */
    probe(host: HostConfig, script: string): Effect.Effect<string, DeployError>;
  }
>()('compoza/Remote') {
  /**
   * The service over the platform's process spawner, running the `ssh` on `PATH`.
   */
  static readonly layer: Layer.Layer<Remote, never, ChildProcessSpawner.ChildProcessSpawner> =
    Layer.effect(
      Remote,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const execute = Effect.fn('Remote.execute')(function* (
          host: HostConfig,
          script: string,
          input?: string,
          stream = false,
        ) {
          const ssh = ChildProcess.make(
            'ssh',
            ['-o', 'BatchMode=yes', host.ssh, `bash -c ${shellQuote(script)}`],
            {
              env: childEnvironment(),
              stdin: input === undefined ? 'ignore' : Stream.make(new TextEncoder().encode(input)),
              stdout: 'pipe',
              stderr: 'inherit',
            },
          );
          const { output, code } = yield* collect(spawner, ssh, `ssh ${host.ssh}`, stream).pipe(
            Effect.mapError(
              () =>
                new DeployError({
                  message: `ssh ${host.ssh} could not execute; subprocess details suppressed`,
                }),
            ),
          );
          if (code !== 0) {
            if (!stream && output !== '') {
              yield* Console.log(output);
            }

            return yield* new DeployError({ message: `ssh ${host.ssh} exited with ${code}` });
          }

          return output;
        });

        const run = Effect.fn('Remote.run')(function* (
          host: HostConfig,
          script: string,
          input?: string,
          label?: string,
          stream = false,
        ) {
          yield* Console.log(`$ ssh ${host.ssh} ${label ?? scriptLabel(script)}`);

          if (yield* DryRun) {
            return '';
          }

          const output = yield* execute(host, script, input, stream);
          return stream ? '' : output;
        });

        const probe = Effect.fn('Remote.probe')(function* (host: HostConfig, script: string) {
          return yield* execute(host, script);
        });

        return Remote.of({ run, probe });
      }),
    );
}

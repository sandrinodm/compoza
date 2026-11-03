import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Logger } from 'effect';
import { CliOutput, Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import packageJson from '../package.json' with { type: 'json' };
import { cli } from './cli.ts';
import { helpFormatter } from './help.ts';
import { humanLogger } from './progress.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { Shell } from './services/Shell.ts';

/**
 * The tool's services: the local shell, Git over it, and SSH to the hosts. The platform services
 * they need, and the HTTP client the post-deploy wait uses, are provided underneath.
 *
 * `humanLogger` replaces Effect's default logger, whose lines carry a timestamp and a fiber id,
 * with `[level] message` on standard error. The minimum level stays `Info` unless the global
 * `--log-level` flag lowers it: `Command.run` provides `References.MinimumLogLevel` to the handler
 * when the flag is given (`effect/cli` `Command.js`, "Apply built-in setting behavior"), so
 * `--log-level debug` shows the plan, the host scripts and the wait probes.
 *
 * `helpFormatter` renders `--help` and `compoza help`.
 */
const Services = Layer.mergeAll(
  Git.layer.pipe(Layer.provideMerge(Shell.layer)),
  Remote.layer,
  Logger.layer([humanLogger]),
  CliOutput.layer(helpFormatter()),
).pipe(Layer.provideMerge(FetchHttpClient.layer), Layer.provideMerge(NodeServices.layer));

/**
 * Runs the CLI with this process's arguments.
 *
 * A `DeployError` is a message for the person, so it is printed on its own with exit code 1 instead
 * of as an Effect cause with a fiber trace; anything else is a bug and keeps the full report.
 */
Command.run({ version: packageJson.version })(cli).pipe(
  Effect.catchTag('DeployError', (error) =>
    Console.error(error.message).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.provide(Services),
  NodeRuntime.runMain,
);

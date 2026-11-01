import { isCredentialEnvironment } from './extensions/credentials.ts';
/**
 * One process to run on this machine: a program, its arguments, and the variables added to the environment.
 *
 * This is a plain description, not an effect, so a deployment can be planned, printed by `--dry-run` and tested without
 * Docker. The `Shell` service turns it into a child process.
 */
export interface Command {
  /**
   * The program to run, looked up on `PATH`.
   */
  readonly program: string;

  /**
   * The arguments, one element each; no shell is involved, so nothing is quoted or expanded.
   */
  readonly args: ReadonlyArray<string>;

  /**
   * The working directory; defaults to the current one.
   */
  readonly cwd?: string;

  /**
   * Variables added to the inherited environment.
   */
  readonly env?: Readonly<Record<string, string>>;

  /**
   * Names of variables in `env` whose values are never printed.
   */
  readonly secret?: ReadonlyArray<string>;

  /**
   * The secret-bearing subprocess output suppression flag.
   *
   * Third-party diagnostics can repeat interpolation values, so Compose deployment output is discarded.
   */
  readonly sensitive?: boolean;

  /**
   * The concise display line when arguments contain an internal host script.
   *
   * This affects presentation only; the full argument list is still executed.
   */
  readonly label?: string;
}

/**
 * Commands connected stdout to stdin, like `a | b | c` in a shell; the last stage's output is the pipeline's.
 */
export interface Pipeline {
  /**
   * The stages in order; at least two, or it would be a `Command`.
   */
  readonly stages: ReadonlyArray<Command>;
}

/**
 * One step of a deployment plan.
 */
export type Step = Command | Pipeline;

/**
 * Whether a step is a pipeline rather than a single command.
 */
export function isPipeline(step: Step): step is Pipeline {
  return 'stages' in step;
}

/**
 * Builds a command from its program and arguments, for readable plans.
 */
export function command(
  program: string,
  args: ReadonlyArray<string>,
  options?: Omit<Command, 'program' | 'args'>,
): Command {
  return { program, args, ...options };
}

/**
 * The command as a person would type it, with secret values replaced by `***`.
 *
 * Arguments are printed as given, without shell quoting, so the line is easy to read rather than safe to paste;
 * `--dry-run` output is for reviewing a plan, not for replaying it.
 */
export function printable(command: Command): string {
  if (command.label !== undefined) {
    return command.label;
  }
  const env = Object.entries(command.env ?? {}).map(
    ([key, value]) => `${key}=${command.secret?.includes(key) || isCredentialEnvironment(key) ? '***' : value}`,
  );
  return [...env, command.program, ...command.args].join(' ');
}

/**
 * A step as a person would type it: a command, or its stages joined with ` | `.
 */
export function printableStep(step: Step): string {
  return isPipeline(step) ? step.stages.map(printable).join(' | ') : printable(step);
}

/**
 * Quotes a value for a POSIX shell with single quotes, the only quoting that needs no escaping other than of the quote
 * itself. Used for the scripts sent to a host, which run under `bash -c`.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The line that prepends the usual Docker install folders to `PATH`, put at the top of every script sent to a host.
 *
 * Non-interactive SSH sessions on macOS hosts do not load the profile that adds Homebrew and OrbStack, so `docker`
 * would otherwise be missing. The folders go before the inherited `PATH`, and a folder that does not exist on the host
 * is simply skipped by the shell.
 */
export const REMOTE_PATH = 'export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH';

/**
 * A script that creates the given host folders, for the bind mounts Compose expects to exist.
 */
export function mkdirScript(directories: ReadonlyArray<string>): string {
  return `mkdir -p ${directories.map(shellQuote).join(' ')}`;
}

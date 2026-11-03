import type { LogLevel } from 'effect/LogLevel';

import { Cause, Clock, Console, Effect, Exit, Formatter, Logger } from 'effect';

/**
 * Durations below this many tenths of a second (one minute) print with tenths; longer ones print in
 * whole minutes and seconds.
 */
const TENTHS_PER_MINUTE = 600;

/**
 * The last line of every dry run, printed in place of the summary of what was done.
 */
export const DRY_RUN_COMPLETE = 'Dry run complete.';

/**
 * One phase of a run: a key that names it in logs, the title printed for it, and the work, which
 * yields the word printed on its finish line.
 *
 * A run is an ordered list of these, decided before the first one starts, so the `[n/total]`
 * counter is honest from the first line and cannot drift from what actually runs: the list is the
 * only place that decides which phases there are. Build them with `phase`, which turns any effect
 * and its outcome into this shape.
 */
export interface Phase<E, R> {
  /**
   * A short name for the phase, e.g. `folders`, unique within a run; it appears in the debug log of
   * the plan.
   */
  readonly key: string;

  /**
   * What the phase does, as printed after its number, e.g. `Creating host folders`.
   */
  readonly title: string;

  /**
   * The work of the phase, yielding the outcome printed on its finish line, such as `ok` or `HTTP
   * 200`.
   */
  readonly run: Effect.Effect<string, E, R>;
}

/**
 * Formats a duration in milliseconds for a person: tenths of a second under a minute (`1.8 s`),
 * whole minutes and seconds from a minute on (`1 min 24 s`, `3 min`). Negative durations print as
 * `0.0 s`.
 *
 * Tenths are enough to tell a slow phase from a fast one; beyond a minute they are noise.
 */
export function formatDuration(millis: number): string {
  const tenths = Math.round(Math.max(0, millis) / 100);
  if (tenths < TENTHS_PER_MINUTE) {
    return `${(tenths / 10).toFixed(1)} s`;
  }

  const seconds = Math.round(tenths / 10);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * The start line of a phase, `[n/total] <title> …`; the finish line appends the outcome and
 * duration to it.
 */
export function phaseLine(number: number, total: number, title: string): string {
  return `[${number}/${total}] ${title} …`;
}

/**
 * Makes a phase from an effect, printing `outcome(value)` on its finish line, `ok` by default.
 *
 * The value itself is not kept: a caller that needs it, such as the HTTP status for a summary line,
 * reads it inside `effect` or `outcome`.
 */
export function phase<A, E, R>(
  key: string,
  title: string,
  effect: Effect.Effect<A, E, R>,
  outcome: (value: A) => string = () => 'ok',
): Phase<E, R> {
  return { key, title, run: Effect.map(effect, outcome) };
}

/**
 * Runs the phases in order and yields the milliseconds the whole run took. Each phase prints
 * `[n/total] <title> …` when it starts, then the same line followed by its outcome and elapsed
 * time, or by `failed` or `interrupted` before the failure propagates unchanged and the remaining
 * phases are skipped.
 *
 * Durations come from `Clock`, so tests drive them with `TestClock`; lines go through `Console`, so
 * they print at every log level and tests capture them with `TestConsole`.
 */
export function runPhases<E, R>(phases: ReadonlyArray<Phase<E, R>>): Effect.Effect<number, E, R> {
  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    yield* Effect.logDebug(`phases: ${phases.map((planned) => planned.key).join(', ')}`);

    for (const [index, planned] of phases.entries()) {
      const line = phaseLine(index + 1, phases.length, planned.title);
      yield* Console.log(line);

      const start = yield* Clock.currentTimeMillis;
      yield* Effect.onExit(planned.run, (exit) =>
        Effect.gen(function* () {
          const duration = formatDuration((yield* Clock.currentTimeMillis) - start);
          yield* Console.log(`${line} ${finishWord(exit)} (${duration})`);
        }),
      );
    }

    return (yield* Clock.currentTimeMillis) - started;
  });
}

/**
 * The word on a phase's finish line: the phase's own outcome when it succeeded, `interrupted` when
 * it was only interrupted, and `failed` for any other failure.
 */
function finishWord(exit: Exit.Exit<string, unknown>): string {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  return Cause.hasInterruptsOnly(exit.cause) ? 'interrupted' : 'failed';
}

/**
 * Formats one log event as `[level] message`, the level in lower case so it reads as a note beside
 * the progress lines, continuation lines indented by two spaces, and the cause's pretty report
 * appended when there is one.
 *
 * Multi-line messages are the norm here (scripts, site files), so continuation lines are indented
 * to stay visibly part of their entry. Strings print as is and other values through
 * `Formatter.format`. Timestamps and fiber ids are left out on purpose: the reader is a person
 * following one deploy, not a log aggregator.
 */
export function formatLogLine(
  logLevel: LogLevel,
  message: unknown,
  cause: Cause.Cause<unknown>,
): string {
  const parts = (Array.isArray(message) ? message : [message]).map((part: unknown) =>
    typeof part === 'string' ? part : Formatter.format(part),
  );

  if (cause.reasons.length > 0) {
    parts.push(Cause.pretty(cause));
  }

  return `[${logLevel.toLowerCase()}] ${parts.join(' ')}`.replaceAll('\n', '\n  ');
}

/**
 * The logger for the CLI: `formatLogLine` written to standard error through the fiber's `Console`.
 *
 * Standard error keeps detail out of standard output, so `check --json` stays parseable at any log
 * level, while the progress lines on standard output stay readable on their own.
 */
export const humanLogger = Logger.withConsoleError(
  Logger.make(({ logLevel, message, cause }) => formatLogLine(logLevel, message, cause)),
);

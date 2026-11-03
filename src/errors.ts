import type { PlatformError } from 'effect/PlatformError';

import { Effect, Schema } from 'effect';

/**
 * A deployment that cannot proceed: a configuration problem, a failed readiness check, a repository
 * that is not ready to be tagged, or a command on this machine or on the host that exited with an
 * error.
 *
 * The message is written for the person running the tool and is printed as is, without a stack
 * trace: every cause is something they fix by hand (a file, a DNS record, a login on the host), so
 * the stack adds nothing.
 */
export class DeployError extends Schema.TaggedError<DeployError>()('DeployError', {
  /**
   * What went wrong, in one or two sentences, naming the file, check or command involved.
   */
  message: Schema.String,
}) {}

/**
 * Turns a platform failure (a process that could not be spawned, a file that could not be read)
 * into a `DeployError` that names what was being attempted.
 */
export function platformFailure(attempt: string): (cause: PlatformError) => DeployError {
  return (cause) => new DeployError({ message: `${attempt}: ${cause.message}` });
}

/**
 * Runs a synchronous planning function that reports invalid configuration by throwing, and fails
 * with a `DeployError` carrying the thrown error's message, or `fallback` when the thrown value is
 * not an `Error`.
 *
 * Planners throw plain errors so they stay usable outside Effect; wrapping every call made from
 * Effect code keeps a bad configuration a printed message instead of an unexpected defect.
 */
export function tryPlan<A>(plan: () => A, fallback: string): Effect.Effect<A, DeployError> {
  return Effect.try({
    try: plan,
    catch: (cause) =>
      new DeployError({ message: cause instanceof Error ? cause.message : fallback }),
  });
}

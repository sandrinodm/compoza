import { Clock, Console, Effect } from 'effect';
import { HttpClient } from 'effect/http';

import { DeployError } from './errors.ts';
import { formatDuration } from './progress.ts';

/**
 * How long a deploy waits for the public URL to answer, in milliseconds: certificate issuance
 * through a DNS challenge and a first container start both take a while, but three minutes of
 * silence means something is wrong.
 */
export const WAIT_TIMEOUT_MILLIS = 3 * 60_000;

/**
 * How long one probe may take, in milliseconds.
 */
const PROBE_TIMEOUT_MILLIS = 10_000;

/**
 * How long to wait between probes, in milliseconds.
 */
const PROBE_INTERVAL_MILLIS = 5_000;

/**
 * The least time between two `still waiting` lines, in milliseconds.
 *
 * Probes come every 5 to 15 s; one line per probe would bury the rest of the output during a slow
 * certificate issuance, while 15 s keeps the wait visibly alive.
 */
const NOTICE_INTERVAL_MILLIS = 15_000;

/**
 * Probes `url` once and returns its status, or `undefined` when it does not answer within the probe
 * timeout.
 *
 * Each outcome is logged at debug level, connection errors with their message, so `--log-level
 * debug` shows why a URL is not up yet without changing the default output.
 */
function probe(url: string): Effect.Effect<number | undefined, never, HttpClient.HttpClient> {
  return HttpClient.get(url).pipe(
    Effect.map((response): number | undefined => response.status),
    Effect.timeout(PROBE_TIMEOUT_MILLIS),
    Effect.tap((status) => Effect.logDebug(`probe ${url}: HTTP ${status}`)),
    Effect.catch((error) =>
      Effect.as(Effect.logDebug(`probe ${url}: ${error.message}`), undefined),
    ),
  );
}

/**
 * Probes `url` until it answers with a status below 500 or the deadline passes, returning the
 * status.
 *
 * Redirects and client errors count as up: the question is whether the route reaches a running
 * container, not whether the path is public. Connection errors and timeouts are retried, because
 * they are expected while Caddy obtains a certificate; at most every 15 s a `still waiting` line
 * with the elapsed time and the last status seen shows that the wait is alive. Time comes from
 * `Clock`, so tests can drive it with `TestClock`.
 */
export const waitForUrl = Effect.fn('waitForUrl')(function* (
  url: string,
  timeoutMillis: number,
): Effect.fn.Return<number, DeployError, HttpClient.HttpClient> {
  const start = yield* Clock.currentTimeMillis;
  const deadline = start + timeoutMillis;
  let noticed = start;
  let last: number | undefined;

  while ((yield* Clock.currentTimeMillis) < deadline) {
    const status = yield* probe(url);
    if (status !== undefined) {
      last = status;
      if (status < 500) {
        return status;
      }
    }

    const now = yield* Clock.currentTimeMillis;
    if (now - noticed >= NOTICE_INTERVAL_MILLIS) {
      noticed = now;
      yield* Console.log(
        `   … still waiting (${formatDuration(now - start)}, last status ${last ?? 'none'})`,
      );
    }

    yield* Effect.sleep(PROBE_INTERVAL_MILLIS);
  }

  return yield* new DeployError({
    message:
      `${url} did not respond successfully within ${timeoutMillis / 1000} s ` +
      `(last status ${last ?? 'none'})`,
  });
});

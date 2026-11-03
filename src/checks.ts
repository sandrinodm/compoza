import { Effect } from 'effect';
import { Resolver } from 'node:dns/promises';

import type { App } from './config/deploy.ts';

import { type HostConfig, registryOf } from './config/hosts.ts';
import { DeployError } from './errors.ts';
import { ingressFor } from './extensions/ingress.ts';
import { parseCheck, registryProbe } from './probe.ts';
import { Remote } from './services/Remote.ts';
import { sshReadinessScript } from './ssh-plan.ts';

/**
 * The outcome of one readiness check. `fix` names who resolves a failure: a DNS record only the
 * person can add, the one-time `setup-proxy` command, the deploy itself, or something to do by hand
 * on the host.
 */
export interface Check {
  /**
   * The short name printed before the detail: `dns`, `proxy`, `network`, `route` or `registry`.
   */
  readonly name: string;

  /**
   * Whether the check passed.
   */
  readonly ok: boolean;

  /**
   * One line saying what was found, and what is expected when it failed.
   */
  readonly detail: string;

  /**
   * Who resolves a failure.
   */
  readonly fix: 'dns' | 'setup-proxy' | 'deploy' | 'manual';
}

/**
 * The public resolvers asked for the app domain, so the answer is what the internet sees rather
 * than what a local resolver or hosts file says.
 */
const PUBLIC_RESOLVERS = ['1.1.1.1', '1.0.0.1'];

/**
 * How long one DNS query may take, in milliseconds, before the check reports no record.
 */
const DNS_TIMEOUT_MILLIS = 3_000;

/**
 * Resolves both IP families through public resolvers; one missing family does not discard the other
 * answer.
 */
export function lookup(domain: string): Effect.Effect<ReadonlyArray<string>> {
  return Effect.tryPromise({
    try: async () => {
      const resolver = new Resolver({ timeout: DNS_TIMEOUT_MILLIS, tries: 2 });
      resolver.setServers(PUBLIC_RESOLVERS);

      const answers = await Promise.allSettled([
        resolver.resolve4(domain),
        resolver.resolve6(domain),
      ]);
      return answers.flatMap((answer) => (answer.status === 'fulfilled' ? answer.value : []));
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
}

/**
 * Interprets a DNS answer and a host probe as checks for the app on the host.
 *
 * The selected ingress extension interprets its own probe keys; the Docker core adds registry
 * readiness independently. Extensions report missing host configuration as blocking checks and mark
 * deployment-repairable checks explicitly.
 */
export function evaluateChecks(
  app: App,
  host: HostConfig,
  addresses: ReadonlyArray<string>,
  probe: Record<string, string>,
): ReadonlyArray<Check> {
  const checks: Array<Check> = [...(ingressFor(app)?.checks(app, host, addresses, probe) ?? [])];
  const registry = app.config.targets.length === 0 ? undefined : registryOf(host);
  if (registry !== undefined) {
    const loggedIn = probe.registry_login === 'yes';
    checks.push({
      name: 'registry',
      ok: loggedIn,
      detail:
        probe.registry_login === undefined
          ? `stored login for ${registry} was not probed`
          : loggedIn
            ? `host is logged in to ${registry}`
            : `host has no stored login for ${registry}; run docker login there`,
      fix: 'manual',
    });
  }

  return checks;
}

/**
 * The checks that must pass before deploying. Checks repaired by deployment itself do not block,
 * regardless of the extension that produced them.
 */
export function blocking(checks: ReadonlyArray<Check>): ReadonlyArray<Check> {
  return checks.filter((check) => !check.ok && check.fix !== 'deploy');
}

/**
 * The checks as lines for the terminal, `ok` or `FAIL` first.
 */
export function formatChecks(checks: ReadonlyArray<Check>): string {
  return checks
    .map((check) => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`)
    .join('\n');
}

/**
 * Runs the readiness checks for an app on its host: the DNS lookup and the host probe concurrently,
 * then `evaluateChecks`. Nothing on the host is changed.
 *
 * Extensions supply an optional domain and read-only probe. Registry readiness remains independent
 * of ingress, and no SSH probe runs when neither integration needs one.
 */
export const runChecks = Effect.fn('runChecks')(function* (app: App, host: HostConfig) {
  const remote = yield* Remote;
  const ingress = ingressFor(app);
  const domain = ingress?.domain(app, host);
  const registry = app.config.targets.length === 0 ? undefined : registryOf(host);
  const scripts = [
    ingress?.probe(app, host),
    registry === undefined ? undefined : registryProbe(registry),
  ].filter((script): script is string => script !== undefined);
  const [addresses, output] = yield* Effect.all(
    [
      domain === undefined ? Effect.succeed([] as ReadonlyArray<string>) : lookup(domain),
      scripts.length === 0 ? Effect.succeed('') : remote.probe(host, scripts.join('\n')),
    ],
    { concurrency: 'unbounded' },
  );
  const checks = [...evaluateChecks(app, host, addresses, parseCheck(output))];

  if (app.config.execution === 'ssh') {
    const script = yield* Effect.try({
      try: () => sshReadinessScript(app, host),
      catch: (cause) =>
        new DeployError({
          message: cause instanceof Error ? cause.message : 'Invalid SSH configuration',
        }),
    });
    const readiness = parseCheck(yield* remote.probe(host, script));

    for (const [name, value] of Object.entries(readiness)) {
      checks.push({
        name,
        ok: value === 'yes',
        detail:
          value === 'yes'
            ? `${name} ready for SSH execution`
            : `${name} unavailable; check host Docker/Compose, Bash 3.2+, jq 1.6+, paths and optional curl/Buildx`,
        fix: 'manual',
      });
    }
  }

  return checks;
});

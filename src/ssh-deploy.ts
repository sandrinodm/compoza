import { Console, Effect } from 'effect';
import { randomUUID } from 'node:crypto';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';
import type { DeployOptions } from './deploy.ts';

import { readBundle } from './bundle.ts';
import { blocking, formatChecks, runChecks } from './checks.ts';
import { command, shellQuote } from './command.ts';
import { readSecrets, secretSource } from './config/secrets.ts';
import { DeployError } from './errors.ts';
import { planDeployment } from './plan.ts';
import { phase, runPhases } from './progress.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { deployedScript, deploymentScript, rollbackScript } from './ssh-plan.ts';

/**
 * Converts pure planning failures into concise user-facing deployment errors.
 *
 * No candidate configuration or secret-bearing resolved model is included in these messages.
 */
function planned<A>(build: () => A): Effect.Effect<A, DeployError> {
  return Effect.try({
    try: build,
    catch: (cause) =>
      new DeployError({ message: cause instanceof Error ? cause.message : 'Invalid SSH deployment plan' }),
  });
}

/**
 * Deploys a bounded Compose release and executes Compose through the host's own CLI.
 *
 * BuildKit transfers sources independently of the release bundle; managed providers resolve on this machine, while
 * legacy host dotenv stays on the host. Readiness and planning precede builds, and dry runs do not stage releases,
 * acquire locks or build images.
 */
export const deploySsh = Effect.fn('deploySsh')(function* (
  app: App,
  host: HostConfig,
  options: DeployOptions,
  source: { readonly tag: string; readonly context: string },
) {
  const shell = yield* Shell;
  const remote = yield* Remote;
  const bundle = yield* readBundle(app);
  const id = `${source.tag}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const values = yield* readSecrets(app);
  const sourceConfig = yield* planned(() => secretSource(app));
  const managed = sourceConfig !== undefined && sourceConfig.provider !== 'none';
  const deployment = yield* planned(() =>
    deploymentScript(app, host, source.tag, id, bundle, managed ? values : undefined),
  );
  const builds = planDeployment({
    app,
    host,
    tag: source.tag,
    context: source.context,
    local: false,
    reuseImages: options.tag._tag === 'Some',
    secrets: {},
  }).slice(0, -1);
  yield* Console.log(`Deploying ${app.config.name} ${source.tag} to ${app.config.host} over SSH; release ${id}`);
  yield* runPhases([
    phase(
      'checks',
      'Checking SSH host readiness',
      Effect.gen(function* () {
        const checks = yield* runChecks(app, host);
        yield* Console.log(formatChecks(checks));
        if (blocking(checks).length > 0) {
          return yield* new DeployError({ message: 'Host is not ready for SSH deployment; see check details' });
        }
      }),
    ),
    ...(builds.length === 0
      ? []
      : [
          phase(
            'build',
            `Building and shipping ${app.config.targets.length} images (${host.transport.mode})`,
            Effect.forEach(builds, (step) => shell.run(step), { discard: true }),
          ),
        ]),
    phase(
      'compose',
      'Staging, validating and health-gating the host release',
      remote
        .run(
          host,
          deployment.script,
          deployment.input,
          `<stage ${bundle.length} declared files; lock, validate, compose up --wait, route, health, promote ${id}>`,
          true,
        )
        .pipe(Effect.flatMap((output) => (output === '' ? Effect.void : Console.log(output.trimEnd())))),
    ),
  ]);
  yield* Console.log(
    (yield* DryRun)
      ? 'Dry run complete. No host writes, locks, builds or staging. Candidate config cannot be fully validated remotely until staged with the host env and overlay.'
      : `Deployed ${app.config.name} ${source.tag} to ${app.config.host}; release ${id}. Previous successful release retained.`,
  );
});

/**
 * Streams deployed stack inspection through SSH, including follow-mode logs.
 *
 * The shell inherits stdout, so logs appear immediately and are not buffered until SSH exits. Inspection reads only the
 * host current release, ignoring local Compose edits and production dotenv contents.
 */
export const inspectSsh = Effect.fn('inspectSsh')(function* (app: App, host: HostConfig, args: ReadonlyArray<string>) {
  const shell = yield* Shell;
  const script = yield* planned(() => deployedScript(app, args, false));
  yield* shell.run(
    command('ssh', ['-o', 'BatchMode=yes', host.ssh, `bash -c ${shellQuote(script)}`], {
      label: `ssh ${host.ssh} <${args[0]} deployed release>`,
    }),
  );
});

/**
 * Activates a successful release, resolving the default predecessor under the host mutation lock.
 *
 * Dry runs never acquire a lock; named IDs are path-validated locally. Supported releases use the active managed
 * snapshot or legacy host dotenv and live overlay. Migrations and partial Compose changes are never described as atomic
 * or reversed.
 */
export const rollbackSsh = Effect.fn('rollbackSsh')(function* (app: App, host: HostConfig, selected?: string) {
  if (app.config.execution !== 'ssh') {
    return yield* new DeployError({
      message: 'Release rollback requires execution: ssh; client execution supports image reuse with deploy --tag',
    });
  }
  const remote = yield* Remote;
  const script = yield* planned(() => rollbackScript(app, selected));
  const label = selected ?? 'previous successful release';
  const output = yield* remote.run(
    host,
    script,
    undefined,
    `<rollback to release ${label}; validate, up --wait, health, promote>`,
    true,
  );
  if (output !== '') {
    yield* Console.log(output.trimEnd());
  }
  yield* Console.log(
    (yield* DryRun)
      ? 'Dry run complete; no writes or locks.'
      : `${selected === undefined ? 'Restored previous successful release' : `Restored release ${selected}`}; host secrets, overlays and data were retained.`,
  );
});

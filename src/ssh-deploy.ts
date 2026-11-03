import { Console, Effect, type FileSystem, type Path } from 'effect';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';
import type { DeployOptions } from './deploy.ts';

import { readBundle } from './bundle.ts';
import { blocking, formatChecks, runChecks } from './checks.ts';
import { command, shellQuote } from './command.ts';
import { readSecrets, selectSecretSource } from './config/secrets.ts';
import { DeployError, tryPlan } from './errors.ts';
import { planDeployment } from './plan.ts';
import { DRY_RUN_COMPLETE, phase, runPhases } from './progress.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { deployedScript, deploymentScript } from './ssh-plan.ts';

/**
 * What the host stack transaction does after staging the bundle, shown in its progress label.
 */
const STACK_UPDATE_SUMMARY = 'lock, validate, compose up --wait, route, health';

/**
 * The closing message of a dry run, which stops before anything reaches the host.
 */
const SSH_DRY_RUN_SUMMARY =
  `${DRY_RUN_COMPLETE} No host writes, locks, builds or staging. ` +
  'Candidate config cannot be fully validated remotely until staged with the host env and overlay.';

/**
 * Converts pure planning failures into concise user-facing deployment errors.
 *
 * No candidate configuration or secret-bearing resolved model is included in these messages.
 */
function planned<A>(build: () => A): Effect.Effect<A, DeployError> {
  return tryPlan(build, 'Invalid SSH deployment plan');
}

/**
 * Deploys a bounded Compose stack and executes Compose through the host's own CLI.
 *
 * BuildKit transfers sources independently of the stack bundle; managed providers resolve on this
 * machine, while legacy host dotenv stays on the host. Readiness and planning precede builds, and
 * dry runs do not stage stack files, acquire locks or build images.
 */
export const deploySsh = Effect.fn('deploySsh')(function* (
  app: App,
  host: HostConfig,
  options: DeployOptions,
  source: { readonly tag: string; readonly context: string },
): Effect.fn.Return<void, DeployError, FileSystem.FileSystem | Path.Path | Remote | Shell> {
  const shell = yield* Shell;
  const remote = yield* Remote;

  const bundle = yield* readBundle(app);

  const values = yield* readSecrets(app);
  const sourceConfig = yield* Effect.fromResult(selectSecretSource(app));
  const managed = sourceConfig !== undefined && sourceConfig.provider !== 'none';

  const deployment = yield* planned(() =>
    deploymentScript(app, host, source.tag, bundle, managed ? values : undefined),
  );

  // The plan's last step is the local Compose command; over SSH the host runs Compose itself.
  const plan = yield* planned(() =>
    planDeployment({
      app,
      host,
      tag: source.tag,
      context: source.context,
      local: false,
      reuseImages: options.tag._tag === 'Some',
      secrets: {},
    }),
  );
  const builds = plan.slice(0, -1);

  const readiness = phase(
    'checks',
    'Checking SSH host readiness',
    Effect.gen(function* () {
      const checks = yield* runChecks(app, host);
      yield* Console.log(formatChecks(checks));

      if (blocking(checks).length > 0) {
        return yield* new DeployError({
          message: 'Host is not ready for SSH deployment; see check details',
        });
      }
    }),
  );

  const build = phase(
    'build',
    `Building and shipping ${app.config.targets.length} images (${host.transport.mode})`,
    Effect.forEach(builds, (step) => shell.run(step), { discard: true }),
  );

  const stackUpdate = remote
    .run(host, deployment.script, {
      input: deployment.input,
      label: `<stage ${bundle.length} declared files; ${STACK_UPDATE_SUMMARY}>`,
      stream: true,
    })
    .pipe(
      Effect.flatMap((output) => (output === '' ? Effect.void : Console.log(output.trimEnd()))),
    );

  yield* Console.log(`Deploying ${app.config.name} ${source.tag} to ${app.config.host} over SSH`);
  yield* runPhases([
    readiness,
    ...(builds.length === 0 ? [] : [build]),
    phase('compose', 'Staging, validating and updating the host stack', stackUpdate),
  ]);

  yield* Console.log(
    (yield* DryRun)
      ? SSH_DRY_RUN_SUMMARY
      : `Deployed ${app.config.name} ${source.tag} to ${app.config.host}; stack folder updated.`,
  );
});

/**
 * Streams deployed stack inspection through SSH, including follow-mode logs.
 *
 * The shell inherits stdout, so logs appear immediately and are not buffered until SSH exits.
 * Inspection reads only the deployed host configuration, ignoring local Compose edits and
 * production dotenv contents.
 */
export const inspectSsh = Effect.fn('inspectSsh')(function* (
  app: App,
  host: HostConfig,
  args: ReadonlyArray<string>,
): Effect.fn.Return<void, DeployError, Shell> {
  const shell = yield* Shell;
  const script = yield* planned(() => deployedScript(app, args, false));
  yield* shell.run(
    command('ssh', ['-o', 'BatchMode=yes', host.ssh, `bash -c ${shellQuote(script)}`], {
      label: `ssh ${host.ssh} <${args[0]} deployed stack>`,
    }),
  );
});

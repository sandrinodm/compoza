import type { HttpClient } from 'effect/http';

import { Console, Effect, FileSystem, type Option, Path } from 'effect';

import type { Step } from './command.ts';
import type { IngressPlan } from './extensions/ingress.ts';
import type { Phase } from './progress.ts';

import { blocking, formatChecks, runChecks } from './checks.ts';
import { mkdirScript, printableStep } from './command.ts';
import {
  type App,
  directoriesOf,
  loadApp,
  selectDestination,
  workingDirectoryOf,
} from './config/deploy.ts';
import { dockerHost, type HostConfig, hostFor, loadHostsForRun } from './config/hosts.ts';
import { readSecrets } from './config/secrets.ts';
import { DeployError } from './errors.ts';
import { loadAppExtensionFiles } from './extensions/config.ts';
import { ingressFor } from './extensions/ingress.ts';
import { planDeployment } from './plan.ts';
import { DRY_RUN_COMPLETE, formatDuration, phase, runPhases } from './progress.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { deploySsh } from './ssh-deploy.ts';
import { WAIT_TIMEOUT_MILLIS, waitForUrl } from './wait.ts';

/**
 * The tag of a deploy without targets: nothing is built, so there is no commit to name the images
 * after.
 */
const THIRD_PARTY_TAG = 'third-party';

/**
 * The message of a failed ingress plan when the extension throws something other than an `Error`.
 */
const INVALID_INGRESS_MESSAGE = 'Invalid ingress configuration';

/**
 * What the `deploy` command was asked to do.
 */
export interface DeployOptions {
  /**
   * The deploy folder, or its `deploy.yaml`.
   */
  readonly target: string;

  /**
   * Print every command instead of running it. Read-only checks still run.
   */
  readonly dryRun: boolean;

  /**
   * Build into this machine's Docker and start the stack here, without checks, transport or
   * routing.
   */
  readonly local: boolean;

  /**
   * Deploy a checkout with uncommitted changes, tagging images `<commit>-dirty`.
   */
  readonly allowDirty: boolean;

  /**
   * Reuse images already built under this tag instead of building: a rollback to an earlier deploy.
   */
  readonly tag: Option.Option<string>;

  /**
   * The hosts file, when not the default.
   */
  readonly hosts: Option.Option<string>;

  /**
   * The named deployment selection; omission preserves the app defaults.
   */
  readonly destination?: string | undefined;
}

/**
 * An app with the host it deploys to, as every command starts by resolving.
 */
export interface Resolved {
  /**
   * The app.
   */
  readonly app: App;

  /**
   * Its host.
   */
  readonly host: HostConfig;
}

/**
 * Runs a synchronous planning function that reports invalid configuration by throwing, and fails
 * with a `DeployError` carrying the thrown error's message, or `fallback` when the thrown value is
 * not an `Error`.
 */
export function tryPlan<A>(plan: () => A, fallback: string): Effect.Effect<A, DeployError> {
  return Effect.try({
    try: plan,
    catch: (cause) =>
      new DeployError({ message: cause instanceof Error ? cause.message : fallback }),
  });
}

/**
 * `tryPlan` for an ingress extension's `plan` or `setup`, failing with `Invalid ingress
 * configuration` when the extension throws something other than an `Error`.
 */
export function tryIngressPlan<A>(plan: () => A): Effect.Effect<A, DeployError> {
  return tryPlan(plan, INVALID_INGRESS_MESSAGE);
}

/**
 * Reads the app's `deploy.yaml` and the hosts file, and pairs the app with its host.
 */
export const resolve = Effect.fn('resolve')(function* (
  target: string,
  hosts: Option.Option<string>,
  destination?: string,
) {
  const loaded = yield* loadApp(target);
  const selected = yield* tryPlan(
    () => selectDestination(loaded, destination),
    'Invalid destination',
  );
  const app = yield* loadAppExtensionFiles(selected);
  const host = yield* hostFor(app.config, yield* loadHostsForRun(hosts));
  const resolved: Resolved = { app, host };
  return resolved;
});

/**
 * The image tag of a deploy and the build context its images are built from.
 */
interface Source {
  /**
   * The tag the images are built and run under.
   */
  readonly tag: string;

  /**
   * The absolute build context: `context` from `deploy.yaml` resolved against the working
   * directory, else the Git root. With `--tag` nothing is built, so it falls back to the working
   * directory instead and is never read.
   */
  readonly context: string;
}

/**
 * Chooses the image tag and build context: the commit, `-dirty` when the checkout has changes, or
 * the tag given to reuse.
 *
 * A repository without commits cannot be deployed, because there is nothing to tag images with; a
 * dirty checkout is refused unless `--allow-dirty` or `--local`, so that a tag always names the
 * exact source it was built from. With `--tag` Git is not consulted at all: a rollback reuses
 * images, so neither the commit nor a clean checkout matters, and it has to work from a deploy
 * folder that is no longer inside a checkout, where `git rev-parse` exits 128. The context is then
 * only a placeholder for `PlanOptions`, which needs one even though no build step reads it.
 */
const chooseSource = Effect.fn('chooseSource')(function* (app: App, options: DeployOptions) {
  const path = yield* Path.Path;
  const directory = workingDirectoryOf(app);
  const configured =
    app.config.context === undefined ? undefined : path.resolve(directory, app.config.context);

  if (options.tag._tag === 'Some') {
    const reused: Source = { tag: options.tag.value, context: configured ?? directory };
    return reused;
  }

  if (app.config.targets.length === 0) {
    return { tag: THIRD_PARTY_TAG, context: configured ?? directory };
  }

  if (app.config.workingDirectory !== undefined) {
    yield* requireDirectory(directory);
  }

  const git = yield* Git;
  const root = yield* git.root(directory);
  if (!(yield* git.hasCommits(root))) {
    return yield* new DeployError({
      message: 'The repository has no commits yet; images are tagged with the commit',
    });
  }

  const dirty = yield* git.isDirty(root);
  if (dirty && !options.allowDirty && !options.local) {
    return yield* new DeployError({ message: 'Commit your changes first, or pass --allow-dirty' });
  }

  const built: Source = {
    tag: `${yield* git.shortSha(root)}${dirty ? '-dirty' : ''}`,
    context: configured ?? root,
  };
  return built;
});

/**
 * Fails unless the configured working directory exists and is a directory, so a mistyped
 * `workingDirectory` is reported by name before Git is asked about it.
 */
const requireDirectory = Effect.fn('requireDirectory')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(directory)
    .pipe(
      Effect.mapError(
        () => new DeployError({ message: `Cannot access working directory: ${directory}` }),
      ),
    );
  if (info.type !== 'Directory') {
    return yield* new DeployError({
      message: `Working directory is not a directory: ${directory}`,
    });
  }
});

/**
 * A phase of a deploy: it fails with a `DeployError` and may use SSH (`Remote`) and HTTP
 * (`HttpClient`).
 */
type DeployPhase = Phase<DeployError, Remote | HttpClient.HttpClient>;

/**
 * Everything a deploy prints and runs, decided before the first phase starts.
 */
interface DeployRun {
  /**
   * The `Deploying <app> <tag> to <where>` line printed before the first phase.
   */
  readonly header: string;

  /**
   * The phases in the order they run.
   */
  readonly phases: ReadonlyArray<DeployPhase>;

  /**
   * Prints what follows the last phase, given the formatted duration of the whole run: the summary
   * line, or the site file and `Dry run complete.` for a dry run.
   */
  readonly summary: (total: string) => Effect.Effect<void>;
}

/**
 * Plans a deploy: reads the secrets, plans the Docker commands, and decides the phases and the
 * summary that follows them.
 *
 * This is the only place that decides which phases run, so the `[n/total]` counter and the
 * execution cannot disagree: `--local` has no checks, folders, routing or wait; `--tag` reuses
 * images, so the plan has no build steps and there is no build phase; ingress `none` stops after
 * Compose; a dry run routes (printing the site file) but has nothing to wait for. The route and
 * wait phases record the site file and the HTTP status for the summary as they run.
 */
const planRun = Effect.fn('planRun')(function* (
  app: App,
  host: HostConfig,
  options: DeployOptions,
  source: Source,
) {
  const shell = yield* Shell;
  const dryRun = yield* DryRun;

  const { tag } = source;
  const steps = yield* planSteps(app, host, options, source);

  const where = options.local ? 'local Docker' : `${app.config.host} (${dockerHost(host)})`;
  const header = `Deploying ${app.config.name} ${tag} to ${where}`;
  const phases: Array<DeployPhase> = [];
  const done = (summary: DeployRun['summary']): DeployRun => ({ header, phases, summary });
  const deployed = (total: string) =>
    `Deployed ${app.config.name} ${tag} to ${where} (${total} total)`;
  const runSteps = (planned: ReadonlyArray<Step>) =>
    Effect.forEach(planned, (step) => shell.run(step), { discard: true });

  const ingress = options.local ? undefined : ingressFor(app);
  const directories = directoriesOf(app.config);
  const images = imageCount(app.config.targets.length);

  // `planDeployment` puts the Compose command last, after every build and transport step; with
  // `--tag` it is alone.
  const build = steps.slice(0, -1);
  const compose = steps.slice(-1);

  if (!options.local) {
    phases.push(checksPhase(app, host));
  }

  if (!options.local && directories.length > 0) {
    phases.push(foldersPhase(host, directories));
  }

  if (build.length > 0) {
    const title = options.local ? `Building ${images}` : `Building and shipping ${images}`;
    phases.push(phase('build', title, runSteps(build)));
  }

  const composeTitle = options.local
    ? 'Starting the stack with Compose on local Docker'
    : 'Starting the stack with Compose';
  phases.push(phase('compose', composeTitle, runSteps(compose)));

  if (options.local) {
    return done((total) =>
      Console.log(
        dryRun ? DRY_RUN_COMPLETE : `Running ${app.config.name} ${tag} locally (${total} total)`,
      ),
    );
  }

  if (ingress === undefined) {
    return done((total) => Console.log(dryRun ? DRY_RUN_COMPLETE : deployed(total)));
  }

  const routing = yield* tryIngressPlan(() => ingress.plan(app, host));

  let site = '';
  phases.push(
    routePhase(host, routing, (routed) => {
      site = routed;
    }),
  );

  if (dryRun) {
    return done(() => Effect.andThen(Console.log(site.trimEnd()), Console.log(DRY_RUN_COMPLETE)));
  }

  const url = routing.healthUrl;
  if (url === undefined) {
    return done((total) => Console.log(deployed(total)));
  }

  let status = 0;
  phases.push(
    phase('wait', `Waiting for ${url}`, waitForUrl(url, WAIT_TIMEOUT_MILLIS), (code) => {
      status = code;
      return `HTTP ${code}`;
    }),
  );

  return done((total) =>
    Console.log(
      `Deployed ${app.config.name} ${tag} to ${app.config.host}: ${url} ` +
        `(HTTP ${status}, ${total} total)`,
    ),
  );
});

/**
 * Reads the secrets and plans the Docker commands of a deploy, logging the plan at debug level.
 */
const planSteps = Effect.fn('planSteps')(function* (
  app: App,
  host: HostConfig,
  options: DeployOptions,
  source: Source,
) {
  const steps = planDeployment({
    app,
    host,
    tag: source.tag,
    local: options.local,
    reuseImages: options.tag._tag === 'Some',
    context: source.context,
    secrets: yield* readSecrets(app, options.local),
  });
  yield* Effect.logDebug(
    `plan, ${steps.length} steps:\n${steps.map((step) => `$ ${printableStep(step)}`).join('\n')}`,
  );

  return steps;
});

/**
 * `1 image` or `<count> images`, for the build phase title.
 */
function imageCount(count: number): string {
  return `${count} ${count === 1 ? 'image' : 'images'}`;
}

/**
 * The readiness phase: runs the checks, prints them, and fails naming the blocking ones, so nothing
 * is built for a host that cannot take the deploy.
 */
function checksPhase(app: App, host: HostConfig): DeployPhase {
  return phase(
    'checks',
    `Checking readiness on ${app.config.host}`,
    Effect.gen(function* () {
      const checks = yield* runChecks(app, host);
      if (checks.length > 0) {
        yield* Console.log(formatChecks(checks));
      }

      const failed = blocking(checks);
      if (failed.length > 0) {
        const names = failed.map((check) => check.name).join(', ');
        return yield* new DeployError({
          message: `Not ready to deploy: ${names}. See \`compoza check\`.`,
        });
      }
    }),
  );
}

/**
 * The phase that creates the app's host folders before Compose mounts them.
 */
function foldersPhase(host: HostConfig, directories: ReadonlyArray<string>): DeployPhase {
  const script = mkdirScript(directories);
  return phase(
    'folders',
    'Creating host folders',
    Effect.gen(function* () {
      const remote = yield* Remote;
      yield* Effect.logDebug(`host folders script:\n${script}`);
      yield* remote.run(host, script);
    }),
  );
}

/**
 * The phase that writes and validates the ingress route, printing the host's output outside a dry
 * run and handing the site file (the route's input, or `''`) to `onRouted` for the summary.
 */
function routePhase(
  host: HostConfig,
  routing: IngressPlan,
  onRouted: (site: string) => void,
): DeployPhase {
  return phase(
    'route',
    `Routing ${routing.description}`,
    Effect.gen(function* () {
      const remote = yield* Remote;
      const dryRun = yield* DryRun;
      const { script, input, label } = routing.route;
      yield* Effect.logDebug(`route script:\n${script}`);

      if (input !== undefined) {
        yield* Effect.logDebug(`route configuration:\n${input}`);
      }

      const output = yield* remote.run(host, script, input, label);
      if (!dryRun && output.trim() !== '') {
        yield* Console.log(output.trimEnd());
      }

      onRouted(input ?? '');
    }),
  );
}

/**
 * Deploys an app: checks readiness, builds and ships the images, runs Compose on the host, writes
 * and validates the ingress route, and waits for the public URL. With `--local` it builds into this
 * machine's Docker and starts the stack here instead, skipping checks, transport and routing. With
 * `--tag` it reuses images and never touches Git (see `chooseSource`).
 *
 * The order is deliberate: nothing is built before the checks pass, folders exist before Compose
 * mounts them, and the route is only written once the containers are up, so the proxy never points
 * at a stack that is not there. `planRun` decides the phases once and they run in that order
 * through `runPhases`, each with a numbered start and finish line and its duration, so a person can
 * follow the run and see where it stopped; the plan, the scripts sent to the host and the resolved
 * tag are logged at debug level. A missing secrets file fails before anything runs.
 */
export const deploy = Effect.fn('deploy')(function* (options: DeployOptions) {
  const { app, host } = yield* resolve(options.target, options.hosts, options.destination);
  if (!options.local && host.transport.mode === 'remote-build' && app.config.execution !== 'ssh') {
    return yield* new DeployError({ message: 'remote-build transport requires execution: ssh' });
  }

  const source = yield* chooseSource(app, options);

  if (!options.local && app.config.execution === 'ssh') {
    return yield* deploySsh(app, host, options, source);
  }

  yield* Effect.logDebug(`tag ${source.tag}, context ${source.context}`);

  const run = yield* planRun(app, host, options, source);
  yield* Console.log(run.header);

  const total = yield* runPhases(run.phases);
  yield* run.summary(formatDuration(total));
});

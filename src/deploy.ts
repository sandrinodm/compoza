import type { HttpClient } from 'effect/http';

import { Console, Effect, FileSystem, type Option, Path, type Scope } from 'effect';
import { tmpdir } from 'node:os';

import type { Step } from './command.ts';
import type { IngressPlan } from './extensions/ingress.ts';
import type { Phase } from './progress.ts';

import { ROLES_OVERRIDE_FILE } from './bundle.ts';
import { blocking, formatChecks, runChecks } from './checks.ts';
import { mkdirScript, printableStep } from './command.ts';
import { type App, directoriesOf, loadApp, selectDestination } from './config/deploy.ts';
import { dockerHost, type HostConfig, hostFor, loadHostsForRun } from './config/hosts.ts';
import { readSecrets } from './config/secrets.ts';
import { DeployError, platformFailure, tryPlan } from './errors.ts';
import { loadAppExtensionFiles } from './extensions/config.ts';
import { tryIngressFor, tryIngressPlan } from './extensions/ingress.ts';
import { planDeployment } from './plan.ts';
import { DRY_RUN_COMPLETE, formatDuration, phase, runPhases } from './progress.ts';
import {
  buildingRoles,
  buildSettingsOf,
  roleOverride,
  type RoleSource,
  type RoleSources,
  validateRoles,
} from './roles.ts';
import { Git } from './services/Git.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { deploySsh } from './ssh-deploy.ts';
import { parseTagFlags, tagLabel, tagsOf } from './tags.ts';
import { WAIT_TIMEOUT_MILLIS, waitForUrl } from './wait.ts';

/**
 * The message of a failed deployment plan when the planner throws something other than an `Error`.
 */
const INVALID_DEPLOYMENT_PLAN = 'Invalid deployment plan';

/**
 * The permissions of the roles override file: readable by this user only, because it names the
 * variables of role secrets.
 */
const PRIVATE_FILE_MODE = 0o600;

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
   * The values of the repeatable `--tag` flag: `<tag>` for every building role and `<role>=<tag>`
   * for one. Any value reuses images already built under those tags instead of building, a rollback
   * to an earlier deploy.
   */
  readonly tags: ReadonlyArray<string>;

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
 * Reads the app's `deploy.yaml` and the hosts file, and pairs the app with its host.
 */
export const resolve = Effect.fn('resolve')(function* (
  target: string,
  hosts: Option.Option<string>,
  destination?: string,
): Effect.fn.Return<Resolved, DeployError, FileSystem.FileSystem | Path.Path> {
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
 * Chooses the tag and build context of every building role: the commit of the role's repository,
 * `-dirty` when its checkout has changes, or the tags given with `--tag` to reuse.
 *
 * A repository without commits cannot be deployed, because there is nothing to tag images with; a
 * dirty checkout is refused unless `--allow-dirty` or `--local`, so that a tag always names the
 * exact source it was built from. Roles whose working directories share a Git root share one check
 * and one tag. With `--tag` Git is not consulted at all: a rollback reuses images, so neither the
 * commit nor a clean checkout matters, and it has to work from a deploy folder that is no longer
 * inside a checkout, where `git rev-parse` exits 128. The context is then only a placeholder for
 * `PlanOptions`, which needs one even though no build step reads it. An app that builds nothing has
 * no sources and does not consult Git, though `--tag` values are still parsed and validated.
 */
const chooseSource = Effect.fn('chooseSource')(function* (
  app: App,
  options: DeployOptions,
): Effect.fn.Return<RoleSources, DeployError, FileSystem.FileSystem | Git> {
  const roles = buildingRoles(app.config).map((role) => buildSettingsOf(app, role));

  if (options.tags.length > 0) {
    const tags = yield* tryPlan(() => parseTagFlags(options.tags, app.config), 'Invalid --tag');
    const reused: Record<string, RoleSource> = {};
    for (const settings of roles) {
      const tag = Object.hasOwn(tags, settings.role) ? tags[settings.role] : undefined;
      if (tag === undefined) {
        return yield* new DeployError({ message: `No tag for role "${settings.role}"` });
      }

      reused[settings.role] = { tag, context: settings.context ?? settings.workingDirectory };
    }

    return reused;
  }

  const git = yield* Git;
  const tagsByRoot = new Map<string, string>();
  const built: Record<string, RoleSource> = {};
  for (const settings of roles) {
    if (settings.workingDirectoryConfigured) {
      yield* requireDirectory(settings.workingDirectory);
    }

    const root = yield* git.root(settings.workingDirectory);
    const known = tagsByRoot.get(root);
    const tag = known ?? (yield* checkedTag(root, options));
    tagsByRoot.set(root, tag);
    built[settings.role] = { tag, context: settings.context ?? root };
  }

  return built;
});

/**
 * The tag of one Git repository: its short commit, `-dirty` when the checkout has changes. Fails
 * when it has no commits, or is dirty without `--allow-dirty` or `--local`.
 */
const checkedTag = Effect.fn('checkedTag')(function* (root: string, options: DeployOptions) {
  const git = yield* Git;
  if (!(yield* git.hasCommits(root))) {
    return yield* new DeployError({
      message: `The repository ${root} has no commits yet; images are tagged with the commit`,
    });
  }

  const dirty = yield* git.isDirty(root);
  if (dirty && !options.allowDirty && !options.local) {
    return yield* new DeployError({
      message: `Commit your changes in ${root} first, or pass --allow-dirty`,
    });
  }

  return `${yield* git.shortSha(root)}${dirty ? '-dirty' : ''}`;
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
  sources: RoleSources,
  overrideFile: string | undefined,
) {
  const shell = yield* Shell;
  const dryRun = yield* DryRun;

  const tag = tagLabel(sources);
  const steps = yield* planSteps(app, host, options, sources, overrideFile);

  const where = options.local ? 'local Docker' : `${app.config.host} (${dockerHost(host)})`;
  const header = `Deploying ${app.config.name} ${tag} to ${where}`;
  const phases: Array<DeployPhase> = [];

  /**
   * The finished run: the header and phases planned so far, closed with `summary`.
   */
  const done = (summary: DeployRun['summary']): DeployRun => ({ header, phases, summary });

  /**
   * The closing line of a deploy that ran to completion, with the total duration already formatted.
   */
  const deployed = (total: string) =>
    `Deployed ${app.config.name} ${tag} to ${where} (${total} total)`;

  /**
   * Runs planned Docker steps one after another, stopping at the first that fails.
   */
  const runSteps = (planned: ReadonlyArray<Step>) =>
    Effect.forEach(planned, (step) => shell.run(step), { discard: true });

  const ingress = options.local ? undefined : yield* tryIngressFor(app);
  const directories = directoriesOf(app.config);
  const images = imageCount(Object.keys(sources).length);

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
  sources: RoleSources,
  overrideFile: string | undefined,
) {
  const secrets = yield* readSecrets(app, { local: options.local });
  const steps = yield* tryPlan(
    () =>
      planDeployment({
        app,
        host,
        sources,
        local: options.local,
        reuseImages: options.tags.length > 0,
        ...(overrideFile === undefined ? {} : { overrideFile }),
        secrets,
      }),
    INVALID_DEPLOYMENT_PLAN,
  );
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

      const output = yield* remote.run(host, script, { input, label });
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
export const deploy = Effect.fn('deploy')(function* (
  options: DeployOptions,
): Effect.fn.Return<
  void,
  DeployError,
  FileSystem.FileSystem | Git | HttpClient.HttpClient | Path.Path | Remote | Scope.Scope | Shell
> {
  const { app, host } = yield* resolve(options.target, options.hosts, options.destination);
  if (!options.local && host.transport.mode === 'remote-build' && app.config.execution !== 'ssh') {
    return yield* new DeployError({ message: 'remote-build transport requires execution: ssh' });
  }

  yield* validateRoles(app, { local: options.local });

  const sources = yield* chooseSource(app, options);
  if (!options.local && app.config.execution === 'ssh') {
    return yield* deploySsh(app, host, options, sources);
  }

  yield* Effect.logDebug(`tags ${tagLabel(sources)}`);

  const override = yield* tryPlan(
    () => roleOverride({ app, host, tags: tagsOf(sources), local: options.local }),
    INVALID_DEPLOYMENT_PLAN,
  );
  const overrideFile = override === undefined ? undefined : yield* overridePath(override);
  const run = yield* planRun(app, host, options, sources, overrideFile);
  yield* Console.log(run.header);

  if (override !== undefined && (yield* DryRun)) {
    yield* Console.log(`Roles override ${overrideFile}:\n${override.trimEnd()}`);
  }

  const total = yield* runPhases(run.phases);
  yield* run.summary(formatDuration(total));
}, Effect.scoped);

/**
 * The path Compose reads the roles override from. Outside a dry run the override is written to a
 * private temporary folder that is removed when the surrounding scope closes; a dry run writes
 * nothing and only names where the file would go.
 */
const overridePath = Effect.fn('overridePath')(function* (
  override: string,
): Effect.fn.Return<string, DeployError, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const path = yield* Path.Path;
  if (yield* DryRun) {
    return path.join(tmpdir(), 'compoza-roles-XXXXXX', ROLES_OVERRIDE_FILE);
  }

  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs
    .makeTempDirectoryScoped({ prefix: 'compoza-roles-' })
    .pipe(Effect.mapError(platformFailure('Creating a temporary folder for the roles override')));
  const file = path.join(dir, ROLES_OVERRIDE_FILE);
  yield* fs
    .writeFileString(file, override, { mode: PRIVATE_FILE_MODE })
    .pipe(Effect.mapError(platformFailure('Writing the roles override')));

  return file;
});

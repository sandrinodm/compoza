import { devNull } from 'node:os';
import { resolve } from 'node:path';

import { type Command, command, REMOTE_PATH, shellQuote, type Step } from './command.ts';
import {
  type App,
  composeFilesOf,
  environmentOf,
  projectNameOf,
  workingDirectoryOf,
} from './config/deploy.ts';
import { dockerHost, type HostConfig } from './config/hosts.ts';
import { secretSource, validateSecrets } from './config/secrets.ts';

/**
 * Variables cleared for a build on the host's daemon, so a Docker context or Buildx builder
 * selected on this machine cannot redirect the build away from the explicit `--host`.
 */
const REMOTE_BUILD_ENVIRONMENT = {
  /**
   * The Docker context selected with `docker context use`, which would override `DOCKER_HOST`.
   */
  DOCKER_CONTEXT: '',

  /**
   * The Buildx builder selected with `docker buildx use`, which may run on another daemon.
   */
  BUILDX_BUILDER: '',

  /**
   * A Buildx endpoint override.
   */
  BUILDX_HOST: '',
};

/**
 * Everything a plan needs decided: the app and host, the tag, where the build context is, and the
 * secrets.
 */
export interface PlanOptions {
  /**
   * The app to deploy.
   */
  readonly app: App;

  /**
   * The host it deploys to; ignored for `local` runs except for naming images.
   */
  readonly host: HostConfig;

  /**
   * The image tag, normally the short commit.
   */
  readonly tag: string;

  /**
   * Whether the stack runs on this machine's Docker instead of the host.
   */
  readonly local: boolean;

  /**
   * Whether the build and transport steps are left out because the images already exist under
   * `tag`.
   */
  readonly reuseImages: boolean;

  /**
   * The absolute build context.
   */
  readonly context: string;

  /**
   * Secret Compose variables, passed to Compose and masked when printed.
   */
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * The Compose variable that carries a target's image, e.g. `web` → `WEB_IMAGE`, `scraper-api` →
 * `SCRAPER_API_IMAGE`.
 */
export function imageVariable(target: string): string {
  return `${target.toUpperCase().replaceAll('-', '_')}_IMAGE`;
}

/**
 * The image reference for one target at one tag: prefixed with the registry when the host pulls
 * from one, bare otherwise (local runs and SSH transport, where the image is loaded straight into a
 * daemon).
 */
export function imageReference(
  app: App,
  host: HostConfig,
  target: string,
  tag: string,
  local: boolean,
): string {
  const bare = `${app.config.name}-${target}:${tag}`;
  return !local && host.transport.mode === 'registry' ? `${host.transport.registry}/${bare}` : bare;
}

/**
 * The absolute Dockerfile path, defaulting to `Dockerfile` in the working directory.
 *
 * A relative `dockerfile` resolves against the working directory and an absolute one is kept as is,
 * the same rule the build context follows in `deploy.ts`; `join` would instead append an absolute
 * path to the folder.
 */
export function dockerfileOf(app: App): string {
  return resolve(workingDirectoryOf(app), app.config.dockerfile ?? 'Dockerfile');
}

/**
 * The script the SSH transport runs on the host to load an image from standard input: `gunzip |
 * docker load` after `REMOTE_PATH`, under `bash -c`.
 *
 * `ssh` hands its command to the host's login shell, which in a non-interactive session on a macOS
 * host has no Homebrew or OrbStack folder on `PATH`, so a bare `docker load` would not be found.
 * Wrapping it the way `Remote` wraps every script keeps the transport independent of the login
 * shell.
 */
export const LOAD_SCRIPT = `bash -c ${shellQuote(`${REMOTE_PATH}\ngunzip | docker load`)}`;

/**
 * The `docker compose` prefix for an app on a host, or on this machine when `host` is left out: the
 * endpoint, project name and project directory that every Compose subcommand needs.
 */
export function composePrefix(app: App, host?: HostConfig): ReadonlyArray<string> {
  return [
    ...(host === undefined ? [] : ['--host', dockerHost(host)]),
    'compose',
    '--project-name',
    projectNameOf(app),
    '--project-directory',
    app.dir,
  ];
}

/**
 * The ordered steps of a deployment: a build per target, the transport that gets images to the
 * host, and the Compose command that starts the stack. Nothing runs here; `--dry-run` prints
 * exactly this list.
 *
 * With the registry transport the build pushes directly and Compose pulls `always`, so a stale
 * image on the host can never win over the one just built. With the SSH transport the build loads
 * into the local daemon and a `docker save | gzip | ssh … docker load` pipeline follows per image;
 * there, and for `local` runs, Compose pulls `missing`. `--pull` applies to every service in the
 * stack, so `never` would leave a fresh host unable to fetch a third-party image such as
 * `postgres:18`; the images just built are already in the daemon under their tag, so `missing`
 * never replaces them with a pulled copy.
 */
export function planDeployment(options: PlanOptions): ReadonlyArray<Step> {
  const { app, host, tag, local } = options;
  validateSecrets(app, options.secrets, local);

  const steps: Array<Step> = [];
  const images: Record<string, string> = {};
  const dockerfile = dockerfileOf(app);

  for (const target of app.config.targets) {
    const reference = imageReference(app, host, target, tag, local);
    images[imageVariable(target)] = reference;
    if (options.reuseImages) {
      continue;
    }

    steps.push(buildCommand(options, dockerfile, target, reference));

    if (!local && host.transport.mode === 'ssh-load') {
      steps.push(loadPipeline(host, reference));
    }
  }

  steps.push(composeUpCommand(options, images));

  return steps;
}

/**
 * The `docker buildx build` command for one target: pushed to the registry, built on the host's own
 * daemon, or loaded into this machine's daemon, depending on the transport and `local`.
 */
function buildCommand(
  options: PlanOptions,
  dockerfile: string,
  target: string,
  reference: string,
): Command {
  const { app, host, local } = options;
  const push = !local && host.transport.mode === 'registry';
  const remoteBuild = !local && host.transport.mode === 'remote-build';
  return command(
    'docker',
    [
      ...(remoteBuild ? ['--host', dockerHost(host)] : []),
      'buildx',
      'build',
      ...(remoteBuild ? ['--builder', 'default'] : []),
      ...(local ? [] : ['--platform', host.platform]),
      push ? '--push' : '--load',
      '--file',
      dockerfile,
      '--target',
      target,
      '--tag',
      reference,
      options.context,
    ],
    {
      cwd: workingDirectoryOf(app),
      ...(remoteBuild ? { env: REMOTE_BUILD_ENVIRONMENT } : {}),
    },
  );
}

/**
 * The `docker save | gzip | ssh … docker load` pipeline that ships one locally built image to the
 * host.
 */
function loadPipeline(host: HostConfig, reference: string): Step {
  return {
    stages: [
      command('docker', ['save', reference]),
      command('gzip', []),
      command('ssh', ['-o', 'BatchMode=yes', host.ssh, LOAD_SCRIPT]),
    ],
  };
}

/**
 * The `docker compose up` command that starts the stack with the built image references.
 *
 * A secret source or secret values replace Compose's automatic `.env` lookup with `/dev/null`, so a
 * stray dotenv file in the project directory cannot add or override variables.
 */
function composeUpCommand(options: PlanOptions, images: Readonly<Record<string, string>>): Command {
  const { app, host, local } = options;
  const pull = !local && host.transport.mode === 'registry' ? 'always' : 'missing';
  const replacesDotenv =
    secretSource(app, local) !== undefined || Object.keys(options.secrets).length > 0;
  return command(
    'docker',
    [
      ...composePrefix(app, local ? undefined : host),
      ...(replacesDotenv ? ['--env-file', devNull] : []),
      ...composeFilesOf(app.config, local).flatMap((file) => ['--file', resolve(app.dir, file)]),
      ...(app.config.profiles ?? []).flatMap((profile) => ['--profile', profile]),
      'up',
      '--detach',
      '--remove-orphans',
      '--no-build',
      '--pull',
      pull,
    ],
    {
      cwd: app.dir,
      env: { ...environmentOf(app.config, local), ...options.secrets, ...images },
      secret: Object.keys(options.secrets),
      sensitive: true,
    },
  );
}

import { devNull } from 'node:os';
import { resolve } from 'node:path';

import { type Command, command, REMOTE_PATH, shellQuote, type Step } from './command.ts';
import { type App, composeFilesOf, environmentOf, projectNameOf } from './config/deploy.ts';
import { dockerHost, type HostConfig } from './config/hosts.ts';
import { secretSource, validateSecrets } from './config/secrets.ts';

/**
 * Everything a plan needs decided: the app and host, the tag, where the build context is, and the secrets.
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
   * Whether the build and transport steps are left out because the images already exist under `tag`.
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
 * The Compose variable that carries a target's image, e.g. `web` → `WEB_IMAGE`, `scraper-api` → `SCRAPER_API_IMAGE`.
 */
export function imageVariable(target: string): string {
  return `${target.toUpperCase().replaceAll('-', '_')}_IMAGE`;
}

/**
 * The image reference for one target at one tag: prefixed with the registry when the host pulls from one, bare
 * otherwise (local runs and SSH transport, where the image is loaded straight into a daemon).
 */
export function imageReference(app: App, host: HostConfig, target: string, tag: string, local: boolean): string {
  const bare = `${app.config.name}-${target}:${tag}`;
  return !local && host.transport.mode === 'registry' ? `${host.transport.registry}/${bare}` : bare;
}

/**
 * The absolute Dockerfile path, defaulting to `Dockerfile` in the deploy folder.
 *
 * A relative `dockerfile` resolves against the deploy folder and an absolute one is kept as is, the same rule the build
 * context follows in `deploy.ts`; `join` would instead append an absolute path to the folder.
 */
export function dockerfileOf(app: App): string {
  return resolve(app.dir, app.config.dockerfile ?? 'Dockerfile');
}

/**
 * The script the SSH transport runs on the host to load an image from standard input: `gunzip | docker load` after
 * `REMOTE_PATH`, under `bash -c`.
 *
 * `ssh` hands its command to the host's login shell, which in a non-interactive session on a macOS host has no Homebrew
 * or OrbStack folder on `PATH`, so a bare `docker load` would not be found. Wrapping it the way `Remote` wraps every
 * script keeps the transport independent of the login shell.
 */
export const LOAD_SCRIPT = `bash -c ${shellQuote(`${REMOTE_PATH}\ngunzip | docker load`)}`;

/**
 * The `docker compose` prefix for an app on a host, or on this machine when `host` is left out: the endpoint, project
 * name and project directory that every Compose subcommand needs.
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
 * The ordered steps of a deployment: a build per target, the transport that gets images to the host, and the Compose
 * command that starts the stack. Nothing runs here; `--dry-run` prints exactly this list.
 *
 * With the registry transport the build pushes directly and Compose pulls `always`, so a stale image on the host can
 * never win over the one just built. With the SSH transport the build loads into the local daemon and a `docker save |
 * gzip | ssh … docker load` pipeline follows per image; there, and for `local` runs, Compose pulls `missing`. `--pull`
 * applies to every service in the stack, so `never` would leave a fresh host unable to fetch a third-party image such
 * as `postgres:18`; the images just built are already in the daemon under their tag, so `missing` never replaces them
 * with a pulled copy.
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

    const push = !local && host.transport.mode === 'registry';
    steps.push(
      command(
        'docker',
        [
          ...(!local && host.transport.mode === 'remote-build' ? ['--host', dockerHost(host)] : []),
          'buildx',
          'build',
          ...(!local && host.transport.mode === 'remote-build' ? ['--builder', 'default'] : []),
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
          cwd: app.dir,
          ...(!local && host.transport.mode === 'remote-build'
            ? { env: { DOCKER_CONTEXT: '', BUILDX_BUILDER: '', BUILDX_HOST: '' } }
            : {}),
        },
      ),
    );

    if (!local && host.transport.mode === 'ssh-load') {
      steps.push({
        stages: [
          command('docker', ['save', reference]),
          command('gzip', []),
          command('ssh', ['-o', 'BatchMode=yes', host.ssh, LOAD_SCRIPT]),
        ],
      });
    }
  }

  const pull = !local && host.transport.mode === 'registry' ? 'always' : 'missing';
  const compose: Command = command(
    'docker',
    [
      ...composePrefix(app, local ? undefined : host),
      ...(secretSource(app, local) !== undefined || Object.keys(options.secrets).length > 0
        ? ['--env-file', devNull]
        : []),
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
  steps.push(compose);

  return steps;
}

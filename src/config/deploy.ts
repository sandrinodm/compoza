import { Effect, Path, Schema } from 'effect';

import { DeployError } from '../errors.ts';
import { readJsonFile } from './json-file.ts';
import { AbsolutePath, Name, Target } from './schema.ts';

export { HealthPath, CaddyIngress, NoIngress } from '../extensions/config.ts';
export { Ingress, SecretsConfig } from '../extensions/config.ts';
import { Ingress, SecretsConfig, resolveIngress, type ResolvedIngress } from '../extensions/config.ts';

/**
 * Settings that replace the deployment's for `--local` runs against this machine's Docker.
 */
export const LocalOverrides = Schema.Struct({
  /**
   * The complete secret source replacing inherited settings when supplied.
   */
  secrets: Schema.optionalKey(SecretsConfig),

  /**
   * Compose files for a local run, relative to the deploy folder; typically without the host-network overlay.
   */
  composeFiles: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),

  /**
   * Compose variables merged over `environment`, usually relative paths in place of host folders.
   */
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

/**
 * Host-owned paths and health deadlines for SSH execution.
 *
 * The overlay, legacy host dotenv and persistent data remain operator-owned. Client-resolved providers are uploaded
 * separately as protected snapshots outside the release assets.
 */
export const RemoteConfig = Schema.Struct({
  /**
   * The absolute stack root containing `releases`, `current` and the deployment lock.
   */
  stackDir: AbsolutePath,

  /**
   * The absolute production dotenv path; Compose reads it only on the host.
   */
  envFile: Schema.optionalKey(AbsolutePath),

  /**
   * The optional absolute host-owned Compose overlay, applied after release files.
   */
  overlayFile: Schema.optionalKey(AbsolutePath),

  /**
   * The Compose readiness timeout in seconds, defaulting to 180.
   */
  waitTimeoutSeconds: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3600 }))),
  ),
});

/**
 * An independent HTTP readiness probe executed over SSH on the host.
 *
 * Host-loopback URLs work without publishing a port or exposing a tunnel on the client.
 */
export const HealthConfig = Schema.Struct({
  /**
   * The HTTP or HTTPS URL to probe from the host, without credentials.
   */
  url: Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\/[^\s@]+$/))),

  /**
   * The total probe timeout in seconds, defaulting to 180.
   */
  timeoutSeconds: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3600 })))),
});

/**
 * A named deployment selection merged over the app defaults.
 *
 * Destinations share source and image targets while selecting a host, Compose files and persistent host paths.
 */
export const Destination = Schema.Struct({
  /**
   * The complete secret source replacing inherited settings when supplied.
   */
  secrets: Schema.optionalKey(SecretsConfig),

  /**
   * The host key replacing the app default.
   */
  host: Schema.optionalKey(Name),

  /**
   * The Compose project name replacing the app name on this destination.
   */
  projectName: Schema.optionalKey(Name),

  /**
   * The ordered Compose files replacing the app defaults.
   */
  composeFiles: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),

  /**
   * The Compose execution location, independent of image transport.
   */
  execution: Schema.optionalKey(Schema.Literals(['client', 'ssh'])),

  /**
   * The host-owned SSH settings replacing the app defaults.
   */
  remote: Schema.optionalKey(RemoteConfig),

  /**
   * The selected Compose profiles replacing the app defaults.
   */
  profiles: Schema.optionalKey(Schema.Array(Name)),

  /**
   * The non-secret variables merged over app defaults.
   */
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /**
   * The ingress replacing the app default, including `none` for private destinations.
   */
  ingress: Schema.optionalKey(Ingress),

  /**
   * The independent host-side health probe replacing the app default.
   */
  health: Schema.optionalKey(HealthConfig),

  /**
   * The persistent host directories replacing the app defaults.
   */
  directories: Schema.optionalKey(Schema.Array(AbsolutePath)),

  /**
   * The content destinations replacing the app defaults.
   */
  content: Schema.optionalKey(Schema.Record(Name, AbsolutePath)),
});

/**
 * The contents of an app's `deploy.json`, the file that opts a folder into this tool.
 *
 * Paths in it are relative to the folder holding the file, except host folders, which are absolute on the host.
 */
export const DeployConfig = Schema.Struct({
  /**
   * The complete secret source replacing inherited settings when supplied.
   */
  secrets: Schema.optionalKey(SecretsConfig),

  /**
   * Compose project name and image name prefix (`<name>-<target>`).
   */
  name: Name,

  /**
   * Key of the host that runs the app in the hosts file.
   */
  host: Name,

  /**
   * The Dockerfile, relative to the deploy folder; defaults to `Dockerfile` next to `deploy.json`.
   */
  dockerfile: Schema.optionalKey(Schema.String),

  /**
   * The build context, relative to the deploy folder; defaults to the root of the Git repository.
   */
  context: Schema.optionalKey(Schema.String),

  /**
   * Dockerfile targets to build; each becomes an `<TARGET>_IMAGE` Compose variable holding its image reference.
   */
  targets: Schema.Array(Target),

  /**
   * Compose files, relative to the deploy folder, applied in order.
   */
  composeFiles: Schema.NonEmptyArray(Schema.String),

  /**
   * How the stack is routed; defaults to `none`.
   */
  ingress: Schema.optionalKey(Ingress),

  /**
   * Host folders created before Compose runs, such as bind-mounted data.
   */
  directories: Schema.optionalKey(Schema.Array(AbsolutePath)),

  /**
   * Content sections the app serves, mapped to their host folders: `publish` copies a local folder into one, and deploy
   * creates them like `directories`.
   */
  content: Schema.optionalKey(Schema.Record(Name, AbsolutePath)),

  /**
   * Non-secret Compose variables.
   */
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),

  /**
   * A `KEY=value` file on this machine with secret Compose variables, read at deploy time and never printed. A leading
   * `~/` means the home folder.
   */
  envFile: Schema.optionalKey(Schema.String),

  /**
   * Overrides for `--local` runs.
   */
  local: Schema.optionalKey(LocalOverrides),

  /**
   * The Compose execution location; defaults to the original client-side Docker SSH execution.
   */
  execution: Schema.optionalKey(Schema.Literals(['client', 'ssh'])),

  /**
   * The host-owned stack paths, required for SSH execution.
   */
  remote: Schema.optionalKey(RemoteConfig),

  /**
   * The explicit deploy-relative regular files included with SSH Compose releases.
   */
  assets: Schema.optionalKey(Schema.Array(Schema.String)),

  /**
   * The Compose profiles enabled for this deployment.
   */
  profiles: Schema.optionalKey(Schema.Array(Name)),

  /**
   * The optional independent HTTP readiness probe over SSH.
   */
  health: Schema.optionalKey(HealthConfig),

  /**
   * The optional Compose project name, leaving the app's image prefix unchanged.
   */
  projectName: Schema.optionalKey(Name),

  /**
   * The named deployment choices selected with `--destination`.
   */
  destinations: Schema.optionalKey(Schema.Record(Name, Destination)),
});

/**
 * A decoded `deploy.json`.
 */
export type DeployConfig = typeof DeployConfig.Type;

/**
 * An app ready to deploy: its configuration and the absolute folder it was read from, against which the relative paths
 * in the configuration resolve.
 */
export interface App {
  /**
   * The absolute deploy folder.
   */
  readonly dir: string;

  /**
   * The decoded `deploy.json`.
   */
  readonly config: DeployConfig;
}

/**
 * The file name that marks a deploy folder.
 */
export const DEPLOY_FILE = 'deploy.json';

/**
 * The path probed after a deploy when the ingress names none.
 */
export const DEFAULT_HEALTH_PATH = '/';

/**
 * The app's ingress, `none` when the configuration leaves it out.
 */
export function ingressOf(config: DeployConfig): ResolvedIngress {
  return config.ingress === undefined ? { mode: 'none' } : resolveIngress(config.ingress);
}

/**
 * The content sections, empty when the configuration leaves them out.
 */
export function contentOf(config: DeployConfig): Readonly<Record<string, string>> {
  return config.content ?? {};
}

/**
 * Every host folder deploy creates: the listed directories followed by the content folders.
 */
export function directoriesOf(config: DeployConfig): ReadonlyArray<string> {
  return [...(config.directories ?? []), ...Object.values(contentOf(config))];
}

/**
 * The Compose files for a run: the local overrides when `local` is set and they exist, the deployment's otherwise.
 */
export function composeFilesOf(config: DeployConfig, local: boolean): ReadonlyArray<string> {
  return (local ? config.local?.composeFiles : undefined) ?? config.composeFiles;
}

/**
 * The non-secret Compose variables for a run, with the local overrides merged over them when `local` is set.
 */
export function environmentOf(config: DeployConfig, local: boolean): Readonly<Record<string, string>> {
  return { ...config.environment, ...(local ? config.local?.environment : undefined) };
}

/**
 * Reads and validates the `deploy.json` at `target`, which may name the folder or the file itself.
 *
 * Relative targets resolve against the working directory, so `compoza deploy infra` works from a repository root and
 * `compoza deploy .` from the folder itself. A missing file is reported as such rather than as a parse error, because
 * it is the usual first mistake.
 */
export const loadApp = Effect.fn('loadApp')(function* (target: string) {
  const path = yield* Path.Path;
  const resolved = path.resolve(target);
  const file = path.basename(resolved) === DEPLOY_FILE ? resolved : path.join(resolved, DEPLOY_FILE);
  const config = yield* readJsonFile(
    file,
    DeployConfig,
    `No ${file}. Point compoza at a folder holding a ${DEPLOY_FILE}.`,
    true,
  );
  const app: App = { dir: path.dirname(file), config };
  yield* Effect.try({
    try: () => validateSecretSettings(config),
    catch: () =>
      new DeployError({
        message: 'Ambiguous secret sources: use secrets, envFile, or remote.envFile, never a combination',
      }),
  });
  return app;
});

/**
 * Selects a destination before host resolution without changing the shared source or image prefix.
 *
 * Unknown selections fail early, and omitted destination fields retain the app defaults.
 */
export function selectDestination(app: App, name?: string): App {
  if (name === undefined) {
    return app;
  }
  const selected = app.config.destinations?.[name];
  if (selected === undefined) {
    throw new Error(
      `Unknown destination "${name}"; choices: ${Object.keys(app.config.destinations ?? {}).join(', ') || 'none'}`,
    );
  }
  const config = { ...app.config, ...selected, environment: { ...app.config.environment, ...selected.environment } };
  if (selected.secrets !== undefined) {
    delete config.envFile;
    if (config.remote !== undefined) {
      const { envFile: _legacy, ...remote } = config.remote;
      config.remote = remote;
    }
  }
  validateSecretSettings(config);
  return { ...app, config };
}

/**
 * The Compose project identity, distinct from the shared image prefix when configured.
 */
export function projectNameOf(app: App): string {
  return app.config.projectName ?? app.config.name;
}

/**
 * Rejects competing source declarations before fetching secrets or mutating a host.
 *
 * Destination provider objects replace inherited sources, while conflicting declarations within one level are errors.
 */
export function validateSecretSettings(config: DeployConfig): void {
  if ([config.secrets, config.envFile, config.remote?.envFile].filter((source) => source !== undefined).length > 1) {
    throw new Error('Ambiguous secret sources: use secrets, envFile, or remote.envFile, never a combination');
  }
  for (const destination of Object.values(config.destinations ?? {})) {
    if (destination.secrets !== undefined && destination.remote?.envFile !== undefined) {
      throw new Error('Ambiguous destination secret sources');
    }
  }
}

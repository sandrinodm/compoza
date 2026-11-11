import { Effect, type FileSystem, Path, Schema } from 'effect';
import { resolve } from 'node:path';

import { DeployError } from '../errors.ts';
import {
  Ingress,
  SecretsConfig,
  resolveIngress,
  type ResolvedIngress,
} from '../extensions/config.ts';
import { fileExists, readConfigFile } from './config-file.ts';
import { expandHome } from './hosts.ts';
import { AbsolutePath, Name, RoleName, Target } from './schema.ts';

export { HealthPath, Ingress, SecretsConfig } from '../extensions/config.ts';
export type { CaddyIngress, NoIngress } from '../extensions/config.ts';

/**
 * The file name that marks a deploy folder.
 */
export const DEPLOY_FILE = 'deploy.yaml';

/**
 * The file name looked for when a folder has no `DEPLOY_FILE`, for repositories that spell YAML
 * with three letters.
 */
const ALTERNATE_DEPLOY_FILE = 'deploy.yml';

/**
 * The path probed after a deploy when the ingress names none.
 */
export const DEFAULT_HEALTH_PATH = '/';

/**
 * The message for a `deploy.yaml` that still has `targets`, which `roles` replaced.
 */
const TARGETS_REMOVED_MESSAGE =
  'targets was replaced by roles: give each built Compose service a role with build.target, ' +
  'and remove image: ${<TARGET>_IMAGE} from Compose files; ' +
  "compoza now sets each built service's image";

/**
 * A target that already names a YAML file rather than a folder.
 */
const YAML_FILE_PATTERN = /\.ya?ml$/;

/**
 * The longest readiness or probe timeout a configuration may set, in seconds (one hour).
 */
const MAX_TIMEOUT_SECONDS = 3600;

/**
 * A timeout in whole seconds, from one second up to `MAX_TIMEOUT_SECONDS`.
 */
const TimeoutSeconds = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS })),
);

/**
 * An HTTP or HTTPS URL without whitespace or an `@`, so it can carry no user credentials.
 */
const HEALTH_URL_PATTERN = /^https?:\/\/[^\s@]+$/;

/**
 * A directory path that is not blank and holds no control characters, such as newlines or tabs.
 */
const DIRECTORY_PATH_PATTERN = /^(?=.*\S)[^\p{Cc}]+$/u;

/**
 * A directory path that is not blank and holds no control characters, as `workingDirectory` takes.
 */
const DirectoryPath = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(DIRECTORY_PATH_PATTERN, {
      message: 'expected a nonempty directory path without control characters',
    }),
  ),
);

/**
 * How one role's image is built; each field left out falls back to the top-level field of the same
 * name, then to its default.
 */
const RoleBuild = Schema.Struct({
  /**
   * The Dockerfile stage to build; without it no `--target` flag is passed and the final stage is
   * built.
   */
  target: Schema.optionalKey(Target),

  /**
   * The source directory for this role's Git checks and build, resolved like the top-level
   * `workingDirectory`.
   */
  workingDirectory: Schema.optionalKey(DirectoryPath),

  /**
   * The Dockerfile, relative to the role's working directory; defaults to `Dockerfile` there.
   */
  dockerfile: Schema.optionalKey(Schema.String),

  /**
   * The build context, relative to the role's working directory; defaults to the root of the Git
   * repository containing it.
   */
  context: Schema.optionalKey(Schema.String),
});

/**
 * What a destination or a local run may change about a role: its container environment and secrets.
 * Destinations share the source, so they cannot add `build`.
 */
export const RoleSettings = Schema.Struct({
  /**
   * Container environment of the service, merged over the role's `environment`. Values are literal.
   */
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),

  /**
   * Secret variable names from the stack's secret source, delivered to the service under the same
   * names. Replaces the role's list.
   */
  secrets: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * The settings of one Compose service: what to build for it and which container environment and
 * secrets it gets.
 */
export const Role = Schema.Struct({
  /**
   * How to build the service's image; without it Compoza builds nothing for this service.
   */
  build: Schema.optionalKey(RoleBuild),

  ...RoleSettings.fields,
});

/**
 * Role changes by Compose service name: settings to merge over the role, or `null` to remove the
 * role for the run.
 */
const RoleChangesByName = Schema.Record(RoleName, Schema.NullOr(RoleSettings));

/**
 * Settings that replace the deployment's for `--local` runs against this machine's Docker.
 */
export const LocalOverrides = Schema.Struct({
  /**
   * The complete secret source replacing inherited settings when supplied.
   */
  secrets: Schema.optionalKey(SecretsConfig),

  /**
   * Compose files for a local run, relative to the deploy folder; typically without the
   * host-network overlay.
   */
  composeFiles: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),

  /**
   * Compose variables merged over `environment`, usually relative paths in place of host folders.
   */
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),

  /**
   * Role environment merged over the app's roles for a local run, and secrets replacing a role's
   * list. A role set to `null` is removed for the local run.
   */
  roles: Schema.optionalKey(RoleChangesByName),
});

/**
 * Host-owned paths and health deadlines for SSH execution.
 *
 * The overlay and persistent data remain operator-owned. Client-resolved providers are uploaded in
 * the protected stack .env file.
 */
export const RemoteConfig = Schema.Struct({
  /**
   * The absolute stack root containing compose.yaml, .env, assets and lifecycle metadata.
   */
  stackDir: AbsolutePath,

  /**
   * The optional absolute host-owned Compose overlay, applied after compose.yaml.
   */
  overlayFile: Schema.optionalKey(AbsolutePath),

  /**
   * The Compose readiness timeout in seconds, defaulting to 180.
   */
  waitTimeoutSeconds: Schema.optionalKey(TimeoutSeconds),
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
  url: Schema.String.pipe(Schema.check(Schema.isPattern(HEALTH_URL_PATTERN))),

  /**
   * The total probe timeout in seconds, defaulting to 180.
   */
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds),
});

/**
 * A named deployment selection merged over the app defaults.
 *
 * Destinations share source and the roles' builds while selecting a host, Compose files and
 * persistent host paths.
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
   * Role environment merged over the app's roles, and secrets replacing a role's list. A role set
   * to `null` is removed for this destination.
   */
  roles: Schema.optionalKey(RoleChangesByName),

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
 * The contents of an app's `deploy.yaml`, the file that opts a folder into this tool.
 *
 * Deployment paths are relative to the file; build paths use `workingDirectory`. Host folders are
 * absolute on the host.
 */
export const DeployConfig = Schema.Struct({
  /**
   * The complete secret source replacing inherited settings when supplied.
   */
  secrets: Schema.optionalKey(SecretsConfig),

  /**
   * Compose project name and image name prefix (`<name>-<role>`).
   */
  name: Name,

  /**
   * Key of the host that runs the app in the hosts file.
   */
  host: Name,

  /**
   * The default source directory for Git and builds, relative to this file; absolute and `~/` paths
   * are also accepted. Defaults to the deploy folder. Compose, assets, secrets and templates remain
   * relative to this file.
   */
  workingDirectory: Schema.optionalKey(DirectoryPath),

  /**
   * The default Dockerfile, relative to the working directory; defaults to `Dockerfile` there.
   */
  dockerfile: Schema.optionalKey(Schema.String),

  /**
   * The default build context, relative to the working directory; defaults to the root of the Git
   * repository.
   */
  context: Schema.optionalKey(Schema.String),

  /**
   * Settings per Compose service. A role with `build` gets an image built by Compoza, and every
   * role can set container environment and secrets for its service.
   */
  roles: Schema.optionalKey(Schema.Record(RoleName, Role)),

  /**
   * Compose files applied in order; relative paths use the deploy folder, and absolute paths select
   * external sources.
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
   * Content sections the app serves, mapped to their host folders: `publish` copies a local folder
   * into one, and deploy creates them like `directories`.
   */
  content: Schema.optionalKey(Schema.Record(Name, AbsolutePath)),

  /**
   * Non-secret Compose variables.
   */
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),

  /**
   * Overrides for `--local` runs.
   */
  local: Schema.optionalKey(LocalOverrides),

  /**
   * Where Compose runs: `client` (the default) runs it on this machine against the host's Docker
   * over SSH, `ssh` runs it on the host itself.
   */
  execution: Schema.optionalKey(Schema.Literals(['client', 'ssh'])),

  /**
   * The host-owned stack paths, required for SSH execution.
   */
  remote: Schema.optionalKey(RemoteConfig),

  /**
   * The explicit deploy-relative regular files included with the SSH stack.
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
 * A decoded `deploy.yaml`.
 */
export type DeployConfig = typeof DeployConfig.Type;

/**
 * An app ready to deploy: its configuration and the absolute folder used to resolve deployment
 * files. Git and builds use `workingDirectoryOf`.
 */
export interface App {
  /**
   * The absolute deploy folder.
   */
  readonly dir: string;

  /**
   * The absolute source configuration file, when loaded from disk.
   */
  readonly file?: string;

  /**
   * The decoded `deploy.yaml`.
   */
  readonly config: DeployConfig;

  /**
   * The roles the selected destination removed, which `config.roles` no longer lists. Empty when no
   * destination is selected.
   */
  readonly removedRoles?: ReadonlyArray<string>;
}

/**
 * The settings of one role after merging destinations and local runs.
 */
export type Role = typeof Role.Type;

/**
 * The container settings a destination or local run may set for a role.
 */
export type RoleSettings = typeof RoleSettings.Type;

/**
 * The source directory used by Git and builds, without requiring a checkout for source-free
 * commands. A role's own `workingDirectory` takes the place of the top-level one when given.
 */
export function workingDirectoryOf(app: App, workingDirectory?: string): string {
  return resolve(app.dir, expandHome(workingDirectory ?? app.config.workingDirectory ?? '.'));
}

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
 * Which run a setting is resolved for, as taken by the functions that read `local` overrides.
 */
export interface RunOptions {
  /**
   * Whether this is a local run (`--local`), which reads the `local` overrides (Compose files,
   * environment, secrets) instead of the deployment's. `false` when left out.
   */
  readonly local?: boolean;
}

/**
 * The Compose files for a run: the local overrides for a local run when they exist, the
 * deployment's otherwise.
 */
export function composeFilesOf(
  config: DeployConfig,
  { local = false }: RunOptions = {},
): ReadonlyArray<string> {
  return (local ? config.local?.composeFiles : undefined) ?? config.composeFiles;
}

/**
 * The non-secret Compose variables for a run, with the local overrides merged over them for a local
 * run.
 */
export function environmentOf(
  config: DeployConfig,
  { local = false }: RunOptions = {},
): Readonly<Record<string, string>> {
  return { ...config.environment, ...(local ? config.local?.environment : undefined) };
}

/**
 * Merges role changes from a destination or local run over a base set of roles: per role,
 * `environment` merges over the base's and `secrets` replaces the base's list when given. A role
 * named only in `overrides` is kept as an environment-only role. A role set to `null` is removed
 * entirely, and removing a role the base does not have changes nothing.
 */
export function mergeRoles(
  base: Readonly<Record<string, Role>> | undefined,
  overrides: Readonly<Record<string, RoleSettings | null>> | undefined,
): Record<string, Role> {
  const merged: Record<string, Role> = { ...base };
  for (const [name, settings] of Object.entries(overrides ?? {})) {
    const role = Object.hasOwn(merged, name) ? merged[name] : undefined;
    if (settings === null) {
      delete merged[name];
      continue;
    }

    const environment = { ...role?.environment, ...settings.environment };
    const secrets = settings.secrets ?? role?.secrets;
    merged[name] = {
      ...role,
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
      ...(secrets === undefined ? {} : { secrets }),
    };
  }

  return merged;
}

/**
 * The first role removal in `config` that names a role the app's top-level `roles` does not define,
 * as a message, or `undefined` when every removal is valid. Destinations are checked in
 * configuration order, then `local.roles`, so a typo in a destination that is not selected is still
 * found.
 */
export function roleRemovalIssue(config: DeployConfig): string | undefined {
  const defined = Object.keys(config.roles ?? {});
  const sources = [
    ...Object.entries(config.destinations ?? {}).map(([name, destination]) => ({
      subject: `Destination "${name}"`,
      changes: destination.roles,
    })),
    { subject: 'local.roles', changes: config.local?.roles },
  ];
  for (const { subject, changes } of sources) {
    const unknown = removedBy(changes).find((name) => !defined.includes(name));
    if (unknown !== undefined) {
      const choices = defined.join(', ') || 'none';
      return `${subject} removes role "${unknown}", which is not a role; roles: ${choices}`;
    }
  }

  return undefined;
}

/**
 * The roles for a run: the app's (already merged with the selected destination), with the
 * `local.roles` changes applied over them for a local run.
 */
export function rolesOf(
  config: DeployConfig,
  { local = false }: RunOptions = {},
): Readonly<Record<string, Role>> {
  return local ? mergeRoles(config.roles, config.local?.roles) : (config.roles ?? {});
}

/**
 * The variables the roles take from the secret source, without duplicates, in first-use order.
 */
export function roleSecretNames(roles: Readonly<Record<string, Role>>): ReadonlyArray<string> {
  return [...new Set(Object.values(roles).flatMap((role) => role.secrets ?? []))];
}

/**
 * Reads and validates the `deploy.yaml` at `target`, which may name the folder or the file itself.
 *
 * Relative targets resolve against the working directory, so `compoza deploy infra` works from a
 * repository root and `compoza deploy .` from the folder itself. A missing file is reported as such
 * rather than as a parse error, because it is the usual first mistake.
 */
export const loadApp = Effect.fn('loadApp')(function* (
  target: string,
): Effect.fn.Return<App, DeployError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const file = yield* deployFileFor(target);
  const config = yield* readConfigFile(
    file,
    DeployConfig,
    `No ${file}. Point compoza at a folder holding a ${DEPLOY_FILE}.`,
    { privateInput: true, removedKeys: { targets: TARGETS_REMOVED_MESSAGE } },
  );
  const removalIssue = roleRemovalIssue(config);
  if (removalIssue !== undefined) {
    return yield* new DeployError({ message: `${file}: ${removalIssue}` });
  }

  return { dir: path.dirname(file), file, config };
});

/**
 * The deploy file a `loadApp` target names: the target itself when it ends in `.yaml` or `.yml`,
 * otherwise the folder's `DEPLOY_FILE`, or its `ALTERNATE_DEPLOY_FILE` when only that one exists.
 *
 * A folder with neither file still yields the `DEPLOY_FILE` path, so the missing-file message names
 * the preferred spelling.
 */
const deployFileFor = Effect.fn('deployFileFor')(function* (target: string) {
  const path = yield* Path.Path;
  const resolved = path.resolve(target);
  if (YAML_FILE_PATTERN.test(resolved)) {
    return resolved;
  }

  const preferred = path.join(resolved, DEPLOY_FILE);
  if (yield* fileExists(preferred)) {
    return preferred;
  }

  const alternate = path.join(resolved, ALTERNATE_DEPLOY_FILE);
  return (yield* fileExists(alternate)) ? alternate : preferred;
});

/**
 * The `local` entry for a destination's config, as a spread: `local.roles` without the roles that
 * the destination removes, so a local run cannot bring one back or fail on removing it twice.
 * Nothing is added when the app has no `local` block.
 */
function localWithoutRemoved(
  local: typeof LocalOverrides.Type | undefined,
  destinationRoles: Readonly<Record<string, RoleSettings | null>> | undefined,
): { readonly local?: typeof LocalOverrides.Type } {
  if (local?.roles === undefined) {
    return local === undefined ? {} : { local };
  }

  const removed = removedBy(destinationRoles);
  const kept = Object.entries(local.roles).filter(([name]) => !removed.includes(name));
  return { local: { ...local, roles: Object.fromEntries(kept) } };
}

/**
 * Selects a destination before host resolution without changing the shared source or image prefix.
 *
 * Unknown selections fail early, and omitted destination fields retain the app defaults.
 */
export function selectDestination(app: App, name?: string): App {
  if (name === undefined) {
    return app;
  }

  const destinations = app.config.destinations ?? {};
  const selected = Object.hasOwn(destinations, name) ? destinations[name] : undefined;
  if (selected === undefined) {
    const choices = Object.keys(destinations).join(', ') || 'none';
    throw new Error(`Unknown destination "${name}"; choices: ${choices}`);
  }

  const { roles: _roles, ...rest } = selected;
  const { roles: _appRoles, ...base } = app.config;
  const roles = mergeRoles(app.config.roles, selected.roles);
  const config = {
    ...base,
    ...rest,
    environment: { ...app.config.environment, ...selected.environment },
    ...(Object.keys(roles).length === 0 ? {} : { roles }),
    ...localWithoutRemoved(app.config.local, selected.roles),
  };
  return { ...app, config, removedRoles: removedBy(selected.roles) };
}

/**
 * The roles that `changes` set to `null`.
 */
function removedBy(
  changes: Readonly<Record<string, RoleSettings | null>> | undefined,
): ReadonlyArray<string> {
  return Object.entries(changes ?? {})
    .filter(([, change]) => change === null)
    .map(([name]) => name);
}

/**
 * The roles removed for a run, by the selected destination and, for a local run, by `local.roles`,
 * in that order and without duplicates.
 */
export function removedRolesOf(
  app: App,
  { local = false }: RunOptions = {},
): ReadonlyArray<string> {
  const names = [...(app.removedRoles ?? []), ...(local ? removedBy(app.config.local?.roles) : [])];
  return [...new Set(names)];
}

/**
 * The Compose project identity, distinct from the shared image prefix when configured.
 */
export function projectNameOf(app: App): string {
  return app.config.projectName ?? app.config.name;
}

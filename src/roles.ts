import { Effect, FileSystem } from 'effect';
import { resolve } from 'node:path';
import { stringify } from 'yaml';

import type { App, DeployConfig, Role, RunOptions } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { readComposeEnvironment } from './compose-environment.ts';
import { environmentOf, roleSecretNames, rolesOf, workingDirectoryOf } from './config/deploy.ts';
import { VARIABLE_NAME_PATTERN } from './config/env-file.ts';
import { isReservedVariable, roleSecretSourceIssue, selectSecretSource } from './config/secrets.ts';
import { DeployError, tryPlan } from './errors.ts';

/**
 * Characters a role environment value may not contain, matching the rule for secret values.
 */
const UNSUPPORTED_VALUE_PATTERN = /[\r\n\0]/;

/**
 * Why a variable name is rejected, shared by environment and secret names.
 */
const PORTABLE_NAME_HINT = 'use a letter or underscore, then letters, digits and underscores';

/**
 * Where one building role's image comes from: the tag it runs under and the absolute build context.
 */
export interface RoleSource {
  /**
   * The tag the role's image is built and run under.
   */
  readonly tag: string;

  /**
   * The absolute build context: the role's `context` resolved against its working directory, else
   * the Git root. With `--tag` nothing is built, so it falls back to the working directory and is
   * never read.
   */
  readonly context: string;
}

/**
 * Image sources by role name, for the roles that build an image.
 */
export type RoleSources = Readonly<Record<string, RoleSource>>;

/**
 * A role's build settings after falling back to the top-level fields and defaults.
 */
export interface RoleBuildSettings {
  /**
   * The role, which is also the Compose service.
   */
  readonly role: string;

  /**
   * The Dockerfile stage, or `undefined` to build the final stage.
   */
  readonly target: string | undefined;

  /**
   * The absolute working directory used for Git checks and as the build's `cwd`.
   */
  readonly workingDirectory: string;

  /**
   * Whether a working directory was configured for the role, at either level.
   */
  readonly workingDirectoryConfigured: boolean;

  /**
   * The absolute Dockerfile path.
   */
  readonly dockerfile: string;

  /**
   * The absolute build context when one is configured; the Git root is used otherwise.
   */
  readonly context: string | undefined;
}

/**
 * The names of the roles that build an image for a run, in configuration order. Only the app's
 * roles can build, and a role that the selected destination or a local run removes with `null`
 * builds nothing.
 */
export function buildingRoles(
  config: DeployConfig,
  options: RunOptions = {},
): ReadonlyArray<string> {
  return Object.entries(rolesOf(config, options))
    .filter(([, role]) => role.build !== undefined)
    .map(([name]) => name);
}

/**
 * The build settings of a role that has `build`: each field falls back to the top-level field of
 * the same name, then to its default (`Dockerfile`, the Git root). Throws when the role has no
 * `build`.
 *
 * A relative `dockerfile` and `context` resolve against the role's working directory and an
 * absolute one is kept as is.
 */
export function buildSettingsOf(app: App, role: string): RoleBuildSettings {
  const roles = app.config.roles ?? {};
  const build = Object.hasOwn(roles, role) ? roles[role]?.build : undefined;
  if (build === undefined) {
    throw new Error(`Role "${role}" has no build`);
  }

  const configured = build.workingDirectory ?? app.config.workingDirectory;
  const workingDirectory = workingDirectoryOf(app, configured);
  const context = build.context ?? app.config.context;
  return {
    role,
    target: build.target,
    workingDirectory,
    workingDirectoryConfigured: configured !== undefined,
    dockerfile: resolve(
      workingDirectory,
      build.dockerfile ?? app.config.dockerfile ?? 'Dockerfile',
    ),
    context: context === undefined ? undefined : resolve(workingDirectory, context),
  };
}

/**
 * The image reference for one role at one tag: prefixed with the registry when the host pulls from
 * one, bare otherwise (local runs and SSH transport, where the image is loaded straight into a
 * daemon).
 */
export function imageReference(
  app: App,
  host: HostConfig,
  role: string,
  tag: string,
  local: boolean,
): string {
  const bare = `${app.config.name}-${role}:${tag}`;
  return !local && host.transport.mode === 'registry' ? `${host.transport.registry}/${bare}` : bare;
}

/**
 * Checks the role settings that need no Compose file: environment names and values, secret names,
 * and a name used as both environment and secret. Throws an `Error` naming the role and variable
 * (never a value) for the first problem found.
 */
export function validateRoleSettings(roles: Readonly<Record<string, Role>>): void {
  for (const [name, role] of Object.entries(roles)) {
    const environment = role.environment ?? {};
    const secrets = role.secrets ?? [];

    for (const [key, value] of Object.entries(environment)) {
      if (!VARIABLE_NAME_PATTERN.test(key)) {
        throw new Error(
          `Role "${name}" environment name ${key} is not portable; ${PORTABLE_NAME_HINT}`,
        );
      }

      if (UNSUPPORTED_VALUE_PATTERN.test(value)) {
        throw new Error(
          `Role "${name}" environment ${key} has a multi-line value; ` +
            'it must be a single line without line breaks or NUL',
        );
      }
    }

    for (const secret of secrets) {
      if (!VARIABLE_NAME_PATTERN.test(secret)) {
        throw new Error(
          `Role "${name}" secret name ${secret} is not portable; ${PORTABLE_NAME_HINT}`,
        );
      }

      if (Object.hasOwn(environment, secret)) {
        throw new Error(`Role "${name}" lists ${secret} in both environment and secrets`);
      }
    }
  }
}

/**
 * Options of `roleOverride`.
 */
export interface RoleOverrideOptions {
  /**
   * The app whose roles are rendered.
   */
  readonly app: App;

  /**
   * The host the images are named for.
   */
  readonly host: HostConfig;

  /**
   * The tag of every building role.
   */
  readonly tags: Readonly<Record<string, string>>;

  /**
   * Whether this is a local run, which merges `local.roles` and names images without a registry.
   * `false` when left out.
   */
  readonly local?: boolean;
}

/**
 * Renders the Compose override that sets each building role's image and each role's container
 * environment, or `undefined` when the app has no roles.
 *
 * Environment values are literal, so `$` is written as `$$`. A role secret is only the reference
 * `${NAME}`: the value stays in the interpolation pool (the stack `.env` or the process
 * environment), so the file never holds a secret. Throws when the role settings are invalid or a
 * building role has no tag.
 */
export function roleOverride({
  app,
  host,
  tags,
  local = false,
}: RoleOverrideOptions): string | undefined {
  const roles = rolesOf(app.config, { local });
  if (Object.keys(roles).length === 0) {
    return undefined;
  }

  validateRoleSettings(roles);

  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, role] of Object.entries(roles)) {
    const service: Record<string, unknown> = {};
    if (role.build !== undefined) {
      const tag = Object.hasOwn(tags, name) ? tags[name] : undefined;
      if (tag === undefined) {
        throw new Error(`No tag for role "${name}"`);
      }

      service.image = imageReference(app, host, name, tag, local);
    }

    const environment = {
      ...Object.fromEntries(
        Object.entries(role.environment ?? {}).map(([key, value]) => [
          key,
          value.replaceAll('$', () => '$$'),
        ]),
      ),
      ...Object.fromEntries((role.secrets ?? []).map((secret) => [secret, `\${${secret}}`])),
    };
    if (Object.keys(environment).length > 0) {
      service.environment = environment;
    }

    if (Object.keys(service).length > 0) {
      services[name] = service;
    }
  }

  if (Object.keys(services).length === 0) {
    return undefined;
  }

  // Double-quoting every string keeps Compose's YAML 1.1 reader from turning plain `1_000`,
  // `0b101` or `2001-12-14` into a number or a date.
  return stringify(
    { services },
    { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 },
  );
}

/**
 * Checks the roles of a run against the run's secret source, environment and Compose files, before
 * any build or host write.
 *
 * Fails with a `DeployError` when a role setting is invalid; a role takes secrets but the run has
 * no secret source; a role secret is a reserved variable or has the name of an `environment`
 * variable of the run; a role is not a service in any selected Compose file (the override would
 * silently create an imageless service); or a service sets in its own `environment:` a variable its
 * role also sets. The Compose rule follows how Compose merges the files: later files and
 * `!reset`/`!override` replace or remove earlier variables, `extends` contributes the base
 * service's variables, and under client execution `include:` files count. Files are parsed locally
 * and no secret value is read; an app without roles reads nothing.
 */
export const validateRoles = Effect.fn('validateRoles')(function* (
  app: App,
  options: RunOptions = {},
): Effect.fn.Return<void, DeployError, FileSystem.FileSystem> {
  const roles = rolesOf(app.config, options);
  if (Object.keys(roles).length === 0) {
    return;
  }

  yield* tryPlan(() => validateRoleSettings(roles), 'Invalid roles');

  if (roleSecretNames(roles).length > 0) {
    const source = yield* Effect.fromResult(selectSecretSource(app, options));
    const sourceIssue = roleSecretSourceIssue(roles, source);
    if (sourceIssue !== undefined) {
      return yield* new DeployError({ message: sourceIssue });
    }
  }

  const environment = environmentOf(app.config, options);
  for (const [name, role] of Object.entries(roles)) {
    for (const secret of role.secrets ?? []) {
      if (isReservedVariable(secret)) {
        return yield* new DeployError({
          message: `Role "${name}" secret ${secret} is a reserved variable; rename it`,
        });
      }

      if (Object.hasOwn(environment, secret)) {
        return yield* new DeployError({
          message:
            `Role "${name}" secret ${secret} has the name of an environment variable; ` +
            'set it in only one place',
        });
      }
    }
  }

  const services = yield* readComposeEnvironment(app, options);
  for (const [name, role] of Object.entries(roles)) {
    const own = services.get(name);
    if (own === undefined) {
      return yield* new DeployError({
        message:
          `Role "${name}" is not a service in the Compose files; ` +
          `services: ${[...services.keys()].join(', ') || 'none'}`,
      });
    }

    const keys = [...Object.keys(role.environment ?? {}), ...(role.secrets ?? [])];
    const clash = keys.find((key) => own.has(key));
    if (clash !== undefined) {
      return yield* new DeployError({
        message:
          `Role "${name}" sets ${clash}, which service ${name} also sets in environment ` +
          `in ${own.get(clash)}; set it in only one place`,
      });
    }
  }
});

import { Effect, type FileSystem, type Path, Result } from 'effect';

import type { App, RunOptions } from './deploy.ts';

import { DeployError } from '../errors.ts';
import { resolveSecrets, type ResolvedSecretsConfig } from '../extensions/config.ts';
import { credentialProvider, isCredentialEnvironment } from '../extensions/credentials.ts';
import { imageVariable } from '../plan.ts';
import { DryRun } from '../services/Shell.ts';
import { declaredSecretSources, environmentOf, secretSettingsIssue } from './deploy.ts';
import { VARIABLE_NAME_PATTERN } from './env-file.ts';

/**
 * Prefixes of the variables Compose, the Docker CLI and Buildx read for their own configuration; a
 * secret with one of them would change how the deployment itself runs.
 */
const RESERVED_PREFIX_PATTERN = /^(?:COMPOSE_|DOCKER_|BUILDX_)/;

/**
 * Process variables a secret may not replace, because shells, loaders and language runtimes on the
 * host read them before any application code runs.
 */
const RESERVED_VARIABLES = new Set([
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'BASH_ENV',
  'ENV',
  'XDG_RUNTIME_DIR',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'PYTHONPATH',
]);

/**
 * Characters a secret value may not contain: the dotenv format written for Compose has no way to
 * carry line breaks, and NUL cannot appear in a process environment.
 */
const UNSUPPORTED_VALUE_PATTERN = /[\r\n\0]/;

/**
 * Selects a complete source, preserving the legacy client dotenv alias.
 *
 * A local run with any production source requires its own explicit source, including `none`, to
 * prevent accidental production credential use. Host-owned legacy dotenv remains a separate SSH
 * compatibility mode.
 */
export function selectSecretSource(
  app: App,
  { local = false }: RunOptions = {},
): Result.Result<ResolvedSecretsConfig | undefined, DeployError> {
  const issue = secretSettingsIssue(app.config);
  if (issue !== undefined) {
    return Result.fail(new DeployError({ message: issue }));
  }

  if (local) {
    const source = app.config.local?.secrets;
    if (source === undefined && declaredSecretSources(app.config).length > 0) {
      return Result.fail(
        new DeployError({
          message: 'Local runs require local.secrets; select a development source or {none:{}}',
        }),
      );
    }

    return Result.succeed(source === undefined ? undefined : resolveSecrets(source));
  }

  if (app.config.secrets !== undefined) {
    return Result.succeed(resolveSecrets(app.config.secrets));
  }

  const path = app.config.envFile;
  return Result.succeed(path === undefined ? undefined : { provider: 'env-file', path });
}

/**
 * Keeps the synchronous planner contract; Effect callers convert `selectSecretSource` with
 * `Effect.fromResult`.
 */
export function secretSource(
  app: App,
  options: RunOptions = {},
): ResolvedSecretsConfig | undefined {
  const selected = selectSecretSource(app, options);
  if (Result.isFailure(selected)) {
    throw new Error(selected.failure.message);
  }

  return selected.success;
}

/**
 * Checks variable names and values before command creation or serialization.
 *
 * Multiline, carriage-return and NUL values are explicitly unsupported. Invalid entries never echo
 * their value or raw name; valid names are safe to report. Secret/non-secret collisions are errors
 * instead of silently winning a merge.
 */
export function validateSecrets(
  app: App,
  values: Readonly<Record<string, string>>,
  { local = false }: RunOptions = {},
): void {
  const imageVariables = new Set(app.config.targets.map(imageVariable));
  const environment = environmentOf(app.config, { local });

  if (imageVariables.size !== app.config.targets.length) {
    throw new Error('Targets must map to distinct image variables');
  }

  for (const [index, [key, value]] of Object.entries(values).entries()) {
    if (!VARIABLE_NAME_PATTERN.test(key) || typeof value !== 'string') {
      throw new Error(`Invalid secret variable at entry ${index + 1}`);
    }

    if (isReservedVariable(key, imageVariables)) {
      throw new Error(`Reserved secret variable: ${key}`);
    }

    if (Object.hasOwn(environment, key)) {
      throw new Error(`Secret variable collides with environment: ${key}`);
    }

    if (UNSUPPORTED_VALUE_PATTERN.test(value)) {
      throw new Error(`Unsupported multiline or NUL secret value: ${key}`);
    }
  }
}

/**
 * Encodes literal Compose dotenv values without interpolation or shell evaluation.
 *
 * Unsupported newlines are rejected upstream; quotes, backslashes, empty strings and dollars retain
 * their contents.
 */
export function secretEnvironment(values: Readonly<Record<string, string>>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}="${dotenvLiteral(value)}"`);
  return lines.join('\n') + '\n';
}

/**
 * Resolves selected provider variables on the CLI machine, suppressing failures and every value in
 * diagnostics.
 *
 * Dry runs validate source selection but fetch no provider and read no secret file. The ordinary
 * check command does not call this function; explicit access checks do, including before a first
 * SSH deployment.
 */
export const readSecrets = Effect.fn('readSecrets')(function* (
  app: App,
  options: RunOptions = {},
): Effect.fn.Return<Record<string, string>, DeployError, FileSystem.FileSystem | Path.Path> {
  const source = yield* Effect.fromResult(selectSecretSource(app, options));
  if (source === undefined || source.provider === 'none' || (yield* DryRun)) {
    return {} as Record<string, string>;
  }

  const provider = yield* Effect.try({
    try: () => credentialProvider(source.provider),
    catch: () => new DeployError({ message: 'Unknown credential provider' }),
  });
  const values = yield* provider.read(source, app.dir);
  yield* Effect.try({
    try: () => validateSecrets(app, values, options),
    catch: (cause) => new DeployError({ message: (cause as Error).message }),
  });

  return { ...values };
});

/**
 * Whether a secret named `key` would replace an image variable, a Docker or Compose setting, a
 * secret provider's credential or a process variable the host's shell and runtimes read.
 */
function isReservedVariable(key: string, imageVariables: ReadonlySet<string>): boolean {
  return (
    imageVariables.has(key) ||
    RESERVED_PREFIX_PATTERN.test(key) ||
    isCredentialEnvironment(key) ||
    RESERVED_VARIABLES.has(key)
  );
}

/**
 * Escapes a value for a double-quoted Compose dotenv entry: backslashes and quotes get a backslash,
 * and `$` is doubled so Compose does not interpolate it.
 */
function dotenvLiteral(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', () => '$$');
}

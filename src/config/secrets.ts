import { Effect, Result } from 'effect';

import type { App } from './deploy.ts';

import { DeployError } from '../errors.ts';
import { resolveSecrets, type ResolvedSecretsConfig } from '../extensions/config.ts';
import { credentialProvider, isCredentialEnvironment } from '../extensions/credentials.ts';
import { imageVariable } from '../plan.ts';
import { DryRun } from '../services/Shell.ts';
import { environmentOf, secretSettingsIssue } from './deploy.ts';

/**
 * Selects a complete source, preserving the legacy client dotenv alias.
 *
 * A local run with any production source requires its own explicit source, including `none`, to
 * prevent accidental production credential use. Host-owned legacy dotenv remains a separate SSH
 * compatibility mode.
 */
export function selectSecretSource(
  app: App,
  local = false,
): Result.Result<ResolvedSecretsConfig | undefined, DeployError> {
  const issue = secretSettingsIssue(app.config);
  if (issue !== undefined) {
    return Result.fail(new DeployError({ message: issue }));
  }

  if (local) {
    const source = app.config.local?.secrets;
    if (
      source === undefined &&
      (app.config.secrets !== undefined ||
        app.config.envFile !== undefined ||
        app.config.remote?.envFile !== undefined)
    ) {
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
export function secretSource(app: App, local = false): ResolvedSecretsConfig | undefined {
  const selected = selectSecretSource(app, local);
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
  local = false,
): void {
  const reserved = new Set(app.config.targets.map(imageVariable));
  const environment = environmentOf(app.config, local);

  if (reserved.size !== app.config.targets.length) {
    throw new Error('Targets must map to distinct image variables');
  }

  for (const [index, [key, value]] of Object.entries(values).entries()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new Error(`Invalid secret variable at entry ${index + 1}`);
    }

    if (
      reserved.has(key) ||
      /^(?:COMPOSE_|DOCKER_|BUILDX_)/.test(key) ||
      isCredentialEnvironment(key) ||
      [
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
      ].includes(key)
    ) {
      throw new Error(`Reserved secret variable: ${key}`);
    }

    if (Object.hasOwn(environment, key)) {
      throw new Error(`Secret variable collides with environment: ${key}`);
    }

    if (/[\r\n\0]/.test(value)) {
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
  return (
    Object.entries(values)
      .map(
        ([key, value]) =>
          `${key}="${value
            .replaceAll('\\', '\\\\')
            .replaceAll('"', '\\"')
            .replaceAll('$', () => '$$')}"`,
      )
      .join('\n') + '\n'
  );
}

/**
 * Resolves selected provider variables on the CLI machine, suppressing failures and every value in
 * diagnostics.
 *
 * Dry runs validate source selection but fetch no provider and read no secret file. The ordinary
 * check command does not call this function; explicit access checks do, including before a first
 * SSH deployment.
 */
export const readSecrets = Effect.fn('readSecrets')(function* (app: App, local = false) {
  const source = yield* Effect.fromResult(selectSecretSource(app, local));
  if (source === undefined || source.provider === 'none' || (yield* DryRun)) {
    return {} as Record<string, string>;
  }

  const provider = yield* Effect.try({
    try: () => credentialProvider(source.provider),
    catch: () => new DeployError({ message: 'Unknown credential provider' }),
  });
  const values = yield* provider.read(source, app.dir);
  yield* Effect.try({
    try: () => validateSecrets(app, values, local),
    catch: (cause) => new DeployError({ message: (cause as Error).message }),
  });

  return { ...values };
});

import type { Effect, FileSystem, Path } from 'effect';

import type { DeployError } from '../errors.ts';
import type { ResolvedSecretsConfig } from './config.ts';

import { onePasswordProvider } from './1password/index.ts';
import { envFileProvider } from './env-file/index.ts';

/**
 * A credential provider's selector, as written in application configuration.
 */
type CredentialProviderId = Exclude<ResolvedSecretsConfig['provider'], 'none'>;

/**
 * A client-side source of Compose credentials.
 *
 * Providers return values only; the deployment core owns source selection, dry runs, validation and
 * secret transport. Failures must contain safe diagnostics, never SDK exceptions, source contents
 * or authentication material.
 */
export interface CredentialProvider {
  /**
   * The source selector used in application configuration.
   */
  readonly id: CredentialProviderId;

  /**
   * The operator environment prefixes masked in commands and stripped from every child process.
   */
  readonly authEnvironmentPrefixes: ReadonlyArray<string>;

  /**
   * Reads the selected source on the CLI machine, resolving relative paths against the deployment
   * directory.
   */
  readonly read: (
    source: ResolvedSecretsConfig,
    directory: string,
  ) => Effect.Effect<Record<string, string>, DeployError, FileSystem.FileSystem | Path.Path>;
}

/**
 * The bundled credential providers, registered without importing an optional SDK eagerly.
 *
 * New providers add their configuration schema and an entry here; Docker execution stays unchanged.
 */
export const credentialProviders = {
  /**
   * A dotenv file on the operator machine.
   */
  'env-file': envFileProvider,

  /**
   * A 1Password Environment, read through the optional SDK.
   */
  '1password': onePasswordProvider,
} as const satisfies Readonly<Record<CredentialProviderId, CredentialProvider>>;

/**
 * Resolves a credential provider, rejecting unsupported selectors instead of falling back to
 * another source.
 */
export function credentialProvider(id: string): CredentialProvider {
  const provider = Object.values(credentialProviders).find((entry) => entry.id === id);
  if (provider === undefined) {
    throw new Error('Unknown credential provider');
  }

  return provider;
}

/**
 * Identifies operator authentication belonging to any bundled provider, including inactive
 * providers.
 *
 * Authentication must not leak into builds, Compose, SSH or Git just because a different source is
 * selected.
 */
export function isCredentialEnvironment(name: string): boolean {
  return Object.values(credentialProviders).some((provider) =>
    provider.authEnvironmentPrefixes.some((prefix) => name.startsWith(prefix)),
  );
}

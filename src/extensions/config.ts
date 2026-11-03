import { Effect, type FileSystem, type Path, Schema } from 'effect';

import type { App } from '../config/deploy.ts';
import type { HostConfig } from '../config/hosts.ts';
import type { DeployError } from '../errors.ts';

import { OnePasswordConfig, OnePasswordSelection } from './1password/config.ts';
import {
  CaddyIngress,
  CaddySelection,
  CaddyHostSelection,
  ProxyConfig as CaddyProxy,
} from './caddy/config.ts';
import { loadAppTemplates, loadHostTemplates } from './caddy/templates.ts';
import {
  CloudflareIngress,
  CloudflareSelection,
  CloudflareHostSelection,
  CloudflareProxy,
} from './cloudflare-tunnel/config.ts';
import { loadCloudflareAppFiles, loadCloudflareHostFiles } from './cloudflare-tunnel/templates.ts';
import { EnvFileConfig, EnvFileSelection } from './env-file/config.ts';

export { CaddyIngress, HealthPath } from './caddy/config.ts';

/**
 * The explicit extension opt-out, with no settings and no implicit provider fallback.
 */
export const NoExtension = Schema.Struct({
  /**
   * The empty settings object selecting no extension.
   */
  none: Schema.Record(Schema.String, Schema.Never),
});

/**
 * The legacy ingress opt-out retained for existing app files.
 */
export const NoIngress = Schema.Struct({
  /**
   * The legacy empty ingress selector.
   */
  mode: Schema.Literal('none'),
});

/**
 * The internal ingress representation used by deployment planners after resolving extension
 * settings.
 */
export const ResolvedIngress = Schema.Union([CaddyIngress, CloudflareIngress, NoIngress]);

/**
 * The application ingress input, selecting exactly one extension and validating its own required
 * settings.
 *
 * Flat legacy selections remain accepted during migration. Strict YAML decoding rejects ambiguous
 * or misspelled selectors.
 */
export const Ingress = Schema.Union([
  CaddySelection,
  CloudflareSelection,
  NoExtension,
  ResolvedIngress,
]);

/**
 * Host ingress capabilities: either provider, both providers, or an explicit opt-out.
 */
export const HostIngress = Schema.Union([
  Schema.Struct({ ...CaddyHostSelection.fields, ...CloudflareHostSelection.fields }),
  CaddyHostSelection,
  CloudflareHostSelection,
  NoExtension,
]);

/**
 * The internal host proxy representation and legacy hosts.yaml input.
 */
export const ProxyConfig = Schema.Union([CaddyProxy, CloudflareProxy]);

/**
 * The normalized credential provider inputs, never containing resolved secret values.
 */
export const ResolvedSecretsConfig = Schema.Union([
  EnvFileConfig,
  OnePasswordConfig,
  Schema.Struct({
    /**
     * The legacy empty source selector.
     */
    provider: Schema.Literal('none'),
  }),
]);

/**
 * The named credential source input, with flat legacy sources retained for migration.
 */
export const SecretsConfig = Schema.Union([
  EnvFileSelection,
  OnePasswordSelection,
  NoExtension,
  ResolvedSecretsConfig,
]);

/**
 * The decoded application ingress input.
 */
export type Ingress = typeof Ingress.Type;

/**
 * The normalized application ingress selection.
 */
export type ResolvedIngress = typeof ResolvedIngress.Type;

/**
 * An ingress provider's internal identifier, shared by host selection and app planning.
 */
export type IngressId = Exclude<ResolvedIngress['mode'], 'none'>;

/**
 * The decoded host ingress input.
 */
export type HostIngress = typeof HostIngress.Type;

/**
 * The normalized host proxy settings.
 */
export type ProxyConfig = typeof ProxyConfig.Type;

/**
 * The decoded credential source input.
 */
export type SecretsConfig = typeof SecretsConfig.Type;

/**
 * The normalized credential provider selection.
 */
export type ResolvedSecretsConfig = typeof ResolvedSecretsConfig.Type;

/**
 * Loads extension-owned host files relative to the winning host definition before pure planning.
 */
export function loadHostExtensionFiles(
  host: HostConfig,
  file: string,
): Effect.Effect<HostConfig, DeployError, FileSystem.FileSystem | Path.Path> {
  return loadHostTemplates(host, file).pipe(
    Effect.flatMap((selected) => loadCloudflareHostFiles(selected, file)),
  );
}

/**
 * Loads extension-owned app files after destination selection, leaving unselected sources unread.
 */
export function loadAppExtensionFiles(
  app: App,
): Effect.Effect<App, DeployError, FileSystem.FileSystem | Path.Path> {
  return loadAppTemplates(app).pipe(Effect.flatMap(loadCloudflareAppFiles));
}

/**
 * Resolves named app settings to the provider's existing planning contract without changing
 * execution behavior.
 */
export function resolveIngress(config: Ingress): ResolvedIngress {
  if ('mode' in config) {
    return config;
  }

  if ('caddy' in config) {
    return { mode: 'caddy', ...config.caddy };
  }

  if ('cloudflare-tunnel' in config) {
    return { mode: 'cloudflare-tunnel', ...config['cloudflare-tunnel'] };
  }

  return { mode: 'none' };
}

/**
 * Selects a host capability, requiring an explicit provider when the host supports both.
 */
export function resolveHostIngress(
  config: HostIngress,
  provider?: IngressId,
): ProxyConfig | undefined {
  if (provider === undefined && 'caddy' in config && 'cloudflare-tunnel' in config) {
    throw new Error(
      'Host has multiple ingress providers; select --ingress caddy or --ingress cloudflare-tunnel',
    );
  }

  if ('caddy' in config && (provider === undefined || provider === 'caddy')) {
    return { provider: 'caddy', ...config.caddy };
  }

  if (
    'cloudflare-tunnel' in config &&
    (provider === undefined || provider === 'cloudflare-tunnel')
  ) {
    return { provider: 'cloudflare-tunnel', ...config['cloudflare-tunnel'] };
  }

  return undefined;
}

/**
 * Resolves named source settings without accessing a credential provider or reading any secret
 * file.
 */
export function resolveSecrets(config: SecretsConfig): ResolvedSecretsConfig {
  if ('provider' in config) {
    return config;
  }

  if ('1password' in config) {
    return { provider: '1password', ...config['1password'] };
  }

  if ('env-file' in config) {
    return { provider: 'env-file', ...config['env-file'] };
  }

  return { provider: 'none' };
}

import { Effect, type FileSystem, type Path, Schema } from 'effect';

import type { App } from '../config/deploy.ts';
import type { HostConfig } from '../config/hosts.ts';
import type { DeployError } from '../errors.ts';
import type { OnePasswordConfig } from './1password/config.ts';
import type { CaddyIngress, ProxyConfig as CaddyProxy } from './caddy/config.ts';
import type { CloudflareIngress, CloudflareProxy } from './cloudflare-tunnel/config.ts';
import type { EnvFileConfig } from './env-file/config.ts';

import { OnePasswordSelection } from './1password/config.ts';
import { CaddySelection, CaddyHostSelection } from './caddy/config.ts';
import { loadAppTemplates, loadHostTemplates } from './caddy/templates.ts';
import { CloudflareSelection, CloudflareHostSelection } from './cloudflare-tunnel/config.ts';
import { loadCloudflareAppFiles, loadCloudflareHostFiles } from './cloudflare-tunnel/templates.ts';
import { EnvFileSelection } from './env-file/config.ts';

export { HealthPath } from './caddy/config.ts';
export type { CaddyIngress } from './caddy/config.ts';

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
 * The application ingress input, selecting exactly one extension and validating its own required
 * settings. Strict YAML decoding rejects ambiguous or misspelled selectors.
 */
export const Ingress = Schema.Union([CaddySelection, CloudflareSelection, NoExtension]);

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
 * The named credential source input, selecting exactly one provider or `none`.
 */
export const SecretsConfig = Schema.Union([EnvFileSelection, OnePasswordSelection, NoExtension]);

/**
 * The decoded application ingress input.
 */
export type Ingress = typeof Ingress.Type;

/**
 * An app that routes through no ingress extension, as planners see it.
 */
export type NoIngress = {
  /**
   * Marks the app as routed through no extension.
   */
  readonly mode: 'none';
};

/**
 * The application ingress as deployment planners see it: the selected extension's settings tagged
 * with its `mode`.
 */
export type ResolvedIngress = CaddyIngress | CloudflareIngress | NoIngress;

/**
 * An ingress provider's internal identifier, shared by host selection and app planning.
 */
export type IngressId = Exclude<ResolvedIngress['mode'], 'none'>;

/**
 * The decoded host ingress input.
 */
export type HostIngress = typeof HostIngress.Type;

/**
 * One host ingress capability as extensions see it: the provider's settings tagged with its
 * `provider`.
 */
export type ProxyConfig =
  | ({ readonly provider: 'caddy' } & CaddyProxy)
  | ({ readonly provider: 'cloudflare-tunnel' } & CloudflareProxy);

/**
 * The decoded credential source input.
 */
export type SecretsConfig = typeof SecretsConfig.Type;

/**
 * The credential source as providers see it: the selected provider's settings tagged with its
 * `provider`, never containing resolved secret values.
 */
export type ResolvedSecretsConfig =
  | EnvFileConfig
  | OnePasswordConfig
  | { readonly provider: 'none' };

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
 * Tags the selected extension's app settings with its `mode`, the shape deployment planners take.
 */
export function resolveIngress(config: Ingress): ResolvedIngress {
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
 * Tags the selected source's settings with its `provider`, without accessing a credential provider
 * or reading any secret file.
 */
export function resolveSecrets(config: SecretsConfig): ResolvedSecretsConfig {
  if ('1password' in config) {
    return { provider: '1password', ...config['1password'] };
  }

  if ('env-file' in config) {
    return { provider: 'env-file', ...config['env-file'] };
  }

  return { provider: 'none' };
}

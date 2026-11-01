import type { Check } from '../checks.ts';
import type { App } from '../config/deploy.ts';
import type { HostConfig } from '../config/hosts.ts';
import type { ResolvedIngress, SecretsConfig } from './config.ts';

import { shellQuote } from '../command.ts';
import { ingressOf } from '../config/deploy.ts';
import { ingressConfigOf } from '../config/hosts.ts';
import { caddyIngress } from './caddy/index.ts';
import { cloudflareIngress } from './cloudflare-tunnel/index.ts';

/**
 * A host operation planned by an ingress extension and executed by the core Remote service.
 *
 * Scripts must target Bash 3.2 and accept any payload on stdin; labels describe the operation for dry runs.
 */
export interface IngressOperation {
  /**
   * The host script, never executed while planning.
   */
  readonly script: string;

  /**
   * The optional configuration sent on stdin, without credentials.
   */
  readonly input?: string;

  /**
   * Optional setup-only credential source, resolved after dry-run handling; never frozen into application stacks.
   */
  readonly secrets?: SecretsConfig;

  /**
   * Selected provider variable names mapped to connector env-file names; other provider values are discarded.
   */
  readonly secretVariables?: Readonly<Record<string, string>>;

  /**
   * The concise description displayed by the Remote service.
   */
  readonly label: string;
}

/**
 * The complete routing plan retained with deployed SSH configuration or executed after client Compose.
 */
export interface IngressPlan {
  /**
   * The human-readable route identity used in progress messages.
   */
  readonly description: string;

  /**
   * The route activation operation, including provider validation and recovery on failure.
   */
  readonly route: IngressOperation;

  /**
   * The matching removal operation, safe when the route is already absent.
   */
  readonly unroute: IngressOperation;

  /**
   * The optional public URL probed after activation.
   */
  readonly healthUrl?: string;
}

/**
 * A pure ingress integration covering checks, host setup, activation and removal.
 *
 * Extensions describe operations; Docker, SSH execution, dry runs and stack files remain core responsibilities.
 */
export interface IngressExtension {
  /**
   * The selector used by app ingress and host proxy configuration.
   */
  readonly id: Exclude<ResolvedIngress['mode'], 'none'>;

  /**
   * Plans activation and removal, rejecting missing or incompatible host settings.
   */
  readonly plan: (app: App, host: HostConfig) => IngressPlan;

  /**
   * Plans the explicit host setup operation; deployments never perform setup implicitly.
   */
  readonly setup: (host: HostConfig) => IngressOperation;

  /**
   * The optional public domain for readiness DNS lookup.
   */
  readonly domain: (app: App, host: HostConfig) => string | undefined;

  /**
   * Plans a read-only host probe producing key=value output, or skips it when host configuration is missing.
   */
  readonly probe: (app: App, host: HostConfig) => string | undefined;

  /**
   * Interprets DNS and probe results, including actionable failures for missing host configuration.
   */
  readonly checks: (
    app: App,
    host: HostConfig,
    addresses: ReadonlyArray<string>,
    probe: Record<string, string>,
  ) => ReadonlyArray<Check>;
}

/**
 * The bundled ingress extensions; additional implementations register here alongside their configuration schemas.
 */
export const ingressExtensions = {
  'caddy-sites': caddyIngress,
  'cloudflare-tunnel': cloudflareIngress,
} as const satisfies Readonly<Record<Exclude<ResolvedIngress['mode'], 'none'>, IngressExtension>>;

/**
 * Resolves a supported ingress extension without silently ignoring an unknown selector.
 */
export function ingressExtension(id: string): IngressExtension {
  const extension = Object.values(ingressExtensions).find((entry) => entry.id === id);
  if (extension === undefined) {
    throw new Error('Unknown ingress extension');
  }

  return extension;
}

/**
 * Resolves application ingress; omitted or explicit none requires no extension or host proxy.
 */
export function ingressFor(app: App): IngressExtension | undefined {
  const mode = ingressOf(app.config).mode;
  return mode === 'none' ? undefined : ingressExtension(mode);
}

/**
 * Resolves host setup, preserving Caddy as the default for existing proxy entries without a provider selector.
 */
export function hostIngress(host: HostConfig): IngressExtension {
  const proxy = ingressConfigOf(host);
  if (proxy === undefined) {
    throw new Error('Host has no proxy entry; configure an ingress extension before setup-proxy');
  }

  return ingressExtension(proxy.provider ?? 'caddy-sites');
}

/**
 * Freezes an ingress operation into a standalone host script without executing it.
 *
 * Quoted printf input preserves literal configuration and cannot collide with a heredoc delimiter in an extension's
 * payload. Credentials are forbidden in ingress plans; managed secrets use the private deployment stdin channel.
 */
export function ingressOperationScript(operation: IngressOperation): string {
  return operation.input === undefined
    ? operation.script
    : `set -euo pipefail\nprintf '%s' ${shellQuote(operation.input)} | bash -c ${shellQuote(operation.script)}\n`;
}

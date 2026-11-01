import { Schema } from 'effect';

import { AbsolutePath, Domain, HealthPath } from '../../config/schema.ts';

/**
 * The public HTTP application routed through an existing remotely managed Cloudflare Tunnel.
 *
 * The service URL is resolved from the connector's network, not from the CLI machine. Authentication in URLs is
 * deliberately unsupported so generated plans and release scripts contain no credentials.
 */
export const CloudflareSettings = Schema.Struct({
  /**
   * The public hostname with an operator-managed proxied CNAME to the tunnel.
   */
  domain: Domain,

  /**
   * The HTTP or HTTPS origin reachable by every connector, such as http://web:8080.
   */
  service: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?\/?$/, {
        message: 'expected an HTTP(S) origin without credentials, query or path',
      }),
    ),
  ),

  /**
   * The public readiness path, defaulting to /.
   */
  healthPath: Schema.optionalKey(HealthPath),
});

/**
 * The existing Cloudflare Tunnel and host-local operator authentication used to manage its application routes.
 *
 * Tunnel creation, connector installation, DNS and Access policies remain operator-owned. One host and state directory
 * must own configuration writes for a shared tunnel; the API replaces the full configuration without a
 * compare-and-swap.
 */
export const CloudflareHostSettings = Schema.Struct({
  /**
   * The Cloudflare account identifier containing the existing tunnel.
   */
  accountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{32}$/))),

  /**
   * The existing remotely managed tunnel UUID.
   */
  tunnelId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/))),

  /**
   * The absolute host file containing only a Cloudflare API token, never the connector's tunnel token.
   */
  apiTokenFile: AbsolutePath,

  /**
   * The private host directory containing per-tunnel route ownership journals and a shared mutation lock.
   */
  stateDir: AbsolutePath,
});

/**
 * The legacy flat app configuration and normalized runtime representation.
 */
export const CloudflareIngress = Schema.Struct({
  /**
   * The legacy mode selector.
   */
  mode: Schema.Literal('cloudflare-tunnel'),
  ...CloudflareSettings.fields,
});

/**
 * The legacy flat host configuration and normalized runtime representation.
 */
export const CloudflareProxy = Schema.Struct({
  /**
   * The legacy host provider selector.
   */
  provider: Schema.Literal('cloudflare-tunnel'),
  ...CloudflareHostSettings.fields,
});

/**
 * The named Cloudflare Tunnel app configuration.
 */
export const CloudflareSelection = Schema.Struct({
  /**
   * The selected extension's public application settings.
   */
  'cloudflare-tunnel': CloudflareSettings,
});

/**
 * The named Cloudflare Tunnel host configuration.
 */
export const CloudflareHostSelection = Schema.Struct({
  /**
   * The selected extension's existing tunnel and host credential path.
   */
  'cloudflare-tunnel': CloudflareHostSettings,
});

/**
 * The decoded Cloudflare application settings.
 */
export type CloudflareIngress = typeof CloudflareIngress.Type;

/**
 * The decoded Cloudflare host settings, containing paths and identifiers but no secret values.
 */
export type CloudflareProxy = typeof CloudflareProxy.Type;

import { Schema } from 'effect';

import {
  AbsolutePath,
  ComposeServiceName,
  Domain,
  HealthPath,
  Name,
  NetworkName,
} from '../../config/schema.ts';
import { OnePasswordSelection } from '../1password/config.ts';
import { CaddyTemplate } from '../caddy/config.ts';
import { EnvFileSelection } from '../env-file/config.ts';

/**
 * A Compose filename inside the connector directory: a plain name ending in `.yaml` or `.yml`, with
 * no path separators.
 */
export const COMPOSE_FILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/;

/**
 * The longest drain deadline or connection wait accepted for a provisioned connector, in seconds.
 */
const MAX_CONNECTOR_WAIT_SECONDS = 60 * 60;

/**
 * The error shown when host settings fail `validCloudflareHost`.
 */
const HOST_REQUIREMENTS_MESSAGE =
  'Managed Cloudflare routing requires apiTokenFile/stateDir; ' +
  'provisioning/manual routing requires dir, container and network';

/**
 * Host validation is shared by named and legacy inputs; spreading fields alone would drop Struct
 * refinements.
 */
function validCloudflareHost(config: {
  routing?: string;
  apiTokenFile?: string;
  stateDir?: string;
  provision?: unknown;
  dir?: string;
  container?: string;
  network?: string;
}): boolean {
  if (
    config.routing !== 'manual' &&
    (config.apiTokenFile === undefined || config.stateDir === undefined)
  ) {
    return false;
  }

  if (config.provision !== undefined || config.routing === 'manual') {
    return (
      config.dir !== undefined && config.container !== undefined && config.network !== undefined
    );
  }

  return true;
}

/**
 * Connector provisioning is explicit; credentials come from one source and never from configuration
 * literals.
 */
export const CloudflareProvision = Schema.Struct({
  /**
   * Override the bundled digest-pinned cloudflared image.
   */
  image: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/)),
  ),

  /**
   * An existing host dotenv file containing TUNNEL_TOKEN, read only by Docker.
   */
  envFile: Schema.optionalKey(AbsolutePath),

  /**
   * A native client credential provider whose selected token is staged privately on the host.
   */
  secrets: Schema.optionalKey(Schema.Union([OnePasswordSelection, EnvFileSelection])),

  /**
   * The provider variable mapped to TUNNEL_TOKEN; defaults to CLOUDFLARE_TUNNEL_TOKEN.
   */
  tokenVariable: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  ),

  /**
   * Numeric nonroot UID:GID; defaults to 65532:65532.
   */
  user: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[1-9][0-9]*:[0-9]+$/))),

  /**
   * In-flight request drain deadline; Docker allows ten additional seconds for exit.
   */
  gracePeriodSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CONNECTOR_WAIT_SECONDS })),
  ),

  /**
   * The bounded Compose connection-readiness wait, defaulting to 120 seconds.
   */
  waitTimeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CONNECTOR_WAIT_SECONDS })),
  ),
}).check(
  Schema.makeFilter((p) => (p.envFile === undefined) !== (p.secrets === undefined), {
    message: 'Cloudflare provision requires exactly one of envFile or secrets',
  }),
);

/**
 * The public HTTP application routed through an existing remotely managed Cloudflare Tunnel.
 *
 * The service URL is resolved from the connector's network, not from the CLI machine.
 * Authentication in URLs is deliberately unsupported so generated plans and host scripts contain no
 * credentials.
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

  /**
   * Optional YAML route template, resolved relative to deploy.yaml after destination selection.
   */
  routeTemplate: Schema.optionalKey(CaddyTemplate),
});

/**
 * The existing Cloudflare Tunnel and host-local operator authentication used to manage its
 * application routes.
 *
 * Tunnel creation, connector installation, DNS and Access policies remain operator-owned. One host
 * and state directory must own configuration writes for a shared tunnel; the API replaces the full
 * configuration without a compare-and-swap.
 */
export const CloudflareHostSettings = Schema.Struct({
  /**
   * The Cloudflare account identifier containing the existing tunnel.
   */
  accountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{32}$/))),

  /**
   * The existing remotely managed tunnel UUID.
   */
  tunnelId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)),
  ),

  /**
   * The absolute host file containing only a Cloudflare API token, never the connector's tunnel
   * token.
   */
  apiTokenFile: Schema.optionalKey(AbsolutePath),

  /**
   * Managed routing is the default; manual routing leaves dashboard rules untouched and needs no
   * API token.
   */
  routing: Schema.optionalKey(Schema.Literals(['managed', 'manual'])),

  /**
   * Connector stack directory, required when provisioning or checking a manual ingress.
   */
  dir: Schema.optionalKey(AbsolutePath),

  /**
   * Stable connector container identity, also used for health checks and ownership validation.
   */
  container: Schema.optionalKey(Name),

  /**
   * Shared Docker network applications join with unique service aliases.
   */
  network: Schema.optionalKey(NetworkName),

  /**
   * Compose service name; defaults to connector.
   */
  service: Schema.optionalKey(ComposeServiceName),

  /**
   * Compose filename within dir; defaults to compose.yaml.
   */
  composeFile: Schema.optionalKey(Schema.String.check(Schema.isPattern(COMPOSE_FILE_NAME_PATTERN))),

  /**
   * Opt-in host connector provisioning; absent settings keep existing connectors operator-managed.
   */
  provision: Schema.optionalKey(CloudflareProvision),

  /**
   * File or inline Compose and per-application route templates.
   */
  templates: Schema.optionalKey(
    Schema.Struct({
      /**
       * Complete connector Compose template, loaded relative to the host definition.
       */
      compose: Schema.optionalKey(CaddyTemplate),

      /**
       * Default YAML route template for applications on this host.
       */
      route: Schema.optionalKey(CaddyTemplate),
    }),
  ),

  /**
   * The private host directory containing per-tunnel route ownership journals and a shared mutation
   * lock.
   */
  stateDir: Schema.optionalKey(AbsolutePath),
}).check(Schema.makeFilter(validCloudflareHost, { message: HOST_REQUIREMENTS_MESSAGE }));

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
}).check(Schema.makeFilter(validCloudflareHost, { message: HOST_REQUIREMENTS_MESSAGE }));

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

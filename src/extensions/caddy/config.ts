import { Schema } from 'effect';
import { isIP } from 'node:net';

import {
  AbsolutePath,
  ComposeServiceName,
  Domain,
  HealthPath,
  Name,
  NetworkName,
  SnippetName,
  Upstream,
} from '../../config/schema.ts';

/**
 * An optional DNS assertion accepts either IP family; Caddy itself does not need the host IP.
 */
const DnsAddress = Schema.String.check(Schema.makeFilter((value) => !value.includes('%') && isIP(value) !== 0));

/**
 * A local template filename or inline template text; file sources are loaded before planning.
 */
export const CaddyTemplate = Schema.Union([
  Schema.String.check(Schema.isPattern(/^[^\r\n]*\S[^\r\n]*$/)),
  Schema.Struct({
    /**
     * The complete template text, with literal Caddy syntax and optional compoza placeholders.
     */
    inline: Schema.String,
  }),
]);

/**
 * A template source, resolved to inline text by the configuration loader.
 */
export type CaddyTemplate = typeof CaddyTemplate.Type;

/**
 * Routing through the host's shared Caddy: deploy writes a site file for `domain` that proxies to `upstream` on the
 * proxy's network, and waits for `https://<domain><healthPath>` to answer (`healthPath` defaults to `/`).
 */
export const CaddySettings = Schema.Struct({
  /**
   * The public domain; it needs an A or AAAA record before the first deploy.
   */
  domain: Domain,

  /**
   * The container name (or alias) and port on the proxy's network that serves the domain.
   */
  upstream: Upstream,

  /**
   * The path probed after a deploy, defaulting to `/`. Any status below 500 counts as up.
   */
  healthPath: Schema.optionalKey(HealthPath),

  /**
   * An app-specific site template overriding the host default, relative to deploy.json when it is a filename.
   */
  siteTemplate: Schema.optionalKey(CaddyTemplate),
});

/**
 * The legacy flat Caddy app selection, retained for existing deploy files and normalized runtime plans.
 */
export const CaddyIngress = Schema.Struct({
  /**
   * The legacy mode selector.
   */
  mode: Schema.Literal('caddy-sites'),
  ...CaddySettings.fields,
});

/**
 * The named Caddy application configuration with settings scoped to the extension.
 */
export const CaddySelection = Schema.Struct({
  /**
   * The selected extension's application routing settings.
   */
  caddy: CaddySettings,
});

/**
 * The decoded Caddy routing settings.
 */
export type CaddyIngress = typeof CaddyIngress.Type;

/**
 * Opt-in creation of a shared Caddy stack; credentials remain in an operator-provided file on the host.
 */
export const CaddyProvision = Schema.Struct({
  /**
   * The Caddy image, including any required DNS modules; a tag or digest can pin the version.
   */
  image: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/)),

  /**
   * An existing absolute host env-file path passed to Caddy without interpolation.
   */
  envFile: Schema.optionalKey(AbsolutePath),

  /**
   * The global acme_dns arguments, e.g. cloudflare {env.CLOUDFLARE_API_TOKEN}; never put credentials here.
   */
  acmeDns: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\S[^\r\n]*$/))),

  /**
   * Additional DNS aliases for Caddy on the shared Docker network.
   */
  networkAliases: Schema.optionalKey(Schema.Array(Domain)),

  /**
   * The default template's drain limit in seconds (1–3600, default 30); Docker allows ten extra seconds to exit.
   */
  gracePeriodSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 }))),
});

/**
 * The shared Caddy that routes public domains on a host, for apps whose ingress is `caddy-sites`.
 *
 * `setup-proxy` makes this Caddy load every `sites/*.caddy` file next to its Caddyfile; deploy then writes one file per
 * app. The optional `tls` and `logSnippet` settings go into every site file, so the host decides how certificates are
 * issued and requests are logged, not the app.
 */
export const CaddyHostSettings = Schema.Struct({
  /**
   * Folder on the host holding the proxy's Caddyfile and Compose file.
   */
  dir: AbsolutePath,

  /**
   * Name of the running Caddy container, used for `docker exec` (`caddy reload`) and `docker inspect`.
   */
  container: Name,

  /**
   * The Compose service name of the Caddy container in the proxy's Compose file, which `setup-proxy` recreates with
   * `docker compose up -d`; defaults to the value of `container`.
   *
   * Compose names containers `<project>-<service>-1` unless the service sets `container_name`, so the two differ on any
   * proxy that does not pin its container name.
   */
  service: Schema.optionalKey(ComposeServiceName),

  /**
   * Docker network Caddy shares with the apps it routes to.
   */
  network: NetworkName,

  /**
   * The proxy's Compose file name inside `dir`; defaults to `docker-compose.yaml`.
   */
  composeFile: Schema.optionalKey(Schema.String),

  /**
   * The body of the `tls` block written into every site file, for example `dns cloudflare {env.CLOUDFLARE_API_TOKEN}`.
   * Left out, Caddy issues certificates its default way (HTTP or TLS-ALPN challenges).
   */
  tls: Schema.optionalKey(Schema.String),

  /**
   * A snippet defined in the shared Caddyfile that every site file imports with the app name as its argument, for
   * example a `request_log` snippet writing `/data/<app>.log`. Left out, site files import nothing.
   */
  logSnippet: Schema.optionalKey(SnippetName),

  /**
   * Creates a fresh proxy stack instead of adapting existing files; reruns require unchanged generated files.
   */
  provision: Schema.optionalKey(CaddyProvision),

  /**
   * Shared Caddy templates, with paths relative to the JSON file declaring this host.
   */
  templates: Schema.optionalKey(
    Schema.Struct({
      /**
       * The default template for each app's site block.
       */
      site: Schema.optionalKey(CaddyTemplate),

      /**
       * The root Caddyfile template used when provisioning a new stack.
       */
      config: Schema.optionalKey(CaddyTemplate),
    }),
  ),
});

/**
 * The legacy flat Caddy host configuration used internally after resolving named ingress settings.
 */
export const ProxyConfig = Schema.Struct({
  /**
   * The legacy extension selector, optional for older host entries.
   */
  provider: Schema.optionalKey(Schema.Literal('caddy-sites')),

  /**
   * The Caddy DNS address, falling back to the legacy host address when omitted.
   */
  address: Schema.optionalKey(DnsAddress),
  ...CaddyHostSettings.fields,
});

/**
 * The named Caddy host selection, including an optional expected DNS address.
 */
export const CaddyHostSelection = Schema.Struct({
  /**
   * The selected extension's shared proxy and DNS settings.
   */
  caddy: Schema.Struct({
    /**
     * An optional IPv4 or IPv6 address that public app DNS answers must include.
     */
    address: Schema.optionalKey(DnsAddress),
    ...CaddyHostSettings.fields,
  }),
});

/**
 * The decoded shared Caddy host settings.
 */
export type ProxyConfig = typeof ProxyConfig.Type;

/**
 * The proxy's Compose file name when the host entry leaves it out.
 */
export const DEFAULT_PROXY_COMPOSE_FILE = 'docker-compose.yaml';

/**
 * The proxy's Compose file name, with its default applied.
 */
export function proxyComposeFile(proxy: ProxyConfig): string {
  return proxy.composeFile ?? DEFAULT_PROXY_COMPOSE_FILE;
}

/**
 * The Compose service name of the proxy's Caddy, falling back to its container name when the entry leaves `service`
 * out.
 */
export function proxyService(proxy: ProxyConfig): string {
  return proxy.service ?? proxy.container;
}

export { HealthPath } from '../../config/schema.ts';

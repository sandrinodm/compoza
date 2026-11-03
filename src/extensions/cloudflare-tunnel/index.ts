import { readFileSync } from 'node:fs';

import type { Check } from '../../checks.ts';
import type { App } from '../../config/deploy.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { IngressExtension } from '../ingress.ts';
import type { CloudflareProxy } from './config.ts';

import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { ingressOf, projectNameOf } from '../../config/deploy.ts';
import { ingressConfigOf } from '../../config/hosts.ts';
import { provisionOperation } from './provision.ts';
import { routeRule } from './templates.ts';

/**
 * The route script for manually routed tunnels. Their published routes are edited in the Cloudflare
 * dashboard, so activating or removing an application changes nothing.
 */
const MANUAL_ROUTE_SCRIPT = [
  'set -eu',
  '# Published routes are operator-managed in Cloudflare.',
  'true',
  '',
].join('\n');

/**
 * The `docker inspect` template printing whether the connector runs and, when it defines a health
 * check, its health status. A ready connector prints `true healthy`.
 */
const CONNECTOR_STATE_FORMAT =
  '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}';

/**
 * The shell block that fails setup when the connector probe found the network or connector missing
 * or unhealthy.
 */
const CONNECTOR_READY_GUARD = [
  'if [ "$ready" != yes ]; then',
  "  echo 'Cloudflare connector/network is not healthy; " +
    "run setup-proxy with provision or prepare the connector' >&2",
  '  exit 1',
  'fi',
].join('\n');

/**
 * What a host script does: prepare route ownership storage, probe readiness, or apply or remove one
 * application's route.
 */
type ScriptAction = 'setup' | 'probe' | 'route' | 'unroute';

/**
 * Selects Cloudflare host settings without accepting a different ingress implementation
 * accidentally.
 */
function proxyFor(host: HostConfig): CloudflareProxy | undefined {
  const proxy = ingressConfigOf(host, 'cloudflare-tunnel');
  return proxy?.provider === 'cloudflare-tunnel' ? proxy : undefined;
}

/**
 * Selects Cloudflare host settings for planning, throwing when the host has no Cloudflare Tunnel
 * ingress.
 */
function requireProxy(host: HostConfig): CloudflareProxy {
  const proxy = proxyFor(host);
  if (proxy === undefined) {
    throw new Error('cloudflare-tunnel requires a matching host proxy');
  }

  return proxy;
}

/**
 * Reads Cloudflare app settings before generating any public route operation.
 */
function settings(app: App) {
  const ingress = ingressOf(app.config);
  if (ingress?.mode !== 'cloudflare-tunnel') {
    throw new Error('Invalid Cloudflare Tunnel ingress selection');
  }

  return ingress;
}

/**
 * Builds self-contained host operations from installed Bash/jq assets and non-secret configuration.
 *
 * SSH stack operations embed these sources just like the Caddy operations. Only the host reads its
 * API token; the script contains a token file path but never the token itself.
 */
function script(proxy: CloudflareProxy, action: ScriptAction, app?: App): string {
  if (proxy.routing === 'manual') {
    if (action === 'route' || action === 'unroute') {
      return MANUAL_ROUTE_SCRIPT;
    }

    return connectorProbe(proxy, action === 'setup');
  }

  if (proxy.apiTokenFile === undefined || proxy.stateDir === undefined) {
    throw new Error('Managed Cloudflare routing requires apiTokenFile');
  }

  const root = `${proxy.stateDir}/${proxy.accountId}-${proxy.tunnelId}`;
  const owner = app === undefined ? 'setup' : projectNameOf(app);
  const rule = app === undefined ? [] : [routeRule(proxy, app, projectNameOf(app))];
  const wanted = action === 'unroute' ? [] : rule;
  const runtime = readFileSync(new URL('./runtime.sh', import.meta.url), 'utf8');
  const merge = readFileSync(new URL('./merge.jq', import.meta.url), 'utf8');
  const probeConnector =
    action === 'probe' && proxy.container !== undefined && proxy.network !== undefined;
  return [
    'set +x',
    'set -euo pipefail',
    REMOTE_PATH,
    `cf_account=${shellQuote(proxy.accountId)}`,
    `cf_tunnel=${shellQuote(proxy.tunnelId)}`,
    `cf_token_file=${shellQuote(proxy.apiTokenFile)}`,
    `cf_state_dir=${shellQuote(proxy.stateDir)}`,
    `cf_root=${shellQuote(root)}`,
    `cf_owner_file=${shellQuote(`${root}/routes/${owner}.json`)}`,
    `cf_wanted=${shellQuote(JSON.stringify(wanted))}`,
    `cf_merge_filter=${shellQuote(merge)}`,
    runtime,
    runtimeCommand(action),
    probeConnector ? connectorProbe(proxy) : '',
    '',
  ].join('\n');
}

/**
 * Names the runtime.sh function that performs a managed-routing action.
 */
function runtimeCommand(action: ScriptAction): string {
  switch (action) {
    case 'probe':
      return 'cf_probe';
    case 'setup':
      return 'cf_setup';
    case 'route':
    case 'unroute':
      return 'cf_mutate';
  }
}

/**
 * Reads local connector/network readiness without API credentials or host writes, including
 * dashboard-managed routes.
 */
function connectorProbe(proxy: CloudflareProxy, requireReady = false): string {
  if (proxy.container === undefined || proxy.network === undefined) {
    throw new Error('Cloudflare connector checks require container and network');
  }

  const container = shellQuote(proxy.container);
  const inspectState = `docker inspect -f ${shellQuote(CONNECTOR_STATE_FORMAT)} ${container}`;
  return [
    'set +x',
    'set -eu',
    REMOTE_PATH,
    'ready=yes',
    `if docker network inspect ${shellQuote(proxy.network)} >/dev/null 2>&1; then`,
    '  echo cf_network=yes',
    'else',
    '  echo cf_network=no',
    '  ready=no',
    'fi',
    `if [ "$(${inspectState} 2>/dev/null)" = 'true healthy' ]; then`,
    '  echo cf_connector=yes',
    'else',
    '  echo cf_connector=no',
    '  ready=no',
    'fi',
    requireReady ? CONNECTOR_READY_GUARD : '',
    '',
  ].join('\n');
}

/**
 * Interprets read-only API and host checks without exposing configuration or requiring a public
 * origin IP.
 */
function checks(
  app: App,
  host: HostConfig,
  addresses: ReadonlyArray<string>,
  probe: Record<string, string>,
): ReadonlyArray<Check> {
  const proxy = proxyFor(host);
  if (proxy === undefined) {
    return [
      {
        name: 'proxy',
        ok: false,
        detail: 'cloudflare-tunnel requires a host proxy with provider cloudflare-tunnel',
        fix: 'manual',
      },
    ];
  }

  const ingress = settings(app);
  const dns = dnsCheck(ingress.domain, proxy, addresses);
  const connector = connectorChecks(proxy, probe);
  if (proxy.routing === 'manual') {
    return [dns, ...connector];
  }

  return [dns, ...managedRoutingChecks(probe), ...connector];
}

/**
 * Reports whether the public hostname resolves at all.
 *
 * Cloudflare's proxied DNS resolves to its edge, so the addresses must not be compared with the
 * Docker host's address.
 */
function dnsCheck(domain: string, proxy: CloudflareProxy, addresses: ReadonlyArray<string>): Check {
  const resolves = addresses.length > 0;
  return {
    name: 'dns',
    ok: resolves,
    detail: resolves
      ? `${domain} resolves through public DNS; ` +
        'the post-deploy HTTP probe verifies service availability'
      : `Create a proxied CNAME for ${domain} to ${proxy.tunnelId}.cfargotunnel.com`,
    fix: 'dns',
  };
}

/**
 * Interprets the local connector probe, skipped when the host names no connector container.
 */
function connectorChecks(
  proxy: CloudflareProxy,
  probe: Record<string, string>,
): ReadonlyArray<Check> {
  if (proxy.container === undefined) {
    return [];
  }

  return [
    {
      name: 'cloudflare-connector',
      ok: probe.cf_connector === 'yes',
      detail: 'Host connector must be running and healthy',
      fix: 'setup-proxy',
    },
    {
      name: 'cloudflare-network',
      ok: probe.cf_network === 'yes',
      detail: 'Shared connector network must exist; the app must join it',
      fix: 'setup-proxy',
    },
  ];
}

/**
 * Interprets the API, state and route probe results that only managed routing produces.
 */
function managedRoutingChecks(probe: Record<string, string>): ReadonlyArray<Check> {
  return [
    {
      name: 'cloudflare-tools',
      ok: probe.cf_tools === 'yes',
      detail: 'Cloudflare Tunnel requires curl and jq on the Docker host',
      fix: 'manual',
    },
    {
      name: 'cloudflare-auth',
      ok: probe.cf_auth === 'yes',
      detail: 'Cloudflare API token must be readable from the configured host file',
      fix: 'manual',
    },
    {
      name: 'cloudflare-tunnel',
      ok: probe.cf_tunnel === 'yes',
      detail: 'Existing tunnel must be remotely managed with healthy connectors',
      fix: 'manual',
    },
    {
      name: 'cloudflare-api',
      ok: probe.cf_api === 'yes',
      detail: 'Cloudflare tunnel configuration must be readable with the configured API token',
      fix: 'manual',
    },
    {
      name: 'cloudflare-state',
      ok: probe.cf_state === 'yes',
      detail: 'Private route ownership storage is prepared by setup-proxy',
      fix: 'setup-proxy',
    },
    {
      name: 'cloudflare-ownership',
      ok: probe.cf_ownership === 'yes',
      detail:
        "Hostname must be unused or match this deployment's managed route; " +
        'external edits require reconciliation',
      fix: 'manual',
    },
    {
      name: 'route',
      ok: probe.cf_route === 'yes',
      detail:
        probe.cf_route === 'yes'
          ? 'Cloudflare application route is current'
          : 'Deploy applies the Cloudflare application route',
      fix: 'deploy',
    },
  ];
}

/**
 * The Cloudflare Tunnel extension for existing remotely managed tunnels and operator-owned
 * connectors and DNS.
 */
export const cloudflareIngress: IngressExtension = {
  /**
   * Selected by an app's `ingress.cloudflare-tunnel` and a host's `ingress.cloudflare-tunnel`.
   */
  id: 'cloudflare-tunnel',

  /**
   * With managed routing, routes the app by adding its hostname to the tunnel's configuration
   * through the Cloudflare API and unroutes by removing the rule compoza owns; with manual routing,
   * both are no-ops because the operator publishes routes. Throws when the host has no matching
   * Cloudflare proxy.
   */
  plan: (app, host) => {
    const proxy = requireProxy(host);
    const ingress = settings(app);
    return {
      description: `${ingress.domain} through Cloudflare Tunnel`,
      route: {
        script: script(proxy, 'route', app),
        label: `<configure Cloudflare Tunnel route for ${ingress.domain}>`,
      },
      unroute: {
        script: script(proxy, 'unroute', app),
        label: `<remove managed Cloudflare Tunnel route for ${projectNameOf(app)}>`,
      },
      healthUrl: `https://${ingress.domain}${ingress.healthPath ?? '/'}`,
    };
  },
  /**
   * Prepares route ownership storage on the host (managed routing) or checks the connector (manual
   * routing), and provisions the connector first when the proxy has `provision` settings. Throws
   * when the host has no matching Cloudflare proxy.
   */
  setup: (host) => {
    const proxy = requireProxy(host);
    if (proxy.provision !== undefined) {
      const operation = provisionOperation(proxy);
      const setup = script(proxy, 'setup');
      return {
        ...operation,
        // Manual routing's setup script is the connector readiness check, so it runs after
        // provisioning; managed routing prepares route ownership storage first.
        script:
          proxy.routing === 'manual'
            ? `${operation.script}\n${setup}`
            : `${setup}\n${operation.script}`,
      };
    }

    return {
      script: script(proxy, 'setup'),
      label: '<prepare Cloudflare Tunnel route ownership storage>',
    };
  },
  /**
   * The app's domain, or `undefined` when the host has no Cloudflare proxy to check it against.
   */
  domain: (app, host) => (proxyFor(host) === undefined ? undefined : settings(app).domain),

  /**
   * The read-only probe of the Cloudflare route state (managed routing) or the connector (manual
   * routing, or managed routing with a known connector container), or `undefined` when the host has
   * no Cloudflare proxy.
   */
  probe: (app, host) => {
    const proxy = proxyFor(host);
    return proxy === undefined ? undefined : script(proxy, 'probe', app);
  },
  /**
   * Turns DNS answers and probe keys into Cloudflare readiness checks.
   */
  checks,
};

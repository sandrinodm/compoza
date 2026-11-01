import { readFileSync } from 'node:fs';

import type { Check } from '../../checks.ts';
import type { App } from '../../config/deploy.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { IngressExtension } from '../ingress.ts';
import type { CloudflareProxy } from './config.ts';

import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { ingressOf, projectNameOf } from '../../config/deploy.ts';
import { ingressConfigOf } from '../../config/hosts.ts';

/**
 * Selects Cloudflare host settings without accepting a different ingress implementation accidentally.
 */
function proxyFor(host: HostConfig): CloudflareProxy | undefined {
  const proxy = ingressConfigOf(host);
  return proxy?.provider === 'cloudflare-tunnel' ? proxy : undefined;
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
 * SSH releases freeze these sources just like the Caddy operations. Only the host reads its API token, including on
 * rollback; the script contains a token file path but never the token itself.
 */
function script(proxy: CloudflareProxy, action: 'setup' | 'probe' | 'route' | 'unroute', app?: App): string {
  const root = `${proxy.stateDir}/${proxy.accountId}-${proxy.tunnelId}`;
  const rule = app === undefined ? [] : [{ hostname: settings(app).domain, service: settings(app).service }];
  const wanted = action === 'unroute' ? [] : rule;
  const source = readFileSync(new URL('./runtime.sh', import.meta.url), 'utf8');
  const merge = readFileSync(new URL('./merge.jq', import.meta.url), 'utf8');
  return `set +x
set -euo pipefail
${REMOTE_PATH}
cf_account=${shellQuote(proxy.accountId)}
cf_tunnel=${shellQuote(proxy.tunnelId)}
cf_token_file=${shellQuote(proxy.apiTokenFile)}
cf_state_dir=${shellQuote(proxy.stateDir)}
cf_root=${shellQuote(root)}
cf_owner_file=${shellQuote(`${root}/routes/${app === undefined ? 'setup' : projectNameOf(app)}.json`)}
cf_wanted=${shellQuote(JSON.stringify(wanted))}
cf_merge_filter=${shellQuote(merge)}
${source}
${action === 'probe' ? 'cf_probe' : action === 'setup' ? 'cf_setup' : 'cf_mutate'}
`;
}

/**
 * Interprets read-only API and host checks without exposing configuration or requiring a public origin IP.
 *
 * Cloudflare's proxied DNS resolves to its edge, so it must not be compared with the Docker host's address.
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
  const checks: Array<Check> = [
    {
      name: 'dns',
      ok: addresses.length > 0,
      detail:
        addresses.length > 0
          ? `${ingress.domain} resolves through public DNS; the post-deploy HTTP probe verifies service availability`
          : `Create a proxied CNAME for ${ingress.domain} to ${proxy.tunnelId}.cfargotunnel.com`,
      fix: 'dns',
    },
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
      detail: "Hostname must be unused or match this deployment's managed route; external edits require reconciliation",
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
  return checks;
}

/**
 * The Cloudflare Tunnel extension for existing remotely managed tunnels and operator-owned connectors and DNS.
 */
export const cloudflareIngress: IngressExtension = {
  id: 'cloudflare-tunnel',
  plan: (app, host) => {
    const proxy = proxyFor(host);
    if (proxy === undefined) {
      throw new Error('cloudflare-tunnel requires a matching host proxy');
    }
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
  setup: (host) => {
    const proxy = proxyFor(host);
    if (proxy === undefined) {
      throw new Error('cloudflare-tunnel requires a matching host proxy');
    }
    return { script: script(proxy, 'setup'), label: '<prepare Cloudflare Tunnel route ownership storage>' };
  },
  domain: (app, host) => (proxyFor(host) === undefined ? undefined : settings(app).domain),
  probe: (app, host) => {
    const proxy = proxyFor(host);
    return proxy === undefined ? undefined : script(proxy, 'probe', app);
  },
  checks,
};

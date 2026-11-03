import type { App } from '../../config/deploy.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { IngressExtension } from '../ingress.ts';
import type { ProxyConfig } from './config.ts';

import { ingressOf, projectNameOf } from '../../config/deploy.ts';
import { ingressConfigOf } from '../../config/hosts.ts';
import { caddyChecks } from './checks.ts';
import { provisionOperation } from './provision.ts';
import { checkScript, routeScript, setupScript, siteFile, unrouteScript } from './scripts.ts';

/**
 * The host's Caddy proxy entry, from either the named `caddy` ingress or a legacy `proxy` entry;
 * undefined when the host has none or its entry belongs to another extension.
 */
function caddyProxyOf(host: HostConfig): ProxyConfig | undefined {
  const proxy = ingressConfigOf(host, 'caddy');
  if (proxy === undefined || (proxy.provider !== undefined && proxy.provider !== 'caddy')) {
    return undefined;
  }

  return proxy;
}

/**
 * Requires host settings compatible with the selected Caddy extension before creating mutation
 * scripts.
 */
function caddyProxy(host: HostConfig): ProxyConfig {
  const proxy = caddyProxyOf(host);
  if (proxy === undefined) {
    throw new Error('caddy requires a host proxy configured for the Caddy ingress extension');
  }

  return proxy;
}

/**
 * Reads the Caddy app settings, rejecting a mismatched extension call before generating a route.
 */
function settings(app: App) {
  const ingress = ingressOf(app.config);
  if (ingress?.mode !== 'caddy') {
    throw new Error('Invalid Caddy ingress selection');
  }

  return ingress;
}

/**
 * The bundled shared-Caddy ingress extension, including setup, readiness and reversible route
 * operations.
 *
 * Every method is pure. The core executes the returned operations and stores the deployed removal
 * operation in SSH lifecycle metadata.
 */
export const caddyIngress: IngressExtension = {
  id: 'caddy',
  plan: (app, host) => {
    const proxy = caddyProxy(host);
    const ingress = settings(app);
    const name = projectNameOf(app);
    return {
      description: `${ingress.domain} through Caddy`,
      route: {
        script: routeScript(proxy, name),
        input: siteFile(name, ingress, proxy),
        label: `<lock Caddy, replace sites/${name}.caddy, validating reload>`,
      },
      unroute: {
        script: unrouteScript(proxy, name),
        label: `<lock Caddy, remove sites/${name}.caddy, validating reload>`,
      },
      healthUrl: `https://${ingress.domain}${ingress.healthPath ?? '/'}`,
    };
  },
  setup: (host) => {
    const proxy = caddyProxy(host);
    if (proxy.provision !== undefined) {
      return provisionOperation(proxy);
    }

    return {
      script: setupScript(proxy),
      label: `<set up ${proxy.dir}/sites, recreate Caddy>`,
    };
  },
  domain: (app, host) => (caddyProxyOf(host) === undefined ? undefined : settings(app).domain),
  probe: (app, host) => {
    const proxy = caddyProxyOf(host);
    return proxy === undefined ? undefined : checkScript({ proxy, name: projectNameOf(app) });
  },
  checks: caddyChecks,
};

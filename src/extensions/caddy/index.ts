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
 * The host's `caddy` ingress settings; undefined when the host has no Caddy ingress.
 */
function caddyProxyOf(host: HostConfig): ProxyConfig | undefined {
  const proxy = ingressConfigOf(host, 'caddy');
  return proxy?.provider === 'caddy' ? proxy : undefined;
}

/**
 * Requires the host's Caddy ingress settings before creating mutation scripts.
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
  /**
   * Selected by an app's `ingress.caddy` and a host's `ingress.caddy`.
   */
  id: 'caddy',

  /**
   * Routes the app by writing `sites/<project>.caddy` into the shared Caddy and reloading it, and
   * removes that file to unroute. Throws when the host has no Caddy proxy.
   */
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
  /**
   * Provisions the Caddy stack when the proxy has `provision` settings; otherwise prepares the
   * `sites` folder of an operator-managed Caddy and recreates it. Throws when the host has no Caddy
   * proxy.
   */
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
  /**
   * The app's domain, or `undefined` when the host has no Caddy proxy to check it against.
   */
  domain: (app, host) => (caddyProxyOf(host) === undefined ? undefined : settings(app).domain),

  /**
   * The read-only Caddy probe (site file, mounts, container state), or `undefined` when the host
   * has no Caddy proxy.
   */
  probe: (app, host) => {
    const proxy = caddyProxyOf(host);
    return proxy === undefined ? undefined : checkScript({ proxy, name: projectNameOf(app) });
  },
  /**
   * Turns DNS answers and probe keys into Caddy readiness checks.
   */
  checks: caddyChecks,
};

import { isIP } from 'node:net';

import type { Check } from '../../checks.ts';
import type { HostConfig } from '../../config/hosts.ts';

import { type App, ingressOf, projectNameOf } from '../../config/deploy.ts';
import { ingressConfigOf } from '../../config/hosts.ts';
import { sha256, siteFile } from './scripts.ts';

/**
 * Evaluates Caddy-specific readiness without executing commands or changing host state.
 */
export function caddyChecks(
  app: App,
  host: HostConfig,
  addresses: ReadonlyArray<string>,
  probe: Record<string, string>,
): ReadonlyArray<Check> {
  const checks: Array<Check> = [];
  const ingress = ingressOf(app.config);
  const selected = ingressConfigOf(host);
  const proxy = selected?.provider === undefined || selected.provider === 'caddy-sites' ? selected : undefined;
  const address = proxy?.address ?? host.address;

  if (ingress.mode === 'caddy-sites' && proxy === undefined) {
    checks.push({
      name: 'proxy',
      ok: false,
      detail: `host "${app.config.host}" has no proxy entry in the hosts file; add one to use caddy-sites ingress`,
      fix: 'manual',
    });
  }

  if (ingress.mode === 'caddy-sites' && proxy !== undefined) {
    const expectedSite = sha256(siteFile(projectNameOf(app), ingress, proxy));
    const proxyReady =
      probe.caddyfile_import === 'yes' &&
      probe.compose_mount === 'yes' &&
      probe.running_mount === 'yes' &&
      probe.container_running === 'yes' &&
      (probe.container_health === 'healthy' || (proxy.provision === undefined && probe.container_health === 'none'));

    const dnsOk =
      address === undefined
        ? addresses.length > 0
        : addresses.some((value) => normalizedIp(value) === normalizedIp(address));
    checks.push(
      {
        name: 'dns',
        ok: dnsOk,
        detail:
          addresses.length === 0
            ? `${ingress.domain} has no A or AAAA answer${address === undefined ? '' : `; expected ${address}`}`
            : dnsOk
              ? `${ingress.domain} → ${addresses.join(', ')}`
              : `${ingress.domain} → ${addresses.join(', ')}, expected ${address}`,
        fix: 'dns',
      },
      {
        name: 'proxy',
        ok: probe.proxy_dir === 'present' && proxyReady,
        detail:
          probe.proxy_dir === undefined
            ? `proxy folder ${proxy.dir} was not probed`
            : probe.proxy_dir !== 'present'
              ? `proxy folder ${proxy.dir} not found`
              : proxyReady
                ? 'Caddy is running and loads per-app files from sites/'
                : `Caddy is not ready (import ${probed(probe.caddyfile_import)}, compose mount ${probed(probe.compose_mount)}, running mount ${probed(probe.running_mount)}, running ${probed(probe.container_running)}, health ${probed(probe.container_health)})`,
        fix: proxy.provision !== undefined || probe.proxy_dir === 'present' ? 'setup-proxy' : 'manual',
      },
      {
        name: 'network',
        ok: probe.network === 'yes',
        detail:
          probe.network === undefined
            ? `Docker network ${proxy.network} was not probed`
            : probe.network === 'yes'
              ? `${proxy.network} exists`
              : `Docker network ${proxy.network} is missing`,
        fix: proxy.provision !== undefined ? 'setup-proxy' : 'manual',
      },
      {
        name: 'route',
        ok: probe.site_sha256 === expectedSite,
        detail:
          probe.site_sha256 === undefined
            ? `sites/${projectNameOf(app)}.caddy was not probed${probe.proxy_dir === 'missing' ? `: proxy folder ${proxy.dir} not found` : ''}`
            : probe.site_sha256 === 'none'
              ? `sites/${projectNameOf(app)}.caddy does not exist yet; deploy writes it`
              : probe.site_sha256 === expectedSite
                ? `sites/${projectNameOf(app)}.caddy is current`
                : `sites/${projectNameOf(app)}.caddy differs; deploy rewrites it`,
        fix: 'deploy',
      },
    );
  }

  return checks;
}

/**
 * Normalizes IPv6 spelling before comparing a configured DNS assertion with resolver answers.
 */
function normalizedIp(address: string): string {
  return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname : address;
}

/**
 * Describes a missing probe result without claiming the check ran.
 */
function probed(value: string | undefined): string {
  return value ?? 'not probed';
}

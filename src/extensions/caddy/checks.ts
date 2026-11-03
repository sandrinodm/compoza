import { isIP } from 'node:net';

import type { Check } from '../../checks.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { ProxyConfig } from './config.ts';

import { type App, ingressOf, projectNameOf } from '../../config/deploy.ts';
import { ingressConfigOf } from '../../config/hosts.ts';
import { sha256, siteFile } from './scripts.ts';

/**
 * Evaluates Caddy-specific readiness without executing commands or changing host state.
 *
 * Returns no checks for an app that does not route through Caddy, a single failing `proxy` check
 * when the host has no Caddy entry, and otherwise the `dns`, `proxy`, `network` and `route` checks
 * built from the resolver `addresses` and the parsed host `probe`. Probe keys that are missing are
 * reported as not probed rather than as failures of what they measure.
 */
export function caddyChecks(
  app: App,
  host: HostConfig,
  addresses: ReadonlyArray<string>,
  probe: Record<string, string>,
): ReadonlyArray<Check> {
  const ingress = ingressOf(app.config);
  // Resolved before the mode check so a host entry setting both ingress and proxy is rejected
  // whatever the app's mode.
  const selected = ingressConfigOf(host, 'caddy');
  if (ingress.mode !== 'caddy') {
    return [];
  }

  const proxy =
    selected?.provider === undefined || selected.provider === 'caddy' ? selected : undefined;
  if (proxy === undefined) {
    return [
      {
        name: 'proxy',
        ok: false,
        detail:
          `host "${app.config.host}" has no proxy entry in the hosts file; ` +
          'add one to use caddy ingress',
        fix: 'manual',
      },
    ];
  }

  const name = projectNameOf(app);
  const expectedSite = sha256(siteFile(name, ingress, proxy));
  return [
    dnsCheck(ingress.domain, addresses, proxy.address ?? host.address),
    proxyCheck(proxy, probe),
    networkCheck(proxy, probe),
    routeCheck(name, proxy, probe, expectedSite),
  ];
}

/**
 * Passes when the domain resolves to the expected address or, with no address configured, to
 * anything at all.
 */
function dnsCheck(
  domain: string,
  addresses: ReadonlyArray<string>,
  expected: string | undefined,
): Check {
  const ok =
    expected === undefined
      ? addresses.length > 0
      : addresses.some((value) => normalizedIp(value) === normalizedIp(expected));
  return { name: 'dns', ok, detail: dnsDetail(domain, addresses, expected, ok), fix: 'dns' };
}

/**
 * Describes the resolver answers, naming the expected address when they miss it.
 */
function dnsDetail(
  domain: string,
  addresses: ReadonlyArray<string>,
  expected: string | undefined,
  ok: boolean,
): string {
  if (addresses.length === 0) {
    const expectation = expected === undefined ? '' : `; expected ${expected}`;
    return `${domain} has no A or AAAA answer${expectation}`;
  }

  const answers = `${domain} → ${addresses.join(', ')}`;
  return ok ? answers : `${answers}, expected ${expected}`;
}

/**
 * Passes when the proxy folder exists and Caddy is set up for site files, running and healthy.
 * Setup can fix it when compoza provisions the proxy or the folder already exists.
 */
function proxyCheck(proxy: ProxyConfig, probe: Record<string, string>): Check {
  const ready = isProxyReady(proxy, probe);
  return {
    name: 'proxy',
    ok: probe.proxy_dir === 'present' && ready,
    detail: proxyDetail(proxy, probe, ready),
    fix: proxy.provision !== undefined || probe.proxy_dir === 'present' ? 'setup-proxy' : 'manual',
  };
}

/**
 * Whether the probe saw every part of the site-file setup in place and a running, healthy Caddy.
 *
 * A proxy compoza provisions always has a health check, so it must report `healthy`; an existing
 * proxy may define none, and then `none` counts as healthy.
 */
function isProxyReady(proxy: ProxyConfig, probe: Record<string, string>): boolean {
  const setUp =
    probe.caddyfile_import === 'yes' &&
    probe.compose_mount === 'yes' &&
    probe.running_mount === 'yes';
  const healthy =
    probe.container_health === 'healthy' ||
    (proxy.provision === undefined && probe.container_health === 'none');
  return setUp && probe.container_running === 'yes' && healthy;
}

/**
 * Describes the proxy folder and, when it exists, which part of the Caddy setup is not ready.
 */
function proxyDetail(proxy: ProxyConfig, probe: Record<string, string>, ready: boolean): string {
  if (probe.proxy_dir === undefined) {
    return `proxy folder ${proxy.dir} was not probed`;
  }

  if (probe.proxy_dir !== 'present') {
    return `proxy folder ${proxy.dir} not found`;
  }

  if (ready) {
    return 'Caddy is running and loads per-app files from sites/';
  }

  const findings = [
    `import ${probed(probe.caddyfile_import)}`,
    `compose mount ${probed(probe.compose_mount)}`,
    `running mount ${probed(probe.running_mount)}`,
    `running ${probed(probe.container_running)}`,
    `health ${probed(probe.container_health)}`,
  ];
  return `Caddy is not ready (${findings.join(', ')})`;
}

/**
 * Passes when the proxy's Docker network exists; only a provisioned proxy can create it.
 */
function networkCheck(proxy: ProxyConfig, probe: Record<string, string>): Check {
  return {
    name: 'network',
    ok: probe.network === 'yes',
    detail: networkDetail(proxy.network, probe.network),
    fix: proxy.provision !== undefined ? 'setup-proxy' : 'manual',
  };
}

/**
 * Describes whether the network exists, or that it was not probed.
 */
function networkDetail(network: string, state: string | undefined): string {
  if (state === undefined) {
    return `Docker network ${network} was not probed`;
  }

  return state === 'yes' ? `${network} exists` : `Docker network ${network} is missing`;
}

/**
 * Passes when the app's site file on the host hashes to the one deploy would write.
 */
function routeCheck(
  name: string,
  proxy: ProxyConfig,
  probe: Record<string, string>,
  expectedSite: string,
): Check {
  return {
    name: 'route',
    ok: probe.site_sha256 === expectedSite,
    detail: routeDetail(name, proxy, probe, expectedSite),
    fix: 'deploy',
  };
}

/**
 * Describes the site file's state, naming the missing proxy folder when that is why it was not
 * probed.
 */
function routeDetail(
  name: string,
  proxy: ProxyConfig,
  probe: Record<string, string>,
  expectedSite: string,
): string {
  const site = `sites/${name}.caddy`;
  if (probe.site_sha256 === undefined) {
    const reason = probe.proxy_dir === 'missing' ? `: proxy folder ${proxy.dir} not found` : '';
    return `${site} was not probed${reason}`;
  }

  if (probe.site_sha256 === 'none') {
    return `${site} does not exist yet; deploy writes it`;
  }

  return probe.site_sha256 === expectedSite
    ? `${site} is current`
    : `${site} differs; deploy rewrites it`;
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

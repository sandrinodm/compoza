import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { CaddyIngress } from '../config.ts';

import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { type ProxyConfig, proxyComposeFile, proxyService } from './config.ts';
import { defaultSiteTemplate, renderTemplate } from './templates.ts';

/**
 * The line the shared Caddyfile ends with once per-app site files are enabled.
 */
export const SITES_IMPORT = 'import /etc/caddy/sites/*.caddy';

/**
 * The container folder Caddy reads the per-app site files from.
 *
 * Detection looks for this destination rather than for `SITES_MOUNT` verbatim, so a Compose file
 * that mounts `sites/` another way (without `:ro`, or in the long `type: bind` syntax) still counts
 * as set up instead of getting a second mount at the same destination, which `docker compose
 * config` rejects.
 */
export const SITES_DESTINATION = '/etc/caddy/sites';

/**
 * The Compose volume that mounts the per-app site files into Caddy, as `setupScript` inserts it.
 */
export const SITES_MOUNT = `./sites:${SITES_DESTINATION}:ro`;

/**
 * The existing Caddyfile mount the sites mount is inserted after, which every proxy set up this way
 * has.
 */
const CADDYFILE_MOUNT = './Caddyfile:/etc/caddy/Caddyfile:ro';

/**
 * The site block for one app, written to `<proxy dir>/sites/<name>.caddy`.
 *
 * The `tls` block and the log import come from the host's proxy entry, so every app on a host gets
 * certificates and request logs the same way without repeating it in each `deploy.yaml`.
 */
export function siteFile(name: string, ingress: CaddyIngress, proxy: ProxyConfig): string {
  return renderTemplate(
    ingress.siteTemplate ?? proxy.templates?.site,
    defaultSiteTemplate,
    {
      name,
      domain: ingress.domain,
      upstream: ingress.upstream,
      tls: proxy.tls ?? '',
      logSnippet: proxy.logSnippet ?? '',
    },
    'Caddy site template',
  );
}

/**
 * The SHA-256 of a text as a hex string, compared against `shasum -a 256` (or `sha256sum`) output
 * on the host to tell whether its site file is current.
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The three shell conditions that together mean a proxy is set up for site files, each succeeding
 * when its part is in place. The first two read files relative to the proxy folder, so they run
 * after a `cd` into it.
 */
interface SetupConditions {
  /**
   * The shared Caddyfile imports every file in `sites/`.
   */
  readonly caddyfileImport: string;

  /**
   * The proxy Compose file mounts something at `SITES_DESTINATION`.
   */
  readonly composeMount: string;

  /**
   * The running Caddy container has a mount at `SITES_DESTINATION`.
   */
  readonly runningMount: string;
}

/**
 * Builds the conditions `checkScript` reports and `setupScript` tests before changing anything, so
 * the probe and the setup can never disagree on what "set up" means.
 *
 * Errors are silenced (`grep -s`, `2>/dev/null`): a missing file or container is simply not set up,
 * and only the exit status is read. The Compose condition is a fixed-string match on the
 * destination anywhere in the file, which also matches a commented-out mount; that errs towards not
 * inserting a duplicate.
 */
function setupConditions(proxy: ProxyConfig): SetupConditions {
  const destination = shellQuote(SITES_DESTINATION);
  return {
    caddyfileImport: `grep -qsxF ${shellQuote(SITES_IMPORT)} Caddyfile`,
    composeMount: `grep -qsF ${destination} ${shellQuote(proxyComposeFile(proxy))}`,
    runningMount: `docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' ${shellQuote(proxy.container)} 2>/dev/null | grep -qF ${destination}`,
  };
}

/**
 * The parts of a host probe to include.
 */
export interface ProbeOptions {
  /**
   * The proxy to inspect, when the app is routed through one.
   */
  readonly proxy?: ProxyConfig | undefined;

  /**
   * The app name, naming its site file under the proxy.
   */
  readonly name: string;
}

/**
 * A read-only probe of a host, printing `key=value` lines: whether the proxy folder exists and is
 * set up for site files, whether its network exists, and the hash of the app's site file.
 *
 * A missing proxy folder prints `proxy_dir=missing` and skips only the keys read from that folder
 * (`caddyfile_import`, `compose_mount`, `site_sha256`); the container and network probes still run,
 * so every check reports what was measured. The hash falls back from `shasum` to coreutils
 * `sha256sum`, because minimal Linux hosts ship only the latter and macOS only the former.
 */
export function checkScript(options: ProbeOptions): string {
  const lines = ['set -u', REMOTE_PATH];

  if (options.proxy !== undefined) {
    const proxy = options.proxy;
    const site = shellQuote(`sites/${options.name}.caddy`);
    const conditions = setupConditions(proxy);
    lines.push(
      `if cd ${shellQuote(proxy.dir)} 2>/dev/null; then`,
      '  echo proxy_dir=present',
      `  if ${conditions.caddyfileImport}; then echo caddyfile_import=yes; else echo caddyfile_import=no; fi`,
      `  if ${conditions.composeMount}; then echo compose_mount=yes; else echo compose_mount=no; fi`,
      `  if [ -f ${site} ]; then echo site_sha256=$({ shasum -a 256 ${site} 2>/dev/null || sha256sum ${site}; } | cut -d' ' -f1); else echo site_sha256=none; fi`,
      'else',
      '  echo proxy_dir=missing',
      'fi',
      `if ${conditions.runningMount}; then echo running_mount=yes; else echo running_mount=no; fi`,
      `if [ "$(docker inspect -f '{{.State.Running}}' ${shellQuote(proxy.container)} 2>/dev/null)" = true ]; then echo container_running=yes; else echo container_running=no; fi`,
      `health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ${shellQuote(proxy.container)} 2>/dev/null) || health=missing`,
      'echo container_health="$health"',
      `docker network inspect ${shellQuote(proxy.network)} >/dev/null 2>&1 && echo network=yes || echo network=no`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The one-time change to a shared proxy: mount a `sites/` folder and import every `*.caddy` file in
 * it.
 *
 * Both files are backed up with a timestamp, the new configuration is validated with a throwaway
 * Caddy before the running one is touched, and the backups are restored if any step fails,
 * including the Compose edit when the Caddyfile mount it anchors on is absent. The sites mount is
 * inserted only when nothing in the Compose file mounts at `SITES_DESTINATION` yet, so a proxy that
 * mounts `sites/` its own way keeps that mount. Recreating the Compose service (`proxyService`)
 * interrupts every site on the host for a moment, which is why this is its own command rather than
 * part of deploy. It is a no-op on a host that is already set up.
 *
 * The throwaway Caddy mounts only the Caddyfile and `sites/`, with the proxy's `.env` as its
 * environment when that file exists. A Caddyfile that imports other files mounted into the running
 * container cannot be validated this way and fails here, leaving the proxy restored and untouched.
 */
export function setupScript(proxy: ProxyConfig): string {
  const compose = shellQuote(proxyComposeFile(proxy));
  const container = shellQuote(proxy.container);
  const anchor = shellQuote(`- ${CADDYFILE_MOUNT}`);
  const add = shellQuote(`- ${SITES_MOUNT}`);
  const conditions = setupConditions(proxy);
  return `set +x
set -euo pipefail
umask 077
${REMOTE_PATH}
cd ${shellQuote(proxy.dir)}
mkdir .compoza-caddy.lock 2>/dev/null || { echo "Caddy is locked; inspect the host before retrying" >&2; exit 1; }
pending=no
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$pending" = yes ]; then
    if ! restore; then
      echo "Caddy setup restoration failed; backups and lock retained for inspection" >&2
      exit 1
    fi
  fi
  rmdir .compoza-caddy.lock
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ${conditions.caddyfileImport} && ${conditions.composeMount} \\
  && ${conditions.runningMount}; then
  echo "proxy already set up; nothing to do"
  exit 0
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cp -p Caddyfile "Caddyfile.pre-sites-$stamp"
cp -p ${compose} "${proxyComposeFile(proxy)}.pre-sites-$stamp"
restore() {
  echo "setup failed; restoring Caddyfile and ${proxyComposeFile(proxy)}"
  cp -p "Caddyfile.pre-sites-$stamp" Caddyfile &&
    cp -p "${proxyComposeFile(proxy)}.pre-sites-$stamp" ${compose}
}
pending=yes
mkdir -p sites
if ! ${conditions.caddyfileImport}; then
  # Append in place so the single-file bind mount keeps pointing at this file.
  printf '\\n%s\\n' ${shellQuote(SITES_IMPORT)} >> Caddyfile
fi
if ! ${conditions.composeMount}; then
  # Insert the sites mount right after the Caddyfile mount, with the same indentation. awk runs as its own statement:
  # on the left of && a failure would neither stop set -e nor fire the ERR trap.
  tmp=${compose}.tmp
  if ! awk -v anchor=${anchor} -v add=${add} '
    { print }
    !done && index($0, anchor) { match($0, /^[ \\t]*/); printf "%s%s\\n", substr($0, 1, RLENGTH), add; done = 1 }
    END { if (!done) { print "Caddyfile mount not found in the proxy Compose file" > "/dev/stderr"; exit 1 } }
  ' ${compose} > "$tmp"; then
    rm -f "$tmp"
    false
  fi
  mv "$tmp" ${compose}
fi
docker compose -f ${compose} config --quiet >/dev/null 2>&1 || { echo "Caddy Compose validation failed; inspect configuration privately" >&2; false; }
image=$(docker inspect -f '{{.Config.Image}}' ${container})
# Positional parameters rather than an array: bash 3.2 (macOS) treats an empty "\${a[@]}" as unbound under set -u.
set --
if [ -f .env ]; then set -- --env-file .env; fi
docker run --rm "$@" \\
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/sites:/etc/caddy/sites:ro" \\
  "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "Caddy validation failed; inspect configuration privately" >&2; false; }
docker compose -f ${compose} up -d ${shellQuote(proxyService(proxy))} >/dev/null 2>&1 || { echo "Caddy setup failed to start the service; inspect it privately" >&2; false; }
pending=no
echo "proxy setup complete; backups: Caddyfile.pre-sites-$stamp ${proxyComposeFile(proxy)}.pre-sites-$stamp"
`;
}

/**
 * Installs a complete site file under the shared proxy lock and asks the running Caddy to load it
 * atomically.
 *
 * A failed or interrupted reload restores the prior file and attempts to reconcile the running
 * configuration. Diagnostics stay private because Caddy can include expanded environment
 * credentials in errors.
 */
export function routeScript(proxy: ProxyConfig, name: string): string {
  return mutationScript(proxy, name, 'route');
}

/**
 * Removes a route using the same lock and failure recovery as installation; a missing route is a
 * no-op.
 */
export function unrouteScript(proxy: ProxyConfig, name: string): string {
  return mutationScript(proxy, name, 'unroute');
}

/**
 * Embeds the portable route runtime so host operations remain independent of the local CLI
 * installation.
 */
function mutationScript(proxy: ProxyConfig, name: string, action: 'route' | 'unroute'): string {
  return `set +x
set -euo pipefail
${REMOTE_PATH}
cd ${shellQuote(proxy.dir)}
container=${shellQuote(proxy.container)}
file=${shellQuote(`${name}.caddy`)}
action=${shellQuote(action)}
${readFileSync(new URL('./route.sh', import.meta.url), 'utf8')}
`;
}

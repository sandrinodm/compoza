import { readFileSync } from 'node:fs';
import YAML from 'yaml';

import type { IngressOperation } from '../ingress.ts';
import type { ProxyConfig } from './config.ts';

import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { proxyComposeFile, proxyService } from './config.ts';
import { SITES_IMPORT } from './scripts.ts';
import { defaultConfigTemplate, renderTemplate } from './templates.ts';

/**
 * The Caddy drain period in seconds when `provision.gracePeriodSeconds` is left out.
 */
const DEFAULT_GRACE_PERIOD_SECONDS = 30;

/**
 * Extra seconds Docker waits beyond the Caddy drain period before it kills the container, so a
 * graceful shutdown is never cut short.
 */
const STOP_GRACE_MARGIN_SECONDS = 10;

/**
 * A plain YAML filename with no directory part, so the generated Compose file stays inside the
 * proxy directory.
 */
const COMPOSE_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/;

/**
 * The settings of a proxy entry that opted into provisioning.
 */
type ProvisionConfig = NonNullable<ProxyConfig['provision']>;

/**
 * Generates a complete shared Caddy stack and a guarded bootstrap operation without contacting the
 * host.
 *
 * Existing differing files are never overwritten. Credentials are referenced by host path, and
 * validation output stays private because Caddy and Compose can echo expanded credential values in
 * diagnostics.
 *
 * Throws when the entry has no `provision` settings, when `composeFile` or the paths are unsafe to
 * generate, or when the config template does not import the per-app site files.
 */
export function provisionOperation(proxy: ProxyConfig): IngressOperation {
  const config = proxy.provision;
  if (config === undefined) {
    throw new Error('Caddy provisioning settings are missing');
  }

  const composeFile = proxyComposeFile(proxy);
  checkProvisionPaths(proxy, config, composeFile);

  const project = `${proxy.container}-ingress`;
  const compose = YAML.stringify(composeDocument(proxy, config, project));
  const caddyfile = renderCaddyfile(proxy, config);
  return {
    label: `<provision Caddy in ${proxy.dir}, validate, start ${proxy.container}>`,
    input: JSON.stringify({ compose, caddyfile }),
    script: `set +x
set -euo pipefail
${REMOTE_PATH}
proxy_dir=${shellQuote(proxy.dir)}
compose_file=${shellQuote(composeFile)}
container=${shellQuote(proxy.container)}
service=${shellQuote(proxyService(proxy))}
project=${shellQuote(project)}
network=${shellQuote(proxy.network)}
image=${shellQuote(config.image)}
env_file=${shellQuote(config.envFile ?? '')}
${readFileSync(new URL('./provision.sh', import.meta.url), 'utf8')}
`,
  };
}

/**
 * Rejects file locations the bootstrap cannot write safely: a Compose file outside the proxy
 * directory, paths Compose would interpolate, and an env file that generation would overwrite.
 */
function checkProvisionPaths(
  proxy: ProxyConfig,
  config: ProvisionConfig,
  composeFile: string,
): void {
  if (!COMPOSE_FILENAME_PATTERN.test(composeFile)) {
    throw new Error(
      'Caddy provisioning requires composeFile to be a YAML filename inside the proxy directory',
    );
  }

  if (proxy.dir.includes('$') || config.envFile?.includes('$')) {
    throw new Error('Caddy provisioning paths cannot contain Compose interpolation characters');
  }

  const generatedFiles = [composeFile, 'Caddyfile'].map((file) => `${proxy.dir}/${file}`);
  if (config.envFile !== undefined && generatedFiles.includes(config.envFile)) {
    throw new Error('Caddy envFile must be separate from generated configuration');
  }
}

/**
 * The Compose model for the provisioned stack: one hardened, read-only Caddy service with a health
 * check against its admin API, publishing HTTP and HTTPS (TCP and QUIC) on every interface.
 */
function composeDocument(proxy: ProxyConfig, config: ProvisionConfig, project: string) {
  const gracePeriodSeconds = config.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS;
  return {
    name: project,
    services: {
      [proxyService(proxy)]: {
        image: config.image,
        container_name: proxy.container,
        restart: 'unless-stopped',
        entrypoint: ['caddy'],
        command: ['run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
        read_only: true,
        tmpfs: ['/tmp:rw,noexec,nosuid,size=64m'],
        security_opt: ['no-new-privileges:true'],
        stop_grace_period: `${gracePeriodSeconds + STOP_GRACE_MARGIN_SECONDS}s`,
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
        healthcheck: {
          test: [
            'CMD',
            'wget',
            '-q',
            '-T',
            '3',
            '-O',
            '/dev/null',
            'http://127.0.0.1:2019/config/',
          ],
          interval: '10s',
          timeout: '5s',
          retries: 3,
          start_period: '10s',
        },
        ports: ['0.0.0.0:80:80', '0.0.0.0:443:443', '0.0.0.0:443:443/udp'],
        volumes: [
          './Caddyfile:/etc/caddy/Caddyfile:ro',
          './sites:/etc/caddy/sites:ro',
          './data:/data',
          './config:/config',
        ],
        ...(config.envFile === undefined
          ? {}
          : { env_file: [{ path: config.envFile, required: true, format: 'raw' }] }),
        networks: { edge: { aliases: config.networkAliases ?? [] } },
      },
    },
    networks: { edge: { external: true, name: proxy.network } },
  };
}

/**
 * Renders the shared Caddyfile from the host's config template or the bundled one, and requires it
 * to import the per-app site files, without which no app route would ever load.
 */
function renderCaddyfile(proxy: ProxyConfig, config: ProvisionConfig): string {
  const caddyfile = renderTemplate(
    proxy.templates?.config,
    defaultConfigTemplate,
    {
      acmeDns: config.acmeDns ?? '',
      logSnippet: proxy.logSnippet ?? '',
      sitesImport: SITES_IMPORT,
      gracePeriod: `${config.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS}s`,
    },
    'Caddy config template',
  );
  if (!caddyfile.split(/\r?\n/).includes(SITES_IMPORT)) {
    throw new Error(
      'Caddy config template must include {{sitesImport}} on its own line to load app routes',
    );
  }

  return caddyfile;
}

import { readFileSync } from 'node:fs';
import YAML from 'yaml';

import type { IngressOperation } from '../ingress.ts';
import type { CloudflareProxy } from './config.ts';

import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { renderTemplate } from '../caddy/templates.ts';
import { defaultComposeTemplate } from './templates.ts';

/**
 * Reviewed multiarchitecture connector image; release updates deliberately replace this digest.
 */
export const DEFAULT_CLOUDFLARED_IMAGE =
  'cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07';

/**
 * Rejects custom Compose output with the runtime requirement it failed to preserve.
 */
function requireCondition(condition: unknown, requirement: string): asserts condition {
  if (!condition) {
    throw new Error(`Cloudflare Compose template must ${requirement}`);
  }
}

/**
 * Checks custom Compose output before planning host operations, preserving connector identity and runtime guarantees.
 */
function validateCompose(compose: string, proxy: CloudflareProxy, service: string, envFile: string): void {
  if (Buffer.byteLength(compose) > 256 * 1024) {
    throw new Error('Cloudflare Compose template is too large');
  }

  let model;

  try {
    model = YAML.parse(compose, { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    throw new Error('Cloudflare Compose template must render valid YAML');
  }

  // Validate the shape before checking individual connector settings.
  requireCondition(model && typeof model === 'object' && !Array.isArray(model), 'render a Compose mapping');
  requireCondition(
    model.services && typeof model.services === 'object' && !Array.isArray(model.services),
    'define a services mapping',
  );
  requireCondition(Object.keys(model.services).length === 1, 'define exactly one connector service');

  const connector = model.services[service];
  requireCondition(
    connector && typeof connector === 'object' && !Array.isArray(connector),
    `define the connector service "${service}"`,
  );
  requireCondition(
    Object.keys(model).every((key) => ['name', 'services', 'networks'].includes(key)),
    'use only the supported top-level settings',
  );
  requireCondition(
    Object.keys(connector).every((key) =>
      [
        'image',
        'container_name',
        'user',
        'restart',
        'entrypoint',
        'command',
        'read_only',
        'cap_drop',
        'security_opt',
        'stop_grace_period',
        'mem_limit',
        'pids_limit',
        'cpus',
        'logging',
        'env_file',
        'networks',
        'healthcheck',
      ].includes(key),
    ),
    'use only the supported connector settings',
  );

  // Keep the stack identity fixed while allowing supported runtime tuning.
  requireCondition(model.name === `${proxy.container}-ingress`, 'preserve the stack project name');
  requireCondition(connector.container_name === proxy.container, 'preserve the connector container name');
  requireCondition(
    connector.image === (proxy.provision?.image ?? DEFAULT_CLOUDFLARED_IMAGE),
    'use the configured connector image',
  );
  requireCondition(connector.user === (proxy.provision?.user ?? '65532:65532'), 'use the configured connector user');
  requireCondition(connector.restart === 'unless-stopped', 'use the unless-stopped restart policy');

  // The allowed settings above exclude ports, volumes, builds and namespace or privilege overrides.
  requireCondition(connector.read_only === true, 'keep the connector filesystem read-only');
  requireCondition(connector.cap_drop?.includes('ALL'), 'drop all connector capabilities');
  requireCondition(connector.security_opt?.includes('no-new-privileges:true'), 'prevent privilege escalation');

  // Credentials come only from the selected raw env file, never command arguments or environment overrides.
  requireCondition(
    JSON.stringify(connector.env_file) === JSON.stringify([{ path: envFile, required: true, format: 'raw' }]),
    'preserve the credential env-file source',
  );
  requireCondition(JSON.stringify(connector.entrypoint) === '["cloudflared"]', 'use the cloudflared entrypoint');

  const command = connector.command;
  requireCondition(Array.isArray(command), 'define the connector command as an argument list');
  requireCondition(
    command.every((argument: unknown) => typeof argument === 'string' && !/\$|\r|\n/.test(argument)),
    'use literal single-line command arguments',
  );
  requireCondition(command[0] === 'tunnel' && command.at(-1) === 'run', 'run the cloudflared tunnel command');

  for (const flag of [
    '--token',
    '--token-file',
    '--credentials-file',
    '--cred-file',
    '--credentials-contents',
    '--config',
  ]) {
    requireCondition(
      command.every((argument: string) => argument !== flag && !argument.startsWith(flag + '=')),
      `omit the ${flag} command option`,
    );
  }

  requireCondition(command.includes('--no-autoupdate'), 'disable connector autoupdates');

  // Metrics stay private and the command uses the configured drain deadline.
  requireCondition(command.filter((argument) => argument === '--metrics').length === 1, 'set metrics exactly once');
  requireCondition(
    command.every((argument: string) => !argument.startsWith('--metrics=')),
    'use a separate metrics address argument',
  );
  requireCondition(
    command[command.indexOf('--metrics') + 1] === '127.0.0.1:20241',
    'bind metrics to the private listener',
  );

  const gracePeriodSeconds = proxy.provision?.gracePeriodSeconds ?? 30;
  requireCondition(
    command.filter((argument) => argument === '--grace-period').length === 1,
    'set the drain deadline exactly once',
  );
  requireCondition(
    command[command.indexOf('--grace-period') + 1] === `${gracePeriodSeconds}s`,
    'preserve the configured drain deadline',
  );

  // Readiness, bounded resources and shutdown budgets remain mandatory.
  requireCondition(
    JSON.stringify(connector.healthcheck?.test) ===
      '["CMD","cloudflared","tunnel","--metrics","127.0.0.1:20241","ready"]',
    'use the native connector readiness check',
  );
  requireCondition(!connector.healthcheck?.disable, 'keep the readiness check enabled');
  requireCondition(['local', 'json-file'].includes(connector.logging?.driver), 'use a supported rotating log driver');
  requireCondition(
    /^[1-9][0-9]*(?:[kmgt]b?)?$/i.test(String(connector.logging?.options?.['max-size'])),
    'set a positive log file size limit',
  );
  requireCondition(
    /^[1-9][0-9]*$/.test(String(connector.logging?.options?.['max-file'])),
    'set a positive log file retention count',
  );
  requireCondition(/^[1-9][0-9]*(?:[kmgt]b?)?$/i.test(String(connector.mem_limit)), 'set a positive memory limit');
  requireCondition(Number.isInteger(connector.pids_limit) && connector.pids_limit >= 1, 'set a positive PID limit');
  requireCondition(
    connector.stop_grace_period === `${gracePeriodSeconds + 10}s`,
    'preserve shutdown headroom beyond the drain deadline',
  );

  // Origins share one external network; only the connector joins the separate egress network.
  requireCondition(
    model.networks && typeof model.networks === 'object' && !Array.isArray(model.networks),
    'define a networks mapping',
  );
  requireCondition(
    Object.keys(model.networks).every((key) => ['edge', 'egress'].includes(key)),
    'define only the edge and egress networks',
  );
  requireCondition(JSON.stringify(model.networks.egress) === '{}', 'keep the egress network private');

  const edge = model.networks.edge;
  requireCondition(edge && typeof edge === 'object' && !Array.isArray(edge), 'define the shared edge network');
  requireCondition(
    Object.keys(edge).every((key) => ['name', 'external'].includes(key)),
    'use only the supported edge network settings',
  );
  requireCondition(edge.name === proxy.network, 'preserve the shared edge network name');
  requireCondition(edge.external === true, 'keep the shared edge network external');
  requireCondition(
    JSON.stringify(connector.networks) === '["edge","egress"]',
    'join only the edge and egress networks',
  );
}

/**
 * Generates a guarded host bootstrap, keeping credentials out of templates, plans and SSH command arguments.
 */
export function provisionOperation(proxy: CloudflareProxy): IngressOperation {
  const config = proxy.provision;
  if (config === undefined || proxy.dir === undefined || proxy.container === undefined || proxy.network === undefined) {
    throw new Error('Cloudflare provisioning requires provision, dir, container and network');
  }

  const composeFile = proxy.composeFile ?? 'compose.yaml';
  const envFile = config.envFile ?? `${proxy.dir}/.credentials.env`;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/.test(composeFile) ||
    [proxy.dir, envFile].some((path) => /[$\r\n\0]/.test(path)) ||
    envFile === `${proxy.dir}/${composeFile}`
  ) {
    throw new Error('Cloudflare provisioning requires safe separate Compose and credential paths');
  }

  const service = proxy.service ?? 'connector';
  const project = `${proxy.container}-ingress`;
  const values = Object.fromEntries(
    Object.entries({
      service,
      project,
      container: proxy.container,
      network: proxy.network,
      image: config.image ?? DEFAULT_CLOUDFLARED_IMAGE,
      envFile,
      user: config.user ?? '65532:65532',
      gracePeriod: `${config.gracePeriodSeconds ?? 30}s`,
      stopGracePeriod: `${(config.gracePeriodSeconds ?? 30) + 10}s`,
    }).map(([key, value]) => [key, JSON.stringify(value)]),
  );

  const compose = renderTemplate(
    proxy.templates?.compose,
    defaultComposeTemplate,
    values,
    'Cloudflare Compose template',
  );

  validateCompose(compose, proxy, service, envFile);

  return {
    label: `<provision Cloudflare connector ${proxy.container} in ${proxy.dir}, validate and wait for connections>`,
    input: JSON.stringify({ compose }),
    ...(config.secrets === undefined
      ? {}
      : {
          secrets: config.secrets,
          secretVariables: { TUNNEL_TOKEN: config.tokenVariable ?? 'CLOUDFLARE_TUNNEL_TOKEN' },
        }),
    script: `set +x
set -euo pipefail
${REMOTE_PATH}
proxy_dir=${shellQuote(proxy.dir)}
compose_file=${shellQuote(composeFile)}
container=${shellQuote(proxy.container)}
service=${shellQuote(service)}
project=${shellQuote(project)}
network=${shellQuote(proxy.network)}
env_file=${shellQuote(envFile)}
managed_credentials=${config.secrets === undefined ? 'no' : 'yes'}
wait_timeout=${config.waitTimeoutSeconds ?? 120}
cf_account=${shellQuote(proxy.accountId)}
cf_tunnel=${shellQuote(proxy.tunnelId)}
${readFileSync(new URL('./provision.sh', import.meta.url), 'utf8')}
`,
  };
}

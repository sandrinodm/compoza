import { readFileSync } from 'node:fs';
import YAML from 'yaml';

import type { IngressOperation } from '../ingress.ts';
import type { CloudflareProxy } from './config.ts';

import { REMOTE_PATH, shellQuote } from '../../command.ts';
import { renderTemplate } from '../caddy/templates.ts';
import { COMPOSE_FILE_NAME_PATTERN } from './config.ts';
import { defaultComposeTemplate, MAX_RENDERED_TEMPLATE_BYTES } from './templates.ts';

/**
 * Reviewed multiarchitecture connector image; release updates deliberately replace this digest.
 */
export const DEFAULT_CLOUDFLARED_IMAGE =
  'cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07';

/**
 * The numeric nonroot UID:GID the connector runs as unless `provision.user` overrides it.
 */
const DEFAULT_CONNECTOR_USER = '65532:65532';

/**
 * How long the connector drains in-flight requests on shutdown unless
 * `provision.gracePeriodSeconds` overrides it.
 */
const DEFAULT_GRACE_PERIOD_SECONDS = 30;

/**
 * The extra time Docker gives the connector to exit after its drain deadline, added to the grace
 * period to form `stop_grace_period`.
 */
const SHUTDOWN_HEADROOM_SECONDS = 10;

/**
 * How long setup waits for the connector to report connections unless
 * `provision.waitTimeoutSeconds` overrides it.
 */
const DEFAULT_WAIT_TIMEOUT_SECONDS = 120;

/**
 * The private loopback listener for connector metrics, which the readiness check queries.
 */
const METRICS_ADDRESS = '127.0.0.1:20241';

/**
 * The only top-level Compose settings a custom connector template may use.
 */
const ALLOWED_TOP_LEVEL_SETTINGS = new Set(['name', 'services', 'networks']);

/**
 * The only connector service settings a custom template may use. Leaving out ports, volumes, builds
 * and namespace or privilege overrides is what keeps the connector isolated.
 */
const ALLOWED_CONNECTOR_SETTINGS = new Set([
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
]);

/**
 * The cloudflared options that would supply credentials or configuration outside the selected env
 * file.
 */
const CREDENTIAL_OPTIONS = [
  '--token',
  '--token-file',
  '--credentials-file',
  '--cred-file',
  '--credentials-contents',
  '--config',
];

/**
 * The Docker log drivers that rotate their files.
 */
const ROTATING_LOG_DRIVERS = new Set(['local', 'json-file']);

/**
 * The only networks the connector stack may define.
 */
const ALLOWED_NETWORKS = new Set(['edge', 'egress']);

/**
 * The only settings the shared edge network may use.
 */
const ALLOWED_EDGE_NETWORK_SETTINGS = new Set(['name', 'external']);

/**
 * A positive Compose byte size such as `128m` or `10mb`.
 */
const BYTE_SIZE_PATTERN = /^[1-9][0-9]*(?:[kmgt]b?)?$/i;

/**
 * A positive decimal integer without a leading zero.
 */
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

/**
 * Characters that would let a command argument expand or span lines.
 */
const NON_LITERAL_ARGUMENT_PATTERN = /\$|\r|\n/;

/**
 * Characters a host path must not contain, because the bootstrap script expands or splits on them.
 */
const UNSAFE_PATH_PATTERN = /[$\r\n\0]/;

/**
 * Rejects custom Compose output with the runtime requirement it failed to preserve.
 */
function requireCondition(condition: unknown, requirement: string): asserts condition {
  if (!condition) {
    throw new Error(`Cloudflare Compose template must ${requirement}`);
  }
}

/**
 * Distinguishes YAML mappings from scalars, null and sequences.
 *
 * It returns a plain boolean rather than a type predicate so the parsed model stays untyped and its
 * fields can be read without further narrowing.
 */
function isMapping(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks custom Compose output before planning host operations, preserving connector identity and
 * runtime guarantees.
 */
function validateCompose(
  compose: string,
  proxy: CloudflareProxy,
  service: string,
  envFile: string,
): void {
  const model = parseCompose(compose);
  const connector = connectorService(model, service);
  checkConnectorIdentity(model, connector, proxy);
  checkConnectorIsolation(connector, envFile);

  const gracePeriodSeconds = proxy.provision?.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS;
  checkConnectorCommand(connector.command, gracePeriodSeconds);
  checkConnectorRuntime(connector, gracePeriodSeconds);
  checkNetworks(model, connector, proxy);
}

/**
 * Parses rendered Compose text, rejecting oversized output, duplicate keys and aliases.
 */
function parseCompose(compose: string): any {
  if (Buffer.byteLength(compose) > MAX_RENDERED_TEMPLATE_BYTES) {
    throw new Error('Cloudflare Compose template is too large');
  }

  try {
    return YAML.parse(compose, { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    throw new Error('Cloudflare Compose template must render valid YAML');
  }
}

/**
 * Checks the model's shape and returns its single connector service, rejecting settings outside the
 * allowlists.
 */
function connectorService(model: any, service: string): any {
  requireCondition(isMapping(model), 'render a Compose mapping');
  requireCondition(isMapping(model.services), 'define a services mapping');
  requireCondition(
    Object.keys(model.services).length === 1,
    'define exactly one connector service',
  );

  const connector = model.services[service];
  requireCondition(isMapping(connector), `define the connector service "${service}"`);
  requireCondition(
    Object.keys(model).every((key) => ALLOWED_TOP_LEVEL_SETTINGS.has(key)),
    'use only the supported top-level settings',
  );
  requireCondition(
    Object.keys(connector).every((key) => ALLOWED_CONNECTOR_SETTINGS.has(key)),
    'use only the supported connector settings',
  );
  return connector;
}

/**
 * Keeps the stack identity fixed while allowing supported runtime tuning.
 */
function checkConnectorIdentity(model: any, connector: any, proxy: CloudflareProxy): void {
  requireCondition(model.name === `${proxy.container}-ingress`, 'preserve the stack project name');
  requireCondition(
    connector.container_name === proxy.container,
    'preserve the connector container name',
  );
  requireCondition(
    connector.image === (proxy.provision?.image ?? DEFAULT_CLOUDFLARED_IMAGE),
    'use the configured connector image',
  );
  requireCondition(
    connector.user === (proxy.provision?.user ?? DEFAULT_CONNECTOR_USER),
    'use the configured connector user',
  );
  requireCondition(connector.restart === 'unless-stopped', 'use the unless-stopped restart policy');
}

/**
 * Checks the connector's privilege restrictions and credential source.
 */
function checkConnectorIsolation(connector: any, envFile: string): void {
  // The allowed settings exclude ports, volumes, builds and namespace or privilege overrides.
  requireCondition(connector.read_only === true, 'keep the connector filesystem read-only');
  requireCondition(connector.cap_drop?.includes('ALL'), 'drop all connector capabilities');
  requireCondition(
    connector.security_opt?.includes('no-new-privileges:true'),
    'prevent privilege escalation',
  );

  // Credentials come only from the selected raw env file, never command arguments or environment
  // overrides.
  requireCondition(
    JSON.stringify(connector.env_file) ===
      JSON.stringify([{ path: envFile, required: true, format: 'raw' }]),
    'preserve the credential env-file source',
  );
  requireCondition(
    JSON.stringify(connector.entrypoint) === '["cloudflared"]',
    'use the cloudflared entrypoint',
  );
}

/**
 * Checks that the connector command is a literal `tunnel … run` argument list without credential
 * options, with private metrics and the configured drain deadline.
 */
function checkConnectorCommand(command: unknown, gracePeriodSeconds: number): void {
  requireCondition(Array.isArray(command), 'define the connector command as an argument list');
  requireCondition(
    command.every(
      (argument: unknown) =>
        typeof argument === 'string' && !NON_LITERAL_ARGUMENT_PATTERN.test(argument),
    ),
    'use literal single-line command arguments',
  );
  requireCondition(
    command[0] === 'tunnel' && command.at(-1) === 'run',
    'run the cloudflared tunnel command',
  );

  for (const option of CREDENTIAL_OPTIONS) {
    requireCondition(
      command.every(
        (argument: string) => argument !== option && !argument.startsWith(option + '='),
      ),
      `omit the ${option} command option`,
    );
  }

  requireCondition(command.includes('--no-autoupdate'), 'disable connector autoupdates');

  // Metrics stay private and the command uses the configured drain deadline.
  requireCondition(
    command.filter((argument) => argument === '--metrics').length === 1,
    'set metrics exactly once',
  );
  requireCondition(
    command.every((argument: string) => !argument.startsWith('--metrics=')),
    'use a separate metrics address argument',
  );
  requireCondition(
    command[command.indexOf('--metrics') + 1] === METRICS_ADDRESS,
    'bind metrics to the private listener',
  );
  requireCondition(
    command.filter((argument) => argument === '--grace-period').length === 1,
    'set the drain deadline exactly once',
  );
  requireCondition(
    command[command.indexOf('--grace-period') + 1] === `${gracePeriodSeconds}s`,
    'preserve the configured drain deadline',
  );
}

/**
 * Keeps readiness, bounded resources and shutdown budgets mandatory.
 */
function checkConnectorRuntime(connector: any, gracePeriodSeconds: number): void {
  const readinessTest = ['CMD', 'cloudflared', 'tunnel', '--metrics', METRICS_ADDRESS, 'ready'];
  requireCondition(
    JSON.stringify(connector.healthcheck?.test) === JSON.stringify(readinessTest),
    'use the native connector readiness check',
  );
  requireCondition(!connector.healthcheck?.disable, 'keep the readiness check enabled');
  requireCondition(
    ROTATING_LOG_DRIVERS.has(connector.logging?.driver),
    'use a supported rotating log driver',
  );
  requireCondition(
    BYTE_SIZE_PATTERN.test(String(connector.logging?.options?.['max-size'])),
    'set a positive log file size limit',
  );
  requireCondition(
    POSITIVE_INTEGER_PATTERN.test(String(connector.logging?.options?.['max-file'])),
    'set a positive log file retention count',
  );
  requireCondition(
    BYTE_SIZE_PATTERN.test(String(connector.mem_limit)),
    'set a positive memory limit',
  );
  requireCondition(
    Number.isInteger(connector.pids_limit) && connector.pids_limit >= 1,
    'set a positive PID limit',
  );
  requireCondition(
    connector.stop_grace_period === `${gracePeriodSeconds + SHUTDOWN_HEADROOM_SECONDS}s`,
    'preserve shutdown headroom beyond the drain deadline',
  );
}

/**
 * Origins share one external network; only the connector joins the separate egress network.
 */
function checkNetworks(model: any, connector: any, proxy: CloudflareProxy): void {
  requireCondition(isMapping(model.networks), 'define a networks mapping');
  requireCondition(
    Object.keys(model.networks).every((key) => ALLOWED_NETWORKS.has(key)),
    'define only the edge and egress networks',
  );
  requireCondition(
    JSON.stringify(model.networks.egress) === '{}',
    'keep the egress network private',
  );

  const edge = model.networks.edge;
  requireCondition(isMapping(edge), 'define the shared edge network');
  requireCondition(
    Object.keys(edge).every((key) => ALLOWED_EDGE_NETWORK_SETTINGS.has(key)),
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
 * JSON-quotes every template value, so substituted scalars can't change the YAML structure.
 */
function jsonQuoted(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]),
  );
}

/**
 * Generates a guarded host bootstrap, keeping credentials out of templates, plans and SSH command
 * arguments.
 */
export function provisionOperation(proxy: CloudflareProxy): IngressOperation {
  const config = proxy.provision;
  if (
    config === undefined ||
    proxy.dir === undefined ||
    proxy.container === undefined ||
    proxy.network === undefined
  ) {
    throw new Error('Cloudflare provisioning requires provision, dir, container and network');
  }

  const composeFile = proxy.composeFile ?? 'compose.yaml';
  const envFile = config.envFile ?? `${proxy.dir}/.credentials.env`;
  if (
    !COMPOSE_FILE_NAME_PATTERN.test(composeFile) ||
    [proxy.dir, envFile].some((path) => UNSAFE_PATH_PATTERN.test(path)) ||
    envFile === `${proxy.dir}/${composeFile}`
  ) {
    throw new Error('Cloudflare provisioning requires safe separate Compose and credential paths');
  }

  const service = proxy.service ?? 'connector';
  const project = `${proxy.container}-ingress`;
  const gracePeriodSeconds = config.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS;
  const values = jsonQuoted({
    service,
    project,
    container: proxy.container,
    network: proxy.network,
    image: config.image ?? DEFAULT_CLOUDFLARED_IMAGE,
    envFile,
    user: config.user ?? DEFAULT_CONNECTOR_USER,
    gracePeriod: `${gracePeriodSeconds}s`,
    stopGracePeriod: `${gracePeriodSeconds + SHUTDOWN_HEADROOM_SECONDS}s`,
  });

  const compose = renderTemplate(
    proxy.templates?.compose,
    defaultComposeTemplate,
    values,
    'Cloudflare Compose template',
  );

  validateCompose(compose, proxy, service, envFile);

  return {
    label:
      `<provision Cloudflare connector ${proxy.container} in ${proxy.dir}, ` +
      'validate and wait for connections>',
    input: JSON.stringify({ compose }),
    ...(config.secrets === undefined
      ? {}
      : {
          secrets: config.secrets,
          secretVariables: { TUNNEL_TOKEN: config.tokenVariable ?? 'CLOUDFLARE_TUNNEL_TOKEN' },
        }),
    script: [
      'set +x',
      'set -euo pipefail',
      REMOTE_PATH,
      `proxy_dir=${shellQuote(proxy.dir)}`,
      `compose_file=${shellQuote(composeFile)}`,
      `container=${shellQuote(proxy.container)}`,
      `service=${shellQuote(service)}`,
      `project=${shellQuote(project)}`,
      `network=${shellQuote(proxy.network)}`,
      `env_file=${shellQuote(envFile)}`,
      `managed_credentials=${config.secrets === undefined ? 'no' : 'yes'}`,
      `wait_timeout=${config.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS}`,
      `cf_account=${shellQuote(proxy.accountId)}`,
      `cf_tunnel=${shellQuote(proxy.tunnelId)}`,
      readFileSync(new URL('./provision.sh', import.meta.url), 'utf8'),
      '',
    ].join('\n'),
  };
}

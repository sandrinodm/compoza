import { Schema } from 'effect';
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
 * A setting whose value the requirement checks inspect themselves. Any value passes the shape
 * check, so a wrong value fails with the requirement it breaks rather than a generic shape error.
 */
const Setting = Schema.optionalKey(Schema.Unknown);

/**
 * A YAML mapping with string keys and values of any type; scalars, null and sequences don't match.
 */
const Mapping = Schema.Record(Schema.String, Schema.Unknown);

/**
 * The only top-level Compose settings a custom connector template may use. Only `services` has a
 * fixed shape here; the project name and networks are checked later with their own requirements.
 */
const ComposeDocument = Schema.Struct({
  /**
   * The Compose project name, which must stay `<container>-ingress`.
   */
  name: Setting,

  /**
   * The services by name, which must hold only the connector.
   */
  services: Mapping,

  /**
   * The stack networks, which must be the shared edge network and the private egress network.
   */
  networks: Setting,
});

/**
 * A parsed Compose document with a services mapping and only unchecked top-level values.
 */
type ComposeDocument = typeof ComposeDocument.Type;

/**
 * The only connector service settings a custom template may use. Leaving out ports, volumes, builds
 * and namespace or privilege overrides is what keeps the connector isolated.
 */
const ConnectorService = Schema.Struct({
  /**
   * The connector image, which must be the configured one.
   */
  image: Setting,

  /**
   * The container name, which must be the configured connector container.
   */
  container_name: Setting,

  /**
   * The UID:GID the connector runs as, which must be the configured user.
   */
  user: Setting,

  /**
   * The restart policy, which must be `unless-stopped`.
   */
  restart: Setting,

  /**
   * The entrypoint, which must be exactly `cloudflared`.
   */
  entrypoint: Setting,

  /**
   * The cloudflared argument list, checked by `checkConnectorCommand`.
   */
  command: Setting,

  /**
   * Whether the root filesystem is read-only, which it must be.
   */
  read_only: Setting,

  /**
   * The dropped capabilities, which must include `ALL`.
   */
  cap_drop: Setting,

  /**
   * The security options, which must include `no-new-privileges:true`.
   */
  security_opt: Setting,

  /**
   * How long Docker waits before killing the connector, which must be the drain deadline plus
   * headroom.
   */
  stop_grace_period: Setting,

  /**
   * The memory limit, which must be a positive byte size.
   */
  mem_limit: Setting,

  /**
   * The process limit, which must be a positive integer.
   */
  pids_limit: Setting,

  /**
   * The CPU limit, which is free to tune.
   */
  cpus: Setting,

  /**
   * The log driver and rotation options, which must rotate with positive limits.
   */
  logging: Setting,

  /**
   * The env-file sources, which must be only the selected raw credential file.
   */
  env_file: Setting,

  /**
   * The networks the connector joins, which must be exactly edge and egress.
   */
  networks: Setting,

  /**
   * The readiness check, which must be the native connector readiness command and stay enabled.
   */
  healthcheck: Setting,
});

/**
 * A connector service mapping with only supported settings, each value still unchecked.
 */
type ConnectorService = typeof ConnectorService.Type;

/**
 * The `healthcheck` settings the readiness requirements read.
 */
const Healthcheck = Schema.Struct({
  /**
   * The readiness command.
   */
  test: Setting,

  /**
   * Whether the check is turned off.
   */
  disable: Setting,
});

/**
 * The `logging` settings the rotation requirements read.
 */
const Logging = Schema.Struct({
  /**
   * The Docker log driver.
   */
  driver: Setting,

  /**
   * The driver options, read as `LoggingOptions`.
   */
  options: Setting,
});

/**
 * The log driver options the rotation requirements read.
 */
const LoggingOptions = Schema.Struct({
  /**
   * The largest log file before rotation, as a Compose byte size.
   */
  'max-size': Setting,

  /**
   * How many rotated log files to keep.
   */
  'max-file': Setting,
});

/**
 * A setting that `includes` can search for a required entry: a list, or a single string, which is
 * searched as a substring.
 */
const SearchableSetting = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);

/**
 * A command given as a YAML sequence, before its arguments are checked.
 */
const ArgumentList = Schema.Array(Schema.Unknown);

/**
 * A command whose arguments are all literal single-line strings, so none can expand or inject
 * another line.
 */
const LiteralArguments = Schema.Array(
  Schema.String.check(
    Schema.makeFilter((argument: string) => !NON_LITERAL_ARGUMENT_PATTERN.test(argument)),
  ),
);

/**
 * The only networks the connector stack may define.
 */
const Networks = Schema.Struct({
  /**
   * The shared external network that origins join.
   */
  edge: Setting,

  /**
   * The private network only the connector joins, which must be an empty mapping.
   */
  egress: Setting,
});

/**
 * The only settings the shared edge network may use.
 */
const EdgeNetwork = Schema.Struct({
  /**
   * The Docker network name, which must be the configured shared network.
   */
  name: Setting,

  /**
   * Whether Compose uses an existing network, which it must.
   */
  external: Setting,
});

/**
 * The top-level settings names from `ComposeDocument`.
 */
const ALLOWED_TOP_LEVEL_SETTINGS = new Set(Object.keys(ComposeDocument.fields));

/**
 * The connector setting names from `ConnectorService`.
 */
const ALLOWED_CONNECTOR_SETTINGS = new Set(Object.keys(ConnectorService.fields));

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
 * The network names from `Networks`.
 */
const ALLOWED_NETWORKS = new Set(Object.keys(Networks.fields));

/**
 * The edge network setting names from `EdgeNetwork`.
 */
const ALLOWED_EDGE_NETWORK_SETTINGS = new Set(Object.keys(EdgeNetwork.fields));

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
 * Checks custom Compose output before planning host operations, preserving connector identity and
 * runtime guarantees.
 */
function validateCompose(
  compose: string,
  proxy: CloudflareProxy,
  service: string,
  envFile: string,
): void {
  const model = composeDocument(parseCompose(compose));
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
function parseCompose(compose: string): unknown {
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
 * Checks that the parsed output is a mapping with a services mapping.
 */
function composeDocument(model: unknown): ComposeDocument {
  requireCondition(Schema.is(Mapping)(model), 'render a Compose mapping');
  requireCondition(Schema.is(ComposeDocument)(model), 'define a services mapping');
  return model;
}

/**
 * Returns the document's single connector service, rejecting settings outside the allowlists.
 */
function connectorService(model: ComposeDocument, service: string): ConnectorService {
  requireCondition(
    Object.keys(model.services).length === 1,
    'define exactly one connector service',
  );

  const connector = model.services[service];
  requireCondition(
    Schema.is(ConnectorService)(connector),
    `define the connector service "${service}"`,
  );
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
function checkConnectorIdentity(
  model: ComposeDocument,
  connector: ConnectorService,
  proxy: CloudflareProxy,
): void {
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
function checkConnectorIsolation(connector: ConnectorService, envFile: string): void {
  // The allowed settings exclude ports, volumes, builds and namespace or privilege overrides.
  requireCondition(connector.read_only === true, 'keep the connector filesystem read-only');
  requireCondition(
    Schema.is(SearchableSetting)(connector.cap_drop) && connector.cap_drop.includes('ALL'),
    'drop all connector capabilities',
  );
  requireCondition(
    Schema.is(SearchableSetting)(connector.security_opt) &&
      connector.security_opt.includes('no-new-privileges:true'),
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
  requireCondition(
    Schema.is(ArgumentList)(command),
    'define the connector command as an argument list',
  );
  requireCondition(
    Schema.is(LiteralArguments)(command),
    'use literal single-line command arguments',
  );

  // The guard intersects with the argument list type above; this restates it as plain strings.
  const args: ReadonlyArray<string> = command;
  requireCondition(
    args[0] === 'tunnel' && args.at(-1) === 'run',
    'run the cloudflared tunnel command',
  );

  for (const option of CREDENTIAL_OPTIONS) {
    requireCondition(
      args.every((argument) => argument !== option && !argument.startsWith(option + '=')),
      `omit the ${option} command option`,
    );
  }

  requireCondition(args.includes('--no-autoupdate'), 'disable connector autoupdates');

  // Metrics stay private and the command uses the configured drain deadline.
  requireCondition(
    args.filter((argument) => argument === '--metrics').length === 1,
    'set metrics exactly once',
  );
  requireCondition(
    args.every((argument) => !argument.startsWith('--metrics=')),
    'use a separate metrics address argument',
  );
  requireCondition(
    args[args.indexOf('--metrics') + 1] === METRICS_ADDRESS,
    'bind metrics to the private listener',
  );
  requireCondition(
    args.filter((argument) => argument === '--grace-period').length === 1,
    'set the drain deadline exactly once',
  );
  requireCondition(
    args[args.indexOf('--grace-period') + 1] === `${gracePeriodSeconds}s`,
    'preserve the configured drain deadline',
  );
}

/**
 * Keeps readiness, bounded resources and shutdown budgets mandatory.
 */
function checkConnectorRuntime(connector: ConnectorService, gracePeriodSeconds: number): void {
  // A healthcheck or logging value that isn't a mapping reads as one without settings, so each
  // requirement below fails on its own missing setting.
  const healthcheck: typeof Healthcheck.Type = Schema.is(Healthcheck)(connector.healthcheck)
    ? connector.healthcheck
    : {};
  const readinessTest = ['CMD', 'cloudflared', 'tunnel', '--metrics', METRICS_ADDRESS, 'ready'];
  requireCondition(
    JSON.stringify(healthcheck.test) === JSON.stringify(readinessTest),
    'use the native connector readiness check',
  );
  requireCondition(!healthcheck.disable, 'keep the readiness check enabled');

  const logging: typeof Logging.Type = Schema.is(Logging)(connector.logging)
    ? connector.logging
    : {};
  requireCondition(
    typeof logging.driver === 'string' && ROTATING_LOG_DRIVERS.has(logging.driver),
    'use a supported rotating log driver',
  );

  const options: typeof LoggingOptions.Type = Schema.is(LoggingOptions)(logging.options)
    ? logging.options
    : {};
  requireCondition(
    BYTE_SIZE_PATTERN.test(String(options['max-size'])),
    'set a positive log file size limit',
  );
  requireCondition(
    POSITIVE_INTEGER_PATTERN.test(String(options['max-file'])),
    'set a positive log file retention count',
  );
  requireCondition(
    BYTE_SIZE_PATTERN.test(String(connector.mem_limit)),
    'set a positive memory limit',
  );
  requireCondition(
    typeof connector.pids_limit === 'number' &&
      Number.isInteger(connector.pids_limit) &&
      connector.pids_limit >= 1,
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
function checkNetworks(
  model: ComposeDocument,
  connector: ConnectorService,
  proxy: CloudflareProxy,
): void {
  const networks = model.networks;
  requireCondition(Schema.is(Networks)(networks), 'define a networks mapping');
  requireCondition(
    Object.keys(networks).every((key) => ALLOWED_NETWORKS.has(key)),
    'define only the edge and egress networks',
  );
  requireCondition(JSON.stringify(networks.egress) === '{}', 'keep the egress network private');

  const edge = networks.edge;
  requireCondition(Schema.is(EdgeNetwork)(edge), 'define the shared edge network');
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

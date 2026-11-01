import { Effect, FileSystem, type Option, Path, Schema } from 'effect';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProxyConfig as CaddyProxy } from '../extensions/caddy/config.ts';
import type { DeployConfig } from './deploy.ts';

import { DeployError, platformFailure } from '../errors.ts';
import { ProxyConfig, HostIngress, resolveHostIngress, loadHostExtensionFiles } from '../extensions/config.ts';
import { readJsonFile } from './json-file.ts';
import { Ipv4, Name, Platform, Registry, SshDestination } from './schema.ts';
export { ProxyConfig } from '../extensions/config.ts';
export { DEFAULT_PROXY_COMPOSE_FILE, proxyComposeFile, proxyService } from '../extensions/caddy/config.ts';

/**
 * Images reach the host through a registry: built with `--push` here, pulled by Compose there. The host needs a stored
 * login for the registry, which the readiness check verifies.
 */
export const RegistryTransport = Schema.Struct({
  /**
   * Selects this mode.
   */
  mode: Schema.Literal('registry'),

  /**
   * The registry both sides use, without a scheme.
   */
  registry: Registry,
});

/**
 * Images reach the host over SSH: built with `--load` here, then `docker save` piped through `ssh` into `docker load`
 * there. No registry is involved, so Compose runs with `--pull never`.
 */
export const SshLoadTransport = Schema.Struct({
  /**
   * Selects this mode.
   */
  mode: Schema.Literal('ssh-load'),
});

/**
 * How built images get to the host.
 */
export const Transport = Schema.Union([
  RegistryTransport,
  SshLoadTransport,
  Schema.Struct({
    /**
     * The native host BuildKit transport; SSH Compose execution is required.
     */
    mode: Schema.Literal('remote-build'),
  }),
]);

/**
 * One Docker host: where to reach it, what it runs, how images get there, and its shared proxy if it has one.
 */
export const HostConfig = Schema.Struct({
  /**
   * SSH destination, e.g. `deploy@server.example.com`; also the Docker endpoint as `ssh://<ssh>`.
   */
  ssh: SshDestination,

  /**
   * The legacy Caddy DNS address; named host ingress stores this under ingress.caddy.address.
   */
  address: Schema.optionalKey(Ipv4),

  /**
   * The single build platform for this host, e.g. `linux/arm64`.
   */
  platform: Platform,

  /**
   * How images get to the host.
   */
  transport: Transport,

  /**
   * The legacy flat host ingress settings, replaced by named ingress for new configurations.
   */
  proxy: Schema.optionalKey(ProxyConfig),

  /**
   * The named host ingress extension; cannot be combined with the legacy proxy field.
   */
  ingress: Schema.optionalKey(HostIngress),
}).check(
  Schema.makeFilter((host) => host.ingress === undefined || host.proxy === undefined, {
    message: 'Use ingress or legacy proxy, never both',
  }),
);

/**
 * The hosts file: a host key to its configuration.
 */
export const Hosts = Schema.Record(Name, HostConfig);

/**
 * An external file containing one complete host configuration.
 */
const HostReference = Schema.Struct({
  /**
   * A local file path, relative to the containing hosts file or absolute; a leading ~/ is expanded.
   */
  $ref: Schema.String.check(Schema.isPattern(/\S/, { message: 'expected a nonempty file path' })),
});

/**
 * Hosts on disk can be inline configurations or references; deployment code receives resolved hosts only.
 */
const HostsFile = Schema.Record(Name, Schema.Union([HostConfig, HostReference]));

/**
 * A decoded host entry.
 */
export type HostConfig = typeof HostConfig.Type;

/**
 * A decoded transport entry.
 */
export type Transport = typeof Transport.Type;

/**
 * A decoded hosts file.
 */
export type Hosts = typeof Hosts.Type;

/**
 * The environment variable that overrides where the hosts file is read from.
 */
export const HOSTS_ENV = 'COMPOZA_HOSTS';

/**
 * The global hosts file, overlaid by hosts.json in the current working directory unless explicitly overridden.
 */
export const DEFAULT_HOSTS_PATH = '~/.config/compoza/hosts.json';

/**
 * Replaces a leading `~/` with the home folder, as shells would; any other path is returned unchanged.
 */
export function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * The hosts file path for a run: the `--hosts` flag, else the environment variable, else the default.
 */
export function hostsPath(override: Option.Option<string>): string {
  return expandHome(override._tag === 'Some' ? override.value : (process.env[HOSTS_ENV] ?? DEFAULT_HOSTS_PATH));
}

/**
 * Reads a hosts file while retaining its directory for external references.
 */
const readHostsFile = Effect.fn('readHostsFile')(function* (file: string) {
  const path = yield* Path.Path;
  const resolved = path.resolve(file);
  const entries = yield* readJsonFile(
    resolved,
    HostsFile,
    `No hosts file at ${resolved}. Create it, or point --hosts or ${HOSTS_ENV} at one.`,
  );
  return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, { entry, file: resolved }]));
});

/**
 * Resolves only the winning entries, so a local override does not read a superseded global reference.
 */
const resolveHosts = Effect.fn('resolveHosts')(function* (
  entries: Record<string, { entry: (typeof HostsFile.Type)[string]; file: string }>,
) {
  const path = yield* Path.Path;
  const hosts: Record<string, HostConfig> = {};
  for (const [name, { entry, file }] of Object.entries(entries)) {
    if ('$ref' in entry) {
      const referenced = path.resolve(path.dirname(file), expandHome(entry.$ref));
      const host = yield* readJsonFile(
        referenced,
        HostConfig,
        `No host configuration at ${referenced} (host "${name}" referenced by ${file}).`,
      );
      hosts[name] = yield* loadHostExtensionFiles(host, referenced);
    } else {
      hosts[name] = yield* loadHostExtensionFiles(entry, file);
    }
  }
  return hosts;
});

/**
 * Reads and validates one explicitly selected hosts file, including its external host references.
 */
export const loadHosts = Effect.fn('loadHosts')(function* (file: string) {
  return yield* resolveHosts(yield* readHostsFile(expandHome(file)));
});

/**
 * Overlays current-directory hosts on global hosts by name. Either file may be absent, but not both.
 */
export const loadDefaultHosts = Effect.fn('loadDefaultHosts')(function* (
  directory = process.cwd(),
  globalFile = DEFAULT_HOSTS_PATH,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const files = [...new Set([path.resolve(expandHome(globalFile)), path.resolve(directory, 'hosts.json')])];
  let entries: Record<string, { entry: (typeof HostsFile.Type)[string]; file: string }> = {};
  let found = false;
  for (const file of files) {
    if (yield* fs.exists(file).pipe(Effect.mapError(platformFailure(`Looking for ${file}`)))) {
      entries = { ...entries, ...(yield* readHostsFile(file)) };
      found = true;
    }
  }
  if (!found) {
    return yield* new DeployError({
      message: `No hosts file at ${files.join(' or ')}. Create one, or point --hosts or ${HOSTS_ENV} at one.`,
    });
  }
  return yield* resolveHosts(entries);
});

/**
 * Explicit flag/environment selection is exclusive; otherwise use the local-over-global host configuration.
 */
export const loadHostsForRun = Effect.fn('loadHostsForRun')(function* (override: Option.Option<string>) {
  return yield* override._tag === 'Some' || process.env[HOSTS_ENV] !== undefined
    ? loadHosts(hostsPath(override))
    : loadDefaultHosts();
});

/**
 * Looks up the host an app deploys to, failing with the known host names when the key is unknown.
 */
export function hostFor(config: DeployConfig, hosts: Hosts): Effect.Effect<HostConfig, DeployError> {
  return hostNamed(config.host, hosts);
}

/**
 * Looks up a host by its key, for commands that take a host rather than an app.
 */
export function hostNamed(name: string, hosts: Hosts): Effect.Effect<HostConfig, DeployError> {
  const host = hosts[name];
  if (host === undefined) {
    const known = Object.keys(hosts).join(', ') || 'none';
    return Effect.fail(new DeployError({ message: `Unknown host "${name}" (hosts file defines: ${known})` }));
  }
  return Effect.succeed(host);
}

/**
 * The legacy Caddy proxy lookup, rejecting missing or incompatible host ingress settings.
 */
export function proxyOf(host: HostConfig, hostName: string): Effect.Effect<CaddyProxy, DeployError> {
  const proxy = ingressConfigOf(host);
  return proxy === undefined || (proxy.provider !== undefined && proxy.provider !== 'caddy-sites')
    ? Effect.fail(
        new DeployError({
          message: `Host "${hostName}" has no compatible Caddy proxy entry; add one to use caddy-sites ingress`,
        }),
      )
    : Effect.succeed(proxy);
}

/**
 * The Docker endpoint for a host, as `docker --host` takes it.
 */
export function dockerHost(host: HostConfig): string {
  return `ssh://${host.ssh}`;
}

/**
 * The registry a host pulls from, or `undefined` for a host that receives images over SSH.
 */
export function registryOf(host: HostConfig): string | undefined {
  return host.transport.mode === 'registry' ? host.transport.registry : undefined;
}

/**
 * Resolves the host's selected ingress settings while rejecting competing new and legacy declarations.
 */
export function ingressConfigOf(host: HostConfig): ProxyConfig | undefined {
  if (host.ingress !== undefined && host.proxy !== undefined) {
    throw new Error('Use ingress or legacy proxy, never both');
  }
  return host.ingress === undefined ? host.proxy : resolveHostIngress(host.ingress);
}

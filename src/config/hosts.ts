import { Effect, FileSystem, type Option, Path, Schema } from 'effect';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProxyConfig as CaddyProxy } from '../extensions/caddy/config.ts';
import type { DeployConfig } from './deploy.ts';

import { DeployError, platformFailure } from '../errors.ts';
import {
  type ProxyConfig,
  HostIngress,
  type IngressId,
  resolveHostIngress,
  loadHostExtensionFiles,
} from '../extensions/config.ts';
import { fileExists, readConfigFile } from './config-file.ts';
import { Name, Platform, Registry, SshDestination } from './schema.ts';
import { loadSettings } from './settings.ts';

export type { ProxyConfig } from '../extensions/config.ts';
export {
  DEFAULT_PROXY_COMPOSE_FILE,
  proxyComposeFile,
  proxyService,
} from '../extensions/caddy/config.ts';

/**
 * The environment variable that overrides where the hosts file is read from.
 */
export const HOSTS_ENV = 'COMPOZA_HOSTS';

/**
 * The global hosts file, overlaid by hosts.yaml in the current working directory unless explicitly
 * overridden.
 */
export const DEFAULT_HOSTS_PATH = '~/.config/compoza/hosts.yaml';

/**
 * The hosts file looked for in the current working directory, whose entries replace the global
 * file's entries of the same name.
 */
const LOCAL_HOSTS_FILE = 'hosts.yaml';

/**
 * Images reach the host through a registry: built with `--push` here, pulled by Compose there. The
 * host needs a stored login for the registry, which the readiness check verifies.
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
 * Images reach the host over SSH: built with `--load` here, then `docker save` piped through `ssh`
 * into `docker load` there. No registry is involved, so Compose runs with `--pull never`.
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
 * One Docker host: where to reach it, what it runs, how images get there, and its shared proxy if
 * it has one.
 */
export const HostConfig = Schema.Struct({
  /**
   * SSH destination, e.g. `deploy@server.example.com`; also the Docker endpoint as `ssh://<ssh>`.
   */
  ssh: SshDestination,

  /**
   * The single build platform for this host, e.g. `linux/arm64`.
   */
  platform: Platform,

  /**
   * How images get to the host.
   */
  transport: Transport,

  /**
   * The host's ingress capabilities: Caddy, Cloudflare Tunnel, both, or `none`.
   */
  ingress: Schema.optionalKey(HostIngress),
});

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
 * Hosts on disk can be inline configurations or references; deployment code receives resolved hosts
 * only.
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
 * The entries read from one or more hosts files, each with the file it came from, so a `$ref`
 * resolves against the folder of the file that contains it.
 */
type HostEntries = Record<string, { entry: (typeof HostsFile.Type)[string]; file: string }>;

/**
 * Replaces a leading `~/` with the home folder, as shells would; any other path is returned
 * unchanged.
 */
export function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * The hosts file path for a run: the `--hosts` flag, else the environment variable, else the
 * default.
 */
export function hostsPath(override: Option.Option<string>): string {
  return expandHome(
    override._tag === 'Some' ? override.value : (process.env[HOSTS_ENV] ?? DEFAULT_HOSTS_PATH),
  );
}

/**
 * Reads a hosts file while retaining its directory for external references.
 */
const readHostsFile = Effect.fn('readHostsFile')(function* (file: string) {
  const path = yield* Path.Path;
  const resolved = path.resolve(file);
  const entries = yield* readConfigFile(
    resolved,
    HostsFile,
    `No hosts file at ${resolved}. Create it, or point --hosts or ${HOSTS_ENV} at one.`,
  );
  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [name, { entry, file: resolved }]),
  );
});

/**
 * Resolves only the winning entries, so a local override does not read a superseded global
 * reference.
 */
const resolveHosts = Effect.fn('resolveHosts')(function* (entries: HostEntries) {
  const path = yield* Path.Path;
  const hosts: Record<string, HostConfig> = {};

  for (const [name, { entry, file }] of Object.entries(entries)) {
    if ('$ref' in entry) {
      const referenced = path.resolve(path.dirname(file), expandHome(entry.$ref));
      const host = yield* readConfigFile(
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
export const loadHosts = Effect.fn('loadHosts')(function* (
  file: string,
): Effect.fn.Return<Record<string, HostConfig>, DeployError, FileSystem.FileSystem | Path.Path> {
  return yield* resolveHosts(yield* readHostsFile(expandHome(file)));
});

/**
 * Where `loadDefaultHosts` looks for hosts.
 */
interface DefaultHostsOptions {
  /**
   * The folder whose `hosts.yaml` overrides every other file; the working directory when left out.
   */
  readonly directory?: string;

  /**
   * The global hosts file; `DEFAULT_HOSTS_PATH` when left out.
   */
  readonly globalFile?: string;

  /**
   * Linked hosts files, or folders holding a `hosts.yaml`, read alongside the global file; none
   * when left out.
   */
  readonly links?: ReadonlyArray<string>;
}

/**
 * Overlays current-directory hosts on the global and linked hosts by name.
 *
 * The global and local files may each be absent, but not both unless a link supplies hosts. A
 * missing link, and a host name defined in more than one of the global and linked files, fail with
 * a `DeployError` naming the files.
 */
export const loadDefaultHosts = Effect.fn('loadDefaultHosts')(function* (
  options: DefaultHostsOptions = {},
): Effect.fn.Return<Record<string, HostConfig>, DeployError, FileSystem.FileSystem | Path.Path> {
  return yield* resolveHosts(yield* defaultHostEntries(options));
});

/**
 * Explicit flag/environment selection is exclusive; otherwise use the local-over-global host
 * configuration, including the hosts files linked in the settings file.
 */
export const loadHostsForRun = Effect.fn('loadHostsForRun')(function* (
  override: Option.Option<string>,
): Effect.fn.Return<Record<string, HostConfig>, DeployError, FileSystem.FileSystem | Path.Path> {
  return yield* resolveHosts(yield* hostEntriesForRun(override));
});

/**
 * A host name and the hosts file whose entry for it a run uses.
 */
export interface HostSource {
  /**
   * The host key.
   */
  readonly name: string;

  /**
   * The absolute path of the hosts file that defines the host.
   */
  readonly file: string;
}

/**
 * The hosts a run would use and the file each comes from, sorted by name. `$ref` targets are not
 * read; otherwise it fails like `loadHostsForRun`.
 */
export const hostSourcesForRun = Effect.fn('hostSourcesForRun')(function* (
  override: Option.Option<string>,
): Effect.fn.Return<ReadonlyArray<HostSource>, DeployError, FileSystem.FileSystem | Path.Path> {
  const entries = yield* hostEntriesForRun(override);
  return Object.entries(entries)
    .map(([name, { file }]) => ({ name, file }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

/**
 * Validates the hosts shared by every working directory: the global file and `links`, including
 * their `$ref` targets. A current-directory `hosts.yaml` is not read. Fails with a `DeployError`
 * like `loadDefaultHosts`.
 */
export const checkSharedHosts = Effect.fn('checkSharedHosts')(function* (
  links: ReadonlyArray<string>,
  globalFile: string = DEFAULT_HOSTS_PATH,
): Effect.fn.Return<void, DeployError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const files = yield* sharedHostsFiles(path.resolve(expandHome(globalFile)), links);
  yield* resolveHosts(yield* mergeSharedEntries(files));
});

/**
 * Whether a run reads one hosts file only: `--hosts` (passed as `override`) or `COMPOZA_HOSTS`
 * selects it, and the global file, the current-directory `hosts.yaml`, the links and the settings
 * file are all ignored.
 */
export function usesExclusiveHostsFile(override: Option.Option<string>): boolean {
  return override._tag === 'Some' || process.env[HOSTS_ENV] !== undefined;
}

/**
 * The entries a run reads: only the explicit file when `--hosts` or the environment variable
 * selects one, else the default overlay with the links from the settings file.
 */
const hostEntriesForRun = Effect.fn('hostEntriesForRun')(function* (
  override: Option.Option<string>,
) {
  if (usesExclusiveHostsFile(override)) {
    return yield* readHostsFile(hostsPath(override));
  }

  const settings = yield* loadSettings();
  return yield* defaultHostEntries({ links: settings.hosts?.links ?? [] });
});

/**
 * The global and linked entries, overlaid by the current-directory `hosts.yaml`.
 */
const defaultHostEntries = Effect.fn('defaultHostEntries')(function* ({
  directory = process.cwd(),
  globalFile = DEFAULT_HOSTS_PATH,
  links = [],
}: DefaultHostsOptions) {
  const path = yield* Path.Path;
  const global = path.resolve(expandHome(globalFile));
  const local = path.resolve(directory, LOCAL_HOSTS_FILE);
  const shared = yield* sharedHostsFiles(global, links, local);
  const hasLocal = yield* fileExists(local);

  if (shared.length === 0 && !hasLocal) {
    return yield* new DeployError({
      message:
        `No hosts file at ${[...new Set([global, local])].join(' or ')}. ` +
        `Create one, or point --hosts or ${HOSTS_ENV} at one.`,
    });
  }

  const entries = yield* mergeSharedEntries(shared);
  return hasLocal ? { ...entries, ...(yield* readHostsFile(local)) } : entries;
});

/**
 * The global file when it exists, then each link's hosts file, without duplicates and without
 * `excluded`, the current-directory file that is read as the override instead.
 */
const sharedHostsFiles = Effect.fn('sharedHostsFiles')(function* (
  global: string,
  links: ReadonlyArray<string>,
  excluded?: string,
) {
  const files = (yield* fileExists(global)) ? [global] : [];

  for (const link of links) {
    files.push(yield* linkedHostsFile(link));
  }

  return [...new Set(files)].filter((file) => file !== excluded);
});

/**
 * The hosts file a link names: the file itself, or the `hosts.yaml` inside a linked folder. A
 * relative link resolves against the working directory, and a leading `~/` is expanded.
 */
const linkedHostsFile = Effect.fn('linkedHostsFile')(function* (link: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(expandHome(link));
  if (!(yield* fileExists(target))) {
    return yield* new DeployError({
      message: `Linked hosts ${link} does not exist. ${unlinkHint(link)}`,
    });
  }

  const info = yield* fs.stat(target).pipe(Effect.mapError(platformFailure(`Reading ${target}`)));
  if (info.type !== 'Directory') {
    return target;
  }

  const file = path.join(target, LOCAL_HOSTS_FILE);
  if (!(yield* fileExists(file))) {
    return yield* new DeployError({
      message: `Linked folder ${link} has no ${LOCAL_HOSTS_FILE}. ${unlinkHint(link)}`,
    });
  }

  return file;
});

/**
 * Reads the shared hosts files in order, failing when two of them define the same host name:
 * neither is meant to override the other, so silently picking one would deploy to the wrong host.
 */
const mergeSharedEntries = Effect.fn('mergeSharedEntries')(function* (
  files: ReadonlyArray<string>,
) {
  let entries: HostEntries = {};

  for (const file of files) {
    const next = yield* readHostsFile(file);

    for (const name of Object.keys(next)) {
      // An own-property check, so a host named like an Object method (`constructor`) is not
      // mistaken for one defined earlier.
      const existing = Object.hasOwn(entries, name) ? entries[name] : undefined;
      if (existing !== undefined) {
        return yield* new DeployError({
          message:
            `Host "${name}" is defined in both ${existing.file} and ${file}. ` +
            'Rename or remove one of them, or unlink one of the files.',
        });
      }
    }

    entries = { ...entries, ...next };
  }

  return entries;
});

/**
 * How to recover from a link that no longer points at a hosts file.
 */
function unlinkHint(link: string): string {
  return `Restore it, or run: compoza hosts unlink ${link}`;
}

/**
 * Looks up the host an app deploys to, failing with the known host names when the key is unknown.
 */
export function hostFor(
  config: DeployConfig,
  hosts: Hosts,
): Effect.Effect<HostConfig, DeployError> {
  return hostNamed(config.host, hosts);
}

/**
 * Looks up a host by its key, for commands that take a host rather than an app.
 */
export function hostNamed(name: string, hosts: Hosts): Effect.Effect<HostConfig, DeployError> {
  const host = Object.hasOwn(hosts, name) ? hosts[name] : undefined;
  if (host === undefined) {
    const known = Object.keys(hosts).join(', ') || 'none';
    return Effect.fail(
      new DeployError({ message: `Unknown host "${name}" (hosts file defines: ${known})` }),
    );
  }

  return Effect.succeed(host);
}

/**
 * The host's Caddy ingress settings, failing when the host has no Caddy ingress.
 */
export function proxyOf(
  host: HostConfig,
  hostName: string,
): Effect.Effect<CaddyProxy, DeployError> {
  const proxy = ingressConfigOf(host, 'caddy');
  if (proxy?.provider !== 'caddy') {
    return Effect.fail(
      new DeployError({
        message:
          `Host "${hostName}" has no compatible Caddy proxy entry; ` +
          'add one to use caddy ingress',
      }),
    );
  }

  return Effect.succeed(proxy);
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
 * Resolves one host ingress capability, `undefined` when the host has none (or not the requested
 * `provider`). Throws when the host has both providers and `provider` does not pick one.
 */
export function ingressConfigOf(host: HostConfig, provider?: IngressId): ProxyConfig | undefined {
  return host.ingress === undefined ? undefined : resolveHostIngress(host.ingress, provider);
}

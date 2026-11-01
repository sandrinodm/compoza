import { posix } from 'node:path';

import type { BundleFile } from './bundle.ts';
import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { REMOTE_PATH, shellQuote } from './command.ts';
import { directoriesOf, ingressOf, projectNameOf } from './config/deploy.ts';
import { secretEnvironment, validateSecrets } from './config/secrets.ts';
import { resolveSecrets } from './extensions/config.ts';
import { ingressFor, ingressOperationScript } from './extensions/ingress.ts';
import { imageReference, imageVariable } from './plan.ts';
import { runtimeAsset, runtimeSource } from './ssh-runtime.ts';
import { candidateSecrets, stageSecrets } from './ssh-secrets.ts';

/**
 * The shell-safe release identifier used in symlinks and rollback selectors.
 *
 * Identifiers are directory names, never paths, so rollback cannot escape the release store.
 */
export function releaseId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error('Release IDs must be simple directory names of at most 128 characters');
  }
  return value;
}

/**
 * The required SSH stack root, rejecting a filesystem root or shell-control characters.
 *
 * Every mutation is confined to the tool-owned release and lock children; data and host env paths are never removed.
 */
export function stackRoot(app: App): string {
  const root = app.config.remote?.stackDir;
  if (
    root === undefined ||
    root === '/' ||
    root.split('/').some((part) => part === '.' || part === '..') ||
    /[\r\n\0]/.test(root)
  ) {
    throw new Error(
      'SSH execution requires remote.stackDir: a non-root absolute host directory without dot components',
    );
  }
  return root.replace(/\/$/, '');
}

/**
 * Builds the non-secret dotenv payload using Compose's double-quoted literal escaping.
 *
 * Image variables are reserved and exported by the recovery wrapper, so production dotenv or inherited shell variables
 * cannot replace them. Configured variables must be explicit non-secret strings.
 */
export function generatedEnvironment(app: App): string {
  const reserved = new Set(app.config.targets.map(imageVariable));
  if (reserved.size !== app.config.targets.length) {
    throw new Error('Targets must map to distinct image variables');
  }
  return (
    Object.entries(app.config.environment ?? {})
      .map(([key, value]) => {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          reserved.has(key) ||
          key.startsWith('COMPOSE_') ||
          key.startsWith('DOCKER_') ||
          ['HOME', 'PATH', 'USER', 'XDG_RUNTIME_DIR'].includes(key) ||
          /[\r\n\0]/.test(value)
        ) {
          throw new Error(`Invalid or reserved Compose environment key/value: ${key}`);
        }
        const literal = value
          .replaceAll('\\', '\\\\')
          .replaceAll('"', '\\"')
          .replaceAll('$', () => '$$');
        return `${key}="${literal}"`;
      })
      .join('\n') + '\n'
  );
}

/**
 * Builds a version-2 recovery entry point for the release’s ordinary Bash runtime and frozen JSON launch metadata.
 *
 * A clean shell environment prevents SSH session variables from overriding dotenv. Only Docker connection and home
 * settings survive, preserving rootless Linux and macOS Docker contexts without importing arbitrary application
 * values.
 */
export function composeWrapper(_app: App, _host: HostConfig, _tag: string, release: string): string {
  return `#!/usr/bin/env bash\n# compoza-runtime-v2\nset -euo pipefail\n${REMOTE_PATH}\nexec bash ${shellQuote(`${release}/runtime.sh`)} compose ${shellQuote(release)} "$@"\n`;
}

/**
 * Builds frozen non-secret Compose arguments and image assignments as JSON data.
 *
 * Host shell sources interpret none of these strings as code, preserving literal path and profile characters.
 */
function composeMetadata(app: App, host: HostConfig, tag: string, release: string): string {
  return (
    JSON.stringify({
      version: 2,
      arguments: [
        '--project-name',
        projectNameOf(app),
        '--project-directory',
        release,
        ...app.config.composeFiles.flatMap((file) => ['--file', `${release}/${file}`]),
        ...(app.config.remote?.overlayFile === undefined ? [] : ['--file', app.config.remote.overlayFile]),
        ...(app.config.profiles ?? []).flatMap((profile) => ['--profile', profile]),
      ],
      images: app.config.targets.map((target) => ({
        name: imageVariable(target),
        value: imageReference(app, host, target, tag, false),
      })),
      legacy: {
        path:
          app.config.secrets !== undefined && resolveSecrets(app.config.secrets).provider === 'none'
            ? '-'
            : app.config.secrets === undefined
              ? (app.config.remote?.envFile ?? `${stackRoot(app)}/.env`)
              : null,
        required: app.config.remote?.envFile !== undefined,
      },
    }) + '\n'
  );
}

/**
 * The shared mutation preamble: rejects symlinked stack ancestors and acquires a portable mkdir lock.
 *
 * The trap only removes this invocation's lock. A killed SSH session releases it; SIGKILL or host power loss can leave
 * a stale lock, which requires operator inspection rather than unsafe automatic lock stealing.
 */
export function lockPreamble(root: string): string {
  return `set -euo pipefail\n${REMOTE_PATH}\n${runtimeSource()}root=${shellQuote(root)}\ncompoza_lock\n`;
}

/**
 * Builds a bounded HTTP wait on the host, accepting the same below-500 statuses as the client wait.
 *
 * Curl bodies and error messages are discarded so authenticated service responses cannot enter deployment logs.
 */
export function healthScript(url: string, timeoutSeconds: number): string {
  return `echo 'Waiting for HTTP readiness'
deadline=$((SECONDS + ${timeoutSeconds}))
ready=no
while [ "$SECONDS" -lt "$deadline" ]; do
  remaining=$((deadline - SECONDS))
  limit=$((remaining < 10 ? remaining : 10))
  code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time "$limit" ${shellQuote(url)} 2>/dev/null) || code=000
  case "$code" in [1-4][0-9][0-9]) ready=yes; break;; esac
  echo "  still waiting: HTTP $code"
  sleep 2
done
[ "$ready" = yes ] || { echo 'HTTP readiness timed out; containers may have changed, previous current remains' >&2; exit 1; }`;
}

/**
 * Builds validation, health-gated Compose and promotion of one candidate release under the stack lock.
 *
 * Failure leaves the previous successful pointer untouched and the candidate for diagnosis. Compose can have partially
 * changed containers; no automatic rollback or reversal of data migrations is claimed.
 */
function activateScript(release: string | undefined, timeout: number, pull: string, source = ''): string {
  return `compoza_read_state\n${source}candidate=${release === undefined ? '"$root/releases/$selected"' : shellQuote(release)}\n[ -d "$candidate" ] && [ ! -L "$candidate" ] || { echo 'Release not found' >&2; exit 1; }\ncompoza_activate ${timeout} ${shellQuote(pull)} ${source === '' ? 'no' : 'yes'}\n`;
}

/**
 * Builds a full release upload and activation, paired with the line-oriented base64 stdin payload.
 *
 * Release directories are immutable candidates. Host dotenv, overlays, persistent folders and older releases are never
 * overwritten or deleted. Failed or interrupted staging never changes the current pointer.
 */
export function deploymentScript(
  app: App,
  host: HostConfig,
  tag: string,
  id: string,
  bundle: ReadonlyArray<BundleFile>,
  secrets?: Readonly<Record<string, string>>,
): { readonly script: string; readonly input: string } {
  if (secrets !== undefined) {
    validateSecrets(app, secrets);
  }
  const root = stackRoot(app);
  const release = `${root}/releases/${releaseId(id)}`;
  const ingress = ingressFor(app)?.plan(app, host);
  const route = ingress === undefined ? 'set -eu\n' : ingressOperationScript(ingress.route);
  const unroute = ingress === undefined ? 'set -eu\n' : ingressOperationScript(ingress.unroute);
  const health = app.config.health;
  const url = health?.url ?? ingress?.healthUrl;
  const generated: Array<BundleFile> = [
    ['compose.sh', composeWrapper(app, host, tag, release)],
    ['compose.json', composeMetadata(app, host, tag, release)],
    ['runtime.sh', runtimeAsset('runtime.sh')],
    ['model.jq', runtimeAsset('model.jq')],
    ['status.jq', runtimeAsset('status.jq')],
    [
      'release.env',
      generatedEnvironment(app) +
        app.config.targets
          .map((target) => `${imageVariable(target)}=${imageReference(app, host, target, tag, false)}\n`)
          .join(''),
    ],
    [
      'directories.sh',
      `set -eu\n${directoriesOf(app.config).length === 0 ? '' : `mkdir -p -- ${directoriesOf(app.config).map(shellQuote).join(' ')}`}\n`,
    ],
    ['route.sh', route],
    ['unroute.sh', unroute],
    ['health.sh', `set -eu\n${url === undefined ? '' : healthScript(url, health?.timeoutSeconds ?? 180)}\n`],
    [
      'manifest.json',
      JSON.stringify({
        version: 2,
        id,
        tag,
        project: projectNameOf(app),
        files: bundle.map((file) => file.path),
        composeFiles: app.config.composeFiles,
        profiles: app.config.profiles ?? [],
        transport: host.transport.mode,
      }) + '\n',
    ],
  ].map(([path, content]) => ({ path: path!, encoded: Buffer.from(content!).toString('base64') }));
  const files = [...bundle, ...generated];
  const staging = files
    .map(
      (file) =>
        `mkdir -p -- ${shellQuote(posix.dirname(`${release}/${file.path}`))}\nIFS= read -r encoded || { echo 'Interrupted bundle upload' >&2; exit 1; }\nprintf '%s' "$encoded" | compoza_decode > ${shellQuote(`${release}/${file.path}`)}`,
    )
    .join('\n');
  return {
    script: `${lockPreamble(root)}
[ ! -e "$root/current" ] || [ -L "$root/current" ] || { echo 'Unsafe current pointer' >&2; exit 1; }
[ ! -e "$root/previous" ] || [ -L "$root/previous" ] || { echo 'Unsafe previous pointer' >&2; exit 1; }
mkdir -- ${shellQuote(release)}
${staging}
${secrets === undefined ? '' : stageSecrets(root, id)}${activateScript(release, app.config.remote?.waitTimeoutSeconds ?? 180, host.transport.mode === 'registry' ? 'always' : 'missing', candidateSecrets(app, root, id, secrets !== undefined))}`,
    input:
      files.map((file) => file.encoded).join('\n') +
      '\n' +
      (secrets === undefined ? '' : Buffer.from(secretEnvironment(secrets)).toString('base64') + '\n'),
  };
}

/**
 * Builds an action using only the deployed recovery wrapper, rather than local candidate Compose files.
 *
 * Mutating actions take the same stack lock as deployment. Inspection does not acquire locks or write host state.
 */
export function deployedScript(app: App, args: ReadonlyArray<string>, mutate: boolean): string {
  const root = stackRoot(app);
  return `set -euo pipefail\n${REMOTE_PATH}\n${runtimeSource()}root=${shellQuote(root)}
compoza_read_state
[ "$release_id" != '-' ] || { echo 'No deployed release; deploy this destination first' >&2; exit 1; }
candidate="$root/releases/$release_id"
compoza_supported
${mutate ? 'compoza_lock\ncompoza_read_state\ncandidate="$root/releases/$release_id"\ncompoza_supported\n' : ''}if ! compoza_compose_release config --quiet >/dev/null 2>&1; then
  echo 'Deployed Compose configuration is invalid; inspect host env and overlay privately' >&2; exit 1
fi
${args[0] === 'down' ? 'bash "$candidate/unroute.sh"\n' : ''}compoza_compose_safe ${args.map(shellQuote).join(' ')}
`;
}

/**
 * Builds an explicit release rollback under the same lock, preserving its config, profiles and image references.
 *
 * Rollback retains the active managed snapshot or legacy host dotenv and live overlay. Earlier runtime formats are
 * rejected before Compose runs. Image availability and irreversible migrations remain operational concerns; a failed
 * rollback can partially change containers.
 */
export function rollbackScript(app: App, id?: string): string {
  const root = stackRoot(app);
  if (id !== undefined) {
    releaseId(id);
  }
  return `set -euo pipefail\n${REMOTE_PATH}\n${runtimeSource()}root=${shellQuote(root)}\ncompoza_read_state
[ "$release_id" != '-' ] || { echo 'No active release or secret source; deploy this destination before rollback' >&2; exit 1; }
selected=${id === undefined ? '"$previous_id"' : shellQuote(id)}
[ "$selected" != '-' ] || { echo 'No previous successful release' >&2; exit 1; }
[ -d "$root/releases/$selected" ] && [ ! -L "$root/releases/$selected" ] && [ -f "$root/releases/$selected/successful" ] || { echo 'Rollback requires a successful release' >&2; exit 1; }
candidate="$root/releases/$selected"
compoza_supported
compoza_lock
compoza_read_state
selected=${id === undefined ? '"$previous_id"' : shellQuote(id)}
[ "$selected" != '-' ] || { echo 'No previous successful release' >&2; exit 1; }
${activateScript(undefined, app.config.remote?.waitTimeoutSeconds ?? 180, 'missing')}`;
}

/**
 * Builds read-only SSH execution prerequisites without creating stack paths or selecting builders.
 *
 * The host needs Bash, Compose with wait support, jq for private JSON validation, and curl only for HTTP probes.
 */
export function sshReadinessScript(app: App, host: HostConfig): string {
  const root = stackRoot(app);
  return `set -eu
${REMOTE_PATH}
printf 'docker='; if docker info >/dev/null 2>&1; then echo yes; else echo no; fi
printf 'compose='; if docker compose up --help 2>/dev/null | grep -q -- --wait-timeout && docker compose config --help 2>/dev/null | grep -q -- --no-env-resolution; then echo yes; else echo no; fi
printf 'jq='; if command -v jq >/dev/null 2>&1; then echo yes; else echo no; fi
printf 'stack_path='; if [ -L ${shellQuote(root)} ] || [ -L ${shellQuote(`${root}/releases`)} ]; then echo no; else echo yes; fi
printf 'host_env='; if ${app.config.remote?.envFile === undefined ? 'true' : `[ -r ${shellQuote(app.config.remote.envFile)} ]`}; then echo yes; else echo no; fi
printf 'host_overlay='; if ${app.config.remote?.overlayFile === undefined ? 'true' : `[ -r ${shellQuote(app.config.remote.overlayFile)} ]`}; then echo yes; else echo no; fi
printf 'curl='; if ${app.config.health === undefined && ingressOf(app.config).mode === 'none' ? 'true' : 'command -v curl >/dev/null 2>&1'}; then echo yes; else echo no; fi
printf 'buildkit='; if ${host.transport.mode === 'remote-build' && app.config.targets.length > 0 ? 'docker buildx version >/dev/null 2>&1' : 'true'}; then echo yes; else echo no; fi
`;
}

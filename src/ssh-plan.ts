import { posix } from 'node:path';

import type { BundleFile } from './bundle.ts';
import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { REMOTE_PATH, shellQuote } from './command.ts';
import { directoriesOf, ingressOf, projectNameOf } from './config/deploy.ts';
import { secretEnvironment, validateSecrets } from './config/secrets.ts';
import { ingressFor, ingressOperationScript } from './extensions/ingress.ts';
import { imageReference, imageVariable } from './plan.ts';
import { runtimeSource } from './ssh-runtime.ts';

/**
 * The required SSH stack root, rejecting a filesystem root or shell-control characters.
 *
 * Only tool-owned stack files are replaced; operator data, overlays and host env files are never removed.
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
 * Image variables are reserved and written into the generated dotenv, so a separate host dotenv or inherited shell
 * variables cannot replace them. Configured variables must be explicit non-secret strings.
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
 * The shared mutation preamble: rejects symlinked stack ancestors and acquires a portable mkdir lock.
 *
 * The trap only removes this invocation's lock. A killed SSH session releases it; SIGKILL or host power loss can leave
 * a stale lock, which requires operator inspection rather than unsafe automatic lock stealing.
 */
export function lockPreamble(root: string): string {
  return `set +x\nset -euo pipefail\n${REMOTE_PATH}\n${runtimeSource()}root=${shellQuote(root)}\ncompoza_lock\n`;
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
[ "$ready" = yes ] || { echo 'HTTP readiness timed out; containers may have changed, redeploy a known image tag to recover' >&2; exit 1; }`;
}

/**
 * Builds a flat stack upload and validation transaction with no retained deployment history.
 *
 * Compose source files are normalized without interpolation in the temporary lock folder. The selected dotenv and live
 * operator overlay validate that output before tool-owned stack files are replaced. Containers can still change
 * partially if Compose, routing or health fails; recovery is another deployment with a known image tag.
 */
export function deploymentScript(
  app: App,
  host: HostConfig,
  tag: string,
  bundle: ReadonlyArray<BundleFile>,
  secrets?: Readonly<Record<string, string>>,
): { readonly script: string; readonly input: string } {
  if (secrets !== undefined) {
    validateSecrets(app, secrets);
  }

  const root = stackRoot(app);
  const assets = bundle.filter((file) => !app.config.composeFiles.includes(file.path));
  if (assets.some((file) => file.path === 'compose.yaml' || file.path.startsWith('compose.yaml/'))) {
    throw new Error('compose.yaml is the generated stack file and cannot be declared as an asset');
  }

  const files = ['compose.yaml', ...assets.map((file) => file.path)];
  const outputs = [...files, '.env', '.compoza.json'];

  for (const path of [app.config.remote?.envFile, app.config.remote?.overlayFile]) {
    if (path !== undefined && outputs.some((file) => posix.normalize(path) === `${root}/${file}`)) {
      throw new Error('Host env and overlay files must be separate from tool-owned stack files');
    }
  }

  const ingress = ingressFor(app)?.plan(app, host);
  const url = app.config.health?.url ?? ingress?.healthUrl;
  const metadata = JSON.stringify({
    version: 1,
    project: projectNameOf(app),
    tag,
    profiles: app.config.profiles ?? [],
    files,
    overlay: app.config.remote?.overlayFile ?? null,
    hostEnv: app.config.remote?.envFile ?? null,
    managed: secrets !== undefined,
    unroute: ingress === undefined ? '' : ingressOperationScript(ingress.unroute),
  });

  const environment =
    generatedEnvironment(app) +
    secretEnvironment({
      ...secrets,
      ...Object.fromEntries(
        app.config.targets.map((target) => [imageVariable(target), imageReference(app, host, target, tag, false)]),
      ),
    });

  const staging = bundle.map(
    (file) =>
      `mkdir -p -- "$upload"/${shellQuote(posix.dirname(file.path))}\ncompoza_receive "$upload"/${shellQuote(file.path)}`,
  );

  const installs = outputs.map(
    (file) =>
      `mkdir -p -- ${shellQuote(posix.dirname(`${root}/${file}`))}\nmv -f -- "$upload"/${shellQuote(file)} ${shellQuote(`${root}/${file}`)}`,
  );
  return {
    script: `${lockPreamble(root)}
metadata="$root/.compoza.json"
if [ -e "$metadata" ] || [ -L "$metadata" ]; then compoza_metadata; fi
${outputs.map((file) => `compoza_target ${shellQuote(file)}`).join('\n')}
upload="$root/.deploy-lock/upload"
mkdir "$upload"
compoza_receive() {
  local encoded
  IFS= read -r encoded || { echo 'Interrupted stack upload' >&2; return 1; }
  printf '%s' "$encoded" | compoza_decode > "$1" || { echo 'Invalid stack upload' >&2; return 1; }
}
${staging.join('\n')}
compoza_receive "$upload/.compoza.json"
compoza_receive "$upload/.env"
metadata="$upload/.compoza.json"
env_file="$upload/.env"
compose_file="$upload/compose.yaml"
compoza_metadata
if ! compoza_compose normalize ${app.config.composeFiles.map((file) => `"$upload"/${shellQuote(file)}`).join(' ')} > "$upload/normalized.yaml" 2>/dev/null; then
  echo 'Compose normalization failed; inspect selected files privately' >&2; exit 1
fi
mv -f -- "$upload/normalized.yaml" "$compose_file"
echo 'Validating stack Compose configuration'
if ! compoza_compose config --quiet >/dev/null 2>&1; then
  echo 'Compose validation failed; inspect host env and overlay privately' >&2; exit 1
fi
if ! compoza_compose config --format json --no-env-resolution --no-path-resolution 2>/dev/null | compoza_validate_model >/dev/null 2>&1; then
  echo 'Unsafe Compose paths; inspect declared assets and host file paths privately' >&2; exit 1
fi
${installs.join('\n')}
upload=''
metadata="$root/.compoza.json"
env_file="$root/.env"
compose_file="$root/compose.yaml"
${directoriesOf(app.config).length === 0 ? '' : `mkdir -p -- ${directoriesOf(app.config).map(shellQuote).join(' ')}`}
echo 'Starting stack and waiting for running/healthy services'
if ! compoza_compose up --detach --remove-orphans --no-build --pull ${host.transport.mode === 'registry' ? 'always' : 'missing'} --wait --wait-timeout ${app.config.remote?.waitTimeoutSeconds ?? 180} >/dev/null 2>&1; then
  echo 'Compose failed; containers may be partially updated. Recover by deploying a known image tag.' >&2; exit 1
fi
${ingress === undefined ? '' : `bash -c ${shellQuote(ingressOperationScript(ingress.route))}`}
${url === undefined ? '' : healthScript(url, app.config.health?.timeoutSeconds ?? 180)}
echo 'Stack deployment complete'
`,
    input:
      [
        ...bundle.map((file) => file.encoded),
        Buffer.from(metadata).toString('base64'),
        Buffer.from(environment).toString('base64'),
      ].join('\n') + '\n',
  };
}

/**
 * Uses deployed lifecycle metadata and flat Compose files, ignoring unshipped local configuration changes.
 *
 * Mutations share the deployment lock; inspection does not create host paths or read a client credential provider.
 */
export function deployedScript(app: App, args: ReadonlyArray<string>, mutate: boolean): string {
  const root = stackRoot(app);
  return `set +x\nset -euo pipefail\n${REMOTE_PATH}\n${runtimeSource()}root=${shellQuote(root)}
compoza_root || { echo 'Unsafe stack path' >&2; exit 1; }
${mutate ? 'compoza_lock' : ''}
metadata="$root/.compoza.json"
compoza_metadata
compose_file="$root/compose.yaml"
env_file="$root/.env"
[ -f "$compose_file" ] && [ ! -L "$compose_file" ] && [ -f "$env_file" ] && [ ! -L "$env_file" ] || { echo 'Missing or unsafe deployed stack files' >&2; exit 1; }
if ! compoza_compose config --quiet >/dev/null 2>&1; then
  echo 'Deployed Compose configuration is invalid; inspect host env and overlay privately' >&2; exit 1
fi
${args[0] === 'down' ? 'jq -r .unroute "$metadata" | bash\n' : ''}compoza_compose_safe ${args.map(shellQuote).join(' ')}
`;
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
printf 'compose='; if docker compose up --help 2>/dev/null | grep -q -- --wait-timeout && docker compose config --help 2>/dev/null | grep -q -- --no-interpolate && docker compose config --help 2>/dev/null | grep -q -- --no-env-resolution; then echo yes; else echo no; fi
printf 'jq='; if command -v jq >/dev/null 2>&1; then echo yes; else echo no; fi
printf 'stack_path='; if [ -L ${shellQuote(root)} ] || [ -L ${shellQuote(`${root}/.compoza.json`)} ]; then echo no; else echo yes; fi
printf 'host_env='; if ${app.config.remote?.envFile === undefined ? 'true' : `[ -r ${shellQuote(app.config.remote.envFile)} ]`}; then echo yes; else echo no; fi
printf 'host_overlay='; if ${app.config.remote?.overlayFile === undefined ? 'true' : `[ -r ${shellQuote(app.config.remote.overlayFile)} ]`}; then echo yes; else echo no; fi
printf 'curl='; if ${app.config.health === undefined && ingressOf(app.config).mode === 'none' ? 'true' : 'command -v curl >/dev/null 2>&1'}; then echo yes; else echo no; fi
printf 'buildkit='; if ${host.transport.mode === 'remote-build' && app.config.targets.length > 0 ? 'docker buildx version >/dev/null 2>&1' : 'true'}; then echo yes; else echo no; fi
`;
}

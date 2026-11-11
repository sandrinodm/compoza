import { posix } from 'node:path';

import type { BundleFile } from './bundle.ts';
import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';
import type { IngressPlan } from './extensions/ingress.ts';

import { composeBundlePath, ROLES_OVERRIDE_FILE, ROLES_OVERRIDE_RESERVED } from './bundle.ts';
import { REMOTE_PATH, shellQuote } from './command.ts';
import { directoriesOf, ingressOf, projectNameOf } from './config/deploy.ts';
import { secretEnvironment, validateSecrets } from './config/secrets.ts';
import { ingressFor, ingressOperationScript } from './extensions/ingress.ts';
import { buildingRoles, roleOverride } from './roles.ts';
import { runtimeSource } from './ssh-runtime.ts';

/**
 * How long `compose up --wait` waits for running and healthy services when `remote` sets no
 * `waitTimeoutSeconds`.
 */
const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;

/**
 * How long the host waits for the HTTP readiness probe when `health` sets no `timeoutSeconds`.
 */
const DEFAULT_HEALTH_TIMEOUT_SECONDS = 180;

/**
 * Line breaks and NUL, which would split or truncate a value embedded in a host script or dotenv
 * line.
 */
const LINE_BREAK_OR_NUL = /[\r\n\0]/;

/**
 * One trailing slash, dropped from the stack root so joined paths never contain `//`.
 */
const TRAILING_SLASH = /\/$/;

/**
 * A portable environment variable name: a letter or underscore, then letters, digits and
 * underscores.
 */
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variables the host shell and Compose depend on, which configured environment cannot replace.
 */
const RESERVED_ENVIRONMENT_KEYS = new Set(['HOME', 'PATH', 'USER', 'XDG_RUNTIME_DIR']);

/**
 * Prefixes of variables that change how the Compose and Docker CLIs behave.
 */
const RESERVED_ENVIRONMENT_PREFIXES = ['COMPOSE_', 'DOCKER_'];

/**
 * A shell condition that holds when the host's Compose supports every flag the stack transaction
 * uses: `up --wait-timeout`, and `config --no-interpolate` and `--no-env-resolution`.
 */
const COMPOSE_FEATURES_CHECK = [
  'docker compose up --help 2>/dev/null | grep -q -- --wait-timeout',
  'docker compose config --help 2>/dev/null | grep -q -- --no-interpolate',
  'docker compose config --help 2>/dev/null | grep -q -- --no-env-resolution',
].join(' && ');

/**
 * The pieces of the stack transaction script that depend on the app, host and bundle.
 */
interface TransactionScriptParts {
  /**
   * The stack root on the host, without a trailing slash.
   */
  readonly root: string;

  /**
   * The upload-relative Compose files to normalize, in selection order.
   */
  readonly composeFiles: ReadonlyArray<string>;

  /**
   * Every stack file the transaction installs: the generated Compose file, the assets, `.env` and
   * `.compoza.json`.
   */
  readonly outputs: ReadonlyArray<string>;

  /**
   * The selected files, received from standard input in this order.
   */
  readonly bundle: ReadonlyArray<BundleFile>;

  /**
   * Whether the generated roles override follows the bundle on standard input. It is staged as
   * `ROLES_OVERRIDE_FILE` and normalized last, but never installed.
   */
  readonly hasOverride: boolean;

  /**
   * Host directories created before Compose starts the stack.
   */
  readonly directories: ReadonlyArray<string>;

  /**
   * The Compose `--pull` policy for the host's image transport.
   */
  readonly pull: 'always' | 'missing';

  /**
   * The `compose up --wait` timeout in seconds.
   */
  readonly waitTimeoutSeconds: number;

  /**
   * The ingress route command, or an empty line without ingress.
   */
  readonly route: string;

  /**
   * The HTTP readiness wait, or an empty line without a health URL.
   */
  readonly health: string;
}

/**
 * The required SSH stack root without a trailing slash. Throws when `remote.stackDir` is missing,
 * and otherwise with the first requirement it fails (see `stackRootIssue`).
 *
 * Only tool-owned stack files are replaced; operator data, overlays and host env files are never
 * removed.
 */
export function stackRoot(app: App): string {
  const root = app.config.remote?.stackDir;
  if (root === undefined) {
    throw new Error(
      'SSH execution requires remote.stackDir; set it to the host directory for the stack files',
    );
  }

  const issue = stackRootIssue(root);
  if (issue !== undefined) {
    throw new Error(issue);
  }

  return root.replace(TRAILING_SLASH, '');
}

/**
 * Builds the non-secret dotenv payload using Compose's double-quoted literal escaping.
 *
 * Configured variables must be explicit non-secret strings.
 */
export function generatedEnvironment(app: App): string {
  const environment = app.config.environment ?? {};
  for (const [key, value] of Object.entries(environment)) {
    const issue = environmentVariableIssue(key, value);
    if (issue !== undefined) {
      throw new Error(issue);
    }
  }

  // Configured values use the same literal dotenv encoding as secret values.
  return secretEnvironment(environment);
}

/**
 * The shared mutation preamble: rejects symlinked stack ancestors and acquires a portable mkdir
 * lock.
 *
 * The trap only removes this invocation's lock. A killed SSH session releases it; SIGKILL or host
 * power loss can leave a stale lock, which requires operator inspection rather than unsafe
 * automatic lock stealing.
 */
export function lockPreamble(root: string): string {
  return `${runtimePreamble(root)}compoza_lock\n`;
}

/**
 * Builds a bounded HTTP wait on the host, accepting the same below-500 statuses as the client wait.
 *
 * Curl bodies and error messages are discarded so authenticated service responses cannot enter
 * deployment logs.
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
 * Compose source files are normalized without interpolation in the temporary lock folder. The
 * selected dotenv and live operator overlay validate that output before tool-owned stack files are
 * replaced. Services are recreated so file bind mounts pick up replaced assets even when image tags
 * and Compose settings are unchanged. Containers can still change partially if Compose, routing or
 * health fails; recovery is another deployment with a known image tag.
 */
export function deploymentScript(
  app: App,
  host: HostConfig,
  tags: Readonly<Record<string, string>>,
  bundle: ReadonlyArray<BundleFile>,
  secrets?: Readonly<Record<string, string>>,
): { readonly script: string; readonly input: string } {
  if (secrets !== undefined) {
    validateSecrets(app, secrets);
  }

  const root = stackRoot(app);
  const composeFiles = app.config.composeFiles.map(composeBundlePath);
  const assets = bundle.filter((file) => !composeFiles.includes(file.path));
  if (assets.some((file) => isGeneratedComposePath(file.path))) {
    throw new Error('compose.yaml is the generated stack file and cannot be declared as an asset');
  }

  if (bundle.some((file) => file.path === ROLES_OVERRIDE_FILE)) {
    throw new Error(ROLES_OVERRIDE_RESERVED);
  }

  const override = roleOverride({ app, host, tags });

  const files = ['compose.yaml', ...assets.map((file) => file.path)];
  const outputs = [...files, '.env', '.compoza.json'];
  assertOverlaySeparate(app, root, outputs);

  const ingress = ingressFor(app)?.plan(app, host);
  const url = app.config.health?.url ?? ingress?.healthUrl;
  const metadata = deploymentMetadata(app, tags, files, ingress, secrets !== undefined);
  const environment = generatedEnvironment(app) + secretEnvironment({ ...secrets });

  const script = transactionScript({
    root,
    composeFiles,
    outputs,
    bundle,
    hasOverride: override !== undefined,
    directories: directoriesOf(app.config),
    pull: host.transport.mode === 'registry' ? 'always' : 'missing',
    waitTimeoutSeconds: app.config.remote?.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS,
    route:
      ingress === undefined ? '' : `bash -c ${shellQuote(ingressOperationScript(ingress.route))}`,
    health:
      url === undefined
        ? ''
        : healthScript(url, app.config.health?.timeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_SECONDS),
  });

  const input =
    [
      ...bundle.map((file) => file.encoded),
      ...(override === undefined ? [] : [Buffer.from(override).toString('base64')]),
      Buffer.from(metadata).toString('base64'),
      Buffer.from(environment).toString('base64'),
    ].join('\n') + '\n';
  return { script, input };
}

/**
 * Extra steps of a deployed-stack script.
 */
export interface DeployedScriptOptions {
  /**
   * A service the Compose command names: the script fails with the deployed service names, and runs
   * nothing, when the stack has no such service.
   */
  readonly service?: string | undefined;

  /**
   * Stop with exit status 0 on Ctrl-C (SIGINT), for commands such as `logs --follow` that only end
   * when interrupted.
   */
  readonly interruptible?: boolean;
}

/**
 * Uses deployed lifecycle metadata and flat Compose files, ignoring unshipped local configuration
 * changes.
 *
 * Mutations share the deployment lock; inspection does not create host paths or read a client
 * credential provider.
 */
export function deployedScript(
  app: App,
  args: ReadonlyArray<string>,
  mutate: boolean,
  { service, interruptible = false }: DeployedScriptOptions = {},
): string {
  const root = stackRoot(app);
  const unroute = args[0] === 'down' ? 'jq -r .unroute "$metadata" | bash\n' : '';
  const requireService =
    service === undefined ? '' : `compoza_require_service ${shellQuote(service)}\n`;
  const interrupt = interruptible ? "trap 'exit 0' INT\n" : '';
  return `${runtimePreamble(root)}compoza_root || { echo 'Unsafe stack path' >&2; exit 1; }
${mutate ? 'compoza_lock' : ''}
metadata="$root/.compoza.json"
compoza_metadata
compose_file="$root/compose.yaml"
env_file="$root/.env"
[ -f "$compose_file" ] && [ ! -L "$compose_file" ] && [ -f "$env_file" ] && [ ! -L "$env_file" ] || { echo 'Missing or unsafe deployed stack files' >&2; exit 1; }
if ! compoza_compose config --quiet >/dev/null 2>&1; then
  echo 'Deployed Compose configuration is invalid; inspect host env and overlay privately' >&2; exit 1
fi
${unroute}${requireService}${interrupt}compoza_compose_safe ${args.map(shellQuote).join(' ')}
`;
}

/**
 * Builds read-only SSH execution prerequisites without creating stack paths or selecting builders.
 *
 * The host needs Bash, Compose with wait support, jq for private JSON validation, and curl only for
 * HTTP probes.
 */
export function sshReadinessScript(app: App, host: HostConfig): string {
  const root = stackRoot(app);
  const quotedRoot = shellQuote(root);
  const quotedMetadata = shellQuote(`${root}/.compoza.json`);
  const overlayCheck = readableFileCheck(app.config.remote?.overlayFile);
  const probesHttp = app.config.health !== undefined || ingressOf(app.config).mode !== 'none';
  const curlCheck = probesHttp ? 'command -v curl >/dev/null 2>&1' : 'true';
  const buildsOnHost =
    host.transport.mode === 'remote-build' && buildingRoles(app.config).length > 0;
  const buildkitCheck = buildsOnHost ? 'docker buildx version >/dev/null 2>&1' : 'true';
  return `set -eu
${REMOTE_PATH}
printf 'docker='; if docker info >/dev/null 2>&1; then echo yes; else echo no; fi
printf 'compose='; if ${COMPOSE_FEATURES_CHECK}; then echo yes; else echo no; fi
printf 'jq='; if command -v jq >/dev/null 2>&1; then echo yes; else echo no; fi
printf 'stack_path='; if [ -L ${quotedRoot} ] || [ -L ${quotedMetadata} ]; then echo no; else echo yes; fi
printf 'host_overlay='; if ${overlayCheck}; then echo yes; else echo no; fi
printf 'curl='; if ${curlCheck}; then echo yes; else echo no; fi
printf 'buildkit='; if ${buildkitCheck}; then echo yes; else echo no; fi
`;
}

/**
 * Why a configured stack root is not safe to embed and operate on, or `undefined` when it is: it
 * must be absolute, not the filesystem root, without `.` or `..` components, and without line
 * breaks or NUL. The requirements are checked in that order and the first one that fails is
 * reported; the message never repeats the configured path.
 *
 * The config schema already requires an absolute path; checking it here as well keeps a relative
 * root from resolving against the SSH user's working folder when an app is built without decoding.
 */
function stackRootIssue(root: string): string | undefined {
  if (!root.startsWith('/')) {
    return 'remote.stackDir must be an absolute path; start it with /';
  }

  if (root === '/') {
    return 'remote.stackDir must not be the filesystem root; choose a directory below /';
  }

  if (root.split('/').some((part) => part === '.' || part === '..')) {
    return 'remote.stackDir must not contain . or .. components; write the path without them';
  }

  if (LINE_BREAK_OR_NUL.test(root)) {
    return 'remote.stackDir must not contain line breaks or NUL; remove them from the path';
  }

  return undefined;
}

/**
 * Why a configured variable may not be written into the generated dotenv, or `undefined` when it
 * may: its name must be portable, must not be reserved by Compose, Docker or the shell, and its
 * value must be a single line without NUL. The requirements are checked in that order and the first
 * one that fails is reported.
 *
 * Messages name the variable but never include its value.
 */
function environmentVariableIssue(key: string, value: string): string | undefined {
  if (!ENVIRONMENT_KEY.test(key)) {
    return (
      `Environment variable name ${key} is not portable; ` +
      'use a letter or underscore, then letters, digits and underscores'
    );
  }

  if (
    RESERVED_ENVIRONMENT_KEYS.has(key) ||
    RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    return (
      `Environment variable ${key} is reserved by Compose, Docker or the shell; ` +
      'rename it in environment'
    );
  }

  if (LINE_BREAK_OR_NUL.test(value)) {
    return (
      `Environment variable ${key} has a multi-line value; ` +
      'it must be a single line without line breaks or NUL'
    );
  }

  return undefined;
}

/**
 * The script prefix every stack script shares: strict Bash without tracing, the host `PATH`, the
 * runtime functions and the quoted stack root.
 */
function runtimePreamble(root: string): string {
  return [
    'set +x',
    'set -euo pipefail',
    REMOTE_PATH,
    // runtimeSource() already ends with a newline, so the root assignment starts its own line.
    `${runtimeSource()}root=${shellQuote(root)}`,
    '',
  ].join('\n');
}

/**
 * Whether an asset would replace the generated Compose file or a path below it.
 */
function isGeneratedComposePath(path: string): boolean {
  return path === 'compose.yaml' || path.startsWith('compose.yaml/');
}

/**
 * Rejects a host overlay file that resolves to one of the stack files the transaction replaces,
 * since installing the stack would overwrite operator-owned configuration.
 */
function assertOverlaySeparate(app: App, root: string, outputs: ReadonlyArray<string>): void {
  const path = app.config.remote?.overlayFile;
  if (path !== undefined && outputs.some((file) => posix.normalize(path) === `${root}/${file}`)) {
    throw new Error('Host overlay file must be separate from tool-owned stack files');
  }
}

/**
 * The lifecycle metadata stored as `.compoza.json`: what was deployed (the tag of every building
 * role), which files the tool owns, and the host-side ingress removal script that `down` runs
 * later.
 */
function deploymentMetadata(
  app: App,
  tags: Readonly<Record<string, string>>,
  files: ReadonlyArray<string>,
  ingress: IngressPlan | undefined,
  managed: boolean,
): string {
  return JSON.stringify({
    version: 1,
    project: projectNameOf(app),
    tags,
    profiles: app.config.profiles ?? [],
    files,
    ownedFiles: files,
    overlay: app.config.remote?.overlayFile ?? null,
    managed,
    unroute: ingress === undefined ? '' : ingressOperationScript(ingress.unroute),
  });
}

/**
 * Renders the stack transaction: lock, receive the bundle, normalize and validate it in the lock
 * folder, install the stack files, then start the stack, route ingress and wait for health.
 */
function transactionScript(parts: TransactionScriptParts): string {
  const { root, composeFiles, outputs, bundle, directories } = parts;
  const targets = outputs.map((file) => `compoza_target ${shellQuote(file)}`);
  const staging = bundle.map((file) =>
    [
      `mkdir -p -- "$upload"/${shellQuote(posix.dirname(file.path))}`,
      `compoza_receive "$upload"/${shellQuote(file.path)}`,
    ].join('\n'),
  );
  const stagedOverride = parts.hasOverride
    ? [`compoza_receive "$upload"/${shellQuote(ROLES_OVERRIDE_FILE)}`]
    : [];
  const uploadedComposeFiles = [
    ...composeFiles,
    ...(parts.hasOverride ? [ROLES_OVERRIDE_FILE] : []),
  ].map((file) => `"$upload"/${shellQuote(file)}`);
  const installs = outputs.map((file) =>
    [
      `mkdir -p -- ${shellQuote(posix.dirname(`${root}/${file}`))}`,
      `mv -f -- "$upload"/${shellQuote(file)} ${shellQuote(`${root}/${file}`)}`,
    ].join('\n'),
  );
  const createDirectories =
    directories.length === 0 ? '' : `mkdir -p -- ${directories.map(shellQuote).join(' ')}`;
  const up = [
    'compoza_compose up --detach --force-recreate --remove-orphans --no-build',
    `--pull ${parts.pull} --wait --wait-timeout ${parts.waitTimeoutSeconds}`,
  ].join(' ');
  return `${lockPreamble(root)}
metadata="$root/.compoza.json"
if [ -e "$metadata" ] || [ -L "$metadata" ]; then compoza_metadata; fi
${targets.join('\n')}
upload="$root/.deploy-lock/upload"
mkdir "$upload"
compoza_receive() {
  local encoded
  IFS= read -r encoded || { echo 'Interrupted stack upload' >&2; return 1; }
  printf '%s' "$encoded" | compoza_decode > "$1" || { echo 'Invalid stack upload' >&2; return 1; }
}
${[...staging, ...stagedOverride].join('\n')}
compoza_receive "$upload/.compoza.json"
compoza_receive "$upload/.env"
metadata="$upload/.compoza.json"
env_file="$upload/.env"
compose_file="$upload/compose.yaml"
compoza_metadata
compoza_merge_ownership
if ! compoza_compose normalize ${uploadedComposeFiles.join(' ')} > "$root/.deploy-lock/normalized.yaml" 2>/dev/null; then
  echo 'Compose normalization failed; inspect selected files privately' >&2; exit 1
fi
mv -f -- "$root/.deploy-lock/normalized.yaml" "$compose_file"
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
${createDirectories}
echo 'Starting stack and waiting for running/healthy services'
if ! ${up} >/dev/null 2>&1; then
  echo 'Compose failed; containers may be partially updated. Recover by deploying a known image tag.' >&2; exit 1
fi
${parts.route}
${parts.health}
echo 'Stack deployment complete'
`;
}

/**
 * A shell condition that holds when an optional host file is readable, or always when it is not
 * configured.
 */
function readableFileCheck(path: string | undefined): string {
  return path === undefined ? 'true' : `[ -r ${shellQuote(path)} ]`;
}

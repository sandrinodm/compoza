import { Console, Effect, Option } from 'effect';
import { Argument, CliError, Command, Flag } from 'effect/cli';

import type { App } from './config/deploy.ts';
import type { Resolved } from './deploy.ts';

import { blocking, type Check, formatChecks, runChecks } from './checks.ts';
import { command } from './command.ts';
import { rolesOf } from './config/deploy.ts';
import { hostLinks, linkHosts, unlinkHosts } from './config/host-links.ts';
import {
  hostNamed,
  hostSourcesForRun,
  loadHostsForRun,
  usesExclusiveHostsFile,
} from './config/hosts.ts';
import { readSecrets } from './config/secrets.ts';
import {
  deleteSetting,
  editSettings,
  SETTING_KEYS,
  type SettingKey,
  SettingsFile,
  loadSettings,
  settingValue,
} from './config/settings.ts';
import { deploy, resolve } from './deploy.ts';
import { DeployError } from './errors.ts';
import { hostIngress, tryIngressPlan } from './extensions/ingress.ts';
import { closestNames, helpText, IgnoredSharedFlags } from './help.ts';
import { setupOperationInput } from './ingress-setup.ts';
import { lifecycle, projectArgs, remove, requireProjectService } from './lifecycle.ts';
import { publish } from './publish.ts';
import { validateRoles } from './roles.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { type InspectOptions, inspectSsh } from './ssh-deploy.ts';

/**
 * The detail of a passing `secrets` check when the source holds no variables, as with `none` or an
 * empty env file.
 */
const NO_SECRET_NAMES = '(no variables)';

/**
 * Where the full command reference lives, for the root help.
 */
const COMMAND_REFERENCE_URL = 'https://github.com/sandrinodm/compoza/blob/main/docs/commands.md';

/**
 * The deploy folder argument shared by the app commands: a folder holding `deploy.yaml`, or the
 * file itself, defaulting to the working directory.
 */
const folder = Argument.String('folder').pipe(
  Argument.withDescription('Folder holding deploy.yaml, or the file itself; defaults to .'),
  Argument.withDefault('.'),
);

/**
 * The deploy folder argument of `publish`, which has no default.
 *
 * `publish` takes two more positionals after it, and positionals bind in order: with a default,
 * `publish notes /tmp/src` would bind `notes` to the folder and `/tmp/src` to the section, then
 * fail on a missing source.
 */
const requiredFolder = Argument.String('folder').pipe(
  Argument.withDescription('Folder holding deploy.yaml (or the file itself)'),
);

/**
 * An on/off flag, off unless given.
 */
function switchFlag(name: string, description: string): Flag.Flag<boolean> {
  return Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withDefault(false));
}

/**
 * The `--dry-run` flag of the commands that change a running app: print every command instead of
 * running it.
 */
const dryRunFlag = switchFlag(
  'dry-run',
  'Print every command and host script instead of running it',
);

/**
 * Hides `--destination` from the help of a command that takes a host or no app, and so never reads
 * it.
 */
const ignoresDestination = Command.annotate(IgnoredSharedFlags, ['destination']);

/**
 * Hides both shared flags from the help of a command that reads neither deploy.yaml nor hosts.
 */
const ignoresSharedFlags = Command.annotate(IgnoredSharedFlags, ['destination', 'hosts']);

/**
 * The root command: it carries the `--destination` and `--hosts` flags every subcommand reads.
 */
const root = Command.make('compoza').pipe(
  Command.withSharedFlags({
    destination: Flag.String('destination').pipe(
      Flag.withDescription('Use this named destination from deploy.yaml instead of the default'),
      Flag.optional,
    ),
    hosts: Flag.String('hosts').pipe(
      Flag.withDescription('Read hosts from this file only (or set $COMPOZA_HOSTS)'),
      Flag.optional,
    ),
  }),
  Command.withDescription(
    helpText([
      'Builds, ships and runs a Docker Compose stack on a remote host over SSH, routes traffic ' +
        'to it through Caddy or Cloudflare Tunnel, and waits until it answers.',
      'An app is a folder holding deploy.yaml. App commands take that folder as their first ' +
        'argument and default to the working directory. Hosts are defined in ' +
        '~/.config/compoza/hosts.yaml, in linked hosts files (compoza hosts link), or in ' +
        './hosts.yaml.',
      'Run "compoza help <command>" or "compoza <command> --help" for what a command does, its ' +
        `arguments and its flags. The full reference is at ${COMMAND_REFERENCE_URL}`,
    ]),
  ),
  Command.withExamples([
    {
      command: 'compoza check infra',
      description: 'Report whether ./infra and its host are ready',
    },
    {
      command: 'compoza deploy infra --dry-run',
      description: 'Preview a deployment without changing anything',
    },
    { command: 'compoza deploy infra', description: 'Deploy it' },
    { command: 'compoza logs infra --follow', description: "Follow the app's logs" },
    { command: 'compoza help deploy', description: 'Explain one command' },
  ]),
);

/**
 * Sets the process exit code to 2 without stopping, for commands whose result is a report rather
 * than a failure.
 */
const exitCode2 = Effect.sync(() => {
  process.exitCode = 2;
});

/**
 * The last line of the `check` report: `N checks, M failing`, followed by how many of the failures
 * block a deploy when that is not all of them.
 *
 * A failing `route` check only means the deploy will write the site file, so it is counted as
 * failing but not as blocking; saying so keeps a `1 failing` report from reading as "not ready".
 */
function checkSummary(checks: ReadonlyArray<Check>): string {
  const failing = checks.filter((check) => !check.ok).length;
  const blocked = blocking(checks).length;
  const noun = checks.length === 1 ? 'check' : 'checks';
  const summary = `${checks.length} ${noun}, ${failing} failing`;
  return blocked === failing ? summary : `${summary} (${blocked} blocking a deploy)`;
}

/**
 * Resolves the app in `folder` with the `--hosts` and `--destination` flags of the root command.
 */
function resolveFolder(folder: string) {
  return Effect.gen(function* () {
    const { hosts, destination } = yield* root;
    return yield* resolve(folder, hosts, Option.getOrUndefined(destination));
  });
}

/**
 * The `secrets` check of `check --secrets`: whether the app's secret source can be read, naming its
 * variables but never printing their values.
 */
function secretsCheck(app: App, local: boolean) {
  return readSecrets(app, { local }).pipe(
    Effect.map((values): Check => {
      const names = Object.keys(values).sort().join(', ') || NO_SECRET_NAMES;
      return {
        name: 'secrets',
        ok: true,
        detail: `Secret source accessible; names: ${names}`,
        fix: 'manual',
      };
    }),
    Effect.catchTag('DeployError', (error): Effect.Effect<Check> =>
      Effect.succeed({ name: 'secrets', ok: false, detail: error.message, fix: 'manual' }),
    ),
  );
}

/**
 * The `roles` check: whether each role's settings are valid and its service exists in the selected
 * Compose files without setting the same variables itself. Reads only local files.
 */
function rolesCheck(app: App, local: boolean) {
  return validateRoles(app, { local }).pipe(
    Effect.map((): Check => ({
      name: 'roles',
      ok: true,
      detail: 'Roles match the Compose files',
      fix: 'manual',
    })),
    Effect.catchTag('DeployError', (error): Effect.Effect<Check> =>
      Effect.succeed({ name: 'roles', ok: false, detail: error.message, fix: 'manual' }),
    ),
  );
}

/**
 * `check`: the read-only readiness report, ending with a one-line count of failing checks. Exit
 * code 2 when a check other than the route fails.
 */
const check = Command.make(
  'check',
  {
    folder,
    secrets: switchFlag(
      'secrets',
      'Also read the secret source and report whether it is accessible, with variable names only',
    ),
    local: switchFlag(
      'local',
      'Skip the remote checks and check local.roles and local.composeFiles; ' +
        'with --secrets, check the local.secrets source instead',
    ),
    json: switchFlag('json', 'Print { app, host, checks } as JSON instead of one line per check'),
  },
  Effect.fn(function* ({ folder, json, secrets, local }) {
    const { app, host } = yield* resolveFolder(folder);
    const checks: Array<Check> = [...(local ? [] : yield* runChecks(app, host))];

    if (Object.keys(rolesOf(app.config, { local })).length > 0) {
      checks.push(yield* rolesCheck(app, local));
    }

    if (secrets) {
      checks.push(yield* secretsCheck(app, local));
    }

    if (json) {
      yield* Console.log(
        JSON.stringify({ app: app.config.name, host: app.config.host, checks }, null, 2),
      );
    } else {
      if (checks.length > 0) {
        yield* Console.log(formatChecks(checks));
      }

      yield* Console.log(checkSummary(checks));
    }

    if (blocking(checks).length > 0) {
      yield* exitCode2;
    }
  }),
).pipe(
  Command.withShortDescription('Report whether an app and its host are ready to deploy'),
  Command.withDescription(
    helpText([
      'Prints a read-only readiness report for the app and its host: DNS for its domain, the ' +
        'ingress proxy and its network, registry login when images are pushed and, with ' +
        "execution: ssh, the host's Docker, Compose, jq, curl and stack folder. It changes " +
        'nothing and reads no secrets unless --secrets is given.',
      'Each line names a check and what was found; the last line counts the failures. The exit ' +
        'status is 2 when a check that blocks a deploy fails. A failing route check alone does ' +
        'not block, because the deploy writes the route.',
    ]),
  ),
  Command.withExamples([
    { command: 'compoza check infra', description: 'Check ./infra/deploy.yaml and its host' },
    {
      command: 'compoza check infra --secrets --local',
      description: 'Only verify that the local secret source can be read',
    },
    { command: 'compoza check infra --json', description: 'Machine-readable report' },
  ]),
);

/**
 * `deploy`: the whole pipeline, or a preview of it.
 */
const deployCommand = Command.make(
  'deploy',
  {
    folder,
    dryRun: switchFlag('dry-run', 'Run the checks and print every command instead of running it'),
    local: switchFlag('local', "Build and run the stack in this machine's Docker instead"),
    allowDirty: switchFlag(
      'allow-dirty',
      'Build a checkout with uncommitted changes, tagging the images <commit>-dirty',
    ),
    tag: Flag.String('tag').pipe(
      Flag.withDescription(
        'Reuse images built earlier instead of building: <tag> for every built role, ' +
          '<role>=<tag> for one; repeatable',
      ),
      Flag.atLeast(0),
    ),
  },
  Effect.fn(function* ({ folder, dryRun, local, allowDirty, tag }) {
    const { hosts, destination } = yield* root;
    yield* deploy({
      target: folder,
      dryRun,
      local,
      allowDirty,
      tags: tag,
      hosts,
      destination: Option.getOrUndefined(destination),
    }).pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withShortDescription('Check, build, ship, run and route an app on its host'),
  Command.withDescription(
    helpText([
      'Deploys the app in numbered phases: the readiness checks of "compoza check", the folders ' +
        "on the host, image builds shipped through the host's transport, docker compose up " +
        '--wait, the route, and a wait until the public URL answers. A blocking check failure ' +
        'stops the deploy before anything changes.',
      'Images are tagged with the first twelve characters of the commit, so a build needs a ' +
        'clean checkout unless --allow-dirty is given. Each role with a build is tagged with ' +
        'the commit of its own repository. --tag reuses earlier images instead of building, ' +
        'with the current local configuration: --tag <tag> names the tag of every built role ' +
        'and --tag <role>=<tag> overrides it for one role (repeat the flag as needed). --local runs the stack in this ' +
        "machine's Docker with the local overrides, without remote checks, routes or wait.",
      'A failed deploy is not rolled back: inspect "compoza status" and "compoza logs", then ' +
        'deploy a known tag.',
    ]),
  ),
  Command.withExamples([
    {
      command: 'compoza deploy infra --dry-run',
      description: 'Preview the deployment of ./infra/deploy.yaml',
    },
    { command: 'compoza deploy infra', description: 'Deploy it' },
    {
      command: 'compoza deploy infra --destination staging',
      description: 'Deploy to the staging destination named in deploy.yaml',
    },
    {
      command: 'compoza deploy infra --tag 1a2b3c4d5e6f',
      description: 'Redeploy earlier images with the current local config',
    },
    {
      command: 'compoza deploy infra --tag 1a2b3c4d5e6f --tag worker=9f8e7d6c5b4a',
      description: 'Redeploy earlier images, with another tag for the worker role',
    },
  ]),
);

/**
 * `setup-proxy`: the explicit setup operation of the host's ingress extension.
 */
const setupProxy = Command.make(
  'setup-proxy',
  {
    host: Argument.String('host').pipe(
      Argument.withDescription('Host name from the hosts file (see compoza hosts list)'),
    ),
    ingress: Flag.Literals('ingress', ['caddy', 'cloudflare-tunnel']).pipe(
      Flag.withDescription('Provider to set up; required when the host configures both'),
      Flag.optional,
    ),
    dryRun: switchFlag('dry-run', 'Print the setup script and its input without connecting'),
  },
  Effect.fn(function* ({ host: name, ingress, dryRun }) {
    const { hosts } = yield* root;
    const remote = yield* Remote;
    const host = yield* hostNamed(name, yield* loadHostsForRun(hosts));
    const operation = yield* tryIngressPlan(() =>
      hostIngress(host, Option.getOrUndefined(ingress)).setup(host),
    );

    if (dryRun) {
      yield* Console.log(operation.label);
      yield* Console.log(operation.script);

      if (operation.input !== undefined) {
        yield* Console.log(operation.input);
      }

      return;
    }

    const input = yield* setupOperationInput(operation);
    const output = yield* remote.run(host, operation.script, { input, label: operation.label });
    yield* Console.log(output.trimEnd());
  }),
).pipe(
  ignoresDestination,
  Command.withShortDescription("Set up a host's ingress provider (Caddy or Cloudflare Tunnel)"),
  Command.withDescription(
    helpText([
      'Runs the one-time host setup of an ingress provider; deploys never set up ingress on ' +
        'their own. <host> is a host name from the hosts file, not an app folder.',
      "Caddy: prepares the shared proxy's sites folder and recreates Caddy or, with " +
        'ingress.caddy.provision, creates a hardened Caddy stack. Recreating Caddy can briefly ' +
        'interrupt the sites it already serves.',
      'Cloudflare Tunnel: with API-managed routes, verifies access to the tunnel and prepares ' +
        'route ownership storage; with manual routes, checks the connector. With provision, it ' +
        'first creates the connector stack.',
    ]),
  ),
  Command.withExamples([
    {
      command: 'compoza setup-proxy atlas --dry-run',
      description: 'Show the setup script for the host atlas',
    },
    {
      command: 'compoza setup-proxy atlas --ingress caddy',
      description: 'Set up Caddy on a host that configures both providers',
    },
  ]),
);

/**
 * `publish`: mirror a local folder into a content section.
 */
const publishCommand = Command.make(
  'publish',
  {
    folder: requiredFolder,
    section: Argument.String('section').pipe(
      Argument.withDescription('Content section declared under content in deploy.yaml'),
    ),
    source: Argument.String('source').pipe(Argument.withDescription('Local folder to mirror')),
    dryRun: switchFlag('dry-run', 'List the files rsync would copy or delete, changing nothing'),
  },
  Effect.fn(function* ({ folder, section, source, dryRun }) {
    const { app, host } = yield* resolveFolder(folder);
    yield* publish(app, host, section, source, dryRun).pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withShortDescription("Mirror a local folder into one of the app's content sections"),
  Command.withDescription(
    helpText([
      'Mirrors the local folder <source> into the content section <section> declared under ' +
        'content in deploy.yaml, using rsync over SSH. The host folder becomes an exact copy: ' +
        'files missing from <source> are deleted there. Dotfiles and node_modules are never ' +
        'copied.',
      'Unlike the other app commands, <folder> is required, because two more arguments follow ' +
        'it.',
    ]),
  ),
  Command.withExamples([
    {
      command: 'compoza publish infra public ./public --dry-run',
      description: 'List what would change; *deleting marks removals',
    },
    { command: 'compoza publish infra public ./public', description: 'Mirror it' },
  ]),
);

/**
 * Runs a read-only `docker compose` subcommand (`ps`, `logs`) for the app on its host: through the
 * host's own script for `execution: ssh`, else through `docker --host` from this machine. A named
 * `options.service` is checked first in both modes, against the deployed stack over SSH and against
 * the running project's containers otherwise; the other options only affect SSH execution, where a
 * followed command ends with the connection.
 */
function inspect(resolved: Resolved, args: ReadonlyArray<string>, options: InspectOptions = {}) {
  return Effect.gen(function* () {
    if (resolved.app.config.execution === 'ssh') {
      return yield* inspectSsh(resolved.app, resolved.host, args, options);
    }

    if (options.service !== undefined) {
      yield* requireProjectService(resolved, options.service);
    }

    const shell = yield* Shell;
    yield* shell.run(command('docker', [...projectArgs(resolved), ...args]));
  });
}

/**
 * `status`: `docker compose ps --all` for the app on its host; `--all` so a stopped stack is listed
 * as stopped rather than appearing absent.
 */
const status = Command.make(
  'status',
  { folder },
  Effect.fn(function* ({ folder }) {
    yield* inspect(yield* resolveFolder(folder), ['ps', '--all']);
  }),
).pipe(
  Command.withShortDescription("List the app's containers and their state"),
  Command.withDescription(
    helpText([
      "Lists the app's containers on its host with docker compose ps --all, so a stopped stack " +
        'shows as stopped instead of missing. It changes nothing.',
      'With execution: ssh and a managed secret source, only the service, state, health and ' +
        'exit code are shown, with dotenv values redacted.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza status infra' }]),
);

/**
 * Runs `effect` so that closing the terminal (SIGHUP) stops it the way SIGTERM does.
 *
 * Effect starts child processes in their own process group, so a closing terminal's SIGHUP reaches
 * only this process, and Node exits at once on it, leaving a followed `docker compose logs` or
 * `ssh` running. Re-raising it as SIGTERM lets `NodeRuntime.runMain` interrupt the command, which
 * stops the child; over SSH that closes the connection and ends the command on the host.
 */
function stopOnHangup<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  /**
   * Re-raises the hangup as SIGTERM, which `NodeRuntime.runMain` turns into an interruption.
   */
  const hangup = () => {
    process.kill(process.pid, 'SIGTERM');
  };

  return Effect.acquireUseRelease(
    Effect.sync(() => process.on('SIGHUP', hangup)),
    () => effect,
    () => Effect.sync(() => process.off('SIGHUP', hangup)),
  );
}

/**
 * How many existing lines `logs` prints per container before it stops or starts following.
 */
const DEFAULT_LOG_TAIL_LINES = 100;

/**
 * `logs`: `docker compose logs` for the app on its host. Compose prefixes every line with the
 * container that wrote it (`web-1`, `worker-1`); `--follow` keeps streaming until interrupted.
 */
const logs = Command.make(
  'logs',
  {
    folder,
    service: Flag.String('service').pipe(
      Flag.withDescription(
        "Only this Compose service's containers; an unknown name lists the others",
      ),
      Flag.optional,
    ),
    tail: Flag.Int('tail').pipe(
      Flag.withDescription(
        `Existing lines to print per container first (default ${DEFAULT_LOG_TAIL_LINES})`,
      ),
      Flag.withDefault(DEFAULT_LOG_TAIL_LINES),
    ),
    follow: Flag.Boolean('follow').pipe(
      Flag.withAlias('f'),
      Flag.withDescription('Keep printing new lines as they arrive, until interrupted'),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ folder, service, tail, follow }) {
    const name = Option.getOrUndefined(service);
    const read = inspect(
      yield* resolveFolder(folder),
      [
        'logs',
        '--tail',
        String(tail),
        ...(follow ? ['--follow'] : []),
        ...(name === undefined ? [] : [name]),
      ],
      { follow, service: name },
    );
    yield* follow ? stopOnHangup(read) : read;
  }),
).pipe(
  Command.withShortDescription("Show the app's container logs, optionally following new lines"),
  Command.withDescription(
    helpText([
      "Prints the app's container logs from its host with docker compose logs. Every line " +
        'starts with the container that wrote it, such as web-1 or worker-1. Logs are read from ' +
        'the running project by name, so they need no Compose files, checkout or secrets on ' +
        'this machine.',
      '--follow keeps the command running until Ctrl-C, so leave it out in scripts and CI. Lines ' +
        'are printed as the containers wrote them and can contain secrets if the app logs them.',
    ]),
  ),
  Command.withExamples([
    { command: 'compoza logs infra', description: 'The last 100 lines of every container' },
    {
      command: 'compoza logs infra --tail 20 --follow',
      description: 'The last 20 lines, then new lines as they arrive',
    },
    { command: 'compoza logs infra --service web -f', description: 'Only the web service, live' },
  ]),
);

/**
 * `stop`: halts the app's containers on its host; networks, volumes and images stay, so `start`
 * brings it back as it was.
 */
const stop = Command.make(
  'stop',
  { folder, dryRun: dryRunFlag },
  Effect.fn(function* ({ folder, dryRun }) {
    const resolved = yield* resolveFolder(folder);
    yield* lifecycle(resolved, 'stop').pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withShortDescription("Stop the app's containers, keeping everything else in place"),
  Command.withDescription(
    helpText([
      "Stops the app's containers on its host. Networks, volumes, images, the route and data " +
        'stay, so "compoza start" brings the stack back as it was.',
      'Nothing is built, pulled or reconfigured; to change what runs, deploy.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza stop infra' }]),
);

/**
 * `start`: resumes the containers of a stopped app.
 */
const start = Command.make(
  'start',
  { folder, dryRun: dryRunFlag },
  Effect.fn(function* ({ folder, dryRun }) {
    const resolved = yield* resolveFolder(folder);
    yield* lifecycle(resolved, 'start').pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withShortDescription('Start the containers of an app stopped with compoza stop'),
  Command.withDescription(
    helpText([
      'Starts the containers of an app stopped with "compoza stop", exactly as they were.',
      'Nothing is built, pulled or reconfigured; to change what runs, deploy.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza start infra' }]),
);

/**
 * `delete` (also `down`): removes the app's route, containers and networks from its host, and its
 * named volumes with `--volumes`. Host folders are never removed, so a later `deploy` finds the
 * data again.
 */
const deleteCommand = Command.make(
  'delete',
  {
    folder,
    volumes: switchFlag(
      'volumes',
      "Also remove the project's named volumes (bind-mounted host folders always stay)",
    ),
    dryRun: dryRunFlag,
  },
  Effect.fn(function* ({ folder, volumes, dryRun }) {
    const resolved = yield* resolveFolder(folder);
    yield* remove(resolved, volumes).pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withAlias('down'),
  Command.withShortDescription("Remove the app's route, containers and networks; data stays"),
  Command.withDescription(
    helpText([
      "Removes the app's route first, so its domain stops being served cleanly, then its " +
        'containers and networks with docker compose down --remove-orphans. down is another ' +
        'name for delete.',
      "The app's directories and content folders always stay on the host, as do, with " +
        'execution: ssh, the stack folder with its dotenv and overlays, so a later deploy finds ' +
        'them again. Named Compose volumes are removed only with --volumes.',
    ]),
  ),
  Command.withExamples([
    {
      command: 'compoza delete infra --dry-run',
      description: 'Show what removing the app would do',
    },
    {
      command: 'compoza delete infra --volumes',
      description: 'Remove the stack and its named volumes',
    },
  ]),
);

/**
 * The keys `config` accepts, in the order its help lists them.
 */
const SETTING_KEY_NAMES = Object.keys(SETTING_KEYS) as Array<SettingKey>;

/**
 * The setting key argument shared by the `config` subcommands.
 */
const settingKey = Argument.Literals('key', SETTING_KEY_NAMES).pipe(
  Argument.withDescription(`Setting to read or change: ${SETTING_KEY_NAMES.join(', ')}`),
);

/**
 * `config get`: prints one setting from the settings file.
 */
const configGet = Command.make(
  'get',
  { key: settingKey },
  Effect.fn(function* ({ key }) {
    const value = settingValue(yield* loadSettings(), key);
    if (value === undefined) {
      return yield* new DeployError({ message: `${key} is not set in ${yield* SettingsFile}` });
    }

    yield* Console.log(value);
  }),
).pipe(
  ignoresSharedFlags,
  Command.withShortDescription('Print the saved value of a setting'),
  Command.withDescription(
    helpText([
      'Prints the value of a setting saved in ~/.config/compoza/config.yaml, and exits with ' +
        'status 1 when it is not set. An environment variable that overrides the setting is not ' +
        'reported.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza config get 1password.account' }]),
);

/**
 * `config set`: saves one setting in the settings file.
 */
const configSet = Command.make(
  'set',
  {
    key: settingKey,
    value: Argument.String('value').pipe(Argument.withDescription('The new value')),
  },
  Effect.fn(function* ({ key, value }) {
    const file = yield* editSettings((document) => document.setIn(SETTING_KEYS[key], value));
    yield* Console.log(`Set ${key} in ${file}`);
  }),
).pipe(
  ignoresSharedFlags,
  Command.withShortDescription('Save a setting'),
  Command.withDescription(
    helpText([
      'Saves a setting in ~/.config/compoza/config.yaml, creating the file and its folder when ' +
        'needed. The result is validated before it is written, and comments and other settings ' +
        'are kept.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza config set 1password.account "Atlas Example"' }]),
);

/**
 * `config unset`: removes one setting from the settings file.
 */
const configUnset = Command.make(
  'unset',
  { key: settingKey },
  Effect.fn(function* ({ key }) {
    if (settingValue(yield* loadSettings(), key) === undefined) {
      yield* Console.log(`${key} is not set`);
      return;
    }

    const file = yield* editSettings((document) => deleteSetting(document, SETTING_KEYS[key]));
    yield* Console.log(`Removed ${key} from ${file}`);
  }),
).pipe(
  ignoresSharedFlags,
  Command.withShortDescription('Remove a setting'),
  Command.withDescription(
    helpText([
      'Removes a setting from ~/.config/compoza/config.yaml. Unsetting a key that is not set ' +
        'changes nothing.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza config unset 1password.account' }]),
);

/**
 * `config`: the user settings in `~/.config/compoza/config.yaml`.
 */
const configCommand = Command.make('config').pipe(
  ignoresSharedFlags,
  Command.withShortDescription('Read and change settings such as the 1Password account'),
  Command.withDescription(
    helpText([
      'Reads and changes the settings in ~/.config/compoza/config.yaml, which apply to every app ' +
        'on this machine.',
      '1password.account is the 1Password desktop account, by name or UUID, used when neither ' +
        'OP_SERVICE_ACCOUNT_TOKEN nor COMPOZA_1PASSWORD_ACCOUNT is set.',
      'Linked hosts are stored in the same file but are changed with "compoza hosts link".',
    ]),
  ),
  Command.withSubcommands([configGet, configSet, configUnset]),
  Command.withExamples([
    {
      command: 'compoza config set 1password.account "Atlas Example"',
      description: 'Use this 1Password desktop account unless COMPOZA_1PASSWORD_ACCOUNT is set',
    },
  ]),
);

/**
 * The hosts file or folder argument of `hosts link` and `hosts unlink`.
 */
const hostsTarget = Argument.String('path').pipe(
  Argument.withDescription('Hosts file, or folder holding a hosts.yaml'),
);

/**
 * `hosts link`: adds a hosts file or folder to the ones every run reads.
 */
const hostsLink = Command.make(
  'link',
  { path: hostsTarget },
  Effect.fn(function* ({ path }) {
    const { link, changed, file } = yield* linkHosts(path);
    yield* Console.log(changed ? `Linked ${link} in ${file}` : `${link} is already linked`);
  }),
).pipe(
  ignoresSharedFlags,
  Command.withShortDescription('Read the hosts in a file or folder on every run'),
  Command.withDescription(
    helpText([
      'Adds a hosts file, or a folder holding a hosts.yaml, to the files read alongside ' +
        '~/.config/compoza/hosts.yaml. Its absolute path is stored in ' +
        '~/.config/compoza/config.yaml.',
      'Nothing is saved when the target is missing or invalid, or defines a host name that the ' +
        'global file or another link already defines. Linking an already linked path changes ' +
        'nothing.',
    ]),
  ),
  Command.withExamples([
    {
      command: 'compoza hosts link ~/infrastructure',
      description: 'Also read ~/infrastructure/hosts.yaml on every run',
    },
  ]),
);

/**
 * `hosts unlink`: removes a linked hosts file or folder.
 */
const hostsUnlink = Command.make(
  'unlink',
  { path: hostsTarget },
  Effect.fn(function* ({ path }) {
    const { link, file } = yield* unlinkHosts(path);
    yield* Console.log(`Unlinked ${link} from ${file}`);
  }),
).pipe(
  ignoresSharedFlags,
  Command.withShortDescription('Stop reading a linked hosts file or folder'),
  Command.withDescription(
    helpText([
      'Removes a linked hosts file or folder, given as written or as any path resolving to it. ' +
        'The target does not need to exist, so a link to a deleted folder can still be removed. ' +
        'It fails, listing the current links, when the path is not linked.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza hosts unlink ~/infrastructure' }]),
);

/**
 * `hosts list`: every host a run would use, with the file that defines it, then the links.
 */
const hostsList = Command.make(
  'list',
  {},
  Effect.fn(function* () {
    const { hosts } = yield* root;
    const sources = yield* hostSourcesForRun(hosts);
    const width = Math.max(0, ...sources.map(({ name }) => name.length));

    for (const { name, file } of sources) {
      yield* Console.log(`${name.padEnd(width)}  ${file}`);
    }

    // An exclusive hosts file ignores the settings file, so its links are neither read nor listed.
    const links = usesExclusiveHostsFile(hosts) ? [] : yield* hostLinks();
    if (links.length > 0) {
      yield* Console.log(`\nLinked: ${links.join(', ')}`);
    }
  }),
).pipe(
  ignoresDestination,
  Command.withShortDescription('List the hosts a run would use and the file defining each'),
  Command.withDescription(
    helpText([
      'Prints each host a run would use and the hosts file that defines it, then the linked ' +
        'paths. It honours --hosts and COMPOZA_HOSTS, and fails when a hosts file is missing, ' +
        'invalid or clashes with another.',
    ]),
  ),
  Command.withExamples([{ command: 'compoza hosts list' }]),
);

/**
 * `hosts`: the hosts files every run reads.
 */
const hostsCommand = Command.make('hosts').pipe(
  ignoresDestination,
  Command.withShortDescription('List hosts, and link or unlink extra hosts files'),
  Command.withDescription(
    helpText([
      'Manages the hosts files every run reads; none of these commands connect to a host.',
      'Hosts come from ~/.config/compoza/hosts.yaml and the linked files or folders, and ' +
        './hosts.yaml overrides them by host name. --hosts or COMPOZA_HOSTS selects one file ' +
        'instead.',
    ]),
  ),
  Command.withSubcommands([hostsList, hostsLink, hostsUnlink]),
  Command.withExamples([
    {
      command: 'compoza hosts link ~/infrastructure',
      description: 'Also read ~/infrastructure/hosts.yaml on every run',
    },
    { command: 'compoza hosts list', description: 'Show where each host comes from' },
  ]),
);

/**
 * `help`: the help of the named command, the same as `<command> --help`.
 */
const helpCommand = Command.make(
  'help',
  {
    command: Argument.String('command').pipe(
      Argument.withDescription(
        'Command to explain, such as deploy, or hosts link for a subcommand',
      ),
      Argument.variadic(),
    ),
  },
  ({ command }) => Effect.fail(helpFor(command)),
).pipe(
  ignoresSharedFlags,
  Command.withShortDescription('Explain a command, its arguments and its flags'),
  Command.withDescription(
    helpText([
      'Prints what a command does, its arguments, flags and examples; the same as ' +
        '"compoza <command> --help". Name a subcommand after its group, as in ' +
        '"compoza help hosts link". Without a command, prints the overview of compoza.',
    ]),
  ),
  Command.withExamples([
    { command: 'compoza help deploy' },
    { command: 'compoza help hosts link' },
  ]),
);

/**
 * The whole command tree, with the subcommands grouped by what they act on.
 */
export const cli = root.pipe(
  Command.withSubcommands([
    {
      group: 'APP COMMANDS',
      commands: [check, deployCommand, status, logs, stop, start, deleteCommand, publishCommand],
    },
    { group: 'HOST COMMANDS', commands: [setupProxy, hostsCommand] },
    { group: 'OTHER COMMANDS', commands: [configCommand, helpCommand] },
  ]),
);

/**
 * The request to show the help of the command at `names` below the root, which `Command.run`
 * presents like `--help` for that command, with exit status 0.
 *
 * Aliases resolve to their command. An unknown name stops the walk: the help of the last command
 * found is shown with an unknown subcommand error naming the closest commands, and the exit status
 * is 1.
 */
function helpFor(names: ReadonlyArray<string>): CliError.ShowHelp {
  const commandPath: Array<string> = [cli.name];
  let current: Command.Command.Any = cli;

  for (const name of names) {
    const subcommands = current.subcommands.flatMap(({ commands }) => commands);
    const subcommand = subcommands.find(
      (candidate) => candidate.name === name || candidate.alias === name,
    );

    if (subcommand === undefined) {
      const names = subcommands.flatMap(({ name, alias }) => (alias ? [name, alias] : [name]));
      const unknown = new CliError.UnknownSubcommand({
        subcommand: name,
        parent: [...commandPath],
        suggestions: closestNames(name, names),
      });
      return new CliError.ShowHelp({ commandPath, errors: [unknown] });
    }

    commandPath.push(subcommand.name);
    current = subcommand;
  }

  return new CliError.ShowHelp({ commandPath, errors: [] });
}

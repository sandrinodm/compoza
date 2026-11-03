import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import type { App } from './config/deploy.ts';
import type { Resolved } from './deploy.ts';

import { blocking, type Check, formatChecks, runChecks } from './checks.ts';
import { command } from './command.ts';
import { hostNamed, loadHostsForRun } from './config/hosts.ts';
import { readSecrets } from './config/secrets.ts';
import { deploy, resolve } from './deploy.ts';
import { hostIngress, tryIngressPlan } from './extensions/ingress.ts';
import { setupOperationInput } from './ingress-setup.ts';
import { lifecycle, projectArgs, remove } from './lifecycle.ts';
import { publish } from './publish.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { inspectSsh } from './ssh-deploy.ts';

/**
 * The detail of a passing `secrets` check when the source holds no variables: an app on legacy host
 * dotenv keeps its secrets on the host, which the host readiness checks cover.
 */
const NO_SECRET_NAMES = '(no variables; legacy host dotenv uses host readiness)';

/**
 * The deploy folder argument shared by the app commands: a folder holding `deploy.yaml`, or the
 * file itself, defaulting to the working directory.
 */
const folder = Argument.String('folder').pipe(
  Argument.withDescription(
    'Folder holding deploy.yaml (or the file itself); defaults to the working directory',
  ),
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
 * The `--dry-run` flag of `deploy` and of the commands that change a host: print every command
 * instead of running it.
 */
const dryRunFlag = switchFlag('dry-run', 'Print every command instead of running it');

/**
 * The root command: it carries the `--destination` and `--hosts` flags every subcommand reads.
 */
const root = Command.make('compoza').pipe(
  Command.withSharedFlags({
    destination: Flag.String('destination').pipe(
      Flag.withDescription('Named destination from deploy.yaml'),
      Flag.optional,
    ),
    hosts: Flag.String('hosts').pipe(
      Flag.withDescription(
        'Exclusive hosts file (or $COMPOZA_HOSTS); otherwise ./hosts.yaml overrides global hosts',
      ),
      Flag.optional,
    ),
  }),
  Command.withDescription(
    'Builds, ships and runs a Compose stack on a remote Docker host over SSH.',
  ),
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
 * `check`: the read-only readiness report, ending with a one-line count of failing checks. Exit
 * code 2 when a check other than the route fails.
 */
const check = Command.make(
  'check',
  {
    folder,
    secrets: switchFlag('secrets', 'Explicitly read secret source access; report names only'),
    local: switchFlag('local', 'Skip remote readiness; with --secrets, check the local source'),
    json: switchFlag('json', 'Print the checks as JSON'),
  },
  Effect.fn(function* ({ folder, json, secrets, local }) {
    const { app, host } = yield* resolveFolder(folder);
    const checks: Array<Check> = [...(local ? [] : yield* runChecks(app, host))];

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
  Command.withDescription(
    'Read-only host readiness report; --secrets also verifies source access without values',
  ),
);

/**
 * `deploy`: the whole pipeline, or a preview of it.
 */
const deployCommand = Command.make(
  'deploy',
  {
    folder,
    dryRun: dryRunFlag,
    local: switchFlag(
      'local',
      "Build and run the stack on this machine's Docker instead of the host",
    ),
    allowDirty: switchFlag(
      'allow-dirty',
      'Deploy a checkout with uncommitted changes, tagged <commit>-dirty',
    ),
    tag: Flag.String('tag').pipe(
      Flag.withDescription('Reuse images with this tag with the current local config'),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ folder, dryRun, local, allowDirty, tag }) {
    const { hosts, destination } = yield* root;
    yield* deploy({
      target: folder,
      dryRun,
      local,
      allowDirty,
      tag,
      hosts,
      destination: Option.getOrUndefined(destination),
    }).pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withDescription('Check, build, ship, run and route an app on its host'),
  Command.withExamples([
    {
      command: 'compoza deploy infra --dry-run',
      description: 'Preview the deployment of ./infra/deploy.yaml',
    },
    {
      command: 'compoza deploy infra --tag 1a2b3c4d5e6f',
      description: 'Reuse earlier images with current local config',
    },
  ]),
);

/**
 * `setup-proxy`: the explicit setup operation of the host's ingress extension.
 */
const setupProxy = Command.make(
  'setup-proxy',
  {
    host: Argument.String('host').pipe(Argument.withDescription('Host key in the hosts file')),
    ingress: Flag.Literals('ingress', ['caddy', 'cloudflare-tunnel']).pipe(
      Flag.withDescription(
        'Ingress provider to set up; required when the host configures both providers',
      ),
      Flag.optional,
    ),
    dryRun: switchFlag('dry-run', 'Preview ingress setup without connecting to the host'),
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
  Command.withDescription(
    "Provision or prepare the host's ingress extension; may briefly interrupt routed sites",
  ),
);

/**
 * `publish`: mirror a local folder into a content section.
 */
const publishCommand = Command.make(
  'publish',
  {
    folder: requiredFolder,
    section: Argument.String('section').pipe(
      Argument.withDescription('Content section named in deploy.yaml'),
    ),
    source: Argument.String('source').pipe(Argument.withDescription('Local folder to mirror')),
    dryRun: switchFlag('dry-run', 'List the changes rsync would make'),
  },
  Effect.fn(function* ({ folder, section, source, dryRun }) {
    const { app, host } = yield* resolveFolder(folder);
    yield* publish(app, host, section, source, dryRun).pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withDescription(
    "Mirrors a local folder into one of the app's content sections on its host",
  ),
);

/**
 * Runs a read-only `docker compose` subcommand (`ps`, `logs`) for the app on its host: through the
 * host's own script for `execution: ssh`, else through `docker --host` from this machine.
 */
function inspect(resolved: Resolved, args: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    if (resolved.app.config.execution === 'ssh') {
      return yield* inspectSsh(resolved.app, resolved.host, args);
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
).pipe(Command.withDescription("Lists the app's containers on its host"));

/**
 * `logs`: `docker compose logs` for the app on its host.
 */
const logs = Command.make(
  'logs',
  {
    folder,
    service: Flag.String('service').pipe(
      Flag.withDescription('Only this Compose service'),
      Flag.optional,
    ),
    tail: Flag.Int('tail').pipe(Flag.withDescription('Lines per container'), Flag.withDefault(100)),
    follow: Flag.Boolean('follow').pipe(
      Flag.withAlias('f'),
      Flag.withDescription('Keep streaming'),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ folder, service, tail, follow }) {
    yield* inspect(yield* resolveFolder(folder), [
      'logs',
      '--tail',
      String(tail),
      ...(follow ? ['--follow'] : []),
      ...Option.match(service, { onNone: () => [], onSome: (name) => [name] }),
    ]);
  }),
).pipe(Command.withDescription("Shows the app's container logs from its host"));

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
  Command.withDescription(
    "Stops the app's containers on its host, keeping everything else in place",
  ),
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
).pipe(Command.withDescription("Starts the app's stopped containers on its host"));

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
  Command.withDescription(
    "Removes the app's route, containers and networks from its host; data folders stay",
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
 * The whole command tree.
 */
export const cli = root.pipe(
  Command.withSubcommands([
    check,
    deployCommand,
    stop,
    start,
    deleteCommand,
    setupProxy,
    publishCommand,
    status,
    logs,
  ]),
);

import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import { blocking, type Check, formatChecks, runChecks } from './checks.ts';
import { command } from './command.ts';
import { hostNamed, loadHostsForRun } from './config/hosts.ts';
import { readSecrets } from './config/secrets.ts';
import { deploy, resolve } from './deploy.ts';
import { DeployError } from './errors.ts';
import { hostIngress } from './extensions/ingress.ts';
import { setupOperationInput } from './ingress-setup.ts';
import { lifecycle, projectArgs, remove } from './lifecycle.ts';
import { publish } from './publish.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { inspectSsh } from './ssh-deploy.ts';

/**
 * The deploy folder argument shared by the app commands: a folder holding `deploy.yaml`, or the file itself, defaulting
 * to the working directory.
 */
const folder = Argument.String('folder').pipe(
  Argument.withDescription('Folder holding deploy.yaml (or the file itself); defaults to the working directory'),
  Argument.withDefault('.'),
);

/**
 * The deploy folder argument of `publish`, which has no default.
 *
 * `publish` takes two more positionals after it, and positionals bind in order: with a default, `publish notes
 * /tmp/src` would bind `notes` to the folder and `/tmp/src` to the section, then fail on a missing source.
 */
const requiredFolder = Argument.String('folder').pipe(
  Argument.withDescription('Folder holding deploy.yaml (or the file itself)'),
);

/**
 * The root command: it carries the `--hosts` flag every subcommand reads.
 */
const root = Command.make('compoza').pipe(
  Command.withSharedFlags({
    destination: Flag.String('destination').pipe(
      Flag.withDescription('Named destination from deploy.yaml'),
      Flag.optional,
    ),
    hosts: Flag.String('hosts').pipe(
      Flag.withDescription('Exclusive hosts file (or $COMPOZA_HOSTS); otherwise ./hosts.yaml overrides global hosts'),
      Flag.optional,
    ),
  }),
  Command.withDescription('Builds, ships and runs a Compose stack on a remote Docker host over SSH.'),
);

/**
 * Sets the process exit code to 2 without stopping, for commands whose result is a report rather than a failure.
 */
const exitCode2 = Effect.sync(() => {
  process.exitCode = 2;
});

/**
 * The last line of the `check` report: `N checks, M failing`, followed by how many of the failures block a deploy when
 * that is not all of them.
 *
 * A failing `route` check only means the deploy will write the site file, so it is counted as failing but not as
 * blocking; saying so keeps a `1 failing` report from reading as "not ready".
 */
function checkSummary(checks: ReadonlyArray<Check>): string {
  const failing = checks.filter((check) => !check.ok).length;
  const blocked = blocking(checks).length;
  const summary = `${checks.length} ${checks.length === 1 ? 'check' : 'checks'}, ${failing} failing`;
  return blocked === failing ? summary : `${summary} (${blocked} blocking a deploy)`;
}

/**
 * `check`: the read-only readiness report, ending with a one-line count of failing checks. Exit code 2 when a check
 * other than the route fails.
 */
const check = Command.make(
  'check',
  {
    folder,
    secrets: Flag.Boolean('secrets').pipe(
      Flag.withDescription('Explicitly read secret source access; report names only'),
      Flag.withDefault(false),
    ),
    local: Flag.Boolean('local').pipe(
      Flag.withDescription('Skip remote readiness; with --secrets, check the local source'),
      Flag.withDefault(false),
    ),
    json: Flag.Boolean('json').pipe(Flag.withDescription('Print the checks as JSON'), Flag.withDefault(false)),
  },
  Effect.fn(function* ({ folder, json, secrets, local }) {
    const { hosts, destination } = yield* root;
    const { app, host } = yield* resolve(folder, hosts, Option.getOrUndefined(destination));
    const checks: Array<Check> = [...(local ? [] : yield* runChecks(app, host))];

    if (secrets) {
      const access = yield* readSecrets(app, local).pipe(
        Effect.map((values): Check => ({
          name: 'secrets',
          ok: true,
          detail: `Secret source accessible; names: ${Object.keys(values).sort().join(', ') || '(no variables; legacy host dotenv uses host readiness)'}`,
          fix: 'manual',
        })),
        Effect.catchTag('DeployError', (error) =>
          Effect.succeed({ name: 'secrets', ok: false, detail: error.message, fix: 'manual' } as Check),
        ),
      );
      checks.push(access);
    }

    if (json) {
      yield* Console.log(JSON.stringify({ app: app.config.name, host: app.config.host, checks }, null, 2));
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
  Command.withDescription('Read-only host readiness report; --secrets also verifies source access without values'),
);

/**
 * `deploy`: the whole pipeline, or a preview of it.
 */
const deployCommand = Command.make(
  'deploy',
  {
    folder,
    dryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('Print every command instead of running it'),
      Flag.withDefault(false),
    ),
    local: Flag.Boolean('local').pipe(
      Flag.withDescription("Build and run the stack on this machine's Docker instead of the host"),
      Flag.withDefault(false),
    ),
    allowDirty: Flag.Boolean('allow-dirty').pipe(
      Flag.withDescription('Deploy a checkout with uncommitted changes, tagged <commit>-dirty'),
      Flag.withDefault(false),
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
    { command: 'compoza deploy infra --dry-run', description: 'Preview the deployment of ./infra/deploy.yaml' },
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
    dryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('Preview ingress setup without connecting to the host'),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ host: name, dryRun }) {
    const { hosts } = yield* root;
    const remote = yield* Remote;
    const host = yield* hostNamed(name, yield* loadHostsForRun(hosts));
    const operation = yield* Effect.try({
      try: () => hostIngress(host).setup(host),
      catch: (cause) =>
        new DeployError({ message: cause instanceof Error ? cause.message : 'Invalid ingress configuration' }),
    });

    if (dryRun) {
      yield* Console.log(operation.label);
      yield* Console.log(operation.script);

      if (operation.input !== undefined) {
        yield* Console.log(operation.input);
      }

      return;
    }

    const input = yield* setupOperationInput(operation);
    const output = yield* remote.run(host, operation.script, input, operation.label);
    yield* Console.log(output.trimEnd());
  }),
).pipe(
  Command.withDescription("Provision or prepare the host's ingress extension; may briefly interrupt routed sites"),
);

/**
 * `publish`: mirror a local folder into a content section.
 */
const publishCommand = Command.make(
  'publish',
  {
    folder: requiredFolder,
    section: Argument.String('section').pipe(Argument.withDescription('Content section named in deploy.yaml')),
    source: Argument.String('source').pipe(Argument.withDescription('Local folder to mirror')),
    dryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('List the changes rsync would make'),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ folder, section, source, dryRun }) {
    const { hosts, destination } = yield* root;
    const { app, host } = yield* resolve(folder, hosts, Option.getOrUndefined(destination));
    yield* publish(app, host, section, source, dryRun).pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(Command.withDescription("Mirrors a local folder into one of the app's content sections on its host"));

/**
 * `status`: `docker compose ps --all` for the app on its host; `--all` so a stopped stack is listed as stopped rather
 * than appearing absent.
 */
const status = Command.make(
  'status',
  { folder },
  Effect.fn(function* ({ folder }) {
    const { hosts, destination } = yield* root;
    const shell = yield* Shell;
    const resolved = yield* resolve(folder, hosts, Option.getOrUndefined(destination));
    if (resolved.app.config.execution === 'ssh') {
      yield* inspectSsh(resolved.app, resolved.host, ['ps', '--all']);
    } else {
      yield* shell.run(command('docker', [...projectArgs(resolved), 'ps', '--all']));
    }
  }),
).pipe(Command.withDescription("Lists the app's containers on its host"));

/**
 * `logs`: `docker compose logs` for the app on its host.
 */
const logs = Command.make(
  'logs',
  {
    folder,
    service: Flag.String('service').pipe(Flag.withDescription('Only this Compose service'), Flag.optional),
    tail: Flag.Int('tail').pipe(Flag.withDescription('Lines per container'), Flag.withDefault(100)),
    follow: Flag.Boolean('follow').pipe(
      Flag.withAlias('f'),
      Flag.withDescription('Keep streaming'),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ folder, service, tail, follow }) {
    const { hosts, destination } = yield* root;
    const shell = yield* Shell;
    const resolved = yield* resolve(folder, hosts, Option.getOrUndefined(destination));
    if (resolved.app.config.execution === 'ssh') {
      yield* inspectSsh(resolved.app, resolved.host, [
        'logs',
        '--tail',
        String(tail),
        ...(follow ? ['--follow'] : []),
        ...Option.match(service, { onNone: () => [], onSome: (name) => [name] }),
      ]);

      return;
    }

    yield* shell.run(
      command('docker', [
        ...projectArgs(resolved),
        'logs',
        '--tail',
        String(tail),
        ...(follow ? ['--follow'] : []),
        ...Option.match(service, { onNone: () => [], onSome: (name) => [name] }),
      ]),
    );
  }),
).pipe(Command.withDescription("Shows the app's container logs from its host"));

/**
 * The `--dry-run` flag of the commands that change a host: print every command instead of running it.
 */
const dryRunFlag = Flag.Boolean('dry-run').pipe(
  Flag.withDescription('Print every command instead of running it'),
  Flag.withDefault(false),
);

/**
 * `stop`: halts the app's containers on its host; networks, volumes and images stay, so `start` brings it back as it
 * was.
 */
const stop = Command.make(
  'stop',
  { folder, dryRun: dryRunFlag },
  Effect.fn(function* ({ folder, dryRun }) {
    const { hosts, destination } = yield* root;
    const resolved = yield* resolve(folder, hosts, Option.getOrUndefined(destination));
    yield* lifecycle(resolved, 'stop').pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(Command.withDescription("Stops the app's containers on its host, keeping everything else in place"));

/**
 * `start`: resumes the containers of a stopped app.
 */
const start = Command.make(
  'start',
  { folder, dryRun: dryRunFlag },
  Effect.fn(function* ({ folder, dryRun }) {
    const { hosts, destination } = yield* root;
    const resolved = yield* resolve(folder, hosts, Option.getOrUndefined(destination));
    yield* lifecycle(resolved, 'start').pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(Command.withDescription("Starts the app's stopped containers on its host"));

/**
 * `delete` (also `down`): removes the app's route, containers and networks from its host, and its named volumes with
 * `--volumes`. Host folders are never removed, so a later `deploy` finds the data again.
 */
const deleteCommand = Command.make(
  'delete',
  {
    folder,
    volumes: Flag.Boolean('volumes').pipe(
      Flag.withDescription("Also remove the project's named volumes (bind-mounted host folders always stay)"),
      Flag.withDefault(false),
    ),
    dryRun: dryRunFlag,
  },
  Effect.fn(function* ({ folder, volumes, dryRun }) {
    const { hosts, destination } = yield* root;
    const resolved = yield* resolve(folder, hosts, Option.getOrUndefined(destination));
    yield* remove(resolved, volumes).pipe(Effect.provideService(DryRun, dryRun));
  }),
).pipe(
  Command.withAlias('down'),
  Command.withDescription("Removes the app's route, containers and networks from its host; data folders stay"),
  Command.withExamples([
    { command: 'compoza delete infra --dry-run', description: 'Show what removing the app would do' },
    { command: 'compoza delete infra --volumes', description: 'Remove the stack and its named volumes' },
  ]),
);

/**
 * The whole command tree.
 */
export const cli = root.pipe(
  Command.withSubcommands([check, deployCommand, stop, start, deleteCommand, setupProxy, publishCommand, status, logs]),
);

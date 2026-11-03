import { Console, Effect } from 'effect';

import type { Resolved } from './deploy.ts';
import type { IngressPlan } from './extensions/ingress.ts';

import { type Command, command } from './command.ts';
import { projectNameOf } from './config/deploy.ts';
import { dockerHost, type HostConfig } from './config/hosts.ts';
import { DeployError } from './errors.ts';
import { tryIngressFor, tryIngressPlan } from './extensions/ingress.ts';
import { DRY_RUN_COMPLETE, phase, type Phase, runPhases } from './progress.ts';
import { Remote } from './services/Remote.ts';
import { DryRun, Shell } from './services/Shell.ts';
import { deployedScript } from './ssh-plan.ts';

/**
 * The `docker` arguments that address an app's Compose project on its host: `--host <endpoint>
 * compose --project-name <name>`, to be followed by a subcommand such as `ps`, `stop` or `down`.
 *
 * No `--file` or `--project-directory` is passed on purpose. The project is addressed by name and
 * Compose finds its containers by their project label, so it needs neither the Compose files nor
 * their variables; loading the files from the deploy folder would only add warnings, or fail on
 * `${VAR:?}` guards whose values exist only during a deploy. Verified on Docker 29.4 with Compose
 * v5.1.2: `compose --project-name <name> ps`, `stop`, `start` and `down` all work with no Compose
 * file at all.
 */
export function projectArgs({ app, host }: Resolved): ReadonlyArray<string> {
  return ['--host', dockerHost(host), 'compose', '--project-name', projectNameOf(app)];
}

/**
 * The container actions that keep the stack in place: `stop` halts the containers and `start`
 * resumes them, with their networks, volumes and images untouched, so a stopped stack comes back
 * exactly as it was.
 */
export type LifecycleAction = 'stop' | 'start';

/**
 * The word that opens the line printed after a lifecycle action succeeds.
 */
function pastTense(action: LifecycleAction): string {
  switch (action) {
    case 'stop':
      return 'Stopped';
    case 'start':
      return 'Started';
  }
}

/**
 * The Compose command for a lifecycle action on the app's project.
 */
export function lifecycleCommand(resolved: Resolved, action: LifecycleAction): Command {
  return command('docker', [...projectArgs(resolved), action]);
}

/**
 * The Compose command that removes the app's containers and networks: `down --remove-orphans`, plus
 * `--volumes` when asked, which also removes the project's named volumes.
 *
 * Bind-mounted host folders (`directories` and `content` in `deploy.yaml`) are never touched by
 * either form: they are the data, and removing a stack must leave the data where a redeploy will
 * find it.
 */
export function downCommand(resolved: Resolved, volumes: boolean): Command {
  return command('docker', [...projectArgs(resolved), ...downArgs(volumes)]);
}

/**
 * Stops or starts the app's containers on its host, printing the command first; honours `--dry-run`
 * through `Shell.run`.
 */
export const lifecycle = Effect.fn('lifecycle')(function* (
  resolved: Resolved,
  action: LifecycleAction,
): Effect.fn.Return<void, DeployError, Remote | Shell> {
  const shell = yield* Shell;

  if (resolved.app.config.execution === 'ssh') {
    const remote = yield* Remote;
    const output = yield* remote.run(resolved.host, deployedScript(resolved.app, [action], true), {
      label: `<${action} deployed stack>`,
    });
    yield* printOutput(output);
  } else {
    yield* shell.run(lifecycleCommand(resolved, action));
  }

  const { name, host } = resolved.app.config;
  yield* Console.log(
    (yield* DryRun) ? DRY_RUN_COMPLETE : `${pastTense(action)} ${name} on ${host}`,
  );
});

/**
 * Removes the app from its host: the ingress route first, when the app has one, so the domain stops
 * being served before the containers disappear and no request meets a half-removed stack; then the
 * containers and networks, and the named volumes when asked. Host folders stay.
 *
 * Both steps print as numbered phases like a deploy, and both go through `Remote.run` and
 * `Shell.run`, so `--dry-run` shows exactly what would be removed without removing anything.
 */
export const remove = Effect.fn('remove')(function* (
  resolved: Resolved,
  volumes: boolean,
): Effect.fn.Return<void, DeployError, Remote | Shell> {
  const shell = yield* Shell;
  const remote = yield* Remote;
  const { app, host } = resolved;
  if (app.config.execution === 'ssh') {
    return yield* removeDeployedStack(resolved, volumes);
  }

  const ingress = yield* tryIngressFor(app);
  const phases: Array<Phase<DeployError, never>> = [];

  if (ingress !== undefined) {
    const routing = yield* tryIngressPlan(() => ingress.plan(app, host));
    phases.push(unroutePhase(remote, host, routing));
  }

  phases.push(
    phase(
      'down',
      volumes ? 'Removing containers, networks and volumes' : 'Removing containers and networks',
      shell.run(downCommand(resolved, volumes)),
    ),
  );

  yield* runPhases(phases);
  yield* Console.log(
    (yield* DryRun)
      ? DRY_RUN_COMPLETE
      : `Deleted ${app.config.name} from ${app.config.host}; host folders were left in place`,
  );
});

/**
 * The `compose` arguments that remove the stack: `down --remove-orphans`, plus `--volumes` when the
 * named volumes go too.
 */
function downArgs(volumes: boolean): ReadonlyArray<string> {
  return ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])];
}

/**
 * Prints a host script's output, without its trailing newline, unless the script printed nothing.
 */
function printOutput(output: string): Effect.Effect<void> {
  return output === '' ? Effect.void : Console.log(output.trimEnd());
}

/**
 * `remove` for an app deployed with `execution: ssh`: the host's own script takes the stack down,
 * leaving its stack files, secrets and data on the host.
 */
const removeDeployedStack = Effect.fn('removeDeployedStack')(function* (
  resolved: Resolved,
  volumes: boolean,
) {
  const remote = yield* Remote;
  const output = yield* remote.run(
    resolved.host,
    deployedScript(resolved.app, downArgs(volumes), true),
    { label: '<delete deployed stack; keep stack files, secrets and data>' },
  );
  yield* printOutput(output);

  yield* Console.log(
    (yield* DryRun)
      ? DRY_RUN_COMPLETE
      : `Deleted ${resolved.app.config.name}; data, secrets and stack files stay`,
  );
});

/**
 * The phase that removes the app's ingress route, printing whatever the host reports.
 */
function unroutePhase(
  remote: typeof Remote.Service,
  host: HostConfig,
  routing: IngressPlan,
): Phase<DeployError, never> {
  const { script, input, label } = routing.unroute;
  return phase(
    'unroute',
    `Removing the route for ${routing.description}`,
    remote.run(host, script, { input, label }).pipe(Effect.flatMap(printOutput)),
  );
}

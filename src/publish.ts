import { Console, Effect, FileSystem, Path } from 'effect';

import type { HostConfig } from './config/hosts.ts';

import { type Command, command, mkdirScript } from './command.ts';
import { type App, contentOf } from './config/deploy.ts';
import { DeployError, platformFailure } from './errors.ts';
import { Remote } from './services/Remote.ts';
import { Shell } from './services/Shell.ts';

/**
 * Looks up the host folder of one of the app's content sections, failing with the known section names when `section` is
 * not one of them.
 */
export function contentTarget(app: App, section: string): Effect.Effect<string, DeployError> {
  const sections = contentOf(app.config);
  const target = sections[section];
  if (target === undefined) {
    const known = Object.keys(sections).join(', ') || 'none';
    return Effect.fail(
      new DeployError({ message: `${app.config.name} has no content section "${section}" (sections: ${known})` }),
    );
  }

  return Effect.succeed(target);
}

/**
 * Builds the rsync command that mirrors the absolute folder `source` into `target`, a host folder resolved by
 * `contentTarget`.
 *
 * Dotfiles (such as `.env` and `.git`) and `node_modules` never leave this machine; `--delete` makes the host folder an
 * exact copy, which is what a content section is. Under `dryRun` rsync lists the changes instead, with `*deleting`
 * marking removals. The trailing slash on `source` makes rsync copy the folder's contents rather than the folder
 * itself; `source` comes from `path.resolve`, which drops trailing slashes. rsync's ssh runs with `BatchMode=yes` like
 * every other SSH use in the tool, so a missing key fails at once instead of stopping at a password prompt.
 */
export function rsyncCommand(host: HostConfig, target: string, source: string, dryRun: boolean): Command {
  return command('rsync', [
    '--archive',
    '--delete',
    '--itemize-changes',
    '--exclude=.*',
    '--exclude=node_modules/',
    '-e',
    'ssh -o BatchMode=yes',
    ...(dryRun ? ['--dry-run'] : []),
    `${source}/`,
    `${host.ssh}:${target}/`,
  ]);
}

/**
 * Mirrors a local folder into one of the app's content sections on its host, creating the host folder first.
 *
 * Creating the folder honours `DryRun` like any other change, so the caller sets it alongside `dryRun`. The rsync
 * itself runs with `alwaysRun`, because rsync's own `--dry-run` is the preview: it lists what would change, which a
 * printed command line cannot.
 */
export const publish = Effect.fn('publish')(function* (
  app: App,
  host: HostConfig,
  section: string,
  folder: string,
  dryRun: boolean,
) {
  const shell = yield* Shell;
  const remote = yield* Remote;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const source = path.resolve(folder);
  const exists = yield* fs.exists(source).pipe(Effect.mapError(platformFailure(`Looking for ${source}`)));
  if (!exists) {
    return yield* new DeployError({ message: `No such folder: ${source}` });
  }

  const target = yield* contentTarget(app, section);
  yield* remote.run(host, mkdirScript([target]));
  yield* shell.run(rsyncCommand(host, target, source, dryRun), { alwaysRun: true });

  yield* Console.log(
    dryRun
      ? 'Dry run: the lines above are what would change (*deleting marks removals).'
      : `Published ${section} to ${host.ssh}:${target}`,
  );
});

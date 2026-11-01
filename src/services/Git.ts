import { Context, Effect, Layer } from 'effect';

import type { DeployError } from '../errors.ts';

import { command } from '../command.ts';
import { Shell } from './Shell.ts';

/**
 * The Git facts a deployment needs about the app's repository: where it is, whether it has a commit to tag images with,
 * and whether the checkout is clean.
 *
 * Images are tagged with the commit so a running container can always be traced back to source; a dirty checkout would
 * break that, which is why `deploy` refuses one unless told otherwise.
 */
export class Git extends Context.Service<
  Git,
  {
    /**
     * The root of the repository containing `dir`, failing when it is not inside one.
     */
    root(dir: string): Effect.Effect<string, DeployError>;

    /**
     * Whether the repository has at least one commit.
     */
    hasCommits(root: string): Effect.Effect<boolean, DeployError>;

    /**
     * Whether the checkout has uncommitted or untracked changes.
     */
    isDirty(root: string): Effect.Effect<boolean, DeployError>;

    /**
     * The first twelve characters of the current commit, the image tag.
     */
    shortSha(root: string): Effect.Effect<string, DeployError>;
  }
>()('compoza/Git') {
  /**
   * The service over `Shell`, running the `git` on `PATH`.
   */
  static readonly layer: Layer.Layer<Git, never, Shell> = Layer.effect(
    Git,
    Effect.gen(function* () {
      const shell = yield* Shell;

      const git = (dir: string, ...args: ReadonlyArray<string>) =>
        shell.capture(command('git', ['-C', dir, ...args])).pipe(Effect.map((output) => output.trim()));

      return Git.of({
        root: (dir) => git(dir, 'rev-parse', '--show-toplevel'),
        hasCommits: (root) =>
          git(root, 'rev-parse', '--verify', '--quiet', 'HEAD').pipe(
            Effect.map(() => true),
            Effect.catchTag('DeployError', () => Effect.succeed(false)),
          ),
        isDirty: (root) => git(root, 'status', '--porcelain').pipe(Effect.map((output) => output !== '')),
        shortSha: (root) => git(root, 'rev-parse', '--short=12', 'HEAD'),
      });
    }),
  );
}

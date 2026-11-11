import { assert, describe, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { Resolved } from './deploy.ts';

import { type Command, printable } from './command.ts';
import { downCommand, lifecycleCommand, projectArgs, requireProjectService } from './lifecycle.ts';
import { Shell } from './services/Shell.ts';

const resolved: Resolved = {
  app: {
    dir: '/repo/infra',
    config: {
      name: 'demo',
      host: 'atlas',
      roles: { web: { build: { target: 'web' } } },
      composeFiles: ['compose.yaml'],
    },
  },
  host: {
    ssh: 'deploy@atlas.example.com',
    platform: 'linux/arm64',
    transport: { mode: 'registry', registry: 'registry.example.com' },
  },
};

describe('lifecycle commands', () => {
  it('address the project by name on the host, without Compose files', () => {
    assert.deepStrictEqual(projectArgs(resolved), [
      '--host',
      'ssh://deploy@atlas.example.com',
      'compose',
      '--project-name',
      'demo',
    ]);
    assert.strictEqual(
      printable(lifecycleCommand(resolved, 'stop')),
      'docker --host ssh://deploy@atlas.example.com compose --project-name demo stop',
    );
    assert.strictEqual(
      printable(lifecycleCommand(resolved, 'start')),
      'docker --host ssh://deploy@atlas.example.com compose --project-name demo start',
    );
  });

  it('remove containers and networks, and volumes only when asked', () => {
    assert.strictEqual(
      printable(downCommand(resolved, false)),
      'docker --host ssh://deploy@atlas.example.com compose --project-name demo ' +
        'down --remove-orphans',
    );
    assert.strictEqual(
      printable(downCommand(resolved, true)),
      'docker --host ssh://deploy@atlas.example.com compose --project-name demo ' +
        'down --remove-orphans --volumes',
    );
  });
});

describe('requireProjectService', () => {
  /**
   * Checks `service` against a project whose `ps --all --services` prints `listed`, returning the
   * failure message (or `undefined`) and the command that listed the services.
   */
  const check = (service: string, listed: string) => {
    const captured: Array<Command> = [];
    const shell = Shell.of({
      run: () => Effect.die('the check only lists services'),
      capture: (command) =>
        Effect.sync(() => {
          captured.push(command);
          return listed;
        }),
    });
    return requireProjectService(resolved, service).pipe(
      Effect.result,
      Effect.provideService(Shell, shell),
      Effect.map((result) => ({
        message: Result.isFailure(result) ? result.failure.message : undefined,
        listing: captured.map(printable),
      })),
    );
  };

  it.effect('accepts a service with containers, listed by project name', () =>
    Effect.gen(function* () {
      const { message, listing } = yield* check('maint', 'maint\nweb\n');

      assert.isUndefined(message);
      assert.deepStrictEqual(listing, [
        'docker --host ssh://deploy@atlas.example.com compose --project-name demo ps --all --services',
      ]);
    }),
  );

  it.effect('names the services it has when the requested one is missing', () =>
    Effect.gen(function* () {
      const missing = yield* check('wbe', 'maint\nweb\n');
      const empty = yield* check('web', '\n');

      assert.strictEqual(
        missing.message,
        'No service "wbe" in the running project; services: maint, web',
      );
      assert.strictEqual(empty.message, 'No service "web" in the running project; services: none');
    }),
  );
});

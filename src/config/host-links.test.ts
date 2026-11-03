import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mkdir, mkdtempDisposable, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { hostLinks, linkHosts, unlinkHosts } from './host-links.ts';
import { loadDefaultHosts } from './hosts.ts';
import { SettingsFile } from './settings.ts';

const atlas = {
  ssh: 'deploy@atlas.example.com',
  platform: 'linux/arm64',
  transport: { mode: 'ssh-load' },
} as const;

const cedar = {
  ssh: 'deploy@cedar.example.com',
  platform: 'linux/amd64',
  transport: { mode: 'ssh-load' },
} as const;

/**
 * A scratch layout: a global hosts file, a team folder holding a `hosts.yaml`, a repository folder
 * and the settings file, all removed after the test.
 */
const fixture = Effect.gen(function* () {
  const { path: dir } = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'compoza-links-'))),
    (directory) => Effect.promise(() => directory.remove()),
  );

  for (const folder of ['global', 'team', 'repo']) {
    yield* Effect.promise(() => mkdir(join(dir, folder)));
  }

  return {
    dir,
    global: join(dir, 'global', 'hosts.yaml'),
    team: join(dir, 'team'),
    teamFile: join(dir, 'team', 'hosts.yaml'),
    repo: join(dir, 'repo'),
    settings: join(dir, 'global', 'config.yaml'),
  };
});

/**
 * Writes fixture YAML.
 */
const yamlFile = (file: string, value: unknown) =>
  Effect.promise(() => writeFile(file, YAML.stringify(value)));

/**
 * Runs a test against its own fixture, with the settings file inside it.
 */
function withFixture<A, E>(
  test: (f: Effect.Success<typeof fixture>) => Effect.Effect<A, E, NodeServices.NodeServices>,
) {
  return Effect.gen(function* () {
    const f = yield* fixture;
    return yield* test(f).pipe(Effect.provideService(SettingsFile, f.settings));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
}

describe('host links', () => {
  it.effect(
    'links a folder by absolute path once and reads its hosts.yaml with the global file',
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          yield* yamlFile(f.global, { atlas });
          yield* yamlFile(f.teamFile, { cedar });

          const linked = yield* linkHosts(f.team, { globalFile: f.global });
          assert.deepStrictEqual(linked, { link: f.team, changed: true, file: f.settings });

          const again = yield* linkHosts(join(f.team, '.'), { globalFile: f.global });
          assert.isFalse(again.changed);
          assert.deepStrictEqual(yield* hostLinks(), [f.team]);

          const hosts = yield* loadDefaultHosts({
            directory: f.repo,
            globalFile: f.global,
            links: yield* hostLinks(),
          });
          assert.deepStrictEqual(hosts, { atlas, cedar });
        }),
      ),
  );

  it.effect('links a hosts file directly and supplies hosts without a global file', () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* yamlFile(f.teamFile, { cedar });
        yield* linkHosts(f.teamFile, { globalFile: f.global });

        const hosts = yield* loadDefaultHosts({
          directory: f.repo,
          globalFile: f.global,
          links: yield* hostLinks(),
        });
        assert.deepStrictEqual(hosts, { cedar });
      }),
    ),
  );

  it.effect('reads a host named like an Object method without reporting it as a duplicate', () =>
    withFixture((f) =>
      Effect.gen(function* () {
        // `constructor` is the one Object method name the host-name pattern allows.
        yield* yamlFile(f.global, { constructor: atlas });
        yield* yamlFile(f.teamFile, { cedar });
        yield* linkHosts(f.team, { globalFile: f.global });

        const hosts = yield* loadDefaultHosts({
          directory: f.repo,
          globalFile: f.global,
          links: yield* hostLinks(),
        });
        assert.deepStrictEqual(Object.keys(hosts).sort(), ['cedar', 'constructor']);
      }),
    ),
  );

  it.effect('refuses a link whose host names clash, and saves nothing', () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* yamlFile(f.global, { atlas });
        yield* yamlFile(f.teamFile, { atlas: cedar });

        const error = yield* linkHosts(f.team, { globalFile: f.global }).pipe(Effect.flip);
        assert.include(error.message, 'Host "atlas"');
        assert.include(error.message, f.global);
        assert.include(error.message, f.teamFile);
        assert.deepStrictEqual(yield* hostLinks(), []);
      }),
    ),
  );

  it.effect('refuses a missing target or a folder without hosts.yaml', () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const missing = yield* linkHosts(join(f.dir, 'absent'), { globalFile: f.global }).pipe(
          Effect.flip,
        );
        assert.include(missing.message, 'does not exist');

        const empty = yield* linkHosts(f.team, { globalFile: f.global }).pipe(Effect.flip);
        assert.include(empty.message, 'has no hosts.yaml');
        assert.deepStrictEqual(yield* hostLinks(), []);
      }),
    ),
  );

  it.effect('lets the current-directory hosts.yaml override linked hosts', () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* yamlFile(f.teamFile, { cedar });
        yield* yamlFile(join(f.repo, 'hosts.yaml'), { cedar: atlas });

        const hosts = yield* loadDefaultHosts({
          directory: f.repo,
          globalFile: f.global,
          links: [f.team],
        });
        assert.deepStrictEqual(hosts, { cedar: atlas });
      }),
    ),
  );

  it.effect('fails a run on a link that disappeared, and unlinks it without the target', () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* yamlFile(f.teamFile, { cedar });
        yield* linkHosts(f.team, { globalFile: f.global });
        yield* Effect.promise(() => rm(f.team, { recursive: true }));

        const error = yield* loadDefaultHosts({
          directory: f.repo,
          globalFile: f.global,
          links: yield* hostLinks(),
        }).pipe(Effect.flip);
        assert.include(error.message, `compoza hosts unlink ${f.team}`);

        const removed = yield* unlinkHosts(f.team);
        assert.strictEqual(removed.link, f.team);
        assert.deepStrictEqual(yield* hostLinks(), []);

        const again = yield* unlinkHosts(f.team).pipe(Effect.flip);
        assert.include(again.message, 'is not linked');
      }),
    ),
  );
});

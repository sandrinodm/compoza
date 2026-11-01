import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option, Schema } from 'effect';
import { mkdir, mkdtempDisposable, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import {
  DEFAULT_HOSTS_PATH,
  dockerHost,
  expandHome,
  hostFor,
  Hosts,
  hostsPath,
  loadDefaultHosts,
  loadHosts,
  loadHostsForRun,
  proxyComposeFile,
  proxyOf,
  proxyService,
  registryOf,
} from './hosts.ts';

const valid = {
  atlas: {
    ssh: 'deploy@atlas.example.com',
    address: '192.0.2.42',
    platform: 'linux/arm64',
    transport: { mode: 'registry', registry: 'registry.example.com' },
    proxy: {
      dir: '/srv/proxy',
      container: 'proxy-caddy-1',
      service: 'caddy',
      network: 'edge_network',
      tls: 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
      logSnippet: 'request_log',
    },
  },
  cedar: {
    ssh: 'deploy@cedar.example.com',
    address: '203.0.113.86',
    platform: 'linux/amd64',
    transport: { mode: 'ssh-load' },
  },
} as const;

describe('Hosts', () => {
  it.effect('accepts both transports and an optional proxy', () =>
    Effect.gen(function* () {
      const hosts = yield* Schema.decodeUnknownEffect(Hosts)(valid);
      const atlas = yield* hostFor({ host: 'atlas' } as never, hosts);
      assert.strictEqual(dockerHost(atlas), 'ssh://deploy@atlas.example.com');
      assert.strictEqual(registryOf(atlas), 'registry.example.com');

      const proxy = yield* proxyOf(atlas, 'atlas');
      assert.strictEqual(proxyComposeFile(proxy), 'docker-compose.yaml');
      assert.strictEqual(proxyService(proxy), 'caddy');

      const cedar = hosts.cedar;
      assert.isDefined(cedar);
      assert.isUndefined(registryOf(cedar!));

      const error = yield* proxyOf(cedar!, 'cedar').pipe(Effect.flip);
      assert.include(error.message, 'cedar');
    }),
  );

  it.effect('accepts a bare SSH config alias and defaults the service to the container', () =>
    Effect.gen(function* () {
      const { service: _service, ...proxy } = valid.atlas.proxy;
      const hosts = yield* Schema.decodeUnknownEffect(Hosts)({ nas: { ...valid.atlas, ssh: 'nas', proxy } });
      const nas = yield* hostFor({ host: 'nas' } as never, hosts);
      assert.strictEqual(dockerHost(nas), 'ssh://nas');
      assert.strictEqual(proxyService(yield* proxyOf(nas, 'nas')), 'proxy-caddy-1');
    }),
  );

  it.effect('names the known hosts when the key is unknown', () =>
    Effect.gen(function* () {
      const hosts = yield* Schema.decodeUnknownEffect(Hosts)(valid);
      const error = yield* hostFor({ host: 'nas' } as never, hosts).pipe(Effect.flip);
      assert.include(error.message, 'atlas, cedar');
    }),
  );

  it.effect.each([
    ['proxy folder', { atlas: { ...valid.atlas, proxy: { ...valid.atlas.proxy, dir: 'proxy' } } }],
    ['ssh', { atlas: { ...valid.atlas, ssh: 'deploy@atlas server.example.com' } }],
    ['empty ssh', { atlas: { ...valid.atlas, ssh: '' } }],
    ['proxy service', { atlas: { ...valid.atlas, proxy: { ...valid.atlas.proxy, service: '-caddy' } } }],
    ['platform', { atlas: { ...valid.atlas, platform: 'arm64' } }],
    ['transport', { atlas: { ...valid.atlas, transport: { mode: 'ftp' } } }],
  ])('rejects an invalid %s', ([, input]) =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(Hosts)(input).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'SchemaError');
    }),
  );
});

describe('hostsPath', () => {
  it('expands the home folder', () => {
    assert.strictEqual(expandHome('~/x/y'), join(homedir(), 'x/y'));
    assert.strictEqual(expandHome('/abs'), '/abs');
  });

  it('prefers the flag, then the environment, then the default', () => {
    const previous = process.env.COMPOZA_HOSTS;
    delete process.env.COMPOZA_HOSTS;

    try {
      assert.strictEqual(hostsPath(Option.none()), expandHome(DEFAULT_HOSTS_PATH));

      process.env.COMPOZA_HOSTS = '/etc/hosts.yaml';

      assert.strictEqual(hostsPath(Option.none()), '/etc/hosts.yaml');
      assert.strictEqual(hostsPath(Option.some('~/mine.yaml')), join(homedir(), 'mine.yaml'));
    } finally {
      if (previous === undefined) {
        delete process.env.COMPOZA_HOSTS;
      } else {
        process.env.COMPOZA_HOSTS = previous;
      }
    }
  });
});

/**
 * Creates isolated local/global host files and cleans them up after each loader test.
 */
const fixture = Effect.gen(function* () {
  const { path: dir } = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-hosts-'))),
    (directory) => Effect.promise(() => directory.remove()),
  );
  yield* Effect.promise(() => mkdir(join(dir, 'repo')));
  yield* Effect.promise(() => mkdir(join(dir, 'global')));

  return {
    dir,
    local: join(dir, 'repo', 'hosts.yaml'),
    global: join(dir, 'global', 'hosts.yaml'),
    directory: join(dir, 'repo'),
  };
});

/**
 * Writes fixture YAML through the filesystem used by the real loader.
 */
const yamlFile = (file: string, value: unknown) => Effect.promise(() => writeFile(file, YAML.stringify(value)));

describe('host file loading', () => {
  it.effect('replaces complete global entries locally and preserves other global hosts', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* yamlFile(f.global, valid);
      yield* yamlFile(f.local, { atlas: valid.cedar });

      assert.deepStrictEqual(yield* loadDefaultHosts(f.directory, f.global), {
        atlas: valid.cedar,
        cedar: valid.cedar,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('allows either default file to be absent, but reports both paths if neither exists', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = yield* loadDefaultHosts(f.directory, f.global).pipe(Effect.flip);
      assert.include(error.message, f.local);
      assert.include(error.message, f.global);

      yield* yamlFile(f.local, valid);

      assert.deepStrictEqual(yield* loadDefaultHosts(f.directory, f.global), valid);

      yield* Effect.promise(() => rm(f.local));
      yield* yamlFile(f.global, valid);

      assert.deepStrictEqual(yield* loadDefaultHosts(f.directory, f.global), valid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('resolves relative references from each containing file and supports absolute paths', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* yamlFile(join(f.dir, 'global', 'host.yaml'), valid.atlas);
      yield* yamlFile(join(f.directory, 'host.yaml'), valid.cedar);
      yield* yamlFile(f.global, { atlas: { $ref: './host.yaml' } });
      yield* yamlFile(f.local, {
        cedar: { $ref: './host.yaml' },
        other: { $ref: join(f.dir, 'global', 'host.yaml') },
      });

      assert.deepStrictEqual(yield* loadDefaultHosts(f.directory, f.global), {
        ...valid,
        other: valid.atlas,
      });
      assert.deepStrictEqual(yield* loadHosts(f.global), { atlas: valid.atlas });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('does not read a global reference replaced by a local host', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* yamlFile(f.global, { atlas: { $ref: './missing.yaml' } });
      yield* yamlFile(f.local, { atlas: valid.cedar });

      assert.deepStrictEqual(yield* loadDefaultHosts(f.directory, f.global), { atlas: valid.cedar });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('fails on malformed local configuration instead of using the global host', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* yamlFile(f.global, valid);

      for (const value of [{ atlas: { ssh: 'partial' } }, { atlas: { ...valid.atlas, typo: true } }]) {
        yield* yamlFile(f.local, value);

        const error = yield* loadDefaultHosts(f.directory, f.global).pipe(Effect.flip);
        assert.include(error.message, f.local);
      }

      yield* Effect.promise(() => writeFile(f.local, '{'));

      const error = yield* loadDefaultHosts(f.directory, f.global).pipe(Effect.flip);
      assert.include(error.message, 'not valid YAML');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('rejects missing targets, nested references, and ambiguous or invalid references', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* yamlFile(f.global, { atlas: { $ref: './missing.yaml' } });

      const missing = yield* loadHosts(f.global).pipe(Effect.flip);
      assert.include(missing.message, 'missing.yaml');
      assert.include(missing.message, 'atlas');
      assert.include(missing.message, f.global);

      for (const entry of [{ $ref: '' }, { $ref: '   ' }, { $ref: './host.yaml', ...valid.atlas }]) {
        yield* yamlFile(f.global, { atlas: entry });

        const error = yield* loadHosts(f.global).pipe(Effect.flip);
        assert.include(error.message, f.global);
      }

      yield* yamlFile(f.global, { atlas: { $ref: './host.yaml' } });

      for (const value of [{ $ref: './hosts.yaml' }, { ...valid.atlas, typo: true }, valid]) {
        yield* yamlFile(join(f.dir, 'global', 'host.yaml'), value);

        const error = yield* loadHosts(f.global).pipe(Effect.flip);
        assert.include(error.message, join(f.dir, 'global', 'host.yaml'));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('uses explicit flag and environment files exclusively, failing when they are missing', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* yamlFile(f.global, valid);
      yield* yamlFile(f.local, { local: valid.cedar });

      const previous = process.env.COMPOZA_HOSTS;

      try {
        process.env.COMPOZA_HOSTS = f.local;

        assert.deepStrictEqual(yield* loadHostsForRun(Option.none()), { local: valid.cedar });
        assert.deepStrictEqual(yield* loadHostsForRun(Option.some(f.global)), valid);

        const error = yield* loadHostsForRun(Option.some(join(f.dir, 'absent.yaml'))).pipe(Effect.flip);
        assert.include(error.message, 'absent.yaml');

        process.env.COMPOZA_HOSTS = join(f.dir, 'missing-env.yaml');

        const envError = yield* loadHostsForRun(Option.none()).pipe(Effect.flip);
        assert.include(envError.message, 'missing-env.yaml');
      } finally {
        if (previous === undefined) {
          delete process.env.COMPOZA_HOSTS;
        } else {
          process.env.COMPOZA_HOSTS = previous;
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

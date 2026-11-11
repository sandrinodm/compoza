import { assert, describe, it } from '@effect/vitest';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { isPipeline, printableStep, REMOTE_PATH, shellQuote } from './command.ts';
import { composePrefix, planDeployment } from './plan.ts';
import { buildSettingsOf, imageReference } from './roles.ts';

const app: App = {
  dir: '/repo/infra',
  config: {
    name: 'demo',
    host: 'atlas',
    roles: { builder: { build: { target: 'builder' } }, web: { build: { target: 'web' } } },
    composeFiles: ['compose.yaml', 'compose.production.yaml'],
    environment: { DEMO_PORT: '8090' },
    local: { composeFiles: ['compose.yaml'], environment: { DEMO_SOURCES_PATH: '../sources' } },
  },
};

const registryHost: HostConfig = {
  ssh: 'deploy@atlas.example.com',
  platform: 'linux/arm64',
  transport: { mode: 'registry', registry: 'registry.example.com' },
};

/**
 * A role source under the fixture repository.
 */
function source(tag: string, context = '/repo') {
  return { tag, context };
}

const sshHost: HostConfig = { ...registryHost, transport: { mode: 'ssh-load' } };

describe('naming', () => {
  it('prefixes the registry only when the host pulls from one', () => {
    assert.strictEqual(
      imageReference(app, registryHost, 'web', 'abc', false),
      'registry.example.com/demo-web:abc',
    );
    assert.strictEqual(imageReference(app, registryHost, 'web', 'abc', true), 'demo-web:abc');
    assert.strictEqual(imageReference(app, sshHost, 'web', 'abc', false), 'demo-web:abc');
    assert.strictEqual(buildSettingsOf(app, 'web').dockerfile, '/repo/infra/Dockerfile');
    assert.strictEqual(
      buildSettingsOf({ ...app, config: { ...app.config, dockerfile: '../Dockerfile' } }, 'web')
        .dockerfile,
      '/repo/Dockerfile',
    );
  });

  it('keeps an absolute dockerfile and compose file as given', () => {
    const absolute: App = {
      ...app,
      config: { ...app.config, dockerfile: '/abs/Dockerfile', composeFiles: ['/abs/compose.yaml'] },
    };
    assert.strictEqual(buildSettingsOf(absolute, 'web').dockerfile, '/abs/Dockerfile');

    const steps = planDeployment({
      app: absolute,
      host: registryHost,
      sources: { builder: source('abc'), web: source('abc') },
      local: false,
      reuseImages: false,
      secrets: {},
    });
    assert.include(printableStep(steps[0]!), '--file /abs/Dockerfile ');
    assert.include(printableStep(steps.at(-1)!), '--file /abs/compose.yaml up');
  });

  it('builds the compose prefix for the host or this machine', () => {
    assert.deepStrictEqual(composePrefix(app, registryHost), [
      '--host',
      'ssh://deploy@atlas.example.com',
      'compose',
      '--project-name',
      'demo',
      '--project-directory',
      '/repo/infra',
    ]);
    assert.deepStrictEqual(composePrefix(app), [
      'compose',
      '--project-name',
      'demo',
      '--project-directory',
      '/repo/infra',
    ]);
  });
});

describe('planDeployment', () => {
  const base = {
    app,
    sources: { builder: source('abc123'), web: source('abc123') },
    local: false,
    reuseImages: false,
    secrets: { PG_PASSWORD: 'x' },
  };

  it('builds with --push for a registry host and pulls always', () => {
    const steps = planDeployment({ ...base, host: registryHost });
    assert.deepStrictEqual(steps.map(printableStep), [
      'docker buildx build --platform linux/arm64 --push --file /repo/infra/Dockerfile --target builder --tag registry.example.com/demo-builder:abc123 /repo',
      'docker buildx build --platform linux/arm64 --push --file /repo/infra/Dockerfile --target web --tag registry.example.com/demo-web:abc123 /repo',
      'DEMO_PORT=8090 PG_PASSWORD=*** docker --host ssh://deploy@atlas.example.com compose --project-name demo --project-directory /repo/infra --env-file /dev/null --file /repo/infra/compose.yaml --file /repo/infra/compose.production.yaml up --detach --remove-orphans --no-build --pull always',
    ]);

    const compose = steps.at(-1);
    assert.isTrue(
      compose !== undefined && !isPipeline(compose) && compose.env?.PG_PASSWORD === 'x',
    );
  });

  it('loads and ships over ssh for an ssh-load host and pulls missing images', () => {
    const steps = planDeployment({ ...base, host: sshHost });
    assert.strictEqual(steps.length, 5);
    assert.deepStrictEqual(steps.slice(0, 2).map(printableStep), [
      'docker buildx build --platform linux/arm64 --load --file /repo/infra/Dockerfile --target builder --tag demo-builder:abc123 /repo',
      "docker save demo-builder:abc123 | gzip | ssh -o BatchMode=yes deploy@atlas.example.com bash -c 'export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH\ngunzip | docker load'",
    ]);

    const transport = steps[1]!;
    assert.isTrue(isPipeline(transport));
    assert.deepStrictEqual(isPipeline(transport) ? transport.stages.at(-1)?.args : [], [
      '-o',
      'BatchMode=yes',
      'deploy@atlas.example.com',
      `bash -c ${shellQuote(`${REMOTE_PATH}\ngunzip | docker load`)}`,
    ]);
    assert.include(printableStep(steps[4]!), '--pull missing');
  });

  it('runs locally without platform, transport or host and pulls missing images', () => {
    const steps = planDeployment({ ...base, host: registryHost, local: true });
    assert.deepStrictEqual(steps.map(printableStep), [
      'docker buildx build --load --file /repo/infra/Dockerfile --target builder --tag demo-builder:abc123 /repo',
      'docker buildx build --load --file /repo/infra/Dockerfile --target web --tag demo-web:abc123 /repo',
      'DEMO_PORT=8090 DEMO_SOURCES_PATH=../sources PG_PASSWORD=*** docker compose --project-name demo --project-directory /repo/infra --env-file /dev/null --file /repo/infra/compose.yaml up --detach --remove-orphans --no-build --pull missing',
    ]);
  });

  it('skips the build when reusing images', () => {
    const steps = planDeployment({ ...base, host: registryHost, reuseImages: true });
    assert.strictEqual(steps.length, 1);
    assert.include(printableStep(steps[0]!), 'compose --project-name demo');
  });

  it('builds a role without a target and with its own dockerfile, context and directory', () => {
    const roles: App['config']['roles'] = {
      api: { build: {} },
      worker: {
        build: {
          target: 'worker',
          workingDirectory: '/other/worker',
          dockerfile: 'infra/worker.Dockerfile',
          context: 'src',
        },
      },
    };
    const steps = planDeployment({
      ...base,
      app: { ...app, config: { ...app.config, roles } },
      host: registryHost,
      sources: { api: source('abc', '/repo'), worker: source('def', '/other/worker/src') },
    });
    const [api, worker] = steps;
    assert.strictEqual(
      printableStep(api!),
      'docker buildx build --platform linux/arm64 --push --file /repo/infra/Dockerfile --tag registry.example.com/demo-api:abc /repo',
    );
    assert.strictEqual(
      printableStep(worker!),
      'docker buildx build --platform linux/arm64 --push --file /other/worker/infra/worker.Dockerfile --target worker --tag registry.example.com/demo-worker:def /other/worker/src',
    );
    assert.strictEqual(isPipeline(api!) ? '' : api!.cwd, '/repo/infra');
    assert.strictEqual(isPipeline(worker!) ? '' : worker!.cwd, '/other/worker');
  });

  it('builds nothing for roles without a build', () => {
    const roles = { postgres: { environment: { POSTGRES_USER: 'demo' } } };
    const steps = planDeployment({
      ...base,
      app: { ...app, config: { ...app.config, roles } },
      host: registryHost,
      sources: {},
    });
    assert.strictEqual(steps.length, 1);
  });

  it('passes the roles override to compose as the last file', () => {
    const overrideFile = '/tmp/compoza-roles-x/compoza.roles.yaml';
    const client = planDeployment({ ...base, host: registryHost, overrideFile });
    assert.include(
      printableStep(client.at(-1)!),
      '--file /repo/infra/compose.production.yaml --file /tmp/compoza-roles-x/compoza.roles.yaml up',
    );

    const local = planDeployment({ ...base, host: registryHost, local: true, overrideFile });
    assert.include(
      printableStep(local.at(-1)!),
      '--file /repo/infra/compose.yaml --file /tmp/compoza-roles-x/compoza.roles.yaml up',
    );
  });
});

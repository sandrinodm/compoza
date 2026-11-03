import { assert, describe, it } from '@effect/vitest';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { isPipeline, printableStep, REMOTE_PATH, shellQuote } from './command.ts';
import {
  composePrefix,
  dockerfileOf,
  imageReference,
  imageVariable,
  planDeployment,
} from './plan.ts';

const app: App = {
  dir: '/repo/infra',
  config: {
    name: 'demo',
    host: 'atlas',
    targets: ['builder', 'web'],
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

const sshHost: HostConfig = { ...registryHost, transport: { mode: 'ssh-load' } };

describe('naming', () => {
  it('prefixes the registry only when the host pulls from one', () => {
    assert.strictEqual(
      imageReference(app, registryHost, 'web', 'abc', false),
      'registry.example.com/demo-web:abc',
    );
    assert.strictEqual(imageReference(app, registryHost, 'web', 'abc', true), 'demo-web:abc');
    assert.strictEqual(imageReference(app, sshHost, 'web', 'abc', false), 'demo-web:abc');
    assert.strictEqual(imageVariable('scraper-api'), 'SCRAPER_API_IMAGE');
    assert.strictEqual(dockerfileOf(app), '/repo/infra/Dockerfile');
    assert.strictEqual(
      dockerfileOf({ ...app, config: { ...app.config, dockerfile: '../Dockerfile' } }),
      '/repo/Dockerfile',
    );
  });

  it('keeps an absolute dockerfile and compose file as given', () => {
    const absolute: App = {
      ...app,
      config: { ...app.config, dockerfile: '/abs/Dockerfile', composeFiles: ['/abs/compose.yaml'] },
    };
    assert.strictEqual(dockerfileOf(absolute), '/abs/Dockerfile');

    const steps = planDeployment({
      app: absolute,
      host: registryHost,
      tag: 'abc',
      local: false,
      reuseImages: false,
      context: '/repo',
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
    tag: 'abc123',
    local: false,
    reuseImages: false,
    context: '/repo',
    secrets: { PG_PASSWORD: 'x' },
  };

  it('builds with --push for a registry host and pulls always', () => {
    const steps = planDeployment({ ...base, host: registryHost });
    assert.deepStrictEqual(steps.map(printableStep), [
      'docker buildx build --platform linux/arm64 --push --file /repo/infra/Dockerfile --target builder --tag registry.example.com/demo-builder:abc123 /repo',
      'docker buildx build --platform linux/arm64 --push --file /repo/infra/Dockerfile --target web --tag registry.example.com/demo-web:abc123 /repo',
      'DEMO_PORT=8090 PG_PASSWORD=*** BUILDER_IMAGE=registry.example.com/demo-builder:abc123 WEB_IMAGE=registry.example.com/demo-web:abc123 docker --host ssh://deploy@atlas.example.com compose --project-name demo --project-directory /repo/infra --env-file /dev/null --file /repo/infra/compose.yaml --file /repo/infra/compose.production.yaml up --detach --remove-orphans --no-build --pull always',
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
      'DEMO_PORT=8090 DEMO_SOURCES_PATH=../sources PG_PASSWORD=*** BUILDER_IMAGE=demo-builder:abc123 WEB_IMAGE=demo-web:abc123 docker compose --project-name demo --project-directory /repo/infra --env-file /dev/null --file /repo/infra/compose.yaml up --detach --remove-orphans --no-build --pull missing',
    ]);
  });

  it('skips the build when reusing images', () => {
    const steps = planDeployment({ ...base, host: registryHost, reuseImages: true });
    assert.strictEqual(steps.length, 1);
    assert.include(printableStep(steps[0]!), 'WEB_IMAGE=registry.example.com/demo-web:abc123');
  });
});

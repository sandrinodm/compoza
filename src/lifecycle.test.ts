import { assert, describe, it } from '@effect/vitest';

import type { Resolved } from './deploy.ts';

import { printable } from './command.ts';
import { downCommand, lifecycleCommand, projectArgs } from './lifecycle.ts';

const resolved: Resolved = {
  app: {
    dir: '/repo/infra',
    config: { name: 'demo', host: 'atlas', targets: ['web'], composeFiles: ['compose.yaml'] },
  },
  host: {
    ssh: 'deploy@atlas.example.com',
    address: '192.0.2.42',
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
      'docker --host ssh://deploy@atlas.example.com compose --project-name demo down --remove-orphans',
    );
    assert.strictEqual(
      printable(downCommand(resolved, true)),
      'docker --host ssh://deploy@atlas.example.com compose --project-name demo down --remove-orphans --volumes',
    );
  });
});

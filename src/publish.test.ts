import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import type { App } from './config/deploy.ts';
import type { HostConfig } from './config/hosts.ts';

import { printable } from './command.ts';
import { contentTarget, rsyncCommand } from './publish.ts';

const app: App = {
  dir: '/repo/infra',
  config: {
    name: 'demo',
    host: 'atlas',
    targets: ['web'],
    composeFiles: ['compose.yaml'],
    content: { demo: '/srv/demo/data/demo' },
  },
};

const host: HostConfig = {
  ssh: 'deploy@atlas.example.com',
  address: '192.0.2.42',
  platform: 'linux/arm64',
  transport: { mode: 'ssh-load' },
};

describe('rsyncCommand', () => {
  it('mirrors with rsync, excluding dotfiles and dependencies', () => {
    assert.strictEqual(
      printable(rsyncCommand(host, '/srv/demo/data/demo', '/me/demo', true)),
      'rsync --archive --delete --itemize-changes --exclude=.* --exclude=node_modules/ -e ssh -o BatchMode=yes --dry-run /me/demo/ deploy@atlas.example.com:/srv/demo/data/demo/',
    );
  });

  it('passes --dry-run only when asked', () => {
    const real = rsyncCommand(host, '/srv/demo/data/demo', '/me/demo', false);
    assert.notInclude(real.args, '--dry-run');
    assert.deepStrictEqual(real.args.slice(-2), ['/me/demo/', 'deploy@atlas.example.com:/srv/demo/data/demo/']);
  });
});

describe('contentTarget', () => {
  it.effect('resolves a section to its host folder', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* contentTarget(app, 'demo'), '/srv/demo/data/demo');
      const unknown = yield* contentTarget(app, 'research').pipe(Effect.flip);
      assert.include(unknown.message, 'sections: demo');
      const error = yield* contentTarget({ ...app, config: { ...app.config, content: {} } }, 'demo').pipe(Effect.flip);
      assert.include(error.message, 'sections: none');
    }),
  );
});

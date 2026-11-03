import { assert, describe, it } from '@effect/vitest';

import { command, isPipeline, printable, printableStep, shellQuote } from './command.ts';

describe('printable', () => {
  it('masks secret variables and keeps the rest', () => {
    const line = printable(
      command('docker', ['compose', 'up'], {
        env: { PG_PASSWORD: 'x', PORT: '80' },
        secret: ['PG_PASSWORD'],
      }),
    );
    assert.strictEqual(line, 'PG_PASSWORD=*** PORT=80 docker compose up');
  });

  it('joins pipeline stages', () => {
    const step = { stages: [command('docker', ['save', 'img']), command('gzip', [])] };
    assert.isTrue(isPipeline(step));
    assert.isFalse(isPipeline(command('ls', [])));
    assert.strictEqual(printableStep(step), 'docker save img | gzip');
  });
});

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded ones', () => {
    assert.strictEqual(shellQuote('plain'), "'plain'");
    assert.strictEqual(shellQuote("it's"), `'it'\\''s'`);
  });
});

import { assert, describe, it } from '@effect/vitest';
import { Context, Option } from 'effect';

import { closestNames, helpFormatter, helpText, IgnoredSharedFlags } from './help.ts';

const LONG_PARAGRAPH =
  'Builds, ships and runs a Docker Compose stack on a remote host over SSH, routes traffic to ' +
  'it through Caddy or Cloudflare Tunnel, and waits until it answers.';

const sharedFlag = (name: string) => ({
  name,
  aliases: [],
  type: 'string',
  description: Option.some(`The ${name} flag`),
  required: false,
});

const helpDoc = {
  description: 'Lists things',
  usage: 'compoza things',
  flags: [],
  inheritedFlags: [sharedFlag('destination'), sharedFlag('hosts')],
  commandPath: ['compoza', 'things'],
  annotations: Context.empty(),
  subcommands: [
    {
      group: undefined,
      commands: [{ name: 'list', alias: undefined, shortDescription: 'List', description: 'List' }],
    },
  ],
  examples: [{ command: 'compoza things list' }],
} as const;

describe('helpText', () => {
  it('wraps paragraphs to 80 columns once indented', () => {
    const lines = `  ${helpText([LONG_PARAGRAPH, 'Second paragraph.'])}`.split('\n');

    assert.isAbove(lines.length, 2);

    for (const line of lines) {
      assert.isAtMost(line.length, 80, line);
    }
  });

  it('indents every line after the first and separates paragraphs with a blank line', () => {
    const text = helpText([LONG_PARAGRAPH, 'Second paragraph.']);
    const [, ...rest] = text.split('\n');

    assert.deepStrictEqual(
      rest.filter((line) => !line.startsWith('  ')),
      [''],
    );
    assert.isTrue(text.endsWith('\n\n  Second paragraph.'));
  });

  it('keeps a word longer than a line whole', () => {
    const url = `https://example.com/${'a'.repeat(90)}`;

    assert.strictEqual(helpText([`See ${url}`]), `See\n  ${url}`);
  });
});

describe('helpFormatter', () => {
  it('keeps every inherited shared flag by default', () => {
    const help = helpFormatter(false).formatHelpDoc(helpDoc);

    assert.include(help, '--destination');
    assert.include(help, '--hosts');
  });

  it('leaves out the shared flags a command ignores', () => {
    const annotations = Context.make(IgnoredSharedFlags, ['destination']);
    const help = helpFormatter(false).formatHelpDoc({ ...helpDoc, annotations });

    assert.notInclude(help, '--destination');
    assert.include(help, '--hosts');
  });

  it('sets the examples off from a subcommand list with a blank line', () => {
    const help = helpFormatter(false).formatHelpDoc(helpDoc);

    assert.include(help, 'List\n\nEXAMPLES');
  });
});

describe('closestNames', () => {
  it('suggests the names at the fewest edits', () => {
    assert.deepStrictEqual(closestNames('depoy', ['deploy', 'delete', 'down']), ['deploy']);
  });

  it('suggests nothing more than two edits away', () => {
    assert.deepStrictEqual(closestNames('zzz', ['deploy', 'logs']), []);
  });
});

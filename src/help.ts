import { Context } from 'effect';
import { CliOutput, type HelpDoc } from 'effect/cli';
import { stripVTControlCharacters } from 'node:util';

/**
 * The widest a help paragraph line may be, in columns, counting the indent the formatter puts in
 * front of it.
 */
const HELP_WIDTH_COLUMNS = 80;

/**
 * The indent the help formatter puts in front of every line of a command's description.
 */
const DESCRIPTION_INDENT = '  ';

/**
 * The heading the help formatter writes above a command's examples.
 */
const EXAMPLES_HEADING = 'EXAMPLES';

/**
 * The most single-character edits a mistyped command name may be from a command for it to be
 * suggested, the same limit Effect's parser uses for `compoza <unknown>`.
 */
const MAX_SUGGESTION_EDITS = 2;

/**
 * A flag the root command shares with every subcommand.
 */
export type SharedFlagName = 'destination' | 'hosts';

/**
 * The shared root flags a command does not read, so its help leaves them out of `INHERITED FLAGS`.
 * Attach it with `Command.annotate`; a command without it reads every shared flag.
 */
export const IgnoredSharedFlags = Context.Reference<ReadonlyArray<SharedFlagName>>(
  'compoza/IgnoredSharedFlags',
  { defaultValue: () => [] },
);

/**
 * Builds a command description from paragraphs for `Command.withDescription`.
 *
 * Each paragraph is wrapped at word boundaries to fit 80 columns once the formatter indents it, and
 * paragraphs are separated by a blank line. The formatter indents only the first line of a
 * description, so every later line carries that indent here. A word longer than a line is kept
 * whole on its own line. An empty list gives an empty description.
 */
export function helpText(paragraphs: ReadonlyArray<string>): string {
  return paragraphs
    .map((paragraph) => wrap(paragraph, HELP_WIDTH_COLUMNS - DESCRIPTION_INDENT.length))
    .map((lines) => lines.join(`\n${DESCRIPTION_INDENT}`))
    .join(`\n\n${DESCRIPTION_INDENT}`);
}

/**
 * The help formatter of the CLI: Effect's default formatter, with three changes.
 *
 * - Subcommand help points to `compoza --help` for the global flags instead of repeating them.
 * - `INHERITED FLAGS` leaves out the shared flags the command declares in `IgnoredSharedFlags`.
 * - `EXAMPLES` is always set off by a blank line, which the default formatter omits after a plain
 *   subcommand list.
 *
 * `colors` forces ANSI colors on or off; left out, the terminal decides.
 */
export function helpFormatter(colors?: boolean): CliOutput.Formatter {
  const base = CliOutput.defaultFormatter({ colors, globalFlags: 'summary' });

  return {
    formatHelpDoc: (doc) => separateExamples(base.formatHelpDoc(withoutIgnoredFlags(doc))),
    formatCliError: base.formatCliError,
    formatError: base.formatError,
    formatVersion: base.formatVersion,
    formatErrors: base.formatErrors,
  };
}

/**
 * The candidates closest to a mistyped `input`, for a "Did you mean" hint: those at the smallest
 * edit distance found, if it is at most two edits, in their given order. Empty when nothing is that
 * close.
 */
export function closestNames(input: string, candidates: ReadonlyArray<string>): Array<string> {
  const scored = candidates
    .map((candidate) => ({ candidate, edits: editDistance(input, candidate) }))
    .filter(({ edits }) => edits <= MAX_SUGGESTION_EDITS);
  const fewest = Math.min(...scored.map(({ edits }) => edits));
  return scored.filter(({ edits }) => edits === fewest).map(({ candidate }) => candidate);
}

/**
 * `doc` without the inherited flags its command declares in `IgnoredSharedFlags`.
 */
function withoutIgnoredFlags(doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc {
  const ignored = new Set<string>(Context.get(doc.annotations, IgnoredSharedFlags));

  if (doc.inheritedFlags === undefined || ignored.size === 0) {
    return doc;
  }

  return { ...doc, inheritedFlags: doc.inheritedFlags.filter((flag) => !ignored.has(flag.name)) };
}

/**
 * Splits `text` into lines of at most `width` columns, breaking only between words.
 */
function wrap(text: string, width: number): Array<string> {
  const lines: Array<string> = [];
  let line = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line !== '') {
    lines.push(line);
  }

  return lines;
}

/**
 * Puts a blank line before the `EXAMPLES` heading of formatted help when the line above it has
 * text.
 */
function separateExamples(help: string): string {
  const lines = help.split('\n');
  const heading = lines.findIndex((line) => stripVTControlCharacters(line) === EXAMPLES_HEADING);

  if (heading > 0 && lines[heading - 1] !== '') {
    lines.splice(heading, 0, '');
  }

  return lines.join('\n');
}

/**
 * The Levenshtein distance between `a` and `b`: how many single-character insertions, deletions or
 * substitutions turn one into the other.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];

    for (let j = 0; j < b.length; j++) {
      const substitution = (previous[j] ?? 0) + (a[i] === b[j] ? 0 : 1);
      current.push(Math.min((previous[j + 1] ?? 0) + 1, (current[j] ?? 0) + 1, substitution));
    }

    previous = current;
  }

  return previous[b.length] ?? 0;
}

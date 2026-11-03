import { Effect } from 'effect';

import { DeployError } from '../errors.ts';

/**
 * A portable environment variable name, as POSIX shells accept it: a letter or underscore, then
 * letters, digits and underscores.
 */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The characters that may wrap a value; a value that opens with one must close with the same one.
 */
const QUOTES = new Set(['"', "'"]);

/**
 * Parses `KEY=value` lines into a record. Blank lines and `#` comments are skipped, surrounding
 * whitespace is trimmed, and a value wrapped in matching single or double quotes loses the quotes.
 *
 * This format deliberately excludes interpolation, escape processing and multiline values. Parse
 * errors report only line numbers, keeping raw secret-bearing input out of diagnostics.
 */
export function parseEnvFile(text: string): Effect.Effect<Record<string, string>, DeployError> {
  const values: Record<string, string> = Object.create(null);

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return envFileFailure(`Invalid env file at line ${lineNumber}`);
    }

    const key = trimmed.slice(0, separator).trim();
    if (!VARIABLE_NAME_PATTERN.test(key) || Object.hasOwn(values, key)) {
      return envFileFailure(`Invalid or duplicate env key at line ${lineNumber}`);
    }

    const value = trimmed.slice(separator + 1).trim();
    const quoted = QUOTES.has(value.charAt(0));
    if (quoted && value.at(-1) !== value[0]) {
      return envFileFailure(
        `Unterminated env value at line ${lineNumber}; multiline values are unsupported`,
      );
    }

    // A lone quote character opens and closes the same quote, so it is kept as the value.
    values[key] = quoted && value.length >= 2 ? value.slice(1, -1) : value;
  }

  return Effect.succeed({ ...values });
}

/**
 * Fails a parse with `message`, which names the line but never quotes it.
 */
function envFileFailure(message: string): Effect.Effect<never, DeployError> {
  return Effect.fail(new DeployError({ message }));
}

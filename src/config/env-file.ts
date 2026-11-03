import { Effect } from 'effect';

import { DeployError } from '../errors.ts';

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
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return Effect.fail(new DeployError({ message: `Invalid env file at line ${index + 1}` }));
    }

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(values, key)) {
      return Effect.fail(
        new DeployError({ message: `Invalid or duplicate env key at line ${index + 1}` }),
      );
    }

    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') || value.startsWith("'")) && value.at(-1) !== value[0]) {
      return Effect.fail(
        new DeployError({
          message: `Unterminated env value at line ${index + 1}; multiline values are unsupported`,
        }),
      );
    }

    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return Effect.succeed({ ...values });
}

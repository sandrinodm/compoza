import { Effect, FileSystem, Schema } from 'effect';
import { parseDocument } from 'yaml';

import { DeployError, platformFailure } from '../errors.ts';

/**
 * Reads the YAML file at `file` and decodes it with `schema`, failing with `missingMessage` when
 * the file does not exist.
 *
 * Every failure is a `DeployError` naming the file: a missing file gets the caller's message,
 * because it is the usual first mistake and each file has its own remedy; a syntax error says the
 * file is not valid YAML; a decoding error is the schema's message prefixed with the path. `file`
 * is used as given, so callers resolve it first and the messages show the absolute path.
 *
 * Unknown keys are an error rather than ignored: both files are hand-written, and a misspelt or
 * outdated key (such as a top-level `domain` from an older layout) would otherwise be dropped
 * silently, so a deploy would skip the routing it was meant to do.
 */
export const readConfigFile = Effect.fn('readConfigFile')(function* <T>(
  file: string,
  schema: Schema.Decoder<T>,
  missingMessage: string,
  privateInput = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(file)
    .pipe(Effect.mapError(platformFailure(`Looking for ${file}`)));
  if (!exists) {
    return yield* new DeployError({ message: missingMessage });
  }

  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(platformFailure(`Reading ${file}`)));
  const value = yield* Effect.try({
    try: () => parseConfig(text),
    catch: (cause) =>
      new DeployError({
        message: `${file} is not valid YAML${privateInput ? '' : `: ${String(cause)}`}`,
      }),
  });
  return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError(
      (error) =>
        new DeployError({
          message: `${file}: ${privateInput ? 'invalid configuration; check field names and source settings privately' : error.message}`,
        }),
    ),
  );
});

/**
 * Parses one YAML 1.2 document with unique keys, string keys and bounded alias expansion.
 */
export function parseConfig(text: string): unknown {
  const document = parseDocument(text, {
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    resolveKnownTags: false,
    version: '1.2',
  });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue !== undefined) {
    throw issue;
  }

  return document.toJS({ maxAliasCount: 100 }) as unknown;
}

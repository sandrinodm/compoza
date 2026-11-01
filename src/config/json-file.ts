import { Effect, FileSystem, Schema } from 'effect';

import { DeployError, platformFailure } from '../errors.ts';

/**
 * Reads the JSON file at `file` and decodes it with `schema`, failing with `missingMessage` when the file does not
 * exist.
 *
 * Every failure is a `DeployError` naming the file: a missing file gets the caller's message, because it is the usual
 * first mistake and each file has its own remedy; a syntax error says the file is not valid JSON; a decoding error is
 * the schema's message prefixed with the path. `file` is used as given, so callers resolve it first and the messages
 * show the absolute path.
 *
 * Unknown keys are an error rather than ignored: both files are hand-written, and a misspelt or outdated key (such as a
 * top-level `domain` from an older layout) would otherwise be dropped silently, so a deploy would skip the routing it
 * was meant to do.
 */
export const readJsonFile = Effect.fn('readJsonFile')(function* <T>(
  file: string,
  schema: Schema.Decoder<T>,
  missingMessage: string,
  privateInput = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(file).pipe(Effect.mapError(platformFailure(`Looking for ${file}`)));
  if (!exists) {
    return yield* new DeployError({ message: missingMessage });
  }
  const text = yield* fs.readFileString(file).pipe(Effect.mapError(platformFailure(`Reading ${file}`)));
  const json = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new DeployError({ message: `${file} is not valid JSON${privateInput ? '' : `: ${String(cause)}`}` }),
  });
  return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(json).pipe(
    Effect.mapError(
      (error) =>
        new DeployError({
          message: `${file}: ${privateInput ? 'invalid configuration; check field names and source settings privately' : error.message}`,
        }),
    ),
  );
});

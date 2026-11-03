import { Effect, FileSystem, Schema } from 'effect';
import { parseDocument } from 'yaml';

import { DeployError, platformFailure } from '../errors.ts';

/**
 * The most alias references one document may expand. Ordinary anchors stay well below it, while a
 * document that nests aliases to multiply its size (a "billion laughs" file) is rejected.
 */
const MAX_YAML_ALIASES = 100;

/**
 * What a decoding error says about a private file in place of the schema's message, which can quote
 * the offending values.
 */
const PRIVATE_DECODING_HINT =
  'invalid configuration; check field names and source settings privately';

/**
 * How `readConfigFile` treats a file.
 */
interface ReadConfigOptions {
  /**
   * Whether the file may hold secret values, so syntax and decoding errors leave out the parser's
   * details, which can quote the file's contents. `false` when left out.
   */
  readonly privateInput?: boolean;
}

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
  { privateInput = false }: ReadConfigOptions = {},
) {
  if (!(yield* fileExists(file))) {
    return yield* new DeployError({ message: missingMessage });
  }

  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(platformFailure(`Reading ${file}`)));
  const value = yield* Effect.try({
    try: () => parseConfig(text),
    catch: (cause) => invalidYaml(file, privateInput ? undefined : String(cause)),
  });
  return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError((error) =>
      invalidConfiguration(file, privateInput ? PRIVATE_DECODING_HINT : error.message),
    ),
  );
});

/**
 * Whether `file` exists, failing with a `DeployError` naming it when the file system cannot tell.
 */
export function fileExists(
  file: string,
): Effect.Effect<boolean, DeployError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(file).pipe(Effect.mapError(platformFailure(`Looking for ${file}`)));
  });
}

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

  return document.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown;
}

/**
 * The failure for a file that is not valid YAML, with the parser's `detail` appended when there is
 * one to show.
 */
function invalidYaml(file: string, detail: string | undefined): DeployError {
  const suffix = detail === undefined ? '' : `: ${detail}`;
  return new DeployError({ message: `${file} is not valid YAML${suffix}` });
}

/**
 * The failure for a file whose contents do not match its schema, prefixed with the path.
 */
function invalidConfiguration(file: string, detail: string): DeployError {
  return new DeployError({ message: `${file}: ${detail}` });
}

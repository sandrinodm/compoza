import { Context, Effect, FileSystem, Path, Schema } from 'effect';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Document, isMap } from 'yaml';

import { DeployError, platformFailure } from '../errors.ts';
import { fileExists, parseConfigDocument, readConfigFile } from './config-file.ts';

/**
 * The user settings file, beside the global hosts file.
 */
export const DEFAULT_SETTINGS_PATH = join(homedir(), '.config', 'compoza', 'config.yaml');

/**
 * The settings file a run reads and `compoza config` writes; tests point it at a scratch file.
 */
export const SettingsFile = Context.Reference<string>('compoza/SettingsFile', {
  defaultValue: () => DEFAULT_SETTINGS_PATH,
});

/**
 * The user's own defaults, which apply to every app on this machine. Nothing in it is secret: the
 * 1Password account is a name or UUID, and authentication stays in the desktop app.
 */
export const Settings = Schema.Struct({
  /**
   * 1Password defaults.
   */
  '1password': Schema.optionalKey(
    Schema.Struct({
      /**
       * The desktop account used when `COMPOZA_1PASSWORD_ACCOUNT` is unset.
       */
      account: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),

  /**
   * Host discovery defaults.
   */
  hosts: Schema.optionalKey(
    Schema.Struct({
      /**
       * Extra hosts files, or folders holding a `hosts.yaml`, read alongside the global hosts file.
       */
      links: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    }),
  ),
});

/**
 * A decoded settings file.
 */
export type Settings = typeof Settings.Type;

/**
 * Where a setting lives in the settings file.
 */
export type SettingPath = ReadonlyArray<string>;

/**
 * Where `compoza hosts link` keeps the linked hosts files.
 */
export const HOST_LINKS_SETTING: SettingPath = ['hosts', 'links'];

/**
 * The settings `compoza config` reads and writes, by the dotted key it takes.
 */
export const SETTING_KEYS = {
  /**
   * The 1Password desktop account used when `COMPOZA_1PASSWORD_ACCOUNT` is unset.
   */
  '1password.account': ['1password', 'account'],
} as const satisfies Record<string, SettingPath>;

/**
 * A key `compoza config` accepts.
 */
export type SettingKey = keyof typeof SETTING_KEYS;

/**
 * The text that replaces the parser's detail for a settings file that is not valid YAML when it is
 * about to be edited.
 */
const INVALID_SETTINGS_YAML = 'is not valid YAML; fix or remove it before changing settings';

/**
 * Reads the settings file, or returns no settings when it does not exist. Fails with a
 * `DeployError` naming the file when it is not valid YAML or has unknown or invalid fields.
 */
export const loadSettings = Effect.fn('loadSettings')(function* (): Effect.fn.Return<
  Settings,
  DeployError,
  FileSystem.FileSystem
> {
  const file = yield* SettingsFile;
  if (!(yield* fileExists(file))) {
    return {};
  }

  return yield* readConfigFile(file, Settings, `No settings file at ${file}.`);
});

/**
 * Applies `edit` to the settings file and writes it back, keeping its comments and creating the
 * file and its folder when they are missing. The edited document is validated first, so an edit
 * that would leave an invalid file fails with a `DeployError` and writes nothing.
 *
 * Returns the path of the settings file.
 */
export const editSettings = Effect.fn('editSettings')(function* (
  edit: (document: Document) => void,
): Effect.fn.Return<string, DeployError, FileSystem.FileSystem | Path.Path> {
  const file = yield* SettingsFile;
  const document = yield* readSettingsDocument(file);
  edit(document);
  yield* Schema.decodeUnknownEffect(Settings, { onExcessProperty: 'error' })(document.toJS()).pipe(
    Effect.mapError((error) => new DeployError({ message: `${file}: ${error.message}` })),
  );

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .makeDirectory(path.dirname(file), { recursive: true })
    .pipe(Effect.mapError(platformFailure(`Creating ${path.dirname(file)}`)));
  yield* fs
    .writeFileString(file, document.toString())
    .pipe(Effect.mapError(platformFailure(`Writing ${file}`)));
  return file;
});

/**
 * The value of a `compoza config` key, or `undefined` when it is not set.
 */
export function settingValue(settings: Settings, key: SettingKey): string | undefined {
  let value: unknown = settings;

  for (const part of SETTING_KEYS[key]) {
    value = isRecord(value) ? value[part] : undefined;
  }

  return typeof value === 'string' ? value : undefined;
}

/**
 * Removes the setting at `path`, then any map above it that the removal left empty, so unsetting
 * the last 1Password setting removes the `1password` key too.
 */
export function deleteSetting(document: Document, path: SettingPath): void {
  document.deleteIn(path);

  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = document.getIn(path.slice(0, depth));
    if (!isMap(parent) || parent.items.length > 0) {
      return;
    }

    document.deleteIn(path.slice(0, depth));
  }
}

/**
 * The settings file as an editable document: an empty map when the file is missing or empty.
 */
const readSettingsDocument = Effect.fn('readSettingsDocument')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = (yield* fileExists(file))
    ? yield* fs.readFileString(file).pipe(Effect.mapError(platformFailure(`Reading ${file}`)))
    : '';
  const document = yield* Effect.try({
    try: () => parseConfigDocument(text),
    catch: () => new DeployError({ message: `${file} ${INVALID_SETTINGS_YAML}` }),
  });

  if (document.contents === null) {
    document.contents = document.createNode({});
  }

  return document;
});

/**
 * Whether `value` is an object whose properties can be read by name.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

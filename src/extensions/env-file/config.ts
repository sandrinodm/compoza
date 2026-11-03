import { Schema } from 'effect';

/**
 * The client dotenv source settings; relative paths resolve against the deployment directory.
 */
export const EnvFileSettings = Schema.Struct({
  /**
   * The client path, relative to the deploy folder or expanded from `~/`.
   */
  path: Schema.NonEmptyString,
});

/**
 * The named dotenv file source configuration.
 */
export const EnvFileSelection = Schema.Struct({
  /**
   * The selected credential extension's settings, without authentication material.
   */
  'env-file': EnvFileSettings,
});

/**
 * A dotenv file source as credential providers receive it, tagged with `provider: 'env-file'`.
 */
export type EnvFileConfig = { readonly provider: 'env-file' } & typeof EnvFileSettings.Type;

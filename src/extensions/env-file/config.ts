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
 * The legacy flat dotenv file source and normalized provider input.
 */
export const EnvFileConfig = Schema.Struct({
  /**
   * The legacy credential provider selector.
   */
  provider: Schema.Literal('env-file'),
  ...EnvFileSettings.fields,
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

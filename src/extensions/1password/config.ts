import { Schema } from 'effect';

/**
 * The structured 1Password Environment selection; operator authentication never belongs in app
 * configuration.
 */
export const OnePasswordSettings = Schema.Struct({
  /**
   * The Environment identifier, without authentication material.
   */
  environmentId: Schema.NonEmptyString,

  /**
   * Exact variable names to import. Omission imports all; an empty list imports none.
   */
  variables: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
  ),
});

/**
 * The legacy flat 1Password Environment source and normalized provider input.
 */
export const OnePasswordConfig = Schema.Struct({
  /**
   * The legacy credential provider selector.
   */
  provider: Schema.Literal('1password'),
  ...OnePasswordSettings.fields,
});

/**
 * The named 1Password Environment source configuration.
 */
export const OnePasswordSelection = Schema.Struct({
  /**
   * The selected credential extension's settings, without authentication material.
   */
  '1password': OnePasswordSettings,
});

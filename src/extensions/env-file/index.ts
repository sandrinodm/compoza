import { Effect, FileSystem, Path } from 'effect';

import type { CredentialProvider } from '../credentials.ts';

import { parseEnvFile } from '../../config/env-file.ts';
import { expandHome } from '../../config/hosts.ts';
import { DeployError } from '../../errors.ts';

/**
 * The bundled dotenv credential provider with literal parsing and private file diagnostics.
 */
export const envFileProvider: CredentialProvider = {
  /**
   * Selected by `secrets: { env-file: { path } }`.
   */
  id: 'env-file',

  /**
   * None: a local file needs no operator credentials.
   */
  authEnvironmentPrefixes: [],

  /**
   * Reads the dotenv file at the source's path (with `~/` expanded, relative to the deployment
   * folder) and parses it literally. Fails with a `DeployError` that never names the file's
   * contents when it cannot be read or a line is invalid.
   */
  read: Effect.fn('envFileProvider.read')(function* (source, directory) {
    if (source.provider !== 'env-file') {
      return yield* new DeployError({ message: 'Invalid env-file source selection' });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.resolve(directory, expandHome(source.path));
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError(
          () => new DeployError({ message: 'Cannot read configured secret env file' }),
        ),
      );
    return yield* parseEnvFile(text);
  }),
};

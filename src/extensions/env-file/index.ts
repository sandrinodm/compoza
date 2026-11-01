import { Effect, FileSystem, Path } from 'effect';

import type { CredentialProvider } from '../credentials.ts';

import { parseEnvFile } from '../../config/env-file.ts';
import { expandHome } from '../../config/hosts.ts';
import { DeployError } from '../../errors.ts';

/**
 * The bundled dotenv credential provider with literal parsing and private file diagnostics.
 */
export const envFileProvider: CredentialProvider = {
  id: 'env-file',
  authEnvironmentPrefixes: [],
  read: Effect.fn('envFileProvider.read')(function* (source, directory) {
    if (source.provider !== 'env-file') {
      return yield* new DeployError({ message: 'Invalid env-file source selection' });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.resolve(directory, expandHome(source.path));
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => new DeployError({ message: 'Cannot read configured secret env file' })));
    return yield* parseEnvFile(text);
  }),
};

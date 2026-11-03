import { Effect } from 'effect';

import type { IngressOperation } from './extensions/ingress.ts';

import { readSecrets } from './config/secrets.ts';
import { DeployError } from './errors.ts';

/**
 * Characters that would let a credential value break out of its `NAME=value` line.
 */
const LINE_BREAK_OR_NUL_PATTERN = /[\r\n\0]/;

/**
 * The characters a connector token is made of: base64 and base64url, with padding.
 */
const CONNECTOR_TOKEN_PATTERN = /^[A-Za-z0-9+/=_-]+$/;

/**
 * Builds the stdin payload of an ingress setup operation. Without a credential source it is the
 * operation's own input; with one, the source is read and each variable the operation selects is
 * added to the payload as a `credentials` field of `NAME=value` lines, ending in a newline.
 *
 * The caller handles `--dry-run` first, so a preview never reads a credential. The values travel
 * only over the `Remote` stdin, never in the plan or the script, and the setup script is
 * responsible for consuming them privately and keeping third-party diagnostics quiet. A selected
 * value that is empty or is not a connector token fails without echoing the value.
 */
export const setupOperationInput = Effect.fn('setupOperationInput')(function* (
  operation: IngressOperation,
) {
  if (operation.secrets === undefined) {
    return operation.input;
  }

  // `readSecrets` reads an app's source; setup has no app, so a minimal one carrying only the
  // operation's source stands in, with relative paths resolved against the working directory.
  const values = yield* readSecrets({
    dir: process.cwd(),
    config: {
      name: 'ingress-setup',
      host: 'setup',
      targets: [],
      composeFiles: ['compose.yaml'],
      secrets: operation.secrets,
    },
  });

  const credentials: Array<string> = [];
  for (const [target, source] of Object.entries(operation.secretVariables ?? {})) {
    const value = values[source];
    if (!value || LINE_BREAK_OR_NUL_PATTERN.test(value) || !CONNECTOR_TOKEN_PATTERN.test(value)) {
      return yield* new DeployError({
        message: `Ingress credential ${source} must contain only a connector token`,
      });
    }

    credentials.push(`${target}=${value}`);
  }

  return JSON.stringify({
    ...JSON.parse(operation.input ?? '{}'),
    credentials: credentials.join('\n') + '\n',
  });
});

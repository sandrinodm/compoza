import { Effect } from 'effect';

import type { IngressOperation } from './extensions/ingress.ts';

import { readSecrets } from './config/secrets.ts';
import { DeployError } from './errors.ts';

/**
 * Resolves setup-only credentials after dry-run handling and sends selected values exclusively over Remote stdin.
 *
 * Ingress plans remain nonsecret. Setup scripts must consume credentials privately and suppress third-party
 * diagnostics.
 */
export const setupOperationInput = Effect.fn('setupOperationInput')(function* (operation: IngressOperation) {
  if (operation.secrets === undefined) {
    return operation.input;
  }

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

  const credentials: string[] = [];

  for (const [target, source] of Object.entries(operation.secretVariables ?? {})) {
    const value = values[source];
    if (!value || /[\r\n\0]/.test(value) || !/^[A-Za-z0-9+/=_-]+$/.test(value)) {
      return yield* new DeployError({ message: `Ingress credential ${source} must contain only a connector token` });
    }

    credentials.push(`${target}=${value}`);
  }

  return JSON.stringify({
    ...JSON.parse(operation.input ?? '{}'),
    credentials: credentials.join('\n') + '\n',
  });
});

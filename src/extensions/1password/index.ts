import { Context, Effect } from 'effect';

import type { CredentialProvider } from '../credentials.ts';

import { DeployError } from '../../errors.ts';

/**
 * A structured Environment entry returned by the official SDK, including display-only masking metadata.
 *
 * The SDK's `EnvironmentVariable` types and official read-environment-variables guide expose the actual `value`;
 * `masked` controls display. Neither values nor third-party exceptions are logged here.
 */
export interface EnvironmentVariable {
  /**
   * The variable's exact environment name.
   */
  readonly name: string;

  /**
   * The resolved plaintext value used only for Compose.
   */
  readonly value: string;

  /**
   * The display masking metadata, independent of import eligibility.
   */
  readonly masked: boolean;
}

/**
 * The narrow official SDK contract verified against version 0.5.0's shipped declarations.
 *
 * A structural contract avoids a compile-time dependency on an optionally absent package.
 */
interface OnePasswordSdk {
  /**
   * The desktop account selector from the official SDK.
   */
  readonly DesktopAuth: new (account: string) => object;

  /**
   * The official structured Environment client factory.
   */
  readonly createClient: (options: {
    auth: string | object;
    integrationName: string;
    integrationVersion: string;
  }) => Promise<{
    /**
     * The structured Environment read API.
     */
    environments: {
      /**
       * The complete Environment variable response.
       */
      getVariables: (id: string) => Promise<{ variables: ReadonlyArray<EnvironmentVariable> }>;
    };
  }>;
}

/**
 * Reads an Environment using the optional official SDK on the CLI machine.
 *
 * Dynamic import keeps dotenv and dry runs usable without optional dependencies. Authentication uses a service token or
 * an explicitly selected desktop account, never an application-configured token or an implicit account.
 */
async function fetchEnvironment(environmentId: string): Promise<ReadonlyArray<EnvironmentVariable>> {
  const packageName = '@1password/sdk';
  const sdk = (await import(packageName)) as OnePasswordSdk;
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const account = process.env.COMPOZA_1PASSWORD_ACCOUNT;
  if (!token && !account) {
    throw new Error('Missing operator authentication');
  }
  const client = await sdk.createClient({
    auth: token || new sdk.DesktopAuth(account!),
    integrationName: 'compoza',
    integrationVersion: '1.0.0',
  });
  return (await client.environments.getVariables(environmentId)).variables;
}

/**
 * The replaceable SDK boundary used by isolated tests without a real account or vault.
 *
 * Production uses the official SDK lazily; providers cannot run shell commands or expose exception details.
 */
export const OnePasswordReader = Context.Reference<typeof fetchEnvironment>('compoza/OnePasswordReader', {
  defaultValue: () => fetchEnvironment,
});

/**
 * The bundled 1Password credential provider; SDK authentication stays on the operator machine.
 */
export const onePasswordProvider: CredentialProvider = {
  id: '1password',
  authEnvironmentPrefixes: ['OP_', 'COMPOZA_1PASSWORD_'],
  read: Effect.fn('onePasswordProvider.read')(function* (source) {
    if (source.provider !== '1password') {
      return yield* new DeployError({ message: 'Invalid 1Password source selection' });
    }
    const reader = yield* OnePasswordReader;
    const variables = yield* Effect.tryPromise({
      try: () => reader(source.environmentId),
      catch: () =>
        new DeployError({
          message:
            '1Password Environment access failed; verify optional @1password/sdk installation, operator authentication and Environment access privately',
        }),
    });
    if (!Array.isArray(variables)) {
      return yield* new DeployError({ message: 'Invalid 1Password Environment response' });
    }
    const values: Record<string, string> = Object.create(null);
    for (const [index, variable] of variables.entries()) {
      if (
        typeof variable?.name !== 'string' ||
        typeof variable.value !== 'string' ||
        typeof variable.masked !== 'boolean' ||
        Object.hasOwn(values, variable.name)
      ) {
        return yield* new DeployError({ message: `Invalid or duplicate 1Password variable at entry ${index + 1}` });
      }
      values[variable.name] = variable.value;
    }
    return values;
  }),
};

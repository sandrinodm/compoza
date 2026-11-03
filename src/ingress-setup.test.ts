import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import { OnePasswordReader } from './extensions/1password/index.ts';
import { setupOperationInput } from './ingress-setup.ts';

const operation = { label: 'setup', script: 'true', input: '{"compose":"safe"}' };

describe('setupOperationInput', () => {
  it.effect('preserves input without reading a credential source', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* setupOperationInput(operation), operation.input);
      assert.isUndefined(yield* setupOperationInput({ label: 'empty', script: 'true' }));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([undefined, {}, { FIRST: 'FIRST_TOKEN', SECOND: 'SECOND_TOKEN' }])(
    'serializes selected credentials with the existing trailing newline: %s',
    (secretVariables) =>
      Effect.gen(function* () {
        const input = yield* setupOperationInput({
          ...operation,
          secrets: { '1password': { environmentId: 'fixture' } },
          ...(secretVariables === undefined ? {} : { secretVariables }),
        }).pipe(
          Effect.provideService(OnePasswordReader, async () => [
            { name: 'FIRST_TOKEN', value: 'first-token', masked: true },
            { name: 'SECOND_TOKEN', value: 'second-token', masked: true },
            { name: 'UNUSED_TOKEN', value: 'discarded-token', masked: true },
          ]),
        );
        assert.deepStrictEqual(JSON.parse(input!), {
          compose: 'safe',
          credentials:
            secretVariables && 'FIRST' in secretVariables
              ? 'FIRST=first-token\nSECOND=second-token\n'
              : '\n',
        });
        assert.notInclude(input!, 'discarded-token');
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    '',
    'installation command',
    'private-token!',
    'private-token\n',
    'private-token\r',
    'private-token\0',
  ])('rejects invalid connector tokens privately: %s', (value) =>
    Effect.gen(function* () {
      const error = yield* setupOperationInput({
        ...operation,
        secrets: { '1password': { environmentId: 'fixture' } },
        secretVariables: { TUNNEL_TOKEN: 'PROVIDER_TOKEN' },
      }).pipe(
        Effect.provideService(OnePasswordReader, async () => [
          { name: 'PROVIDER_TOKEN', value, masked: true },
        ]),
        Effect.flip,
      );
      assert.match(
        error.message,
        /must contain only a connector token|Unsupported multiline or NUL secret value/,
      );

      if (value !== '') {
        assert.notInclude(error.message, value);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

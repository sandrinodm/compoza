import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import { tryPlan } from './errors.ts';

describe('tryPlan', () => {
  it.effect('returns the planned value', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* tryPlan(() => 'planned', 'unused'), 'planned');
    }),
  );

  it.effect('turns a thrown error into a DeployError with the same message', () =>
    Effect.gen(function* () {
      const error = yield* tryPlan(() => {
        throw new Error('Unknown ingress extension: other');
      }, 'fallback').pipe(Effect.flip);
      assert.strictEqual(error._tag, 'DeployError');
      assert.strictEqual(error.message, 'Unknown ingress extension: other');
    }),
  );

  it.effect('uses the fallback message when the thrown value is not an Error', () =>
    Effect.gen(function* () {
      const error = yield* tryPlan(() => {
        throw 'not an error';
      }, 'Invalid deployment plan').pipe(Effect.flip);
      assert.strictEqual(error.message, 'Invalid deployment plan');
    }),
  );
});

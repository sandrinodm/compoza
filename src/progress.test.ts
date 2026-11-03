import { assert, describe, it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Logger } from 'effect';
import { TestClock, TestConsole } from 'effect/testing';

import {
  formatDuration,
  formatLogLine,
  humanLogger,
  phase,
  phaseLine,
  runPhases,
} from './progress.ts';

describe('formatDuration', () => {
  it('prints tenths under a minute and minutes from a minute on', () => {
    assert.strictEqual(formatDuration(0), '0.0 s');
    assert.strictEqual(formatDuration(-5), '0.0 s');
    assert.strictEqual(formatDuration(1_849), '1.8 s');
    assert.strictEqual(formatDuration(12_460), '12.5 s');
    assert.strictEqual(formatDuration(59_940), '59.9 s');
    assert.strictEqual(formatDuration(59_960), '1 min');
    assert.strictEqual(formatDuration(84_200), '1 min 24 s');
    assert.strictEqual(formatDuration(180_000), '3 min');
  });
});

describe('phaseLine', () => {
  it('numbers the phase against the total', () => {
    assert.strictEqual(phaseLine(2, 6, 'Creating host folders'), '[2/6] Creating host folders …');
  });
});

describe('runPhases', () => {
  it.effect('prints start and finish lines with the outcome and yields the total duration', () =>
    Effect.gen(function* () {
      let status = 0;
      const total = yield* runPhases([
        phase('checks', 'Checking readiness on atlas', TestClock.adjust(1_800)),
        phase(
          'wait',
          'Waiting for https://demo.example.com/',
          Effect.as(TestClock.adjust(12_500), 200),
          (code) => {
            status = code;
            return `HTTP ${code}`;
          },
        ),
      ]);

      assert.strictEqual(status, 200);
      assert.strictEqual(total, 14_300);
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        '[1/2] Checking readiness on atlas …',
        '[1/2] Checking readiness on atlas … ok (1.8 s)',
        '[2/2] Waiting for https://demo.example.com/ …',
        '[2/2] Waiting for https://demo.example.com/ … HTTP 200 (12.5 s)',
      ]);
    }).pipe(Effect.provide(TestConsole.layer)),
  );

  it.effect(
    'prints the failure, skips the remaining phases and propagates the error unchanged',
    () =>
      Effect.gen(function* () {
        const exit = yield* runPhases([
          phase(
            'build',
            'Building and shipping 2 images',
            Effect.andThen(TestClock.adjust(2_300), Effect.fail('boom')),
          ),
          phase('compose', 'Starting the stack with Compose', Effect.void),
        ]).pipe(Effect.exit);
        assert.deepStrictEqual(exit, Exit.fail('boom'));
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          '[1/2] Building and shipping 2 images …',
          '[1/2] Building and shipping 2 images … failed (2.3 s)',
        ]);
      }).pipe(Effect.provide(TestConsole.layer)),
  );

  it.effect('prints an interrupted phase as such', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runPhases([phase('wait', 'Waiting for https://demo.example.com/', Effect.never)]),
      );
      yield* TestClock.adjust(4_000);
      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(yield* TestConsole.logLines, [
        '[1/1] Waiting for https://demo.example.com/ …',
        '[1/1] Waiting for https://demo.example.com/ … interrupted (4.0 s)',
      ]);
    }).pipe(Effect.provide(TestConsole.layer)),
  );

  it.effect('prints nothing for an empty run', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* runPhases<never, never>([]), 0);
      assert.deepStrictEqual(yield* TestConsole.logLines, []);
    }).pipe(Effect.provide(TestConsole.layer)),
  );
});

describe('formatLogLine', () => {
  it('prints the level and indents continuation lines', () => {
    assert.strictEqual(
      formatLogLine('Debug', ['script:\nset -eu\ntrue'], Cause.empty),
      '[debug] script:\n  set -eu\n  true',
    );
    assert.strictEqual(formatLogLine('Info', ['tag', 1], Cause.empty), '[info] tag 1');
  });

  it.effect('writes to standard error, filtered by the minimum level', () =>
    Effect.gen(function* () {
      yield* Effect.logDebug('hidden at the default level');
      yield* Effect.logInfo('shown');

      assert.deepStrictEqual(yield* TestConsole.errorLines, ['[info] shown']);
      assert.deepStrictEqual(yield* TestConsole.logLines, []);
    }).pipe(Effect.provide([Logger.layer([humanLogger]), TestConsole.layer])),
  );
});

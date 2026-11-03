import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Sink, Stream } from 'effect';
import { type ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestConsole } from 'effect/testing';

import type { HostConfig } from '../config/hosts.ts';

import { Remote, scriptLabel } from './Remote.ts';
import { DryRun } from './Shell.ts';

const host: HostConfig = {
  ssh: 'deploy@atlas.example.com',
  address: '192.0.2.42',
  platform: 'linux/arm64',
  transport: { mode: 'ssh-load' },
};

/**
 * A `Remote` over a spawner that runs nothing: every spawn is recorded in `spawned` and answers
 * `ok=yes`.
 */
function fakeRemote(spawned: Array<ChildProcess.Command>): Layer.Layer<Remote> {
  const spawner = ChildProcessSpawner.make((command) => {
    spawned.push(command);

    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode('ok=yes\n')),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  return Remote.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );
}

describe('Remote', () => {
  it.effect('prints and skips run under DryRun', () => {
    const spawned: Array<ChildProcess.Command> = [];
    return Effect.gen(function* () {
      const remote = yield* Remote;
      const output = yield* remote.run(host, "mkdir -p '/srv/a'");
      assert.strictEqual(output, '');
      assert.lengthOf(spawned, 0);
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "$ ssh deploy@atlas.example.com mkdir -p '/srv/a'",
      ]);
    }).pipe(
      Effect.provideService(DryRun, true),
      Effect.provide(Layer.merge(fakeRemote(spawned), TestConsole.layer)),
    );
  });

  it.effect('prints the label, then runs', () => {
    const spawned: Array<ChildProcess.Command> = [];
    return Effect.gen(function* () {
      const remote = yield* Remote;
      const output = yield* remote.run(host, 'set -eu\ntrue', { input: 'input', label: '<do it>' });
      assert.strictEqual(output, 'ok=yes\n');
      assert.lengthOf(spawned, 1);
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        '$ ssh deploy@atlas.example.com <do it>',
      ]);
    }).pipe(Effect.provide(Layer.merge(fakeRemote(spawned), TestConsole.layer)));
  });

  it.effect('streams run output without retaining a captured copy', () => {
    const spawned: Array<ChildProcess.Command> = [];
    return Effect.gen(function* () {
      const remote = yield* Remote;
      const output = yield* remote.run(host, 'echo ok=yes', { label: '<stream>', stream: true });
      assert.strictEqual(output, '');
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        '$ ssh deploy@atlas.example.com <stream>',
        'ok=yes',
      ]);
    }).pipe(Effect.provide(Layer.merge(fakeRemote(spawned), TestConsole.layer)));
  });

  it.effect('probes silently even under DryRun', () => {
    const spawned: Array<ChildProcess.Command> = [];
    return Effect.gen(function* () {
      const remote = yield* Remote;
      const output = yield* remote.probe(host, 'echo ok=yes');
      assert.strictEqual(output, 'ok=yes\n');
      assert.lengthOf(spawned, 1);
      assert.deepStrictEqual(yield* TestConsole.logLines, []);
    }).pipe(
      Effect.provideService(DryRun, true),
      Effect.provide(Layer.merge(fakeRemote(spawned), TestConsole.layer)),
    );
  });
});

describe('scriptLabel', () => {
  it('prints one-line scripts whole and marks longer ones', () => {
    assert.strictEqual(scriptLabel("mkdir -p '/a'"), "mkdir -p '/a'");
    assert.strictEqual(scriptLabel('\nset -eu\ncd /srv\n'), 'set -eu …');
  });
});

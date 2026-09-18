import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoCardlessDropinLifecycle,
  GOCARDLESS_DROPIN_LOAD_TIMEOUT_MS,
  scheduleGoCardlessDropinLoadTimeout,
} from './goCardlessDropinLifecycle.js';

test('StrictMode cleanup replay exits the old handler and permits one fresh open', () => {
  const lifecycle = createGoCardlessDropinLifecycle();
  let exits = 0;
  let opens = 0;
  const exit = () => { exits += 1; };

  lifecycle.activate();
  lifecycle.dispose(exit);
  lifecycle.activate();
  assert.equal(lifecycle.open(() => { opens += 1; }, exit), true);
  assert.equal(lifecycle.open(() => { opens += 1; }, exit), false);
  assert.equal(opens, 1);

  lifecycle.dispose(exit);
  assert.equal(exits, 1, 'the same handler exit function is idempotent');
});

test('programmatic cleanup suppresses SDK onExit and terminal callbacks are unique', () => {
  const calls = [];
  let lifecycle;
  const exit = () => lifecycle.userExit(new Error('programmatic'), { source: 'sdk' });
  lifecycle = createGoCardlessDropinLifecycle({
    onSuccess: () => calls.push('success'),
    onExit: () => calls.push('exit'),
  });

  lifecycle.dispose(exit);
  lifecycle.succeed({}, {});
  lifecycle.userExit(null, {});
  assert.deepEqual(calls, []);
});

test('success is delivered immediately once and unmount removes the SDK receipt', () => {
  const calls = [];
  let exits = 0;
  let lifecycle;
  lifecycle = createGoCardlessDropinLifecycle({
    onSuccess: (request, flow) => calls.push([request.id, flow.id]),
    onExit: () => calls.push('exit'),
  });

  assert.equal(lifecycle.succeed({ id: 'BR1' }, { id: 'BRF1' }), true);
  assert.deepEqual(calls, [['BR1', 'BRF1']]);
  assert.equal(exits, 0, 'success alone leaves the SDK receipt for the caller');
  assert.equal(lifecycle.succeed({}, {}), false);
  assert.equal(lifecycle.userExit(null, {}), false);
  lifecycle.dispose(() => {
    exits += 1;
    lifecycle.userExit(null, { source: 'programmatic-cleanup' });
  });
  assert.equal(exits, 1);
  assert.deepEqual(calls, [['BR1', 'BRF1']], 'success-triggered unmount suppresses SDK onExit');
});

test('latest callbacks are used without recreating the SDK lifecycle', () => {
  const calls = [];
  const lifecycle = createGoCardlessDropinLifecycle({
    onExit: () => calls.push('stale'),
  });
  lifecycle.updateCallbacks({
    onExit: (error, metadata) => calls.push([error, metadata.reason]),
  });

  lifecycle.userExit(undefined, { reason: 'payer-close' });
  assert.deepEqual(calls, [[null, 'payer-close']]);
});

test('failed open exits before fallback and suppresses synchronous exit callback', () => {
  const calls = [];
  let lifecycle;
  const failure = new Error('open failed');
  const exit = () => {
    calls.push('handler-exit');
    lifecycle.userExit(null, {});
  };
  lifecycle = createGoCardlessDropinLifecycle({
    onExit: () => calls.push('payer-exit'),
    onLoadFailure: error => calls.push(error),
  });

  assert.equal(lifecycle.open(() => { throw failure; }, exit), false);
  assert.deepEqual(calls, ['handler-exit', failure]);
  lifecycle.dispose(exit);
  assert.deepEqual(calls, ['handler-exit', failure]);
});

test('never-ready timeout uses the current handler, clears normally, and fires once', () => {
  const failures = [];
  const timers = new Map();
  let nextTimer = 0;
  let exits = 0;
  const lifecycle = createGoCardlessDropinLifecycle({
    onLoadFailure: error => failures.push(error.message),
  });
  const clear = scheduleGoCardlessDropinLoadTimeout(
    lifecycle,
    () => () => { exits += 1; },
    (callback, delay) => {
      assert.equal(delay, GOCARDLESS_DROPIN_LOAD_TIMEOUT_MS);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    timer => timers.delete(timer),
  );

  timers.get(1)();
  timers.get(1)();
  assert.equal(exits, 1);
  assert.deepEqual(failures, ['GoCardless Drop-in did not load in time']);
  clear();
  assert.equal(timers.size, 0);
});

test('load timeout becomes inert as soon as the handler opens', () => {
  const failures = [];
  const lifecycle = createGoCardlessDropinLifecycle({
    onLoadFailure: error => failures.push(error),
  });

  assert.equal(lifecycle.open(() => {}, () => {}), true);
  assert.equal(lifecycle.timeout(() => {}), false);
  assert.deepEqual(failures, []);
});
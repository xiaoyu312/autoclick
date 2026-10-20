'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AbsoluteScheduler } = require('../src/shared/scheduler');

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeoutFn: (callback, delay) => {
      const timerId = ++id;
      timers.set(timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeoutFn: (timerId) => timers.delete(timerId),
    advance: (milliseconds) => {
      now += milliseconds;
      let ran = true;
      while (ran) {
        ran = false;
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length > 0) {
          const [timerId, timer] = due[0];
          timers.delete(timerId);
          timer.callback();
          ran = true;
        }
      }
    }
  };
}

test('absolute scheduler fires on each exact due point without drift', () => {
  const clock = fakeClock();
  const ticks = [];
  const scheduler = new AbsoluteScheduler({
    intervalMs: 1000,
    onTick: (tick) => ticks.push(tick),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });

  scheduler.start(0);
  clock.advance(1000);
  clock.advance(1000);
  clock.advance(1000);

  assert.deepEqual(ticks.map((tick) => tick.index), [1, 2, 3]);
  assert.deepEqual(ticks.map((tick) => tick.scheduledAt), [1000, 2000, 3000]);
  assert.deepEqual(ticks.map((tick) => tick.skipped), [0, 0, 0]);
});

test('late timer skips missed points instead of catching up', () => {
  const clock = fakeClock();
  const ticks = [];
  const scheduler = new AbsoluteScheduler({
    intervalMs: 1000,
    onTick: (tick) => ticks.push(tick),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });

  scheduler.start(0);
  clock.advance(2500);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].index, 1);
  assert.equal(ticks[0].scheduledAt, 1000);
  assert.equal(ticks[0].skipped, 1);
  assert.equal(scheduler.getState().nextDueAt, 3000);

  clock.advance(500);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[1].index, 3);
  assert.equal(ticks[1].scheduledAt, 3000);
});

test('in-flight async work causes the due tick to be skipped without overlap', async () => {
  const clock = fakeClock();
  const ticks = [];
  let resolveFirst;
  const firstDone = new Promise((resolve) => { resolveFirst = resolve; });
  const scheduler = new AbsoluteScheduler({
    intervalMs: 1000,
    onTick: (tick) => {
      ticks.push(tick);
      if (tick.index === 1) return firstDone;
      return undefined;
    },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });

  scheduler.start(0);
  clock.advance(1000);
  assert.equal(scheduler.getState().inFlight, true);
  clock.advance(1000);
  assert.deepEqual(ticks.map((tick) => tick.index), [1]);
  resolveFirst();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduler.getState().inFlight, false);
  clock.advance(1000);
  assert.deepEqual(ticks.map((tick) => tick.index), [1, 3]);
});

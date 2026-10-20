'use strict';

class AbsoluteScheduler {
  constructor({ intervalMs, onTick, now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      throw new RangeError('intervalMs must be at least 1000 milliseconds');
    }
    if (typeof onTick !== 'function') {
      throw new TypeError('onTick must be a function');
    }

    this.intervalMs = intervalMs;
    this.onTick = onTick;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timer = null;
    this.running = false;
    this.startedAt = null;
    this.nextDueAt = null;
    this.nextIndex = 1;
    this.inFlight = false;
  }

  start(startedAt = this.now()) {
    this.stop();
    this.running = true;
    this.startedAt = startedAt;
    this.nextIndex = 1;
    this.nextDueAt = startedAt + this.intervalMs;
    this.schedule();
    return this.getState();
  }

  stop() {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.startedAt = null;
    this.nextDueAt = null;
    this.nextIndex = 1;
    this.inFlight = false;
  }

  schedule() {
    if (!this.running || this.nextDueAt === null) return;
    const delay = Math.max(0, this.nextDueAt - this.now());
    this.timer = this.setTimeoutFn(() => this.handleTimer(), delay);
  }

  handleTimer() {
    this.timer = null;
    if (!this.running || this.nextDueAt === null || this.startedAt === null) return;

    const actualAt = this.now();
    if (actualAt < this.nextDueAt) {
      this.schedule();
      return;
    }

    const scheduledAt = this.nextDueAt;
    const index = this.nextIndex;
    const expectedNextIndex = Math.floor((actualAt - this.startedAt) / this.intervalMs) + 1;
    const skipped = Math.max(0, expectedNextIndex - (index + 1));

    // Advance the absolute timeline before invoking user work. A slow callback
    // therefore cannot move the next due time or cause missed ticks to replay.
    this.nextIndex = Math.max(index + 1, expectedNextIndex);
    this.nextDueAt = this.startedAt + this.nextIndex * this.intervalMs;
    this.schedule();

    if (this.inFlight) return;

    this.inFlight = true;
    try {
      const result = this.onTick({ scheduledAt, actualAt, index, skipped });
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {}).finally(() => {
          this.inFlight = false;
        });
      } else {
        this.inFlight = false;
      }
    } catch (_) {
      // The scheduler remains alive; the owner records callback failures.
      this.inFlight = false;
    }
  }

  getState() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      nextDueAt: this.nextDueAt,
      nextIndex: this.nextIndex,
      intervalMs: this.intervalMs,
      inFlight: this.inFlight
    };
  }
}

module.exports = { AbsoluteScheduler };

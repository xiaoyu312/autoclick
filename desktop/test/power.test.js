'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerBlockerController } = require('../src/shared/power');

test('power blocker is acquired once and released on stop', () => {
  const started = [];
  const stopped = [];
  const controller = new PowerBlockerController({
    start: (reason) => { started.push(reason); return 17; },
    stop: (id) => stopped.push(id)
  });
  controller.acquire();
  controller.acquire();
  assert.deepEqual(started, ['prevent-app-suspension']);
  assert.equal(controller.held, true);
  assert.equal(controller.release(), true);
  assert.deepEqual(stopped, [17]);
  assert.equal(controller.release(), false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateHttpUrl,
  validateIntervalSeconds,
  validateBrowserCommand,
  isTrustedSender
} = require('../src/shared/validation');
const { canMarkTargetReady, shouldPauseForNavigation } = require('../src/shared/readiness');
const { isSafeSmokeUserDataPath, defaultUserDataCandidates } = require('../src/shared/smoke-path');
const { classifyNavigationFailure, navigationWatchdogAction } = require('../src/shared/navigation');
const {
  createTargetWindowReadiness,
  updateTargetWindowReadiness,
  classifyTargetRedirect,
  shouldPromoteTargetChild,
  findRecoverableTargetAncestor
} = require('../src/shared/target-window');

test('IPC URL and interval validation accepts MVP inputs and rejects unsafe values', () => {
  assert.equal(validateHttpUrl('https://example.test/path'), 'https://example.test/path');
  assert.throws(() => validateHttpUrl('file:///tmp/secret'), /http or https/);
  assert.throws(() => validateHttpUrl('https://user:pass@example.test'), /credentials/);
  assert.equal(validateIntervalSeconds('8'), 8);
  assert.throws(() => validateIntervalSeconds(0), /from 1/);
  assert.throws(() => validateIntervalSeconds(1.5), /integer/);
});

test('browser command validation requires a known type and descriptor for execute', () => {
  assert.deepEqual(validateBrowserCommand({ type: 'start-selection' }), { type: 'start-selection' });
  assert.deepEqual(validateBrowserCommand({ type: 'cancel-execute', requestId: 'click-1' }), { type: 'cancel-execute', requestId: 'click-1' });
  assert.throws(() => validateBrowserCommand({ type: 'cancel-execute' }), /requestId/);
  assert.throws(() => validateBrowserCommand({ type: 'execute' }), /descriptor/);
  assert.throws(() => validateBrowserCommand({ type: 'run-shell' }), /type/);
});

test('IPC sender must be the expected webContents object', () => {
  const sender = {};
  assert.equal(isTrustedSender({ sender }, sender), true);
  assert.equal(isTrustedSender({ sender: {} }, sender), false);
  assert.equal(isTrustedSender(null, sender), false);
});

test('target readiness requires both finished main-frame load and browser preload', () => {
  assert.equal(canMarkTargetReady({ targetFinishedLoad: true, browserPreloadReady: true }), true);
  assert.equal(canMarkTargetReady({ targetFinishedLoad: true, browserPreloadReady: false }), false);
  assert.equal(canMarkTargetReady({ targetFinishedLoad: false, browserPreloadReady: true }), false);
  assert.equal(shouldPauseForNavigation({ isMainFrame: true, isInPlace: false }), true);
  assert.equal(shouldPauseForNavigation({ isMainFrame: true, isInPlace: true }), false);
  assert.equal(shouldPauseForNavigation({ isMainFrame: false, isInPlace: false }), false);
});

test('smoke userData must be an existing child of the OS temp directory', () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tempRoot = fs.realpathSync(os.tmpdir());
  const safe = fs.mkdtempSync(path.join(tempRoot, 'autoclick-test-'));
  try {
    assert.equal(isSafeSmokeUserDataPath(safe, tempRoot), true);
    assert.equal(isSafeSmokeUserDataPath(tempRoot, tempRoot), false);
    assert.equal(isSafeSmokeUserDataPath('/not-an-existing-temp-path', tempRoot), false);
    assert.equal(defaultUserDataCandidates('darwin', '/synthetic-home/test', {}).length, 3);
  } finally {
    fs.rmSync(safe, { recursive: true, force: true });
  }
});

test('navigation failure classification distinguishes subframes, aborted pending, and stale aborted loads', () => {
  assert.equal(classifyNavigationFailure({ errorCode: -2, isMainFrame: false }), 'subframe-failed');
  assert.equal(classifyNavigationFailure({ errorCode: -3, isMainFrame: true, pendingUrl: 'https://new.test', validatedURL: 'https://old.test' }), 'stale-aborted');
  assert.equal(classifyNavigationFailure({ errorCode: -3, isMainFrame: true, pendingUrl: 'https://same.test', validatedURL: 'https://same.test' }), 'aborted-pending');
  assert.equal(classifyNavigationFailure({ errorCode: -2, isMainFrame: true, pendingUrl: 'https://same.test', validatedURL: 'https://same.test' }), 'main-failed');
});

test('navigation watchdog clears stopped pending loads and only recovers active runs', () => {
  assert.equal(navigationWatchdogAction({ desiredRunning: false, targetNavigationInFlight: true, pendingGeneration: 4, generation: 4 }), 'clear-pending');
  assert.equal(navigationWatchdogAction({ desiredRunning: true, targetNavigationInFlight: true, pendingGeneration: 4, generation: 4 }), 'recover');
  assert.equal(navigationWatchdogAction({ desiredRunning: true, targetNavigationInFlight: false, pendingGeneration: 4, generation: 4 }), 'ignore');
  assert.equal(navigationWatchdogAction({ desiredRunning: true, targetNavigationInFlight: true, pendingGeneration: 3, generation: 4 }), 'ignore');
});

test('managed window readiness snapshots stay independent and require both load and preload', () => {
  const initial = createTargetWindowReadiness();
  const loading = updateTargetWindowReadiness(initial, { type: 'did-start-navigation', isMainFrame: true, url: 'https://child.test' });
  const loadedOnly = updateTargetWindowReadiness(loading, { type: 'did-finish-load', isMainFrame: true });
  assert.equal(loadedOnly.targetReady, false);
  const ready = updateTargetWindowReadiness(loadedOnly, { type: 'browser-ready', isMainFrame: true });
  assert.equal(ready.targetReady, true);
  const failed = updateTargetWindowReadiness(ready, { type: 'did-fail-load', isMainFrame: true });
  assert.deepEqual(failed, createTargetWindowReadiness({ navigationFailed: true }));
  assert.equal(failed.navigationFailed, true);
  assert.equal(updateTargetWindowReadiness(failed, { type: 'browser-ready', isMainFrame: true }).targetReady, false);
  const retried = updateTargetWindowReadiness(failed, { type: 'did-start-navigation', isMainFrame: true, url: 'https://retry.test' });
  const retriedLoaded = updateTargetWindowReadiness(retried, { type: 'did-finish-load', isMainFrame: true });
  assert.equal(updateTargetWindowReadiness(retriedLoaded, { type: 'browser-ready', isMainFrame: true }).targetReady, true);
  const stale = updateTargetWindowReadiness(loading, { type: 'did-fail-stale', isMainFrame: true });
  assert.deepEqual(stale, loading);
  const aborted = updateTargetWindowReadiness(loading, { type: 'did-fail-aborted', isMainFrame: true, pendingUrl: 'https://child.test' });
  assert.equal(aborted.targetReady, false);
  assert.equal(aborted.navigationInFlight, true);
  assert.equal(aborted.pendingUrl, 'https://child.test');
  assert.equal(aborted.navigationFailed, false);
  const abortedLoaded = updateTargetWindowReadiness(aborted, { type: 'did-finish-load', isMainFrame: true });
  assert.equal(updateTargetWindowReadiness(abortedLoaded, { type: 'browser-ready', isMainFrame: true }).targetReady, true);
  assert.equal(updateTargetWindowReadiness(ready, { type: 'did-start-navigation', isMainFrame: false, url: 'https://frame.test' }).targetReady, true);
  assert.equal(updateTargetWindowReadiness(ready, { type: 'render-process-gone', isMainFrame: false }).targetReady, true);
});

test('managed target redirect and child promotion decisions keep unsafe or blank pages pending', () => {
  assert.equal(classifyTargetRedirect({ url: 'https://example.test/next', isMainFrame: true }), 'allow-http');
  assert.equal(classifyTargetRedirect({ url: 'file:///tmp/nope', isMainFrame: true }), 'block-non-http');
  assert.equal(classifyTargetRedirect({ url: 'https://example.test/frame', isMainFrame: false }), 'ignore-subframe');
  assert.equal(shouldPromoteTargetChild({ pending: true, urlIsHttp: false, targetReady: true, targetFinishedLoad: true, browserPreloadReady: true }), false);
  assert.equal(shouldPromoteTargetChild({ pending: true, urlIsHttp: true, targetReady: false, targetFinishedLoad: true, browserPreloadReady: true }), false);
  assert.equal(shouldPromoteTargetChild({ pending: true, urlIsHttp: true, targetReady: true, targetFinishedLoad: true, browserPreloadReady: true }), true);
});

test('nested child close skips pending, destroyed, and non-HTTP ancestors', () => {
  const parent = { name: 'parent' };
  const blank = { name: 'blank' };
  const grandchild = { name: 'grandchild' };
  const openers = new Map([[grandchild, blank], [blank, parent]]);
  const pending = new Set([blank]);
  const result = findRecoverableTargetAncestor(grandchild, {
    getOpener: (window) => openers.get(window) || null,
    isDestroyed: () => false,
    isPending: (window) => pending.has(window),
    isHttp: (window) => window === parent
  });
  assert.equal(result, parent);
  assert.equal(findRecoverableTargetAncestor(grandchild, {
    getOpener: (window) => openers.get(window) || null,
    isDestroyed: (window) => window === parent,
    isPending: (window) => pending.has(window),
    isHttp: () => true
  }), null);
  assert.equal(findRecoverableTargetAncestor(grandchild, {
    getOpener: (window) => openers.get(window) || null,
    isDestroyed: () => false,
    isPending: (window) => pending.has(window),
    isHttp: () => false
  }), null);
});

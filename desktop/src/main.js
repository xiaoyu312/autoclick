'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  nativeImage,
  powerSaveBlocker,
  powerMonitor,
  session
} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AbsoluteScheduler } = require('./shared/scheduler');
const {
  DEFAULT_INTERVAL_SECONDS,
  validateHttpUrl,
  validateIntervalSeconds,
  validateDescriptor,
  validateBrowserCommand,
  isTrustedSender
} = require('./shared/validation');
const {
  exportRunLogs,
  createLogEntry
} = require('./shared/logs');
const { PowerBlockerController } = require('./shared/power');
const { canMarkTargetReady, shouldPauseForNavigation } = require('./shared/readiness');
const { isSafeSmokeUserDataPath } = require('./shared/smoke-path');
const { classifyNavigationFailure, navigationWatchdogAction } = require('./shared/navigation');
const {
  createTargetWindowReadiness,
  updateTargetWindowReadiness,
  classifyTargetRedirect,
  shouldPromoteTargetChild,
  findRecoverableTargetAncestor
} = require('./shared/target-window');
const { boundedPageIdentity } = require('./shared/target');

const APP_STATE_CHANNEL = 'app:state';
const TARGET_PARTITION = 'persist:autoclick-target';
const RECOVERY_DELAYS_MS = [2000, 5000, 10000, 30000];
const MAX_LOG_ENTRIES = 2000;
const CLICK_RESPONSE_TIMEOUT_MS = 15000;
const NAVIGATION_WATCHDOG_MS = 30000;

let controlWindow = null;
let targetWindow = null;
let tray = null;
let scheduler = null;
let recoveryTimer = null;
let recoveryAttempt = 0;
let recoveryDueAt = null;
let targetReady = false;
let targetNavigationInFlight = false;
let targetFinishedLoad = false;
let browserPreloadReady = false;
let suspended = false;
let quitting = false;
let userDataPath = null;
let stateFilePath = null;
let logsFilePath = null;
let logs = [];
let clickRequestCounter = 0;
let clickInFlight = null;
let smokeCompletionScheduled = false;
let navigationGeneration = 0;
let pendingNavigation = null;
let navigationWatchdog = null;
const targetWindowOpeners = new WeakMap();
const targetWindowAncestorOpeners = new WeakMap();
const targetWindowReadiness = new WeakMap();
const pendingTargetWindows = new WeakSet();

const state = {
  url: '',
  descriptor: null,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  desiredRunning: false,
  actualRunning: false,
  recovering: false,
  clickCount: 0,
  lastClickAt: null,
  lastAttemptAt: null,
  nextClickAt: null,
  lastResult: 'idle',
  lastError: null,
  recoveryDueAt: null
};

const powerController = new PowerBlockerController({
  start: (reason) => powerSaveBlocker.start(reason),
  stop: (id) => powerSaveBlocker.stop(id)
});

function configureSmokeUserData() {
  if (process.env.AUTOCLICK_SMOKE !== '1') return true;
  const candidate = process.env.AUTOCLICK_SMOKE_USER_DATA;
  if (!isSafeSmokeUserDataPath(candidate, os.tmpdir())) {
    console.error('[AutoClick Smoke] AUTOCLICK_SMOKE_USER_DATA must be an existing absolute temp child directory');
    app.exit(2);
    return false;
  }
  app.setPath('userData', candidate);
  return true;
}

const smokeUserDataConfigured = configureSmokeUserData();
const hasSingleInstanceLock = smokeUserDataConfigured && app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.show();
      controlWindow.focus();
    }
  });
}

function cloneState() {
  return { ...state, descriptor: state.descriptor ? JSON.parse(JSON.stringify(state.descriptor)) : null };
}

function sendState() {
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send(APP_STATE_CHANNEL, cloneState());
}

function persistState() {
  if (!stateFilePath) return;
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('[AutoClick Desktop] state persistence failed', error);
  }
}

function loadState() {
  if (!stateFilePath) return;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(state)) {
        if (saved[key] !== undefined) state[key] = saved[key];
      }
    }
  } catch (_) {
    // A missing or corrupt state file is equivalent to a fresh install.
  }
  // A previous process cannot safely resume a click task before the page has
  // been loaded and observed in this process. Keep the user's descriptor but
  // require an explicit start in the new session.
  state.desiredRunning = false;
  state.actualRunning = false;
  state.recovering = false;
  state.nextClickAt = null;
  state.recoveryDueAt = null;
  persistState();
}

function loadLogs() {
  if (!logsFilePath) return;
  try {
    const loaded = JSON.parse(fs.readFileSync(logsFilePath, 'utf8'));
    if (Array.isArray(loaded)) logs = loaded.slice(-MAX_LOG_ENTRIES);
  } catch (_) {
    logs = [];
  }
}

function log(level, category, message, data = null) {
  const entry = createLogEntry(level, category, message, data);
  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(-MAX_LOG_ENTRIES);
  if (logsFilePath) {
    try {
      fs.writeFileSync(logsFilePath, JSON.stringify(logs, null, 2), 'utf8');
    } catch (error) {
      console.error('[AutoClick Desktop] log persistence failed', error);
    }
  }
  if (level === 'error') console.error('[AutoClick Desktop]', category, message, data || '');
  else if (level === 'warn') console.warn('[AutoClick Desktop]', category, message, data || '');
  else console.log('[AutoClick Desktop]', category, message, data || '');
  sendState();
}

function descriptorLocatorDiagnostics(descriptor) {
  const locator = descriptor?.container?.productRowLocator;
  const strategy = typeof locator?.strategy === 'string' ? locator.strategy : 'none';
  const controlled = strategy === 'controlled-product-name-toggle'
    || (strategy === 'product-name-row' && JSON.stringify(locator?.toggleLabels) === JSON.stringify(['讲解', '取消讲解']));
  return {
    boundedMode: controlled ? 'controlled-toggle' : strategy === 'product-name-row' ? 'product-row' : strategy === 'unavailable' ? 'unavailable' : 'generic',
    locatorStrategy: strategy
  };
}

function isHttpUrl(value) {
  try {
    validateHttpUrl(value);
    return true;
  } catch (_) {
    return false;
  }
}

function sendBrowserCommandToWindow(window, command) {
  if (!window || window.isDestroyed()) return false;
  try {
    validateBrowserCommand(command);
    window.webContents.send('autoclick:browser-command', command);
    return true;
  } catch (error) {
    log('error', 'ipc', 'Browser command rejected', { message: error.message });
    return false;
  }
}

function browserCommand(command) {
  if (!targetWindow || targetWindow.isDestroyed() || !targetReady) return false;
  return sendBrowserCommandToWindow(targetWindow, command);
}

function clearRecoveryTimer() {
  if (recoveryTimer !== null) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  recoveryDueAt = null;
  state.recoveryDueAt = null;
}

function clearNavigationWatchdog() {
  if (navigationWatchdog !== null) {
    clearTimeout(navigationWatchdog);
    navigationWatchdog = null;
  }
}

function armNavigationWatchdog(generation, url) {
  clearNavigationWatchdog();
  navigationWatchdog = setTimeout(() => {
    navigationWatchdog = null;
    const action = navigationWatchdogAction({
      desiredRunning: state.desiredRunning,
      targetNavigationInFlight,
      pendingGeneration: pendingNavigation?.generation,
      generation
    });
    if (action === 'ignore') return;
    pendingNavigation = null;
    targetNavigationInFlight = false;
    targetFinishedLoad = false;
    browserPreloadReady = false;
    targetReady = false;
    if (action === 'clear-pending') {
      log('warn', 'browser', 'Target navigation watchdog cleared a stopped navigation', { generation, url });
      return;
    }
    scheduleRecovery('target navigation did not finish', { generation, url });
  }, NAVIGATION_WATCHDOG_MS);
}

function cancelClickRequest(reason = 'cancelled') {
  if (!clickInFlight) return;
  const request = clickInFlight;
  clickInFlight = null;
  clearTimeout(request.timer);
  sendBrowserCommandToWindow(request.targetWindow, { type: 'cancel-execute', requestId: request.requestId });
  request.resolve({ success: false, reason });
}

function stopScheduler() {
  if (scheduler) scheduler.stop();
  scheduler = null;
  cancelClickRequest('scheduler stopped');
  state.actualRunning = false;
  state.nextClickAt = null;
}

function executeBrowserClick() {
  if (clickInFlight) return Promise.resolve({ success: false, reason: 'in-flight' });
  const requestId = `click-${Date.now()}-${++clickRequestCounter}`;
  const executionWindow = targetWindow;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!clickInFlight || clickInFlight.requestId !== requestId) return;
      const request = clickInFlight;
      clickInFlight = null;
      sendBrowserCommandToWindow(request.targetWindow, { type: 'cancel-execute', requestId });
      state.lastResult = 'timeout';
      state.lastError = 'target browser did not respond';
      log('error', 'click', 'Target click response timed out', { requestId });
      persistState();
      sendState();
      resolve({ success: false, reason: 'timeout' });
    }, CLICK_RESPONSE_TIMEOUT_MS);
    clickInFlight = { requestId, timer, resolve, targetWindow: executionWindow };
    if (!browserCommand({ type: 'execute', requestId, descriptor: state.descriptor })) {
      clearTimeout(timer);
      clickInFlight = null;
      resolve({ success: false, reason: 'target-not-ready' });
    }
  });
}

function markTargetReady(source) {
  const wasReady = targetReady;
  targetReady = true;
  rememberTargetReadiness(targetWindow);
  log('info', 'browser', `Target browser ready (${source})`);
  if (state.desiredRunning && (!wasReady || !scheduler || !scheduler.getState().running)) {
    startSchedulerFromFuture();
  }
}

function tryMarkTargetReady(source) {
  if (!canMarkTargetReady({ targetFinishedLoad, browserPreloadReady })) return false;
  markTargetReady(source);
  return true;
}

function startSchedulerFromFuture() {
  if (!state.desiredRunning || !targetReady || suspended || !state.descriptor) return false;
  if (scheduler && scheduler.getState().running && state.actualRunning && !state.recovering) {
    state.nextClickAt = scheduler.getState().nextDueAt;
    sendState();
    return true;
  }
  stopScheduler();
  scheduler = new AbsoluteScheduler({
    intervalMs: state.intervalSeconds * 1000,
    onTick: async ({ scheduledAt, actualAt, skipped }) => {
      if (!state.desiredRunning || state.recovering || suspended || !targetReady) return;
      state.lastAttemptAt = actualAt;
      state.nextClickAt = scheduler?.getState().nextDueAt || null;
      if (skipped > 0) log('warn', 'schedule', 'Skipped late tick without catch-up', { skipped, scheduledAt, actualAt });
      persistState();
      sendState();
      return executeBrowserClick();
    }
  });
  scheduler.start(Date.now());
  state.actualRunning = true;
  state.recovering = false;
  state.nextClickAt = scheduler.getState().nextDueAt;
  state.recoveryDueAt = null;
  recoveryAttempt = 0;
  clearRecoveryTimer();
  persistState();
  sendState();
  log('success', 'schedule', 'Scheduler resumed on a future absolute tick', { nextClickAt: state.nextClickAt });
  return true;
}

function scheduleRecovery(reason, details = null) {
  if (!state.desiredRunning || quitting) return;
  clearNavigationWatchdog();
  stopScheduler();
  state.recovering = true;
  state.lastResult = 'recovering';
  state.lastError = reason;
  const delay = RECOVERY_DELAYS_MS[Math.min(recoveryAttempt, RECOVERY_DELAYS_MS.length - 1)];
  recoveryAttempt += 1;
  clearRecoveryTimer();
  recoveryDueAt = Date.now() + delay;
  state.recoveryDueAt = recoveryDueAt;
  persistState();
  log('error', 'recovery', 'Target runtime paused; recovery scheduled', { reason, delay, attempt: recoveryAttempt, details });
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    recoveryDueAt = null;
    state.recoveryDueAt = null;
    if (!state.desiredRunning || quitting) return;
    try {
      if (!targetWindow || targetWindow.isDestroyed()) {
        createTargetWindow();
        if (state.url) targetWindow.loadURL(state.url).catch((error) => scheduleRecovery('target reload failed', { message: error.message }));
      } else {
        targetReady = false;
        targetWindow.reload();
      }
    } catch (error) {
      scheduleRecovery('target recovery attempt failed', { message: error.message });
    }
  }, delay);
}

function setDesiredRunning(desired) {
  state.desiredRunning = desired;
  if (desired) {
    powerController.acquire();
    if (targetReady) startSchedulerFromFuture();
    else if (targetNavigationInFlight || targetWindow?.webContents?.isLoadingMainFrame?.()) {
      state.recovering = true;
      state.lastResult = 'loading';
      persistState();
      sendState();
    } else scheduleRecovery('waiting for target browser');
  } else {
    clearRecoveryTimer();
    stopScheduler();
    state.recovering = false;
    state.lastResult = 'stopped';
    state.lastError = null;
    powerController.release();
  }
  persistState();
  sendState();
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 520,
    height: 780,
    minWidth: 460,
    minHeight: 640,
    title: 'AutoClick Desktop',
    backgroundColor: '#11161b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  controlWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  controlWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      controlWindow.hide();
    }
  });
  controlWindow.on('closed', () => { controlWindow = null; });
}

function targetWebPreferences() {
  return {
    preload: path.join(__dirname, 'browser-preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    backgroundThrottling: false,
    partition: TARGET_PARTITION
  };
}

function rememberTargetReadiness(window) {
  if (!window || window.isDestroyed()) return;
  const previous = targetWindowReadiness.get(window);
  targetWindowReadiness.set(window, createTargetWindowReadiness({
    targetReady,
    targetFinishedLoad,
    browserPreloadReady,
    navigationInFlight: targetNavigationInFlight,
    navigationFailed: previous?.navigationFailed === true,
    pendingUrl: pendingNavigation?.url || null
  }));
}

function getTargetReadiness(window) {
  if (!window) return createTargetWindowReadiness();
  let snapshot = targetWindowReadiness.get(window);
  if (!snapshot) {
    snapshot = createTargetWindowReadiness();
    targetWindowReadiness.set(window, snapshot);
  }
  return snapshot;
}

function applyTargetReadinessEvent(window, event) {
  const snapshot = updateTargetWindowReadiness(getTargetReadiness(window), event);
  targetWindowReadiness.set(window, snapshot);
  if (targetWindow === window) {
    targetReady = snapshot.targetReady;
    targetFinishedLoad = snapshot.targetFinishedLoad;
    browserPreloadReady = snapshot.browserPreloadReady;
    targetNavigationInFlight = snapshot.navigationInFlight;
    if (snapshot.pendingUrl) pendingNavigation = { generation: navigationGeneration, url: snapshot.pendingUrl };
    else pendingNavigation = null;
  }
  return snapshot;
}

function resetTargetRuntimeState(readiness = null) {
  clearNavigationWatchdog();
  clearRecoveryTimer();
  pendingNavigation = null;
  targetNavigationInFlight = false;
  targetFinishedLoad = readiness?.targetFinishedLoad === true;
  browserPreloadReady = readiness?.browserPreloadReady === true;
  targetReady = readiness?.targetReady === true;
  if (targetWindow) {
    targetWindowReadiness.set(targetWindow, createTargetWindowReadiness({
      targetReady,
      targetFinishedLoad,
      browserPreloadReady,
      navigationInFlight: false,
      navigationFailed: readiness?.navigationFailed === true,
      pendingUrl: null
    }));
  }
  stopScheduler();
  state.recovering = state.desiredRunning && !targetReady;
  state.lastResult = state.desiredRunning && !targetReady ? 'loading' : state.lastResult;
  state.nextClickAt = null;
  persistState();
  sendState();
}

function activateTargetWindow(window, reason) {
  if (!window || window.isDestroyed()) return false;
  if (targetWindow === window) return true;
  cancelClickRequest('target window changed');
  rememberTargetReadiness(targetWindow);
  targetWindow = window;
  resetTargetRuntimeState(targetWindowReadiness.get(window) || null);
  log('info', 'browser', 'Active target window changed', { reason });
  if (targetReady && state.desiredRunning) startSchedulerFromFuture();
  return true;
}

function maybePromoteTargetWindow(window) {
  if (!pendingTargetWindows.has(window) || window.isDestroyed()) return false;
  const snapshot = getTargetReadiness(window);
  const promoted = shouldPromoteTargetChild({
    pending: true,
    urlIsHttp: isHttpUrl(window.webContents.getURL()),
    targetReady: snapshot.targetReady,
    targetFinishedLoad: snapshot.targetFinishedLoad,
    browserPreloadReady: snapshot.browserPreloadReady
  });
  if (!promoted) return false;
  pendingTargetWindows.delete(window);
  activateTargetWindow(window, 'HTTP(S) child navigation');
  return true;
}

function getTargetWindowOpener(window) {
  return targetWindowOpeners.get(window) || targetWindowAncestorOpeners.get(window) || null;
}

function findRecoverableTargetWindow(window) {
  return findRecoverableTargetAncestor(window, {
    getOpener: getTargetWindowOpener,
    isDestroyed: (candidate) => candidate.isDestroyed(),
    isPending: (candidate) => pendingTargetWindows.has(candidate),
    isHttp: (candidate) => !candidate.isDestroyed() && isHttpUrl(candidate.webContents.getURL())
  });
}

function attachTargetWindow(window) {
  window.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    // Same-document/hash navigation has no matching finish-load event; keep
    // the current healthy scheduler instead of pausing it permanently.
    if (!shouldPauseForNavigation({ isMainFrame, isInPlace })) return;
    applyTargetReadinessEvent(window, { type: 'did-start-navigation', isMainFrame, url });
    if (targetWindow !== window) return;
    const generation = ++navigationGeneration;
    pendingNavigation = { generation, url };
    targetNavigationInFlight = true;
    targetFinishedLoad = false;
    browserPreloadReady = false;
    targetReady = false;
    stopScheduler();
    rememberTargetReadiness(window);
    state.recovering = state.desiredRunning;
    state.lastResult = state.desiredRunning ? 'loading' : state.lastResult;
    state.nextClickAt = null;
    persistState();
    sendState();
    log('info', 'browser', 'Main-frame navigation started; click execution paused', { url });
    armNavigationWatchdog(generation, url);
  });
  window.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    const decision = classifyTargetRedirect({ url, isMainFrame });
    if (decision === 'ignore-subframe') return;
    if (decision === 'block-non-http') {
      event.preventDefault();
      applyTargetReadinessEvent(window, { type: 'redirect-blocked', isMainFrame: true });
      log('error', 'security', 'Blocked non-HTTP(S) redirect', { url });
      if (targetWindow !== window) return;
      clearNavigationWatchdog();
      stopScheduler();
      state.recovering = state.desiredRunning;
      state.lastResult = state.desiredRunning ? 'recovering' : state.lastResult;
      state.nextClickAt = null;
      persistState();
      sendState();
      if (state.desiredRunning) scheduleRecovery('target redirect blocked', { url });
      return;
    }
    applyTargetReadinessEvent(window, { type: 'will-redirect', isMainFrame: true, url });
    if (targetWindow !== window) return;
    stopScheduler();
    state.recovering = state.desiredRunning;
    state.lastResult = state.desiredRunning ? 'loading' : state.lastResult;
    state.nextClickAt = null;
    persistState();
    sendState();
    log('info', 'browser', 'HTTP(S) redirect started; click execution paused', { url });
  });
  window.webContents.on('did-finish-load', () => {
    const loadedUrl = window.webContents.getURL();
    const readinessBeforeLoad = getTargetReadiness(window);
    const temporaryBlank = targetWindowOpeners.has(window) && (loadedUrl === 'about:blank' || loadedUrl === '');
    if (readinessBeforeLoad.navigationFailed === true) {
      applyTargetReadinessEvent(window, { type: 'did-fail-load', isMainFrame: true, preserveNavigation: true });
      log('warn', 'browser', 'Ignored finish-load after a failed main-frame navigation until a new navigation starts', { loadedUrl, pendingUrl: readinessBeforeLoad.pendingUrl });
      return;
    }
    if (readinessBeforeLoad.navigationInFlight
      && readinessBeforeLoad.pendingUrl
      && !temporaryBlank
      && loadedUrl !== readinessBeforeLoad.pendingUrl) {
      applyTargetReadinessEvent(window, { type: 'did-fail-stale', isMainFrame: true });
      log('warn', 'browser', 'Ignored stale finish-load from a superseded main-frame navigation', { loadedUrl, pendingUrl: readinessBeforeLoad.pendingUrl });
      return;
    }
    const snapshot = applyTargetReadinessEvent(window, { type: 'did-finish-load', isMainFrame: true, url: loadedUrl, temporaryBlank });
    if (targetWindow !== window) {
      maybePromoteTargetWindow(window);
      return;
    }
    if (temporaryBlank) {
      rememberTargetReadiness(window);
      log('info', 'browser', 'Temporary about:blank child is waiting for HTTP(S) navigation');
      return;
    }
    clearNavigationWatchdog();
    pendingNavigation = snapshot.pendingUrl ? { generation: navigationGeneration, url: snapshot.pendingUrl } : null;
    targetNavigationInFlight = snapshot.navigationInFlight;
    targetFinishedLoad = snapshot.targetFinishedLoad;
    browserPreloadReady = snapshot.browserPreloadReady;
    targetReady = snapshot.targetReady;
    rememberTargetReadiness(window);
    tryMarkTargetReady('did-finish-load');
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const readiness = getTargetReadiness(window);
    const failureType = classifyNavigationFailure({
      errorCode,
      isMainFrame,
      pendingUrl: readiness.pendingUrl,
      validatedURL
    });
    if (failureType === 'subframe-failed') {
      applyTargetReadinessEvent(window, { type: 'did-fail-load', isMainFrame: false });
      log('warn', 'browser', 'Ignored non-main-frame navigation failure', { errorCode, validatedURL, failureType });
      return;
    }
    if (failureType === 'stale-aborted') {
      applyTargetReadinessEvent(window, { type: 'did-fail-stale', isMainFrame: true });
      log('warn', 'browser', 'Ignored stale main-frame navigation failure while newer navigation remains pending', { errorCode, validatedURL, failureType });
      return;
    }
    if (failureType === 'aborted-pending') {
      applyTargetReadinessEvent(window, { type: 'did-fail-aborted', isMainFrame: true, pendingUrl: validatedURL });
      if (targetWindow === window) rememberTargetReadiness(window);
      log('warn', 'browser', 'Navigation was aborted; waiting for finish-load or watchdog recovery', { errorCode, validatedURL });
      return;
    }
    applyTargetReadinessEvent(window, { type: 'did-fail-load', isMainFrame: true, preserveNavigation: readiness.navigationInFlight === true });
    if (targetWindow !== window) return;
    clearNavigationWatchdog();
    rememberTargetReadiness(window);
    log('error', 'browser', 'Target page failed to load', { errorCode, errorDescription, validatedURL });
    if (state.desiredRunning) scheduleRecovery('target page load failure', { errorCode, errorDescription });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    applyTargetReadinessEvent(window, { type: 'render-process-gone', isMainFrame: true });
    if (targetWindow !== window) return;
    clearNavigationWatchdog();
    rememberTargetReadiness(window);
    log('error', 'browser', 'Target renderer exited', details);
    if (state.desiredRunning) scheduleRecovery('target renderer crash', details);
  });
  window.webContents.on('unresponsive', () => {
    if (targetWindow === window) log('warn', 'browser', 'Target renderer became unresponsive');
  });
  window.webContents.on('responsive', () => {
    if (targetWindow === window) log('info', 'browser', 'Target renderer recovered responsiveness');
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isHttpUrl(url)) return;
    event.preventDefault();
    log('error', 'security', 'Blocked non-HTTP(S) navigation', { url });
    if (targetWindow !== window) return;
    cancelClickRequest('target navigation blocked');
    const readyBeforeNavigation = targetReady;
    clearNavigationWatchdog();
    pendingNavigation = null;
    targetNavigationInFlight = false;
    targetReady = readyBeforeNavigation;
    targetFinishedLoad = readyBeforeNavigation;
    browserPreloadReady = readyBeforeNavigation;
    rememberTargetReadiness(window);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url) || url === 'about:blank') {
      log('info', 'browser', 'Allowed managed target child window', { url });
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'AutoClick Target Browser',
          show: true,
          webPreferences: targetWebPreferences()
        }
      };
    }
    log('error', 'security', 'Blocked non-HTTP(S) popup', { url });
    return { action: 'deny' };
  });
  window.webContents.on('did-create-window', (childWindow, details) => {
    targetWindowOpeners.set(childWindow, window);
    targetWindowAncestorOpeners.set(childWindow, window);
    pendingTargetWindows.add(childWindow);
    targetWindowReadiness.set(childWindow, createTargetWindowReadiness());
    childWindow.webContents.backgroundThrottling = false;
    attachTargetWindow(childWindow);
    if (!childWindow.isDestroyed()) childWindow.show();
    log('info', 'browser', 'Managed target child window pending HTTP(S) promotion', { url: details?.url || '' });
  });
  window.on('close', (event) => {
    if (targetWindowOpeners.has(window)) {
      log('info', 'browser', 'Child target window closing; opener will be restored');
      return;
    }
    if (!quitting) {
      event.preventDefault();
      window.hide();
      log('info', 'browser', 'Target window hidden to tray');
    }
  });
  window.on('closed', () => {
    const wasActive = targetWindow === window;
    const recoveryTarget = wasActive ? findRecoverableTargetWindow(window) : null;
    if (wasActive) cancelClickRequest('target window closed');
    pendingTargetWindows.delete(window);
    targetWindowOpeners.delete(window);
    targetWindowReadiness.delete(window);
    if (!wasActive) return;
    clearNavigationWatchdog();
    pendingNavigation = null;
    targetWindow = null;
    targetReady = false;
    targetNavigationInFlight = false;
    targetFinishedLoad = false;
    browserPreloadReady = false;
    if (recoveryTarget && !recoveryTarget.isDestroyed()) {
      activateTargetWindow(recoveryTarget, 'active child window closed; restored HTTP ancestor');
      if (state.desiredRunning && !targetReady) scheduleRecovery('active child window closed');
    } else if (state.desiredRunning) {
      scheduleRecovery('target window closed unexpectedly');
    }
  });
}

function createTargetWindow() {
  if (targetWindow && !targetWindow.isDestroyed()) return targetWindow;
  const primaryWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'AutoClick Target Browser',
    show: false,
    webPreferences: targetWebPreferences()
  });
  activateTargetWindow(primaryWindow, 'primary target window');
  attachTargetWindow(primaryWindow);
  return primaryWindow;
}

async function waitForSmokeCondition(predicate, label, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let result = false;
    try { result = await predicate(); } catch (_) {}
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`smoke timeout waiting for ${label}`);
}

async function assertSmokeControlSurface() {
  await waitForSmokeCondition(() => controlWindow && controlWindow.webContents.getURL().startsWith('file:'), 'control page');
  const result = await controlWindow.webContents.executeJavaScript(`(() => {
    const api = window.autoClickDesktop;
    const methods = ['getState', 'getLogs', 'openTarget', 'showTarget', 'selectTarget', 'start', 'stop', 'resetCount', 'exportLogs', 'onState'];
    const domIds = ['targetForm', 'urlInput', 'selectTargetButton', 'intervalInput', 'startButton', 'stopButton', 'clickCount', 'nextClickAt'];
    return { bridge: Boolean(api) && methods.every((name) => typeof api[name] === 'function'), dom: domIds.every((id) => Boolean(document.getElementById(id))) };
  })()`);
  if (!result?.bridge || !result?.dom) throw new Error('control bridge or required DOM surface is missing');
}

async function runSmokeScenario() {
  const smokeUrl = process.env.AUTOCLICK_SMOKE_URL;
  if (!smokeUrl) {
    console.error('[AutoClick Smoke] AUTOCLICK_SMOKE_URL is required');
    app.exit(2);
    return;
  }
  try {
    const url = validateHttpUrl(smokeUrl);
    const parentWindow = createTargetWindow();
    const controlPreferences = controlWindow?.webContents.getLastWebPreferences?.() || null;
    const targetPreferences = parentWindow.webContents.getLastWebPreferences?.() || null;
    const requiredControl = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
    const requiredTarget = { ...requiredControl };
    for (const [key, expected] of Object.entries(requiredControl)) {
      if (!controlPreferences || controlPreferences[key] !== expected) throw new Error(`control webPreference ${key} was not ${expected}`);
    }
    for (const [key, expected] of Object.entries(requiredTarget)) {
      if (!targetPreferences || targetPreferences[key] !== expected) throw new Error(`target webPreference ${key} was not ${expected} (actual=${targetPreferences?.[key]})`);
    }
    if (parentWindow.webContents.backgroundThrottling !== false) throw new Error(`target backgroundThrottling was not false (actual=${parentWindow.webContents.backgroundThrottling})`);
    if (parentWindow.webContents.session !== session.fromPartition('persist:autoclick-target')) throw new Error('target session partition was not persist:autoclick-target');
    log('success', 'smoke', 'Window security preferences verified');
    await assertSmokeControlSurface();
    await controlWindow.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('urlInput');
      input.value = ${JSON.stringify(url)};
      document.getElementById('targetForm').requestSubmit();
      return true;
    })()`);
    await waitForSmokeCondition(() => state.url === url && targetWindow && !targetWindow.isDestroyed(), 'bridge navigation');
    await waitForSmokeCondition(() => targetReady, 'target readiness gates');

    const childWindowsFor = (opener) => BrowserWindow.getAllWindows().filter((window) => targetWindowOpeners.get(window) === opener && !window.isDestroyed());
    const blankOpened = await parentWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('smoke-open-blank')?.click();
      return window.__smokeBlankOpened === true;
    })()`);
    if (!blankOpened) throw new Error('never-navigating about:blank child window was denied');
    await waitForSmokeCondition(() => childWindowsFor(parentWindow).length === 1, 'never-navigating blank child creation');
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (targetWindow !== parentWindow) throw new Error('never-navigating about:blank child replaced the active target');
    const blankWindow = childWindowsFor(parentWindow)[0];
    const grandchildUrl = new URL('/grandchild', url).toString();
    const grandchildOpened = await blankWindow.webContents.executeJavaScript(`(() => {
      const child = window.open(${JSON.stringify(grandchildUrl)}, 'smoke-grandchild');
      window.__smokeGrandchildWindow = child;
      return Boolean(child);
    })()`);
    if (!grandchildOpened) throw new Error('pending about:blank child could not open its HTTP grandchild');
    await waitForSmokeCondition(
      () => targetWindow && targetWindow !== parentWindow && !targetWindow.isDestroyed() && targetWindow.webContents.getURL().endsWith('/grandchild'),
      'HTTP grandchild promotion from pending blank child'
    );
    const grandchildWindow = targetWindow;
    await grandchildWindow.webContents.executeJavaScript('window.close()');
    await waitForSmokeCondition(() => targetWindow === parentWindow && targetReady && childWindowsFor(parentWindow).length === 1, 'HTTP ancestor after grandchild close');
    await blankWindow.webContents.executeJavaScript('window.close(); true');
    await waitForSmokeCondition(() => targetWindow === parentWindow && targetReady && childWindowsFor(parentWindow).length === 0, 'opener after blank child close');

    const directAttempted = await parentWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('smoke-open-direct')?.click();
      return window.__smokeDirectAttempted === true;
    })()`);
    if (!directAttempted) throw new Error('direct HTTP child fixture did not run');
    await waitForSmokeCondition(
      () => targetWindow && targetWindow !== parentWindow && !targetWindow.isDestroyed() && targetWindow.webContents.getURL().endsWith('/direct-child'),
      'direct HTTP child promotion'
    );
    const directChildWindow = targetWindow;
    const directChildPreferences = directChildWindow.webContents.getLastWebPreferences?.() || null;
    for (const [key, expected] of Object.entries(requiredTarget)) {
      if (!directChildPreferences || directChildPreferences[key] !== expected) throw new Error(`direct child webPreference ${key} was not ${expected} (actual=${directChildPreferences?.[key]})`);
    }
    if (directChildWindow.webContents.backgroundThrottling !== false) throw new Error(`direct child backgroundThrottling was not false (actual=${directChildWindow.webContents.backgroundThrottling})`);
    if (directChildWindow.webContents.session !== session.fromPartition(TARGET_PARTITION)) throw new Error('direct child session partition was not persist:autoclick-target');
    await parentWindow.webContents.executeJavaScript('window.__smokeDirectWindow?.close(); true');
    await waitForSmokeCondition(() => targetWindow === parentWindow && targetReady && childWindowsFor(parentWindow).length === 0, 'opener after direct child close');

    const childOpened = await targetWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('smoke-open-child')?.click();
      return window.__smokeChildOpened === true;
    })()`);
    if (!childOpened) throw new Error('renderer-created HTTP child window was denied');
    await waitForSmokeCondition(
      () => targetWindow && targetWindow !== parentWindow && !targetWindow.isDestroyed() && targetWindow.webContents.getURL().endsWith('/child'),
      'HTTP child target window'
    );
    const childWindow = targetWindow;
    const childPreferences = childWindow.webContents.getLastWebPreferences?.() || null;
    for (const [key, expected] of Object.entries(requiredTarget)) {
      if (!childPreferences || childPreferences[key] !== expected) throw new Error(`child webPreference ${key} was not ${expected} (actual=${childPreferences?.[key]})`);
    }
    if (childWindow.webContents.backgroundThrottling !== false) throw new Error(`child backgroundThrottling was not false (actual=${childWindow.webContents.backgroundThrottling})`);
    if (childWindow.webContents.session !== session.fromPartition('persist:autoclick-target')) throw new Error('child session partition was not persist:autoclick-target');
    const dangerousAttempted = await parentWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('smoke-open-danger')?.click();
      return window.__smokeDangerAttempted === true;
    })()`);
    if (!dangerousAttempted) throw new Error('dangerous child-window fixture did not run');
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (targetWindow !== childWindow) throw new Error('non-HTTP child window was not blocked');
    await waitForSmokeCondition(() => targetReady, 'child readiness gates');
    await parentWindow.webContents.executeJavaScript(`(() => {
      window.location.href = '/inactive-opener-fail?smoke=1';
      return true;
    })()`);
    await waitForSmokeCondition(() => {
      const openerReadiness = targetWindowReadiness.get(parentWindow);
      return targetWindow === childWindow
        && openerReadiness
        && openerReadiness.targetReady === false
        && openerReadiness.targetFinishedLoad === false
        && openerReadiness.browserPreloadReady === false;
    }, 'inactive opener unhealthy readiness snapshot');
    await waitForSmokeCondition(
      () => controlWindow.webContents.executeJavaScript('!document.getElementById("selectTargetButton").disabled'),
      'select target button enabled'
    );
    await controlWindow.webContents.executeJavaScript('document.getElementById("selectTargetButton").click()');
    await waitForSmokeCondition(() => targetWindow && !targetWindow.isDestroyed(), 'target selection window');
    await waitForSmokeCondition(
      () => targetWindow.webContents.executeJavaScript('Boolean(document.getElementById("autoclick-selection-overlay"))'),
      'selection mode'
    );
    await targetWindow.webContents.executeJavaScript(`(() => {
      const nested = document.querySelector('.product-row button path');
      if (!nested) throw new Error('nested smoke target missing');
      nested.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`);
    await waitForSmokeCondition(() => state.descriptor?.target?.tagName === 'button'
      && state.descriptor?.target?.text === '讲解'
      && state.descriptor?.container?.productName === 'Smoke Product'
      && !state.descriptor?.container?.productId
      && state.descriptor?.container?.productRowLocator?.strategy === 'controlled-product-name-toggle'
      && JSON.stringify(state.descriptor?.container?.productRowLocator?.toggleLabels) === JSON.stringify(['讲解', '取消讲解']), 'real product-row toggle locator descriptor');
    await waitForSmokeCondition(
      () => controlWindow.webContents.executeJavaScript('!document.getElementById("startButton").disabled'),
      'start button enabled'
    );
    await controlWindow.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('intervalInput');
      input.value = '1';
      document.getElementById('startButton').click();
      return true;
    })()`);
    await waitForSmokeCondition(
      () => controlWindow.webContents.executeJavaScript('document.getElementById("runtimeText").textContent === "运行中" && document.getElementById("intervalInput").disabled === true'),
      'running renderer state'
    );
    log('info', 'smoke', 'Smoke fixture selected through control bridge and nested target click');
  } catch (error) {
    log('error', 'smoke', 'Smoke setup failed', { message: error.message });
    app.exit(1);
  }
}

async function completeSmokeAfterClicks() {
  if (smokeCompletionScheduled) return;
  smokeCompletionScheduled = true;
  try {
    const smokeMetrics = await targetWindow?.webContents.executeJavaScript(`(() => ({
      clicks: window.__smokeClicks || 0,
      replacements: window.__smokeReplacementCount || 0,
      history: window.__smokeToggleHistory || [],
      routeChanges: window.__smokeRouteChangeCount || 0,
      pathname: location.pathname,
      finalState: document.querySelector('.product-row button[data-smoke-target]')?.textContent?.trim() || ''
    }))()`);
    const renderedCountReady = await waitForSmokeCondition(
      () => controlWindow?.webContents.executeJavaScript('document.getElementById("clickCount")?.textContent || ""').then((value) => value === '2'),
      'renderer click count'
    );
    const expectedToggleHistory = [
      { beforeState: '讲解', afterState: '取消讲解' },
      { beforeState: '取消讲解', afterState: '讲解' },
      { beforeState: '讲解', afterState: '取消讲解' }
    ];
    const historyMatches = Array.isArray(smokeMetrics?.history)
      && smokeMetrics.history.length === expectedToggleHistory.length
      && smokeMetrics.history.every((entry, index) => entry.beforeState === expectedToggleHistory[index].beforeState
        && entry.afterState === expectedToggleHistory[index].afterState);
    if (smokeMetrics?.clicks !== 3 || smokeMetrics?.replacements !== 3 || smokeMetrics?.routeChanges !== 1
      || smokeMetrics?.pathname !== '/dashboard/live/interaction' || smokeMetrics?.finalState !== '取消讲解'
      || !historyMatches || renderedCountReady !== true) {
      log('error', 'smoke', 'Fixture toggle execution mismatch', { smokeMetrics });
      quitting = true;
      app.exit(1);
      return;
    }
    const activeChild = targetWindow;
    const opener = activeChild ? targetWindowOpeners.get(activeChild) : null;
    if (opener && !opener.isDestroyed()) {
      const openerReadiness = targetWindowReadiness.get(opener) || null;
      const openerWasUnhealthy = openerReadiness?.targetReady !== true;
      log('info', 'smoke', 'Closing active child from page and checking opener snapshot', { openerReadiness, openerWasUnhealthy });
      await activeChild.webContents.executeJavaScript('window.close()');
      if (openerWasUnhealthy) {
        await waitForSmokeCondition(
          () => targetWindow === opener && !targetReady && state.recovering && Number.isFinite(state.recoveryDueAt),
          'unhealthy opener recovery after child close'
        );
      } else {
        await waitForSmokeCondition(
          () => targetWindow === opener && targetReady && state.actualRunning && Number.isFinite(state.nextClickAt),
          'opener readiness after child close'
        );
      }
    }
    log('success', 'smoke', 'Smoke verified two delegated DOM clicks and exited');
    setTimeout(() => { quitting = true; app.quit(); }, 100);
  } catch (error) {
    log('error', 'smoke', 'Smoke click count read failed', { message: error.message });
    quitting = true;
    app.exit(1);
  }
}

function showTargetWindow() {
  const window = createTargetWindow();
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    log('error', 'system', 'Tray icon could not be loaded', { iconPath });
    throw new Error(`tray icon is empty: ${iconPath}`);
  }
  tray = new Tray(icon);
  tray.setToolTip('AutoClick Desktop');
  tray.on('click', () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.show();
      controlWindow.focus();
    }
  });
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示控制面板', click: () => { if (controlWindow && !controlWindow.isDestroyed()) { controlWindow.show(); controlWindow.focus(); } } },
    { label: '显示目标浏览器', click: showTargetWindow },
    { label: '停止自动点击', enabled: state.desiredRunning, click: () => setDesiredRunning(false) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
}

function assertControlSender(event) {
  if (!isTrustedSender(event, controlWindow?.webContents)) {
    log('error', 'security', 'Rejected IPC from an untrusted control sender');
    throw new Error('untrusted IPC sender');
  }
}

function registerIpc() {
  ipcMain.handle('app:get-state', (event) => {
    assertControlSender(event);
    return cloneState();
  });
  ipcMain.handle('app:get-logs', (event) => {
    assertControlSender(event);
    return logs.slice(-500);
  });
  ipcMain.handle('app:open-target', async (event, value) => {
    assertControlSender(event);
    const url = validateHttpUrl(value);
    const window = createTargetWindow();
    state.url = url;
    state.lastError = null;
    persistState();
    showTargetWindow();
    await window.loadURL(url);
    log('info', 'browser', 'Target navigation started', { url });
    return cloneState();
  });
  ipcMain.handle('app:show-target', (event) => {
    assertControlSender(event);
    showTargetWindow();
    return cloneState();
  });
  ipcMain.handle('app:select-target', (event) => {
    assertControlSender(event);
    setDesiredRunning(false);
    updateTrayMenu();
    showTargetWindow();
    return browserCommand({ type: 'start-selection' });
  });
  ipcMain.handle('app:start', (event, intervalValue) => {
    assertControlSender(event);
    const intervalSeconds = validateIntervalSeconds(intervalValue);
    if (!state.descriptor) throw new Error('select a target before starting');
    state.intervalSeconds = intervalSeconds;
    setDesiredRunning(true);
    updateTrayMenu();
    return cloneState();
  });
  ipcMain.handle('app:stop', (event) => {
    assertControlSender(event);
    setDesiredRunning(false);
    updateTrayMenu();
    return cloneState();
  });
  ipcMain.handle('app:reset-count', (event) => {
    assertControlSender(event);
    state.clickCount = 0;
    state.lastClickAt = null;
    persistState();
    sendState();
    return cloneState();
  });
  ipcMain.handle('app:export-logs', async (event) => {
    assertControlSender(event);
    const result = await exportRunLogs({
      logs,
      exportedAt: new Date(),
      choosePath: (filename) => dialog.showSaveDialog(controlWindow, {
        title: '导出运行日志',
        defaultPath: path.join(app.getPath('documents'), filename),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }),
      writeText: (filePath, text) => fs.writeFileSync(filePath, text, 'utf8')
    });
    if (result.status === 'saved') {
      log('info', 'logs', 'Run logs exported', { filePath: result.filePath, count: result.count });
    }
    return {
      status: result.status,
      count: result.count,
      ...(result.filePath ? { filePath: result.filePath } : {}),
      ...(result.filename ? { filename: result.filename } : {})
    };
  });

  ipcMain.on('autoclick:browser-event', (event, value) => {
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
      log('error', 'ipc', 'Rejected malformed browser event');
      return;
    }
    if (value.type === 'browser-ready') {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || !targetWindowReadiness.has(senderWindow)) {
        log('error', 'security', 'Rejected browser-ready from an unmanaged target sender');
        return;
      }
      const reportedUrl = typeof value.url === 'string' ? value.url : '';
      const currentUrl = senderWindow.webContents.getURL();
      if (reportedUrl && currentUrl && reportedUrl !== currentUrl) {
        log('warn', 'browser', 'Ignored stale browser-ready from a superseded document', { reportedUrl, currentUrl });
        return;
      }
      applyTargetReadinessEvent(senderWindow, { type: 'browser-ready', isMainFrame: true });
      if (senderWindow !== targetWindow) {
        maybePromoteTargetWindow(senderWindow);
        return;
      }
      browserPreloadReady = true;
      rememberTargetReadiness(senderWindow);
      if (!tryMarkTargetReady('browser-preload')) log('info', 'browser', 'Target preload ready; waiting for main-frame finish-load');
      return;
    }
    if (!isTrustedSender(event, targetWindow?.webContents)) {
      log('error', 'security', 'Rejected IPC from an untrusted target sender');
      return;
    }
    if (value.type === 'selection-complete') {
      try {
        validateDescriptor(value.descriptor);
        const selectedUrl = validateHttpUrl(value.url || state.url);
        setDesiredRunning(false);
        state.descriptor = value.descriptor;
        state.url = selectedUrl;
        state.lastResult = 'target-selected';
        state.lastError = null;
        persistState();
        sendState();
        updateTrayMenu();
        log('success', 'selection', 'Target descriptor saved', descriptorLocatorDiagnostics(state.descriptor));
      } catch (error) {
        log('error', 'selection', 'Rejected target descriptor', { message: error.message });
      }
      return;
    }
    if (value.type === 'click-result') {
      if (typeof value.requestId !== 'string' || !clickInFlight || value.requestId !== clickInFlight.requestId) {
        log('warn', 'click', 'Ignored stale or unsolicited click result', { requestId: value.requestId });
        return;
      }
      const request = clickInFlight;
      clickInFlight = null;
      clearTimeout(request.timer);
      if (value.success === true) {
        state.clickCount += 1;
        state.lastClickAt = value.timestamp || Date.now();
        state.lastResult = 'success';
        state.lastError = null;
        log('success', 'click', 'Scheduled DOM click execution completed', {
          timestamp: state.lastClickAt,
          domClicks: Number.isInteger(value.domClicks) ? value.domClicks : 1,
          initialState: typeof value.initialState === 'string' ? value.initialState : null,
          finalState: typeof value.finalState === 'string' ? value.finalState : null
        });
      } else {
        state.lastResult = value.reason || 'target-missing';
        state.lastError = typeof value.error === 'string' ? value.error : 'target unavailable';
        log(value.reason === 'target-missing' ? 'warn' : 'error', 'click', 'DOM click execution did not complete', {
          reason: state.lastResult,
          error: state.lastError,
          domClicks: Number.isInteger(value.domClicks) ? value.domClicks : 0,
          initialState: typeof value.initialState === 'string' ? value.initialState : null,
          finalState: typeof value.finalState === 'string' ? value.finalState : null,
          ...(state.lastResult === 'target-missing' ? descriptorLocatorDiagnostics(state.descriptor) : {}),
          ...(boundedPageIdentity(value.expectedPage) ? { expectedPage: boundedPageIdentity(value.expectedPage) } : {}),
          ...(boundedPageIdentity(value.currentPage) ? { currentPage: boundedPageIdentity(value.currentPage) } : {})
        });
      }
      request.resolve({ success: value.success === true, reason: state.lastResult });
      persistState();
      sendState();
      if (process.env.AUTOCLICK_SMOKE === '1' && value.success === true && state.clickCount >= 2 && !smokeCompletionScheduled) {
        completeSmokeAfterClicks();
      }
    }
  });
}

function registerPowerEvents() {
  powerMonitor.on('suspend', () => {
    if (!state.desiredRunning) return;
    suspended = true;
    stopScheduler();
    state.recovering = true;
    state.lastResult = 'suspended';
    persistState();
    log('warn', 'system', 'OS suspend paused scheduling; run intent retained');
  });
  powerMonitor.on('resume', () => {
    if (!suspended) return;
    suspended = false;
    log('info', 'system', 'OS resume received; scheduling a future tick');
    if (state.desiredRunning) {
      if (targetReady) startSchedulerFromFuture();
      else scheduleRecovery('target not ready after resume');
    }
  });
}

async function bootstrap() {
  userDataPath = app.getPath('userData');
  fs.mkdirSync(userDataPath, { recursive: true });
  stateFilePath = path.join(userDataPath, 'state.json');
  logsFilePath = path.join(userDataPath, 'logs.json');
  loadState();
  loadLogs();
  registerIpc();
  createControlWindow();
  createTray();
  registerPowerEvents();
  log('info', 'system', 'AutoClick Desktop ready');
  if (process.env.AUTOCLICK_SMOKE === '1') runSmokeScenario();
}

if (hasSingleInstanceLock) app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  state.desiredRunning = false;
  clearRecoveryTimer();
  stopScheduler();
  powerController.release();
  persistState();
});

module.exports = {
  RECOVERY_DELAYS_MS
};

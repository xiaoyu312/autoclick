'use strict';

function createTargetWindowReadiness(overrides = {}) {
  return {
    targetReady: false,
    targetFinishedLoad: false,
    browserPreloadReady: false,
    navigationInFlight: false,
    navigationFailed: false,
    pendingUrl: null,
    ...overrides
  };
}

function updateTargetWindowReadiness(snapshot, event) {
  const current = createTargetWindowReadiness(snapshot);
  if (event?.isMainFrame === false) return current;
  if (event?.type === 'did-fail-stale') return current;
  if (event?.type === 'did-fail-aborted') {
    return createTargetWindowReadiness({
      ...current,
      targetReady: false,
      targetFinishedLoad: false,
      browserPreloadReady: false,
      navigationInFlight: current.navigationInFlight,
      navigationFailed: false,
      pendingUrl: event.pendingUrl || current.pendingUrl
    });
  }
  if (event?.type === 'did-start-navigation' || event?.type === 'will-redirect') {
    return createTargetWindowReadiness({
      ...current,
      targetReady: false,
      targetFinishedLoad: false,
      browserPreloadReady: false,
      navigationInFlight: true,
      navigationFailed: false,
      pendingUrl: event.url || null
    });
  }
  if (event?.type === 'did-finish-load') {
    if (event.temporaryBlank === true) {
      return createTargetWindowReadiness({
        ...current,
        targetReady: false,
        targetFinishedLoad: false,
        navigationInFlight: true,
        navigationFailed: false,
        pendingUrl: 'about:blank'
      });
    }
    return createTargetWindowReadiness({
      ...current,
      targetReady: current.browserPreloadReady === true && current.navigationFailed !== true,
      targetFinishedLoad: true,
      navigationInFlight: false,
      navigationFailed: false,
      pendingUrl: null
    });
  }
  if (event?.type === 'browser-ready') {
    return createTargetWindowReadiness({
      ...current,
      browserPreloadReady: true,
      targetReady: current.targetFinishedLoad === true && current.navigationFailed !== true
    });
  }
  if (event?.type === 'did-fail-load' || event?.type === 'render-process-gone' || event?.type === 'redirect-blocked') {
    return createTargetWindowReadiness({
      ...current,
      targetReady: false,
      targetFinishedLoad: false,
      browserPreloadReady: false,
      navigationInFlight: event.preserveNavigation === true ? current.navigationInFlight : false,
      navigationFailed: true,
      pendingUrl: event.preserveNavigation === true ? current.pendingUrl : null
    });
  }
  return current;
}

function classifyTargetRedirect({ url, isMainFrame }) {
  if (isMainFrame === false) return 'ignore-subframe';
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? 'allow-http' : 'block-non-http';
  } catch (_) {
    return 'block-non-http';
  }
}

function shouldPromoteTargetChild({ pending, urlIsHttp, targetReady, targetFinishedLoad, browserPreloadReady }) {
  return pending === true
    && urlIsHttp === true
    && targetReady === true
    && targetFinishedLoad === true
    && browserPreloadReady === true;
}

function findRecoverableTargetAncestor(startWindow, { getOpener, isDestroyed, isPending, isHttp }) {
  if (typeof getOpener !== 'function') return null;
  const visited = new Set();
  let candidate = getOpener(startWindow);
  while (candidate && !visited.has(candidate)) {
    visited.add(candidate);
    let next = null;
    try { next = getOpener(candidate); } catch (_) {}
    let invalid = false;
    try { invalid = (typeof isDestroyed === 'function' && isDestroyed(candidate)) || (typeof isPending === 'function' && isPending(candidate)) || (typeof isHttp === 'function' && !isHttp(candidate)); } catch (_) { invalid = true; }
    if (!invalid) return candidate;
    candidate = next;
  }
  return null;
}

module.exports = {
  createTargetWindowReadiness,
  updateTargetWindowReadiness,
  classifyTargetRedirect,
  shouldPromoteTargetChild,
  findRecoverableTargetAncestor
};

'use strict';

function classifyNavigationFailure({ errorCode, isMainFrame, pendingUrl, validatedURL }) {
  if (isMainFrame === false) return 'subframe-failed';
  if (errorCode === -3 && pendingUrl && validatedURL && pendingUrl !== validatedURL) return 'stale-aborted';
  if (errorCode === -3) return 'aborted-pending';
  return 'main-failed';
}

function navigationWatchdogAction({ desiredRunning, targetNavigationInFlight, pendingGeneration, generation }) {
  if (!targetNavigationInFlight || pendingGeneration !== generation) return 'ignore';
  return desiredRunning ? 'recover' : 'clear-pending';
}

module.exports = { classifyNavigationFailure, navigationWatchdogAction };

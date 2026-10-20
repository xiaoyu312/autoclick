'use strict';

function canMarkTargetReady({ targetFinishedLoad, browserPreloadReady }) {
  return targetFinishedLoad === true && browserPreloadReady === true;
}

function shouldPauseForNavigation({ isMainFrame, isInPlace }) {
  return isMainFrame !== false && isInPlace !== true;
}

module.exports = { canMarkTargetReady, shouldPauseForNavigation };

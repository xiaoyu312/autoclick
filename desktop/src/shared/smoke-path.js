'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isSafeSmokeUserDataPath(candidate, tempRoot = os.tmpdir()) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  try {
    const resolvedCandidate = fs.realpathSync(candidate);
    const resolvedRoot = fs.realpathSync(tempRoot);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch (_) {
    return false;
  }
}

function defaultUserDataCandidates(platform = process.platform, home = os.homedir(), environment = process.env) {
  let appData;
  if (platform === 'darwin') appData = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appData = environment.APPDATA || path.join(home, 'AppData', 'Roaming');
  else appData = environment.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(appData, 'auto-click-desktop'),
    path.join(appData, 'AutoClick Desktop'),
    path.join(appData, 'Electron')
  ];
}

module.exports = { isSafeSmokeUserDataPath, defaultUserDataCandidates };

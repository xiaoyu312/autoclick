'use strict';

// Explicit dependency-free test list. Optional Electron smoke is not executed.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [
  'extension/selection-target.test.js',
  'extension/error-log-export.test.js',
  'desktop/test/browser-preload-toggle.test.js',
  'desktop/test/logs.test.js',
  'desktop/test/power.test.js',
  'desktop/test/scheduler.test.js',
  'desktop/test/target.test.js',
  'desktop/test/validation.test.js',
];
const result = spawnSync(process.execPath, ['--test', ...files.map((file) => path.join(root, file))], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;

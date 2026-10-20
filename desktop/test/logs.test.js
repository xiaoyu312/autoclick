'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RUN_LOG_SCHEMA,
  RUN_LOG_VERSION,
  formatRunLogFilename,
  createRunLogExport,
  exportRunLogs
} = require('../src/shared/logs');

test('run-log export preserves every level in original order', () => {
  const logs = [
    { level: 'success', message: 'success' },
    { level: 'info', message: 'info' },
    { level: 'warn', message: 'warn' },
    { level: 'error', message: 'error' }
  ];
  const payload = createRunLogExport(logs, new Date('2026-08-10T03:04:05.000Z'));
  assert.equal(payload.logCount, 4);
  assert.deepEqual(payload.logs.map((entry) => entry.message), ['success', 'info', 'warn', 'error']);
});

test('run-log export contains stable schema, timestamp, logCount and full logs', () => {
  const exportedAt = new Date('2026-08-10T03:04:05.000Z');
  const payload = createRunLogExport([{ level: 'error', message: 'bad' }, { level: 'info', message: 'ok' }], exportedAt);
  assert.deepEqual(payload, {
    schema: RUN_LOG_SCHEMA,
    version: RUN_LOG_VERSION,
    exportedAt: '2026-08-10T03:04:05.000Z',
    logCount: 2,
    logs: [{ level: 'error', message: 'bad' }, { level: 'info', message: 'ok' }]
  });
});

test('run-log export filename uses local YYYYMMDD-HHmmss format', () => {
  assert.equal(formatRunLogFilename(new Date(2026, 7, 10, 3, 4, 5)), 'auto-click-run-logs-20260810-030405.json');
});

test('empty input exports an empty payload without inventing logs', () => {
  const payload = createRunLogExport([], new Date('2026-08-10T00:00:00.000Z'));
  assert.equal(payload.logCount, 0);
  assert.deepEqual(payload.logs, []);
});

test('run-log orchestration skips save dialog and write for empty logs', async () => {
  let chooseCalls = 0;
  let writeCalls = 0;
  const result = await exportRunLogs({
    logs: [],
    exportedAt: new Date(2026, 7, 10, 3, 4, 5),
    choosePath: () => { chooseCalls += 1; },
    writeText: () => { writeCalls += 1; }
  });
  assert.deepEqual(result, { status: 'empty', count: 0 });
  assert.equal(chooseCalls, 0);
  assert.equal(writeCalls, 0);
});

test('run-log orchestration treats a canceled save dialog as a no-op', async () => {
  let chooseCalls = 0;
  let writeCalls = 0;
  const result = await exportRunLogs({
    logs: [{ level: 'warn', message: 'warning' }],
    exportedAt: new Date(2026, 7, 10, 3, 4, 5),
    choosePath: (filename) => {
      chooseCalls += 1;
      assert.equal(filename, 'auto-click-run-logs-20260810-030405.json');
      return { canceled: true, filePath: '' };
    },
    writeText: () => { writeCalls += 1; }
  });
  assert.deepEqual(result, { status: 'cancelled', count: 1 });
  assert.equal(chooseCalls, 1);
  assert.equal(writeCalls, 0);
});

test('run-log orchestration writes the complete ordered payload with stable filename', async () => {
  const logs = [
    { level: 'success', message: 'success' },
    { level: 'info', message: 'info' },
    { level: 'warn', message: 'warn' },
    { level: 'error', message: 'error' }
  ];
  const exportedAt = new Date(2026, 7, 10, 3, 4, 5);
  let selectedFilename = null;
  let writtenPath = null;
  let writtenText = null;
  const result = await exportRunLogs({
    logs,
    exportedAt,
    choosePath: (filename) => {
      selectedFilename = filename;
      return { canceled: false, filePath: '/tmp/auto-click-run-logs.json' };
    },
    writeText: (filePath, text) => {
      writtenPath = filePath;
      writtenText = text;
    }
  });
  assert.equal(selectedFilename, 'auto-click-run-logs-20260810-030405.json');
  assert.equal(writtenPath, '/tmp/auto-click-run-logs.json');
  const payload = JSON.parse(writtenText);
  assert.equal(payload.schema, RUN_LOG_SCHEMA);
  assert.equal(payload.version, RUN_LOG_VERSION);
  assert.equal(payload.logCount, 4);
  assert.equal(payload.exportedAt, exportedAt.toISOString());
  assert.deepEqual(payload.logs.map((entry) => entry.level), ['success', 'info', 'warn', 'error']);
  assert.deepEqual(result, {
    status: 'saved',
    count: 4,
    filePath: '/tmp/auto-click-run-logs.json',
    filename: 'auto-click-run-logs-20260810-030405.json',
    payload
  });
});

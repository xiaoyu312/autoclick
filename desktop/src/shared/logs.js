'use strict';

const RUN_LOG_SCHEMA = 'auto-click-run-logs';
const RUN_LOG_VERSION = 1;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatRunLogFilename(date = new Date()) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `auto-click-run-logs-${year}${month}${day}-${hour}${minute}${second}.json`;
}

function createRunLogExport(logs, exportedAt = new Date()) {
  const entries = Array.isArray(logs) ? logs.slice() : [];
  return {
    schema: RUN_LOG_SCHEMA,
    version: RUN_LOG_VERSION,
    exportedAt: exportedAt.toISOString(),
    logCount: entries.length,
    logs: entries
  };
}

async function exportRunLogs({ logs, exportedAt = new Date(), choosePath, writeText }) {
  const entries = Array.isArray(logs) ? logs.slice() : [];
  if (entries.length === 0) return { status: 'empty', count: 0 };
  if (typeof choosePath !== 'function' || typeof writeText !== 'function') {
    throw new TypeError('run-log export requires choosePath and writeText callbacks');
  }

  const filename = formatRunLogFilename(exportedAt);
  const selection = await choosePath(filename);
  const filePath = typeof selection === 'string' ? selection : selection?.filePath;
  if (selection?.canceled || !filePath) return { status: 'cancelled', count: entries.length };

  const payload = createRunLogExport(entries, exportedAt);
  await writeText(filePath, JSON.stringify(payload, null, 2));
  return { status: 'saved', count: payload.logCount, filePath, filename, payload };
}

function createLogEntry(level, category, message, data = null, now = Date.now()) {
  return {
    timestamp: now,
    level,
    category,
    message,
    data
  };
}

module.exports = {
  RUN_LOG_SCHEMA,
  RUN_LOG_VERSION,
  formatRunLogFilename,
  createRunLogExport,
  exportRunLogs,
  createLogEntry
};

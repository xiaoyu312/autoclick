const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const popupScript = fs.readFileSync(
  path.join(__dirname, 'popup.js'),
  'utf8'
);

function loadPopup(logs, storageError = null) {
  const alerts = [];
  const downloads = [];
  const objectUrls = new Map();
  let nextObjectUrl = 1;

  const document = {
    addEventListener() {},
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return {
        href: '',
        download: '',
        style: {},
        click() {
          downloads.push({ href: this.href, download: this.download });
        },
        remove() {}
      };
    },
    body: {
      appendChild() {}
    }
  };

  const context = vm.createContext({
    alert(message) {
      alerts.push(message);
    },
    Blob,
    chrome: {
      storage: {
        local: {
          get() {
            if (storageError) {
              return Promise.reject(storageError);
            }
            return Promise.resolve({ logs });
          }
        }
      }
    },
    console,
    document,
    URL: {
      createObjectURL(blob) {
        const url = `blob:test-${nextObjectUrl++}`;
        objectUrls.set(url, blob);
        return url;
      },
      revokeObjectURL(url) {
        // Keep the stubbed blob readable after revocation so assertions can
        // inspect the generated JSON payload.
      }
    },
    window: {
      addEventListener() {}
    },
    setInterval() {
      return 1;
    },
    clearInterval() {}
  });

  vm.runInContext(popupScript, context, { filename: 'popup.js' });
  return { context, alerts, downloads, objectUrls };
}

async function readDownloadedJson(download, objectUrls) {
  const blob = objectUrls.get(download.href);
  assert.ok(blob, 'download should point to a created object URL');
  return JSON.parse(await blob.text());
}

test('exports only error logs in original order with the fixed JSON schema', async () => {
  const info = { level: 'info', message: 'started' };
  const firstError = { level: 'error', message: 'first' };
  const warning = { level: 'warn', message: 'warning' };
  const secondError = { level: 'error', message: 'second' };
  const { context, downloads, objectUrls } = loadPopup([
    info,
    firstError,
    warning,
    secondError
  ]);

  await context.handleExportErrorLogs();

  assert.equal(downloads.length, 1);
  const exported = await readDownloadedJson(downloads[0], objectUrls);
  assert.equal(exported.schema, 'auto-click-error-logs');
  assert.equal(exported.version, 1);
  assert.match(exported.exportedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(exported.errorCount, 2);
  assert.deepEqual(exported.logs, [firstError, secondError]);
});

test('builds a stable timestamped filename', () => {
  const { context } = loadPopup([]);
  const date = new Date(2026, 0, 2, 3, 4, 5);

  assert.equal(
    context.buildErrorLogExportFilename(date),
    'auto-click-errors-20260102-030405.json'
  );
});

test('does not download when there are no error logs', async () => {
  const { context, alerts, downloads } = loadPopup([
    { level: 'info', message: 'started' },
    { level: 'warn', message: 'warning' }
  ]);

  await context.handleExportErrorLogs();

  assert.deepEqual(alerts, ['暂无错误日志可导出']);
  assert.equal(downloads.length, 0);
});

test('creates and triggers a local download for error logs', async () => {
  const { context, downloads } = loadPopup([
    { level: 'error', message: 'failed' }
  ]);

  await context.handleExportErrorLogs();

  assert.equal(downloads.length, 1);
  assert.match(downloads[0].href, /^blob:test-/);
  assert.match(downloads[0].download, /^auto-click-errors-\d{8}-\d{6}\.json$/);
});

test('alerts with the storage error when export fails', async () => {
  const { context, alerts, downloads } = loadPopup([], new Error('storage unavailable'));

  await context.handleExportErrorLogs();

  assert.deepEqual(alerts, ['导出错误日志失败：storage unavailable']);
  assert.equal(downloads.length, 0);
});

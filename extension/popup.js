// Popup Script - 管理插件 UI 和用户交互

const LOG_PREFIX = '[AutoClick Popup]';
const ERROR_LOG_EXPORT_SCHEMA = 'auto-click-error-logs';
const ERROR_LOG_EXPORT_VERSION = 1;

// DOM 元素
let elements = {};

// 当前状态
let currentTabId = null;
let isRunning = false;
let statusCheckInterval = null;

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  console.log(LOG_PREFIX, 'popup loaded');

  // 获取 DOM 元素
  elements = {
    pageUrl: document.getElementById('pageUrl'),
    pageStatus: document.getElementById('pageStatus'),
    targetInfo: document.getElementById('targetInfo'),
    selectTargetBtn: document.getElementById('selectTargetBtn'),
    reselectTargetBtn: document.getElementById('reselectTargetBtn'),
    intervalInput: document.getElementById('intervalInput'),
    statusSection: document.getElementById('statusSection'),
    runStatus: document.getElementById('runStatus'),
    clickCount: document.getElementById('clickCount'),
    lastClickTime: document.getElementById('lastClickTime'),
    nextClickTime: document.getElementById('nextClickTime'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    resetBtn: document.getElementById('resetBtn'),
    viewLogsBtn: document.getElementById('viewLogsBtn'),
    logPanel: document.getElementById('logPanel'),
    closeLogsBtn: document.getElementById('closeLogsBtn'),
    refreshLogsBtn: document.getElementById('refreshLogsBtn'),
    clearLogsBtn: document.getElementById('clearLogsBtn'),
    exportErrorLogsBtn: document.getElementById('exportErrorLogsBtn'),
    logLevelFilter: document.getElementById('logLevelFilter'),
    logContent: document.getElementById('logContent')
  };

  // 获取当前 tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    currentTabId = tabs[0].id;
  }

  // 绑定事件
  elements.selectTargetBtn.addEventListener('click', handleSelectTarget);
  elements.reselectTargetBtn.addEventListener('click', handleSelectTarget);
  elements.startBtn.addEventListener('click', handleStart);
  elements.stopBtn.addEventListener('click', handleStop);
  elements.resetBtn.addEventListener('click', handleReset);
  elements.intervalInput.addEventListener('change', handleIntervalChange);
  elements.viewLogsBtn.addEventListener('click', handleViewLogs);
  elements.closeLogsBtn.addEventListener('click', handleCloseLogs);
  elements.refreshLogsBtn.addEventListener('click', handleRefreshLogs);
  elements.clearLogsBtn.addEventListener('click', handleClearLogs);
  elements.exportErrorLogsBtn.addEventListener('click', handleExportErrorLogs);
  elements.logLevelFilter.addEventListener('change', handleRefreshLogs);

  // 加载状态
  await loadState();

  // 定期更新状态
  statusCheckInterval = setInterval(updateStatus, 1000);
});

// 卸载时清理
window.addEventListener('unload', () => {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
  }
});

// ============================================
// 状态加载和更新
// ============================================

async function loadState() {
  try {
    // 获取当前页面信息
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      const tab = tabs[0];
      currentTabId = tab.id;

      // 显示页面 URL
      const url = new URL(tab.url);
      elements.pageUrl.textContent = url.hostname + url.pathname;
    }

    // 加载保存的配置
    const result = await chrome.storage.local.get([
      'targetDescriptor',
      'targetUrl',
      'interval',
      'isRunning',
      'clickStats'
    ]);

    // 显示目标信息
    if (result.targetDescriptor) {
      displayTarget(result.targetDescriptor);
      elements.pageStatus.textContent = '✓ 已绑定';
      elements.pageStatus.classList.add('bound');
      elements.startBtn.disabled = false;
      elements.reselectTargetBtn.style.display = 'inline-block';
    } else {
      elements.pageStatus.textContent = '未绑定';
      elements.pageStatus.classList.remove('bound');
    }

    // 设置间隔
    if (result.interval) {
      elements.intervalInput.value = result.interval;
    }

    // 运行状态
    isRunning = result.isRunning || false;
    updateRunningUI();

    // 点击统计
    if (result.clickStats && result.clickStats[currentTabId]) {
      updateClickStats(result.clickStats[currentTabId]);
    }

  } catch (error) {
    console.error(LOG_PREFIX, 'load state error:', error);
  }
}

function displayTarget(descriptor) {
  const productName = descriptor.container?.productName || '未知商品';
  const buttonText = descriptor.target?.text || '未知按钮';
  const productId = descriptor.container?.productId || null;

  let html = '<div class="target-display">';

  if (productId) {
    html += `<div class="target-row"><span class="label">商品 ID：</span><span class="value">${productId}</span></div>`;
  }

  html += `
    <div class="target-row">
      <span class="label">所属商品：</span>
      <span class="value">${escapeHtml(productName)}</span>
    </div>
    <div class="target-row">
      <span class="label">目标元素：</span>
      <span class="value">${escapeHtml(buttonText)}</span>
    </div>
  `;

  html += '</div>';

  elements.targetInfo.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// 事件处理
// ============================================

async function handleSelectTarget() {
  console.log(LOG_PREFIX, 'select target clicked');

  try {
    // 向 content script 发送进入选择模式的消息
    await chrome.tabs.sendMessage(currentTabId, {
      type: 'START_SELECTION_MODE'
    });

    // 关闭 popup（让用户可以在页面上选择）
    window.close();

  } catch (error) {
    console.error(LOG_PREFIX, 'select target error:', error);
    alert('无法进入选择模式，请确保页面已加载完成');
  }
}

async function handleStart() {
  console.log(LOG_PREFIX, 'start clicked');

  const interval = parseInt(elements.intervalInput.value);

  if (interval < 1) {
    alert('间隔时间至少为 1 秒');
    return;
  }

  try {
    // 保存运行状态
    await chrome.storage.local.set({
      isRunning: true,
      interval: interval
    });

    // 通知 background 开始
    await chrome.runtime.sendMessage({
      type: 'START_AUTO_CLICK',
      tabId: currentTabId,
      interval: interval
    });

    isRunning = true;
    updateRunningUI();

    console.log(LOG_PREFIX, 'auto click started');

  } catch (error) {
    console.error(LOG_PREFIX, 'start error:', error);
    alert('启动失败：' + error.message);
  }
}

async function handleStop() {
  console.log(LOG_PREFIX, 'stop clicked');

  try {
    // 保存运行状态
    await chrome.storage.local.set({
      isRunning: false
    });

    // 通知 background 停止
    await chrome.runtime.sendMessage({
      type: 'STOP_AUTO_CLICK',
      tabId: currentTabId
    });

    isRunning = false;
    updateRunningUI();

    console.log(LOG_PREFIX, 'auto click stopped');

  } catch (error) {
    console.error(LOG_PREFIX, 'stop error:', error);
  }
}

async function handleReset() {
  if (!confirm('确定要重置计数吗？')) {
    return;
  }

  try {
    const result = await chrome.storage.local.get(['clickStats']);
    const stats = result.clickStats || {};

    if (stats[currentTabId]) {
      stats[currentTabId] = {
        count: 0,
        lastClickAt: null,
        lastStatus: null,
        lastError: null
      };

      await chrome.storage.local.set({ clickStats: stats });

      updateClickStats(stats[currentTabId]);
    }

  } catch (error) {
    console.error(LOG_PREFIX, 'reset error:', error);
  }
}

async function handleIntervalChange() {
  const interval = parseInt(elements.intervalInput.value);

  if (interval < 1) {
    elements.intervalInput.value = 1;
    return;
  }

  try {
    await chrome.storage.local.set({ interval: interval });
    console.log(LOG_PREFIX, 'interval saved:', interval);

    // 如果正在运行，需要重新启动以应用新间隔
    if (isRunning) {
      await chrome.runtime.sendMessage({
        type: 'START_AUTO_CLICK',
        tabId: currentTabId,
        interval: interval
      });
    }

  } catch (error) {
    console.error(LOG_PREFIX, 'interval change error:', error);
  }
}

// ============================================
// UI 更新
// ============================================

function updateRunningUI() {
  if (isRunning) {
    elements.startBtn.style.display = 'none';
    elements.stopBtn.style.display = 'block';
    elements.statusSection.style.display = 'block';
    elements.runStatus.innerHTML = '<span class="status-running">● 运行中</span>';
  } else {
    elements.startBtn.style.display = 'block';
    elements.stopBtn.style.display = 'none';
    elements.statusSection.style.display = 'none';
    elements.runStatus.innerHTML = '<span class="status-stopped">○ 已停止</span>';
  }
}

function updateClickStats(stats) {
  elements.clickCount.textContent = stats.count || 0;

  if (stats.lastClickAt) {
    const lastTime = new Date(stats.lastClickAt);
    elements.lastClickTime.textContent = formatTime(lastTime);
  } else {
    elements.lastClickTime.textContent = '-';
  }

  // 计算下一次点击时间
  if (isRunning && stats.lastClickAt) {
    const interval = parseInt(elements.intervalInput.value) * 1000;
    const nextTime = new Date(stats.lastClickAt + interval);
    elements.nextClickTime.textContent = formatTime(nextTime);
  } else {
    elements.nextClickTime.textContent = '-';
  }

  // 显示状态
  if (stats.lastError) {
    elements.runStatus.innerHTML = `<span class="status-error">⚠ ${escapeHtml(stats.lastError)}</span>`;
  } else if (isRunning) {
    elements.runStatus.innerHTML = '<span class="status-running">● 运行中</span>';
  }
}

async function updateStatus() {
  if (!isRunning || !currentTabId) return;

  try {
    const result = await chrome.storage.local.get(['clickStats']);
    const stats = result.clickStats || {};

    if (stats[currentTabId]) {
      updateClickStats(stats[currentTabId]);
    }
  } catch (error) {
    // 忽略错误
  }
}

// ============================================
// 工具函数
// ============================================

function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

// ============================================
// 日志管理
// ============================================

async function handleViewLogs() {
  console.log(LOG_PREFIX, 'opening logs panel');
  elements.logPanel.style.display = 'flex';
  await loadLogs();
}

function handleCloseLogs() {
  elements.logPanel.style.display = 'none';
}

async function handleRefreshLogs() {
  await loadLogs();
}

async function handleClearLogs() {
  if (!confirm('确定要清空所有日志吗？')) {
    return;
  }

  try {
    await chrome.storage.local.set({ logs: [] });
    elements.logContent.innerHTML = '<div class="log-empty">暂无日志</div>';
    console.log(LOG_PREFIX, 'logs cleared');
  } catch (error) {
    console.error(LOG_PREFIX, 'clear logs error:', error);
  }
}

function buildErrorLogExportFilename(date = new Date()) {
  const datePart = [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0')
  ].join('');
  const timePart = [
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0')
  ].join('');

  return `auto-click-errors-${datePart}-${timePart}.json`;
}

async function handleExportErrorLogs() {
  let objectUrl = null;

  try {
    const result = await chrome.storage.local.get(['logs']);
    const logs = Array.isArray(result.logs) ? result.logs : [];
    const errorLogs = logs.filter(log => log && log.level === 'error');

    if (errorLogs.length === 0) {
      alert('暂无错误日志可导出');
      return;
    }

    const exportDate = new Date();
    const exportData = {
      schema: ERROR_LOG_EXPORT_SCHEMA,
      version: ERROR_LOG_EXPORT_VERSION,
      exportedAt: exportDate.toISOString(),
      errorCount: errorLogs.length,
      logs: errorLogs
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });
    objectUrl = URL.createObjectURL(blob);

    const downloadLink = document.createElement('a');
    downloadLink.href = objectUrl;
    downloadLink.download = buildErrorLogExportFilename(exportDate);
    if (downloadLink.style) {
      downloadLink.style.display = 'none';
    }
    document.body.appendChild(downloadLink);
    downloadLink.click();
    if (typeof downloadLink.remove === 'function') {
      downloadLink.remove();
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(LOG_PREFIX, 'export error logs error:', error);
    alert('导出错误日志失败：' + message);
  } finally {
    if (objectUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

async function loadLogs() {
  try {
    // 从 storage 加载日志
    const result = await chrome.storage.local.get(['logs']);
    const logs = result.logs || [];

    console.log(LOG_PREFIX, `loaded ${logs.length} logs`);

    // 获取过滤级别
    const filterLevel = elements.logLevelFilter.value;

    // 过滤日志
    const filteredLogs = logs.filter(log => {
      if (filterLevel === 'all') return true;
      if (filterLevel === 'error') return log.level === 'error';
      if (filterLevel === 'warn') return log.level === 'error' || log.level === 'warn';
      if (filterLevel === 'success') return log.level === 'success';
      return true;
    });

    // 显示日志
    if (filteredLogs.length === 0) {
      elements.logContent.innerHTML = '<div class="log-empty">暂无日志</div>';
      return;
    }

    // 倒序显示（最新的在上面）
    const logsHtml = filteredLogs.reverse().map(log => {
      const time = new Date(log.timestamp);
      const timeStr = formatTime(time);
      const dataStr = log.data ? JSON.stringify(log.data, null, 2) : '';

      return `
        <div class="log-entry level-${log.level}">
          <div>
            <span class="log-time">${timeStr}</span>
            <span class="log-category">${log.category}</span>
            <span class="log-message">${escapeHtml(log.message)}</span>
          </div>
          ${dataStr ? `<div class="log-data">${escapeHtml(dataStr)}</div>` : ''}
        </div>
      `;
    }).join('');

    elements.logContent.innerHTML = logsHtml;

    // 滚动到顶部（最新日志）
    elements.logContent.scrollTop = 0;

  } catch (error) {
    console.error(LOG_PREFIX, 'load logs error:', error);
    elements.logContent.innerHTML = '<div class="log-empty">加载日志失败</div>';
  }
}

console.log(LOG_PREFIX, 'popup script loaded');

// Background Service Worker - 管理定时任务和跨页面状态

const LOG_PREFIX = '[AutoClick BG]';

// 全局状态
let activeTimers = new Map(); // tabId -> timer info

// 监听来自 popup 和 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, 'received message:', message.type, 'from tab:', sender.tab?.id);

  if (message.type === 'START_AUTO_CLICK') {
    startAutoClick(message.tabId, message.interval);
    sendResponse({ success: true });
  }
  else if (message.type === 'STOP_AUTO_CLICK') {
    stopAutoClick(message.tabId);
    sendResponse({ success: true });
  }
  else if (message.type === 'CLICK_EXECUTED') {
    // content script 报告点击已执行
    const tabId = sender.tab?.id;
    if (tabId) {
      updateClickStats(tabId, message.success, message.error);
    }
  }

  return true; // 保持消息通道开放
});

// 启动自动点击
function startAutoClick(tabId, interval) {
  console.log(LOG_PREFIX, `starting auto click for tab ${tabId}, interval: ${interval}s`);

  // 清除已有定时器
  stopAutoClick(tabId);

  // 立即执行第一次
  executeClick(tabId);

  // 设置定时器
  const timer = setInterval(() => {
    executeClick(tabId);
  }, interval * 1000);

  activeTimers.set(tabId, {
    timer,
    interval,
    startTime: Date.now()
  });
}

// 停止自动点击
function stopAutoClick(tabId) {
  const timerInfo = activeTimers.get(tabId);
  if (timerInfo) {
    clearInterval(timerInfo.timer);
    activeTimers.delete(tabId);
    console.log(LOG_PREFIX, `stopped auto click for tab ${tabId}`);
  }
}

// 执行一次点击
async function executeClick(tabId) {
  try {
    // 检查 tab 是否仍然存在
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      console.log(LOG_PREFIX, `tab ${tabId} no longer exists, stopping`);
      stopAutoClick(tabId);
      return;
    }

    console.log(LOG_PREFIX, `sending EXECUTE_CLICK to tab ${tabId}`);

    // 向 content script 发送点击指令
    chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_CLICK'
    }).catch(err => {
      console.error(LOG_PREFIX, `failed to send message to tab ${tabId}:`, err);
      // 可能是 content script 未加载，记录错误
      updateClickStats(tabId, false, 'Content script 未响应');
    });

  } catch (error) {
    console.error(LOG_PREFIX, 'execute click error:', error);
  }
}

// 更新点击统计
function updateClickStats(tabId, success, error) {
  chrome.storage.local.get(['clickStats'], (result) => {
    const stats = result.clickStats || {};
    const tabStats = stats[tabId] || { count: 0, lastClickAt: null, lastStatus: null };

    if (success) {
      tabStats.count++;
      tabStats.lastClickAt = Date.now();
      tabStats.lastStatus = 'success';
      tabStats.lastError = null;
    } else {
      tabStats.lastStatus = 'error';
      tabStats.lastError = error;
    }

    stats[tabId] = tabStats;
    chrome.storage.local.set({ clickStats: stats });
  });
}

// 监听 tab 关闭，清理定时器
chrome.tabs.onRemoved.addListener((tabId) => {
  stopAutoClick(tabId);
});

// Service Worker 保活机制
// Chrome 可能会在一段时间后休眠 service worker
// 使用 chrome.alarms 可以唤醒，但对于短间隔任务，setInterval 配合消息传递更合适
// 注意：后台 tab 的 setInterval 可能被节流，但通常 1-30 秒级别影响不大

console.log(LOG_PREFIX, 'background service worker loaded');

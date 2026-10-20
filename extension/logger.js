// 日志管理模块 - 统一的日志收集系统

const LogManager = {
  logs: [],
  maxLogs: 100,

  log(level, category, message, data = null) {
    const entry = {
      timestamp: Date.now(),
      level: level, // 'info', 'warn', 'error', 'success'
      category: category, // 'selection', 'click', 'locate', 'page', 'system'
      message: message,
      data: data,
      url: window.location.href
    };

    this.logs.push(entry);

    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // 同时输出到 console
    const consoleMsg = `[AutoClick][${category}] ${message}`;
    if (level === 'error') {
      console.error(consoleMsg, data || '');
    } else if (level === 'warn') {
      console.warn(consoleMsg, data || '');
    } else {
      console.log(consoleMsg, data || '');
    }

    // 保存到 storage
    this.saveLogs();
  },

  saveLogs() {
    // 只保存最近 50 条到 storage
    const recentLogs = this.logs.slice(-50);
    chrome.storage.local.set({ logs: recentLogs }).catch(err => {
      console.error('[AutoClick] Failed to save logs:', err);
    });
  },

  async loadLogs() {
    try {
      const result = await chrome.storage.local.get(['logs']);
      if (result.logs) {
        this.logs = result.logs;
      }
    } catch (err) {
      console.error('[AutoClick] Failed to load logs:', err);
    }
  },

  clearLogs() {
    this.logs = [];
    chrome.storage.local.set({ logs: [] });
  },

  getLogs() {
    return this.logs;
  }
};

// 初始化时加载日志
LogManager.loadLogs();

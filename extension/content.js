// Content Script - 在网页中运行，负责元素选择、目标定位和点击执行

const LOG_PREFIX = '[AutoClick]';

// 当前页面状态
let isSelectionMode = false;
let selectionOverlay = null;
let lastHoveredElement = null;
let currentTarget = null; // 当前选中的目标描述符

// 监听来自 background 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  LogManager.log('info', 'system', `Content received message: ${message.type}`);

  if (message.type === 'START_SELECTION_MODE') {
    enterSelectionMode();
    sendResponse({ success: true });
  }
  else if (message.type === 'EXIT_SELECTION_MODE') {
    exitSelectionMode();
    sendResponse({ success: true });
  }
  else if (message.type === 'EXECUTE_CLICK') {
    executeAutoClick();
    sendResponse({ success: true });
  }
  else if (message.type === 'GET_PAGE_INFO') {
    sendResponse({
      url: window.location.href,
      title: document.title
    });
  }
  else if (message.type === 'GET_LOGS') {
    sendResponse({ logs: LogManager.getLogs() });
  }

  return true;
});

// ============================================
// 元素选择模式
// ============================================

function enterSelectionMode() {
  LogManager.log('info', 'selection', 'Entering selection mode');
  isSelectionMode = true;

  // 创建顶部提示浮层
  createSelectionOverlay();

  // 监听鼠标移动和点击
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleSelectionClick, true);
  document.addEventListener('keydown', handleSelectionKeydown, true);
}

function exitSelectionMode() {
  LogManager.log('info', 'selection', 'Exiting selection mode');
  isSelectionMode = false;

  // 移除浮层
  if (selectionOverlay) {
    selectionOverlay.remove();
    selectionOverlay = null;
  }

  // 移除高亮
  if (lastHoveredElement) {
    lastHoveredElement.style.outline = '';
    lastHoveredElement = null;
  }

  // 移除监听器
  document.removeEventListener('mousemove', handleMouseMove, true);
  document.removeEventListener('click', handleSelectionClick, true);
  document.removeEventListener('keydown', handleSelectionKeydown, true);
}

function createSelectionOverlay() {
  selectionOverlay = document.createElement('div');
  selectionOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: rgba(255, 77, 79, 0.95);
    color: white;
    padding: 12px 20px;
    font-size: 14px;
    font-family: Arial, sans-serif;
    z-index: 999999;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    text-align: center;
  `;
  selectionOverlay.innerHTML = `
    <strong>自动点击助手：</strong>请选择需要自动点击的按钮
    <span style="margin-left: 20px; opacity: 0.9;">按 ESC 取消</span>
  `;
  document.body.appendChild(selectionOverlay);
}

function handleMouseMove(e) {
  if (!isSelectionMode) return;

  const element = document.elementFromPoint(e.clientX, e.clientY);

  // 跳过选择浮层本身
  if (element === selectionOverlay || selectionOverlay?.contains(element)) {
    return;
  }

  // 移除上一个元素的高亮
  if (lastHoveredElement && lastHoveredElement !== element) {
    lastHoveredElement.style.outline = '';
  }

  // 高亮当前元素
  if (element) {
    element.style.outline = '2px solid #ff4d4f';
    lastHoveredElement = element;
  }
}

function handleSelectionClick(e) {
  if (!isSelectionMode) return;

  // 阻止原始点击事件
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const element = e.target;

  // 跳过选择浮层本身
  if (element === selectionOverlay || selectionOverlay?.contains(element)) {
    return;
  }

  const targetElement = getClickableTarget(element);

  LogManager.log('info', 'selection', 'Element selected', {
    tagName: targetElement.tagName,
    className: targetElement.className,
    id: targetElement.id,
    text: targetElement.textContent?.trim().substring(0, 50)
  });

  // 分析并保存目标
  const targetDescriptor = analyzeTarget(targetElement);

  if (targetDescriptor) {
    currentTarget = targetDescriptor;

    LogManager.log('success', 'selection', 'Target descriptor created', {
      productId: targetDescriptor.container?.productId,
      productName: targetDescriptor.container?.productName?.substring(0, 50),
      buttonText: targetDescriptor.target?.text
    });

    // 保存到 storage
    chrome.storage.local.set({
      targetDescriptor: targetDescriptor,
      targetUrl: window.location.href
    }, () => {
      LogManager.log('success', 'selection', 'Target saved to storage');

      // 显示确认提示
      showSelectionConfirmation(targetDescriptor);

      // 退出选择模式
      exitSelectionMode();
    });
  } else {
    LogManager.log('error', 'selection', 'Failed to analyze target element');
    alert('无法识别目标元素，请重试');
    exitSelectionMode();
  }
}

function getClickableTarget(element) {
  const semanticTarget = element?.closest?.('button, a, [role="button"]');
  return semanticTarget || element?.closest?.('[class*="button"]') || element;
}

function handleSelectionKeydown(e) {
  if (!isSelectionMode) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    exitSelectionMode();
  }
}

function showSelectionConfirmation(descriptor) {
  const confirmDiv = document.createElement('div');
  confirmDiv.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: rgba(39, 174, 96, 0.95);
    color: white;
    padding: 16px 24px;
    border-radius: 4px;
    font-size: 14px;
    font-family: Arial, sans-serif;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    max-width: 300px;
  `;

  const productName = descriptor.container?.productName || '未知商品';
  const buttonText = descriptor.target?.text || '未知按钮';

  confirmDiv.innerHTML = `
    <div style="font-weight: bold; margin-bottom: 8px;">✓ 已选择目标</div>
    <div style="font-size: 12px; opacity: 0.95;">
      ${productName}<br/>
      → ${buttonText}
    </div>
  `;

  document.body.appendChild(confirmDiv);

  setTimeout(() => {
    confirmDiv.remove();
  }, 2000);
}

// ============================================
// 目标分析 - 核心逻辑
// ============================================

function analyzeTarget(element) {
  LogManager.log('info', 'locate', 'Analyzing target element');

  // 1. 提取按钮自身信息
  const targetInfo = {
    tagName: element.tagName.toLowerCase(),
    text: element.textContent?.trim() || '',
    className: element.className || '',
    id: element.id || '',
    attributes: extractAttributes(element)
  };

  LogManager.log('info', 'locate', 'Target info extracted', {
    tagName: targetInfo.tagName,
    text: targetInfo.text.substring(0, 50),
    hasAttributes: Object.keys(targetInfo.attributes).length > 0
  });

  // 2. 向上查找商品容器
  const container = findProductContainer(element);

  // 3. 生成页面规则
  const pageRule = generatePageRule(window.location.href);

  const descriptor = {
    target: targetInfo,
    container: container,
    pageRule: pageRule,
    timestamp: Date.now()
  };

  LogManager.log('success', 'locate', 'Target descriptor complete', {
    hasContainer: !!container,
    hasProductId: !!container?.productId,
    hasProductName: !!container?.productName
  });

  return descriptor;
}

function extractAttributes(element) {
  const attrs = {};
  for (let attr of element.attributes) {
    // 保存 data-* 属性和其他可能有用的属性
    if (attr.name.startsWith('data-') ||
        ['href', 'type', 'role', 'aria-label'].includes(attr.name)) {
      attrs[attr.name] = attr.value;
    }
  }
  return attrs;
}

// 向上查找商品容器，提取商品特征
function findProductContainer(element) {
  LogManager.log('info', 'locate', 'Searching for product container');

  let current = element;
  let depth = 0;
  const maxDepth = 15; // 最多向上查找 15 层

  while (current && current !== document.body && depth < maxDepth) {
    current = current.parentElement;
    depth++;

    if (!current) break;

    // 尝试提取商品特征
    const productFeatures = extractProductFeatures(current);

    // 如果找到有效的商品特征，认为这是商品容器
    if (productFeatures && (productFeatures.productId || productFeatures.productName || productFeatures.href)) {
      LogManager.log('success', 'locate', `Product container found at depth ${depth}`, {
        productId: productFeatures.productId,
        productName: productFeatures.productName?.substring(0, 50),
        hasHref: !!productFeatures.href
      });

      return {
        ...productFeatures,
        depth: depth,
        containerAttrs: extractAttributes(current)
      };
    }
  }

  LogManager.log('warn', 'locate', 'No product container found, using element context');

  // 如果没找到明确的商品容器，返回基本信息
  return {
    productName: element.textContent?.trim() || '',
    depth: 0
  };
}

// 提取商品特征
function extractProductFeatures(container) {
  const features = {};

  // 优先级 1: 查找商品 ID（data-* 属性）
  const idAttrs = ['data-product-id', 'data-goods-id', 'data-item-id', 'data-sku-id', 'data-id'];
  for (let attr of idAttrs) {
    const value = container.getAttribute(attr);
    if (value) {
      features.productId = value;
      break;
    }
  }

  // 优先级 2: 查找商品链接
  const link = container.querySelector('a[href*="product"], a[href*="goods"], a[href*="item"]');
  if (link) {
    features.href = link.href;

    // 尝试从链接中提取 ID
    const idMatch = link.href.match(/[?&](product_id|goods_id|item_id|id)=([^&]+)/);
    if (idMatch && !features.productId) {
      features.productId = idMatch[2];
    }
  }

  // 优先级 3: 查找商品名称
  // 尝试常见的商品名称选择器
  const nameSelectors = [
    '.product-name',
    '.goods-name',
    '.item-name',
    '.title',
    '[class*="name"]',
    '[class*="title"]'
  ];

  for (let selector of nameSelectors) {
    const nameEl = container.querySelector(selector);
    if (nameEl && nameEl.textContent.trim()) {
      features.productName = normalizeText(nameEl.textContent);
      break;
    }
  }

  // 如果还没找到商品名，尝试提取容器内的文本（排除按钮文本）
  if (!features.productName) {
    const textContent = Array.from(container.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE ||
              (node.nodeType === Node.ELEMENT_NODE && !['BUTTON', 'A', 'INPUT'].includes(node.tagName)))
      .map(node => node.textContent?.trim())
      .filter(text => text && text.length > 2 && text.length < 100)
      .join(' ');

    if (textContent) {
      features.productName = normalizeText(textContent);
    }
  }

  // 优先级 4: 保存稳定的 data 属性
  features.stableAttrs = {};
  for (let attr of container.attributes) {
    if (attr.name.startsWith('data-') && attr.value) {
      features.stableAttrs[attr.name] = attr.value;
    }
  }

  return features;
}

// 文本标准化
function normalizeText(text) {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .substring(0, 200); // 限制长度
}

// 生成页面规则
function generatePageRule(url) {
  try {
    const urlObj = new URL(url);
    return {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      pathname: urlObj.pathname,
      fullUrl: url
    };
  } catch (e) {
    return { fullUrl: url };
  }
}

// ============================================
// 自动点击执行
// ============================================

async function executeAutoClick() {
  LogManager.log('info', 'click', '========== Starting auto click execution ==========');

  try {
    // 获取保存的目标描述符
    const result = await chrome.storage.local.get(['targetDescriptor', 'targetUrl']);

    if (!result.targetDescriptor) {
      LogManager.log('error', 'click', 'No target descriptor found in storage');
      reportClickResult(false, '未设置目标');
      return;
    }

    const descriptor = result.targetDescriptor;
    LogManager.log('info', 'click', 'Target descriptor loaded', {
      hasTarget: !!descriptor.target,
      hasContainer: !!descriptor.container,
      hasPageRule: !!descriptor.pageRule
    });

    // 1. 检查页面是否匹配
    const pageMatches = checkPageMatch(descriptor.pageRule);
    if (!pageMatches) {
      LogManager.log('warn', 'page', 'Page URL does not match target page rule', {
        currentUrl: window.location.href,
        ruleHostname: descriptor.pageRule?.hostname,
        rulePathname: descriptor.pageRule?.pathname
      });
      reportClickResult(false, '页面不匹配');
      return;
    }

    LogManager.log('success', 'page', 'Page URL matches target page rule');

    // 2. 重新定位目标元素
    const targetElement = relocateTarget(descriptor);

    if (!targetElement) {
      LogManager.log('error', 'locate', 'Target element not found in current DOM');
      reportClickResult(false, '未找到目标');
      return;
    }

    LogManager.log('success', 'locate', 'Target element relocated', {
      tagName: targetElement.tagName,
      text: targetElement.textContent?.trim().substring(0, 50),
      hasParent: !!targetElement.parentElement
    });

    // 3. 检查元素是否可点击
    if (targetElement.disabled || targetElement.getAttribute('disabled') !== null) {
      LogManager.log('warn', 'click', 'Target element is disabled');
      reportClickResult(false, '目标已禁用');
      return;
    }

    // 4. 执行点击
    LogManager.log('info', 'click', 'Executing click on target element');
    targetElement.click();

    LogManager.log('success', 'click', 'Click executed successfully');
    reportClickResult(true, null);

  } catch (error) {
    LogManager.log('error', 'click', 'Auto click execution failed', {
      error: error.message,
      stack: error.stack
    });
    reportClickResult(false, error.message);
  }
}

// 检查页面是否匹配
function checkPageMatch(pageRule) {
  if (!pageRule) return false;

  const currentUrl = window.location.href;

  LogManager.log('info', 'page', 'Checking page match', {
    currentHostname: window.location.hostname,
    currentPathname: window.location.pathname,
    ruleHostname: pageRule.hostname,
    rulePathname: pageRule.pathname
  });

  // 检查 hostname 和 pathname
  if (pageRule.hostname && pageRule.hostname !== window.location.hostname) {
    return false;
  }

  if (pageRule.pathname && pageRule.pathname !== window.location.pathname) {
    // pathname 可能包含动态部分，做前缀匹配
    const rulePath = pageRule.pathname.split('/').filter(p => p);
    const currentPath = window.location.pathname.split('/').filter(p => p);

    // 至少前两级路径要匹配
    if (rulePath.length >= 2 && currentPath.length >= 2) {
      if (rulePath[0] !== currentPath[0] || rulePath[1] !== currentPath[1]) {
        return false;
      }
    }
  }

  return true;
}

// 重新定位目标元素
function relocateTarget(descriptor) {
  LogManager.log('info', 'locate', 'Starting target relocation');

  // 如果有商品容器信息，先定位商品
  if (descriptor.container && (descriptor.container.productId || descriptor.container.productName)) {
    LogManager.log('info', 'locate', 'Attempting to relocate product container', {
      hasProductId: !!descriptor.container.productId,
      hasProductName: !!descriptor.container.productName,
      hasHref: !!descriptor.container.href
    });

    const productContainer = relocateProductContainer(descriptor.container);

    if (productContainer) {
      LogManager.log('success', 'locate', 'Product container relocated');

      // 在商品容器内查找目标按钮
      const button = findButtonInContainer(productContainer, descriptor.target);
      if (button) {
        LogManager.log('success', 'locate', 'Target button found in container');
        return button;
      } else {
        LogManager.log('warn', 'locate', 'Target button not found in container');
      }
    } else {
      LogManager.log('warn', 'locate', 'Product container not relocated');
    }
  }

  // 如果商品容器定位失败，尝试全局查找（但要确保唯一性）
  LogManager.log('info', 'locate', 'Trying global search for target');
  const candidates = findButtonsByDescriptor(descriptor.target);

  LogManager.log('info', 'locate', `Found ${candidates.length} candidate(s) globally`);

  if (candidates.length === 1) {
    LogManager.log('success', 'locate', 'Unique target found globally');
    return candidates[0];
  } else if (candidates.length > 1) {
    LogManager.log('warn', 'locate', 'Multiple candidates found, skipping for safety');
    return null;
  }

  LogManager.log('error', 'locate', 'No target found');
  return null;
}

// 重新定位商品容器
function relocateProductContainer(containerDescriptor) {
  LogManager.log('info', 'locate', 'Relocating product container');

  // 策略 1: 通过 productId 查找
  if (containerDescriptor.productId) {
    LogManager.log('info', 'locate', `Searching by product ID: ${containerDescriptor.productId}`);
    const idAttrs = ['data-product-id', 'data-goods-id', 'data-item-id', 'data-sku-id', 'data-id'];

    for (let attr of idAttrs) {
      const element = document.querySelector(`[${attr}="${containerDescriptor.productId}"]`);
      if (element) {
        LogManager.log('success', 'locate', `Container found by ${attr}`);
        return element;
      }
    }
    LogManager.log('info', 'locate', 'No container found by product ID');
  }

  // 策略 2: 通过商品链接查找
  if (containerDescriptor.href) {
    LogManager.log('info', 'locate', 'Searching by product href');
    const links = document.querySelectorAll('a[href]');
    for (let link of links) {
      if (link.href === containerDescriptor.href) {
        LogManager.log('success', 'locate', 'Container found by href');
        return link.closest('[class*="item"], [class*="product"], [class*="goods"]') || link.parentElement;
      }
    }
    LogManager.log('info', 'locate', 'No container found by href');
  }

  // 策略 3: 通过商品名称查找
  if (containerDescriptor.productName) {
    LogManager.log('info', 'locate', `Searching by product name: ${containerDescriptor.productName.substring(0, 50)}`);
    const normalizedName = normalizeText(containerDescriptor.productName);
    const allElements = document.querySelectorAll('[class*="item"], [class*="product"], [class*="goods"], [class*="row"]');

    LogManager.log('info', 'locate', `Scanning ${allElements.length} potential containers`);

    for (let element of allElements) {
      const elementText = normalizeText(element.textContent);
      if (elementText.includes(normalizedName) || normalizedName.includes(elementText.substring(0, 20))) {
        LogManager.log('success', 'locate', 'Container found by product name');
        return element;
      }
    }
    LogManager.log('info', 'locate', 'No container found by product name');
  }

  return null;
}

// 在容器内查找目标按钮
function findButtonInContainer(container, targetDescriptor) {
  const buttons = container.querySelectorAll('button, a, [role="button"], [class*="button"]');

  for (let button of buttons) {
    if (matchButton(button, targetDescriptor)) {
      return button;
    }
  }

  return null;
}

// 全局查找按钮
function findButtonsByDescriptor(targetDescriptor) {
  const buttons = document.querySelectorAll('button, a, [role="button"], [class*="button"]');
  const matches = [];

  for (let button of buttons) {
    if (matchButton(button, targetDescriptor)) {
      matches.push(button);
    }
  }

  return matches;
}

// 判断按钮是否匹配
function matchButton(button, targetDescriptor) {
  // 匹配文本
  if (targetDescriptor.text) {
    const buttonText = normalizeText(button.textContent);
    const targetText = normalizeText(targetDescriptor.text);

    if (buttonText !== targetText) {
      return false;
    }
  }

  // 匹配标签名
  if (targetDescriptor.tagName && button.tagName.toLowerCase() !== targetDescriptor.tagName) {
    return false;
  }

  // 匹配 data-* 属性
  if (targetDescriptor.attributes) {
    for (let [key, value] of Object.entries(targetDescriptor.attributes)) {
      if (key.startsWith('data-') && button.getAttribute(key) !== value) {
        return false;
      }
    }
  }

  return true;
}

// 派发鼠标事件（备用方案）
function dispatchMouseEvent(element) {
  const events = ['mousedown', 'mouseup', 'click'];
  events.forEach(eventType => {
    const event = new MouseEvent(eventType, {
      view: window,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(event);
  });
}

// 报告点击结果给 background
function reportClickResult(success, error) {
  const result = {
    type: 'CLICK_EXECUTED',
    success: success,
    error: error,
    timestamp: Date.now()
  };

  LogManager.log(success ? 'success' : 'error', 'click',
    success ? 'Reporting success to background' : `Reporting error to background: ${error}`);

  chrome.runtime.sendMessage(result).catch(err => {
    LogManager.log('error', 'system', 'Failed to report result to background', { error: err.message });
  });
}

LogManager.log('info', 'system', 'Content script loaded and ready');

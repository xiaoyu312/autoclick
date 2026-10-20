'use strict';

const desktop = window.autoClickDesktop;
const elements = {};
let currentState = null;
let toastTimer = null;

function byId(id) { return document.getElementById(id); }

function showToast(message) {
  elements.toast.textContent = message || '';
  clearTimeout(toastTimer);
  if (message) toastTimer = setTimeout(() => { elements.toast.textContent = ''; }, 6000);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value || '');
  return node.innerHTML;
}

function renderTarget(state) {
  const descriptor = state?.descriptor;
  elements.selectTargetButton.disabled = !state?.url;
  elements.startButton.disabled = !descriptor || state.desiredRunning;
  if (!descriptor) {
    elements.targetSummary.innerHTML = '<div class="empty-state"><span class="empty-mark">—</span><span>尚未绑定网页目标</span></div>';
    return;
  }
  const product = descriptor.container?.productName || '未识别商品容器';
  const text = descriptor.target?.text || '未识别文本';
  elements.targetSummary.innerHTML = `<div class="target-display"><div class="target-row"><span class="label">网页</span><span class="value url">${escapeHtml(state.url || descriptor.pageRule?.fullUrl)}</span></div><div class="target-row"><span class="label">所属目标</span><span class="value">${escapeHtml(product)}</span></div><div class="target-row"><span class="label">点击元素</span><span class="value">${escapeHtml(text)}</span></div></div>`;
}

function renderState(state) {
  currentState = state;
  const runtime = state.recovering ? 'recovering' : state.desiredRunning ? 'running' : 'stopped';
  const runtimeText = state.recovering ? '恢复中' : state.desiredRunning ? '运行中' : '已停止';
  elements.runtimeBadge.dataset.state = runtime;
  elements.runtimeText.textContent = runtimeText;
  elements.clickCount.textContent = String(state.clickCount || 0);
  elements.lastClickAt.textContent = formatTime(state.lastClickAt);
  elements.nextClickAt.textContent = formatTime(state.nextClickAt || state.recoveryDueAt);
  elements.lastResult.textContent = state.lastError || ({ success: '执行成功', 'target-missing': '目标暂失，继续重试', recovering: '等待浏览器恢复', stopped: '已停止', suspended: '等待系统恢复' }[state.lastResult] || '等待任务');
  elements.intervalInput.value = state.intervalSeconds || 8;
  elements.intervalInput.disabled = Boolean(state.desiredRunning || state.recovering);
  elements.stopButton.disabled = !state.desiredRunning;
  elements.startButton.disabled = !state.descriptor || state.desiredRunning;
  elements.runHint.textContent = state.recovering ? '目标浏览器正在恢复，任务意图已保留；恢复后从新的未来时间继续，不补点。' : state.desiredRunning ? '任务运行中，间隔不可修改。停止后可调整间隔；关闭窗口会隐藏到托盘。' : '选择网页目标后才能开始。窗口隐藏或切换其他软件不会改变调度。';
  renderTarget(state);
}

function renderLogs(logs) {
  elements.logCount.textContent = `${logs.length} 条`;
  if (!logs.length) {
    elements.logView.innerHTML = '<p class="empty-state">暂无日志</p>';
    return;
  }
  elements.logView.innerHTML = logs.slice().reverse().map((entry) => `<div class="log-line"><span>${escapeHtml(formatTime(entry.timestamp))}</span><span class="level-${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span><span>${escapeHtml(entry.message)}</span></div>`).join('');
}

async function loadLogs() {
  try { renderLogs(await desktop.getLogs()); } catch (error) { showToast(`读取日志失败：${error.message}`); }
}

async function onTargetSubmit(event) {
  event.preventDefault();
  try {
    await desktop.openTarget(elements.urlInput.value.trim());
    showToast('目标浏览器已打开。请在目标窗口登录或选择目标。');
  } catch (error) {
    showToast(`打开失败：${error.message}`);
  }
}

async function onSelectTarget() {
  try { await desktop.selectTarget(); showToast('已进入选择模式，请在目标网页中点击按钮。'); }
  catch (error) { showToast(`无法进入选择模式：${error.message}`); }
}

async function onStart() {
  try { await desktop.start(elements.intervalInput.value); showToast('自动点击已启动。'); }
  catch (error) { showToast(`启动失败：${error.message}`); }
}

async function onStop() {
  try { await desktop.stop(); showToast('已停止并释放唤醒保持。'); }
  catch (error) { showToast(`停止失败：${error.message}`); }
}

async function onExportLogs() {
  try {
    const result = await desktop.exportLogs();
    if (result.status === 'empty') showToast('暂无运行日志可导出。');
    else if (result.status === 'saved') showToast(`运行日志已保存：${result.filePath}`);
  } catch (error) { showToast(`导出失败：${error.message}`); }
}

document.addEventListener('DOMContentLoaded', async () => {
  Object.assign(elements, {
    runtimeBadge: byId('runtimeBadge'), runtimeText: byId('runtimeText'), targetForm: byId('targetForm'), urlInput: byId('urlInput'), showTargetButton: byId('showTargetButton'), selectTargetButton: byId('selectTargetButton'), targetSummary: byId('targetSummary'), intervalInput: byId('intervalInput'), startButton: byId('startButton'), stopButton: byId('stopButton'), runHint: byId('runHint'), clickCount: byId('clickCount'), lastClickAt: byId('lastClickAt'), nextClickAt: byId('nextClickAt'), lastResult: byId('lastResult'), viewLogsButton: byId('viewLogsButton'), exportLogsButton: byId('exportLogsButton'), logView: byId('logView'), logCount: byId('logCount'), toast: byId('toast')
  });
  elements.targetForm.addEventListener('submit', onTargetSubmit);
  elements.showTargetButton.addEventListener('click', () => desktop.showTarget().catch((error) => showToast(`显示失败：${error.message}`)));
  elements.selectTargetButton.addEventListener('click', onSelectTarget);
  elements.startButton.addEventListener('click', onStart);
  elements.stopButton.addEventListener('click', onStop);
  elements.viewLogsButton.addEventListener('click', async () => { elements.logView.hidden = !elements.logView.hidden; if (!elements.logView.hidden) await loadLogs(); });
  elements.exportLogsButton.addEventListener('click', onExportLogs);
  desktop.onState(renderState);
  try { renderState(await desktop.getState()); } catch (error) { showToast(`读取状态失败：${error.message}`); }
});

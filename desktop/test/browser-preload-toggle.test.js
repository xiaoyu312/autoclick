'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PRELOAD_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser-preload.js'), 'utf8');

class FakeElement {
  constructor(tagName, { text = '', className = '', attrs = {}, id = '' } = {}) {
    this.tagName = String(tagName).toUpperCase();
    this._textContent = text;
    this.className = className;
    this.id = id;
    this.attrs = { ...attrs };
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.disabled = false;
    this.style = {};
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
  }

  get attributes() {
    return Object.entries(this.attrs).map(([name, value]) => ({ name, value: String(value) }));
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  appendChild(child) { return this.append(child); }

  remove() {
    const siblings = this.parentElement?.children;
    if (!siblings) return;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
  }

  contains(element) {
    return this === element || this.children.some((child) => child.contains(element));
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (matchesSelector(child, selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matchesSelector(element, selector) {
  return selector.split(',').some((part) => {
    const value = part.trim();
    if (value === 'button') return element.tagName === 'BUTTON';
    if (value === '[role="button"]') return element.getAttribute('role') === 'button';
    if (value === '[class*="button"]') return element.className.includes('button');
    if (value === '.product-name') return element.className === 'product-name';
    if (value === '.goods-name' || value === '.item-name' || value === '.title') return element.className === value.substring(1);
    if (value === '[class*="name"]') return element.className.includes('name');
    if (value === '[class*="title"]') return element.className.includes('title');
    if (value === 'svg' || value === 'use' || value === 'path') return element.tagName === value.toUpperCase();
    const attribute = value.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    return Boolean(attribute && element.getAttribute(attribute[1]) !== null
      && (attribute[2] === undefined || element.getAttribute(attribute[1]) === attribute[2]));
  });
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.documentElement = this.body;
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  createElement(tagName) { return new FakeElement(tagName); }

  addEventListener() {}

  removeEventListener() {}
}

function makeHarness({
  initialState = '讲解',
  transitionDelayMs = 0,
  transition = true,
  deepContext = false,
  extraProductName = null,
  routeOnFirstClick = false,
  initialUrl = 'https://example.test/tools/library',
  routeUrl = 'https://example.test/tools/interaction'
} = {}) {
  const documentObject = new FakeDocument();
  const observers = new Set();
  const results = [];
  const ipcListeners = new Map();
  let clickCount = 0;
  let currentState = initialState;
  const locationObject = { href: initialUrl };

  class HarnessMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {
      observers.add(this);
    }

    disconnect() {
      observers.delete(this);
    }
  }

  function notifyMutation() {
    for (const observer of [...observers]) observer.callback([]);
  }

  function buildRow(state) {
    const row = new FakeElement('div', {
      className: deepContext ? `product-row rebuilt-${clickCount}` : 'product-row',
      attrs: deepContext ? { 'data-runtime-version': String(clickCount) } : {}
    });
    const anchor = row.append(new FakeElement('div', { className: 'product-name', text: 'Harness Product' }));
    const toolbar = row.append(new FakeElement('div', { className: 'toggle-toolbar' }));
    const button = toolbar.append(new FakeElement('button', {
      className: `toggle-button state-${state === '取消讲解' ? 'on' : 'off'}`,
      text: state,
      attrs: { type: 'button', 'data-toggle-action': 'explain' }
    }));
    button.append(new FakeElement('svg', { className: `icon-${state === '取消讲解' ? 'on' : 'off' }` }))
      .append(new FakeElement('path', { attrs: { d: `M${state}${clickCount}Z` } }));
    button.click = () => {
      clickCount += 1;
      if (routeOnFirstClick && clickCount === 1) locationObject.href = routeUrl;
      if (!transition) return;
      const nextState = state === '讲解' ? '取消讲解' : '讲解';
      setTimeout(() => {
        currentState = nextState;
        documentObject.body.children = [];
        documentObject.body.childNodes = [];
        documentObject.body.append(buildRow(nextState).row);
        notifyMutation();
      }, transitionDelayMs);
    };
    if (deepContext) {
      row.children = [anchor];
      row.childNodes = [anchor];
      toolbar.parentElement = null;
      let branch = row;
      for (let index = 0; index < 24 + (clickCount % 3); index += 1) branch = branch.append(new FakeElement('div', { className: `runtime-wrapper-${index}` }));
      if (clickCount > 0) branch.append(new FakeElement('div', { className: 'runtime-extra-child' }));
      branch.append(toolbar);
    }
    if (extraProductName) row.append(new FakeElement('div', { className: 'goods-name', text: extraProductName }));
    return { row, button };
  }

  documentObject.body.append(buildRow(initialState).row);
  const ipcRenderer = {
    send(_channel, value) { results.push(value); },
    on(type, handler) { ipcListeners.set(type, handler); }
  };
  const context = {
    document: documentObject,
    location: locationObject,
    MutationObserver: HarnessMutationObserver,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    window: { addEventListener() {} },
    ipcRenderer,
    require: (name) => {
      if (name === 'electron') return { ipcRenderer };
      throw new Error(`unexpected require: ${name}`);
    }
  };
  const exposed = vm.runInNewContext(`${PRELOAD_SOURCE}\n({ createDescriptor, executeClick })`, context);
  const descriptor = exposed.createDescriptor(documentObject.querySelector('button'));
  return {
    descriptor,
    documentObject,
    exposed,
    results,
    sendCommand(command) {
      ipcListeners.get('autoclick:browser-command')?.({}, command);
    },
    get clickCount() { return clickCount; },
    get currentState() { return currentState; },
    get location() { return locationObject; },
    get button() { return documentObject.querySelector('button'); }
  };
}

async function runExecute(harness, requestId = 'request-1') {
  await harness.exposed.executeClick(requestId, harness.descriptor);
  return harness.results.filter((entry) => entry.type === 'click-result' && entry.requestId === requestId);
}

test('preload waits for a delayed replacement before reporting toggle success', async () => {
  const harness = makeHarness({ initialState: '讲解', transitionDelayMs: 25 });
  const results = await runExecute(harness);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
  assert.equal(results[0].domClicks, 1);
  assert.equal(harness.clickCount, 1);
  assert.equal(harness.currentState, '取消讲解');
});

test('preload keeps a controlled toggle alive across a same-origin SPA route change', async () => {
  const harness = makeHarness({ initialState: '讲解', transitionDelayMs: 10, routeOnFirstClick: true });
  const firstResults = await runExecute(harness, 'route-first');
  assert.equal(firstResults.length, 1);
  assert.equal(firstResults[0].success, true);
  assert.equal(firstResults[0].domClicks, 1);
  assert.equal(harness.location.href, 'https://example.test/tools/interaction');

  const secondResults = await runExecute(harness, 'route-second');
  assert.equal(secondResults.length, 1);
  assert.equal(secondResults[0].success, true);
  assert.equal(secondResults[0].domClicks, 2);
  assert.equal(harness.currentState, '取消讲解');
  assert.equal(harness.clickCount, 3);
});

test('preload relocates a controlled toggle in a deep rebuilt product context', async () => {
  const harness = makeHarness({ initialState: '讲解', transitionDelayMs: 10, deepContext: true });
  assert.equal(harness.descriptor.container.productRowLocator?.strategy, 'controlled-product-name-toggle');
  const firstResults = await runExecute(harness, 'deep-first');
  assert.equal(firstResults[0]?.success, true);
  assert.equal(firstResults[0]?.domClicks, 1);
  const secondResults = await runExecute(harness, 'deep-second');
  assert.equal(secondResults[0]?.success, true);
  assert.equal(secondResults[0]?.domClicks, 2);
  assert.equal(harness.clickCount, 3);
});

test('preload fails closed when the controlled context contains two product names', async () => {
  const harness = makeHarness({ extraProductName: 'Second Product' });
  assert.equal(harness.descriptor.container.productRowLocator?.strategy, 'unavailable');
  const results = await runExecute(harness, 'ambiguous-selection');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.equal(harness.clickCount, 0);

  const relocated = makeHarness();
  relocated.documentObject.body.children[0].append(new FakeElement('div', {
    className: 'goods-name',
    text: 'Second Product'
  }));
  const relocatedResults = await runExecute(relocated, 'ambiguous-relocation');
  assert.equal(relocatedResults.length, 1);
  assert.equal(relocatedResults[0].success, false);
  assert.equal(relocatedResults[0].success, false);
  assert.equal(relocated.clickCount, 0);
});

test('preload accepts a semantic tag change for controlled toggles', async () => {
  const harness = makeHarness({ initialState: '取消讲解', transitionDelayMs: 10 });
  const button = harness.button;
  button.tagName = 'DIV';
  button.attrs.role = 'button';
  const results = await runExecute(harness, 'semantic-tag-change');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
  assert.equal(results[0].domClicks, 2);
  assert.equal(harness.clickCount, 2);
});

test('preload reports bounded page identities for a page mismatch', async () => {
  const harness = makeHarness();
  harness.location.href = 'https://other.example.test/dashboard/live/control?token=should-not-leak#fragment';
  const results = await runExecute(harness, 'mismatch');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.equal(results[0].reason, 'page-mismatch');
  assert.equal(JSON.stringify(results[0].expectedPage), JSON.stringify({
    protocol: 'https:',
    hostname: 'example.test',
    pathname: '/tools/library'
  }));
  assert.equal(JSON.stringify(results[0].currentPage), JSON.stringify({
    protocol: 'https:',
    hostname: 'other.example.test',
    pathname: '/dashboard/live/control'
  }));
  assert.equal(JSON.stringify(results[0]).includes('token'), false);
});

test('preload refuses an ordinary button on a same-DOM pathname change', async () => {
  const harness = makeHarness({ initialState: '普通按钮' });
  harness.location.href = 'https://example.test/tools/interaction';
  const results = await runExecute(harness, 'ordinary-route');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.equal(results[0].reason, 'page-mismatch');
  assert.equal(harness.clickCount, 0);
});

test('preload refuses a controlled toggle after a same-host port change', async () => {
  const harness = makeHarness({
    initialUrl: 'https://example.test:8443/tools/library',
    routeUrl: 'https://example.test:8443/tools/interaction'
  });
  harness.location.href = 'https://example.test:9443/tools/interaction';
  const results = await runExecute(harness, 'port-mismatch');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.equal(results[0].reason, 'page-mismatch');
  assert.equal(harness.clickCount, 0);
});

test('preload fails closed on a toggle timeout and disabled target', async () => {
  const timeoutHarness = makeHarness({ initialState: '讲解', transition: false });
  const timeoutResults = await runExecute(timeoutHarness, 'timeout');
  assert.equal(timeoutResults.length, 1);
  assert.equal(timeoutResults[0].success, false);
  assert.equal(timeoutResults[0].reason, 'toggle-state-timeout');
  assert.equal(timeoutHarness.clickCount, 1);

  const disabledHarness = makeHarness({ initialState: '讲解' });
  disabledHarness.button.disabled = true;
  const disabledResults = await runExecute(disabledHarness, 'disabled');
  assert.equal(disabledResults.length, 1);
  assert.equal(disabledResults[0].success, false);
  assert.equal(disabledResults[0].reason, 'target-disabled');
  assert.equal(disabledHarness.clickCount, 0);
});

test('preload requires the expected pre-click state after a reversal', async () => {
  const harness = makeHarness({ initialState: '取消讲解', transitionDelayMs: 10 });
  let reversalClicks = 0;
  let firstRead = true;
  const originalButton = harness.button;
  Object.defineProperty(originalButton, 'textContent', {
    configurable: true,
    get() {
      if (firstRead) {
        firstRead = false;
        harness.documentObject.body.children = [];
        harness.documentObject.body.childNodes = [];
        harness.documentObject.body.append((() => {
          const replacement = new FakeElement('div', { className: 'product-row' });
          replacement.append(new FakeElement('div', { className: 'product-name', text: 'Harness Product' }));
          const toolbar = replacement.append(new FakeElement('div', { className: 'toggle-toolbar' }));
          const replacementButton = toolbar.append(new FakeElement('button', {
            className: 'toggle-button state-off',
            text: '讲解',
            attrs: { type: 'button', 'data-toggle-action': 'explain' }
          }));
          replacementButton.append(new FakeElement('svg')).append(new FakeElement('path', { attrs: { d: 'MreverseZ' } }));
          replacementButton.click = () => { reversalClicks += 1; };
          return replacement;
        })());
      }
      return '取消讲解';
    }
  });
  const results = await runExecute(harness, 'reversal');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.notEqual(results[0].reason, 'target-missing');
  assert.equal(reversalClicks, 0);
});

test('cancel command stops an old toggle before restart and prevents stale success', async () => {
  const harness = makeHarness({ initialState: '取消讲解', transitionDelayMs: 60 });
  const oldExecution = harness.exposed.executeClick('old-request', harness.descriptor);
  await new Promise((resolve) => setTimeout(resolve, 5));
  harness.sendCommand({ type: 'cancel-execute', requestId: 'old-request' });
  const clicksAtCancel = harness.clickCount;
  const newExecution = harness.exposed.executeClick('new-request', harness.descriptor);
  await Promise.all([oldExecution, newExecution]);
  const oldResults = harness.results.filter((entry) => entry.type === 'click-result' && entry.requestId === 'old-request');
  const newResults = harness.results.filter((entry) => entry.type === 'click-result' && entry.requestId === 'new-request');
  assert.equal(oldResults.length, 0);
  assert.equal(newResults.length, 1);
  assert.equal(newResults[0].success, true);
  assert.equal(harness.clickCount, clicksAtCancel + 2);
});

test('entering selection mode cancels the old toggle before it can click again', async () => {
  const harness = makeHarness({ initialState: '取消讲解', transitionDelayMs: 60 });
  const oldExecution = harness.exposed.executeClick('selection-old', harness.descriptor);
  await new Promise((resolve) => setTimeout(resolve, 5));
  harness.sendCommand({ type: 'start-selection' });
  const clicksAtSelection = harness.clickCount;
  await oldExecution;
  const oldResults = harness.results.filter((entry) => entry.type === 'click-result' && entry.requestId === 'selection-old');
  assert.equal(oldResults.length, 0);
  assert.equal(harness.clickCount, clicksAtSelection);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSelectionTarget,
  createTargetDescriptor,
  createProductRowFingerprint,
  relocateTarget,
  boundedPageIdentity
} = require('../src/shared/target');

class FakeElement {
  constructor(tagName, { text = '', className = '', id = '', attrs = {} } = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.className = className;
    this.id = id;
    this.parentElement = null;
    this.children = [];
    this.attrs = { ...attrs };
    this.attributes = Object.entries(this.attrs).map(([name, value]) => ({ name, value: String(value) }));
    this.childNodes = [];
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selector.includes('button') && current.tagName === 'BUTTON') return current;
      if (selector.includes('a') && current.tagName === 'A') return current;
      if (selector.includes('[role="button"]') && current.getAttribute('role') === 'button') return current;
      if (selector.includes('[class*="button"]') && current.className.includes('button')) return current;
      if (selector.includes('[class*="item"]') && current.className.includes('item')) return current;
      if (selector.includes('[class*="product"]') && current.className.includes('product')) return current;
      if (selector.includes('[class*="goods"]') && current.className.includes('goods')) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (matches(child, selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matches(element, selector) {
  return selector.split(',').some((part) => {
    const value = part.trim();
    if (value === 'button') return element.tagName === 'BUTTON';
    if (value === 'a[href]' || value === 'a') return element.tagName === 'A' && (value === 'a' || element.getAttribute('href') !== null);
    if (value === '[role="button"]') return element.getAttribute('role') === 'button';
    if (value === '[class*="button"]') return element.className.includes('button');
    if (value === '[class*="item"]') return element.className.includes('item');
    if (value === '[class*="product"]') return element.className.includes('product');
    if (value === '[class*="goods"]') return element.className.includes('goods');
    if (value === '[class*="row"]') return element.className.includes('row');
    if (value === '[class*="name"]') return element.className.includes('name');
    if (value === '[class*="title"]' || value === '.title') return element.className.includes('title');
    if (value === '.product-name') return element.className === 'product-name';
    if (['svg', 'use', 'path'].includes(value)) return element.tagName === value.toUpperCase();
    const attr = value.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    if (attr) return element.getAttribute(attr[1]) !== null && (attr[2] === undefined || element.getAttribute(attr[1]) === attr[2]);
    if (value.startsWith('a[href*="')) {
      const fragment = value.match(/a\[href\*="([^"]+)"\]/)?.[1];
      return element.tagName === 'A' && String(element.getAttribute('href') || '').includes(fragment);
    }
    return false;
  });
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
}

function makeFixture(productId = '42') {
  const documentObject = new FakeDocument();
  const row = documentObject.body.append(new FakeElement('div', { className: 'product-row', attrs: { 'data-product-id': productId } }));
  row.append(new FakeElement('div', { className: 'product-name', text: '示例商品' }));
  const button = row.append(new FakeElement('button', { text: '讲解', attrs: { type: 'button', 'data-action': 'explain' } }));
  const nested = button.append(new FakeElement('span', { text: '讲解' }));
  return { documentObject, row, button, nested };
}

function makeProductRowFixture(names = ['上传视频一键清理风险素材', '另一个商品'], paths = []) {
  const documentObject = new FakeDocument();
  const rows = names.map((name, index) => {
    const row = documentObject.body.append(new FakeElement('div', { className: 'creative-card' }));
    const anchor = row.append(new FakeElement('div', { className: 'product-name', text: name }));
    const toolbar = row.append(new FakeElement('div', { className: 'card-toolbar' }));
    const button = toolbar.append(new FakeElement('button', {
      className: 'ovui-button ovui-button-icon',
      attrs: { type: 'button', 'data-okee-fill': 'true', 'data-e2e': 'button' }
    }));
    const svg = button.append(new FakeElement('svg'));
    svg.append(new FakeElement('path', { attrs: { d: paths[index] || `M${index}Z` } }));
    return { row, anchor, toolbar, button };
  });
  return { documentObject, rows };
}

function makeToggleRowFixture({ names = ['讲解商品'], states = ['讲解'], paths = [] } = {}) {
  const documentObject = new FakeDocument();
  const rows = names.map((name, index) => {
    const state = states[index] || '讲解';
    const row = documentObject.body.append(new FakeElement('div', { className: 'product-row' }));
    const anchor = row.append(new FakeElement('div', { className: 'product-name', text: name }));
    const toolbar = row.append(new FakeElement('div', { className: 'toggle-toolbar' }));
    const button = toolbar.append(new FakeElement('button', {
      className: `toggle-button state-${state === '取消讲解' ? 'on' : 'off'}`,
      text: state,
      attrs: { type: 'button', 'data-toggle-action': 'explain' }
    }));
    const svg = button.append(new FakeElement('svg', { className: `icon-${state === '取消讲解' ? 'on' : 'off'}` }));
    svg.append(new FakeElement('path', { attrs: { d: paths[index] || `M${index}Z` } }));
    return { row, anchor, toolbar, button };
  });
  return { documentObject, rows };
}

function makeDeepToggleRowFixture({ state = '讲解', productName = '深层讲解商品' } = {}) {
  const fixture = makeToggleRowFixture({ names: [productName], states: [state] });
  const row = fixture.rows[0].row;
  const anchor = fixture.rows[0].anchor;
  const toolbar = fixture.rows[0].toolbar;
  row.children = [anchor];
  row.childNodes = [anchor];
  anchor.parentElement = row;
  toolbar.parentElement = null;
  let branch = row;
  for (let index = 0; index < 24; index += 1) branch = branch.append(new FakeElement('div', { className: `runtime-wrapper-${index}` }));
  branch.append(toolbar);
  return fixture;
}

function insertChildBefore(parent, child, index) {
  child.parentElement = parent;
  parent.children.splice(index, 0, child);
  parent.childNodes.splice(index, 0, child);
}

function appendIconButton(row, path) {
  const toolbar = row.children[1];
  const button = toolbar.append(new FakeElement('button', {
    className: 'ovui-button ovui-button-icon',
    attrs: { type: 'button', 'data-okee-fill': 'true', 'data-e2e': 'button' }
  }));
  const svg = button.append(new FakeElement('svg'));
  svg.append(new FakeElement('path', { attrs: { d: path } }));
  return button;
}

function addAttributes(element, entries) {
  for (const [name, value] of Object.entries(entries)) {
    element.attrs[name] = String(value);
    element.attributes.push({ name, value: String(value) });
  }
}

function markProductRows(fixture) {
  for (const row of fixture.rows) row.row.className = 'product-row';
  return fixture;
}

function widenRow(row, count) {
  for (let index = 0; index < count; index += 1) row.append(new FakeElement('div', { className: `row-sibling-${index}` }));
}

function indexedCollection(values, length, onIndex) {
  return new Proxy({ length }, {
    get(target, property) {
      if (property === 'length') return target.length;
      if (property === Symbol.iterator) return undefined;
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        onIndex?.(Number(property));
        return values[Number(property)];
      }
      return target[property];
    }
  });
}

test('selection prefers semantic clickable ancestor over nested span or class fallback', () => {
  const fixture = makeFixture();
  assert.equal(resolveSelectionTarget(fixture.nested), fixture.button);

  const classOnly = new FakeElement('span', { text: '操作' });
  const classButton = new FakeElement('div', { className: 'icon-button-shell' });
  classButton.append(classOnly);
  assert.equal(resolveSelectionTarget(classOnly), classButton);

  const plain = new FakeElement('span', { text: '文本' });
  assert.equal(resolveSelectionTarget(plain), plain);
});

test('descriptor relocates the same product and semantic target after DOM replacement', () => {
  const first = makeFixture();
  const descriptor = createTargetDescriptor(first.button, 'https://example.test/live/room', first.documentObject);
  assert.equal(descriptor.target.tagName, 'button');
  assert.equal(descriptor.container.productId, '42');
  assert.deepEqual(descriptor.container.productRowLocator?.toggleLabels, ['讲解', '取消讲解']);

  const second = makeFixture();
  const relocated = relocateTarget(second.documentObject, descriptor, 'https://example.test/live/room');
  assert.equal(relocated, second.button);
});

test('ambiguous global matches are rejected for safety', () => {
  const documentObject = new FakeDocument();
  documentObject.body.append(new FakeElement('button', { text: '同名' }));
  documentObject.body.append(new FakeElement('button', { text: '同名' }));
  const descriptor = {
    target: { tagName: 'button', text: '同名', attributes: {} },
    pageRule: { protocol: 'https:', hostname: 'example.test', pathname: '/room' }
  };
  assert.equal(relocateTarget(documentObject, descriptor, 'https://example.test/room'), null);
});

test('product-name icon-only rows get a locator and relocate after DOM replacement', () => {
  const path = `M${'1'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [path, `M${'2'.repeat(240)}Z`]);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  assert.equal(descriptor.container.productName, '上传视频一键清理风险素材');
  assert.ok(descriptor.container.productRowLocator);

  const second = makeProductRowFixture(undefined, [path, `M${'2'.repeat(240)}Z`]);
  assert.equal(relocateTarget(second.documentObject, descriptor, 'https://example.test/tools/library'), second.rows[0].button);
});

test('product-row locator rejects duplicate names and path drift', () => {
  const path = `M${'3'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [path, `M${'4'.repeat(240)}Z`]);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://other.test/any/path', first.documentObject);
  const duplicate = makeProductRowFixture(['上传视频一键清理风险素材', '上传视频一键清理风险素材'], [path, path]);
  assert.equal(relocateTarget(duplicate.documentObject, descriptor, 'https://other.test/any/path'), null);

  const shifted = makeProductRowFixture(undefined, [path, `M${'4'.repeat(240)}Z`]);
  insertChildBefore(shifted.rows[0].row, new FakeElement('div', { className: 'inserted-sibling' }), 2);
  assert.equal(relocateTarget(shifted.documentObject, descriptor, 'https://other.test/any/path'), null);
});

test('product-row fingerprint distinguishes long SVG paths with otherwise identical buttons', () => {
  const pathA = `M${'a'.repeat(240)}Z`;
  const pathB = `M${'b'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [pathA, pathB]);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const replacement = makeProductRowFixture(undefined, [pathA, pathB]);
  assert.equal(relocateTarget(replacement.documentObject, descriptor, 'https://example.test/tools/library'), replacement.rows[0].button);
  const changed = makeProductRowFixture(undefined, [pathB, pathB]);
  assert.equal(relocateTarget(changed.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('a failed product-row locator never falls back to a global generic button', () => {
  const path = `M${'5'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [path, `M${'6'.repeat(240)}Z`]);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const missing = makeProductRowFixture(['其他商品'], [path]);
  assert.equal(relocateTarget(missing.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('product-row locator requires the exact page-rule host and path', () => {
  const path = `M${'7'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [path, `M${'8'.repeat(240)}Z`]);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const replacement = makeProductRowFixture(undefined, [path, `M${'8'.repeat(240)}Z`]);
  assert.equal(relocateTarget(replacement.documentObject, descriptor, 'https://example.test/tools/library/next'), null);
  assert.equal(relocateTarget(replacement.documentObject, descriptor, 'https://other.test/tools/library'), null);
});

test('product-row locator requires a unique endpoint fingerprint within the container', () => {
  const path = `M${'9'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [path, `M${'a'.repeat(240)}Z`]);
  appendIconButton(first.rows[0].row, path);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  assert.equal(descriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(first.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('product-name locator rejects duplicate exact text across selector classes', () => {
  const path = `M${'b'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [path, `M${'c'.repeat(240)}Z`]);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const replacement = makeProductRowFixture(undefined, [path, `M${'c'.repeat(240)}Z`]);
  replacement.rows[1].row.append(new FakeElement('div', { className: 'goods-name', text: '上传视频一键清理风险素材' }));
  assert.equal(relocateTarget(replacement.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('product-row fingerprint keeps root and SVG descendant budgets independent', () => {
  const pathA = `M${'d'.repeat(240)}Z`;
  const pathB = `M${'e'.repeat(240)}Z`;
  const first = makeProductRowFixture(undefined, [pathA, pathB]);
  addAttributes(first.rows[0].button, Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`data-root-${index}`, `value-${index}`])));
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const changed = makeProductRowFixture(undefined, [pathB, pathB]);
  addAttributes(changed.rows[0].button, Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`data-root-${index}`, `value-${index}`])));
  assert.equal(relocateTarget(changed.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('product-row fingerprint bounds indexed child and attribute traversal', () => {
  let childReads = 0;
  const endpointWithManyChildren = new FakeElement('button');
  endpointWithManyChildren.children = indexedCollection([], 1000, () => { childReads += 1; });
  assert.equal(createProductRowFingerprint(endpointWithManyChildren), null);
  assert.ok(childReads <= 64);

  let attributeReads = 0;
  const endpointWithManyAttributes = new FakeElement('button');
  endpointWithManyAttributes.attributes = indexedCollection([], 1000, () => { attributeReads += 1; });
  assert.equal(createProductRowFingerprint(endpointWithManyAttributes), null);
  assert.ok(attributeReads <= 64);
});

test('product-row sentinel prevents legacy first-match fallback for duplicate endpoints', () => {
  const path = `M${'f'.repeat(240)}Z`;
  const first = markProductRows(makeProductRowFixture(undefined, [path, path]));
  appendIconButton(first.rows[1].row, path);
  const descriptor = createTargetDescriptor(first.rows[1].button, 'https://example.test/tools/library', first.documentObject);
  assert.equal(descriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(first.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('product-row sentinel covers oversized root and descendant attributes', () => {
  const path = `M${'g'.repeat(240)}Z`;
  const rootAttrs = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`data-root-${index}`, `value-${index}`]));
  const rootCase = markProductRows(makeProductRowFixture(undefined, [path, path]));
  addAttributes(rootCase.rows[1].button, rootAttrs);
  const rootDescriptor = createTargetDescriptor(rootCase.rows[1].button, 'https://example.test/tools/library', rootCase.documentObject);
  assert.equal(rootDescriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(rootCase.documentObject, rootDescriptor, 'https://example.test/tools/library'), null);

  const descendantCase = markProductRows(makeProductRowFixture(undefined, [path, path]));
  addAttributes(descendantCase.rows[1].button.children[0], rootAttrs);
  const descendantDescriptor = createTargetDescriptor(descendantCase.rows[1].button, 'https://example.test/tools/library', descendantCase.documentObject);
  assert.equal(descendantDescriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(descendantCase.documentObject, descendantDescriptor, 'https://example.test/tools/library'), null);
});

test('product-row sentinel covers a path with too many siblings for bounded indexing', () => {
  const path = `M${'h'.repeat(240)}Z`;
  const fixture = markProductRows(makeProductRowFixture(undefined, [path, path]));
  widenRow(fixture.rows[1].row, 70);
  const descriptor = createTargetDescriptor(fixture.rows[1].button, 'https://example.test/tools/library', fixture.documentObject);
  assert.equal(descriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(fixture.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('controlled explain toggle relocates across both states and changed endpoint identity', () => {
  const first = makeToggleRowFixture({ states: ['讲解'], paths: [`M${'i'.repeat(80)}Z`] });
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  assert.deepEqual(descriptor.container.productRowLocator?.toggleLabels, ['讲解', '取消讲解']);

  const second = makeToggleRowFixture({ states: ['取消讲解'], paths: [`M${'j'.repeat(80)}Z`] });
  assert.equal(relocateTarget(second.documentObject, descriptor, 'https://example.test/tools/library'), second.rows[0].button);

  const reverseDescriptor = createTargetDescriptor(second.rows[0].button, 'https://example.test/tools/library', second.documentObject);
  assert.deepEqual(reverseDescriptor.container.productRowLocator?.toggleLabels, ['讲解', '取消讲解']);
  const reverse = makeToggleRowFixture({ states: ['讲解'], paths: [`M${'k'.repeat(80)}Z`] });
  assert.equal(relocateTarget(reverse.documentObject, reverseDescriptor, 'https://example.test/tools/library'), reverse.rows[0].button);
});

test('controlled explain toggle requires one allowed label in the unique product row', () => {
  const first = makeToggleRowFixture({ states: ['讲解'] });
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const duplicate = makeToggleRowFixture({ states: ['讲解'] });
  const duplicateButton = duplicate.rows[0].toolbar.append(new FakeElement('button', {
    className: 'another-toggle-button',
    text: '取消讲解',
    attrs: { type: 'button', 'data-toggle-action': 'explain' }
  }));
  duplicateButton.append(new FakeElement('svg')).append(new FakeElement('path', { attrs: { d: 'MduplicateZ' } }));
  assert.equal(relocateTarget(duplicate.documentObject, descriptor, 'https://example.test/tools/library'), null);

  const duplicateName = makeToggleRowFixture({ names: ['讲解商品', '讲解商品'], states: ['取消讲解', '讲解'] });
  assert.equal(relocateTarget(duplicateName.documentObject, descriptor, 'https://example.test/tools/library'), null);
});

test('controlled explain toggle survives row path, witness, and endpoint rebuild', () => {
  const first = makeToggleRowFixture({ states: ['讲解'] });
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const shifted = makeToggleRowFixture({ states: ['取消讲解'] });
  insertChildBefore(shifted.rows[0].row, new FakeElement('div', { className: 'inserted-sibling' }), 1);
  shifted.rows[0].row.className = 'rebuilt-product-row';
  shifted.rows[0].button.className = 'rebuilt-toggle';
  shifted.rows[0].button.attrs['data-toggle-action'] = 'rebuilt-explain';
  assert.equal(relocateTarget(shifted.documentObject, descriptor, 'https://example.test/tools/library'), shifted.rows[0].button);
});

test('controlled explain toggle creates and consumes a deep context locator after structural rebuild', () => {
  const first = makeDeepToggleRowFixture({ state: '讲解' });
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  assert.equal(descriptor.container.productRowLocator?.strategy, 'controlled-product-name-toggle');
  assert.equal(descriptor.container.productRowLocator?.productName, '深层讲解商品');

  const replacement = makeDeepToggleRowFixture({ state: '取消讲解' });
  replacement.rows[0].row.className = 'new-runtime-card';
  replacement.rows[0].row.append(new FakeElement('div', { className: 'runtime-extra-sibling' }));
  replacement.rows[0].button.className = 'new-state-class';
  replacement.rows[0].button.attrs['data-toggle-action'] = 'new-action';
  assert.equal(relocateTarget(replacement.documentObject, descriptor, 'https://example.test/tools/library'), replacement.rows[0].button);
});

test('controlled explain toggle locator fails closed when no unique context or semantic target exists', () => {
  const noName = makeDeepToggleRowFixture();
  noName.rows[0].anchor.className = 'runtime-label';
  const noNameDescriptor = createTargetDescriptor(noName.rows[0].button, 'https://example.test/tools/library', noName.documentObject);
  assert.equal(noNameDescriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(noName.documentObject, noNameDescriptor, 'https://example.test/tools/library'), null);

  const nonSemantic = makeDeepToggleRowFixture();
  nonSemantic.rows[0].button.tagName = 'DIV';
  const nonSemanticDescriptor = createTargetDescriptor(nonSemantic.rows[0].button, 'https://example.test/tools/library', nonSemantic.documentObject);
  assert.equal(nonSemanticDescriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(nonSemantic.documentObject, nonSemanticDescriptor, 'https://example.test/tools/library'), null);
});

test('controlled explain toggle rejects a minimum context containing two unique product names', () => {
  const ambiguous = makeDeepToggleRowFixture();
  ambiguous.rows[0].row.append(new FakeElement('div', { className: 'goods-name', text: '第二商品' }));
  const descriptor = createTargetDescriptor(ambiguous.rows[0].button, 'https://example.test/tools/library', ambiguous.documentObject);
  assert.equal(descriptor.container.productRowLocator?.strategy, 'unavailable');
  assert.equal(relocateTarget(ambiguous.documentObject, descriptor, 'https://example.test/tools/library'), null);

  const first = makeToggleRowFixture({ states: ['讲解'] });
  const validDescriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const rebuilt = makeToggleRowFixture({ states: ['取消讲解'] });
  rebuilt.rows[0].row.append(new FakeElement('div', { className: 'goods-name', text: '第二商品' }));
  assert.equal(relocateTarget(rebuilt.documentObject, validDescriptor, 'https://example.test/tools/library'), null);
});

test('controlled explain toggle accepts a semantic tag change while ordinary locators stay strict', () => {
  const first = makeToggleRowFixture({ states: ['讲解'] });
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/tools/library', first.documentObject);
  const rebuilt = makeToggleRowFixture({ states: ['取消讲解'] });
  rebuilt.rows[0].button.tagName = 'DIV';
  rebuilt.rows[0].button.attrs.role = 'button';
  assert.equal(relocateTarget(rebuilt.documentObject, descriptor, 'https://example.test/tools/library'), rebuilt.rows[0].button);

  const ordinary = makeProductRowFixture(undefined, [`M${'s'.repeat(80)}Z`]);
  const ordinaryDescriptor = createTargetDescriptor(ordinary.rows[0].button, 'https://example.test/tools/library', ordinary.documentObject);
  const ordinaryReplacement = makeProductRowFixture(undefined, [`M${'s'.repeat(80)}Z`]);
  ordinaryReplacement.rows[0].button.tagName = 'DIV';
  ordinaryReplacement.rows[0].button.attrs.role = 'button';
  assert.equal(relocateTarget(ordinaryReplacement.documentObject, ordinaryDescriptor, 'https://example.test/tools/library'), null);
});

test('controlled explain toggle tolerates same-origin SPA pathname changes', () => {
  const first = makeToggleRowFixture({ states: ['讲解'] });
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://buyin.jinritemai.com:8443/dashboard/live/control', first.documentObject);
  assert.equal(descriptor.pageRule.port, '8443');
  const replacement = makeToggleRowFixture({ states: ['取消讲解'] });

  assert.equal(
    relocateTarget(replacement.documentObject, descriptor, 'https://buyin.jinritemai.com:8443/dashboard/live/interaction'),
    replacement.rows[0].button
  );
  assert.equal(
    relocateTarget(replacement.documentObject, descriptor, 'https://other.example/dashboard/live/interaction'),
    null
  );
  assert.equal(
    relocateTarget(replacement.documentObject, descriptor, 'http://buyin.jinritemai.com/dashboard/live/interaction'),
    null
  );
  assert.equal(
    relocateTarget(replacement.documentObject, descriptor, 'https://buyin.jinritemai.com:9443/dashboard/live/interaction'),
    null
  );

  const legacyDescriptor = createTargetDescriptor(first.rows[0].button, 'https://buyin.jinritemai.com:8443/dashboard/live/control', first.documentObject);
  delete legacyDescriptor.pageRule.port;
  assert.equal(
    relocateTarget(replacement.documentObject, legacyDescriptor, 'https://buyin.jinritemai.com:8443/dashboard/live/interaction'),
    replacement.rows[0].button
  );
  delete legacyDescriptor.pageRule.fullUrl;
  assert.equal(
    relocateTarget(replacement.documentObject, legacyDescriptor, 'https://buyin.jinritemai.com:8443/dashboard/live/interaction'),
    null
  );

  const defaultLegacyDescriptor = createTargetDescriptor(first.rows[0].button, 'https://buyin.jinritemai.com/dashboard/live/control', first.documentObject);
  delete defaultLegacyDescriptor.pageRule.port;
  delete defaultLegacyDescriptor.pageRule.fullUrl;
  assert.equal(
    relocateTarget(replacement.documentObject, defaultLegacyDescriptor, 'https://buyin.jinritemai.com/dashboard/live/interaction'),
    replacement.rows[0].button
  );
  assert.equal(
    relocateTarget(replacement.documentObject, defaultLegacyDescriptor, 'https://buyin.jinritemai.com:8443/dashboard/live/interaction'),
    null
  );
});

test('ordinary product-row locator keeps exact pathname matching after SPA navigation', () => {
  const first = makeProductRowFixture(undefined, [`M${'r'.repeat(80)}Z`]);
  const descriptor = createTargetDescriptor(first.rows[0].button, 'https://example.test/dashboard/live/control', first.documentObject);
  const replacement = makeProductRowFixture(undefined, [`M${'r'.repeat(80)}Z`]);
  assert.equal(
    relocateTarget(replacement.documentObject, descriptor, 'https://example.test/dashboard/live/interaction'),
    null
  );
  assert.equal(relocateTarget(replacement.documentObject, descriptor, 'https://example.test/dashboard/live/control'), replacement.rows[0].button);
});

test('ordinary descriptor refuses a same-DOM pathname change', () => {
  const first = makeFixture();
  first.button.textContent = '普通按钮';
  first.nested.textContent = '普通按钮';
  const descriptor = createTargetDescriptor(first.button, 'https://example.test/dashboard/live/control', first.documentObject);
  assert.equal(relocateTarget(first.documentObject, descriptor, 'https://example.test/dashboard/live/interaction'), null);
});

test('bounded page identity rejects malformed trusted IPC fields without leaking URL data', () => {
  const valid = boundedPageIdentity({
    protocol: 'https:',
    hostname: 'buyin.jinritemai.com',
    pathname: '/dashboard/live/control',
    fullUrl: 'https://buyin.jinritemai.com/dashboard/live/control?token=secret#fragment'
  });
  assert.deepEqual(valid, {
    protocol: 'https:',
    hostname: 'buyin.jinritemai.com',
    pathname: '/dashboard/live/control'
  });
  for (const value of [
    { protocol: 'https:', hostname: 'good?evil', pathname: '/path' },
    { protocol: 'https:', hostname: 'good/evil', pathname: '/path' },
    { protocol: 'https:', hostname: 'good evil', pathname: '/path' },
    { protocol: 'https:', hostname: 'good:8443', pathname: '/path' },
    { protocol: 'https:', hostname: 'evil&host', pathname: '/path' },
    { protocol: 'https:', hostname: 'evil=host', pathname: '/path' },
    { protocol: 'https:', hostname: 'evil\\host', pathname: '/path' },
    { protocol: 'https:', hostname: 'bad%20host', pathname: '/path' },
    { protocol: 'https:', hostname: 'good', pathname: 'relative/path' },
    { protocol: 'https:', hostname: 'good', pathname: '/path?token=secret' },
    { protocol: 'https:', hostname: 'good', pathname: '/path#fragment' },
    { protocol: 'https:', hostname: 'good', pathname: '/https://secret.test/private' },
    { protocol: 'https:', hostname: 'good', pathname: '/HTTPS://secret.test/private' },
    { protocol: 'https:', hostname: 'good', pathname: '/token=secret&x=y' },
    { protocol: 'https:', hostname: 'good', pathname: '/encoded%3A%2F%2Fsecret.test' },
    { protocol: 'https:', hostname: 'good', pathname: `/${'x'.repeat(2048)}` }
  ]) assert.equal(boundedPageIdentity(value), null);
});

test('ordinary text button changes retain legacy fail-closed matching', () => {
  const first = makeFixture();
  first.button.textContent = '普通开始';
  const descriptor = createTargetDescriptor(first.button, 'https://example.test/live/room', first.documentObject);
  const changed = makeFixture();
  changed.button.textContent = '普通结束';
  assert.equal(descriptor.container.productRowLocator, undefined);
  assert.equal(relocateTarget(changed.documentObject, descriptor, 'https://example.test/live/room'), null);
});

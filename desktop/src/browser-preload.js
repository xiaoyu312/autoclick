'use strict';

// This preload is the only code with DOM access in the target window. It is
// sandboxed and exposes no API to the remote page; commands arrive from the
// trusted main process through the private IPC channel below.
const { ipcRenderer } = require('electron');

const CLICKABLE_SELECTOR = 'button, a, [role="button"], [class*="button"]';
const SEMANTIC_SELECTOR = 'button, a, [role="button"]';
const ID_ATTRIBUTES = ['data-product-id', 'data-goods-id', 'data-item-id', 'data-sku-id', 'data-id'];
const PRODUCT_NAME_SELECTORS = ['.product-name', '.goods-name', '.item-name', '.title', '[class*="name"]', '[class*="title"]'];
const PRODUCT_ROW_LOCATOR_MAX_DEPTH = 15;
const PRODUCT_ROW_FINGERPRINT_MAX_NODES = 64;
const PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTES = 16;
const PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS = 64;
const PRODUCT_ROW_FINGERPRINT_MAX_MARKERS = 15;
const PRODUCT_ROW_FINGERPRINT_TAGS = new Set(['SVG', 'USE', 'PATH']);
const PRODUCT_ROW_FINGERPRINT_ATTRIBUTE_NAMES = new Set(['aria-label', 'data-icon', 'data-e2e', 'data-okee-fill', 'd', 'fill', 'href', 'name', 'role', 'title', 'type', 'xlink:href']);
const PRODUCT_ROW_TOGGLE_LABELS = Object.freeze(['讲解', '取消讲解']);
const CONTROLLED_PRODUCT_ROW_LOCATOR_MAX_DEPTH = 64;
const TOGGLE_STATE_WAIT_TIMEOUT_MS = 1500;
let selectionMode = false;
let overlay = null;
let highlighted = null;
let activeExecution = null;
let executionGeneration = 0;

function send(event) {
  try { ipcRenderer.send('autoclick:browser-event', event); } catch (_) { /* renderer may be exiting */ }
}

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').replace(/\n+/g, ' ').substring(0, 200);
}

function toggleLabelsForText(value) {
  return PRODUCT_ROW_TOGGLE_LABELS.includes(normalizeText(value)) ? [...PRODUCT_ROW_TOGGLE_LABELS] : null;
}

function normalizeToggleLabels(value) {
  return Array.isArray(value) && value.length === PRODUCT_ROW_TOGGLE_LABELS.length
    && value.every((label, index) => label === PRODUCT_ROW_TOGGLE_LABELS[index])
    ? [...PRODUCT_ROW_TOGGLE_LABELS]
    : null;
}

function resolveSelectionTarget(element) {
  const semantic = element?.closest?.(SEMANTIC_SELECTOR);
  return semantic || element?.closest?.('[class*="button"]') || element;
}

function readAttributes(element) {
  const attributes = {};
  const collection = element?.attributes;
  const length = Math.min(Number(collection?.length || 0), PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS);
  if (!Number.isSafeInteger(length) || length < 0) return attributes;
  for (let index = 0; index < length; index += 1) {
    const attribute = collection[index];
    if (!attribute) continue;
    if (attribute.name.startsWith('data-') || ['href', 'type', 'role', 'aria-label'].includes(attribute.name)) attributes[attribute.name] = attribute.value;
  }
  return attributes;
}

function elementClassName(element) {
  const value = element?.className;
  return String(value && typeof value === 'object' && 'baseVal' in value ? value.baseVal : value || '');
}

function productFingerprintSummary(value) {
  const input = String(value ?? '');
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
    hashB = Math.imul(hashB ^ (code + index), 0x85ebca6b) >>> 0;
  }
  const length = (input.length >>> 0).toString(16).padStart(8, '0');
  return `${length}:${hashA.toString(16).padStart(8, '0')}:${hashB.toString(16).padStart(8, '0')}`;
}

function productFingerprintAttributes(element, remaining) {
  if (!element) return { value: '', count: 0, complete: false };
  const collection = element.attributes;
  const length = Number(collection?.length || 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS) {
    return { value: '', count: 0, complete: false };
  }
  const attributes = [];
  for (let index = 0; index < length; index += 1) {
    const attribute = collection[index];
    if (!attribute) return { value: '', count: 0, complete: false };
    const name = String(attribute.name || '').toLowerCase();
    const value = String(attribute.value || '');
    if (value && (PRODUCT_ROW_FINGERPRINT_ATTRIBUTE_NAMES.has(name) || (name.startsWith('data-') && !name.startsWith('data-v-')))) {
      attributes.push({ name: productFingerprintSummary(name), value: productFingerprintSummary(value) });
    }
  }
  if (attributes.length > remaining) return { value: '', count: attributes.length, complete: false };
  attributes.sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
  return {
    value: attributes.map(({ name, value }) => `${name}=${value}`).join(','),
    count: attributes.length,
    complete: true
  };
}

function createProductRowFingerprint(element) {
  if (!element) return null;
  const queue = [element];
  const markers = [];
  let visited = 0;
  let queued = queue.length;
  const rootAttributes = productFingerprintAttributes(element, PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTES);
  if (!rootAttributes.complete) return null;
  let descendantAttributes = 0;
  while (queue.length && visited < PRODUCT_ROW_FINGERPRINT_MAX_NODES) {
    const current = queue.shift();
    queued -= 1;
    visited += 1;
    const tagName = String(current?.tagName || '').toUpperCase();
    if (PRODUCT_ROW_FINGERPRINT_TAGS.has(tagName)) {
      const attributes = productFingerprintAttributes(current, PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTES - descendantAttributes);
      if (!attributes.complete) return null;
      descendantAttributes += attributes.count;
      markers.push(`${tagName}:${attributes.value}`);
      if (markers.length > PRODUCT_ROW_FINGERPRINT_MAX_MARKERS) return null;
    }
    const children = current?.children;
    const childCount = Number(children?.length || 0);
    if (!Number.isSafeInteger(childCount) || childCount < 0 || visited + queued + childCount > PRODUCT_ROW_FINGERPRINT_MAX_NODES) return null;
    for (let index = 0; index < childCount; index += 1) {
      const child = children[index];
      if (!child) return null;
      queue.push(child);
      queued += 1;
    }
  }
  return {
    tagName: String(element.tagName || '').toUpperCase(),
    className: productFingerprintSummary(elementClassName(element)),
    id: productFingerprintSummary(element.id),
    text: productFingerprintSummary(normalizeText(element.textContent)),
    attributes: rootAttributes.value,
    childElementCount: Number(element.children?.length || 0),
    descendants: markers.join('|')
  };
}

function sameProductRowFingerprint(actual, expected) {
  if (!actual || !expected) return false;
  return actual.tagName === expected.tagName
    && actual.className === expected.className
    && actual.id === expected.id
    && actual.text === expected.text
    && actual.attributes === expected.attributes
    && actual.childElementCount === expected.childElementCount
    && actual.descendants === expected.descendants;
}

function getElementPath(root, element) {
  if (!root || !element) return null;
  if (root === element) return [];
  const path = [];
  let current = element;
  while (current && current !== root) {
    const parent = current.parentElement;
    const children = parent?.children;
    const childCount = Number(children?.length || 0);
    if (!parent || !Number.isSafeInteger(childCount) || childCount < 0 || childCount > PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS) return null;
    let index = -1;
    for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
      if (children[childIndex] === current) {
        index = childIndex;
        break;
      }
    }
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
    if (path.length > PRODUCT_ROW_LOCATOR_MAX_DEPTH) return null;
  }
  return current === root ? path : null;
}

function resolveElementPath(root, path) {
  if (!root || !Array.isArray(path) || path.length > PRODUCT_ROW_LOCATOR_MAX_DEPTH
    || path.some((index) => !Number.isInteger(index) || index < 0)) return null;
  let current = root;
  for (const index of path) {
    const children = current?.children;
    const childCount = Number(children?.length || 0);
    if (!Number.isSafeInteger(childCount) || childCount < 0 || childCount > PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS || index >= childCount) return null;
    current = children[index];
  }
  return current;
}

function createProductRowPathWitness(root, path) {
  if (!root || !Array.isArray(path) || path.length > PRODUCT_ROW_LOCATOR_MAX_DEPTH) return null;
  const witness = [];
  let current = root;
  for (const index of path) {
    const children = current?.children;
    const childCount = Number(children?.length || 0);
    if (!Number.isSafeInteger(childCount) || childCount < 0 || childCount > PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS
      || !Number.isInteger(index) || index < 0 || index >= childCount) return null;
    witness.push({ childCount, index });
    current = children[index];
  }
  return witness;
}

function matchesProductRowPathWitness(root, path, witness) {
  if (!root || !Array.isArray(path) || path.length > PRODUCT_ROW_LOCATOR_MAX_DEPTH
    || !Array.isArray(witness) || witness.length !== path.length || witness.length > PRODUCT_ROW_LOCATOR_MAX_DEPTH) return false;
  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    const step = witness[index];
    const children = current?.children;
    const childCount = Number(children?.length || 0);
    if (!Number.isSafeInteger(childCount) || childCount < 0 || childCount > PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS
      || !step || step.index !== path[index] || step.childCount !== childCount || step.index < 0 || step.index >= childCount) return false;
    current = children[step.index];
  }
  return true;
}

function productRowElementSummary(element) {
  if (!element) return null;
  return {
    tagName: String(element.tagName || '').toUpperCase(),
    className: productFingerprintSummary(elementClassName(element))
  };
}

function matchesProductRowElementSummary(element, summary) {
  return Boolean(element && summary
    && String(element.tagName || '').toUpperCase() === summary.tagName
    && productFingerprintSummary(elementClassName(element)) === summary.className);
}

function isDescendantOf(ancestor, element) {
  let current = element;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentElement;
  }
  return false;
}

function findProductNameAnchor(container, productName) {
  const expected = normalizeText(productName);
  if (!container || !expected) return null;
  const candidates = [];
  for (const selector of PRODUCT_NAME_SELECTORS) {
    for (const candidate of Array.from(container.querySelectorAll?.(selector) || [])) {
      if (normalizeText(candidate.textContent) === expected && !candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  const deepest = candidates.filter((candidate) => !candidates.some((other) => (
    other !== candidate && isDescendantOf(candidate, other) && normalizeText(other.textContent) === expected
  )));
  return deepest.length === 1 ? deepest[0] : null;
}

function findControlledProductNameAnchors(container) {
  if (!container) return [];
  const candidates = [];
  for (const selector of PRODUCT_NAME_SELECTORS) {
    for (const candidate of Array.from(container.querySelectorAll?.(selector) || [])) {
      if (!normalizeText(candidate.textContent) || candidates.includes(candidate)) continue;
      candidates.push(candidate);
    }
  }
  return candidates.filter((candidate) => !candidates.some((other) => (
    other !== candidate
      && normalizeText(other.textContent) === normalizeText(candidate.textContent)
      && isDescendantOf(candidate, other)
  )));
}

function findControlledProductContext(element) {
  if (!element || !PRODUCT_ROW_TOGGLE_LABELS.includes(normalizeText(element.textContent))) return null;
  if (!['BUTTON', 'A'].includes(String(element.tagName || '').toUpperCase())
    && String(element.getAttribute?.('role') || '').toLowerCase() !== 'button') return null;
  let current = element.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < CONTROLLED_PRODUCT_ROW_LOCATOR_MAX_DEPTH) {
    const anchors = findControlledProductNameAnchors(current);
    const toggles = Array.from(current.querySelectorAll(SEMANTIC_SELECTOR)).filter((candidate) => (
      PRODUCT_ROW_TOGGLE_LABELS.includes(normalizeText(candidate.textContent))
    ));
    if (toggles.length === 1 && toggles[0] === element) {
      if (anchors.length === 0) {
        current = current.parentElement;
        depth += 1;
        continue;
      }
      if (anchors.length !== 1) return null;
      const anchor = anchors[0];
      const productName = normalizeText(anchor.textContent);
      const globalAnchors = findProductRowLocatorAnchors({ productName });
      if (globalAnchors.length === 1 && globalAnchors[0] === anchor) return { productName };
      return null;
    }
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

function createControlledProductRowLocator(element) {
  const context = findControlledProductContext(element);
  if (!context) return null;
  return {
    strategy: 'controlled-product-name-toggle',
    productName: context.productName,
    toggleLabels: [...PRODUCT_ROW_TOGGLE_LABELS]
  };
}

function findProductContainerElement(element) {
  let current = element;
  let depth = 0;
  while (current && current !== document.body && depth < PRODUCT_ROW_LOCATOR_MAX_DEPTH) {
    current = current.parentElement;
    depth += 1;
    if (!current) break;
    const features = extractFeatures(current);
    if (features.productId || features.productName || features.href) return current;
  }
  return null;
}

function containerProductName(container) {
  return normalizeText(container?.productName || extractFeatures(container).productName || '');
}

function productRowLocatorApplies(element, container, target) {
  if (!element || !container?.parentElement || !containerProductName(container)) return false;
  if (toggleLabelsForText(target?.text)) return true;
  const globalMatches = Array.from(document.querySelectorAll(CLICKABLE_SELECTOR)).filter((candidate) => matchButton(candidate, target));
  return Boolean((!target.text && !target.id) || globalMatches.length !== 1);
}

function createProductRowLocator(element, container, target) {
  if (!productRowLocatorApplies(element, container, target)) return null;
  const productName = containerProductName(container);
  const anchor = findProductNameAnchor(container, productName);
  if (!anchor) return null;
  const anchorPath = getElementPath(container, anchor);
  const targetPath = getElementPath(container, element);
  const anchorWitness = createProductRowPathWitness(container, anchorPath);
  const targetWitness = createProductRowPathWitness(container, targetPath);
  if (!anchorPath || !targetPath || !anchorWitness || !targetWitness) return null;
  const toggleLabels = toggleLabelsForText(target?.text);
  if (toggleLabels) {
    const matchingToggleTargets = Array.from(container.querySelectorAll(CLICKABLE_SELECTOR)).filter((candidate) => (
      toggleLabels.includes(normalizeText(candidate.textContent))
    ));
    if (matchingToggleTargets.length !== 1 || matchingToggleTargets[0] !== element) return null;
    return {
      strategy: 'product-name-row',
      productName,
      toggleLabels,
      anchorPath,
      anchorWitness,
      targetPath,
      targetWitness,
      anchorSignature: productRowElementSummary(anchor),
      containerSignature: productRowElementSummary(container)
    };
  }
  const endpointFingerprint = createProductRowFingerprint(element);
  if (!endpointFingerprint) return null;
  const matchingEndpoints = Array.from(container.querySelectorAll(CLICKABLE_SELECTOR)).filter((candidate) => (
    sameProductRowFingerprint(createProductRowFingerprint(candidate), endpointFingerprint)
  ));
  if (matchingEndpoints.length !== 1 || matchingEndpoints[0] !== element) return null;
  return {
    strategy: 'product-name-row',
    productName,
    anchorPath,
    anchorWitness,
    targetPath,
    targetWitness,
    anchorSignature: productRowElementSummary(anchor),
    containerSignature: productRowElementSummary(container),
    endpointFingerprint
  };
}

function findProductRowLocatorAnchors(locator) {
  const expected = normalizeText(locator?.productName);
  if (!expected) return [];
  const matches = [];
  for (const selector of PRODUCT_NAME_SELECTORS) {
    for (const candidate of Array.from(document.querySelectorAll(selector))) {
      if (normalizeText(candidate.textContent) !== expected) continue;
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

function matchesToggleTarget(button, targetDescriptor, toggleLabels) {
  if (!button || !targetDescriptor || !toggleLabels.includes(normalizeText(button.textContent))) return false;
  if (targetDescriptor.tagName && String(button.tagName).toLowerCase() !== targetDescriptor.tagName.toLowerCase()) return false;
  for (const [key, value] of Object.entries(targetDescriptor.attributes || {})) {
    if (key.startsWith('data-') && button.getAttribute(key) !== value) return false;
  }
  return true;
}

function matchesControlledToggleTarget(button, targetDescriptor, toggleLabels) {
  if (!button || !targetDescriptor || !toggleLabels.includes(normalizeText(button.textContent))) return false;
  if (!['BUTTON', 'A'].includes(String(button.tagName || '').toUpperCase())
    && String(button.getAttribute?.('role') || '').toLowerCase() !== 'button') return false;
  return true;
}

function relocateControlledProductRowTarget(locator, targetDescriptor) {
  if (!locator || locator.strategy !== 'controlled-product-name-toggle') return null;
  const anchors = findProductRowLocatorAnchors(locator);
  if (anchors.length !== 1) return null;
  const toggleLabels = normalizeToggleLabels(locator.toggleLabels);
  if (!toggleLabels) return null;
  let current = anchors[0].parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < CONTROLLED_PRODUCT_ROW_LOCATOR_MAX_DEPTH) {
    const toggles = Array.from(current.querySelectorAll(SEMANTIC_SELECTOR)).filter((candidate) => (
      toggleLabels.includes(normalizeText(candidate.textContent))
    ));
    if (toggles.length === 1) {
      const contextAnchors = findControlledProductNameAnchors(current);
      if (contextAnchors.length === 0) {
        current = current.parentElement;
        depth += 1;
        continue;
      }
      if (contextAnchors.length !== 1 || contextAnchors[0] !== anchors[0]) return null;
      return matchesControlledToggleTarget(toggles[0], targetDescriptor, toggleLabels) ? toggles[0] : null;
    }
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

function relocateProductRowTarget(locator, targetDescriptor) {
  if (!locator || locator.strategy !== 'product-name-row') return null;
  const anchors = findProductRowLocatorAnchors(locator);
  if (anchors.length !== 1 || !Array.isArray(locator.anchorPath) || !Array.isArray(locator.targetPath)) return null;
  if (!matchesProductRowElementSummary(anchors[0], locator.anchorSignature)) return null;
  let container = anchors[0];
  for (let index = locator.anchorPath.length; index > 0; index -= 1) container = container?.parentElement || null;
  if (!container || !matchesProductRowElementSummary(container, locator.containerSignature)) return null;
  if (!matchesProductRowPathWitness(container, locator.anchorPath, locator.anchorWitness)) return null;
  const target = resolveElementPath(container, locator.targetPath);
  if (!target || !matchesProductRowPathWitness(container, locator.targetPath, locator.targetWitness)) return null;
  const toggleLabels = normalizeToggleLabels(locator.toggleLabels);
  if (locator.toggleLabels !== undefined && !toggleLabels) return null;
  if (toggleLabels) {
    const matchingToggleTargets = Array.from(container.querySelectorAll(CLICKABLE_SELECTOR)).filter((candidate) => (
      toggleLabels.includes(normalizeText(candidate.textContent))
    ));
    if (matchingToggleTargets.length !== 1 || matchingToggleTargets[0] !== target) return null;
    return matchesToggleTarget(target, targetDescriptor, toggleLabels) ? target : null;
  }
  const endpointFingerprint = createProductRowFingerprint(target);
  if (!sameProductRowFingerprint(endpointFingerprint, locator.endpointFingerprint)) return null;
  const matchingEndpoints = Array.from(container.querySelectorAll(CLICKABLE_SELECTOR)).filter((candidate) => (
    sameProductRowFingerprint(createProductRowFingerprint(candidate), locator.endpointFingerprint)
  ));
  if (matchingEndpoints.length !== 1 || matchingEndpoints[0] !== target) return null;
  return matchButton(target, targetDescriptor) ? target : null;
}

function extractFeatures(container) {
  const features = {};
  for (const attribute of ID_ATTRIBUTES) {
    const value = container?.getAttribute(attribute);
    if (value) { features.productId = value; break; }
  }
  const link = container?.querySelector?.('a[href*="product"], a[href*="goods"], a[href*="item"]');
  if (link) {
    features.href = link.href || link.getAttribute('href') || '';
    const match = features.href.match(/[?&](product_id|goods_id|item_id|id)=([^&]+)/);
    if (match && !features.productId) features.productId = match[2];
  }
  for (const selector of ['.product-name', '.goods-name', '.item-name', '.title', '[class*="name"]', '[class*="title"]']) {
    const name = container?.querySelector?.(selector);
    if (name && normalizeText(name.textContent)) { features.productName = normalizeText(name.textContent); break; }
  }
  if (!features.productName && container?.childNodes) {
    const text = Array.from(container.childNodes)
      .filter((node) => node.nodeType === 3 || (node.nodeType === 1 && !['BUTTON', 'A', 'INPUT'].includes(node.tagName)))
      .map((node) => normalizeText(node.textContent)).filter((value) => value.length > 2 && value.length < 100).join(' ');
    if (text) features.productName = normalizeText(text);
  }
  features.stableAttrs = {};
  const collection = container?.attributes;
  const length = Math.min(Number(collection?.length || 0), PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS);
  if (Number.isSafeInteger(length) && length >= 0) {
    for (let index = 0; index < length; index += 1) {
      const attribute = collection[index];
      if (attribute?.name.startsWith('data-') && attribute.value) features.stableAttrs[attribute.name] = attribute.value;
    }
  }
  return features;
}

function findProductContainer(element) {
  let current = element;
  let depth = 0;
  while (current && current !== document.body && depth < 15) {
    current = current.parentElement;
    depth += 1;
    if (!current) break;
    const features = extractFeatures(current);
    if (features.productId || features.productName || features.href) return { ...features, depth, containerAttrs: readAttributes(current) };
  }
  return { productName: normalizeText(element?.textContent), depth: 0 };
}

function createDescriptor(element) {
  let pageRule = { fullUrl: location.href };
  try {
    const url = new URL(location.href);
    pageRule = { protocol: url.protocol, hostname: url.hostname, port: url.port, pathname: url.pathname, fullUrl: location.href };
  } catch (_) {}
  const target = {
    tagName: String(element?.tagName || '').toLowerCase(),
    text: normalizeText(element?.textContent),
    className: String(element?.className || ''),
    id: String(element?.id || ''),
    attributes: readAttributes(element)
  };
  const container = findProductContainer(element);
  const descriptor = {
    target,
    container,
    pageRule,
    timestamp: Date.now()
  };
  const controlledToggle = toggleLabelsForText(target.text);
  if (controlledToggle) {
    const controlledLocator = createControlledProductRowLocator(element);
    descriptor.container = {
      ...container,
      productName: controlledLocator?.productName || '',
      productRowLocator: controlledLocator || { strategy: 'unavailable' }
    };
    return descriptor;
  }
  if (container.productName) {
    const containerElement = findProductContainerElement(element);
    if (productRowLocatorApplies(element, containerElement, target)) {
      const locator = createProductRowLocator(element, containerElement, target);
      descriptor.container.productRowLocator = locator || { strategy: 'unavailable' };
    }
  }
  return descriptor;
}

function pageMatches(rule) {
  if (!rule) return false;
  let current;
  try { current = new URL(location.href); } catch (_) { return false; }
  if (rule.protocol && rule.protocol !== current.protocol) return false;
  if (rule.hostname && rule.hostname !== current.hostname) return false;
  if (rule.pathname && rule.pathname !== current.pathname) {
    const expected = rule.pathname.split('/').filter(Boolean);
    const actual = current.pathname.split('/').filter(Boolean);
    if (expected.length >= 2 && actual.length >= 2 && (expected[0] !== actual[0] || expected[1] !== actual[1])) return false;
  }
  return true;
}

function pageIdentity(url) {
  try {
    const current = new URL(url);
    return {
      protocol: current.protocol,
      hostname: current.hostname,
      pathname: current.pathname
    };
  } catch (_) {
    return null;
  }
}

function defaultPagePort(protocol) {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

function normalizePagePort(protocol, value) {
  const port = typeof value === 'string' ? value : '';
  return port || defaultPagePort(protocol);
}

function pagePort(url) {
  try {
    const current = new URL(url);
    return normalizePagePort(current.protocol, current.port);
  } catch (_) {
    return '';
  }
}

function pageRulePort(rule) {
  if (!rule || typeof rule.protocol !== 'string') return '';
  if (Object.prototype.hasOwnProperty.call(rule, 'port') && typeof rule.port === 'string') {
    return normalizePagePort(rule.protocol, rule.port);
  }
  if (typeof rule.fullUrl === 'string') {
    try {
      const legacy = new URL(rule.fullUrl);
      if (legacy.protocol === rule.protocol && legacy.hostname === rule.hostname) {
        return normalizePagePort(legacy.protocol, legacy.port);
      }
    } catch (_) {
      // Fall through to the protocol default for legacy descriptors.
    }
  }
  return defaultPagePort(rule.protocol);
}

function pageRuleIdentity(rule) {
  if (!rule || typeof rule.protocol !== 'string' || typeof rule.hostname !== 'string'
    || typeof rule.pathname !== 'string') return null;
  return {
    protocol: rule.protocol,
    hostname: rule.hostname,
    pathname: rule.pathname
  };
}

function pageMatchesSameOrigin(rule) {
  const expected = pageRuleIdentity(rule);
  const current = pageIdentity(location.href);
  return Boolean(expected && current
    && expected.protocol === current.protocol
    && expected.hostname === current.hostname
    && pageRulePort(rule) === pagePort(location.href));
}

function isControlledProductRowToggle(descriptor) {
  return ['product-name-row', 'controlled-product-name-toggle'].includes(descriptor?.container?.productRowLocator?.strategy)
    && JSON.stringify(normalizeToggleLabels(descriptor.container.productRowLocator.toggleLabels))
      === JSON.stringify(PRODUCT_ROW_TOGGLE_LABELS);
}

function pageMatchesDescriptor(descriptor) {
  if (isControlledProductRowToggle(descriptor)) return pageMatchesSameOrigin(descriptor.pageRule);
  return pageMatchesExactly(descriptor?.pageRule);
}

function pageMatchesExactly(rule) {
  if (!rule || typeof rule.protocol !== 'string' || typeof rule.hostname !== 'string' || typeof rule.pathname !== 'string') return false;
  let current;
  try { current = new URL(location.href); } catch (_) { return false; }
  return rule.protocol === current.protocol
    && rule.hostname === current.hostname
    && rule.pathname === current.pathname
    && pageRulePort(rule) === pagePort(location.href);
}

function matchButton(button, target) {
  if (!button || !target) return false;
  if (target.text && normalizeText(button.textContent) !== normalizeText(target.text)) return false;
  if (target.tagName && String(button.tagName).toLowerCase() !== target.tagName.toLowerCase()) return false;
  for (const [key, value] of Object.entries(target.attributes || {})) {
    if (key.startsWith('data-') && button.getAttribute(key) !== value) return false;
  }
  return true;
}

function relocateProductContainer(descriptor) {
  if (descriptor.productId) {
    for (const attribute of ID_ATTRIBUTES) {
      const match = Array.from(document.querySelectorAll(`[${attribute}]`)).find((element) => element.getAttribute(attribute) === descriptor.productId);
      if (match) return match;
    }
  }
  if (descriptor.href) {
    const link = Array.from(document.querySelectorAll('a[href]')).find((element) => (element.href || element.getAttribute('href')) === descriptor.href);
    if (link) return link.closest('[class*="item"], [class*="product"], [class*="goods"]') || link.parentElement;
  }
  if (descriptor.productName) {
    const expected = normalizeText(descriptor.productName);
    const candidates = document.querySelectorAll('[class*="item"], [class*="product"], [class*="goods"], [class*="row"]');
    for (const candidate of candidates) {
      const text = normalizeText(candidate.textContent);
      if (text.includes(expected) || expected.includes(text.substring(0, 20))) return candidate;
    }
  }
  return null;
}

function relocateTarget(descriptor) {
  if (!pageMatchesDescriptor(descriptor)) return null;
  const hasProductRowLocator = Boolean(descriptor.container
    && Object.prototype.hasOwnProperty.call(descriptor.container, 'productRowLocator'));
  if (hasProductRowLocator) {
    if (isControlledProductRowToggle(descriptor)) {
      if (!pageMatchesSameOrigin(descriptor.pageRule)) return null;
    } else if (!pageMatchesExactly(descriptor.pageRule)) return null;
    if (descriptor.container.productRowLocator?.strategy === 'controlled-product-name-toggle') {
      return relocateControlledProductRowTarget(descriptor.container.productRowLocator, descriptor.target);
    }
    if (descriptor.container.productRowLocator?.strategy !== 'product-name-row') return null;
    return relocateProductRowTarget(descriptor.container.productRowLocator, descriptor.target);
  }
  if (descriptor.container && (descriptor.container.productId || descriptor.container.productName || descriptor.container.href)) {
    const container = relocateProductContainer(descriptor.container);
    const inContainer = container && Array.from(container.querySelectorAll(CLICKABLE_SELECTOR)).find((element) => matchButton(element, descriptor.target));
    if (inContainer) return inContainer;
  }
  const candidates = Array.from(document.querySelectorAll(CLICKABLE_SELECTOR)).filter((element) => matchButton(element, descriptor.target));
  return candidates.length === 1 ? candidates[0] : null;
}

function clearHighlight() {
  if (highlighted) highlighted.style.outline = '';
  highlighted = null;
}

function removeOverlay() {
  clearHighlight();
  overlay?.remove();
  overlay = null;
}

function exitSelectionMode() {
  if (!selectionMode) return;
  selectionMode = false;
  removeOverlay();
  document.removeEventListener('mousemove', handleMouseMove, true);
  document.removeEventListener('click', handleSelectionClick, true);
  document.removeEventListener('keydown', handleSelectionKeydown, true);
}

function enterSelectionMode() {
  exitSelectionMode();
  selectionMode = true;
  overlay = document.createElement('div');
  overlay.id = 'autoclick-selection-overlay';
  overlay.textContent = '自动点击助手：请选择目标按钮（ESC 取消）';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:12px 20px;background:#bc3d2e;color:#fff;font:600 14px system-ui,sans-serif;text-align:center;z-index:2147483647;box-shadow:0 2px 10px #0005;';
  document.documentElement.appendChild(overlay);
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleSelectionClick, true);
  document.addEventListener('keydown', handleSelectionKeydown, true);
}

function handleMouseMove(event) {
  if (!selectionMode) return;
  const element = document.elementFromPoint(event.clientX, event.clientY);
  if (!element || element === overlay || overlay?.contains(element)) return;
  const target = resolveSelectionTarget(element);
  if (highlighted !== target) clearHighlight();
  if (target) {
    target.style.outline = '2px solid #e85d3f';
    highlighted = target;
  }
}

function handleSelectionClick(event) {
  if (!selectionMode) return;
  if (event.target === overlay || overlay?.contains(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const target = resolveSelectionTarget(event.target);
  if (!target) return;
  send({ type: 'selection-complete', descriptor: createDescriptor(target), url: location.href });
  exitSelectionMode();
}

function handleSelectionKeydown(event) {
  if (selectionMode && event.key === 'Escape') {
    event.preventDefault();
    exitSelectionMode();
  }
}

function isDisabledTarget(target) {
  return Boolean(target?.disabled || target?.getAttribute?.('disabled') !== null);
}

function isExecutionActive(execution) {
  return Boolean(execution && activeExecution === execution && execution.cancelled !== true);
}

function cancelExecution(execution) {
  if (!execution || execution.cancelled) return;
  execution.cancelled = true;
  for (const listener of execution.cancelListeners) listener();
  execution.cancelListeners.clear();
}

function cancelActiveExecution(requestId) {
  if (activeExecution && (!requestId || activeExecution.requestId === requestId)) cancelExecution(activeExecution);
}

function beginExecution(requestId) {
  cancelActiveExecution();
  const execution = {
    requestId,
    generation: ++executionGeneration,
    cancelled: false,
    cancelListeners: new Set()
  };
  activeExecution = execution;
  return execution;
}

function waitForToggleState(descriptor, expectedState, execution) {
  return new Promise((resolve) => {
    const deadline = Date.now() + TOGGLE_STATE_WAIT_TIMEOUT_MS;
    let settled = false;
    let observer = null;
    let pollTimer = null;
    let timeoutTimer = null;
    const finish = (target) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (pollTimer !== null) clearInterval(pollTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      execution?.cancelListeners.delete(cancelWait);
      resolve(target || null);
    };
    const cancelWait = () => finish(null);
    execution?.cancelListeners.add(cancelWait);
    const inspect = () => {
      if (!isExecutionActive(execution)) {
        finish(null);
        return;
      }
      const target = relocateTarget(descriptor);
      if (target && !isDisabledTarget(target) && normalizeText(target.textContent) === expectedState) {
        finish(target);
        return;
      }
      if (Date.now() >= deadline) finish(null);
    };
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true
      });
    } else {
      pollTimer = setInterval(inspect, 50);
    }
    timeoutTimer = setTimeout(() => finish(null), TOGGLE_STATE_WAIT_TIMEOUT_MS);
    inspect();
  });
}

async function executeToggleClick(descriptor, toggleLabels, execution) {
  if (!isExecutionActive(execution)) return { success: false, reason: 'cancelled', cancelled: true, domClicks: 0 };
  let target = relocateTarget(descriptor);
  const initialState = normalizeText(target?.textContent);
  if (!target || !toggleLabels.includes(initialState)) {
    return { success: false, reason: 'toggle-state-ambiguous', error: '讲解状态不明确', domClicks: 0, initialState };
  }
  let domClicks = 0;
  const clickAndWait = async (expectedBeforeState, expectedAfterState) => {
    if (!isExecutionActive(execution)) return { success: false, reason: 'cancelled', cancelled: true };
    target = relocateTarget(descriptor);
    if (!target || normalizeText(target.textContent) !== expectedBeforeState) {
      return { success: false, reason: 'toggle-state-ambiguous', error: '讲解状态不明确' };
    }
    if (isDisabledTarget(target)) {
      return { success: false, reason: 'target-disabled', error: '目标已禁用' };
    }
    target.click();
    domClicks += 1;
    target = await waitForToggleState(descriptor, expectedAfterState, execution);
    if (!isExecutionActive(execution)) return { success: false, reason: 'cancelled', cancelled: true };
    if (!target) return { success: false, reason: 'toggle-state-timeout', error: `未在限定时间内进入${expectedAfterState}状态` };
    return { success: true };
  };

  if (initialState === toggleLabels[0]) {
    const result = await clickAndWait(toggleLabels[0], toggleLabels[1]);
    return {
      ...result,
      domClicks,
      initialState,
      finalState: result.success ? toggleLabels[1] : normalizeText(target?.textContent)
    };
  }

  let result = await clickAndWait(toggleLabels[1], toggleLabels[0]);
  if (result.success) result = await clickAndWait(toggleLabels[0], toggleLabels[1]);
  return {
    ...result,
    domClicks,
    initialState,
    finalState: result.success ? toggleLabels[1] : normalizeText(target?.textContent)
  };
}

function sendClickResult(requestId, result) {
  send({ type: 'click-result', requestId, timestamp: Date.now(), ...result });
}

async function executeClick(requestId, descriptor) {
  const execution = beginExecution(requestId);
  try {
    if (!pageMatchesDescriptor(descriptor)) {
      if (isExecutionActive(execution)) sendClickResult(requestId, {
        success: false,
        reason: 'page-mismatch',
        error: '页面不匹配',
        expectedPage: pageRuleIdentity(descriptor?.pageRule),
        currentPage: pageIdentity(location.href)
      });
      return;
    }
    const toggleLabels = normalizeToggleLabels(descriptor?.container?.productRowLocator?.toggleLabels);
    if (descriptor?.container?.productRowLocator?.toggleLabels !== undefined && !toggleLabels) {
      if (isExecutionActive(execution)) sendClickResult(requestId, { success: false, reason: 'toggle-state-invalid', error: '讲解状态族无效', domClicks: 0 });
      return;
    }
    if (toggleLabels) {
      const result = await executeToggleClick(descriptor, toggleLabels, execution);
      if (isExecutionActive(execution)) sendClickResult(requestId, result);
      return;
    }
    const target = relocateTarget(descriptor);
    if (!target) {
      if (isExecutionActive(execution)) sendClickResult(requestId, { success: false, reason: 'target-missing', error: '未找到目标', domClicks: 0 });
      return;
    }
    if (isDisabledTarget(target)) {
      if (isExecutionActive(execution)) sendClickResult(requestId, { success: false, reason: 'target-disabled', error: '目标已禁用', domClicks: 0 });
      return;
    }
    if (!isExecutionActive(execution)) return;
    target.click();
    if (isExecutionActive(execution)) sendClickResult(requestId, { success: true, domClicks: 1 });
  } catch (error) {
    if (isExecutionActive(execution)) sendClickResult(requestId, { success: false, reason: 'error', error: error.message, domClicks: 0 });
  } finally {
    if (activeExecution === execution) activeExecution = null;
  }
}

ipcRenderer.on('autoclick:browser-command', (_event, command) => {
  if (!command || typeof command.type !== 'string') return;
  if (command.type === 'start-selection') {
    cancelActiveExecution();
    enterSelectionMode();
  }
  else if (command.type === 'stop-selection') exitSelectionMode();
  else if (command.type === 'cancel-execute') cancelActiveExecution(command.requestId);
  else if (command.type === 'execute' && command.requestId && command.descriptor) executeClick(command.requestId, command.descriptor);
});

window.addEventListener('DOMContentLoaded', () => send({ type: 'browser-ready', url: location.href }));

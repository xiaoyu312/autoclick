'use strict';

const CLICKABLE_SELECTOR = 'button, a, [role="button"], [class*="button"]';
const SEMANTIC_CLICKABLE_SELECTOR = 'button, a, [role="button"]';
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
  if (!element) return element;
  const semanticTarget = typeof element.closest === 'function'
    ? element.closest(SEMANTIC_CLICKABLE_SELECTOR)
    : null;
  if (semanticTarget) return semanticTarget;
  const classTarget = typeof element.closest === 'function'
    ? element.closest('[class*="button"]')
    : null;
  return classTarget || element;
}

function readAttributes(element) {
  const attributes = {};
  const collection = element?.attributes;
  const length = Math.min(Number(collection?.length || 0), PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS);
  if (!Number.isSafeInteger(length) || length < 0) return attributes;
  for (let index = 0; index < length; index += 1) {
    const attribute = collection[index];
    if (!attribute) continue;
    if (attribute.name.startsWith('data-') || ['href', 'type', 'role', 'aria-label'].includes(attribute.name)) {
      attributes[attribute.name] = attribute.value;
    }
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

function extractProductFeatures(container) {
  if (!container) return {};
  const features = {};
  for (const attribute of ID_ATTRIBUTES) {
    const value = typeof container.getAttribute === 'function' ? container.getAttribute(attribute) : null;
    if (value) {
      features.productId = value;
      break;
    }
  }

  const link = typeof container.querySelector === 'function'
    ? container.querySelector('a[href*="product"], a[href*="goods"], a[href*="item"]')
    : null;
  if (link) {
    features.href = link.href || link.getAttribute?.('href') || '';
    const idMatch = String(features.href).match(/[?&](product_id|goods_id|item_id|id)=([^&]+)/);
    if (idMatch && !features.productId) features.productId = idMatch[2];
  }

  const nameSelectors = [
    '.product-name',
    '.goods-name',
    '.item-name',
    '.title',
    '[class*="name"]',
    '[class*="title"]'
  ];
  for (const selector of nameSelectors) {
    const nameElement = typeof container.querySelector === 'function' ? container.querySelector(selector) : null;
    if (nameElement && normalizeText(nameElement.textContent)) {
      features.productName = normalizeText(nameElement.textContent);
      break;
    }
  }

  if (!features.productName && container.childNodes) {
    const textContent = Array.from(container.childNodes)
      .filter((node) => node.nodeType === 3 || (node.nodeType === 1 && !['BUTTON', 'A', 'INPUT'].includes(String(node.tagName).toUpperCase())))
      .map((node) => normalizeText(node.textContent))
      .filter((text) => text.length > 2 && text.length < 100)
      .join(' ');
    if (textContent) features.productName = normalizeText(textContent);
  }

  features.stableAttrs = {};
  const collection = container.attributes;
  const length = Math.min(Number(collection?.length || 0), PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTE_CHECKS);
  if (Number.isSafeInteger(length) && length >= 0) {
    for (let index = 0; index < length; index += 1) {
      const attribute = collection[index];
      if (attribute?.name.startsWith('data-') && attribute.value) features.stableAttrs[attribute.name] = attribute.value;
    }
  }
  return features;
}

function findProductContainer(element, documentObject, maxDepth = 15) {
  let current = element;
  let depth = 0;
  while (current && current !== documentObject?.body && depth < maxDepth) {
    current = current.parentElement;
    depth += 1;
    if (!current) break;
    const productFeatures = extractProductFeatures(current);
    if (productFeatures.productId || productFeatures.productName || productFeatures.href) {
      return { ...productFeatures, depth, containerAttrs: readAttributes(current) };
    }
  }
  return { productName: normalizeText(element?.textContent), depth: 0 };
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
    for (const candidate of queryAll(container, selector)) {
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

function findControlledProductContext(element, documentObject) {
  if (!element || !documentObject || !PRODUCT_ROW_TOGGLE_LABELS.includes(normalizeText(element.textContent))) return null;
  if (!['BUTTON', 'A'].includes(String(element.tagName || '').toUpperCase())
    && String(element.getAttribute?.('role') || '').toLowerCase() !== 'button') return null;
  let current = element.parentElement;
  let depth = 0;
  while (current && current !== documentObject.body && depth < CONTROLLED_PRODUCT_ROW_LOCATOR_MAX_DEPTH) {
    const anchors = findControlledProductNameAnchors(current);
    const toggles = queryAll(current, SEMANTIC_CLICKABLE_SELECTOR).filter((candidate) => (
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
      const globalAnchors = findProductRowLocatorAnchors(documentObject, { productName });
      if (globalAnchors.length === 1 && globalAnchors[0] === anchor) return { context: current, anchor, productName };
      return null;
    }
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

function createControlledProductRowLocator(element, documentObject) {
  const context = findControlledProductContext(element, documentObject);
  if (!context) return null;
  return {
    strategy: 'controlled-product-name-toggle',
    productName: context.productName,
    toggleLabels: [...PRODUCT_ROW_TOGGLE_LABELS]
  };
}

function findProductContainerElement(element, documentObject, maxDepth = 15) {
  let current = element;
  let depth = 0;
  while (current && current !== documentObject?.body && depth < maxDepth) {
    current = current.parentElement;
    depth += 1;
    if (!current) break;
    const productFeatures = extractProductFeatures(current);
    if (productFeatures.productId || productFeatures.productName || productFeatures.href) return current;
  }
  return null;
}

function createProductRowLocator(element, container, target, documentObject) {
  if (!productRowLocatorApplies(element, container, target, documentObject)) return null;
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
    const matchingToggleTargets = queryAll(container, CLICKABLE_SELECTOR).filter((candidate) => (
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
  const matchingEndpoints = queryAll(container, CLICKABLE_SELECTOR).filter((candidate) => (
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

function containerProductName(container) {
  return normalizeText(container?.productName || extractProductFeatures(container).productName || '');
}

function productRowLocatorApplies(element, container, target, documentObject) {
  if (!element || !container?.parentElement || !containerProductName(container)) return false;
  if (toggleLabelsForText(target?.text)) return true;
  const globalMatches = queryAll(documentObject, CLICKABLE_SELECTOR).filter((candidate) => matchButton(candidate, target));
  return Boolean((!target.text && !target.id) || globalMatches.length !== 1);
}

function generatePageRule(url) {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      fullUrl: url
    };
  } catch (_) {
    return { fullUrl: url };
  }
}

function createTargetDescriptor(element, url, documentObject) {
  const container = findProductContainer(element, documentObject, 15);
  const target = {
    tagName: String(element?.tagName || '').toLowerCase(),
    text: normalizeText(element?.textContent),
    className: String(element?.className || ''),
    id: String(element?.id || ''),
    attributes: readAttributes(element)
  };
  const descriptor = {
    target,
    container,
    pageRule: generatePageRule(url),
    timestamp: Date.now()
  };
  const controlledToggle = toggleLabelsForText(target.text);
  if (controlledToggle) {
    const controlledLocator = createControlledProductRowLocator(element, documentObject);
    descriptor.container = {
      ...container,
      productName: controlledLocator?.productName || '',
      productRowLocator: controlledLocator || { strategy: 'unavailable' }
    };
    return descriptor;
  }
  if (container.productName) {
    const containerElement = findProductContainerElement(element, documentObject, 15);
    if (productRowLocatorApplies(element, containerElement, target, documentObject)) {
      const locator = createProductRowLocator(element, containerElement, target, documentObject);
      descriptor.container.productRowLocator = locator || { strategy: 'unavailable' };
    }
  }
  return descriptor;
}

function pageMatches(pageRule, url) {
  if (!pageRule || typeof url !== 'string') return false;
  let current;
  try {
    current = new URL(url);
  } catch (_) {
    return false;
  }
  if (pageRule.protocol && pageRule.protocol !== current.protocol) return false;
  if (pageRule.hostname && pageRule.hostname !== current.hostname) return false;
  if (pageRule.pathname && pageRule.pathname !== current.pathname) {
    const rulePath = pageRule.pathname.split('/').filter(Boolean);
    const currentPath = current.pathname.split('/').filter(Boolean);
    if (rulePath.length >= 2 && currentPath.length >= 2 && (rulePath[0] !== currentPath[0] || rulePath[1] !== currentPath[1])) {
      return false;
    }
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

function boundedPageIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const protocol = typeof value.protocol === 'string' ? value.protocol : '';
  const hostname = typeof value.hostname === 'string' ? value.hostname : '';
  const pathname = typeof value.pathname === 'string' ? value.pathname : '';
  const hostnameLabels = hostname.split('.');
  let canonicalHostname = '';
  try {
    canonicalHostname = new URL(`${protocol}//${hostname}/`).hostname;
  } catch (_) {
    return null;
  }
  if (!['http:', 'https:'].includes(protocol)
    || !hostname
    || hostname.length > 253
    || canonicalHostname !== hostname
    || hostnameLabels.some((label) => !label || label.length > 63
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
    || !pathname.startsWith('/')
    || pathname.length > 2048
    || /[?#=&\\]/.test(pathname)) return null;
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  if (/(?:https?:\/\/|:\/\/)/i.test(pathname)
    || /(?:https?:\/\/|:\/\/)/i.test(decodedPathname)
    || /[?#=&\\]/.test(decodedPathname)) return null;
  return { protocol, hostname, pathname };
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

function pageRulePort(pageRule) {
  if (!pageRule || typeof pageRule.protocol !== 'string') return '';
  if (Object.prototype.hasOwnProperty.call(pageRule, 'port') && typeof pageRule.port === 'string') {
    return normalizePagePort(pageRule.protocol, pageRule.port);
  }
  if (typeof pageRule.fullUrl === 'string') {
    try {
      const legacy = new URL(pageRule.fullUrl);
      if (legacy.protocol === pageRule.protocol && legacy.hostname === pageRule.hostname) {
        return normalizePagePort(legacy.protocol, legacy.port);
      }
    } catch (_) {
      // Fall through to the protocol default for legacy descriptors.
    }
  }
  return defaultPagePort(pageRule.protocol);
}

function pageRuleIdentity(pageRule) {
  if (!pageRule || typeof pageRule.protocol !== 'string' || typeof pageRule.hostname !== 'string'
    || typeof pageRule.pathname !== 'string') return null;
  return {
    protocol: pageRule.protocol,
    hostname: pageRule.hostname,
    pathname: pageRule.pathname
  };
}

function pageMatchesSameOrigin(pageRule, url) {
  const expected = pageRuleIdentity(pageRule);
  const current = pageIdentity(url);
  return Boolean(expected && current
    && expected.protocol === current.protocol
    && expected.hostname === current.hostname
    && pageRulePort(pageRule) === pagePort(url));
}

function isControlledProductRowToggle(descriptor) {
  return ['product-name-row', 'controlled-product-name-toggle'].includes(descriptor?.container?.productRowLocator?.strategy)
    && JSON.stringify(normalizeToggleLabels(descriptor.container.productRowLocator.toggleLabels))
      === JSON.stringify(PRODUCT_ROW_TOGGLE_LABELS);
}

function pageMatchesDescriptor(descriptor, url) {
  if (isControlledProductRowToggle(descriptor)) return pageMatchesSameOrigin(descriptor.pageRule, url);
  return pageMatchesExactly(descriptor?.pageRule, url);
}

function pageMatchesExactly(pageRule, url) {
  if (!pageRule || typeof url !== 'string'
    || typeof pageRule.protocol !== 'string'
    || typeof pageRule.hostname !== 'string'
    || typeof pageRule.pathname !== 'string') return false;
  let current;
  try {
    current = new URL(url);
  } catch (_) {
    return false;
  }
  return pageRule.protocol === current.protocol
    && pageRule.hostname === current.hostname
    && pageRule.pathname === current.pathname
    && pageRulePort(pageRule) === pagePort(url);
}

function queryAll(documentObject, selector) {
  return typeof documentObject?.querySelectorAll === 'function'
    ? Array.from(documentObject.querySelectorAll(selector))
    : [];
}

function relocateProductContainer(documentObject, descriptor) {
  if (!descriptor || !documentObject) return null;

  if (descriptor.productId) {
    for (const attribute of ID_ATTRIBUTES) {
      const candidates = queryAll(documentObject, `[${attribute}]`);
      const match = candidates.find((candidate) => candidate.getAttribute?.(attribute) === descriptor.productId);
      if (match) return match;
    }
  }

  if (descriptor.href) {
    const link = queryAll(documentObject, 'a[href]').find((candidate) => {
      const href = candidate.href || candidate.getAttribute?.('href');
      return href === descriptor.href;
    });
    if (link) {
      if (typeof link.closest === 'function') {
        return link.closest('[class*="item"], [class*="product"], [class*="goods"]') || link.parentElement;
      }
      return link.parentElement || link;
    }
  }

  if (descriptor.productName) {
    const expected = normalizeText(descriptor.productName);
    const candidates = queryAll(documentObject, '[class*="item"], [class*="product"], [class*="goods"], [class*="row"]');
    for (const candidate of candidates) {
      const text = normalizeText(candidate.textContent);
      if (text.includes(expected) || expected.includes(text.substring(0, 20))) return candidate;
    }
  }
  return null;
}

function matchButton(button, targetDescriptor) {
  if (!button || !targetDescriptor) return false;
  if (targetDescriptor.text && normalizeText(button.textContent) !== normalizeText(targetDescriptor.text)) return false;
  if (targetDescriptor.tagName && String(button.tagName || '').toLowerCase() !== targetDescriptor.tagName.toLowerCase()) return false;
  if (targetDescriptor.attributes) {
    for (const [key, value] of Object.entries(targetDescriptor.attributes)) {
      if (key.startsWith('data-') && button.getAttribute?.(key) !== value) return false;
    }
  }
  return true;
}

function findProductRowLocatorAnchors(documentObject, locator) {
  const expected = normalizeText(locator?.productName);
  if (!expected) return [];
  const matches = [];
  for (const selector of PRODUCT_NAME_SELECTORS) {
    for (const candidate of queryAll(documentObject, selector)) {
      if (normalizeText(candidate.textContent) !== expected) continue;
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

function matchesControlledToggleTarget(button, targetDescriptor, toggleLabels) {
  if (!button || !targetDescriptor || !toggleLabels.includes(normalizeText(button.textContent))) return false;
  if (!['BUTTON', 'A'].includes(String(button.tagName || '').toUpperCase())
    && String(button.getAttribute?.('role') || '').toLowerCase() !== 'button') return false;
  return true;
}

function relocateControlledProductRowTarget(documentObject, locator, targetDescriptor) {
  if (!locator || locator.strategy !== 'controlled-product-name-toggle') return null;
  const anchors = findProductRowLocatorAnchors(documentObject, locator);
  if (anchors.length !== 1) return null;
  const toggleLabels = normalizeToggleLabels(locator.toggleLabels);
  if (!toggleLabels) return null;
  let current = anchors[0].parentElement;
  let depth = 0;
  while (current && current !== documentObject.body && depth < CONTROLLED_PRODUCT_ROW_LOCATOR_MAX_DEPTH) {
    const toggles = queryAll(current, SEMANTIC_CLICKABLE_SELECTOR).filter((candidate) => (
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

function matchesToggleTarget(button, targetDescriptor, toggleLabels) {
  if (!button || !targetDescriptor || !toggleLabels.includes(normalizeText(button.textContent))) return false;
  if (targetDescriptor.tagName && String(button.tagName || '').toLowerCase() !== targetDescriptor.tagName.toLowerCase()) return false;
  for (const [key, value] of Object.entries(targetDescriptor.attributes || {})) {
    if (key.startsWith('data-') && button.getAttribute?.(key) !== value) return false;
  }
  return true;
}

function relocateProductRowTarget(documentObject, locator, targetDescriptor) {
  if (!locator || locator.strategy !== 'product-name-row') return null;
  const anchor = findProductRowLocatorAnchors(documentObject, locator);
  if (anchor.length !== 1 || !Array.isArray(locator.anchorPath) || !Array.isArray(locator.targetPath)) return null;
  if (!matchesProductRowElementSummary(anchor[0], locator.anchorSignature)) return null;
  let container = anchor[0];
  for (let index = locator.anchorPath.length; index > 0; index -= 1) container = container?.parentElement || null;
  if (!container || !matchesProductRowElementSummary(container, locator.containerSignature)) return null;
  if (!matchesProductRowPathWitness(container, locator.anchorPath, locator.anchorWitness)) return null;
  const target = resolveElementPath(container, locator.targetPath);
  if (!target || !matchesProductRowPathWitness(container, locator.targetPath, locator.targetWitness)) return null;
  const toggleLabels = normalizeToggleLabels(locator.toggleLabels);
  if (locator.toggleLabels !== undefined && !toggleLabels) return null;
  if (toggleLabels) {
    const matchingToggleTargets = queryAll(container, CLICKABLE_SELECTOR).filter((candidate) => (
      toggleLabels.includes(normalizeText(candidate.textContent))
    ));
    if (matchingToggleTargets.length !== 1 || matchingToggleTargets[0] !== target) return null;
    return matchesToggleTarget(target, targetDescriptor, toggleLabels) ? target : null;
  }
  const endpointFingerprint = createProductRowFingerprint(target);
  if (!sameProductRowFingerprint(endpointFingerprint, locator.endpointFingerprint)) return null;
  const matchingEndpoints = queryAll(container, CLICKABLE_SELECTOR).filter((candidate) => (
    sameProductRowFingerprint(createProductRowFingerprint(candidate), locator.endpointFingerprint)
  ));
  if (matchingEndpoints.length !== 1 || matchingEndpoints[0] !== target) return null;
  return matchButton(target, targetDescriptor) ? target : null;
}

function findButtonInContainer(container, targetDescriptor) {
  if (!container) return null;
  return queryAll(container, CLICKABLE_SELECTOR).find((button) => matchButton(button, targetDescriptor)) || null;
}

function relocateTarget(documentObject, descriptor, currentUrl) {
  if (!descriptor || !pageMatchesDescriptor(descriptor, currentUrl)) return null;
  const hasProductRowLocator = Boolean(descriptor.container
    && Object.prototype.hasOwnProperty.call(descriptor.container, 'productRowLocator'));
  if (hasProductRowLocator) {
    if (isControlledProductRowToggle(descriptor)) {
      if (!pageMatchesSameOrigin(descriptor.pageRule, currentUrl)) return null;
    } else if (!pageMatchesExactly(descriptor.pageRule, currentUrl)) return null;
    if (descriptor.container.productRowLocator?.strategy === 'controlled-product-name-toggle') {
      return relocateControlledProductRowTarget(documentObject, descriptor.container.productRowLocator, descriptor.target);
    }
    if (descriptor.container.productRowLocator?.strategy !== 'product-name-row') return null;
    return relocateProductRowTarget(documentObject, descriptor.container.productRowLocator, descriptor.target);
  }
  if (descriptor.container && (descriptor.container.productId || descriptor.container.productName || descriptor.container.href)) {
    const productContainer = relocateProductContainer(documentObject, descriptor.container);
    const button = findButtonInContainer(productContainer, descriptor.target);
    if (button) return button;
  }
  const candidates = queryAll(documentObject, CLICKABLE_SELECTOR).filter((button) => matchButton(button, descriptor.target));
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {
  CLICKABLE_SELECTOR,
  SEMANTIC_CLICKABLE_SELECTOR,
  ID_ATTRIBUTES,
  PRODUCT_ROW_LOCATOR_MAX_DEPTH,
  PRODUCT_ROW_FINGERPRINT_MAX_NODES,
  PRODUCT_ROW_FINGERPRINT_MAX_ATTRIBUTES,
  PRODUCT_ROW_TOGGLE_LABELS,
  CONTROLLED_PRODUCT_ROW_LOCATOR_MAX_DEPTH,
  normalizeText,
  resolveSelectionTarget,
  readAttributes,
  extractProductFeatures,
  productFingerprintSummary,
  createProductRowFingerprint,
  createProductRowLocator,
  createControlledProductRowLocator,
  relocateControlledProductRowTarget,
  relocateProductRowTarget,
  findProductContainer,
  generatePageRule,
  createTargetDescriptor,
  pageMatches,
  pageMatchesExactly,
  pageIdentity,
  boundedPageIdentity,
  defaultPagePort,
  normalizePagePort,
  pagePort,
  pageRulePort,
  pageRuleIdentity,
  pageMatchesSameOrigin,
  isControlledProductRowToggle,
  pageMatchesDescriptor,
  relocateProductContainer,
  matchButton,
  findButtonInContainer,
  relocateTarget
};

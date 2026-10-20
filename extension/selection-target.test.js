const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contentScript = fs.readFileSync(
  path.join(__dirname, 'content.js'),
  'utf8'
);

function loadContentScript() {
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: {
          addListener() {}
        },
        sendMessage() {
          return Promise.resolve();
        }
      },
      storage: {
        local: {
          set(_value, callback) {
            if (callback) callback();
          }
        }
      }
    },
    LogManager: {
      log() {}
    },
    window: {
      location: {
        href: 'https://example.test/page'
      }
    },
    setTimeout() {},
    console
  });

  vm.runInContext(contentScript, context, { filename: 'content.js' });
  return context;
}

function createElement(tagName, parentElement = null, className = '', role = '') {
  const element = {
    tagName,
    className,
    parentElement,
    role,
    closestCalls: [],
    closest(selector) {
      this.closestCalls.push(selector);

      const matches = (current, selectorPart) => {
        if (selectorPart === 'button') return current.tagName === 'BUTTON';
        if (selectorPart === 'a') return current.tagName === 'A';
        if (selectorPart === '[role="button"]') return current.role === 'button';
        if (selectorPart === '[class*="button"]') {
          return typeof current.className === 'string' && current.className.includes('button');
        }
        return false;
      };
      const selectorParts = selector.split(',').map(part => part.trim());

      let current = this;
      while (current) {
        if (selectorParts.some(selectorPart => matches(current, selectorPart))) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }
  };
  return element;
}

test('button content class does not shadow its semantic button ancestor', () => {
  const context = loadContentScript();
  const button = createElement('BUTTON');
  const content = createElement('SPAN', button, 'primary-button-content');

  assert.equal(context.getClickableTarget(content), button);
  assert.deepEqual(content.closestCalls, ['button, a, [role="button"]']);
});

test('svg or path content resolves to its semantic button ancestor', () => {
  const context = loadContentScript();
  const button = createElement('BUTTON');
  const svg = createElement('SVG', button);
  const path = createElement('PATH', svg, 'button-icon');

  assert.equal(context.getClickableTarget(path), button);
  assert.deepEqual(path.closestCalls, ['button, a, [role="button"]']);
});

test('class-only custom buttons are used when no semantic ancestor exists', () => {
  const context = loadContentScript();
  const customButton = createElement('DIV', null, 'custom-button');
  const content = createElement('SPAN', customButton, 'icon');

  assert.equal(context.getClickableTarget(content), customButton);
  assert.deepEqual(content.closestCalls, [
    'button, a, [role="button"]',
    '[class*="button"]'
  ]);
});

test('selection target falls back to the original element when no ancestor is clickable', () => {
  const context = loadContentScript();
  const text = createElement('SPAN');

  assert.equal(context.getClickableTarget(text), text);
  assert.deepEqual(text.closestCalls, [
    'button, a, [role="button"]',
    '[class*="button"]'
  ]);
});

test('handleSelectionClick analyzes the normalized outer target', () => {
  const context = loadContentScript();
  const button = createElement('BUTTON');
  const icon = createElement('SPAN', button, 'icon');
  let analyzedTarget = null;

  context.analyzeTarget = element => {
    analyzedTarget = element;
    return {
      target: { text: 'Action' },
      container: {},
      pageRule: {}
    };
  };
  context.showSelectionConfirmation = () => {};
  context.exitSelectionMode = () => {};
  vm.runInContext('isSelectionMode = true', context);

  context.handleSelectionClick({
    target: icon,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {}
  });

  assert.equal(analyzedTarget, button);
});

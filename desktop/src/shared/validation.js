'use strict';

const MIN_INTERVAL_SECONDS = 1;
const DEFAULT_INTERVAL_SECONDS = 8;
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

function validateHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('url must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    throw new TypeError('url must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new TypeError('url protocol must be http or https');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('url credentials are not allowed');
  }
  return parsed.href;
}

function validateIntervalSeconds(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < MIN_INTERVAL_SECONDS || number > MAX_INTERVAL_SECONDS) {
    throw new RangeError(`intervalSeconds must be an integer from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`);
  }
  return number;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateDescriptor(value) {
  if (!isPlainObject(value) || !isPlainObject(value.target) || !isPlainObject(value.pageRule)) {
    throw new TypeError('target descriptor shape is invalid');
  }
  if (value.target.text !== undefined && typeof value.target.text !== 'string') {
    throw new TypeError('target descriptor text must be a string');
  }
  if (value.target.tagName !== undefined && typeof value.target.tagName !== 'string') {
    throw new TypeError('target descriptor tagName must be a string');
  }
  return value;
}

function validateBrowserCommand(value) {
  if (!isPlainObject(value) || !['start-selection', 'stop-selection', 'execute', 'cancel-execute'].includes(value.type)) {
    throw new TypeError('browser command type is invalid');
  }
  if (value.type === 'execute') {
    validateDescriptor(value.descriptor);
  }
  if (value.type === 'cancel-execute' && (typeof value.requestId !== 'string' || !value.requestId.trim())) {
    throw new TypeError('browser cancel requestId must be a non-empty string');
  }
  return value;
}

function isTrustedSender(event, expectedWebContents) {
  return Boolean(event && event.sender && expectedWebContents && event.sender === expectedWebContents);
}

module.exports = {
  MIN_INTERVAL_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  validateHttpUrl,
  validateIntervalSeconds,
  validateDescriptor,
  validateBrowserCommand,
  isTrustedSender
};

import assert from 'node:assert/strict';
import test, { before, afterEach } from 'node:test';

import { applyTheme, defaultTheme, readTheme, storeTheme } from '../src/lib/theme.ts';

/**
 * Theme persistence talks to `localStorage` and `document.documentElement`.
 * Neither exists in the test runner, and both throw rather than returning
 * null when a browser has blocked them — so the stand-ins have to match that
 * shape, not just the happy path.
 */

const memory = new Map<string, string>();
const dataset: Record<string, string | undefined> = {};

before(() => {
  const storage: Storage = {
    get length() {
      return memory.size;
    },
    clear() {
      memory.clear();
    },
    getItem(key) {
      return memory.get(key) ?? null;
    },
    key(index) {
      return [...memory.keys()][index] ?? null;
    },
    removeItem(key) {
      memory.delete(key);
    },
    setItem(key, value) {
      memory.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset } },
  });
});

afterEach(() => {
  memory.clear();
  delete dataset['theme'];
});

test('the default is dark, independent of anything stored', () => {
  assert.equal(defaultTheme, 'dark');
  assert.equal(readTheme(), 'dark');
});

test('a stored light preference is honoured', () => {
  memory.set('proof-of-ownership:theme', 'light');
  assert.equal(readTheme(), 'light');
});

test('a stored dark preference is honoured', () => {
  memory.set('proof-of-ownership:theme', 'dark');
  assert.equal(readTheme(), 'dark');
});

test('garbage in storage falls back to dark rather than throwing', () => {
  memory.set('proof-of-ownership:theme', 'system');
  assert.equal(readTheme(), 'dark');
});

test('storeTheme writes the choice under the key the pre-paint script reads', () => {
  storeTheme('light');
  assert.equal(memory.get('proof-of-ownership:theme'), 'light');
  storeTheme('dark');
  assert.equal(memory.get('proof-of-ownership:theme'), 'dark');
});

test('applyTheme sets the attribute the stylesheet keys off', () => {
  applyTheme('light');
  assert.equal(dataset['theme'], 'light');
  applyTheme('dark');
  assert.equal(dataset['theme'], 'dark');
});

test('a blocked store does not prevent applying the theme to this page', () => {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    },
  });

  try {
    assert.equal(readTheme(), 'dark');
    storeTheme('light');
    applyTheme('light');
    assert.equal(dataset['theme'], 'light');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
  }
});

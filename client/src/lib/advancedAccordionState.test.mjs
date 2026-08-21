import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findAdvancedAccordionHashItemId,
  reconcileAdvancedAccordionOpen,
  resolveAdvancedAccordionInitialOpen,
  toggleAdvancedAccordionOpen,
} from './advancedAccordion.js';

const content = {
  mode: 'multiple',
  initialState: 'multiple',
  initialOpenIds: ['a', 'c'],
  items: [
    { id: 'a', anchor: 'alpha' },
    { id: 'b', anchor: 'beta' },
    { id: 'c', anchor: 'gamma' },
  ],
};

test('hash takes priority over configured initial state', () => {
  assert.deepEqual(resolveAdvancedAccordionInitialOpen(content, '#beta'), ['b']);
});

test('a descendant block hash opens its containing item', () => {
  const nested = {
    ...content,
    items: [
      content.items[0],
      {
        ...content.items[1],
        children: [{
          id: 'layout',
          type: 'group',
          children: [{ id: 'deep', type: 'text', anchorId: 'deep-target' }],
        }],
      },
    ],
  };
  assert.equal(findAdvancedAccordionHashItemId(nested, '#deep-target'), 'b');
  assert.deepEqual(resolveAdvancedAccordionInitialOpen(nested, '#deep-target'), ['b']);
});

test('multiple initial state keeps configured valid item ids', () => {
  assert.deepEqual(resolveAdvancedAccordionInitialOpen(content), ['a', 'c']);
});

test('first and all-closed initial states resolve directly', () => {
  assert.deepEqual(resolveAdvancedAccordionInitialOpen({ ...content, initialState: 'first' }), ['a']);
  assert.deepEqual(resolveAdvancedAccordionInitialOpen({ ...content, initialState: 'all-closed' }), []);
});

test('single-required always opens at least one item', () => {
  const required = { ...content, mode: 'single-required', initialState: 'all-closed' };
  assert.deepEqual(resolveAdvancedAccordionInitialOpen(required), ['a']);
  assert.deepEqual(toggleAdvancedAccordionOpen(['a'], 'a', 'single-required', ['a', 'b']), ['a']);
});

test('single mode replaces or closes the open item', () => {
  assert.deepEqual(toggleAdvancedAccordionOpen(['a'], 'b', 'single'), ['b']);
  assert.deepEqual(toggleAdvancedAccordionOpen(['a'], 'a', 'single'), []);
});

test('multiple mode independently toggles items', () => {
  assert.deepEqual(toggleAdvancedAccordionOpen(['a'], 'b', 'multiple'), ['a', 'b']);
  assert.deepEqual(toggleAdvancedAccordionOpen(['a', 'b'], 'a', 'multiple'), ['b']);
});

test('reconcile removes deleted ids and enforces the active mode', () => {
  assert.deepEqual(reconcileAdvancedAccordionOpen(['gone', 'b'], content), ['b']);
  assert.deepEqual(reconcileAdvancedAccordionOpen(['a', 'b'], { ...content, mode: 'single' }), ['a']);
});
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// Some shared Canvas dependencies resolve the tenant from window.location at
// module evaluation time. Provide a tiny browser before importing the block.
const bootstrapDom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/page',
});
global.window = bootstrapDom.window;
global.document = bootstrapDom.window.document;
global.navigator = bootstrapDom.window.navigator;
global.localStorage = bootstrapDom.window.localStorage;
global.sessionStorage = bootstrapDom.window.sessionStorage;
const {
  AdvancedAccordionInspector,
  AdvancedAccordionRender,
} = await import('./AdvancedAccordionBlock.jsx');
const { BLOCK_TYPES, createBlock } = await import('../../../lib/canvasDesign.js');

let dom;
let container;
let root;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://example.test/page',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.DocumentFragment = dom.window.DocumentFragment;
  global.CustomEvent = dom.window.CustomEvent;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.getElementById('root');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  delete global.window;
  delete global.document;
  delete global.navigator;
  delete global.HTMLElement;
  delete global.Element;
  delete global.Node;
  delete global.DocumentFragment;
  delete global.CustomEvent;
  delete global.requestAnimationFrame;
  delete global.cancelAnimationFrame;
});

const getBlockDefinition = () => ({
  autoHeight: true,
  allowOverflow: true,
  Renderer: ({ block }) => React.createElement(
    'div',
    { 'data-testid': `nested-${block.id}` },
    block.content?.html || block.content?.label || block.name,
  ),
  Editor: ({ block }) => React.createElement(
    'div',
    { 'data-testid': `nested-${block.id}` },
    block.content?.html || block.content?.label || block.name,
  ),
});

function makeBlock(patch = {}) {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  return {
    ...block,
    content: {
      ...block.content,
      initialState: 'all-closed',
      ...patch,
    },
  };
}

async function render(block, props = {}) {
  await act(async () => {
    root.render(React.createElement(AdvancedAccordionRender, {
      block,
      getBlockDefinition,
      ...props,
    }));
  });
}

test('renders semantic disclosure relationships and hides collapsed descendants', async () => {
  const block = makeBlock();
  await render(block);
  const buttons = container.querySelectorAll('button[aria-expanded]');
  assert.equal(buttons.length, 2);
  const panelId = buttons[0].getAttribute('aria-controls');
  const panel = document.getElementById(panelId);
  assert.equal(panel.getAttribute('role'), 'region');
  assert.equal(panel.getAttribute('aria-labelledby'), buttons[0].id);
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
  assert.ok(panel.hasAttribute('inert'));
  assert.match(panel.parentElement.className, /motion-reduce:transition-none/);
});

test('single mode opens one item, closes the previous one, and retains trigger focus', async () => {
  const block = makeBlock({ mode: 'single' });
  await render(block);
  const [first, second] = container.querySelectorAll('button[aria-expanded]');
  first.focus();
  await act(async () => first.click());
  assert.equal(first.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, first);
  await act(async () => second.click());
  assert.equal(first.getAttribute('aria-expanded'), 'false');
  assert.equal(second.getAttribute('aria-expanded'), 'true');
});

test('multiple and single-required modes enforce their distinct contracts', async () => {
  const multiple = makeBlock({ mode: 'multiple' });
  await render(multiple);
  let [first, second] = container.querySelectorAll('button[aria-expanded]');
  await act(async () => { first.click(); second.click(); });
  assert.equal(first.getAttribute('aria-expanded'), 'true');
  assert.equal(second.getAttribute('aria-expanded'), 'true');

  const required = makeBlock({ mode: 'single-required', initialState: 'first' });
  await render(required);
  [first] = container.querySelectorAll('button[aria-expanded]');
  assert.equal(first.getAttribute('aria-expanded'), 'true');
  await act(async () => first.click());
  assert.equal(first.getAttribute('aria-expanded'), 'true');
});

test('a descendant hash opens its containing item before interaction', async () => {
  const block = makeBlock({
    items: [
      {
        id: 'one',
        title: 'One',
        anchor: 'one',
        children: [],
      },
      {
        id: 'two',
        title: 'Two',
        anchor: 'two',
        children: [{
          id: 'group',
          type: BLOCK_TYPES.GROUP,
          name: 'Group',
          layoutMode: 'flow',
          children: [{
            id: 'deep',
            type: BLOCK_TYPES.TEXT,
            name: 'Deep text',
            anchorId: 'deep-target',
            content: { html: 'Deep target' },
          }],
        }],
      },
    ],
  });
  window.history.replaceState(null, '', '#deep-target');
  await render(block);
  const buttons = container.querySelectorAll('button[aria-expanded]');
  assert.equal(buttons[0].getAttribute('aria-expanded'), 'false');
  assert.equal(buttons[1].getAttribute('aria-expanded'), 'true');
  assert.ok(document.getElementById('deep-target'));
});

test('optional hash synchronization replaces history without navigation', async () => {
  const block = makeBlock({ syncHashOnOpen: true });
  const targetAnchor = block.content.items[0].anchor;
  await render(block);
  const first = container.querySelector('button[aria-expanded]');
  await act(async () => first.click());
  assert.equal(window.location.hash, `#${targetAnchor}`);
});

test('renders descendants inside a responsive nested row layout', async () => {
  const block = makeBlock({
    initialState: 'first',
    items: [{
      id: 'item',
      title: 'Nested layout',
      anchor: 'nested-layout',
      children: [{
        id: 'row',
        type: BLOCK_TYPES.ROW,
        name: 'Row',
        layoutMode: 'flow',
        flow: { gap: 12, align: 'stretch' },
        bp: { desktop: { x: 0, y: 0, w: 500, h: 120 } },
        content: { stackMobile: true },
        children: [{
          id: 'deep-text',
          type: BLOCK_TYPES.TEXT,
          name: 'Deep text',
          content: { html: 'Deep content' },
          bp: { desktop: { x: 0, y: 0, w: 240, h: 40 } },
        }],
      }],
    }],
  });
  const definitions = (type) => (
    type === BLOCK_TYPES.ROW || type === BLOCK_TYPES.GROUP
      ? null
      : getBlockDefinition(type)
  );
  await render(block, { breakpoint: 'mobile', getBlockDefinition: definitions });
  assert.ok(container.querySelector('[data-testid="nested-deep-text"]'));
  const row = container.querySelector('[data-advanced-accordion-child="row"]');
  assert.equal(row.firstElementChild.style.flexDirection, 'column');
});

test('inspector accepts the normal Canvas update prop', async () => {
  const block = makeBlock();
  const updates = [];
  await act(async () => {
    root.render(React.createElement(AdvancedAccordionInspector, {
      block,
      update: (patch) => updates.push(patch),
      getBlockDefinition,
      listPaletteBlocks: () => [],
    }));
  });
  const addItem = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent.includes('Add item'));
  assert.ok(addItem);
  await act(async () => addItem.click());
  assert.equal(updates.length, 1);
  assert.equal(updates[0].content.items.length, block.content.items.length + 1);
});
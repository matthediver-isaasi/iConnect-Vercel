import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
global.React = React;
global.HTMLElement = bootstrapDom.window.HTMLElement;
global.Element = bootstrapDom.window.Element;
global.Node = bootstrapDom.window.Node;
const {
  AdvancedAccordionInspector,
  AdvancedAccordionRender,
} = await import('./AdvancedAccordionBlock.jsx');
const {
  BLOCK_TYPES,
  CANVAS_FLOW_VERSION,
  createBlock,
  createFlowNode,
  createFlowSection,
} = await import('../../../lib/canvasDesign.js');
const { DndContext } = await import('@dnd-kit/core');
const { default: CanvasStage } = await import('../CanvasStage.jsx');
const { default: CanvasFlowEditorStage } = await import('../CanvasFlowEditorStage.jsx');
const { getBlockDefinition: getRegisteredBlockDefinition } = await import('./registry.jsx');

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
  global.React = React;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.DocumentFragment = dom.window.DocumentFragment;
  global.CustomEvent = dom.window.CustomEvent;
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.ResizeObserver = global.ResizeObserver;
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
  delete global.React;
  delete global.HTMLElement;
  delete global.Element;
  delete global.Node;
  delete global.DocumentFragment;
  delete global.CustomEvent;
  delete global.MutationObserver;
  delete global.getComputedStyle;
  delete global.ResizeObserver;
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

function makeStageBlock(patch = {}) {
  const block = makeBlock({ initialState: 'first', ...patch });
  return {
    ...block,
    content: {
      ...block.content,
      items: block.content.items.map((item) => ({
        ...item,
        children: [createBlock(BLOCK_TYPES.SPACER, {
          id: `${item.id}-stage-child`,
          content: { height: 24 },
        })],
      })),
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

function pointerDown(element, options = {}) {
  element.dispatchEvent(new window.MouseEvent('pointerdown', {
    bubbles: true,
    button: 0,
    ...options,
  }));
}

function assertBlockIdentityPreserved(before, after) {
  assert.equal(after.type, BLOCK_TYPES.ADVANCED_ACCORDION);
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
  assert.equal(after.anchorId, before.anchorId);
  assert.equal(after.locked, before.locked);
  assert.equal(after.groupId, before.groupId);
  assert.equal(after.fullWidth, before.fullWidth);
  assert.deepEqual(after.bp, before.bp);
  assert.deepEqual(after.style, before.style);
  assert.deepEqual(after.a11y, before.a11y);
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

test('inspector edits use the functional Canvas contract and preserve the complete block', async () => {
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
  assert.equal(typeof updates[0], 'function');
  const next = updates[0](block);
  assertBlockIdentityPreserved(block, next);
  assert.equal(next.content.items.length, block.content.items.length + 1);
});

test('representative behaviour, item, nested-content, and visual edits all preserve block metadata', async () => {
  const block = makeBlock();
  const updates = [];
  await act(async () => {
    root.render(React.createElement(AdvancedAccordionInspector, {
      block,
      update: (updater) => updates.push(updater),
      getBlockDefinition,
      listPaletteBlocks: () => [],
    }));
  });

  const syncHashSwitch = container.querySelector('button[role="switch"]');
  assert.ok(syncHashSwitch);
  await act(async () => syncHashSwitch.click());

  const titleInput = container.querySelector('[data-testid="advanced-accordion-item-title"]');
  assert.ok(titleInput);
  await act(async () => Simulate.change(titleInput, {
    target: { value: 'Updated panel title' },
  }));

  const addChild = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent.includes('Add to panel'));
  assert.ok(addChild);
  await act(async () => addChild.click());

  const itemSpacingLabel = Array.from(container.querySelectorAll('label'))
    .find((label) => label.textContent === 'Item spacing');
  const itemSpacingInput = itemSpacingLabel?.parentElement?.querySelector('input');
  assert.ok(itemSpacingInput);
  await act(async () => Simulate.change(itemSpacingInput, {
    target: { value: '24' },
  }));

  assert.equal(updates.length, 4);
  const results = updates.map((updater) => {
    assert.equal(typeof updater, 'function');
    const next = updater(block);
    assertBlockIdentityPreserved(block, next);
    return next;
  });
  assert.equal(results[0].content.syncHashOnOpen, !block.content.syncHashOnOpen);
  assert.equal(results[1].content.items[0].title, 'Updated panel title');
  assert.equal(
    results[2].content.items[0].children.length,
    block.content.items[0].children.length + 1,
  );
  assert.equal(results[3].content.styles.itemGap ?? results[3].content.itemGap, 24);
});

test('editor pointer bridge selects the parent while header toggling and nested selection still work', async () => {
  const block = makeBlock({ initialState: 'first' });
  const selected = [];
  const bubbled = [];
  const nestedSelections = [];
  const onNestedSelect = (event) => nestedSelections.push(event.detail);
  window.addEventListener('canvas:advanced-accordion-select', onNestedSelect);

  await act(async () => {
    root.render(React.createElement(
      'div',
      { onPointerDown: () => bubbled.push(true) },
      React.createElement(AdvancedAccordionRender, {
        block,
        asEditor: true,
        getBlockDefinition,
        onSelectParent: () => selected.push(block.id),
      }),
    ));
  });

  const header = container.querySelector('button[aria-expanded]');
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  await act(async () => pointerDown(header));
  assert.deepEqual(selected, [block.id]);
  assert.equal(bubbled.length, 0);
  await act(async () => header.click());
  assert.equal(header.getAttribute('aria-expanded'), 'false');

  const child = container.querySelector('[data-advanced-accordion-child]');
  assert.ok(child);
  await act(async () => pointerDown(child));
  assert.deepEqual(selected, [block.id, block.id]);
  assert.equal(bubbled.length, 0);
  assert.equal(nestedSelections.at(-1)?.parentId, block.id);
  assert.equal(nestedSelections.at(-1)?.childId, child.dataset.advancedAccordionChild);
  assert.equal(header.getAttribute('aria-expanded'), 'true');

  window.removeEventListener('canvas:advanced-accordion-select', onNestedSelect);
});

test('absolute Canvas stage selects Advanced Accordion from its interactive header and nested child', async () => {
  const block = makeStageBlock();
  const selections = [];
  const nestedSelections = [];
  const onNestedSelect = (event) => nestedSelections.push(event.detail);
  window.addEventListener('canvas:advanced-accordion-select', onNestedSelect);
  await act(async () => {
    root.render(React.createElement(
      DndContext,
      null,
      React.createElement(CanvasStage, {
        blocks: [block],
        selectedIds: [],
        breakpoint: 'desktop',
        canvasWidth: 1200,
        canvasHeight: 800,
        onSelect: (ids) => selections.push(ids),
        onApplyGeometry: () => {},
        onMarqueeSelect: () => {},
      }),
    ));
  });

  const header = container.querySelector('button[aria-expanded]');
  const child = container.querySelector('[data-advanced-accordion-child]');
  assert.ok(header);
  assert.ok(child);
  await act(async () => pointerDown(header));
  await act(async () => header.click());
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  await act(async () => pointerDown(child));
  assert.deepEqual(selections, [[block.id], [block.id]]);
  assert.equal(nestedSelections.at(-1)?.parentId, block.id);
  assert.equal(nestedSelections.at(-1)?.childId, child.dataset.advancedAccordionChild);
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  window.removeEventListener('canvas:advanced-accordion-select', onNestedSelect);
});

test('flow Canvas stage selects Advanced Accordion from its interactive header and nested child', async () => {
  const stageBlock = makeStageBlock();
  const accordion = createFlowNode(BLOCK_TYPES.ADVANCED_ACCORDION, {
    id: 'flow-advanced-accordion',
    content: stageBlock.content,
  });
  const section = createFlowSection({
    id: 'flow-section',
    children: [accordion],
  });
  const design = {
    version: CANVAS_FLOW_VERSION,
    root: {
      layout: 'flow',
      sections: [section],
    },
  };
  const selections = [];
  const nestedSelections = [];
  const onNestedSelect = (event) => nestedSelections.push(event.detail);
  window.addEventListener('canvas:advanced-accordion-select', onNestedSelect);
  await act(async () => {
    root.render(React.createElement(
      DndContext,
      null,
      React.createElement(CanvasFlowEditorStage, {
        design,
        breakpoint: 'desktop',
        canvasWidth: 1200,
        canvasHeight: 800,
        selectedIds: [],
        onSelect: (ids) => selections.push(ids),
      }),
    ));
  });

  const header = container.querySelector('button[aria-expanded]');
  const child = container.querySelector('[data-advanced-accordion-child]');
  assert.ok(header);
  assert.ok(child);
  await act(async () => pointerDown(header));
  await act(async () => header.click());
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  await act(async () => pointerDown(child));
  assert.deepEqual(selections, [[accordion.id], [accordion.id]]);
  assert.equal(nestedSelections.at(-1)?.parentId, accordion.id);
  assert.equal(nestedSelections.at(-1)?.childId, child.dataset.advancedAccordionChild);
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  window.removeEventListener('canvas:advanced-accordion-select', onNestedSelect);
});

test('legacy FAQ Accordion remains non-interactive in the editor and keeps its disclosure behaviour', async () => {
  const definition = getRegisteredBlockDefinition(BLOCK_TYPES.ACCORDION);
  assert.notEqual(definition.editorInteractive, true);

  const block = createBlock(BLOCK_TYPES.ACCORDION);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['/api/public/typography-styles', null], []);
  await act(async () => {
    root.render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(definition.Renderer, { block }),
    ));
  });

  const header = container.querySelector('button[aria-expanded]');
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  await act(async () => header.click());
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  await act(async () => header.click());
  assert.equal(header.getAttribute('aria-expanded'), 'false');
});
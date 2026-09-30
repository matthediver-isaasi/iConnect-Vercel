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
const {
  fitAspectRatioWithinBounds,
  getBlockDefinition: getRegisteredBlockDefinition,
} = await import('./registry.jsx');

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

test('nested child inspector functional updates change the accordion block', async () => {
  const child = createBlock(BLOCK_TYPES.TEXT, {
    id: 'nested-text',
    name: 'Nested text',
    content: { html: '<p>Original text</p>' },
  });
  const block = makeBlock({
    items: [{
      id: 'item-one',
      title: 'Item one',
      anchor: 'item-one',
      children: [child],
    }],
  });
  const updates = [];
  const definitions = (type) => ({
    ...getBlockDefinition(type),
    Inspector: ({ block: nestedBlock, update }) => React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'edit-nested-text',
        onClick: () => update((current) => ({
          ...current,
          content: {
            ...current.content,
            html: '<p>Updated text</p>',
          },
        })),
      },
      nestedBlock.content.html,
    ),
  });

  await act(async () => {
    root.render(React.createElement(AdvancedAccordionInspector, {
      block,
      update: (updater) => updates.push(updater),
      getBlockDefinition: definitions,
      listPaletteBlocks: () => [],
    }));
  });

  const selectChild = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Nested text');
  assert.ok(selectChild);
  await act(async () => selectChild.click());

  const editChild = container.querySelector('[data-testid="edit-nested-text"]');
  assert.ok(editChild);
  await act(async () => editChild.click());

  assert.equal(updates.length, 1);
  assert.equal(typeof updates[0], 'function');
  const next = updates[0](block);
  assertBlockIdentityPreserved(block, next);
  assert.equal(
    next.content.items[0].children[0].content.html,
    '<p>Updated text</p>',
  );
});

test('nested CTA layout inspector writes responsive geometry and resets tablet overrides', async () => {
  const child = {
    ...createBlock(BLOCK_TYPES.BUTTON, {
      id: 'nested-cta',
      name: 'Nested CTA',
      desktop: { x: 0, y: 0, w: 320, h: 64 },
      tablet: { w: 260, h: 56 },
    }),
    accordionLayout: {
      desktop: { mode: 'custom', align: 'left' },
      tablet: { mode: 'custom', align: 'right' },
    },
  };
  const block = makeBlock({
    items: [{
      id: 'item-one',
      title: 'Item one',
      anchor: 'item-one',
      children: [child],
    }],
  });
  const updates = [];
  const childInspectorBreakpoints = [];
  const definitions = (type) => ({
    ...getBlockDefinition(type),
    label: type === BLOCK_TYPES.BUTTON ? 'Button / CTA' : type,
    Inspector: ({ breakpoint: childBreakpoint }) => {
      childInspectorBreakpoints.push(childBreakpoint);
      return React.createElement('div', { 'data-testid': 'nested-content-inspector' });
    },
  });

  await act(async () => {
    root.render(React.createElement(AdvancedAccordionInspector, {
      block,
      breakpoint: 'tablet',
      update: (updater) => updates.push(updater),
      getBlockDefinition: definitions,
      listPaletteBlocks: () => [],
    }));
  });

  const selectChild = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Nested CTA');
  assert.ok(selectChild);
  await act(async () => selectChild.click());
  assert.ok(container.querySelector('[data-testid="advanced-accordion-child-layout"]'));
  assert.ok(container.querySelector('[data-testid="nested-content-inspector"]'));
  assert.equal(childInspectorBreakpoints.at(-1), 'tablet');

  const width = container.querySelector('[data-testid="advanced-accordion-layout-width"]');
  await act(async () => Simulate.change(width, { target: { value: '240' } }));
  const alignCenter = container.querySelector('[data-testid="advanced-accordion-layout-align-center"]');
  await act(async () => alignCenter.click());
  const fill = container.querySelector('[data-testid="advanced-accordion-layout-fill"]');
  await act(async () => fill.click());
  const reset = container.querySelector('[data-testid="advanced-accordion-layout-reset"]');
  await act(async () => reset.click());

  assert.equal(updates.length, 4);
  const widthResult = updates[0](block);
  assert.equal(widthResult.content.items[0].children[0].bp.tablet.w, 240);
  assert.equal(widthResult.content.items[0].children[0].bp.tablet.h, 56);
  const alignResult = updates[1](block);
  assert.equal(alignResult.content.items[0].children[0].accordionLayout.tablet.align, 'center');
  const fillResult = updates[2](block);
  assert.equal(fillResult.content.items[0].children[0].accordionLayout.tablet.mode, 'fill');
  const resetResult = updates[3](block);
  assert.deepEqual(resetResult.content.items[0].children[0].bp.tablet, {});
  assert.equal(resetResult.content.items[0].children[0].accordionLayout.tablet, undefined);
  assert.deepEqual(resetResult.content.items[0].children[0].accordionLayout.desktop, {
    mode: 'custom',
    align: 'left',
  });
});

test('nested layout controls are not shown when a Row or Group owns child placement', async () => {
  const nestedButton = {
    ...createBlock(BLOCK_TYPES.BUTTON, {
      id: 'row-button',
      name: 'Row button',
    }),
    accordionLayout: {
      desktop: { mode: 'custom', align: 'center' },
    },
  };
  const row = {
    ...createBlock(BLOCK_TYPES.ROW, {
      id: 'row',
      name: 'Row',
    }),
    layoutMode: 'flow',
    flow: { gap: 12, align: 'stretch' },
    children: [nestedButton],
  };
  const block = makeBlock({
    items: [{
      id: 'item-one',
      title: 'Item one',
      anchor: 'item-one',
      children: [row],
    }],
  });
  await act(async () => {
    root.render(React.createElement(AdvancedAccordionInspector, {
      block,
      breakpoint: 'desktop',
      update: () => {},
      getBlockDefinition,
      listPaletteBlocks: () => [],
    }));
  });
  const selectChild = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent.includes('Row button'));
  await act(async () => selectChild.click());
  assert.equal(container.querySelector('[data-testid="advanced-accordion-child-layout"]'), null);
  assert.match(container.textContent, /managed by its parent Row or Group layout/);
});

test('responsive nested CTA and video wrappers inherit custom size, align, height, and clamp to the panel', async () => {
  const cta = {
    ...createBlock(BLOCK_TYPES.BUTTON, {
      id: 'sized-cta',
      desktop: { x: 0, y: 0, w: 360, h: 72 },
      tablet: { w: 280, h: 60 },
    }),
    accordionLayout: {
      desktop: { mode: 'custom', align: 'center' },
      tablet: { align: 'right' },
    },
  };
  const video = {
    ...createBlock(BLOCK_TYPES.VIDEO, {
      id: 'sized-video',
      desktop: { x: 0, y: 0, w: 640, h: 360 },
      tablet: { w: 420, h: 236 },
    }),
    accordionLayout: {
      desktop: { mode: 'custom', align: 'center' },
    },
  };
  const block = makeBlock({
    initialState: 'first',
    items: [{
      id: 'item',
      title: 'Sized content',
      anchor: 'sized-content',
      children: [cta, video],
    }],
  });
  const definitions = (type) => ({
    autoHeight: false,
    allowOverflow: type === BLOCK_TYPES.BUTTON,
    Renderer: ({ block: nested, constrainToBounds }) => React.createElement(
      'div',
      {
        'data-testid': `nested-${nested.id}`,
        'data-constrained': String(!!constrainToBounds),
        style: { width: '100%', height: '100%' },
      },
    ),
    Editor: ({ block: nested, constrainToBounds }) => React.createElement(
      'div',
      {
        'data-testid': `nested-${nested.id}`,
        'data-constrained': String(!!constrainToBounds),
        style: { width: '100%', height: '100%' },
      },
    ),
  });

  await render(block, { breakpoint: 'mobile', getBlockDefinition: definitions });
  const ctaWrapper = container.querySelector('[data-advanced-accordion-child="sized-cta"]');
  const videoWrapper = container.querySelector('[data-advanced-accordion-child="sized-video"]');
  assert.equal(ctaWrapper.dataset.advancedAccordionLayoutMode, 'custom');
  assert.equal(ctaWrapper.style.width, 'min(100%, 280px)');
  assert.equal(ctaWrapper.style.maxWidth, '100%');
  assert.equal(ctaWrapper.style.alignSelf, 'flex-end');
  assert.equal(ctaWrapper.style.height, '60px');
  assert.equal(ctaWrapper.style.overflow, 'hidden');
  assert.equal(ctaWrapper.firstElementChild.dataset.constrained, 'true');
  assert.equal(videoWrapper.style.width, 'min(100%, 420px)');
  assert.equal(videoWrapper.style.alignSelf, 'center');
  assert.equal(videoWrapper.style.height, '236px');
  assert.equal(videoWrapper.firstElementChild.dataset.constrained, 'true');
});

test('legacy nested children and explicit fill mode keep the existing full-panel width', async () => {
  const legacy = createBlock(BLOCK_TYPES.BUTTON, {
    id: 'legacy-cta',
    desktop: { x: 0, y: 0, w: 180, h: 44 },
  });
  const explicitFill = {
    ...createBlock(BLOCK_TYPES.VIDEO, {
      id: 'fill-video',
      desktop: { x: 0, y: 0, w: 560, h: 315 },
    }),
    accordionLayout: {
      desktop: { mode: 'custom', align: 'right' },
      mobile: { mode: 'fill' },
    },
  };
  const block = makeBlock({
    initialState: 'first',
    items: [{
      id: 'item',
      title: 'Compatibility',
      anchor: 'compatibility',
      children: [legacy, explicitFill],
    }],
  });
  await render(block, { breakpoint: 'mobile' });

  const legacyWrapper = container.querySelector('[data-advanced-accordion-child="legacy-cta"]');
  const fillWrapper = container.querySelector('[data-advanced-accordion-child="fill-video"]');
  assert.equal(legacyWrapper.dataset.advancedAccordionLayoutMode, 'legacy-fill');
  assert.equal(legacyWrapper.style.width, '100%');
  assert.equal(legacyWrapper.firstElementChild.dataset.constrained, undefined);
  assert.equal(fillWrapper.dataset.advancedAccordionLayoutMode, 'fill');
  assert.equal(fillWrapper.style.width, '100%');
  assert.equal(fillWrapper.style.alignSelf, '');
});

test('registered CTA stays centred and registered video keeps its aspect ratio inside configured bounds', async () => {
  const cta = {
    ...createBlock(BLOCK_TYPES.BUTTON, {
      id: 'real-cta',
      desktop: { x: 0, y: 0, w: 240, h: 52 },
      content: { label: 'Apply now', href: '/apply', variant: 'default' },
    }),
    accordionLayout: { desktop: { mode: 'custom', align: 'center' } },
  };
  const video = {
    ...createBlock(BLOCK_TYPES.VIDEO, {
      id: 'real-video',
      desktop: { x: 0, y: 0, w: 400, h: 180 },
      content: { provider: 'youtube', url: '', aspectRatio: '4:3' },
    }),
    accordionLayout: { desktop: { mode: 'custom', align: 'left' } },
  };
  const block = makeBlock({
    initialState: 'first',
    items: [{
      id: 'item',
      title: 'Real renderers',
      anchor: 'real-renderers',
      children: [cta, video],
    }],
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['/api/public/typography-styles', null], []);
  await act(async () => {
    root.render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(AdvancedAccordionRender, {
        block,
        breakpoint: 'desktop',
        getBlockDefinition: getRegisteredBlockDefinition,
      }),
    ));
  });

  const ctaAnchor = container.querySelector('[data-advanced-accordion-child="real-cta"] a');
  const videoAspect = container.querySelector('[data-advanced-accordion-child="real-video"] [data-aspect]');
  assert.ok(ctaAnchor);
  assert.match(ctaAnchor.className, /justify-center/);
  assert.equal(ctaAnchor.style.width, '100%');
  assert.ok(videoAspect);
  assert.equal(videoAspect.dataset.aspect, (4 / 3).toFixed(3));
  assert.equal(videoAspect.firstElementChild.style.aspectRatio, '4 / 3');
});

test('video aspect fitting preserves ratio for both height-limited and width-limited bounds', () => {
  assert.deepEqual(fitAspectRatioWithinBounds(400, 180, 4 / 3), {
    width: 240,
    height: 180,
  });
  assert.deepEqual(fitAspectRatioWithinBounds(180, 400, 16 / 9), {
    width: 180,
    height: 101.25,
  });
  assert.equal(fitAspectRatioWithinBounds(0, 400, 16 / 9), null);
});

test('public runtime, absolute stage, and flow stage resolve the same nested mobile layout', async () => {
  const child = {
    ...createBlock(BLOCK_TYPES.VIDEO, {
      id: 'parity-video',
      desktop: { x: 0, y: 0, w: 500, h: 280 },
      tablet: { w: 360, h: 200 },
      mobile: { w: 240, h: 135 },
      content: { provider: 'youtube', url: '', aspectRatio: '16:9' },
    }),
    accordionLayout: {
      desktop: { mode: 'custom', align: 'left' },
      mobile: { align: 'center' },
    },
  };
  const stageBlock = makeBlock({
    initialState: 'first',
    items: [{
      id: 'item',
      title: 'Parity',
      anchor: 'parity',
      children: [child],
    }],
  });

  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  await render(stageBlock, { getBlockDefinition: getRegisteredBlockDefinition });
  let wrapper = container.querySelector('[data-advanced-accordion-child="parity-video"]');
  assert.equal(wrapper.style.width, 'min(100%, 240px)');
  assert.equal(wrapper.style.height, '135px');
  assert.equal(wrapper.style.alignSelf, 'center');

  await act(async () => {
    root.render(React.createElement(
      DndContext,
      null,
      React.createElement(CanvasStage, {
        blocks: [stageBlock],
        selectedIds: [],
        breakpoint: 'mobile',
        canvasWidth: 375,
        canvasHeight: 800,
        onSelect: () => {},
        onApplyGeometry: () => {},
        onMarqueeSelect: () => {},
      }),
    ));
  });
  wrapper = container.querySelector('[data-advanced-accordion-child="parity-video"]');
  assert.equal(wrapper.style.width, 'min(100%, 240px)');
  assert.equal(wrapper.style.height, '135px');
  assert.equal(wrapper.style.alignSelf, 'center');

  const accordion = createFlowNode(BLOCK_TYPES.ADVANCED_ACCORDION, {
    id: 'flow-parity-accordion',
    content: stageBlock.content,
  });
  const design = {
    version: CANVAS_FLOW_VERSION,
    root: {
      layout: 'flow',
      sections: [createFlowSection({
        id: 'flow-parity-section',
        children: [accordion],
      })],
    },
  };
  await act(async () => {
    root.render(React.createElement(
      DndContext,
      null,
      React.createElement(CanvasFlowEditorStage, {
        design,
        breakpoint: 'mobile',
        canvasWidth: 375,
        canvasHeight: 800,
        selectedIds: [],
        onSelect: () => {},
      }),
    ));
  });
  wrapper = container.querySelector('[data-advanced-accordion-child="parity-video"]');
  assert.equal(wrapper.style.width, 'min(100%, 240px)');
  assert.equal(wrapper.style.height, '135px');
  assert.equal(wrapper.style.alignSelf, 'center');
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
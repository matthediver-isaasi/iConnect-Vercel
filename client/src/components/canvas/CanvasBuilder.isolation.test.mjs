// Focused real-React tests. Only surrounding UI/registry/network components are
// stubbed; builder state, palette filtering, validators and height baking run.
// Run: node --test client/src/components/canvas/CanvasBuilder.isolation.test.mjs
import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(document, 'fonts', {
  value: { status: 'loaded', ready: Promise.resolve() },
  configurable: true,
});
globalThis.__canvasIsolationTest = { symbolsById: new Map(), scrolls: [], dragFlags: new Map() };
HTMLElement.prototype.scrollIntoView = function () {
  globalThis.__canvasIsolationTest.scrolls.push(this);
};

const passthrough = 'export default function Component({ children }) { return children || null; }';
const stubs = {
  '@dnd-kit/core': `
    import { useCallback } from 'react';
    export function DndContext(props) {
      return <div data-testid="test-dnd-context" ref={node => { if (node) node.__dndProps = props; }}>{props.children}</div>;
    }
    export const DragOverlay = ({ children }) => children;
    export function PointerSensor() {}
    export const useSensor = (...args) => args;
    export const useSensors = (...args) => args;
    export function useDraggable({ id, disabled }) {
      globalThis.__canvasIsolationTest.dragFlags.set(id, disabled);
      return { attributes: {}, listeners: {}, setNodeRef: useCallback(() => {}, []), isDragging: false };
    }
  `,
  '@/components/ui/button': `
    export function Button({ children, variant, size, ...props }) { return <button {...props}>{children}</button>; }
  `,
  '@/components/ui/badge': `
    export function Badge({ children, variant, ...props }) { return <span {...props}>{children}</span>; }
  `,
  '@/components/ui/alert-dialog': `
    const Part = ({ children }) => <div>{children}</div>;
    export const AlertDialog = ({ open, children }) => open ? <div>{children}</div> : null;
    export const AlertDialogAction = Part, AlertDialogCancel = Part, AlertDialogContent = Part,
      AlertDialogDescription = Part, AlertDialogFooter = Part, AlertDialogHeader = Part, AlertDialogTitle = Part;
  `,
  './blocks/registry': `
    export const getBlockDefinition = type => ({ autoHeight: type === 'text', autoSize: type === 'button' });
    export const BLOCK_CATEGORIES = [{ id: 'all', label: 'All' }];
    export const listPaletteBlocks = () => ['box', 'text', 'advanced-accordion', 'symbol', 'row', 'group', 'unknown']
      .map(type => ({ type, label: type, category: 'all' }));
  `,
  './CanvasStage': `
    export default function Stage(props) {
      return <div data-testid="canvas-stage" ref={node => { if (node) node.__stageProps = props; }}>
        {props.blocks.map(block => <div key={block.id} data-block-id={block.id} data-testid={'canvas-block-' + block.id} />)}
      </div>;
    }
  `,
  './CanvasFlowEditorStage': 'export default function Flow() { return <div data-testid="flow-stage" />; }',
  './CanvasSymbolsContext': `
    export const useCanvasSymbolsData = () => ({ symbolsById: globalThis.__canvasIsolationTest.symbolsById });
    export const CanvasSymbolsProvider = ({ children }) => children;
  `,
  './CanvasAnchorContext': 'export const CanvasAnchorProvider = ({ children }) => children;',
  './CanvasEditorPageContext': 'export const CanvasEditorPageProvider = ({ children }) => children;',
  './CanvasSwatchContext': 'export const CanvasSwatchProvider = ({ children }) => children;',
  './CanvasInspector': 'export default function Inspector() { return null; }',
  './CanvasLayers': 'export default function Layers() { return null; }',
  './CanvasGuides': 'export default function Guides() { return null; }',
  './CanvasPalettePanel': 'export default function PalettePanel() { return null; }',
  './CanvasFloatingPanel': passthrough,
  './useEdgeAutoScroll': `
    const api = { update() {}, stop() {} };
    export default function useEdgeAutoScroll() { return api; }
  `,
};
const temporary = await mkdtemp(path.join(process.cwd(), '.canvas-builder-isolation-'));
const bundlePath = path.join(temporary, 'bundle.mjs');
await build({
  stdin: {
    contents: `
      export { default as CanvasBuilder } from './client/src/components/canvas/CanvasBuilder.jsx';
      export { createBlock, getRootChildren, getBlockDefaults, normalizeCanvasDesign, resolveBlockAtBreakpoint } from './client/src/lib/canvasDesign.js';
    `,
    resolveDir: process.cwd(),
    loader: 'jsx',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
  alias: { '@': path.join(process.cwd(), 'client/src') },
  logLevel: 'silent',
  plugins: [{
    name: 'canvas-test-surrounding-ui',
    setup(api) {
      api.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(stubs, args.path)
        ? { path: args.path, namespace: 'canvas-test-stub' } : undefined);
      api.onLoad({ filter: /.*/, namespace: 'canvas-test-stub' }, (args) => ({
        contents: stubs[args.path], loader: 'jsx', resolveDir: process.cwd(),
      }));
    },
  }],
});
const { CanvasBuilder, createBlock, getRootChildren, getBlockDefaults, normalizeCanvasDesign, resolveBlockAtBreakpoint } =
  await import(pathToFileURL(bundlePath).href);
after(async () => {
  await rm(temporary, { recursive: true, force: true });
  dom.window.close();
});

const designWith = (...children) => ({ version: 1, root: { sections: [{ id: 'root', children }] } });
const block = (id, type = 'box', overrides = {}) => createBlock(type, { id, ...overrides });
const snapshot = (ref) => JSON.stringify(ref.current.getDesign());
const pause = async (ms) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };
const key = (value, options = {}, target = window) => {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  act(() => target.dispatchEvent(event));
  return event;
};
let container, root, refs, props;
beforeEach(() => {
  globalThis.__canvasIsolationTest.symbolsById = new Map();
  globalThis.__canvasIsolationTest.scrolls = [];
  globalThis.__canvasIsolationTest.dragFlags.clear();
  window.localStorage.clear();
  delete window.__canvasClipboard;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  refs = [React.createRef(), React.createRef()];
  props = [];
});
afterEach(async () => {
  await pause(60); // Flush delayed scrolls while still inside act.
  act(() => root.unmount());
  container.remove();
});
function render(...updates) {
  props = updates;
  act(() => root.render(React.createElement(React.Fragment, null, ...props.map((item, index) =>
    React.createElement('section', { key: index, 'data-instance': index },
      React.createElement(CanvasBuilder, { ref: refs[index], breakpoint: 'desktop', ...item }))))));
}
const instance = (index) => container.querySelector(`[data-instance="${index}"]`);
const stage = (index) => instance(index).querySelector('[data-testid="canvas-stage"]');
const stageProps = (index) => stage(index).__stageProps;
const click = (index, testId) => act(() => instance(index).querySelector(`[data-testid="${testId}"]`).click());
function geometry(index, { left, top, width = 800, height = 600, stageLeft = left, stageTop = top }) {
  const wrap = instance(index).querySelector('[data-testid="panel-stage"]');
  wrap.getBoundingClientRect = () => ({ left, top, width, height });
  Object.defineProperties(wrap, { clientWidth: { value: width, configurable: true }, clientHeight: { value: height, configurable: true } });
  stage(index).getBoundingClientRect = () => ({ left: stageLeft, top: stageTop, width, height });
}

test('suspended host retains document, dirty, history and selection while only the symbol handles keyboard/clipboard/save', async () => {
  const hostInitial = designWith(block('same', 'box', { name: 'Host' }));
  const symbolInitial = designWith(block('same', 'box', { name: 'Symbol' }));
  const saves = [[], []], dirtySignals = [[], []];
  const host = { initialDesign: hostInitial, onSave: value => saves[0].push(value), onDirtyChange: value => dirtySignals[0].push(value) };
  const symbol = { initialDesign: symbolInitial, symbolEditing: true, onSave: value => saves[1].push(value), onDirtyChange: value => dirtySignals[1].push(value) };
  render(host);
  act(() => refs[0].current.addBlocks([{ type: 'box', id: 'host-edit' }]));
  act(() => refs[0].current.setSelection(['same']));
  const hostSnapshot = snapshot(refs[0]);
  render({ ...host, interactionEnabled: false }, symbol);
  act(() => refs[1].current.setSelection(['same']));
  assert.equal(refs[0].current.isDirty(), true);
  assert.equal(instance(0).querySelector('[data-testid="canvas-builder"]').hasAttribute('inert'), true);
  key('c', { ctrlKey: true });
  assert.equal(window.__canvasClipboard[0].name, 'Symbol');
  key('x', { ctrlKey: true });
  assert.equal(getRootChildren(refs[1].current.getDesign()).length, 0);
  key('z', { ctrlKey: true });
  key('v', { ctrlKey: true });
  key('d', { ctrlKey: true });
  key('ArrowRight');
  key('Delete');
  key('z', { ctrlKey: true });
  key('z', { ctrlKey: true, shiftKey: true });
  key('s', { ctrlKey: true });
  await pause(0);
  assert.equal(saves[0].length, 0);
  assert.equal(saves[1].length, 1);
  assert.equal(snapshot(refs[0]), hostSnapshot);
  assert.deepEqual(refs[0].current.getSelectedIds(), ['same']);
  assert.equal(refs[0].current.isDirty(), true);
  assert.deepEqual(dirtySignals[0], [false, true]);
  assert.equal(await refs[0].current.saveNow(), false);
  act(() => {
    assert.deepEqual(refs[0].current.addBlocks([{ type: 'box' }]), []);
    assert.equal(refs[0].current.setDesign(hostInitial), false);
    refs[0].current.setSelection([]);
    refs[0].current.autoOrder();
  });
  assert.equal(snapshot(refs[0]), hostSnapshot);
  assert.deepEqual(refs[0].current.getSelectedIds(), ['same']);
  render(host);
  key('z', { ctrlKey: true });
  assert.equal(snapshot(refs[0]), JSON.stringify(normalizeCanvasDesign(hostInitial)));
  assert.equal(refs[0].current.isDirty(), false);
  key('z', { ctrlKey: true, shiftKey: true });
  assert.equal(snapshot(refs[0]), hostSnapshot);
  assert.deepEqual(refs[0].current.getSelectedIds(), ['same']);
});

test('a disabled single builder does not consume global key events or overwrite the shared clipboard', () => {
  render({ initialDesign: designWith(block('host')), interactionEnabled: false });
  const sentinel = [{ id: 'clipboard-owned-by-active-editor' }];
  window.__canvasClipboard = sentinel;
  for (const shortcut of ['c', 'x', 'v', 'z', 'y', 's', 'd', 'g']) {
    assert.equal(key(shortcut, { ctrlKey: true }).defaultPrevented, false);
  }
  assert.equal(key('Delete').defaultPrevented, false);
  assert.equal(key(' ', { code: 'Space' }).defaultPrevented, false);
  assert.equal(window.__canvasClipboard, sentinel);
  assert.equal(globalThis.__canvasIsolationTest.dragFlags.get('palette-box'), true);
});

test('symbol save yields to an already-consumed shortcut, and a successful in-flight save still clears dirty while suspended', async () => {
  let finishSave, saves = 0;
  const pending = new Promise(resolve => { finishSave = resolve; });
  const symbol = {
    initialDesign: designWith(block('original')),
    symbolEditing: true,
    onSave: () => { saves += 1; return pending; },
  };
  const shellKey = event => { if (event.key === 's') event.preventDefault(); };
  window.addEventListener('keydown', shellKey);
  try {
    render(symbol);
    act(() => refs[0].current.addBlocks([{ type: 'text' }]));
    key('s', { ctrlKey: true });
    assert.equal(saves, 0);
  } finally {
    window.removeEventListener('keydown', shellKey);
  }
  let saveResult;
  act(() => { saveResult = refs[0].current.saveNow(); });
  assert.equal(saves, 1);
  render({ ...symbol, interactionEnabled: false });
  assert.equal(await refs[0].current.saveNow(), false);
  await act(async () => {
    finishSave();
    assert.equal(await saveResult, true);
  });
  assert.equal(refs[0].current.isDirty(), false);
  render(symbol);
  assert.equal(instance(0).querySelector('[data-testid="button-undo"]').disabled, false);
});

test('palette, programmatic insertion, clipboard and setDesign reject unsupported symbol structures without modifying history', () => {
  const initial = designWith(block('valid'));
  render({ initialDesign: initial, symbolEditing: true });
  const original = snapshot(refs[0]);
  for (const type of ['box', 'text', 'advanced-accordion']) {
    assert.ok(instance(0).querySelector(`[data-testid="palette-item-${type}"]`));
  }
  for (const type of ['symbol', 'row', 'group', 'unknown']) {
    assert.equal(instance(0).querySelector(`[data-testid="palette-item-${type}"]`), null);
    act(() => assert.deepEqual(refs[0].current.addBlocks([{ type }]), []));
    window.__canvasClipboard = [block('forbidden', type)];
    key('v', { ctrlKey: true });
    assert.equal(snapshot(refs[0]), original);
  }
  const nested = { ...block('nested'), children: [block('child')] };
  const nestedAccordion = block('accordion', 'advanced-accordion', {
    content: { items: [{ id: 'item', children: [block('nested-symbol', 'symbol')] }] },
  });
  const accordionInsideAccordion = block('outer', 'advanced-accordion', {
    content: { items: [{ id: 'item', children: [block('inner', 'advanced-accordion')] }] },
  });
  for (const candidate of [nested, nestedAccordion, accordionInsideAccordion]) {
    act(() => assert.deepEqual(refs[0].current.addBlocks([candidate]), []));
    window.__canvasClipboard = [candidate];
    key('v', { ctrlKey: true });
  }
  for (const invalid of [
    { ...initial, version: 2 },
    { ...initial, root: { ...initial.root, layout: 'flow' } },
    { ...initial, root: { sections: [...initial.root.sections, { id: 'extra', children: [] }] } },
    designWith(nested),
  ]) {
    act(() => assert.equal(refs[0].current.setDesign(invalid), false));
  }
  assert.equal(snapshot(refs[0]), original);
  assert.equal(refs[0].current.isDirty(), false);
  assert.equal(instance(0).querySelector('[data-testid="button-undo"]').disabled, true);
  assert.ok(instance(0).querySelector('[role="alert"]').textContent);
  act(() => assert.equal(refs[0].current.addBlocks([{ type: 'text' }]).length, 1));
  assert.equal(getRootChildren(refs[0].current.getDesign()).length, 2);
  assert.equal(instance(0).querySelector('[role="alert"]'), null);
  // Top-level advanced accordions remain supported; only their disallowed
  // nested structures are rejected.
  act(() => assert.equal(refs[0].current.addBlocks([{ type: 'advanced-accordion' }]).length, 1));
  key('z', { ctrlKey: true });
  key('z', { ctrlKey: true });
  assert.equal(snapshot(refs[0]), original);
});

test('concurrent builders use their own insertion/drop coordinates and scroll targets, including duplicate block ids', async () => {
  render({ initialDesign: designWith(block('same')) }, { initialDesign: designWith(block('same')), symbolEditing: true });
  geometry(0, { left: 100, top: 50, stageLeft: 120, stageTop: 70 });
  geometry(1, { left: 2000, top: 1000, stageLeft: 2100, stageTop: 1100 });
  act(() => refs[1].current.setSelection(['same']));
  await pause(60);
  assert.deepEqual(globalThis.__canvasIsolationTest.scrolls, [stage(1).querySelector('[data-testid="canvas-block-same"]')]);
  globalThis.__canvasIsolationTest.scrolls = [];
  let inserted;
  act(() => { inserted = refs[1].current.addBlocks([{ type: 'box' }]); });
  const added = getRootChildren(refs[1].current.getDesign()).find(item => item.id === inserted[0]);
  const defaults = getBlockDefaults('box').geom;
  assert.equal(added.bp.desktop.x, Math.max(0, Math.round((Math.round(300 / 8) * 8 - defaults.w / 2) / 8) * 8));
  assert.equal(added.bp.desktop.y, Math.max(0, Math.round((200 - defaults.h / 2) / 8) * 8));
  await pause(60);
  assert.deepEqual(globalThis.__canvasIsolationTest.scrolls, [stage(1).querySelector(`[data-testid="canvas-block-${inserted[0]}"]`)]);
  const dnd = instance(1).querySelector('[data-testid="test-dnd-context"]').__dndProps;
  const active = { id: 'palette-box', data: { current: { type: 'box', fromPalette: true } } };
  act(() => {
    dnd.onDragStart({ active, activatorEvent: { clientX: 2260, clientY: 1300 } });
    dnd.onDragEnd({ active, over: { id: 'canvas-drop-zone' } });
  });
  const dropped = getRootChildren(refs[1].current.getDesign()).at(-1);
  assert.equal(dropped.bp.desktop.x, 120);
  assert.equal(dropped.bp.desktop.y, 160);
  assert.equal(getRootChildren(refs[0].current.getDesign()).length, 1);
  // Even when both are enabled, a key originating in one root is not handled
  // by the sibling editor.
  act(() => refs[0].current.setSelection(['same']));
  key('Delete', {}, stage(1).querySelector('[data-testid="canvas-block-same"]'));
  assert.equal(getRootChildren(refs[0].current.getDesign()).length, 1);
});

test('suspension invalidates queued auto-height writes and preserves undo as an author operation', async () => {
  const initial = designWith(block('text', 'text', { desktop: { h: 100 } }));
  const host = { initialDesign: initial };
  render(host);
  await pause(30); // Font + two-frame layout settle gate.
  act(() => refs[0].current.addBlocks([{ type: 'box', id: 'edited' }]));
  const before = snapshot(refs[0]);
  act(() => stageProps(0).onCommitAutoHeight('text', 400));
  const staleCommit = stageProps(0).onCommitAutoHeight;
  render({ ...host, interactionEnabled: false });
  assert.equal(stageProps(0).onCommitAutoHeight, undefined);
  assert.equal(stageProps(0).onCommitAutoSize, undefined);
  act(() => staleCommit('text', 500));
  await pause(250);
  assert.equal(snapshot(refs[0]), before);
  assert.equal(refs[0].current.isDirty(), true);
  render(host);
  // Measurements still pending from before a quick suspend/resume cannot bake.
  act(() => stageProps(0).onCommitAutoHeight('text', 450));
  render({ ...host, interactionEnabled: false });
  render(host);
  await pause(250);
  assert.equal(snapshot(refs[0]), before);
  // A new measurement after resume can bake, without consuming the next
  // author edit's undo slot.
  act(() => stageProps(0).onCommitAutoHeight('text', 350));
  await pause(250);
  assert.equal(getRootChildren(refs[0].current.getDesign())[0].bp.desktop.h, 350);
  key('z', { ctrlKey: true });
  assert.equal(snapshot(refs[0]), JSON.stringify(normalizeCanvasDesign(initial)));
});

test('refreshing symbols only changes fitted display bounds, never host design, dirty state or undo history', () => {
  const initial = designWith(block('instance', 'symbol', {
    content: { symbolId: 'shared-symbol' },
    desktop: { x: 160, y: 80, w: 30, h: 30 },
    tablet: { x: 32, y: 16 },
  }));
  const host = { initialDesign: initial, interactionEnabled: false };
  render(host);
  const original = snapshot(refs[0]);
  globalThis.__canvasIsolationTest.symbolsById = new Map([['shared-symbol', {
    id: 'shared-symbol', design: designWith(block('content', 'box', { desktop: { x: 0, y: 0, w: 640, h: 180 } })),
  }]]);
  render(host);
  let fitted = resolveBlockAtBreakpoint(stageProps(0).blocks[0], 'desktop');
  assert.deepEqual([fitted.x, fitted.y, fitted.w, fitted.h], [160, 80, 640, 180]);
  globalThis.__canvasIsolationTest.symbolsById = new Map([['shared-symbol', {
    id: 'shared-symbol', design: designWith(block('content', 'box', {
      desktop: { x: 0, y: 0, w: 920, h: 320 }, tablet: { x: 0, y: 0, w: 500, h: 240 },
    })),
  }]]);
  render(host);
  fitted = resolveBlockAtBreakpoint(stageProps(0).blocks[0], 'tablet');
  assert.deepEqual([fitted.x, fitted.y, fitted.w, fitted.h], [32, 16, 500, 240]);
  assert.equal(snapshot(refs[0]), original);
  assert.equal(refs[0].current.isDirty(), false);
  render({ ...host, interactionEnabled: true });
  assert.equal(instance(0).querySelector('[data-testid="button-undo"]').disabled, true);
  assert.equal(snapshot(refs[0]), original);
});
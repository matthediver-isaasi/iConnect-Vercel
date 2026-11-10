import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  addTableColumn,
  estimateDataTableHeight,
  normalizeTableContent,
  resolveTableLines,
} from '../../../lib/canvasDataTable.js';
import { createBlock, normalizeCanvasDesign } from '../../../lib/canvasDesign.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test/' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'CustomEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.__TENANT_TYPOGRAPHY_STYLES__ = [];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => ({ ok: true, json: async () => [] });
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { getBlockDefinition } = await import('./registry.jsx');
const definition = getBlockDefinition('data-table');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const providers = (child) => <QueryClientProvider client={queryClient}>{child}</QueryClientProvider>;
const content = {
  columns: [{ id: 'a', heading: 'Member' }, { id: 'b', heading: 'Role' }],
  rows: [{ id: 'r', cells: { a: 'Asha', b: 'Trustee' } }],
};
const block = (settings = {}) => ({ ...createBlock('data-table'), id: 'table-lines', content: { ...content, ...settings } });
const render = (settings = {}, asEditor = false) => {
  const Renderer = asEditor ? definition.Editor : definition.Renderer;
  return new JSDOM(renderToStaticMarkup(providers(<Renderer block={block(settings)} asEditor={asEditor} breakpoint="mobile" />))).window.document;
};

test('legacy defaults are absent from saved content and render unchanged', () => {
  const normalized = normalizeTableContent(content);
  for (const key of ['horizontalLines', 'verticalLines', 'horizontalLineWidth', 'verticalLineWidth', 'horizontalLineColor', 'verticalLineColor']) {
    assert.equal(Object.hasOwn(normalized, key), false);
    assert.equal(Object.hasOwn(block().content, key), false);
  }
  assert.equal(estimateDataTableHeight(content), 83);
  for (const asEditor of [true, false]) {
    const doc = render({}, asEditor);
    assert.equal(doc.querySelector('thead tr').className, 'border-b-2 border-slate-300');
    assert.equal(doc.querySelector('tbody tr').className, 'border-b border-slate-200');
    assert.equal(doc.querySelector('thead tr').getAttribute('style'), null);
    assert.equal(doc.querySelector('tbody tr').getAttribute('style'), null);
    assert.equal(doc.querySelector('th').getAttribute('style'), null);
    assert.equal(doc.querySelector('colgroup'), null);
    assert.match(doc.querySelector('table').className, /table-fixed border-collapse/);
  }
});

test('each axis can be toggled independently in the shared editor and public renderer', () => {
  assert.equal(definition.Editor, definition.Renderer);
  for (const asEditor of [false, true]) {
    for (const horizontalLines of [true, false]) {
      for (const verticalLines of [true, false]) {
        const doc = render({
          horizontalLines, verticalLines,
          horizontalLineWidth: 3.5, horizontalLineColor: '#123456',
          verticalLineWidth: 2, verticalLineColor: '#aabbcc',
        }, asEditor);
        for (const row of doc.querySelectorAll('tr')) {
          assert.equal(row.style.borderBottomWidth, horizontalLines ? '3.5px' : '0px');
          assert.equal(row.style.borderBottomColor, 'rgb(18, 52, 86)');
        }
        for (const selector of ['th', 'td']) {
          const cells = doc.querySelectorAll(selector);
          assert.equal(cells[0].style.borderRightWidth, verticalLines ? '2px' : '');
          assert.equal(cells[0].style.borderRightColor, verticalLines ? 'rgb(170, 187, 204)' : '');
          assert.equal(cells[1].style.borderRight, '', 'no outer border');
        }
      }
    }
  }
});

test('settings survive normalization, column edits and design save/reload without geometry changes', () => {
  const settings = {
    horizontalLines: false, verticalLines: true,
    horizontalLineWidth: 4.5, horizontalLineColor: '#345',
    verticalLineWidth: 2.5, verticalLineColor: '#bcd123',
  };
  const original = block(settings);
  const edited = { ...original, content: addTableColumn(original.content, 'Region') };
  const design = normalizeCanvasDesign(JSON.parse(JSON.stringify({
    version: 1, root: { sections: [{ id: 'root', children: [edited] }] },
  })));
  const saved = design.root.sections[0].children[0];
  for (const [key, value] of Object.entries(settings)) assert.equal(saved.content[key], value);
  assert.deepEqual(saved.bp, original.bp);
  assert.deepEqual(saved.style, original.style);
  assert.equal(saved.content.columns[0].widthPercent, undefined);
  assert.equal(resolveTableLines(saved.content).verticalWidth, 2.5);
});

test('line helpers reject malformed widths and colours, without mutating author content', () => {
  for (const invalid of [-1, 13, NaN, Infinity, '3', true, null]) {
    const settings = { horizontalLineWidth: invalid, verticalLineWidth: invalid, verticalLines: true };
    const resolved = resolveTableLines(settings);
    assert.equal(resolved.headerWidth, 2);
    assert.equal(resolved.bodyWidth, 1);
    assert.equal(resolved.verticalWidth, 1);
    assert.equal(settings.horizontalLineWidth, invalid);
  }
  assert.equal(resolveTableLines({ horizontalLineColor: 'url(unsafe)' }).headerStyle.borderBottomColor, undefined);
  assert.equal(resolveTableLines({ horizontalLineColor: ' #aBc ' }).headerStyle.borderBottomColor, '#aBc');
  assert.equal(resolveTableLines({ horizontalLineWidth: 0 }).headerWidth, 0);
});

test('height estimation includes opted-in horizontal widths and hidden lines at each breakpoint', () => {
  for (const breakpoint of ['desktop', 'tablet', 'mobile']) {
    const estimate = (settings) => estimateDataTableHeight({ ...content, ...settings }, breakpoint);
    assert.equal(estimate({ horizontalLineWidth: 4 }), 88);
    assert.equal(estimate({ horizontalLines: false, horizontalLineWidth: 4 }), 80);
    assert.equal(estimate({ verticalLines: true, verticalLineWidth: 4 }), 83);
    assert.equal(estimate({ horizontalLineWidth: 0 }), 80);
  }
});

test('inspector edits content only, keeps disabled-axis choices and clearing restores defaults', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current = block();
  const originalStyle = structuredClone(current.style);
  const originalGeometry = structuredClone(current.bp);
  const Inspector = definition.Inspector;
  const draw = () => root.render(providers(<Inspector block={current} update={(updater) => {
    current = updater(current);
    draw();
  }} />));
  const input = async (testId, value, colorText = false) => {
    await act(async () => {
      const picker = host.querySelector(`[data-testid="${testId}"]`);
      const element = colorText ? picker?.parentElement.querySelector('input:not([type="color"])') : picker;
      assert.ok(element, testId);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const toggle = async (axis) => act(async () => host.querySelector(`[data-testid="table-${axis}-lines"]`).click());
  try {
    await act(async () => draw());
    await input('table-horizontal-line-width', '3.5');
    assert.equal(current.content.horizontalLineWidth, 3.5);
    await input('table-horizontal-line-color', '#246abc', true);
    assert.equal(current.content.horizontalLineColor, '#246abc');
    await toggle('vertical');
    await input('table-vertical-line-width', '2');
    assert.equal(current.content.verticalLineWidth, 2);
    await input('table-vertical-line-color', '#cba642', true);
    assert.equal(current.content.verticalLineColor, '#cba642');
    await toggle('horizontal');
    assert.equal(current.content.horizontalLines, false);
    assert.equal(current.content.horizontalLineWidth, 3.5);
    assert.equal(current.content.horizontalLineColor, '#246abc');
    await toggle('horizontal');
    await input('table-horizontal-line-width', '');
    assert.equal(Object.hasOwn(current.content, 'horizontalLineWidth'), false);
    await input('table-horizontal-line-color', '', true);
    assert.equal(Object.hasOwn(current.content, 'horizontalLineColor'), false);
    await toggle('vertical');
    await toggle('vertical');
    assert.equal(current.content.verticalLineWidth, 2);
    assert.equal(current.content.verticalLineColor, '#cba642');
    assert.deepEqual(current.style, originalStyle);
    assert.deepEqual(current.bp, originalGeometry);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

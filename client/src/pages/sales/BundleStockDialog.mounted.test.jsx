import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/sales/catalogue/bundles' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'DocumentFragment']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const BundleStockDialog = (await import('./BundleStockDialog.jsx')).default;
after(() => dom.window.close());

test('stock editor saves explicit Unlimited as null with the original version; conflicts require reload', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const row = { id: 'bundle-one', name: 'Delegate package', bundleStock: { remaining: 9, reserved: 3, version: 12, requiresAttention: true } };
  const calls = [];
  let fail = false;
  let reloads = 0;
  await act(async () => root.render(<BundleStockDialog row={row} onClose={() => {}} onRefresh={() => reloads++} onSave={async payload => {
    calls.push(payload);
    if (fail) throw Object.assign(new Error('Changed'), { status: 409 });
  }} />));
  try {
    assert.match(document.body.textContent, /Available: 9 · Reserved: 3/);
    assert.match(document.body.textContent, /Reserved holds need administrator review/);
    await act(async () => document.querySelector('[role="checkbox"]').click());
    assert.equal(document.querySelector('#bundle-stock-remaining'), null);
    await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(calls[0], { id: row.id, remaining: null, expectedVersion: 12 });
    fail = true;
    await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.match(document.body.textContent, /Stock changed while you were editing/);
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === 'Save stock').disabled, true);
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload current stock').click());
    assert.equal(reloads, 1);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

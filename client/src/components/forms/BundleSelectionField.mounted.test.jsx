import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/offers' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'location']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
localStorage.setItem('tenant_slug', 'test-tenant');
const output = await build({
  entryPoints: ['client/src/components/forms/BundleSelectionField.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent',
});
const module = new Module(`${process.cwd()}/bundle-field-test.cjs`);
module.filename = `${process.cwd()}/bundle-field-test.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(output.outputFiles[0].text, module.filename);
const BundleSelectionField = module.exports.default;
const require = createRequire(import.meta.url);
const React = require('react');
globalThis.React = React;
const { act, useState } = React;
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const id = '12345678-1234-4234-8234-123456789012';
const field = { id: 'offer', label: 'Your bundle', required: true, type: 'sales_bundle' };
const item = { id, name: 'Delegate package', amountMinor: 8750, currency: 'GBP', available: true, remaining: 7 };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
async function mount(initialValue = '') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const answers = [];
  function Fixture() {
    const [value, setValue] = useState(initialValue);
    return <BundleSelectionField field={field} formId="form-one" value={value} onChange={next => { answers.push(next); setValue(next); }} />;
  }
  await act(async () => root.render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>));
  return { container, answers, close: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
test('loading, retryable error and authoritative empty options are distinct', async () => {
  let resolve;
  globalThis.fetch = () => new Promise(done => { resolve = done; });
  const fixture = await mount();
  try {
    assert.match(fixture.container.textContent, /Loading bundles/);
    await act(async () => resolve({ ok: false, status: 503, text: async () => '{"error":"Unavailable"}' }));
    await settle();
    assert.match(fixture.container.textContent, /could not be loaded/);
    assert.doesNotMatch(fixture.container.textContent, /No bundles are currently offered/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
    await act(async () => fixture.container.querySelector('button').click());
    await settle();
    assert.match(fixture.container.textContent, /No bundles are currently offered/);
  } finally { await fixture.close(); }
});
test('sold-out bundles remain visible and disabled; selection remains a UUID', async () => {
  let requestOptions;
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    return { ok: true, json: async () => ({ items: [item, { ...item, id: 'sold', name: 'Sold package', available: false, remaining: 0 }] }) };
  };
  const fixture = await mount();
  try {
    await settle();
    assert.equal(requestOptions.credentials, 'include');
    const select = fixture.container.querySelector('select');
    assert.equal(select.querySelector('option[value="sold"]').disabled, true);
    await act(async () => { select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.deepEqual(fixture.answers, [id]);
  } finally { await fixture.close(); }
});
test('stock conflict refreshes options and clears only this bundle answer', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ items: [item] }) }; };
  const fixture = await mount(id);
  try {
    await settle();
    await act(async () => window.dispatchEvent(new CustomEvent('form-bundle-unavailable', { detail: { formId: 'different-form' } })));
    assert.deepEqual(fixture.answers, []);
    await act(async () => window.dispatchEvent(new CustomEvent('form-bundle-unavailable', { detail: { formId: 'form-one' } })));
    await settle();
    assert.deepEqual(fixture.answers, ['']);
    assert.equal(calls, 2);
    assert.match(fixture.container.textContent, /other answers have been kept/);
    assert.equal(fixture.container.querySelector('select').value, '');
  } finally { await fixture.close(); }
});

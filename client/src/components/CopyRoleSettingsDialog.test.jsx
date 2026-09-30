import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'HTMLInputElement', 'MutationObserver', 'CustomEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const CopyRoleSettingsDialog = (await import('./CopyRoleSettingsDialog.jsx')).default;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });

test('distinct selection, named destructive confirmation, reset, errors, pending and success', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  let copied = null;
  let requests = 0;
  let resolveRequest;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests += 1;
    return new Promise(resolve => { resolveRequest = resolve; });
  };
  const choose = async (id, value) => act(async () => {
    const select = document.getElementById(id);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const replaceButton = () => [...document.querySelectorAll('button')].find(button => /Replace target settings|Copying settings/.test(button.textContent));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <CopyRoleSettingsDialog roles={[{ id: 's', name: 'Source Alpha' }, { id: 't', name: 'Target Beta' }, { id: 'u', name: 'Other Gamma' }]}
        onClose={() => {}} onCopied={role => { copied = role; }} />
    </QueryClientProvider>));
    assert.equal(replaceButton().disabled, true);
    await choose('copy-role-source', 's');
    assert.equal(document.querySelector('#copy-role-target option[value="s"]').disabled, true);
    await choose('copy-role-target', 't');
    assert.match(document.body.textContent, /Member Preferences role field permissions/);
    assert.match(document.body.textContent, /I confirm replacing settings on Target Beta with saved settings from Source Alpha/);
    assert.equal(replaceButton().disabled, true);
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    assert.equal(replaceButton().disabled, false);
    await choose('copy-role-target', 'u');
    assert.equal(replaceButton().disabled, true);
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    await act(async () => replaceButton().click());
    await settle();
    assert.equal(requests, 1);
    assert.equal(replaceButton().disabled, true);
    assert.equal(document.getElementById('copy-role-source').disabled, true);
    await act(async () => resolveRequest({ ok: false, json: async () => ({ error: 'Copy denied' }) }));
    await settle();
    assert.equal(document.querySelector('[role="alert"]').textContent, 'Copy denied');
    assert.equal(copied, null);
    await act(async () => replaceButton().click());
    await settle();
    await act(async () => resolveRequest({ ok: true, json: async () => ({ role: { id: 'u' } }) }));
    await settle();
    assert.deepEqual(copied, { id: 'u' });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
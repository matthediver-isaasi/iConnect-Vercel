import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEmailFooterSettings } from '../hooks/useEmailFooterSettings.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function mount({ member = false, missing = false, delay, failing = false, unresolved = false } = {}) {
  let tenant = null;
  let serverTenant = 'a';
  let current;
  const listeners = new Set();
  const calls = [];
  const writes = [];
  const getActiveTenantId = () => tenant;
  const subscribeToActiveTenantId = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const target = options.headers?.['X-Tenant-Id'] || serverTenant;
    if (url === '/api/auth/tenant-user-me') {
      if (delay?.auth) await delay.auth.promise;
      return response(member || unresolved ? { authenticated: false } : { authenticated: true, tenant: { id: target } });
    }
    if (url === '/api/auth/me') return response(unresolved ? null : { id: 'member', tenant_id: target });
    if (options.method) {
      writes.push({ url, options });
      return response({ id: `footer-${target}`, tenant_id: target, setting_key: 'email_footer_html', ...JSON.parse(options.body) });
    }
    const key = JSON.parse(new URL(url, 'http://localhost').searchParams.get('filter')).setting_key;
    if (key === 'email_footer_html' && delay?.[target]) await delay[target].promise;
    if (failing) return response({ error: 'Service unavailable' }, 503);
    if (key === 'social_icons_config') return response([{ id: 'social', tenant_id: target, setting_key: key, setting_value: '[{"platform":"linkedin","url":"https://example.org"}]' }]);
    return response(missing ? [] : [{ id: `footer-${target}`, tenant_id: target, setting_key: key, setting_value: `<table data-tenant="${target}"><tr><td>Saved &amp; intact</td></tr></table>` }]);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Editor() {
    current = useEmailFooterSettings({ getActiveTenantId, subscribeToActiveTenantId });
    return React.createElement('div', null,
      React.createElement('textarea', { value: current.html, readOnly: !current.ready, onChange: e => current.setHtml(e.target.value) }),
      React.createElement('button', { disabled: !current.ready || current.saving, onClick: () => current.save() }, 'Save'),
      React.createElement('output', null, current.error?.message || (current.loading ? 'loading' : current.missing ? 'missing' : 'saved')));
  }
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Editor))));
  await settle();
  return {
    calls, writes, container,
    get current() { return current; },
    async switch(next) { await act(async () => { tenant = next; serverTenant = next; listeners.forEach(listener => listener(next)); }); await settle(); },
    async recover() { failing = false; unresolved = false; await act(async () => { await current.retry(); }); await settle(); },
    async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}

for (const member of [false, true]) {
  test(`mounted ${member ? 'member' : 'admin'} direct entry loads exact saved HTML and social configuration`, async () => {
    const view = await mount({ member });
    try {
      assert.equal(view.current.ready, true);
      assert.equal(view.container.querySelector('textarea').value, '<table data-tenant="a"><tr><td>Saved &amp; intact</td></tr></table>');
      assert.equal(view.current.socialIcons[0].platform, 'linkedin');
      assert.equal(view.calls.filter(call => call.url.startsWith('/api/entities/')).length, 2);
      await act(async () => view.current.setHtml('<p>Edited HTML &amp; entities</p>'));
      await act(async () => { await view.current.save(); });
      assert.equal(view.writes[0].options.method, 'PATCH');
      assert.equal(view.writes[0].url, '/api/entities/SystemSettings/footer-a');
      assert.equal(JSON.parse(view.writes[0].options.body).setting_value, '<p>Edited HTML &amp; entities</p>');
    } finally { await view.cleanup(); }
  });
}

test('confirmed missing footer permits create, then updates the newly saved row', async () => {
  const view = await mount({ missing: true });
  try {
    assert.equal(view.current.missing, true);
    assert.equal(view.current.html, '');
    await act(async () => view.current.setHtml('<p>New</p>'));
    await act(async () => { await view.current.save(); });
    await act(async () => { await view.current.save(); });
    assert.deepEqual(view.writes.map(write => write.options.method), ['POST', 'PATCH']);
  } finally { await view.cleanup(); }
});

test('failed and unresolved reads block saving and are not reported as missing; retry recovers', async () => {
  for (const config of [{ failing: true }, { unresolved: true }]) {
    const view = await mount(config);
    try {
      assert.equal(view.current.ready, false);
      assert.equal(view.current.missing, false);
      assert.ok(view.current.error);
      assert.equal(view.container.querySelector('button').disabled, true);
      await act(async () => { await assert.rejects(view.current.save()); });
      assert.equal(view.writes.length, 0);
      await view.recover();
      assert.equal(view.current.ready, true);
    } finally { await view.cleanup(); }
  }
});

test('identity and settings resolving after mount keep editor locked until confirmed', async () => {
  const auth = deferred();
  const a = deferred();
  const view = await mount({ delay: { auth, a }, member: true });
  try {
    assert.equal(view.current.loading, true);
    assert.equal(view.current.html, '');
    await act(async () => { auth.resolve(); });
    await settle();
    assert.equal(view.current.ready, false);
    await act(async () => { await assert.rejects(view.current.save()); a.resolve(); });
    await settle();
    assert.equal(view.current.ready, true);
  } finally { await view.cleanup(); }
});

test('late tenant reads and cached revisits cannot display or save another tenant’s draft', async () => {
  const b = deferred();
  const view = await mount({ delay: { b } });
  try {
    await act(async () => view.current.setHtml('<p>unsaved a</p>'));
    const staleSave = view.current.save;
    await view.switch('b');
    assert.equal(view.current.html, '');
    await act(async () => { await assert.rejects(staleSave()); });
    await view.switch('a');
    assert.match(view.current.html, /data-tenant="a"/);
    assert.doesNotMatch(view.current.html, /unsaved/);
    await act(async () => { b.resolve(); });
    await settle();
    assert.match(view.current.html, /data-tenant="a"/);
    await act(async () => { await view.current.save(); });
    assert.equal(view.writes[0].options.headers['X-Tenant-Id'], 'a');
  } finally { await view.cleanup(); }
});

test('background refetch preserves a current tenant draft without normalising HTML', async () => {
  const view = await mount();
  try {
    const html = '<table style="width: 600px"><tr><td>&nbsp;{{linkedin_url}}</td></tr></table>';
    await act(async () => view.current.setHtml(html));
    await act(async () => { await view.current.retry(); });
    await settle();
    assert.equal(view.current.html, html);
    assert.equal(view.current.socialIcons[0].url, 'https://example.org');
  } finally { await view.cleanup(); }
});

test('late saves remain pinned to their loaded tenant and cannot populate the next editor', async () => {
  const view = await mount();
  const delayed = deferred();
  const originalFetch = globalThis.fetch;
  let saving;
  try {
    globalThis.fetch = async (url, options) => {
      const result = await originalFetch(url, options);
      if (options.method) await delayed.promise;
      return result;
    };
    await act(async () => { saving = view.current.save(); });
    await view.switch('b');
    assert.match(view.current.html, /data-tenant="b"/);
    await act(async () => { delayed.resolve(); await saving; });
    await settle();
    assert.match(view.current.html, /data-tenant="b"/);
    assert.equal(view.writes[0].options.headers['X-Tenant-Id'], 'a');
  } finally { delayed.resolve(); await view.cleanup(); }
});
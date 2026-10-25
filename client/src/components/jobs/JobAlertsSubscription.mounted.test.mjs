import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://isolated.example.test/JobBoard' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'NodeFilter']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  entryPoints: ['client/src/components/jobs/JobAlertsSubscription.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'isolated-auth',
    setup(builder) {
      builder.onResolve({ filter: /^@\/contexts\/LayoutContext$/ }, () => ({ path: 'layout', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: 'export function useLayoutContext() { return globalThis.__jobAlertsIdentity; }', loader: 'js',
      }));
    },
  }],
});
const bundled = new Module(`${process.cwd()}/job-alerts-isolated-test.cjs`);
bundled.filename = `${process.cwd()}/job-alerts-isolated-test.cjs`;
bundled.paths = Module._nodeModulePaths(process.cwd());
bundled._compile(bundle.outputFiles[0].text, bundled.filename);
const Component = bundled.exports.default;
const { QueryClient, QueryClientProvider } = bundled.require('@tanstack/react-query');
const h = React.createElement;
const originalFetch = globalThis.fetch;
const due = { enabled: true, eligible: true, subscribed: false, optedOutAll: false, categoryId: 'canonical', promptDue: true };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); }); };

async function mount({ state = due, failSave = false, failLoad = false, deferLoad = false } = {}) {
  globalThis.__jobAlertsIdentity = { memberInfo: { id: 'member-a', tenant_id: 'tenant-a' }, sessionValidated: true };
  let current = { ...state };
  let failing = failSave;
  let finishLoad;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, '/api/member/job-alerts');
    assert.equal(options.credentials, 'include');
    if (options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (failing) return new Response(JSON.stringify({ error: 'Save failed. Retry.' }), { status: 503 });
      current = { ...current, promptDue: false, ...(body.action === 'subscribe' ? { subscribed: body.subscribed } : {}) };
    } else {
      if (deferLoad) { deferLoad = false; await new Promise(resolve => { finishLoad = resolve; }); }
      if (failLoad) return new Response('{}', { status: 503 });
    }
    return new Response(JSON.stringify(current), { status: 200 });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(h(QueryClientProvider, { client }, h(Component))); });
  await settle();
  return {
    client, calls,
    setState: next => { current = next; },
    allowSave: () => { failing = false; },
    finishLoad: async () => { await act(async () => finishLoad()); await settle(); },
    close: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; },
  };
}
async function click(label) {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(button, `Button "${label}" exists`);
  await act(async () => button.click());
  await settle();
}

test('failed prompt save stays open; successful retry subscribes through the API', async () => {
  const fixture = await mount({ failSave: true });
  try {
    assert.ok(document.querySelector('[role="dialog"]'));
    await click('Subscribe');
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.match(document.body.textContent, /Save failed/);
    fixture.allowSave();
    await click('Subscribe');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(fixture.calls, [{ action: 'subscribe', subscribed: true }, { action: 'subscribe', subscribed: true }]);
    assert.match(document.body.textContent, /You are subscribed/);
  } finally { await fixture.close(); }
});

test('later does not reopen in the same visit even when a refetch says promptDue', async () => {
  const fixture = await mount();
  try {
    await click('Ask me later (7 days)');
    assert.deepEqual(fixture.calls, [{ action: 'later' }]);
    fixture.setState(due);
    await act(async () => { await fixture.client.invalidateQueries({ queryKey: ['job-alerts'] }); });
    await settle();
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await fixture.close(); }
  // A later visit uses the server's due decision (including its seven-day
  // calculation), rather than a permanent client-side dismissal.
  const nextVisit = await mount();
  try {
    assert.ok(document.querySelector('[role="dialog"]'));
  } finally { await nextVisit.close(); }
});

test('never records the explicit choice, while the subscription toggle remains available', async () => {
  const fixture = await mount();
  try {
    await click("Don't ask again");
    assert.deepEqual(fixture.calls, [{ action: 'never' }]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => document.querySelector('[role="switch"]').click());
    await settle();
    assert.deepEqual(fixture.calls[1], { action: 'subscribe', subscribed: true });
  } finally { await fixture.close(); }
});

test('no dialog during loading, error, global opt-out, disabled feature, or ineligibility', async () => {
  for (const options of [{ deferLoad: true }, { failLoad: true }, { state: { ...due, optedOutAll: true } }, { state: { ...due, enabled: false } }, { state: { ...due, eligible: false } }]) {
    const fixture = await mount(options);
    try {
      assert.equal(document.querySelector('[role="dialog"]'), null);
      if (options.deferLoad) await fixture.finishLoad();
      if (options.state?.optedOutAll) assert.equal(document.querySelector('[role="switch"]').disabled, true);
    } finally { await fixture.close(); }
  }
});

test('tenant settings uses explicit tenant context, preserves failed state, and isolates tenant caches', async () => {
  const result = await build({
    entryPoints: ['client/src/components/admin/JobAlertsSettings.jsx'],
    bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
    plugins: [{
      name: 'isolated-admin-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: 'admin', namespace: 'admin-fixture' }));
        builder.onResolve({ filter: /^@\/contexts\/LayoutContext$/ }, () => ({ path: 'layout', namespace: 'admin-fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'admin-fixture' }, args => ({
          contents: args.path === 'admin'
            ? 'export function adminFetch(url, options, tenantId) { return globalThis.__adminJobAlertsFetch(url, options, tenantId); }'
            : 'export function useLayoutContext() { return {}; }',
          loader: 'js',
        }));
      },
    }],
  });
  const module = new Module(`${process.cwd()}/job-alerts-admin-isolated-test.cjs`);
  module.filename = `${process.cwd()}/job-alerts-admin-isolated-test.cjs`;
  module.paths = Module._nodeModulePaths(process.cwd());
  module._compile(result.outputFiles[0].text, module.filename);
  const Settings = module.exports.default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: 0 } } });
  const states = { 'tenant-a': { enabled: false, categoryId: 'a' }, 'tenant-b': { enabled: true, categoryId: 'b' } };
  const calls = [];
  let fail = true;
  globalThis.__adminJobAlertsFetch = async (url, options, tenantId) => {
    assert.equal(url, '/api/admin/job-alerts');
    assert.ok(tenantId);
    if (options.method === 'PATCH') {
      calls.push({ tenantId, body: JSON.parse(options.body) });
      if (fail) return new Response(JSON.stringify({ error: 'Not saved' }), { status: 503 });
      states[tenantId] = { ...states[tenantId], ...JSON.parse(options.body) };
    }
    return new Response(JSON.stringify(states[tenantId]));
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const renderTenant = async tenantId => {
    await act(async () => root.render(h(QueryClientProvider, { client }, h(Settings, { key: tenantId, tenantId }))));
    await settle();
  };
  try {
    await renderTenant('tenant-a');
    assert.equal(container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false');
    await act(async () => container.querySelector('[role="switch"]').click());
    await settle();
    assert.match(container.textContent, /Not saved/);
    assert.equal(container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false');
    fail = false;
    await click('Retry');
    assert.equal(container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
    assert.deepEqual(calls, [
      { tenantId: 'tenant-a', body: { enabled: true } },
      { tenantId: 'tenant-a', body: { enabled: true } },
    ]);
    await renderTenant('tenant-b');
    assert.equal(client.getQueryData(['admin-job-alerts', 'tenant-b']).categoryId, 'b');
    assert.equal(client.getQueryData(['admin-job-alerts', 'tenant-a']).categoryId, 'a');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    delete globalThis.__adminJobAlertsFetch;
  }
});

after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

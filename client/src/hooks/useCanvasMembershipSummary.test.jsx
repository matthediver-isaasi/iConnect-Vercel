import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test/' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: LayoutContext } = await import('../contexts/LayoutContext.jsx');
const { useCanvasMembershipSummary, fetchCanvasMembershipSummary } = await import('./useCanvasMembershipSummary.js');
const { setActiveTenantId } = await import('../api/base44Client.js');

const responseData = viewer => ({
  membership: { state: 'active', memberSince: '2020-01-01', membershipType: viewer },
  payment: { state: 'pending', method: 'card', nextPayment: null },
});

test('fetch is authenticated, abortable, no-store and rejects denied/malformed responses', async () => {
  const original = globalThis.fetch;
  let options;
  try {
    globalThis.fetch = async (url, opts) => {
      assert.equal(url, '/api/membership/canvas-summary');
      options = opts;
      return { ok: true, json: async () => responseData('Member A') };
    };
    const controller = new AbortController();
    assert.equal((await fetchCanvasMembershipSummary({ tenantId: 't1', signal: controller.signal })).membership.membershipType, 'Member A');
    assert.equal(options.credentials, 'include');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['X-Tenant-Id'], 't1');
    assert.equal(options.signal, controller.signal);
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(fetchCanvasMembershipSummary(), error => error.status === 403);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    await assert.rejects(fetchCanvasMembershipSummary(), /invalid/);
  } finally { globalThis.fetch = original; }
});

test('cards share a request, editor/guest never fetch, viewer transitions never reuse private data', async () => {
  const original = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let viewer = 'Member A';
  let calls = 0;
  let outcome = 200;
  const seen = [];
  function Probe({ asEditor = false }) {
    const result = useCanvasMembershipSummary({ asEditor });
    seen.push(result);
    return <div>{result.status}:{result.data?.membership.membershipType || ''}</div>;
  }
  async function mount(context, editor = false) {
    await act(async () => {
      root.render(<QueryClientProvider client={client}>
        <LayoutContext.Provider value={context}><Probe asEditor={editor} /><Probe asEditor={editor} /></LayoutContext.Provider>
      </QueryClientProvider>);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  const auth = id => ({ authResolved: true, sessionValidated: true, memberInfo: { id, tenant_id: 't1' } });
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: outcome === 200, status: outcome, json: async () => responseData(viewer) };
    };
    await mount({ authResolved: true, sessionValidated: false, memberInfo: null });
    assert.equal(calls, 0);
    assert.match(container.textContent, /guest/);
    await mount(auth('a'), true);
    assert.equal(calls, 0);
    assert.ok(seen.at(-1).isSample);
    await mount(auth('a'));
    assert.equal(calls, 1);
    assert.match(container.textContent, /Member A/);
    viewer = 'Member B';
    seen.length = 0;
    await mount(auth('b'));
    assert.equal(calls, 2);
    assert.match(container.textContent, /Member B/);
    assert.ok(seen.every(value => value.data?.membership.membershipType !== 'Member A'));
    await mount({ authResolved: true, sessionValidated: false, memberInfo: null });
    assert.doesNotMatch(container.textContent, /Member A|Member B/);
    outcome = 403;
    await mount(auth('c'));
    assert.match(container.textContent, /denied/);
    outcome = 500;
    await mount(auth('d'));
    assert.match(container.textContent, /error/);
    const beforeMismatch = calls;
    await act(async () => setActiveTenantId('other-tenant'));
    assert.equal(calls, beforeMismatch);
    assert.match(container.textContent, /denied/);
  } finally {
    await act(async () => root.unmount());
    setActiveTenantId(null);
    client.clear();
    container.remove();
    globalThis.fetch = original;
  }
});
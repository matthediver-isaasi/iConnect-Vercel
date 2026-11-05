import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node'])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act, useState } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: useCrmAlphabet } = await import('./useCrmAlphabet.js');
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

async function fixture(overrides = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const scrolls = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let api;
  let options = {
    endpoint: '/api/admin/members/paginated', listKey: 'members-paginated',
    tenantId: 'tenant-one', userId: 'user-one', params: { sortField: 'first_name', sortDir: 'asc' },
    enabled: true, pageSize: 20, rawSearch: '', viewId: 'default',
    pageData: { pagination: { page: 1 } }, pageFetching: false, pageFailed: false,
    nodes: ['first', 'second'], ...overrides,
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ total: 1113, buckets: [
      { label: 'A', count: 21, offset: 0, id: 'first' },
      { label: 'C', count: 1092, offset: 21, id: 'second' },
    ] });
  };
  HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this.getAttribute('data-alphabet-id')); };
  function Probe() {
    const [currentPage, setCurrentPage] = useState(1);
    api = useCrmAlphabet({ ...options, currentPage, setCurrentPage });
    return <div ref={api.containerRef}>{options.nodes.map(id =>
      <div key={id} {...api.targetProps(id)}>{id}</div>)}</div>;
  }
  const render = async (patch = {}) => {
    options = { ...options, ...patch };
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    await settle();
  };
  await render();
  return {
    get api() { return api; }, requests, scrolls, client, render,
    async close() {
      await act(async () => root.unmount());
      client.clear();
      element.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

test('same-page jumps focus exact IDs and repeated jumps work without a page transition', async () => {
  const f = await fixture();
  try {
    await act(async () => f.api.jump(f.api.groups[0]));
    assert.equal(document.activeElement.getAttribute('data-alphabet-id'), 'first');
    await act(async () => f.api.jump(f.api.groups[0]));
    assert.deepEqual(f.scrolls, ['first', 'first']);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('wait for matching non-placeholder page, then focus; manual navigation clears highlight', async () => {
  const f = await fixture();
  try {
    await act(async () => f.api.jump(f.api.groups[1]));
    assert.deepEqual(f.scrolls, []);
    await f.render({ pageData: { pagination: { page: 2 } }, placeholder: true });
    assert.deepEqual(f.scrolls, []);
    await f.render({ placeholder: false, pageFetching: true });
    assert.deepEqual(f.scrolls, []);
    await f.render({ pageFetching: false });
    assert.deepEqual(f.scrolls, ['second']);
    await act(async () => f.api.manualPage(3));
    assert.equal(f.api.selectedKey, undefined);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('raw search and saved view changes cancel pending jumps before debounce or late pages', async () => {
  for (const patch of [{ rawSearch: 'typing' }, { viewId: 'another-view' }]) {
    const f = await fixture();
    try {
      await act(async () => f.api.jump(f.api.groups[1]));
      await f.render(patch);
      await f.render({ pageData: { pagination: { page: 2 } } });
      assert.deepEqual(f.scrolls, []);
      assert.equal(f.api.selectedKey, undefined);
    } finally { await f.close(); }
  }
});

test('manual page navigation cancels a pending intent, including away-and-back', async () => {
  const f = await fixture();
  try {
    await act(async () => f.api.jump(f.api.groups[1]));
    await act(async () => f.api.manualPage(3));
    await act(async () => f.api.manualPage(2));
    await f.render({ pageData: { pagination: { page: 2 } } });
    assert.deepEqual(f.scrolls, []);
  } finally { await f.close(); }
});

test('missing targets and page failures never focus unrelated rows', async () => {
  for (const patch of [{ nodes: ['first'] }, { pageFailed: true }]) {
    const f = await fixture();
    try {
      await act(async () => f.api.jump(f.api.groups[1]));
      await f.render({ pageData: { pagination: { page: 2 } }, ...patch });
      assert.deepEqual(f.scrolls, []);
      assert.equal(f.api.selectedKey, undefined);
    } finally { await f.close(); }
  }
});

test('relevant invalidations refresh metadata once; page fetches and other tenants do not', async () => {
  const f = await fixture();
  try {
    f.client.setQueryDefaults(['members-paginated'], { gcTime: Infinity });
    f.client.setQueryData(['members-paginated', 'tenant-one', 'user-one', 1], {});
    f.client.setQueryData(['members-paginated', 'tenant-one', 'user-one', 2], {});
    f.client.setQueryData(['members-paginated', 'tenant-two', 'user-one', 1], {});
    await act(async () => f.client.invalidateQueries({ queryKey: ['members-paginated', 'tenant-two'] }));
    await settle();
    assert.equal(f.requests.length, 1);
    await act(async () => f.client.invalidateQueries({ queryKey: ['members-paginated', 'tenant-one'] }));
    await settle();
    assert.equal(f.requests.length, 2);
    await f.render({ pageSize: 50 });
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('metadata requests preserve scoped POST drill IDs without pagination or field selection', async () => {
  const f = await fixture({ drillIds: 'id-one,id-two', params: {
    search: 'Ada', sortField: 'last_name', sortDir: 'asc', organizationFilters: '{"sector":{"op":"empty"}}',
  }, rawSearch: 'Ada' });
  try {
    const request = f.requests[0];
    const url = new URL(request.url, 'https://fixture.invalid');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.credentials, 'include');
    assert.equal(request.init.headers['X-Tenant-Id'], 'tenant-one');
    assert.deepEqual(JSON.parse(request.init.body), { ids: 'id-one,id-two' });
    assert.equal(url.searchParams.get('alphabet'), '1');
    assert.equal(url.searchParams.get('search'), 'Ada');
    assert.equal(url.searchParams.has('page'), false);
    assert.equal(url.searchParams.has('fields'), false);
    await f.render({ tenantId: 'tenant-two' });
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

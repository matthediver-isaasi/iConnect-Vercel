import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>', { url: 'https://crm.example.test/members' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = React;
globalThis.React = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { base44, createClient } = await import('../api/base44Client.js');
const { useSavedListViews } = await import('./useSavedListViews.js');

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function row(id, key, name = 'Saved') {
  return { id, setting_key: key, setting_value: JSON.stringify({ views: [
    { id: 'view', name, isDefault: true, filters: { searchQuery: name }, columns: [{ id: 'name', visible: true }] },
  ] }) };
}

async function mount(props = {}, client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
})) {
  let current;
  let context = { page: 'members', memberId: 'user', tenantId: 'tenant-a', ...props };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  function Probe() { current = useSavedListViews(context); return null; }
  const render = () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  await act(async () => render());
  await settle();
  return {
    client, get current() { return current; },
    async context(next) { context = { ...context, ...next }; await act(async () => render()); await settle(); },
    async unmount() { await act(async () => root.unmount()); element.remove(); },
    async cleanup() { await act(async () => root.unmount()); client.clear(); element.remove(); },
  };
}

test('reads only current and legacy keys beyond a large settings fixture; cache survives remount', async () => {
  const calls = [];
  const all = Array.from({ length: 1500 }, (_, i) => row(`unrelated-${i}`, `unrelated-${i}`));
  all.push(row('saved', 'crm_member_views_user'));
  const entity = base44.entities.SystemSettings;
  entity.list = async (options) => {
    calls.push(options);
    return all.filter(r => options.filter.setting_key.includes(r.setting_key));
  };
  const first = await mount();
  try {
    assert.equal(first.current.viewsLoaded, true);
    assert.equal(first.current.defaultView.name, 'Saved');
    assert.deepEqual(calls[0].filter, { setting_key: ['crm_member_views_user', 'crm_member_filters_user'] });
    assert.ok(calls[0].signal instanceof AbortSignal);
    await first.unmount();
    const second = await mount({}, first.client);
    try { assert.equal(second.current.defaultView.name, 'Saved'); assert.equal(calls.length, 1); }
    finally { await second.cleanup(); }
  } catch (error) { first.client.clear(); throw error; }
});

test('failed settings remain unavailable, block saves, and support a real retry', async () => {
  let failing = true, reads = 0, writes = 0;
  base44.entities.SystemSettings.list = async () => {
    reads++;
    if (failing) throw new Error('Settings unavailable');
    return [];
  };
  base44.entities.SystemSettings.create = async () => { writes++; return { id: 'created' }; };
  const view = await mount();
  try {
    assert.equal(view.current.viewsLoaded, false);
    assert.match(view.current.viewsError.message, /unavailable/);
    await assert.rejects(view.current.createView('Unsafe', { filters: {} }), /must load/);
    assert.equal(writes, 0);
    failing = false;
    await act(async () => { await view.current.retryViews(); });
    await settle();
    assert.equal(reads, 2);
    assert.equal(view.current.viewsLoaded, true);
    assert.equal(view.current.viewsError, null);
  } finally { await view.cleanup(); }
});

test('legacy view is retained and cleanup identity survives a warm remount', async () => {
  const writes = [];
  base44.entities.SystemSettings.list = async () => [{
    id: 'legacy', setting_key: 'crm_org_filters_user',
    setting_value: JSON.stringify({ searchQuery: 'Legacy search' }),
  }];
  base44.entities.SystemSettings.create = async body => { writes.push(['create', body]); return { id: 'new-row' }; };
  base44.entities.SystemSettings.delete = async id => { writes.push(['delete', id]); };
  const first = await mount({ page: 'organisations' });
  assert.equal(first.current.defaultView.filters.searchQuery, 'Legacy search');
  await first.unmount();
  const second = await mount({ page: 'organisations' }, first.client);
  try {
    await act(async () => { await second.current.renameView(second.current.defaultView.id, 'Renamed'); });
    await settle();
    assert.equal(second.current.defaultView.name, 'Renamed');
    assert.equal(writes[0][1].setting_key, 'crm_org_views_user');
    assert.deepEqual(writes[1], ['delete', 'legacy']);
  } finally { await second.cleanup(); }
});

test('late settings from another tenant cannot seed the current view or persistence id', async () => {
  const old = deferred();
  let count = 0;
  const updates = [];
  base44.entities.SystemSettings.list = async () => ++count === 1
    ? old.promise : [row('tenant-b-row', 'crm_member_views_user', 'Tenant B')];
  base44.entities.SystemSettings.update = async (id, patch) => { updates.push([id, patch]); };
  const view = await mount();
  try {
    await view.context({ tenantId: 'tenant-b' });
    assert.equal(view.current.defaultView.name, 'Tenant B');
    old.resolve([row('tenant-a-row', 'crm_member_views_user', 'Tenant A')]);
    await settle();
    assert.equal(view.current.defaultView.name, 'Tenant B');
    await act(async () => { await view.current.renameView('view', 'Still B'); });
    assert.equal(updates[0][0], 'tenant-b-row');
  } finally { await view.cleanup(); }
});

test('custom object views retain distinct scope and reset active selection synchronously', async () => {
  base44.entities.SystemSettings.list = async ({ filter }) => [row(filter.setting_key[0], filter.setting_key[0])];
  const view = await mount({ page: 'customObjects', scopeId: 'object-a' });
  try {
    await act(async () => view.current.setActiveViewId('view'));
    assert.equal(view.current.activeViewId, 'view');
    await view.context({ scopeId: 'object-b' });
    assert.equal(view.current.activeViewId, null);
    assert.equal(view.client.getQueryData([
      'crm-saved-list-views', 'tenant-a', 'crm_custom_object_views_user_object-b',
    ]).id, 'crm_custom_object_views_user_object-b');
  } finally { await view.cleanup(); }
});

test('corrupt saved JSON is not treated as an empty successful view', async () => {
  base44.entities.SystemSettings.list = async () => [{
    id: 'bad', setting_key: 'crm_member_views_user', setting_value: '{broken',
  }];
  const view = await mount();
  try {
    assert.equal(view.current.viewsLoaded, false);
    assert.match(view.current.viewsError.message, /could not be read/);
  } finally { await view.cleanup(); }
});

test('entity list carries cancellation without changing server-side filter encoding', async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('[]', { status: 200 });
  };
  try {
    await createClient().entities.SystemSettings.list({
      filter: { setting_key: ['current', 'legacy'] }, signal: controller.signal,
    });
    assert.equal(request.options.signal, controller.signal);
    assert.equal(request.options.credentials, 'include');
    assert.deepEqual(JSON.parse(new URL(request.url, 'https://fixture.test').searchParams.get('filter')),
      { setting_key: ['current', 'legacy'] });
  } finally { globalThis.fetch = previousFetch; }
});

test('two queued view creations preserve both changes and only create one settings row', async () => {
  const firstWrite = deferred();
  let creates = 0;
  const updates = [];
  base44.entities.SystemSettings.list = async () => [];
  base44.entities.SystemSettings.create = async () => { creates++; await firstWrite.promise; return { id: 'one-row' }; };
  base44.entities.SystemSettings.update = async (id, patch) => { updates.push([id, patch]); };
  const view = await mount();
  try {
    let one, two;
    await act(async () => {
      one = view.current.createView('One', { filters: {} });
      two = view.current.createView('Two', { filters: {} });
    });
    firstWrite.resolve();
    await act(async () => { await Promise.all([one, two]); });
    await settle();
    assert.equal(creates, 1);
    assert.equal(updates[0][0], 'one-row');
    assert.deepEqual(view.current.views.map(v => v.name), ['One', 'Two']);
  } finally { await view.cleanup(); }
});
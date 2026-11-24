import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://isolated.example.test/waitinglist' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'NodeFilter']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  entryPoints: ['client/src/pages/WaitingList.jsx'], bundle: true, write: false,
  packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'waiting-list-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^@\/hooks\/useMemberAccess$/ }, () => ({ path: 'access', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: 'transport', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path === 'access'
          ? 'export const useMemberAccess = () => globalThis.__waiting.access;'
          : 'export const adminFetch = (...args) => globalThis.__waiting.fetch(...args);',
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/waiting-list-test.cjs`);
compiled.filename = `${process.cwd()}/waiting-list-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Page = compiled.exports.default;
const { MemoryRouter } = compiled.require('react-router-dom');
const { QueryClient, QueryClientProvider } = compiled.require('@tanstack/react-query');
const member = { id: 'me', tenant_id: 'tenant' };
const self = { id: 'a', registration_id: 'r1', tenant_id: 'tenant', booker_member_id: 'me', member_id: 'me', status: 'active', can_manage_registration: true, first_name: 'Alex', last_name: 'Self', event_id: 'event', event_title: 'Annual Forum' };
const colleague = { ...self, id: 'b', member_id: 'colleague', first_name: 'Casey', last_name: 'Guest' };
const unrelated = { ...colleague, id: 'c', registration_id: 'r2', first_name: 'Other' };
const groupLabel = 'Remove everyone I registered from this waiting list';
const buttons = label => [...document.querySelectorAll('button')].filter(b => b.textContent === label);
const dialog = () => document.querySelector('[role="dialog"]');
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
async function click(button) {
  assert.ok(button, 'button exists');
  await act(async () => button.click());
  await settle();
}
async function mount(entries, viewer = member, transport) {
  const calls = [];
  globalThis.__waiting = {
    access: { memberInfo: viewer, isAccessReady: true, isFeatureExcluded: () => false },
    fetch: async (url, options, tenantId) => {
      assert.equal(url, '/api/member/event-waiting-list');
      assert.equal(tenantId, 'tenant');
      assert.equal(options.credentials, 'include');
      if (options.method !== 'PATCH') return Response.json({ entries });
      const body = JSON.parse(options.body);
      calls.push(body);
      return transport ? transport(body) : Response.json({ withdrawn: 1 });
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(MemoryRouter, null, React.createElement(Page)))));
  await settle();
  return {
    calls, client,
    async replace(next) {
      await act(async () => client.setQueriesData({ queryKey: ['event-waiting-list'] }, { entries: next }));
      await settle();
    },
    async close() { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}
after(() => { delete globalThis.__waiting; dom.window.close(); });

test('self-only, separate registrations and withdrawn colleagues never offer group removal', async () => {
  for (const entries of [[self], [self, unrelated], [self, { ...colleague, status: 'withdrawn' }]]) {
    const app = await mount(entries);
    try {
      assert.equal(buttons(groupLabel).length, 0);
      await click(buttons('Remove from waiting list')[0]);
      assert.match(dialog().textContent, /remove yourself.*Annual Forum/);
      await click(buttons('Keep on waiting list')[0]);
      assert.equal(app.calls.length, 0);
    } finally { await app.close(); }
  }
});

test('a colleague registered by someone else can remove only themselves', async () => {
  const app = await mount([{ ...colleague, can_manage_registration: false }], { ...member, id: 'colleague' });
  try {
    assert.equal(buttons(groupLabel).length, 0);
    await click(buttons('Remove from waiting list')[0]);
    await click(buttons('Remove me')[0]);
    assert.deepEqual(app.calls, [{ entry_id: 'b', scope: 'attendee' }]);
    assert.match(document.body.textContent, /not currently on any event waiting lists/);
  } finally { await app.close(); }
});

test('booker removes the named colleague; the last entry immediately loses group action', async () => {
  const app = await mount([self, colleague, unrelated]);
  try {
    assert.equal(buttons(groupLabel).length, 2);
    await click(buttons('Remove from waiting list')[1]);
    assert.match(dialog().textContent, /remove Casey Guest.*Annual Forum/);
    assert.equal(buttons('Remove me').length, 0);
    await click(buttons('Remove Casey Guest')[0]);
    assert.deepEqual(app.calls, [{ entry_id: 'b', scope: 'attendee' }]);
    assert.equal(buttons(groupLabel).length, 0);
    assert.equal(buttons('Remove from waiting list').length, 2);
  } finally { await app.close(); }
});

test('group confirmation names event, count and registration scope, preserving unrelated entries', async () => {
  const app = await mount([self, colleague, unrelated]);
  try {
    await click(buttons(groupLabel)[1]);
    assert.match(dialog().textContent, /Remove 2 attendees.*Annual Forum/);
    assert.match(dialog().textContent, /Only people in this registration will be removed/);
    assert.match(dialog().textContent, /Other registrations for this event will stay/);
    await click(buttons('Remove these attendees')[0]);
    assert.deepEqual(app.calls, [{ entry_id: 'b', scope: 'registration' }]);
    assert.equal(buttons('Remove from waiting list').length, 1);
    assert.match(document.body.textContent, /Other Guest/);
  } finally { await app.close(); }
});

test('local cache changes dismiss a now-invalid group dialog', async () => {
  const app = await mount([self, colleague]);
  try {
    await click(buttons(groupLabel)[0]);
    await app.replace([self]);
    assert.equal(dialog(), null);
    assert.equal(buttons(groupLabel).length, 0);
    assert.equal(app.calls.length, 0);
  } finally { await app.close(); }
});

test('failed individual and group requests retain entries and allow retry; pending blocks duplicates', async () => {
  for (const group of [false, true]) {
    let resolve;
    const app = await mount([self, colleague], member, () => new Promise(r => { resolve = r; }));
    try {
      await click(buttons(group ? groupLabel : 'Remove from waiting list')[0]);
      await click(buttons(group ? 'Remove these attendees' : 'Remove me')[0]);
      assert.equal(buttons('Removing…')[0].disabled, true);
      assert.equal(buttons('Keep on waiting list')[0].disabled, true);
      await click(buttons('Removing…')[0]);
      assert.equal(app.calls.length, 1);
      await act(async () => resolve(Response.json({ error: 'Please retry' }, { status: 503 })));
      await settle();
      assert.match(dialog().textContent, /Please retry/);
      assert.equal(buttons('Remove from waiting list').length, 2);
      assert.equal(buttons(groupLabel).length, 2);
      assert.equal(buttons(group ? 'Remove these attendees' : 'Remove me')[0].disabled, false);
    } finally { await app.close(); }
  }
});

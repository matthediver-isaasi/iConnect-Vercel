import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>', { url: 'https://fixture.test/members' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'CustomEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const empty = [];
const access = { isAdmin: true, isAccessReady: true, isFeatureExcluded: () => false, memberInfo: { id: 'viewer', tenant_id: 'tenant' } };
globalThis.__termFixture = { access, views: empty, settings: empty };
const fixtures = {
  '@/api/base44Client': `export const base44 = { entities: new Proxy({}, {get: (_, key) => ({list: async () => key === 'SystemSettings' ? globalThis.__termFixture.settings : [], update: async () => ({}), create: async () => ({id:'pref'})})}) };`,
  '@/hooks/useMemberAccess': `export const useMemberAccess = () => globalThis.__termFixture.access;`,
  '@/contexts/TenantBrandingContext': `export const useTenantBranding = () => ({tenantSlug:'fixture'});`,
  '@/contexts/MemberTerminologyContext': `export const useMemberTerminology = () => ({memberLabel:'Member',memberLabelPlural:'Members',getMemberDetailUrl:id=>'/members/'+id});`,
  '@/hooks/useRealtimeSubscription': `export const useRealtimeSubscription = () => {};`,
  '@/hooks/useSavedListViews': `export const useSavedListViews = () => ({views:globalThis.__termFixture.views, viewsLoaded:true, defaultView:globalThis.__termFixture.defaultView, setActiveViewId:()=>{}});`,
  '@/pages/CustomFieldsAdmin': `export const isMemberAdminColumnVisible = () => true; export const isMemberAdminFilterVisible = () => true; export const isOrgAdminFilterVisible = () => true;`,
  '@/lib/adminOrgList': `export const listAllOrganizationsForAdmin = async () => [];`,
  '@/components/dashboard/widgetDrill': `export const useWidgetDrill = () => ({}); export const WidgetDrillChip = () => null;`,
  '@/hooks/useCrmAlphabet': `export default () => ({targetProps:()=>({})});`,
  '@/components/CrmAlphabetBar': `export default () => null;`,
  '@/components/MemberDetailView': `export default () => null;`,
  '@/components/GuestAccessControl': `export default () => null;`,
  '@/components/SavedViewSwitcher': `export default () => null;`,
  '@/components/MultiSelectFilter': `export default () => null;`,
  '@/components/FilterOperatorMenu': `export default () => null;`,
  '@/components/RoleBadge': `export default () => null;`,
  // Keep the actual column controls mounted without portal positioning in JSDOM.
  '@/components/ui/popover': `import React from 'react'; export const Popover = ({children}) => <div>{children}</div>; export const PopoverContent = Popover; export const PopoverTrigger = Popover;`,
};
const bundle = await build({
  entryPoints: ['client/src/pages/MembersList.jsx'], bundle: true, write: false,
  packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  plugins: [{ name: 'fixtures', setup(builder) {
    builder.onResolve({ filter: /^@\// }, args => fixtures[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path], loader: 'jsx', resolveDir: process.cwd() }));
  } }],
});
const mod = new Module(`${process.cwd()}/member-term-test.cjs`);
mod.filename = `${process.cwd()}/member-term-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const Page = mod.exports.default;
const { QueryClient, QueryClientProvider } = mod.require('@tanstack/react-query');
const { MemoryRouter } = mod.require('react-router-dom');
const requests = [];
globalThis.fetch = async url => {
  requests.push(String(url));
  if (String(url).startsWith('/api/admin/members/departments')) return new Response(JSON.stringify({ departments: [] }));
  if (String(url).startsWith('/api/admin/members/paginated')) return new Response(JSON.stringify({
    members: [{id:'member', first_name:'Ada', email:'ada@example.test', membership_term_end_date:'2027-09-05'}],
    pagination:{page:1,limit:50,total:1,totalPages:1},
  }));
  throw new Error(`Unexpected fetch ${url}`);
};
async function until(fn) {
  for (let i = 0; i < 80; i++) {
    if (fn()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  }
  assert.fail(`Timed out: ${document.body.textContent}`);
}
async function mount() {
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{gcTime:0}}});
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(MemoryRouter, null,
    React.createElement(QueryClientProvider, {client}, React.createElement(Page)))));
  await until(() => document.body.textContent.includes('ada@example.test'));
  return async () => { await act(async () => root.unmount()); client.clear(); host.remove(); };
}
const stored = () => JSON.parse(localStorage.getItem('members_list_columns_fixture'));
const termControl = () => [...document.querySelectorAll('[draggable]')].find(node => node.textContent.includes('Membership term end date'));
const dispatch = async (node, type) => act(async () => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  event.dataTransfer = {};
  node.dispatchEvent(event);
});
after(() => { dom.window.close(); delete globalThis.__termFixture; });

test('disabled-member toggle uses server status filtering and follows saved views', async () => {
  localStorage.clear();
  globalThis.__termFixture.settings = [];
  globalThis.__termFixture.defaultView = null;
  requests.length = 0;
  let close = await mount();
  const toggle = () => document.querySelector('[data-testid="switch-show-disabled-members"]');
  assert.equal(toggle().getAttribute('aria-checked'), 'true');
  await dispatch(toggle(), 'click');
  await until(() => requests.some(url => url.includes('status=active')));
  assert.equal(toggle().getAttribute('aria-checked'), 'false');
  requests.length = 0;
  await dispatch(toggle(), 'click');
  await until(() => requests.some(url => url.includes('status=all')));
  assert.equal(toggle().getAttribute('aria-checked'), 'true');
  await close();
  for (const status of ['active', 'disabled']) {
    globalThis.__termFixture.defaultView = { id: `status-${status}`, columns: [], filters: { statusFilter: status } };
    close = await mount();
    assert.equal(toggle().getAttribute('aria-checked'), status === 'active' ? 'false' : 'true');
    await close();
  }
  globalThis.__termFixture.defaultView = null;
});

test('older preferences discover hidden date; enable, reorder, reload and reset preserve normal column behaviour', async () => {
  localStorage.setItem('members_list_columns_fixture', JSON.stringify([
    {id:'name',label:'Member',visible:true,locked:true},
    {id:'email',label:'Email',visible:true,locked:false},
  ]));
  let close = await mount();
  await until(() => !!termControl());
  assert.equal(stored().find(c=>c.id==='membership_term_end_date').visible, false);
  assert.ok(!requests.some(url=>url.includes('membershipTermEnd=1')));
  await dispatch(termControl().querySelector('button'), 'click');
  await until(() => document.body.textContent.includes('05/09/2027'));
  assert.ok(requests.some(url=>url.includes('membershipTermEnd=1')));
  const term = termControl();
  await dispatch(term, 'dragstart');
  await dispatch([...document.querySelectorAll('[draggable]')].find(node=>node.textContent==='Email'), 'dragover');
  await dispatch(termControl(), 'dragend');
  assert.equal(stored()[1].id, 'membership_term_end_date');
  const header = [...document.querySelectorAll('th')].find(node=>node.textContent==='Membership term end date');
  assert.ok(header);
  assert.equal(header.querySelector('button'), null);
  await close();
  close = await mount();
  await until(() => document.body.textContent.includes('05/09/2027'));
  assert.equal(stored()[1].id, 'membership_term_end_date');
  await dispatch(document.querySelector('[data-testid="button-reset-member-columns"]'), 'click');
  assert.equal(stored().find(c=>c.id==='membership_term_end_date').visible, false);
  await close();
});

test('older server preferences and named default views retain order and discover the new option', async () => {
  for (const kind of ['server', 'view']) {
    localStorage.clear();
    const columns = [{id:'name',label:'Member',visible:true,locked:true}, {id:'email',label:'Email',visible:true}];
    globalThis.__termFixture.settings = kind === 'server' ? [{id:'prefs',setting_value:JSON.stringify(columns)}] : [];
    globalThis.__termFixture.defaultView = kind === 'view' ? {id:'older',columns,filters:{}} : null;
    const close = await mount();
    await until(() => !!termControl());
    assert.deepEqual(stored().slice(0,2), columns);
    assert.equal(stored().find(c=>c.id==='membership_term_end_date').visible, false);
    await close();
  }
});

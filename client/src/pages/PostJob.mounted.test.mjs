import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant-a.iconn.app/postjob' });
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'NodeFilter']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  stdin: {
    contents: `
      export { default as Page } from './client/src/pages/PostJob.jsx';
      export { default as Context } from './client/src/contexts/LayoutContext.jsx';
      export * from './client/src/lib/viewerProtectedWorkGate.js';
      export { publicClient } from './client/src/api/publicClient.js';
    `, resolveDir: process.cwd(), loader: 'jsx',
  },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  logLevel: 'silent',
  plugins: [{
    name: 'display-only-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'fixture' }));
      builder.onResolve({ filter: /^react-quill$/ }, () => ({ path: 'quill', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@\/contexts\/TenantBrandingContext$/ }, () => ({ path: 'branding', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@stripe\// }, () => ({ path: 'stripe', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        loader: 'jsx',
        contents: path === 'css' ? '' : path === 'branding'
          ? 'export const useTenantBranding = () => ({branding:{name:"Fixture tenant"}});'
          : path === 'quill'
            ? 'export default function Editor() { return globalThis.React.createElement("textarea", {"aria-label":"Job description"}); }'
            : 'export const loadStripe=async()=>null; export const Elements=({children})=>children; export const PaymentElement=()=>null; export const useStripe=()=>null; export const useElements=()=>null;',
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/post-job-mounted.cjs`);
compiled.filename = `${process.cwd()}/post-job-mounted.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { Page, Context, publicClient, installViewerProtectedWorkGate, setViewerProtectedWorkPaused, invalidateViewerProtectedWork } = compiled.exports;
// Use the same CJS instance as the bundled page, not a second ESM Query context.
const { QueryClient, QueryClientProvider } = compiled.require('@tanstack/react-query');
const { MemoryRouter } = compiled.require('react-router-dom');
const h = React.createElement;
const nativeFetch = globalThis.fetch;
const settings = [
  { setting_key: 'job_types', setting_value: '["Graduate","Research"]' },
  { setting_key: 'job_hours', setting_value: '["Evenings","Flexible"]' },
  { setting_key: 'job_posting_price', setting_value: '81.25' },
  { setting_key: 'job_posting_terms', setting_value: '{"title":"Tenant advertising agreement","content":"<p>Configured advertising terms.</p>"}' },
];
const member = { id: 'member-a', tenant_id: 'tenant-a', role_id: 'role-a', email: 'member@example.test', first_name: 'Test', last_name: 'Member' };
function identity(authenticated = false) {
  return {
    authResolved: true, sessionValidated: authenticated,
    memberInfo: authenticated ? member : null,
    organizationInfo: authenticated ? { id: 'org-a', name: 'Own organisation' } : null,
    sessionRoleSnapshot: authenticated ? {
      status: 'ready', member_id: member.id, tenant_id: member.tenant_id, role_id: member.role_id,
      session_key: 'validated', role: { id: member.role_id, excluded_features: [] },
    } : null,
  };
}
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); }); };
async function mount({ path = '/postjob', auth = identity(), stored = null, fail = false, rows = settings, denyEdit = false } = {}) {
  dom.reconfigure({ url: `https://tenant-a.iconn.app${path}` });
  localStorage.clear();
  if (stored) localStorage.setItem('agcas_member', typeof stored === 'string' ? stored : JSON.stringify(stored));
  publicClient.tenantSlug = 'tenant-a';
  const calls = [];
  let failing = fail;
  let rejected = 0;
  let clears = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: 0 } } });
  const clear = client.clear.bind(client);
  client.clear = () => { clears++; clear(); };
  window.fetch = async (input, options = {}) => {
    const url = new URL(input, window.location.origin);
    calls.push({ path: url.pathname, tenant: url.searchParams.get('tenant'), body: options.body });
    if (url.pathname === '/api/auth/me') return Response.json(null);
    if (url.pathname === '/api/public/system-settings') {
      return Response.json(rows, { status: failing ? 503 : 200 });
    }
    if (url.pathname === '/api/functions/getStripePublishableKey') {
      assert.equal(JSON.parse(options.body).feature, 'jobs');
      return Response.json({ publishableKey: null });
    }
    if (url.pathname === '/api/functions/checkMemberStatusByEmail') return Response.json({ is_member: false });
    if (auth.sessionValidated && url.pathname === '/api/entities/Organization') return Response.json([{ id: 'org-b', name: 'Another organisation' }]);
    if (auth.sessionValidated && url.pathname === '/api/entities/JobPosting/job-a') {
      return denyEdit ? Response.json({ error: 'Forbidden' }, { status: 403 })
        : Response.json({ id: 'job-a', title: 'Existing job', company_name: 'Job company', description: '<p>Existing description</p>' });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'X-Session-Status': 'invalid' } });
  };
  const uninstall = installViewerProtectedWorkGate(window);
  globalThis.fetch = (...args) => window.fetch(...args);
  // Mirror Layout's rejection/cache lifecycle while retaining the real gate.
  // No suppression of rejection or query clearing in this fixture.
  const reject = () => {
    rejected++;
    setViewerProtectedWorkPaused(true);
    auth = identity();
    localStorage.removeItem('agcas_member');
    void client.cancelQueries();
    client.clear();
    render();
    setViewerProtectedWorkPaused(false);
  };
  window.addEventListener('viewer-session-rejected', reject);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => root.render(h(QueryClientProvider, { client },
    h(Context.Provider, { value: auth }, h(MemoryRouter, {}, h(Page)))));
  await act(async () => render());
  await settle();
  return {
    calls, client, get rejected() { return rejected; }, get clears() { return clears; },
    recover: () => { failing = false; },
    authenticate: async next => { auth = next; await act(async () => render()); await settle(); },
    close: async () => {
      await act(async () => root.unmount());
      window.removeEventListener('viewer-session-rejected', reject);
      uninstall(); invalidateViewerProtectedWork(); clear(); container.remove(); globalThis.fetch = nativeFetch;
    },
  };
}
async function click(label) {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  assert.ok(button, `Button ${label} exists`);
  await act(async () => button.click());
  await settle();
}
async function enterEmail() {
  const input = document.querySelector('#email');
  assert.ok(input, 'Email entry is available');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'guest@example.test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await settle();
}
function assertStable(fixture, count = 1) {
  assert.equal(fixture.calls.filter(call => call.path === '/api/public/system-settings').length, count);
  assert.equal(fixture.rejected, 0);
  assert.equal(fixture.clears, 0);
  assert.equal(fixture.calls.filter(call => call.path.startsWith('/api/entities/')).length, 0);
}

test('both guest route spellings reach the form with public terms and bounded requests', async () => {
  for (const path of ['/postjob', '/PostJob']) {
    const fixture = await mount({ path });
    try {
      await enterEmail();
      assert.ok(document.querySelector('#title'));
      assert.equal(fixture.client.getQueryData(['public-job-posting-settings', 'tenant-a'])
        .find(row => row.setting_key === 'job_posting_price').setting_value, '81.25');
      assert.match(document.body.textContent, /Graduate/);
      assert.match(document.body.textContent, /Evenings/);
      await click('Tenant advertising agreement');
      assert.match(document.body.textContent, /Configured advertising terms\./);
      await settle();
      assertStable(fixture);
      assert.equal(fixture.calls.find(call => call.path === '/api/public/system-settings').tenant, 'tenant-a');
      assert.equal(fixture.calls.filter(call => call.path === '/api/functions/getStripePublishableKey').length, 1);
      assert.equal(window.location.pathname, path);
    } finally { await fixture.close(); }
  }
});

test('failed public settings settle without session resets and recover only on manual retry', async () => {
  const fixture = await mount({ fail: true });
  try {
    assert.match(document.body.textContent, /settings could not be loaded/);
    await settle();
    assertStable(fixture);
    fixture.recover();
    await click('Try again');
    assert.ok(document.querySelector('#email'));
    assertStable(fixture, 2);
    await enterEmail();
    assert.ok(document.querySelector('#title'));
  } finally { await fixture.close(); }
});

test('stale and malformed stored member identities never authorize organisation or edit reads', async () => {
  for (const stored of [member, '{broken']) {
    const fixture = await mount({ stored, auth: { ...identity(), memberInfo: member } });
    try {
      assert.ok(document.querySelector('#email'));
      assertStable(fixture);
    } finally { await fixture.close(); }
  }
  const fixture = await mount({ path: '/PostJob?editJobId=job-a', stored: member });
  try {
    assert.match(document.body.textContent, /Please log in to edit/);
    assert.equal(document.querySelector('#title'), null);
    assertStable(fixture);
  } finally { await fixture.close(); }
});

test('protected editing waits for validation; signed-in posting and editing still load', async () => {
  const fixture = await mount({ path: '/PostJob?editJobId=job-a', auth: { ...identity(), authResolved: false, memberInfo: member } });
  try {
    assert.match(document.body.textContent, /Checking your session/);
    assertStable(fixture);
    await fixture.authenticate(identity(true));
    assert.equal(document.querySelector('#title')?.value, 'Existing job');
    assert.equal(fixture.calls.filter(call => call.path === '/api/entities/JobPosting/job-a').length, 1);
    assert.equal(fixture.rejected, 0);
  } finally { await fixture.close(); }
  const posting = await mount({ auth: identity(true) });
  try {
    assert.match(document.body.textContent, /Free for Members/);
    assert.equal(document.querySelector('#company_name')?.value, 'Own organisation');
    assert.equal(posting.calls.filter(call => call.path === '/api/entities/Organization').length, 1);
    assert.equal(posting.calls.filter(call => call.path.includes('SystemSettings')).length, 0);
  } finally { await posting.close(); }
});

test('an authenticated but unauthorized edit fails closed without rejecting a valid session', async () => {
  const fixture = await mount({ path: '/postjob?editJobId=job-a', auth: identity(true), denyEdit: true });
  try {
    assert.match(document.body.textContent, /Failed to load job posting/);
    assert.equal(document.querySelector('#title'), null);
    assert.equal(fixture.rejected, 0);
  } finally { await fixture.close(); }
});

test('missing or malformed terms retain the existing contact-administrator fallback', async () => {
  for (const value of [null, 'not json', '{"title":[],"content":{}}']) {
    const rows = settings.filter(row => row.setting_key !== 'job_posting_terms');
    if (value) rows.push({ setting_key: 'job_posting_terms', setting_value: value });
    const fixture = await mount({ rows });
    try {
      await enterEmail();
      await click('Terms and Conditions');
      assert.match(document.body.textContent, /Terms and conditions have not been configured/);
      assertStable(fixture);
    } finally { await fixture.close(); }
  }
});

test('fixture exercises real rejection and cache clearing instead of disabling them', async () => {
  const layout = await readFile('client/src/pages/Layout.jsx', 'utf8');
  assert.match(layout, /window\.addEventListener\('viewer-session-rejected', rejectSession\)/);
  assert.match(layout, /queryClient\.cancelQueries\(\);\s*queryClient\.clear\(\)/);
  const fixture = await mount();
  try {
    await act(async () => {
      await assert.rejects(fetch('/api/entities/SystemSettings'), { code: 'VIEWER_SESSION_WORK_PAUSED' });
    });
    await settle();
    assert.equal(fixture.rejected, 1);
    assert.equal(fixture.clears, 1);
    assert.ok(document.querySelector('#email'));
    const count = fixture.calls.length;
    await settle();
    assert.equal(fixture.calls.length, count, 'rejection settles instead of looping');
  } finally { await fixture.close(); }
});

after(() => { globalThis.fetch = nativeFetch; dom.window.close(); });

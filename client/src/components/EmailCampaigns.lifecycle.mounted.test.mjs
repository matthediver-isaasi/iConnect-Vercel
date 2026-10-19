import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// All transport and entity access are isolated; no tenant or provider is contacted.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://isolated.example.test/EmailCampaigns' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'CustomEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  entryPoints: ['client/src/components/EmailCampaigns.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  plugins: [{
    name: 'isolated-campaign-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^@\/(api\/base44Client|lib\/queryClient|components\/email-builder\/BlockRenderer|components\/email-builder\/types)$/ },
        args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path.endsWith('base44Client') ? 'export const base44 = {entities: new Proxy({}, {get: () => ({list: async () => [], filter: async () => []})})};'
          : path.endsWith('queryClient') ? 'export const maybeEmitPlanQuotaFromBody = () => {};'
            : path.endsWith('BlockRenderer') ? 'export const ReadOnlyBlockPreview = () => null;'
              : 'export const defaultEmailDesign = {};',
        loader: 'js'
      }));
    }
  }]
});
const module = new Module(`${process.cwd()}/campaign-lifecycle-isolated.cjs`);
module.filename = `${process.cwd()}/campaign-lifecycle-isolated.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(bundle.outputFiles[0].text, module.filename);
const Campaigns = module.exports.default;
const { QueryClient, QueryClientProvider } = module.require('@tanstack/react-query');
const { MemoryRouter, Routes, Route } = module.require('react-router-dom');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const totals = { totalCampaigns: 8, sentCampaigns: 7, totalSent: 1234, totalOpened: 400, totalClicked: 90, avgOpenRate: '32.4', avgClickRate: '7.3', draftCount: 1, scheduledCount: 0 };
const campaign = { id: 'campaign-1', name: 'Spring briefing', subject: 'News', status: 'draft', archived_at: null, pending_count: 0 };
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await settle(); }
  assert.fail(`Timed out waiting for ${label}`);
}
const click = async element => { assert.ok(element); await act(async () => element.click()); };
const byId = id => document.querySelector(`[data-testid="${id}"]`);
async function mount({ records = [campaign], ready = true, mutationError = null, listError = null, summaryError = null, dataGate = null, readinessGate = null } = {}) {
  let items = records.map(item => ({ ...item }));
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'include');
    const parsed = new URL(url, dom.window.location.origin);
    if (parsed.searchParams.has('lifecycle')) {
      if (readinessGate) await readinessGate;
      return ready ? json({ ready: true }) : json({ error: 'Archive schema migration required' }, 503);
    }
    if (parsed.searchParams.has('summary')) {
      if (dataGate) await dataGate;
      return summaryError ? json({ error: summaryError }, 503) : json(totals);
    }
    if (options.method === 'DELETE' || options.method === 'POST') {
      if (mutationError) return json({ error: mutationError }, 409);
      const action = options.body && JSON.parse(options.body).action;
      if (action === 'archive') items[0].archived_at = '2026-05-18T12:00:00Z';
      else if (action === 'restore') { items[0].archived_at = null; }
      else if (action === 'duplicate') return json({ id: 'copy-draft', status: 'draft', archived_at: null });
      else if (options.method === 'DELETE') items = [];
      else assert.fail(`Unexpected mutation ${url}`);
      return json({ success: true });
    }
    if (parsed.searchParams.has('archive')) {
      if (dataGate) await dataGate;
      if (listError) return json({ error: listError }, 503);
      const view = parsed.searchParams.get('archive');
      return json(items.filter(item => view === 'all' || (view === 'archived' ? !!item.archived_at : !item.archived_at)));
    }
    if (parsed.searchParams.get('timings') === 'true' && parsed.pathname === '/api/email-campaigns/campaign-1') {
      return json({
        campaign: items[0],
        timings: { scheduled_at: items[0].scheduled_at, started_at: null, completed_at: null, notes: [] },
      });
    }
    if (parsed.pathname === '/api/email-campaigns/campaign-1') return json({ ...items[0], html_content: '<p>Preview retained</p>' });
    if (parsed.pathname.includes('footer')) return json({});
    assert.fail(`Unexpected request ${url}`);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const h = React.createElement;
  await act(async () => root.render(h(QueryClientProvider, { client }, h(MemoryRouter, {},
    h(Routes, {}, h(Route, { path: '/', element: h(Campaigns) }), h(Route, { path: '/EmailCampaignEdit/:id', element: h('p', {}, 'Draft editor') }))))));
  await waitFor(() => ready ? calls.some(call => call.url.includes('archive=active')) : container.textContent.includes('migration required'), 'initial data');
  await settle();
  return { calls, client, container, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

test('archive preserves independent headline totals, archived preview and restore do not send; invalidates list and detail caches', async () => {
  const view = await mount();
  try {
    view.client.setQueryDefaults(['email-campaign', campaign.id], { gcTime: Infinity });
    view.client.setQueryData(['email-campaign', campaign.id], campaign);
    await click(byId('button-delete-campaign-1'));
    const dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /headline totals/);
    assert.match(dialog.textContent, /campaign inbox entries/);
    assert.match(dialog.textContent, /does not recall emails/);
    await click(byId('button-confirm-archive'));
    await waitFor(() => !byId('row-campaign-campaign-1'), 'active row removed');
    assert.match(byId('stat-emails-delivered').textContent, /1,234/);
    assert.equal(view.client.getQueryState(['email-campaign', campaign.id]).isInvalidated, true);
    await click(byId('campaign-view-archived'));
    await waitFor(() => byId('badge-archived-campaign-1'), 'archived row');
    for (const action of ['edit', 'test', 'preview']) assert.equal(byId(`button-${action}-campaign-1`).disabled, true);
    assert.ok(byId('button-preview-email-campaign-1'));
    assert.equal(byId('button-duplicate-campaign-1').disabled, false);
    await click(byId('button-preview-email-campaign-1'));
    await waitFor(() => byId('sent-preview-email-body'), 'archived preview loaded');
    assert.match(document.querySelector('[role="dialog"]').textContent, /News/);
    await click([...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button => button.textContent === 'Close'));
    await click(byId('button-restore-campaign-1'));
    await waitFor(() => !byId('row-campaign-campaign-1'), 'restored leaves archive');
    await click(byId('campaign-view-active'));
    await waitFor(() => byId('row-campaign-campaign-1'), 'restored active row');
    const mutations = view.calls.filter(call => call.options.method);
    assert.deepEqual(mutations.map(call => JSON.parse(call.options.body)), [{ action: 'archive' }, { action: 'restore' }]);
    assert.ok(view.calls.filter(call => call.url.includes('summary=true')).length >= 3);
  } finally { await view.cleanup(); }
});

test('clock beside status lazily opens timings and moved notes without mutating campaigns', async () => {
  const view = await mount({ records: [{
    ...campaign, status: 'failed',
    preparation: { phase: 'failed', last_error: 'No recipients found for this campaign' },
  }] });
  try {
    const row = byId('row-campaign-campaign-1');
    assert.ok(row);
    assert.doesNotMatch(row.textContent, /Audience preparation failed|Delivery breakdown unavailable/);
    assert.equal(view.calls.filter(call => call.url.includes('timings=true')).length, 0);
    const clock = byId('button-campaign-timings-campaign-1');
    assert.match(clock.getAttribute('aria-label'), /Spring briefing/);
    assert.equal(clock.getAttribute('aria-haspopup'), 'dialog');
    await click(clock);
    await waitFor(() => document.body.textContent.includes('Campaign finish'), 'timing evidence');
    const dialog = byId('campaign-timing-dialog');
    assert.match(dialog.textContent, /Audience preparation failed/);
    assert.match(dialog.textContent, /failed preparation cannot be resumed/);
    assert.match(dialog.textContent, /Delivery breakdown unavailable/);
    assert.equal(view.calls.filter(call => call.url.includes('timings=true')).length, 1);
    await click([...dialog.querySelectorAll('button')].find(button => button.textContent === 'Close'));
    await waitFor(() => !byId('campaign-timing-dialog'), 'timing dialog closed');
    assert.equal(view.calls.filter(call => call.options.method).length, 0);
  } finally { await view.cleanup(); }
});

test('cancel is non-mutating; permanent delete uses atomic DELETE and refreshes totals', async () => {
  const view = await mount();
  try {
    await click(byId('button-delete-campaign-1'));
    await click([...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button => button.textContent === 'Cancel'));
    assert.equal(view.calls.filter(call => call.options.method).length, 0);
    await click(byId('button-delete-campaign-1'));
    await click(byId('button-confirm-delete'));
    await waitFor(() => !byId('row-campaign-campaign-1'), 'deleted row');
    const mutations = view.calls.filter(call => call.options.method);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].options.method, 'DELETE');
    assert.equal(mutations[0].options.body, undefined);
  } finally { await view.cleanup(); }
});

test('pending and active delivery block archive/delete with explanation', async () => {
  for (const overrides of [{ pending_count: 3, status: 'sent' }, { status: 'sending' }, { status: 'scheduled' }, { status: 'paused' }, { status: 'preparing' }]) {
    const view = await mount({ records: [{ ...campaign, ...overrides }] });
    try {
      await click(byId('button-delete-campaign-1'));
      assert.match(document.querySelector('[role="dialog"] [role="alert"]').textContent, /Stop the campaign/);
      assert.equal(byId('button-confirm-archive').disabled, true);
      assert.equal(byId('button-confirm-delete').disabled, true);
      assert.equal(view.calls.filter(call => call.options.method).length, 0);
    } finally { await view.cleanup(); }
  }
});

test('server conflict remains visible in dialog without removing campaign or claiming success', async () => {
  const view = await mount({ mutationError: 'Delivery started; campaign cannot be archived' });
  try {
    await click(byId('button-delete-campaign-1'));
    await click(byId('button-confirm-archive'));
    await waitFor(() => document.querySelector('[role="dialog"] [role="alert"]'), 'authoritative error');
    assert.match(document.querySelector('[role="dialog"]').textContent, /Delivery started/);
    assert.ok(byId('row-campaign-campaign-1'));
  } finally { await view.cleanup(); }
});

test('missing archive migration still loads 99 campaigns and independent totals; lifecycle controls fail closed', async () => {
  const records = Array.from({ length: 99 }, (_, index) => ({ ...campaign, id: index === 0 ? campaign.id : `item-${index}` }));
  const view = await mount({ ready: false, records });
  try {
    await waitFor(() => byId('row-campaign-campaign-1') && byId('stat-emails-delivered'), 'ordinary reads despite missing migration');
    assert.match(view.container.textContent, /Archive schema migration required/);
    assert.match(view.container.textContent, /Active Campaigns \(99\)/);
    assert.match(byId('stat-emails-delivered').textContent, /1,234/);
    assert.match(byId('stat-campaigns-sent').textContent, /7/);
    assert.doesNotMatch(view.container.textContent, /No active campaigns|Active Campaigns \(0\)/);
    assert.equal(byId('campaign-view-archived').disabled, true);
    assert.equal(byId('campaign-view-active').disabled, false);
    assert.equal(byId('campaign-view-all').disabled, false);
    assert.equal(byId('button-delete-campaign-1').disabled, true);
    await click(byId('button-delete-campaign-1'));
    assert.equal(byId('button-confirm-archive'), null);
    assert.equal(byId('button-confirm-delete'), null);
    await click(byId('campaign-view-archived'));
    assert.equal(view.calls.some(call => call.url.includes('archive=archived')), false);
    await click(byId('campaign-view-all'));
    await waitFor(() => view.container.textContent.includes('All Campaigns (99)'), 'ordinary all view');
    assert.equal(view.calls.filter(call => call.options.method).length, 0);
    assert.ok(view.calls.some(call => call.url.includes('summary=true')));
    assert.ok(view.calls.some(call => call.url.includes('archive=active')));
  } finally { await view.cleanup(); }
});

test('list and summary failures show separate errors, never empty state or zero count', async () => {
  const view = await mount({ ready: false, listError: 'Campaign database unavailable', summaryError: 'Totals database unavailable' });
  try {
    await waitFor(() => view.container.textContent.includes('Campaign list unavailable') && view.container.textContent.includes('Campaign totals unavailable'), 'read errors');
    assert.match(view.container.textContent, /Archive schema migration required/);
    assert.match(view.container.textContent, /Campaign database unavailable/);
    assert.match(view.container.textContent, /Totals database unavailable/);
    assert.doesNotMatch(view.container.textContent, /Active Campaigns \(0\)|No active campaigns|Create First Campaign/);
    assert.equal(byId('stat-campaigns-sent'), null);
    assert.equal(byId('stat-emails-delivered'), null);
    assert.equal(view.calls.filter(call => call.options.method).length, 0);
  } finally { await view.cleanup(); }
});

test('unloaded reads never claim zero; pending readiness does not block successful reads', async () => {
  let releaseData;
  let releaseReadiness;
  const dataGate = new Promise(resolve => { releaseData = resolve; });
  const readinessGate = new Promise(resolve => { releaseReadiness = resolve; });
  const view = await mount({ dataGate, readinessGate });
  try {
    assert.ok(view.container.querySelector('[aria-label="Loading campaigns"]'));
    assert.match(view.container.textContent, /Loading campaign totals/);
    assert.doesNotMatch(view.container.textContent, /Active Campaigns \(0\)|No active campaigns|Create First Campaign/);
    assert.equal(byId('stat-emails-delivered'), null);
    assert.equal(byId('campaign-view-archived').disabled, true);
    await act(async () => releaseData());
    await waitFor(() => byId('row-campaign-campaign-1') && byId('stat-emails-delivered'), 'reads before readiness');
    assert.match(view.container.textContent, /Active Campaigns \(1\)/);
    assert.equal(byId('button-delete-campaign-1').disabled, true);
    assert.equal(byId('campaign-view-archived').disabled, true);
    await click(byId('button-delete-campaign-1'));
    assert.equal(byId('button-confirm-archive'), null);
    assert.equal(view.calls.filter(call => call.options.method).length, 0);
  } finally {
    await act(async () => { releaseData(); releaseReadiness(); });
    await view.cleanup();
  }
});

test('restore remains disabled when readiness fails but all view is readable', async () => {
  const view = await mount({ ready: false, records: [{ ...campaign, archived_at: '2026-05-18T12:00:00Z' }] });
  try {
    await click(byId('campaign-view-all'));
    await waitFor(() => byId('button-restore-campaign-1'), 'archived row in ordinary all view');
    assert.equal(byId('button-restore-campaign-1').disabled, true);
    assert.equal(byId('button-delete-campaign-1').disabled, true);
    await click(byId('button-restore-campaign-1'));
    assert.equal(view.calls.filter(call => call.options.method).length, 0);
  } finally { await view.cleanup(); }
});

test('archived pending records cannot be resumed even in all view', async () => {
  const view = await mount({ records: [{ ...campaign, archived_at: '2026-05-18T12:00:00Z', status: 'sent', pending_count: 2, queued_count: 2 }] });
  try {
    await click(byId('campaign-view-all'));
    await waitFor(() => byId('button-resume-stuck-campaign-1'), 'archived recovery action');
    assert.equal(byId('button-resume-stuck-campaign-1').disabled, true);
    await click(byId('button-resume-stuck-campaign-1'));
    assert.equal(view.calls.filter(call => call.options.method).length, 0);
    assert.ok(byId('button-stats-campaign-1'));
  } finally { await view.cleanup(); }
});

test('all view keeps archived status, pagination and search; archived duplicate opens draft editor', async () => {
  const records = Array.from({ length: 21 }, (_, index) => ({ ...campaign, id: `item-${index}`, name: `Briefing ${index}`, archived_at: index === 20 ? '2026-05-18T12:00:00Z' : null }));
  const view = await mount({ records });
  try {
    await click(byId('campaign-view-all'));
    await waitFor(() => byId('campaigns-pagination'), 'all pagination');
    await click(byId('button-pagination-next'));
    assert.ok(byId('badge-archived-item-20'));
    const search = view.container.querySelector('[aria-label="Search campaigns"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(search, 'Briefing 20');
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.ok(byId('row-campaign-item-20'));
    assert.equal(byId('campaigns-pagination'), null);
    await click(byId('button-duplicate-item-20'));
    await waitFor(() => view.container.textContent.includes('Draft editor'), 'duplicate draft editor');
    assert.deepEqual(JSON.parse(view.calls.find(call => call.options.method === 'POST').options.body), { action: 'duplicate' });
  } finally { await view.cleanup(); }
});

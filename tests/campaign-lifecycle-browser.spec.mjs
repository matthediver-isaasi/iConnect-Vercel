import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { campaignLifecycleError } from '../api/_lib/campaignLifecycle.js';

// Render the actual component, React Query, router and Radix UI in Chromium.
// Every HTTP request is intercepted; entity access is an in-memory boundary.
let script;
let css;
test.beforeAll(async () => {
  await mkdir('/tmp/campaign-lifecycle-browser/evidence', { recursive: true });
  css = (await postcss([tailwindcss({ config: './tailwind.config.ts' })])
    .process(await readFile('client/src/index.css', 'utf8'), { from: 'client/src/index.css' })).css;
  const mocks = {
    '@/api/base44Client': 'export const base44 = {entities: new Proxy({}, {get: () => ({list: async () => [], filter: async () => []})})};',
    '@/lib/queryClient': 'export const maybeEmitPlanQuotaFromBody = () => {};'
  };
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
        import {MemoryRouter} from 'react-router-dom';
        import {Toaster} from 'sonner';
        import EmailCampaigns from './client/src/components/EmailCampaigns.jsx';
        const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
        createRoot(document.getElementById('root')).render(
          <QueryClientProvider client={client}><MemoryRouter><EmailCampaigns/><Toaster/></MemoryRouter></QueryClientProvider>
        );`,
      resolveDir: process.cwd(), loader: 'jsx'
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'isolated-entity-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /^@\/(api\/base44Client|lib\/queryClient)$/ },
          args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' },
          args => ({ contents: mocks[args.path], loader: 'js' }));
      }
    }]
  });
  script = result.outputFiles[0].text;
});

const seed = () => [
  { id: 'sent-a', name: 'Spring briefing', subject: 'Spring member news', status: 'sent', sent_count: 100, opened_count: 50, clicked_count: 10 },
  { id: 'sent-b', name: 'Summer briefing', subject: 'Summer member news', status: 'sent', sent_count: 100, opened_count: 20, clicked_count: 30 },
  { id: 'draft', name: 'Next briefing', subject: 'Draft member news', status: 'draft', sent_count: 0, opened_count: 0, clicked_count: 0 }
].map(item => ({
  ...item, archived_at: null, pending_count: 0, target_type: 'all_members',
  from_name: 'Fixture Association', from_email: 'news@example.test',
  html_content: '<h2>Retained campaign preview</h2><p>Member news remains available after archiving.</p>'
}));

async function fixture(page, { schemaReady = true, deliveryOutcomes = false, cancelled = false, processing = 0 } = {}) {
  let campaigns = seed();
  if (cancelled) Object.assign(campaigns[0], {status:'cancelled',pending_count:1,queued_count:processing?0:1,processing_count:processing});
  const deliverySummary = {
    sent: 4826, excluded: 150, failed: 0, queued: 0, processing: 15,
    reconciliationAlert: { count: 15, message: '15 recipients await reconciliation. Campaign started 2026-10-19T09:00:00.000Z; individual processing start times are not recorded.' }
  };
  if (deliveryOutcomes) Object.assign(campaigns[0], {
    status: 'failed', sent_count: 4826, total_recipients: 4991, pending_count: 15,
    queued_count: 0, processing_count: 15, delivery_summary: deliverySummary,
  });
  let conflict = '';
  const mutations = [];
  const requests = [];
  const unexpected = [];
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  const summary = () => {
    const sent = campaigns.filter(item => item.status === 'sent');
    const sum = key => sent.reduce((total, item) => total + item[key], 0);
    const totalSent = sum('sent_count');
    return {
      totalCampaigns: campaigns.length, sentCampaigns: sent.length, totalSent,
      totalOpened: sum('opened_count'), totalClicked: sum('clicked_count'),
      avgOpenRate: totalSent ? (sum('opened_count') / totalSent * 100).toFixed(1) : 0,
      avgClickRate: totalSent ? (sum('clicked_count') / totalSent * 100).toFixed(1) : 0,
      draftCount: campaigns.filter(item => item.status === 'draft').length, scheduledCount: 0
    };
  };
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.hostname !== 'campaign-lifecycle.fixture.invalid') {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    requests.push({ url: url.pathname + url.search, method: request.method() });
    if (url.pathname === '/api/email-campaigns') {
      if (url.searchParams.has('lifecycle')) return schemaReady ? reply({ ready: true }) : reply({ error: 'Archive schema migration required' }, 503);
      if (url.searchParams.has('summary')) return reply(summary());
      const view = url.searchParams.get('archive');
      if (['active', 'archived', 'all'].includes(view)) return reply(campaigns.filter(item => view === 'all' || (view === 'archived' ? !!item.archived_at : !item.archived_at)));
    }
    if (url.pathname === '/api/email-campaigns/preview-footer') return reply({ hasFooter: false });
    const match = url.pathname.match(/^\/api\/email-campaigns\/(sent-a|sent-b|draft)$/);
    if (match) {
      const campaign = campaigns.find(item => item.id === match[1]);
      if (url.searchParams.has('removal')) {
        if (!campaign) return reply({error:'Campaign not found'},404);
        const blocked = (campaign.processing_count || 0)>0;
        return reply({queued:campaign.queued_count || 0,processing:campaign.processing_count || 0,
          archiveAllowed:!blocked,deleteAllowed:!blocked,
          archiveReason:blocked?'Unresolved processing/provider delivery':null});
      }
      if (request.method() === 'POST' || request.method() === 'DELETE') {
        const action = request.method() === 'DELETE' ? 'delete' : request.postDataJSON().action;
        mutations.push({ method: request.method(), action, id: match[1], body: request.postData() });
        if (conflict) return typeof conflict === 'object'
          ? reply(conflict, conflict.statusCode)
          : reply({ error: conflict }, 409);
        if (action === 'archive') campaign.archived_at = '2026-05-18T12:00:00Z';
        else if (action === 'restore') campaign.archived_at = null;
        else if (action === 'delete') campaigns = campaigns.filter(item => item.id !== match[1]);
        else { unexpected.push(`Unsupported mutation ${action}`); return reply({ error: 'Unexpected mutation' }, 400); }
        return reply({ success: true });
      }
      if (url.searchParams.has('heatmap')) return reply({ heatmapData: [] });
      if (url.searchParams.has('stats')) return reply({
        campaign,
        stats: { sent: 100, delivered: 100, opened: 50, clicked: 10, total: 1, totalTrackedClicks: 10,
          ...(deliveryOutcomes ? { ...deliverySummary, total: 4991, pending: 15 } : {}) }
      });
      if (url.searchParams.has('recipients')) return reply({
        recipients: deliveryOutcomes ? [
          { id: 'suppressed', email: 'suppressed@example.test', status: 'cancelled', error_message: 'Hard-bounced address: campaign sends are paused' },
          { id: 'consent', email: 'optout@example.test', status: 'unsubscribed' },
          { id: 'processing', email: 'uncertain@example.test', status: 'processing' },
          { id: 'accepted', email: 'accepted@example.test', status: 'sent' },
        ] : [{ id: 'recipient-a', email: 'reader@example.test', status: 'sent', opened_at: '2026-05-18T12:00:00Z', clicked_at: null }]
      });
      return reply(campaign);
    }
    unexpected.push(request.method() + ' ' + request.url());
    return route.abort();
  });
  await page.goto('https://campaign-lifecycle.fixture.invalid/');
  if (schemaReady) await expect(page.getByTestId('row-campaign-sent-a')).toBeVisible();
  return { mutations, requests, unexpected, browserErrors, setConflict: value => { conflict = value; } };
}

const screenshot = (page, name) => page.screenshot({ path: `/tmp/campaign-lifecycle-browser/evidence/${name}.png`, fullPage: true });
async function closeDialog(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
function assertIsolated(state) {
  expect(state.unexpected).toEqual([]);
  expect(state.browserErrors).toEqual([]);
}

test('cancelled queued removal and processing protection use separate authoritative counts', async ({ page }) => {
  let state=await fixture(page,{cancelled:true});
  await page.getByTestId('button-delete-sent-a').click();
  await expect(page.getByRole('dialog')).toContainText('Queued recipients: 1. Processing or sending: 0.');
  await expect(page.getByTestId('button-confirm-archive')).toBeEnabled();
  await expect(page.getByTestId('button-confirm-delete')).toBeEnabled();
  await screenshot(page,'cancelled-pending-removal');
  await page.getByTestId('button-confirm-archive').click();
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  expect(state.mutations.map(m=>m.action)).toEqual(['archive']);
  assertIsolated(state);
  await page.unroute('**/*');
  state=await fixture(page,{cancelled:true,processing:1});
  await page.getByTestId('button-delete-sent-a').click();
  await expect(page.getByRole('dialog')).toContainText('Unresolved processing/provider delivery');
  await expect(page.getByTestId('button-confirm-archive')).toBeDisabled();
  await expect(page.getByTestId('button-confirm-delete')).toBeDisabled();
  await expect(page.getByRole('dialog')).not.toContainText('Stop the campaign');
  await screenshot(page,'cancelled-processing-protected');
  expect(state.mutations).toEqual([]);
  assertIsolated(state);
});

test('outcomes separate exclusions and uncertain sends, offer inspection not retry, and filter details', async ({ page }) => {
  const state = await fixture(page, { deliveryOutcomes: true });
  const row = page.getByTestId('row-campaign-sent-a');
  await expect(row).toContainText('4,826 sent · 150 excluded (skipped) · 0 failed · 15 awaiting reconciliation · 0 queued');
  await expect(row.getByRole('button', { name: /Resume/ })).toHaveCount(0);
  await expect(row.getByTestId('campaign-reconciliation-alert')).toContainText('before any resend');
  await row.getByRole('button', { name: 'Inspect delivery details' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('text-stats-excluded')).toHaveText('150');
  await expect(dialog.getByTestId('text-stats-processing')).toHaveText('15');
  await dialog.getByRole('button', { name: 'Inspect delivery details' }).click();
  await expect(dialog.getByTestId('row-recipient-suppressed')).toContainText('Skipped — hard-bounce suppression');
  await expect(dialog.getByTestId('row-recipient-consent')).toContainText('Skipped — consent exclusion');
  await dialog.getByTestId('stat-card-excluded').click();
  await expect(dialog.getByTestId('row-recipient-suppressed')).toBeVisible();
  await expect(dialog.getByTestId('row-recipient-processing')).toHaveCount(0);
  await dialog.getByTestId('stat-card-processing').click();
  await expect(dialog.getByTestId('row-recipient-processing')).toContainText('Awaiting reconciliation');
  await expect(dialog.getByTestId('row-recipient-suppressed')).toHaveCount(0);
  await screenshot(page, 'delivery-outcomes');
  expect(state.mutations).toEqual([]);
  assertIsolated(state);
});

test('cancel makes no mutations; archive retains totals, preview/detail and restore never schedules', async ({ page }) => {
  const state = await fixture(page);
  await expect(page.getByTestId('stat-emails-delivered')).toContainText('200');
  await expect(page.getByTestId('stat-open-rate')).toContainText('35.0%');
  await expect(page.getByTestId('stat-click-rate')).toContainText('20.0%');
  await page.getByTestId('button-delete-sent-a').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('button-confirm-archive')).toHaveText('Archive');
  await expect(dialog.getByTestId('button-confirm-delete')).toHaveText('Delete permanently');
  await expect(dialog).toContainText('campaign inbox entries');
  await expect(dialog).toContainText('does not recall emails');
  await screenshot(page, 'removal-choices');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.mutations).toEqual([]);

  await page.getByTestId('button-delete-sent-a').click();
  await page.getByTestId('button-confirm-archive').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  await expect(page.getByTestId('stat-emails-delivered')).toContainText('200');
  await expect(page.getByTestId('stat-open-rate')).toContainText('35.0%');
  await expect(page.getByTestId('stat-click-rate')).toContainText('20.0%');
  await page.reload();
  await expect(page.getByTestId('row-campaign-sent-b')).toBeVisible();
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  await expect(page.getByTestId('stat-emails-delivered')).toContainText('200');
  await expect(page.getByTestId('stat-open-rate')).toContainText('35.0%');
  await expect(page.getByTestId('stat-click-rate')).toContainText('20.0%');
  await page.getByTestId('campaign-view-archived').click();
  await expect(page.getByTestId('badge-archived-sent-a')).toBeVisible();
  await expect(page.getByTestId('row-campaign-sent-b')).toHaveCount(0);
  await page.getByTestId('button-preview-email-sent-a').click();
  await expect(page.getByTestId('sent-preview-raw-html')).toContainText('Retained campaign preview');
  await screenshot(page, 'archived-preview');
  await closeDialog(page);
  await page.getByTestId('button-stats-sent-a').click();
  await expect(page.getByRole('dialog')).toContainText('Spring briefing');
  await page.getByTestId('button-view-details').click();
  await expect(page.getByRole('dialog')).toContainText('reader@example.test');
  await screenshot(page, 'archived-recipient-detail');
  await closeDialog(page);
  await page.getByTestId('button-restore-sent-a').click();
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  await page.getByTestId('campaign-view-active').click();
  await expect(page.getByTestId('row-campaign-sent-a')).toBeVisible();
  await expect(page.getByTestId('row-campaign-sent-a').getByText('Sent', { exact: true })).toBeVisible();
  await expect(page.getByTestId('button-edit-sent-a')).toHaveCount(0);
  await expect(page.getByTestId('stat-emails-delivered')).toContainText('200');
  await expect(page.getByTestId('stat-open-rate')).toContainText('35.0%');
  await expect(page.getByTestId('stat-click-rate')).toContainText('20.0%');
  await page.reload();
  await expect(page.getByTestId('row-campaign-sent-a')).toBeVisible();
  await expect(page.getByTestId('row-campaign-sent-a').getByText('Sent', { exact: true })).toBeVisible();
  await expect(page.getByTestId('badge-archived-sent-a')).toHaveCount(0);
  await expect(page.getByTestId('stat-emails-delivered')).toContainText('200');
  await expect(page.getByTestId('stat-open-rate')).toContainText('35.0%');
  await expect(page.getByTestId('stat-click-rate')).toContainText('20.0%');
  await page.getByTestId('campaign-view-archived').click();
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No archived campaigns' })).toBeVisible();
  expect(state.mutations.map(item => item.action)).toEqual(['archive', 'restore']);
  expect(state.requests.filter(item => item.method !== 'GET')).toEqual([
    { url: '/api/email-campaigns/sent-a', method: 'POST' },
    { url: '/api/email-campaigns/sent-a', method: 'POST' }
  ]);
  expect(state.requests.filter(item => item.url.includes('summary=true')).length).toBeGreaterThanOrEqual(3);
  assertIsolated(state);
});

test('permanently deleting a sent campaign changes totals and weighted rates', async ({ page }) => {
  const state = await fixture(page);
  await page.getByTestId('button-delete-sent-a').click();
  await page.getByTestId('button-confirm-delete').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  await expect(page.getByTestId('stat-emails-delivered')).toContainText('100');
  await expect(page.getByTestId('stat-open-rate')).toContainText('20.0%');
  await expect(page.getByTestId('stat-click-rate')).toContainText('30.0%');
  await screenshot(page, 'permanent-delete-updated-totals');
  expect(state.mutations).toEqual([{ method: 'DELETE', action: 'delete', id: 'sent-a', body: null }]);
  await page.getByTestId('campaign-view-all').click();
  await expect(page.getByTestId('row-campaign-sent-b')).toBeVisible();
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  assertIsolated(state);
});

test('database timeout retains campaign and dialog without invalidation; explicit retry succeeds', async ({ page }) => {
  const state = await fixture(page);
  const failure = campaignLifecycleError({ code: '57014' });
  state.setConflict(failure);
  await page.getByTestId('button-delete-sent-a').click();
  const reads = state.requests.length;
  await page.getByTestId('button-confirm-delete').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(failure.error);
  await expect(page.getByTestId('row-campaign-sent-a')).toBeVisible();
  await expect(page.getByTestId('button-confirm-delete')).toBeEnabled();
  expect(state.requests.length).toBe(reads + 1);
  await expect(page.getByText('Campaign permanently deleted', { exact: true })).toHaveCount(0);
  await screenshot(page, 'timeout-retains-campaign');
  state.setConflict('');
  await page.getByTestId('button-confirm-delete').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('row-campaign-sent-a')).toHaveCount(0);
  expect(state.mutations).toHaveLength(2);
  assertIsolated(state);
});

test('authoritative archive/delete conflicts stay in the dialog and do not remove records', async ({ page }) => {
  const state = await fixture(page);
  state.setConflict('Delivery started; stop the campaign before removal.');
  await page.getByTestId('button-delete-sent-a').click();
  await page.getByTestId('button-confirm-archive').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Delivery started; stop the campaign before removal.');
  await expect(page.getByTestId('row-campaign-sent-a')).toBeVisible();
  await page.getByTestId('button-confirm-delete').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Delivery started; stop the campaign before removal.');
  await expect(page.getByTestId('stat-open-rate')).toContainText('35.0%');
  await screenshot(page, 'authoritative-removal-error');
  expect(state.mutations.map(item => item.action)).toEqual(['archive', 'delete']);
  assertIsolated(state);
});

test('missing archive schema blocks removal but preserves ordinary campaign reads', async ({ page }) => {
  const state = await fixture(page, { schemaReady: false });
  await expect(page.getByRole('alert')).toContainText('Archive schema migration required');
  await expect(page.getByTestId('campaign-view-archived')).toBeDisabled();
  await expect(page.getByTestId('button-delete-sent-a')).toBeDisabled();
  expect(state.mutations).toEqual([]);
  expect(state.requests.map(item => item.url)).toContain('/api/email-campaigns?archive=active');
  expect(state.requests.some(item => item.url.includes('archive=archived'))).toBe(false);
  await screenshot(page, 'schema-unavailable');
  assertIsolated(state);
});

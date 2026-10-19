import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readCampaignList, isMissingCampaignArchiveColumn } from './campaignReads.js';
import { campaignSummary, campaignLifecycle, campaignLifecycleError } from './campaignLifecycle.js';

const missingColumn = { code: '42703', message: 'column email_campaign.archived_at does not exist' };
const missingRpc = { code: 'PGRST202', message: 'Could not find the function public.campaign_summary(p_tenant) in the schema cache' };
const campaigns = [
  { id: '01', tenant_id: 'a', status: 'sent', archived_at: null },
  { id: '02', tenant_id: 'a', status: 'sent', archived_at: '2026-01-01' },
  { id: '03', tenant_id: 'a', status: 'draft', archived_at: null },
  { id: '04', tenant_id: 'a', status: 'scheduled', archived_at: null },
  { id: '05', tenant_id: 'a', status: 'failed', archived_at: null },
  { id: '06', tenant_id: 'b', status: 'sent', archived_at: null },
];
const recipients = [
  { id: '01', campaign_id: '01', status: 'sent', open_count: 0, click_count: 0 },
  { id: '02', campaign_id: '02', status: 'delivered', open_count: 1, click_count: 2 },
  // SQL counts engagement even when the recipient status is not a sent status.
  { id: '03', campaign_id: '02', status: 'failed', open_count: 1, click_count: 0 },
  { id: '04', campaign_id: '03', status: 'sent', open_count: 1, click_count: 1 },
  { id: '05', campaign_id: '06', status: 'sent', open_count: 1, click_count: 1 },
];

function fixture(options = {}) {
  const calls = [];
  const db = {
    calls,
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      return { error: options.rpcError || missingRpc };
    },
    from(table) {
      const call = { table, filters: [], orders: [] };
      calls.push(call);
      const value = (row, key) => {
        if (!key.startsWith('email_campaign.')) return row[key];
        return campaigns.find(c => c.id === row.campaign_id)?.[key.split('.')[1]];
      };
      const predicates = [];
      const query = {
        select(fields, config) { call.fields = fields; call.config = config; return this; },
        eq(key, expected) { call.filters.push([key, expected]); predicates.push(row => value(row, key) === expected); return this; },
        is(key, expected) { call.archive = true; predicates.push(row => (row[key] ?? null) === expected); return this; },
        not(key) { call.archive = true; predicates.push(row => row[key] != null); return this; },
        in(key, values) { predicates.push(row => values.includes(row[key])); return this; },
        gt(key, expected) { call.filters.push([key, expected]); predicates.push(row => value(row, key) > expected); return this; },
        order(key, config) { call.orders.push([key, config]); return this; },
        range(start, end) { call.range = [start, end]; return this; },
        limit(size) { call.limit = size; return this; },
        async then(resolve, reject) {
          try {
            if (options.error && (!options.errorTable || options.errorTable === table)) return resolve({ error: options.error });
            if (options.legacy && call.archive) return resolve({ error: options.columnError || missingColumn });
            const source = table === 'email_campaign' ? campaigns : recipients;
            let rows = source.filter(row => predicates.every(check => check(row)));
            if (call.config?.head) return resolve({ count: options.missingCount ? null : rows.length });
            const start = call.range?.[0] || 0;
            const requested = call.limit || (call.range ? call.range[1] - start + 1 : 500);
            rows = rows.slice(start, start + Math.min(requested, options.cap || 2));
            resolve({ data: options.legacy ? rows.map(({ archived_at, ...row }) => row) : rows });
          } catch (error) { reject(error); }
        },
      };
      return query;
    },
  };
  return db;
}

// Execute the real getCampaigns body with read-only dependencies. Do not import
// database/provider modules or allow enrichment writes in this regression suite.
const serviceSource = await readFile(new URL('./campaignService.js', import.meta.url), 'utf8');
const getSource = serviceSource.slice(serviceSource.indexOf('export async function getCampaigns('),
  serviceSource.indexOf('export async function getCampaign(')).replace('export ', '');
function service(db) {
  return new Function('supabase', 'readCampaignList', 'isMissingCampaignArchiveColumn',
    'campaignLifecycleError', 'enrichCampaignCounts', 'enrichCampaignPreparationList', 'console',
    `${getSource}; return getCampaigns;`)(
    db, readCampaignList, isMissingCampaignArchiveColumn, campaignLifecycleError,
    async row => row, async (_db, _tenant, rows) => rows, { error() {} },
  );
}

test('current-schema getCampaigns active/archived/all preserves scope, status and limits', async () => {
  for (const [archive, expected] of [
    ['active', ['01', '03', '04', '05']], ['archived', ['02']], ['all', ['01', '02', '03', '04', '05']],
  ]) {
    const db = fixture();
    const result = await service(db)('a', { archive });
    assert.equal(result.success, true);
    assert.deepEqual(result.campaigns.map(row => row.id), expected);
    assert.ok(db.calls.every(call => call.filters.some(([key, tenant]) => key === 'tenant_id' && tenant === 'a')));
  }
  const result = await service(fixture())('a', { archive: 'all', status: 'sent', limit: 1 });
  assert.deepEqual(result.campaigns.map(row => row.id), ['01']);
});

test('missing archive column permits only legacy active/all reads; archived stays 503', async () => {
  for (const columnError of [missingColumn, {
    code: 'PGRST204', message: "Could not find the 'archived_at' column of 'email_campaign' in the schema cache",
  }]) {
    for (const archive of ['active', 'all']) {
      const db = fixture({ legacy: true, columnError });
      const result = await service(db)('a', { archive });
      assert.equal(result.success, true);
      assert.equal(result.campaigns.length, 5);
      assert.ok(result.campaigns.every(row => !('archived_at' in row)));
    }
    const db = fixture({ legacy: true, columnError });
    const result = await service(db)('a', { archive: 'archived' });
    assert.equal(result.statusCode, 503);
    assert.equal(db.calls.length, 1);
  }
});

test('list real failures and unrelated missing columns never trigger a compatibility read', async () => {
  for (const error of [
    { code: '08006', message: 'connection lost' },
    { code: '42501', message: 'permission denied' },
    { code: '42703', message: 'column email_campaign.other_column does not exist' },
    { code: '42P01', message: 'relation email_campaign does not exist' },
    { code: '500', message: 'column email_campaign.archived_at does not exist' },
  ]) {
    const db = fixture({ error });
    const result = await service(db)('a', { archive: 'active' });
    assert.equal(result.success, false);
    assert.equal(result.error, error.message);
    assert.equal(db.calls.length, 1);
  }
});

test('legacy summary follows SQL across capped campaign pages and tenant-scoped exact recipient aggregates', async () => {
  const db = fixture({ legacy: true, cap: 1 });
  const result = await campaignSummary(db, 'a');
  assert.deepEqual(result, { success: true, summary: {
    totalCampaigns: 5, sentCampaigns: 2, draftCount: 1, scheduledCount: 1,
    totalSent: 2, totalOpened: 2, totalClicked: 1, avgOpenRate: 100, avgClickRate: 50,
  } });
  const reads = db.calls.filter(call => call.table);
  assert.equal(reads.filter(call => call.table === 'email_campaign').length, 6);
  for (const call of reads) {
    assert.ok(!call.fields.includes('archived_at'));
    if (call.table === 'email_campaign') {
      assert.ok(call.limit <= 500);
      assert.ok(call.filters.some(([key, value]) => key === 'tenant_id' && value === 'a'));
    } else {
      assert.deepEqual(call.config, { count: 'exact', head: true });
      assert.ok(call.fields.includes('email_campaign!inner'));
      assert.ok(call.filters.some(([key, value]) => key === 'email_campaign.tenant_id' && value === 'a'));
      assert.ok(call.filters.some(([key, value]) => key === 'email_campaign.status' && value === 'sent'));
    }
  }
  assert.equal(reads.filter(call => call.table === 'email_campaign_recipient').length, 3);
});

test('current RPC summary bypasses compatibility reads', async () => {
  const summary = { totalCampaigns: 12 };
  const db = { rpc: async () => ({ data: summary }), from() { assert.fail('Unexpected legacy read'); } };
  assert.deepEqual(await campaignSummary(db, 'a'), { success: true, summary });
});

test('legacy summary supports PostgreSQL missing-function error but never generic RPC failures', async () => {
  const db = fixture({ rpcError: { code: '42883', message: 'function public.campaign_summary(p_tenant => uuid) does not exist' } });
  assert.equal((await campaignSummary(db, 'a')).success, true);
  for (const error of [
    { code: '08006', message: 'connection lost' },
    { code: '42501', message: 'permission denied' },
    { code: '42883', message: 'function public.some_nested_function() does not exist' },
    { code: 'PGRST202', message: 'Could not find the function public.other_function() in the schema cache' },
  ]) {
    const db = fixture({ rpcError: error });
    const result = await campaignSummary(db, 'a');
    assert.equal(result.success, false);
    assert.equal(result.summary, undefined);
    assert.equal(db.calls.length, 1);
  }
});

test('legacy summary failures and unavailable counts never become fake zero statistics', async () => {
  for (const options of [
    { error: { code: '08006', message: 'connection lost' } },
    { errorTable: 'email_campaign_recipient', error: { code: '42501', message: 'permission denied' } },
    { missingCount: true },
  ]) {
    const result = await campaignSummary(fixture(options), 'a');
    assert.equal(result.success, false);
    assert.equal(result.summary, undefined);
    assert.ok(result.error);
  }
  const empty = await campaignSummary(fixture(), 'no-campaigns');
  assert.equal(empty.success, true);
  assert.equal(empty.summary.totalCampaigns, 0);
  assert.equal(empty.summary.totalSent, 0);
  assert.equal(empty.summary.avgOpenRate, 0);
});

test('missing lifecycle migration never enables archive/restore/delete mutations', async () => {
  for (const action of ['archive', 'restore', 'delete']) {
    const db = fixture();
    const result = await campaignLifecycle(db, '01', 'a', action);
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 503);
    assert.equal(db.calls.length, 1);
  }
});

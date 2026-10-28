import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readCampaignTimings } from '../_lib/campaignTimings.js';

const admin = { tenantId: 'tenant-a', isAuthenticated: true, tenantUserId: 'admin-a' };
const request = { method: 'GET', query: { id: 'campaign-a', timings: 'true', tenantId: 'attacker' } };
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// Execute the real route body with explicit dependencies, never importing its
// live database, session or email-provider dependency graph.
async function route(deps = {}) {
  const source = (await readFile(new URL('./[id].js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default async function handler', 'return async function handler');
  const dependencies = {
    getTenantContext: async () => admin,
    hasAdminAccess: async () => true,
    supabase: { from() { assert.fail('Unexpected database access'); } },
    readCampaignTimings,
    console: { error() {} },
    ...deps,
  };
  return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

test('timings authentication/admin/mismatch failures deny before reading any evidence', async () => {
  for (const [context, allowed, status] of [
    [{}, true, 401],
    [{ tenantId: 'tenant-a', isAuthenticated: false }, true, 401],
    [admin, false, 403],
    [{ ...admin, tenantMismatch: true }, true, 403],
  ]) {
    let reads = 0;
    const handler = await route({
      getTenantContext: async () => context,
      hasAdminAccess: async () => allowed,
      readCampaignTimings: async () => { reads++; assert.fail('Unauthorized read'); },
    });
    const res = response();
    await handler(request, res);
    assert.equal(res.statusCode, status);
    assert.equal(reads, 0);
  }
});

test('admin authorization dependency failure never permits timing reads', async () => {
  let reads = 0;
  const failure = new Error('Administrator lookup unavailable');
  const handler = await route({
    hasAdminAccess: async () => { throw failure; },
    readCampaignTimings: async () => { reads++; },
  });
  await assert.rejects(handler(request, response()), e => e === failure);
  assert.equal(reads, 0);
});

test('all administrative by-id reads require authentication and tenant admin authority', async () => {
  for (const query of [{}, { stats: 'true' }, { heatmap: 'true' }, { recipients: 'true' }]) {
    for (const [context, allowed, status] of [
      [{ tenantId: 'tenant-a' }, true, 401],
      [admin, false, 403],
      [{ ...admin, tenantMismatch: true }, true, 403],
    ]) {
      const handler = await route({ getTenantContext: async () => context, hasAdminAccess: async () => allowed,
        getCampaign: () => assert.fail('unauthorized campaign read'),
        getCampaignStats: () => assert.fail('unauthorized statistics'),
        getClickHeatmapData: () => assert.fail('unauthorized heatmap'),
        getCampaignRecipients: () => assert.fail('unauthorized recipients') });
      const res = response();
      await handler({ method: 'GET', query: { id: 'campaign-a', ...query } }, res);
      assert.equal(res.statusCode, status);
    }
  }
  const handler = await route({ getCampaign: async (id, tenant) => {
    assert.equal(id, 'campaign-a'); assert.equal(tenant, 'tenant-a');
    return { success: true, campaign: { id, html_content: 'Saved campaign' } };
  } });
  const res = response();
  await handler({ method: 'GET', query: { id: 'campaign-a', tenantId: 'attacker' } }, res);
  assert.equal(res.body.html_content, 'Saved campaign');
});

test('authorized GET passes session tenant, not query tenant; timings takes precedence over other reads', async () => {
  const db = {};
  const result = { campaign: { id: 'campaign-a' }, timings: { completed_at: null } };
  let args;
  const handler = await route({
    supabase: db,
    readCampaignTimings: async (...values) => { args = values; return result; },
  });
  const res = response();
  await handler({ ...request, query: { ...request.query, stats: 'true', heatmap: 'true', recipients: 'true' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(args, [db, 'campaign-a', 'tenant-a']);
  assert.deepEqual(res.body, result);
});

test('absent tenant parent returns 404 with no child queries in integrated route/helper', async () => {
  const tables = [];
  const handler = await route({
    supabase: {
      from(table) {
        tables.push(table);
        assert.equal(table, 'email_campaign');
        const filters = [];
        return {
          select() { return this; },
          eq(...args) { filters.push(args); return this; },
          async maybeSingle() {
            assert.deepEqual(filters, [['id', 'campaign-a'], ['tenant_id', 'tenant-a']]);
            return { data: null };
          },
        };
      },
    },
  });
  const res = response();
  await handler(request, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
  assert.deepEqual(tables, ['email_campaign']);
});

test('timings query failures return generic 500 without leaking database details', async () => {
  for (const error of [{ code: '42703', message: 'Private schema detail' }, new Error('Private database detail')]) {
    const handler = await route({ readCampaignTimings: async () => { throw error; } });
    const res = response();
    await handler(request, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Unable to load campaign timings.' });
  }
});

test('timings request without campaign id returns 400 before database reads', async () => {
  const handler = await route();
  const res = response();
  await handler({ method: 'GET', query: { timings: 'true' } }, res);
  assert.equal(res.statusCode, 400);
});

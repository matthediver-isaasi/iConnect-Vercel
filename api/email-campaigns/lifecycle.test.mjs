import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  campaignLifecycle, campaignLifecycleReady, campaignSummary, campaignLifecycleError,
  beginCampaignTestSend, finishCampaignTestSend,
  guardArchivedCampaignWrite,
} from '../_lib/campaignLifecycle.js';

// Execute actual route bodies with explicit dependencies. No session, database
// or provider can be reached by these fixtures.
async function route(file, deps) {
  let source = await readFile(new URL(file, import.meta.url), 'utf8');
  source = source.replace(/^import[\s\S]*?;\n/gm, '');
  const names = Object.keys(deps);
  return new Function(...names, source.replace('export default async function handler', 'return async function handler'))(...Object.values(deps));
}
const admin = { tenantId: 'tenant-a', isAuthenticated: true, tenantUserId: 'admin' };
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('lifecycle routes deny anonymous, non-admin and mismatched tenant without parent/child writes', async () => {
  for (const context of [
    { tenantId: 'tenant-a', isAuthenticated: false },
    { tenantId: 'tenant-a', isAuthenticated: true },
    { ...admin, tenantMismatch: true },
  ]) {
    for (const action of ['archive', 'restore', 'delete']) {
      let calls = 0;
      const handler = await route('./[id].js', {
        getTenantContext: async () => context, hasAdminAccess: async ctx => !!ctx.tenantUserId,
        campaignLifecycle: async () => { calls++; }, deleteCampaign: async () => { calls++; },
        supabase: {},
      });
      const res = response();
      await handler({ method: action === 'delete' ? 'DELETE' : 'POST', query: { id: 'campaign-b' }, body: { action } }, res);
      assert.ok([401, 403].includes(res.statusCode));
      assert.equal(calls, 0);
    }
  }
});

test('authorized archive and restore use session tenant and return conflicts truthfully', async () => {
  for (const action of ['archive', 'restore']) {
    let args;
    const handler = await route('./[id].js', {
      getTenantContext: async () => admin, hasAdminAccess: async () => true,
      supabase: {},
      campaignLifecycle: async (...values) => { args = values; return { success: false, statusCode: 409, error: 'Stop and reconcile delivery first.' }; },
    });
    const res = response();
    await handler({ method: 'POST', query: { id: 'campaign' }, body: { action, tenantId: 'attacker' } }, res);
    assert.deepEqual(args.slice(1), ['campaign', 'tenant-a', action]);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /reconcile/);
  }
});

test('permanent delete returns protected/not-found/schema failures, not success', async () => {
  for (const statusCode of [404, 409, 503]) {
    let args;
    const handler = await route('./[id].js', {
      getTenantContext: async () => admin, hasAdminAccess: async () => true,
      deleteCampaign: async (...values) => { args = values; return { success: false, statusCode, error: 'No changes made' }; },
    });
    const res = response();
    await handler({ method: 'DELETE', query: { id: 'campaign' } }, res);
    assert.deepEqual(args, ['campaign', 'tenant-a']);
    assert.equal(res.statusCode, statusCode);
    assert.equal(res.body.success, undefined);
  }
});

test('service lifecycle makes exactly one tenant-scoped RPC and never deletes children itself', async () => {
  const calls = [];
  const db = { rpc: async (...args) => { calls.push(args); return { data: { id: 'c', archived_at: 'now' } }; } };
  assert.equal((await campaignLifecycle(db, 'c', 't', 'archive')).success, true);
  assert.deepEqual(calls, [['campaign_lifecycle', { p_campaign: 'c', p_tenant: 't', p_action: 'archive' }]]);
  assert.equal((await campaignLifecycle(db, 'c', null, 'delete')).success, false);
  assert.equal(calls.length, 1);
});

test('missing migration fails closed; protected FKs provide Archive guidance', async () => {
  for (const code of ['42883', '42703', 'PGRST202', 'PGRST204']) {
    const db = { rpc: async () => ({ error: { code } }) };
    assert.equal((await campaignLifecycle(db, 'c', 't', 'archive')).statusCode, 503);
    assert.equal((await campaignLifecycleReady(db)).statusCode, 503);
    assert.equal((await campaignSummary(db, 't')).statusCode, 503);
  }
  assert.match(campaignLifecycleError({ code: '23503' }).error, /Archive.*No changes/);
  assert.equal((await campaignLifecycleReady({ rpc: async () => ({ data: false }) })).success, false);
});

test('summary is session-tenant-wide and independent of list filter, limit and status', async () => {
  let seen;
  const totals = { totalSent: 20, totalOpened: 5, avgOpenRate: 25 };
  const handler = await route('./index.js', {
    getTenantContext: async () => admin, hasAdminAccess: async () => true, supabase: {},
    campaignSummary: async (...args) => { seen = args; return { success: true, summary: totals }; },
    getCampaigns: async () => { throw new Error('Summary must not use filtered list'); },
  });
  const res = response();
  await handler({ method: 'GET', query: { summary: 'true', archive: 'active', limit: '1', status: 'draft', tenantId: 'attacker' } }, res);
  assert.equal(seen[1], 'tenant-a');
  assert.deepEqual(res.body, totals);
});

test('list supports explicit archive views and rejects malformed filters/limits', async () => {
  let seen;
  const handler = await route('./index.js', {
    getTenantContext: async () => admin, hasAdminAccess: async () => true,
    getCampaigns: async (...args) => { seen = args; return { success: true, campaigns: [] }; },
  });
  for (const archive of ['active', 'archived', 'all']) {
    const res = response();
    await handler({ method: 'GET', query: { archive } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(seen[1].archive, archive);
  }
  for (const query of [{ archive: 'bad' }, { limit: '-1' }, { limit: 'abc' }]) {
    const res = response();
    await handler({ method: 'GET', query }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('test-send reservations fail closed and never release ambiguous provider work', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push({ name, args }); return { data: name.endsWith('begin') ? 'lease' : true }; } };
  assert.equal((await beginCampaignTestSend(db, 'c', 't')).lease, 'lease');
  assert.deepEqual(calls[0].args, { p_campaign: 'c', p_tenant: 't' });
  assert.equal((await finishCampaignTestSend(db, 'c', 't', 'lease', [{ success: false }])).reconciliationRequired, true);
  assert.equal(calls.length, 1);
  assert.equal((await finishCampaignTestSend(db, 'c', 't', 'lease', [{ success: true }])).reconciliationRequired, false);
  assert.deepEqual(calls[1].args, { p_campaign: 'c', p_tenant: 't', p_lease: 'lease' });
  assert.equal((await beginCampaignTestSend({ rpc: async () => ({ error: { code: '55000', message: 'Archived' } }) }, 'c', 't')).statusCode, 409);
});

test('actual generic EmailCampaign PATCH/PUT cannot edit archived content or clear its archive metadata', async () => {
  for (const method of ['PATCH', 'PUT']) {
    for (const payload of [{ subject: 'Changed' }, { html_content: '<p>Changed</p>' }, { archived_at: null, subject: 'Changed' }]) {
      const filters = [];
      const db = {
        from(table) {
          assert.equal(table, 'email_campaign');
          return {
            select(fields) { assert.equal(fields, 'archived_at'); return this; },
            eq(field, value) { filters.push([field, value]); return this; },
            async maybeSingle() { return { data: { archived_at: '2026-10-19T12:00:00Z' } }; },
            update() { assert.fail('Archived generic write reached mutation'); },
          };
        },
      };
      const handler = await route('../entities/[entity]/[id].js', {
        GROUP_FIELDS_KEY: 'org_directory_group_fields',
        supabase: db, guardArchivedCampaignWrite,
        getTenantContext: async () => admin,
        getEntityTenantScope: () => 'tenant', TENANT_SCOPE: { GLOBAL: 'global' },
        rejectGenericCpdPointsEntity: () => false,
        rejectGenericServerOwnedEntity: () => false,
        gatePublicTicketMemberPolicy: async (_entity, body) => body,
        isCustomObjectStorageEntity: () => false,
        hasGenericCommitmentFields: () => false,
        authorizeGenericCommunicationPreferenceAccess: async () => null,
        hasAdminAccess: async () => true,
      });
      const res = response();
      await handler({ method, query: { entity: 'EmailCampaign', id: 'campaign' }, body: payload }, res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'CAMPAIGN_ARCHIVED');
      assert.deepEqual(filters, [['id', 'campaign'], ['tenant_id', 'tenant-a']]);
    }
  }
});

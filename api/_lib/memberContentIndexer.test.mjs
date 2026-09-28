import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteMemberContentChunks, sweepOrphanedMemberContentChunks } from './memberContentIndexer.js';

function db({ rows = [], canonical = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_member_content_generation') return Promise.resolve({ data: { generation: 2, claim_token: 'claim' } });
      if (name === 'publish_member_content_knowledge') return Promise.resolve({ data: !!args.p_tenant_id });
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table) {
      const filters = {};
      let single = false;
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        in() { return q; },
        eq(k,v) { filters[k]=v; return q; }, or() { return q; },
        maybeSingle() { single = true; return q; },
        update() { return q; },
        then(resolve) {
          calls.push({ table, filters });
          const data = table === 'member_content_source' ? rows
            : table === 'member_content_chunk' ? [] : single ? canonical : canonical ? [canonical] : [];
          resolve({ data, error: null });
        },
      };
      return q;
    },
  };
}

test('scoped deletion uses a zero-budget generation tombstone, never a raw chunk delete', async () => {
  const supabase = db();
  const result = await deleteMemberContentChunks('resource', 'gone', { supabase, tenantId: 'tenant-a' });
  assert.equal(result.removed, true);
  const published = supabase.calls.find(c => c.name === 'publish_member_content_knowledge' && c.args.p_tenant_id);
  assert.equal(published.args.p_tenant_id, 'tenant-a');
  assert.deepEqual(published.args.p_rows, []);
});

test('unscoped deletion cannot guess between tenants', async () => {
  const supabase = db({ rows: [{ tenant_id: 'a' }, { tenant_id: 'b' }] });
  await assert.rejects(deleteMemberContentChunks('resource', 'gone', { supabase }), /unique tenant/);
  assert.equal(supabase.calls.some(c=>c.name), false);
});

test('registry sweep resumes using a bounded composite cursor', async () => {
  const supabase = db({ rows: [{ tenant_id: 'tenant-a', content_type: 'resource', source_id: 'gone' }] });
  const result = await sweepOrphanedMemberContentChunks({ supabase, maxItems: 1 });
  assert.equal(result.items, 1);
  assert.equal(result.done, false);
  assert.ok(result.nextCursor);
  assert.equal(result.removedSources, 1);
});

test('empty registry completes without publishing anything', async () => {
  const supabase = db();
  const result = await sweepOrphanedMemberContentChunks({ supabase });
  assert.equal(result.done, true);
  assert.equal(result.removedSources, 0);
  assert.equal(supabase.calls.some(c=>c.name), false);
});
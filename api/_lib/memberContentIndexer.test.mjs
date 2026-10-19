import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteMemberContentChunks, sweepOrphanedMemberContentChunks,
  processDueMemberContentReindexJobs, reindexAllMemberContent,
} from './memberContentIndexer.js';

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

function retryQueueDb(mode) {
  const job = { tenant_id: 'tenant', source_id: 'blog', content_type: 'blog_post', attempts: 2 };
  const item = { id: job.source_id, tenant_id: job.tenant_id, title: 'Current blog',
    content: 'Current content', status: 'published' };
  const operations = [];
  return {
    operations, job,
    from(table) {
      const filters = {};
      let patch;
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        lte() { return q; },
        eq(key, value) { filters[key] = value; return q; },
        maybeSingle() { return q; },
        update(value) { patch = value; return q; },
        upsert(value) { patch = value; return q; },
        then(resolve) {
          operations.push({ table, filters, patch });
          resolve({ data: table === 'member_content_reindex_job' ? (patch ? null : [job])
            : table === 'blog_post' ? item : [], error: null });
        },
      };
      return q;
    },
    async rpc(name, args) {
      operations.push({ name, args });
      if (name === 'claim_member_content_generation') return {
        data: { generation: 1, claim_token: mode === 'busy' ? null : 'claim' }, error: null,
      };
      if (name === 'publish_member_content_knowledge') {
        if (!args.p_tenant_id) return { data: false, error: null };
        return { data: null, error: { code: 'P0001', message: mode === 'failure'
          ? 'publication database unavailable'
          : 'MEMBER_CONTENT_GENERATION_STALE: publish rejected' } };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
}

const queueProvider = { embeddings: { create: async ({ input }) => ({
  data: input.map(() => ({ embedding: [0.1] })),
}) } };

test('due-job stale recovery backs off once, counts contention separately and preserves spent budget', async () => {
  const supabase = retryQueueDb('stale');
  const budget = { maxEmbeddingChunks: 4 };
  const result = await processDueMemberContentReindexJobs({
    supabase, openai: queueProvider, embeddingBudget: budget,
  });
  assert.equal(result.processed, 0);
  assert.equal(result.errors, 0);
  assert.equal(result.deferred, 1);
  assert.equal(result.stopReason, 'source_deferred');
  assert.equal(result.details[0].code, 'MEMBER_CONTENT_GENERATION_STALE');
  assert.equal(result.details[0].embeddingChunksSpent, 1);
  assert.equal(budget.maxEmbeddingChunks, 3);
  const retry = supabase.operations.find(op => op.table === 'member_content_reindex_job' && op.patch);
  assert.equal(retry.patch.attempts, 3);
  assert.ok(Date.parse(retry.patch.available_at) > Date.now());
  assert.equal(supabase.operations.filter(op => op.name === 'claim_member_content_generation').length, 1);
});

test('global scheduled scan does not immediately re-claim a stale due job in the same slice', async () => {
  const supabase = retryQueueDb('stale');
  const result = await reindexAllMemberContent({ supabase, openai: queueProvider, maxEmbeddingChunks: 4 });
  assert.equal(result.stopReason, 'source_deferred');
  assert.equal(result.done, false);
  assert.equal(result.items, 0);
  assert.equal(result.errors, 0);
  assert.equal(result.deferred, 1);
  assert.equal(result.embeddingChunksSpent, 1);
  assert.equal(result.nextCursor.lastId, null);
  assert.equal(supabase.operations.filter(op => op.name === 'claim_member_content_generation').length, 1);
  assert.ok(supabase.operations.filter(op => op.table === 'blog_post').every(op => op.filters.id === 'blog'));
});

test('due busy claims stop without spend; unrelated RPC failures remain real failures', async () => {
  const busy = await processDueMemberContentReindexJobs({
    supabase: retryQueueDb('busy'), openai: {},
  });
  assert.equal(busy.processed, 0);
  assert.equal(busy.errors, 0);
  assert.equal(busy.deferred, 1);
  assert.equal(busy.stopReason, 'source_deferred');
  const failure = await processDueMemberContentReindexJobs({
    supabase: retryQueueDb('failure'), openai: queueProvider,
  });
  assert.equal(failure.errors, 1);
  assert.equal(failure.deferred, 0);
  assert.equal(failure.stopReason, undefined);
});
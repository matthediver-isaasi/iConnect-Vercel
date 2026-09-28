// Lifecycle integration tests exercise the indexer's database protocol as one
// unit (claim -> stage -> activate), rather than only isolated predicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reindexMemberContentItem } from './memberContentIndexer.js';

function lifecycleDb({
  claim = { generation: 7, claim_token: 'claim-7' },
  activate = true,
  existing = [],
} = {}) {
  const calls = [];
  const db = {
    calls,
    rpc(name, args) {
      calls.push({ kind: 'rpc', name, args });
      if (name === 'claim_member_content_generation') return Promise.resolve({ data: claim, error: null });
      if (name === 'release_member_content_generation') return Promise.resolve({ data: true, error: null });
      if (name === 'publish_member_content_knowledge') {
        return Promise.resolve({ data: args.p_tenant_id ? activate : false, error: null });
      }
      if (name === 'activate_member_content_generation') return Promise.resolve({ data: activate, error: null });
      throw new Error(`unexpected rpc ${name}`);
    },
    from(table) {
      const state = { table, filters: {} };
      const q = {
        select() { return q; },
        update() { state.update = true; return q; },
        maybeSingle() { return q; },
        delete() { return q; },
        eq(key, value) { state.filters[key] = value; return q; },
        upsert(rows, options) {
          calls.push({ kind: 'upsert', table, rows, options });
          return Promise.resolve({ error: null });
        },
        then(resolve) {
          calls.push({ kind: 'select', table, filters: state.filters });
          resolve({ data: table === 'resource' ? resource : existing, error: null });
        },
      };
      return q;
    },
  };
  return db;
}

const resource = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  title: 'Approved event guide',
  description: 'The confirmed event is on 16 October 2026.',
  status: 'active',
  resource_type: 'article',
};
const openai = { embeddings: { create: async ({ input }) => ({
  data: input.map(() => ({ embedding: [0.1, 0.2] })),
}) } };

test('publishes a complete generation with the exact claim in one atomic RPC', async () => {
  const db = lifecycleDb();
  const result = await reindexMemberContentItem('resource', { ...resource }, { supabase: db, openai });
  assert.equal(result.embedded, 1);
  assert.equal(db.calls.some((call) => call.kind === 'upsert'), false);
  const activation = db.calls.find((call) => call.name === 'publish_member_content_knowledge' && call.args.p_tenant_id);
  assert.equal(activation.args.p_rows[0].source_generation, 7);
  const { p_rows, ...identity } = activation.args;
  assert.deepEqual(identity, {
    p_tenant_id: resource.tenant_id,
    p_content_type: 'resource',
    p_source_id: resource.id,
    p_generation: 7,
    p_claim_token: 'claim-7',
  });
});

test('a superseded claim stages no live answer generation', async () => {
  const db = lifecycleDb({ activate: false });
  await assert.rejects(reindexMemberContentItem('resource', { ...resource }, { supabase: db, openai }),
    { code: 'MEMBER_CONTENT_GENERATION_STALE' });
  assert.equal(db.calls.some((call) => call.kind === 'upsert'), false);
  assert.equal(
    db.calls.filter((call) => call.table === 'member_content_source').length,
    1
  );
});

test('an already-claimed generation does not issue embeddings', async () => {
  const db = lifecycleDb({ claim: null });
  let embedded = false;
  const guardedOpenAi = { embeddings: { create: async () => { embedded = true; return { data: [] }; } } };
  const result = await reindexMemberContentItem('resource', { ...resource }, {
    supabase: db,
    openai: guardedOpenAi,
  });
  assert.equal(result.busy, true);
  assert.equal(embedded, false);
});

test('rebuild reuses only an embedding made with the configured model', async () => {
  const contentHash = (await import('node:crypto'))
    .createHash('sha256')
    .update('Approved event guide\n\nThe confirmed event is on 16 October 2026.\n\nType: article')
    .digest('hex');
  const db = lifecycleDb({
    existing: [{
      chunk_index: 0,
      title: resource.title,
      content_hash: contentHash,
      embedding: [0.1, 0.2],
      embedding_model: 'text-embedding-3-small',
    }],
  });
  let embedded = false;
  const guardedOpenAi = { embeddings: { create: async () => { embedded = true; return { data: [] }; } } };
  const result = await reindexMemberContentItem('resource', { ...resource }, {
    supabase: db,
    openai: guardedOpenAi,
  });
  assert.equal(result.reused, 1);
  assert.equal(embedded, false);
  const row = db.calls.find((call) => call.name === 'publish_member_content_knowledge' && call.args.p_tenant_id).args.p_rows[0];
  assert.equal(row.embedding, '[0.1,0.2]');
  assert.equal(row.embedding_model, 'text-embedding-3-small');
});
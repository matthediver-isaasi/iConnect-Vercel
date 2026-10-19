import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeMemberContentGeneration } from './memberContentGenerationWriter.js';
import { validatedCheckpointVector } from './memberContentEmbeddingCheckpoints.js';
import { EMBEDDING_MODEL } from './helpArticleIndexer.js';

const vector = () => Array(1536).fill(0.125);
const item = { id: 'page', tenant_id: 'tenant', title: 'Canonical page' };

// Durable state outlives each fresh client/worker. No DB/provider calls.
function fixture(count = 284) {
  const state = {
    generation: 1, token: null, serial: 0, checkpoints: [], published: [],
    operations: [], chunks: Array.from({ length: count }, (_, chunkIndex) => ({
      chunkIndex, content: `Canonical block ${chunkIndex}`, accessScope: 'public',
    })), title: item.title, missing: false,
  };
  const identityValid = (args) => args.p_tenant_id === item.tenant_id &&
    args.p_source_id === item.id && args.p_content_type === 'iedit_page' &&
    args.p_generation === state.generation && args.p_claim_token === state.token;
  function client() {
    return {
      from(table) {
        const filters = {};
        const b = {
          select() { return b; }, eq(key, value) { filters[key] = value; return b; },
          update() { b.updating = true; return b; },
          then(resolve) {
            state.operations.push({ table, updating: b.updating, filters });
            if (b.updating && filters.claim_token === state.token &&
                filters.generation === state.generation) state.token = null;
            resolve({ data: table === 'member_content_chunk' ? state.published : [], error: null });
          },
        };
        return b;
      },
      async rpc(name, args) {
        state.operations.push({ name, args });
        if (name === 'claim_member_content_generation') {
          state.token = `claim-${++state.serial}`;
          return { data: [{ generation: state.generation, claim_token: state.token }], error: null };
        }
        if (!identityValid(args)) return {
          data: null, error: new Error('MEMBER_CONTENT_GENERATION_STALE: checkpoint/publish rejected'),
        };
        if (name === 'read_member_content_embedding_checkpoints') {
          return { data: structuredClone(state.checkpoints), error: null };
        }
        if (name === 'save_member_content_embedding_checkpoints') {
          state.checkpoints.push(...structuredClone(args.p_rows));
          return { data: true, error: null };
        }
        if (name === 'publish_member_content_knowledge') {
          state.published = structuredClone(args.p_rows);
          state.checkpoints = []; // source activation trigger
          state.token = null;
          return { data: true, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    };
  }
  function invalidate() {
    state.generation++;
    state.token = null;
    state.checkpoints = []; // source generation trigger
  }
  async function run(budget = 100, extras = {}) {
    return writeMemberContentGeneration('iedit_page', item, {
      supabase: client(), publisherReady: true, openai: {},
      embeddingBudget: { maxEmbeddingChunks: budget },
      buildSnapshot: async () => ({
        item: state.missing ? null : { ...item, title: state.title },
        chunks: structuredClone(state.chunks),
        metadata: {
          tenant_id: item.tenant_id, source_id: item.id, content_type: 'iedit_page',
          title: state.title, access_scope: 'public',
        },
        provenance: { kind: 'iedit', generation: state.generation },
      }),
      embedTexts: async (_provider, inputs) => inputs.map(vector),
      ...extras,
    });
  }
  return { state, run, invalidate };
}

test('284-chunk page resumes with fresh workers 100/100/84, publishing only once', async () => {
  const { state, run } = fixture();
  const first = await run();
  assert.equal(first.partial, true);
  assert.equal(first.chunks, 0);
  assert.equal(first.embedded, 100);
  assert.equal(first.reused, 0);
  assert.equal(first.embeddingChunksSpent, 100);
  assert.equal(first.pendingChunks, 184);
  assert.equal(state.token, null);
  assert.equal(state.published.length, 0);
  assert.equal(state.checkpoints.length, 100);
  const second = await run();
  assert.equal(second.partial, true);
  assert.equal(second.pendingChunks, 84);
  assert.equal(second.embedded, 100);
  assert.equal(state.published.length, 0);
  const third = await run();
  assert.equal(third.chunks, 284);
  assert.equal(third.embedded, 84);
  assert.equal(third.reused, 200);
  assert.equal(state.published.length, 284);
  assert.equal(state.checkpoints.length, 0);
  assert.equal(state.operations.filter((op) => op.name === 'publish_member_content_knowledge').length, 1);
  assert.ok(state.operations.filter((op) => op.table === 'member_content_chunk').every((op) => !op.updating));
});

test('75 chunks at budget20 resume without re-embedding the first batch', async () => {
  const { state, run } = fixture(75);
  for (const pendingChunks of [55, 35, 15]) {
    const result = await run(20);
    assert.equal(result.partial, true);
    assert.equal(result.pendingChunks, pendingChunks);
    assert.equal(result.embeddingChunksSpent, 20);
    assert.equal(state.published.length, 0);
  }
  const result = await run(20);
  assert.equal(result.embedded, 15);
  assert.equal(result.reused, 60);
  assert.equal(result.chunks, 75);
});

test('75-chunk page discovers saved progress when allowance increases from20 to100', async () => {
  const { run } = fixture(75);
  const first = await run(20);
  assert.equal(first.pendingChunks, 55);
  const result = await run(100, {
    embedTexts: async (_provider, inputs) => {
      assert.equal(inputs.length, 55);
      assert.ok(inputs.every((input) => !/\n\nCanonical block (?:[0-9]|1[0-9])$/.test(input)));
      return inputs.map(vector);
    },
  });
  assert.equal(result.chunks, 75);
  assert.equal(result.embedded, 55);
  assert.equal(result.reused, 20);
  assert.equal(result.embeddingChunksSpent, 55);
});

test('zero allowance reads durable work but spends nothing and releases claim', async () => {
  const { state, run } = fixture();
  await run();
  const result = await run(0, { openai: null, embedTexts: () => assert.fail('provider called') });
  assert.equal(result.partial, true);
  assert.equal(result.embeddingChunksSpent, 0);
  assert.equal(result.embedded, 0);
  assert.equal(result.pendingChunks, 184);
  assert.equal(state.token, null);
  assert.equal(state.published.length, 0);
});

test('canonical text/title/model changes cannot reuse mismatched checkpoints', async () => {
  for (const change of ['body', 'title', 'model']) {
    const { state, run } = fixture();
    await run();
    if (change === 'body') state.chunks[0].content = 'Changed text from fresh snapshot';
    if (change === 'title') state.title = 'Changed title';
    if (change === 'model') state.checkpoints.forEach((row) => { row.embedding_model = 'old-model'; });
    const inputs = [];
    const result = await run(100, {
      embedTexts: async (_provider, batch) => { inputs.push(...batch); return batch.map(vector); },
    });
    assert.equal(result.pendingChunks, change === 'body' ? 85 : 184);
    if (change === 'body') assert.match(inputs[0], /Changed text/);
    if (change === 'title') assert.ok(inputs.every((input) => input.startsWith('Changed title\n\n')));
  }
});

test('invalidation, deletion and access revocation never publish old private staging', async () => {
  for (const mode of ['edit', 'delete', 'revoke']) {
    const { state, run, invalidate } = fixture();
    await run();
    invalidate();
    assert.equal(state.checkpoints.length, 0);
    if (mode !== 'edit') state.missing = true; // fresh projection excludes non-indexable sources
    const result = await run();
    if (mode === 'edit') {
      assert.equal(result.embedded, 100);
      assert.equal(result.pendingChunks, 184);
    } else {
      assert.equal(result.removed, true);
      assert.equal(result.embeddingChunksSpent, 0);
      assert.equal(state.published.length, 0);
    }
  }
});

test('stale worker after provider call cannot save vectors or publish; budget is spent', async () => {
  for (const mode of ['invalidation', 'claim takeover']) {
    const { state, run, invalidate } = fixture();
    const budget = { maxEmbeddingChunks: 100 };
    await assert.rejects(run(100, {
      embeddingBudget: budget,
      embedTexts: async (_provider, inputs) => {
        assert.equal(budget.maxEmbeddingChunks, 0);
        if (mode === 'invalidation') invalidate();
        else state.token = 'new-worker';
        return inputs.map(vector);
      },
    }), (error) => /MEMBER_CONTENT_GENERATION_STALE/.test(error.message) &&
      error.embeddingChunksSpent === 100);
    assert.equal(state.published.length, 0);
    assert.equal(state.checkpoints.length, 0);
    if (mode === 'claim takeover') assert.equal(state.token, 'new-worker');
  }
});

test('stale snapshot worker cannot read checkpoints after a claim takeover', async () => {
  const { state, run } = fixture();
  await run();
  await assert.rejects(run(100, {
    buildSnapshot: async () => {
      state.token = 'replacement-claim';
      return {
        item, chunks: structuredClone(state.chunks),
        metadata: { title: item.title }, provenance: { kind: 'iedit' },
      };
    },
    embedTexts: () => assert.fail('stale reader called provider'),
  }), (error) => /MEMBER_CONTENT_GENERATION_STALE/.test(error.message) &&
    error.embeddingChunksSpent === 0);
  assert.equal(state.token, 'replacement-claim');
  assert.equal(state.published.length, 0);
});

test('completed batch survives failed publication and can publish on restart without provider spend', async () => {
  const { state, run } = fixture();
  await run();
  await run();
  const originalChunks = state.chunks;
  await assert.rejects(run(100, {
    // Simulate a failed CAS after valid checkpoint save.
    supabase: (() => {
      const token = 'last-claim';
      return {
        from(table) {
          const b = {
            select() { return b; }, update() { return b; }, eq() { return b; },
            then(resolve) { resolve({ data: [], error: null }); },
          };
          return b;
        },
        async rpc(name, args) {
          if (name === 'claim_member_content_generation') {
            state.token = token;
            return { data: [{ generation: 1, claim_token: token }], error: null };
          }
          if (name === 'read_member_content_embedding_checkpoints') return { data: state.checkpoints, error: null };
          if (name === 'save_member_content_embedding_checkpoints') {
            state.checkpoints.push(...args.p_rows);
            return { data: true, error: null };
          }
          return { data: false, error: null };
        },
      };
    })(),
  }), (error) => error.code === 'MEMBER_CONTENT_GENERATION_STALE' &&
    error.embeddingChunksSpent === 84);
  assert.equal(state.checkpoints.length, originalChunks.length);
  const resumed = await run(100, { embedTexts: () => assert.fail('completed vectors re-embedded') });
  assert.equal(resumed.chunks, 284);
  assert.equal(resumed.embeddingChunksSpent, 0);
  assert.equal(resumed.reused, 284);
});

test('provider failures and invalid vectors debit before calls, save no batch, release claims', async () => {
  const cases = [
    () => { throw new Error('provider failed'); },
    () => [],
    (_p, inputs) => inputs.map(() => [1, 2]),
    (_p, inputs) => inputs.map(() => Array(1536).fill(NaN)),
    (_p, inputs) => inputs.map(() => Array(1536).fill('0.1')),
  ];
  for (const embedTexts of cases) {
    const { state, run } = fixture();
    await run();
    const budget = { maxEmbeddingChunks: 100 };
    await assert.rejects(run(100, { embeddingBudget: budget, embedTexts }),
      (error) => error.embeddingChunksSpent === 100);
    assert.equal(budget.maxEmbeddingChunks, 0);
    assert.equal(state.checkpoints.length, 100); // prior valid batch survives
    assert.equal(state.token, null);
    assert.equal(state.published.length, 0);
  }
});

test('oversized resume discovers checkpoints even with allowance larger than remaining page', async () => {
  const { state, run } = fixture();
  await run();
  const result = await run(500);
  assert.equal(result.chunks, 284);
  assert.equal(result.embedded, 184);
  assert.equal(result.reused, 100);
  assert.ok(state.published.every((row) => row.embedding_model === EMBEDDING_MODEL));
});

test('checkpoint vector validator rejects non-finite, wrong-sized or non-numeric values', () => {
  assert.equal(validatedCheckpointVector(JSON.stringify(vector())), JSON.stringify(vector()));
  for (const value of [null, '[broken', [1], Array(1536).fill(Infinity), Array(1536).fill(null)]) {
    assert.throws(() => validatedCheckpointVector(value), /finite numeric dimensions/);
  }
});

test('additive migration is service RPC only, locks active claims, cleans on source transitions', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/202612310008_member_content_embedding_checkpoints.sql', import.meta.url), 'utf8');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);
  assert.doesNotMatch(sql, /GRANT[^;]*TO (?:PUBLIC|anon|authenticated)/i);
  assert.equal((sql.match(/FOR UPDATE;/g) || []).length, 2);
  assert.equal((sql.match(/s\.claim_token=p_claim_token/g) || []).length, 2);
  assert.equal((sql.match(/s\.generation=p_generation/g) || []).length, 2);
  assert.equal((sql.match(/interval '5 minutes'/g) || []).length, 2);
  assert.equal((sql.match(/ERRCODE='P0001'/g) || []).length, 2);
  assert.doesNotMatch(sql, /ERRCODE='40001'/);
  assert.match(sql, /ON DELETE CASCADE/);
  assert.match(sql, /AFTER UPDATE OF generation, active_generation/);
  assert.match(sql, /expires_at > now\(\)/);
  assert.match(sql, /vector\(1536\)/);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM) public\.member_content_chunk\b/i);
  assert.doesNotMatch(sql, /CREATE (?:OR REPLACE )?FUNCTION public\.publish_member_content/);
});

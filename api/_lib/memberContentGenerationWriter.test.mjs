import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chunkMemberContent } from './memberContentChunker.js';
import {
  writeMemberContentGeneration,
  reindexAllMemberContentGeneration,
  MEMBER_CONTENT_GENERATION_STALE,
  MEMBER_CONTENT_PROVENANCE_CONFLICT,
  MEMBER_CONTENT_UNSUPPORTED,
} from './memberContentGenerationWriter.js';
import { reindexAllMemberContent } from './memberContentIndexer.js';

function makeSupabase({
  source,
  canvasPage = null,
  registryRows = [],
  existing = [],
  claims = [{ generation: 1, claim_token: 'claim-1', already_active: false }],
  publish = true,
  onPublish = null,
  onRpc = null,
} = {}) {
  const operations = [];
  let claimIndex = 0;
  const sources = Array.isArray(source) ? source : source ? [source] : [];
  function builder(table) {
    const state = { table, op: 'select', filters: {} };
    const b = {
      select(columns) {
        state.op = 'select';
        state.columns = columns;
        return b;
      },
      update(patch) {
        state.op = 'update';
        state.patch = patch;
        return b;
      },
      eq(column, value) {
        state.filters[column] = value;
        return b;
      },
      in(column, values) {
        state.inFilter = { column, values };
        return b;
      },
      or(value) {
        state.or = value;
        return b;
      },
      order(column, options) {
        state.order = [column, options];
        return b;
      },
      limit(value) {
        state.limit = value;
        return b;
      },
      then(resolve, reject) {
        operations.push({ ...state, filters: { ...state.filters } });
        try {
          if (state.table === 'blog_post') {
            const rows = state.filters.id
              ? sources.filter((row) => row.id === state.filters.id)
              : sources;
            resolve({ data: rows, error: null });
            return;
          }
          if (state.table === 'i_edit_page') {
            resolve({ data: canvasPage ? [canvasPage] : [], error: null });
            return;
          }
          if (
            state.table === 'member_content_source' &&
            state.op === 'select'
          ) {
            const rows = registryRows.filter((row) =>
              Object.entries(state.filters).every(([key, value]) => row[key] === value) &&
              (!state.inFilter || state.inFilter.values.includes(row[state.inFilter.column]))
            );
            resolve({ data: rows, error: null });
            return;
          }
          if (state.table === 'member_content_chunk' && state.op === 'select') {
            resolve({ data: existing, error: null });
            return;
          }
          if (state.op === 'update') {
            resolve({ data: null, error: null });
            return;
          }
          resolve({ data: [], error: null });
        } catch (error) {
          reject(error);
        }
      },
    };
    return b;
  }
  return {
    operations,
    from: (table) => builder(table),
    rpc: async (name, args) => {
      operations.push({ rpc: name, args });
      if (
        name === 'publish_member_content_repair' &&
        args.p_tenant_id === null &&
        args.p_content_type === null &&
        args.p_source_id === null &&
        args.p_generation === null &&
        args.p_claim_token === null &&
        Array.isArray(args.p_rows) &&
        args.p_rows.length === 0
      ) {
        return { data: false, error: null };
      }
      if (name === 'claim_member_content_generation') {
        if (onRpc) return onRpc(name, args);
        const claim = claims[Math.min(claimIndex++, claims.length - 1)];
        return { data: [claim], error: null };
      }
      if (name === 'publish_member_content_repair') {
        if (onPublish) return onPublish(args);
        return { data: publish, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
}

const blog = (overrides = {}) => ({
  id: 'blog-1',
  tenant_id: 'tenant-1',
  title: 'Canonical title',
  slug: 'canonical-title',
  summary: 'Summary',
  content: 'Body',
  tags: ['one'],
  subcategories: ['news'],
  status: 'published',
  published_date: null,
  ...overrides,
});

test('generation writer publishes and repeats with a reused compatible vector', async () => {
  let rows = [];
  let embeddingCalls = 0;
  const supabase = makeSupabase({
    source: blog(),
    existing: () => rows,
    onPublish: (args) => {
      rows = args.p_rows;
      return { data: true, error: null };
    },
  });
  // The existing-row handler above is intentionally represented as a getter by
  // replacing the select result in this small mock after its construction.
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    const query = originalFrom(table);
    if (table !== 'member_content_chunk') return query;
    const originalThen = query.then;
    query.then = (resolve, reject) =>
      originalThen.call(query, (result) => resolve({ ...result, data: rows }), reject);
    return query;
  };
  const deps = {
    supabase,
    openai: {},
    embedTexts: async (_openai, inputs) => {
      embeddingCalls += 1;
      assert.equal(inputs.length, 1);
      return [[0.1, 0.2]];
    },
  };

  const first = await writeMemberContentGeneration('blog_post', blog(), deps);
  assert.equal(first.embedded, 1);
  assert.equal(first.reused, 0);
  assert.equal(embeddingCalls, 1);
  assert.equal(rows[0].access_scope, 'authenticated');
  assert.equal(rows[0].provenance.kind, 'authored_repair');
  assert.equal(rows[0].embedding, '[0.1,0.2]');

  const second = await writeMemberContentGeneration('blog_post', blog(), deps);
  assert.equal(second.embedded, 0);
  assert.equal(second.reused, 1);
  assert.equal(embeddingCalls, 1);
});

test('legacy body-only hashes upgrade in place without an embedding request', async () => {
  const canonical = blog();
  const legacyContent = chunkMemberContent(canonical, 'blog_post')[0].content;
  const legacyHash = crypto
    .createHash('sha256')
    .update(legacyContent)
    .digest('hex');
  const supabase = makeSupabase({
    source: canonical,
    existing: [
      {
        chunk_index: 0,
        title: canonical.title,
        content_hash: legacyHash,
        embedding: [0.9, 0.8],
        embedding_model: null,
        provenance: {},
      },
    ],
  });
  let embeddingCalls = 0;
  const summary = await writeMemberContentGeneration('blog_post', canonical, {
    supabase,
    openai: {},
    embedTexts: async () => {
      embeddingCalls += 1;
      return [[0]];
    },
  });
  assert.equal(summary.embedded, 0);
  assert.equal(summary.reused, 1);
  assert.equal(embeddingCalls, 0);
  const published = supabase.operations.find(
    (operation) =>
      operation.rpc === 'publish_member_content_repair' &&
      operation.args.p_generation != null
  );
  assert.notEqual(published.args.p_rows[0].content_hash, legacyHash);
  assert.equal(published.args.p_rows[0].embedding, '[0.9,0.8]');
});

test('legacy body-only embedding is not reused after a title change', async () => {
  const previous = blog();
  const legacyContent = chunkMemberContent(previous, 'blog_post')[0].content;
  const legacyHash = crypto
    .createHash('sha256')
    .update(legacyContent)
    .digest('hex');
  const current = blog({ title: 'Changed title' });
  const supabase = makeSupabase({
    source: current,
    existing: [
      {
        chunk_index: 0,
        title: previous.title,
        content_hash: legacyHash,
        embedding: [0.9, 0.8],
        embedding_model: null,
        provenance: {},
      },
    ],
  });
  let embeddingCalls = 0;
  const summary = await writeMemberContentGeneration('blog_post', current, {
    supabase,
    openai: {},
    embedTexts: async () => {
      embeddingCalls += 1;
      return [[0.1, 0.2]];
    },
  });
  assert.equal(summary.embedded, 1);
  assert.equal(summary.reused, 0);
  assert.equal(embeddingCalls, 1);
});

test('bulk honors the top-level zero embedding budget and carries its cursor', async () => {
  const supabase = makeSupabase({ source: blog() });
  let embeddingCalls = 0;
  const result = await reindexAllMemberContentGeneration({
    supabase,
    contentType: 'blog_post',
    openai: {},
    maxEmbeddingChunks: 0,
    embedTexts: async () => {
      embeddingCalls += 1;
      return [[1]];
    },
  });
  assert.equal(embeddingCalls, 0);
  assert.equal(result.done, false);
  assert.deepEqual(result.nextCursor, { type: 'blog_post', lastId: null });
  assert.equal(result.stopReason, 'embedding_budget');
  assert.equal(result.errorCode, 'MEMBER_CONTENT_EMBEDDING_BUDGET');
  assert.equal(result.errors, 1);
  assert.equal(result.details[0].code, 'MEMBER_CONTENT_EMBEDDING_BUDGET');
  assert.equal(result.embeddingChunksSpent, 0);
});

test('bulk reports provider-spent chunks after publication failure', async () => {
  const supabase = makeSupabase({
    source: [blog(), blog({ id: 'blog-2', slug: 'second-title' })],
    onPublish: () => ({ data: null, error: new Error('publish failed') }),
  });
  const result = await reindexAllMemberContentGeneration({
    supabase,
    contentType: 'blog_post',
    openai: {},
    maxEmbeddingChunks: 1,
    embedTexts: async () => [[1]],
  });
  assert.equal(result.embedded, 0);
  assert.equal(result.embeddingChunksSpent, 1);
  assert.equal(result.stopReason, 'embedding_budget');
  assert.equal(result.errorCode, 'MEMBER_CONTENT_EMBEDDING_BUDGET');
  assert.deepEqual(result.nextCursor, { type: 'blog_post', lastId: 'blog-1' });
});

test('indexer dispatcher preserves numeric zero embeddingBudget without a provider', async () => {
  const result = await reindexAllMemberContent({
    supabase: makeSupabase({ source: blog() }),
    contentType: 'blog_post',
    embeddingBudget: 0,
  });
  assert.equal(result.done, false);
  assert.equal(result.stopReason, 'embedding_budget');
  assert.equal(result.errorCode, 'MEMBER_CONTENT_EMBEDDING_BUDGET');
  assert.equal(result.errors, 1);
});

test('default bulk types continue through Canvas without synthetic errors', async () => {
  const supabase = makeSupabase({ source: blog() });
  const result = await reindexAllMemberContentGeneration({
    supabase,
    openai: {},
    embedTexts: async () => [[1]],
  });
  assert.equal(result.done, true);
  assert.equal(
    result.details.some((detail) => detail.contentType === 'canvas_page'),
    false
  );
});

test('Canvas generation publishes the guest projection and dependency provenance', async () => {
  let publishedRows = null;
  const supabase = makeSupabase({
    canvasPage: {
      id: 'page-1',
      tenant_id: 'tenant-1',
      title: 'Canvas title',
      slug: 'canvas-title',
      status: 'published',
      builder_type: 'canvas',
      layout_type: 'public',
      microsite_id: null,
      updated_at: '2026-01-02T03:04:05.000Z',
      canvas_design: {
        root: {
          sections: [{
            children: [{
              type: 'text',
              content: { text: 'Guest-visible canvas text' },
            }],
          }],
        },
      },
    },
    onPublish: (args) => {
      publishedRows = args.p_rows;
      return { data: true, error: null };
    },
  });
  const result = await writeMemberContentGeneration(
    'canvas_page',
    { id: 'page-1', tenant_id: 'tenant-1' },
    { supabase, openai: {}, embedTexts: async () => [[1]] }
  );
  assert.equal(result.chunks, 1);
  assert.equal(result.embedded, 1);
  assert.match(publishedRows[0].content, /Guest-visible canvas text/);
  assert.equal(publishedRows[0].access_scope, 'public');
  assert.deepEqual(publishedRows[0].provenance.dependencies, []);
});

test('generation bulk runs the bounded tombstone phase after source indexing', async () => {
  const supabase = makeSupabase({
    source: blog(),
    registryRows: [{
      tenant_id: 'tenant-1',
      content_type: 'blog_post',
      source_id: 'deleted-blog',
    }],
  });
  const result = await reindexAllMemberContentGeneration({
    supabase,
    contentType: 'blog_post',
    openai: {},
    embedTexts: async () => [[1]],
  });
  assert.equal(result.done, true);
  assert.equal(result.orphanSweep.done, true);
  assert.equal(result.removed, 1);
  assert.equal(result.errors, 0);
});

test('generation bulk indexes Canvas pages through the adapter', async () => {
  const supabase = makeSupabase({
    canvasPage: {
      id: 'page-1',
      tenant_id: 'tenant-1',
      title: 'Bulk Canvas',
      slug: 'bulk-canvas',
      status: 'published',
      builder_type: 'canvas',
      layout_type: 'public',
      canvas_design: {
        root: {
          sections: [{
            children: [{
              type: 'text',
              content: { text: 'Bulk canvas text' },
            }],
          }],
        },
      },
    },
  });
  const result = await reindexAllMemberContentGeneration({
    supabase,
    contentType: 'canvas_page',
    openai: {},
    embedTexts: async () => [[1]],
  });
  assert.equal(result.done, true);
  assert.equal(result.items, 1);
  assert.equal(result.embedded, 1);
  assert.equal(result.errors, 0);
});

test('generation tombstone phase carries a resumable composite cursor', async () => {
  const registryRows = [
    { tenant_id: 'tenant-1', content_type: 'blog_post', source_id: 'gone-1' },
    { tenant_id: 'tenant-1', content_type: 'blog_post', source_id: 'gone-2' },
  ];
  const first = await reindexAllMemberContentGeneration({
    supabase: makeSupabase({ source: blog(), registryRows }),
    contentType: 'blog_post',
    maxItems: 2,
    openai: {},
    embedTexts: async () => [[1]],
  });
  assert.equal(first.done, false);
  assert.deepEqual(first.nextCursor, {
    phase: 'sweep',
    tenantId: 'tenant-1',
    contentType: 'blog_post',
    sourceId: 'gone-1',
  });

  const second = await reindexAllMemberContentGeneration({
    supabase: makeSupabase({ source: blog(), registryRows }),
    contentType: 'blog_post',
    cursor: first.nextCursor,
    openai: {},
    embedTexts: async () => [[1]],
  });
  assert.equal(second.done, true);
  assert.equal(second.orphanSweep.done, true);
});

test('Canvas tombstones use the generation publisher for missing pages', async () => {
  const result = await reindexAllMemberContentGeneration({
    supabase: makeSupabase({
      registryRows: [{
        tenant_id: 'tenant-1',
        content_type: 'canvas_page',
        source_id: 'deleted-page',
      }],
    }),
    contentType: 'canvas_page',
    openai: {},
  });
  assert.equal(result.done, true);
  assert.equal(result.removed, 1);
  assert.equal(result.errors, 0);
});

test('bulk rejects invalid budgets, item limits, and deadlines', async () => {
  const invalidOptions = [
    { maxEmbeddingChunks: Number.NaN },
    { maxEmbeddingChunks: Number.POSITIVE_INFINITY },
    { maxEmbeddingChunks: -1 },
    { maxEmbeddingChunks: 1.5 },
    { embeddingBudget: 1 },
    { maxItems: 0 },
    { maxItems: 501 },
    { deadlineMs: Number.NaN },
    { deadlineMs: 0 },
  ];
  for (const options of invalidOptions) {
    await assert.rejects(
      () =>
        reindexAllMemberContentGeneration({
          supabase: makeSupabase({ source: blog() }),
          ...options,
        }),
      (error) => error.code === 'MEMBER_CONTENT_INVALID_OPTIONS'
    );
  }
});

test('claim precedes canonical reread and stale caller content is not embedded', async () => {
  const supabase = makeSupabase({ source: blog({ title: 'Fresh title' }) });
  const embeddedInputs = [];
  await writeMemberContentGeneration(
    'blog_post',
    blog({ title: 'Stale caller title', content: 'Stale body' }),
    {
      supabase,
      openai: {},
      embedTexts: async (_openai, inputs) => {
        embeddedInputs.push(...inputs);
        return [[1]];
      },
    }
  );
  const claimIndex = supabase.operations.findIndex(
    (operation) => operation.rpc === 'claim_member_content_generation'
  );
  const sourceIndex = supabase.operations.findIndex(
    (operation) => operation.table === 'blog_post'
  );
  assert.ok(claimIndex >= 0);
  assert.ok(sourceIndex > claimIndex);
  assert.match(embeddedInputs[0], /^Fresh title\n\n/);
  assert.doesNotMatch(embeddedInputs[0], /Stale caller title/);
});

test('claim, source reread, publish, and release are tenant scoped', async () => {
  const supabase = makeSupabase({ source: blog() });
  await writeMemberContentGeneration('blog_post', blog(), {
    supabase,
    openai: {},
    embedTexts: async () => [[1]],
  });
  const claim = supabase.operations.find(
    (operation) => operation.rpc === 'claim_member_content_generation'
  );
  assert.equal(claim.args.p_tenant_id, 'tenant-1');
  const source = supabase.operations.find(
    (operation) => operation.table === 'blog_post'
  );
  assert.equal(source.filters.tenant_id, 'tenant-1');
  const existing = supabase.operations.find(
    (operation) => operation.table === 'member_content_chunk'
  );
  assert.equal(existing.filters.tenant_id, 'tenant-1');
  const publish = supabase.operations.find(
    (operation) =>
      operation.rpc === 'publish_member_content_repair' &&
      operation.args.p_generation != null
  );
  assert.equal(publish.args.p_tenant_id, 'tenant-1');
});

test('stale publish never falls back to direct chunk mutation', async () => {
  const supabase = makeSupabase({ source: blog(), publish: false });
  await assert.rejects(
    () =>
      writeMemberContentGeneration('blog_post', blog(), {
        supabase,
        openai: {},
        embedTexts: async () => [[1]],
      }),
    (error) => error.code === MEMBER_CONTENT_GENERATION_STALE
  );
  assert.equal(
    supabase.operations.some(
      (operation) =>
        operation.table === 'member_content_chunk' &&
        (operation.op === 'update' || operation.op === 'delete' || operation.op === 'upsert')
    ),
    false
  );
  const release = supabase.operations.find(
    (operation) =>
      operation.table === 'member_content_source' && operation.op === 'update'
  );
  assert.equal(release.filters.tenant_id, 'tenant-1');
  assert.equal(release.filters.content_type, 'blog_post');
  assert.equal(release.filters.source_id, 'blog-1');
  assert.equal(release.filters.generation, 1);
  assert.equal(release.filters.claim_token, 'claim-1');
  assert.deepEqual(release.patch, {
    claim_token: null,
    claim_started_at: null,
  });
});

test('embedding and publish errors release only the matching claim', async () => {
  for (const mode of ['embedding', 'publish']) {
    const supabase = makeSupabase({
      source: blog(),
      onPublish: () =>
        mode === 'publish'
          ? { data: null, error: new Error('rpc failed') }
          : { data: true, error: null },
    });
    await assert.rejects(() =>
      writeMemberContentGeneration('blog_post', blog(), {
        supabase,
        openai: {},
        embedTexts: async () => {
          if (mode === 'embedding') throw new Error('embedding failed');
          return [[1]];
        },
      })
    );
    assert.ok(
      supabase.operations.some(
        (operation) =>
          operation.table === 'member_content_source' &&
          operation.op === 'update' &&
          operation.filters.tenant_id === 'tenant-1' &&
          operation.filters.content_type === 'blog_post' &&
          operation.filters.source_id === 'blog-1' &&
          operation.filters.generation === 1 &&
          operation.filters.claim_token === 'claim-1'
      )
    );
  }
});

test('missing publisher RPC fails readiness before claim or provider spend', async () => {
  const supabase = makeSupabase({ source: blog() });
  const normalRpc = supabase.rpc;
  supabase.rpc = async (name, args) => {
    if (
      name === 'publish_member_content_repair' &&
      args.p_tenant_id === null
    ) {
      supabase.operations.push({ rpc: name, args });
      return {
        data: null,
        error: { code: 'PGRST202', detail: 'function does not exist' },
      };
    }
    return normalRpc(name, args);
  };
  let embeddingCalls = 0;
  await assert.rejects(
    () =>
      writeMemberContentGeneration('blog_post', blog(), {
        supabase,
        openai: {},
        embedTexts: async () => {
          embeddingCalls += 1;
          return [[1]];
        },
      }),
    (error) => error.code === 'PGRST202'
  );
  assert.equal(embeddingCalls, 0);
  assert.equal(
    supabase.operations.some(
      (operation) => operation.rpc === 'claim_member_content_generation'
    ),
    false
  );
  assert.equal(
    supabase.operations.some((operation) => operation.table === 'blog_post'),
    false
  );
});

test('unsupported provenance, event-linked resources, and Canvas fail without publication', async () => {
  const badExisting = makeSupabase({
    source: blog(),
    existing: [{ chunk_index: 0, provenance: { kind: 'pdf' } }],
  });
  await assert.rejects(
    () =>
      writeMemberContentGeneration('blog_post', blog(), {
        supabase: badExisting,
      }),
    (error) => error.code === MEMBER_CONTENT_PROVENANCE_CONFLICT
  );
  assert.equal(
    badExisting.operations.some(
      (operation) =>
        operation.rpc === 'publish_member_content_repair' &&
        operation.args.p_generation != null
    ),
    false
  );

  const linked = makeSupabase({
    source: {
      ...blog(),
      // The blog mock table is sufficient to exercise the canonical guard.
      linked_events: [{ event_id: 'event-1' }],
    },
  });
  await assert.rejects(
    () =>
      writeMemberContentGeneration('blog_post', blog(), {
        supabase: linked,
      }),
    (error) => error.code === MEMBER_CONTENT_UNSUPPORTED
  );
  const canvas = makeSupabase();
  const missingCanvas = await writeMemberContentGeneration(
    'canvas_page',
    { id: 'page-1', tenant_id: 'tenant-1' },
    { supabase: canvas }
  );
  assert.equal(missingCanvas.removed, true);
  const emptyPublish = canvas.operations.find(
    (operation) =>
      operation.rpc === 'publish_member_content_repair' &&
      operation.args.p_generation != null
  );
  assert.deepEqual(emptyPublish.args.p_rows, []);
});

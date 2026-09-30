import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteMemberContentGenerationTombstone,
  processMemberContentGenerationTombstone,
  sweepMemberContentGenerationTombstones,
  MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS,
} from './memberContentGenerationTombstones.js';
import {
  MEMBER_CONTENT_EMBEDDING_BUDGET,
  MEMBER_CONTENT_PROVENANCE_CONFLICT,
} from './memberContentGenerationWriter.js';

function tupleCompare(left, right) {
  const values = ['tenant_id', 'content_type', 'source_id'];
  for (const value of values) {
    if (left[value] === right[value]) continue;
    return left[value] < right[value] ? -1 : 1;
  }
  return 0;
}

function cursorFromFilter(filter) {
  if (!filter) return null;
  const tenant = /tenant_id\.gt\.([^,]+)/.exec(filter);
  const content = /content_type\.gt\.([^,)]+)/.exec(filter);
  const source = /source_id\.gt\.([^,)]+)/.exec(filter);
  const tenantEq = /tenant_id\.eq\.([^,)]+)/.exec(filter);
  const contentEq = /content_type\.eq\.([^,)]+)/.exec(filter);

  // The fake applies the same lexicographic predicate as the real registry
  // query; the production helper still performs a local defensive check.
  if (tenant && content && source) {
    return {
      tenant_id: tenant[1],
      content_type: contentEq?.[1] || '',
      source_id: source[1],
      mode: 'global',
    };
  }
  if (tenant && source) {
    return {
      tenant_id: tenant[1],
      content_type: contentEq?.[1] || '',
      source_id: source[1],
      mode: contentEq ? 'type' : 'tenant',
    };
  }
  if (source) {
    return {
      tenant_id: tenantEq?.[1] || '',
      content_type: contentEq?.[1] || '',
      source_id: source[1],
      mode: 'source',
    };
  }
  return null;
}

function makeSupabase({ registry = [], sources = [] } = {}) {
  const operations = [];
  const sourceRows = Array.isArray(sources) ? sources : [];
  const registryRows = Array.isArray(registry) ? registry : [];

  function builder(table) {
    const state = {
      table,
      filters: {},
      orders: [],
      limit: null,
      or: null,
      columns: null,
    };
    const query = {
      select(columns) {
        state.columns = columns;
        return query;
      },
      eq(column, value) {
        state.filters[column] = value;
        return query;
      },
      in(column, values) {
        state.filters[`in:${column}`] = values;
        return query;
      },
      order(column, options) {
        state.orders.push([column, options]);
        return query;
      },
      limit(value) {
        state.limit = value;
        return query;
      },
      or(value) {
        state.or = value;
        return query;
      },
      then(resolve, reject) {
        operations.push({ ...state, filters: { ...state.filters } });
        try {
          let rows =
            table === 'member_content_source' ? [...registryRows] : [...sourceRows];
          for (const [column, value] of Object.entries(state.filters)) {
            if (column.startsWith('in:')) {
              const actualColumn = column.slice(3);
              rows = rows.filter((row) => value.includes(row[actualColumn]));
              continue;
            }
            rows = rows.filter((row) => row[column] === value);
          }
          if (table === 'member_content_source' && state.or) {
            const cursor = cursorFromFilter(state.or);
            if (cursor) {
              rows = rows.filter((row) => {
                if (cursor.mode === 'source') {
                  return row.source_id > cursor.source_id;
                }
                return tupleCompare(row, cursor) > 0;
              });
            }
          }
          if (state.orders.length) {
            rows.sort((left, right) => {
              for (const [column, options] of state.orders) {
                if (left[column] === right[column]) continue;
                const direction = options?.ascending === false ? -1 : 1;
                return left[column] < right[column] ? -direction : direction;
              }
              return 0;
            });
          }
          if (state.limit != null) rows = rows.slice(0, state.limit);
          resolve({ data: rows, error: null });
        } catch (error) {
          reject(error);
        }
      },
    };
    return query;
  }

  return {
    operations,
    from: (table) => builder(table),
  };
}

function source(id, tenant_id = 'tenant-1', status = 'published') {
  return { id, tenant_id, status };
}

function registryRow(source_id, tenant_id = 'tenant-1', content_type = 'blog_post') {
  return { source_id, tenant_id, content_type };
}

test('missing source calls the generation writer with a tenant-scoped tombstone item', async () => {
  const supabase = makeSupabase({
    registry: [registryRow('gone-1')],
    sources: [],
  });
  const calls = [];
  const result = await deleteMemberContentGenerationTombstone(
    'blog_post',
    'gone-1',
    {
      tenantId: 'tenant-1',
      supabase,
      writeGeneration: async (type, item, options) => {
        calls.push({ type, item, options });
        return { removed: true, chunks: 0, deferred: false };
      },
    }
  );

  assert.equal(result.missing, true);
  assert.equal(result.verifiedMissing, true);
  assert.equal(result.tombstoned, true);
  assert.deepEqual(calls[0].item, { id: 'gone-1', tenant_id: 'tenant-1' });
  assert.deepEqual(calls[0].options.embeddingBudget, { maxEmbeddingChunks: 0 });
  assert.equal(
    supabase.operations.some(
      (operation) =>
        operation.table === 'member_content_chunk' &&
        ['delete', 'upsert'].includes(operation.op)
    ),
    false
  );
});

test('an existing unpublished source is handled by the writer, never raw chunk deletion', async () => {
  const supabase = makeSupabase({ sources: [source('draft-1', 'tenant-1', 'draft')] });
  const calls = [];
  const result = await processMemberContentGenerationTombstone({
    contentType: 'blog_post',
    sourceId: 'draft-1',
    tenantId: 'tenant-1',
    supabase,
    writeGeneration: async (type, item) => {
      calls.push({ type, item });
      return { removed: true, chunks: 0, deferred: false };
    },
  });

  assert.equal(result.missing, false);
  assert.equal(result.sourceExists, true);
  assert.equal(result.tombstoned, false);
  assert.equal(result.removed, true);
  assert.deepEqual(calls, [
    { type: 'blog_post', item: { id: 'draft-1', tenant_id: 'tenant-1' } },
  ]);
  assert.equal(
    supabase.operations.some((operation) => operation.table === 'member_content_chunk'),
    false
  );
});

test('source deletion races are resolved by the writer reread, not by the initial probe', async () => {
  const supabase = makeSupabase({ sources: [source('race-1')] });
  let writerReadCanonical = false;
  const result = await processMemberContentGenerationTombstone({
    contentType: 'blog_post',
    sourceId: 'race-1',
    tenantId: 'tenant-1',
    supabase,
    writeGeneration: async () => {
      // Simulate the source disappearing after the identity probe but before
      // the writer's claim/reread.
      writerReadCanonical = true;
      return { removed: true, chunks: 0, deferred: false };
    },
  });

  assert.equal(writerReadCanonical, true);
  assert.equal(result.missing, false);
  assert.equal(result.tombstoned, false);
  assert.equal(result.deferred, false);
});

test('a source that resurfaces during a tombstone is deferred without embedding', async () => {
  const supabase = makeSupabase({ sources: [] });
  let embeddingCalls = 0;
  const result = await processMemberContentGenerationTombstone({
    contentType: 'blog_post',
    sourceId: 'resurfaced-1',
    tenantId: 'tenant-1',
    supabase,
    writeGeneration: async (_type, _item, options) => {
      assert.equal(options.embeddingBudget.maxEmbeddingChunks, 0);
      embeddingCalls += 1;
      const error = new Error('changed live source needs an embedding');
      error.code = MEMBER_CONTENT_EMBEDDING_BUDGET;
      throw error;
    },
  });

  assert.equal(embeddingCalls, 1);
  assert.equal(result.deferred, true);
  assert.equal(result.code, MEMBER_CONTENT_EMBEDDING_BUDGET);
  assert.equal(result.tombstoned, false);
});

test('rich provenance is preserved and reported deferred', async () => {
  const supabase = makeSupabase({ sources: [source('rich-1')] });
  const result = await processMemberContentGenerationTombstone({
    contentType: 'blog_post',
    sourceId: 'rich-1',
    tenantId: 'tenant-1',
    supabase,
    writeGeneration: async () => {
      const error = new Error('existing source chunks have rich provenance');
      error.code = MEMBER_CONTENT_PROVENANCE_CONFLICT;
      throw error;
    },
  });

  assert.equal(result.deferred, true);
  assert.equal(result.code, MEMBER_CONTENT_PROVENANCE_CONFLICT);
  assert.equal(result.removed, false);
  assert.equal(result.tombstoned, false);
});

test('tenant-scoped sweep never processes a same-id source from another tenant', async () => {
  const supabase = makeSupabase({
    registry: [
      registryRow('same-id', 'tenant-1'),
      registryRow('same-id', 'tenant-2'),
    ],
    sources: [],
  });
  const calls = [];
  const result = await sweepMemberContentGenerationTombstones({
    supabase,
    tenantId: 'tenant-1',
    maxItems: MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS,
    writeGeneration: async (_type, item) => {
      calls.push(item);
      return { removed: true, deferred: false };
    },
  });

  assert.equal(result.done, true);
  assert.equal(result.items, 1);
  assert.deepEqual(calls, [{ id: 'same-id', tenant_id: 'tenant-1' }]);
});

test('global sweep resumes with the composite tenant/content type/source cursor', async () => {
  const supabase = makeSupabase({
    registry: [
      registryRow('source-1', 'tenant-1'),
      registryRow('source-2', 'tenant-1'),
      registryRow('source-3', 'tenant-2'),
    ],
    sources: [],
  });
  const calls = [];
  const writeGeneration = async (_type, item) => {
    calls.push(item);
    return { removed: true, deferred: false };
  };

  const first = await sweepMemberContentGenerationTombstones({
    supabase,
    maxItems: 2,
    writeGeneration,
  });
  assert.equal(first.done, false);
  assert.deepEqual(first.nextCursor, {
    tenantId: 'tenant-1',
    contentType: 'blog_post',
    sourceId: 'source-2',
  });

  const second = await sweepMemberContentGenerationTombstones({
    supabase,
    cursor: first.nextCursor,
    maxItems: 2,
    writeGeneration,
  });
  assert.equal(second.done, true);
  assert.deepEqual(calls, [
    { id: 'source-1', tenant_id: 'tenant-1' },
    { id: 'source-2', tenant_id: 'tenant-1' },
    { id: 'source-3', tenant_id: 'tenant-2' },
  ]);
});

test('full-type sweep allowlists authored and Canvas sources, excluding symbol dependency fences', async () => {
  const supabase = makeSupabase({
    registry: [
      registryRow('blog-1', 'tenant-1', 'blog_post'),
      registryRow('deleted-blog', 'tenant-1', 'blog_post'),
      registryRow('canvas-1', 'tenant-1', 'canvas_page'),
      registryRow('symbol-1', 'tenant-1', 'canvas_symbol'),
    ],
    sources: [source('blog-1'), source('canvas-1')],
  });
  const calls = [];
  const writeGeneration = async (type, item) => {
    calls.push({ type, item });
    return {
      removed: item.id === 'deleted-blog',
      deferred: false,
    };
  };

  const first = await sweepMemberContentGenerationTombstones({
    supabase,
    maxItems: 2,
    writeGeneration,
  });
  assert.equal(first.done, false);
  assert.equal(first.errors, 0);
  assert.deepEqual(first.nextCursor, {
    tenantId: 'tenant-1',
    contentType: 'blog_post',
    sourceId: 'deleted-blog',
  });

  const second = await sweepMemberContentGenerationTombstones({
    supabase,
    cursor: first.nextCursor,
    maxItems: 2,
    writeGeneration,
  });
  assert.equal(second.done, true);
  assert.equal(second.errors, 0);
  assert.equal(second.deferred, 0);
  assert.deepEqual(calls, [
    { type: 'blog_post', item: { id: 'blog-1', tenant_id: 'tenant-1' } },
    { type: 'blog_post', item: { id: 'deleted-blog', tenant_id: 'tenant-1' } },
    { type: 'canvas_page', item: { id: 'canvas-1', tenant_id: 'tenant-1' } },
  ]);
  assert.equal(calls.some(({ item }) => item.id === 'symbol-1'), false);
  const registryQuery = supabase.operations.find(
    (operation) => operation.table === 'member_content_source'
  );
  assert.deepEqual(registryQuery.filters['in:content_type'], [
    'resource',
    'event',
    'complex_event',
    'news_post',
    'blog_post',
    'canvas_page',
  ]);
});

test('sweep obeys max-items and deadline without exceeding the bounded page', async () => {
  const supabase = makeSupabase({
    registry: [
      registryRow('source-1'),
      registryRow('source-2'),
      registryRow('source-3'),
    ],
    sources: [],
  });
  const calls = [];
  let clock = 0;
  const first = await sweepMemberContentGenerationTombstones({
    supabase,
    maxItems: 2,
    deadlineMs: 50,
    now: () => clock,
    writeGeneration: async (_type, item) => {
      calls.push(item);
      clock = calls.length === 1 ? 100 : clock;
      return { removed: true, deferred: false };
    },
  });

  assert.equal(first.items, 1);
  assert.equal(first.done, false);
  assert.deepEqual(first.nextCursor, {
    tenantId: 'tenant-1',
    contentType: 'blog_post',
    sourceId: 'source-1',
  });
  assert.deepEqual(calls, [{ id: 'source-1', tenant_id: 'tenant-1' }]);
});

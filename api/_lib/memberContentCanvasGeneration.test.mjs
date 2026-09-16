import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanvasGenerationProjection,
  buildCanvasGenerationSnapshot,
  MEMBER_CONTENT_CANVAS_CLAIM_REQUIRED,
  MEMBER_CONTENT_CANVAS_DEPENDENCY_UNAVAILABLE,
  isPublicCanvasPage,
} from './memberContentCanvasGeneration.js';

function makeQueryMock({
  page,
  microsite = null,
  symbols = [],
  generations = [],
} = {}) {
  const operations = [];
  const supabase = {
    from(table) {
      const state = {
        table,
        filters: {},
        inFilters: {},
        selected: null,
      };
      const builder = {
        select(columns) {
          state.selected = columns;
          return builder;
        },
        eq(column, value) {
          state.filters[column] = value;
          return builder;
        },
        in(column, values) {
          state.inFilters[column] = values;
          return builder;
        },
        limit(value) {
          state.limit = value;
          return builder;
        },
        then(resolve, reject) {
          operations.push({
            table: state.table,
            selected: state.selected,
            filters: { ...state.filters },
            inFilters: { ...state.inFilters },
          });
          try {
            if (state.table === 'i_edit_page') {
              resolve({ data: page ? [page] : [], error: null });
            } else if (state.table === 'microsite') {
              resolve({ data: microsite ? [microsite] : [], error: null });
            } else if (state.table === 'canvas_symbol') {
              const ids = state.inFilters.id || [];
              resolve({
                data: symbols.filter((row) => ids.includes(row.id)),
                error: null,
              });
            } else if (state.table === 'member_content_source') {
              const ids = state.inFilters.source_id || [];
              resolve({
                data: generations.filter((row) => ids.includes(row.source_id)),
                error: null,
              });
            } else {
              resolve({ data: [], error: null });
            }
          } catch (error) {
            reject(error);
          }
        },
      };
      return builder;
    },
  };
  return { supabase, operations };
}

function page(overrides = {}) {
  return {
    id: 'page-1',
    tenant_id: 'tenant-1',
    title: 'Public Canvas page',
    slug: 'public-canvas',
    status: 'published',
    builder_type: 'canvas',
    layout_type: 'hybrid',
    microsite_id: null,
    updated_at: '2026-01-02T03:04:05.000Z',
    canvas_design: {
      root: {
        sections: [{
          children: [
            {
              type: 'text',
              content: { text: '<p>Public editorial text</p>' },
            },
            {
              type: 'custom-html',
              content: {
                memberOnly: true,
                html: '<p>member secret must not be indexed</p>',
                guestMessage: 'Sign in',
              },
            },
            {
              type: 'symbol',
              content: { symbolId: 'symbol-1' },
            },
          ],
        }],
      },
    },
    ...overrides,
  };
}

function symbol(overrides = {}) {
  return {
    id: 'symbol-1',
    tenant_id: 'tenant-1',
    updated_at: '2026-01-03T03:04:05.000Z',
    design: {
      root: {
        sections: [{
          children: [
            {
              type: 'text',
              content: { text: 'Public symbol text' },
            },
            {
              type: 'custom-html',
              content: {
                memberOnly: true,
                html: '<p>symbol member secret</p>',
              },
            },
          ],
        }],
      },
    },
    ...overrides,
  };
}

test('Canvas public-layout allowlist rejects member and unknown layouts', () => {
  assert.equal(isPublicCanvasPage(page({ layout_type: 'public' })), true);
  assert.equal(isPublicCanvasPage(page({ layout_type: 'hybrid' })), true);
  assert.equal(isPublicCanvasPage(page({ layout_type: 'member' })), false);
  assert.equal(isPublicCanvasPage(page({ layout_type: 'unknown' })), false);
  assert.equal(isPublicCanvasPage(page({ status: 'draft' })), false);
  assert.equal(isPublicCanvasPage(page({ builder_type: 'legacy' })), false);
});

test('pure Canvas projection removes member-only HTML before extraction', () => {
  const result = buildCanvasGenerationProjection({
    page: page(),
    symbols: [symbol()],
    dependencies: [{
      contentType: 'canvas_symbol',
      sourceId: 'symbol-1',
      generation: 4,
    }],
    symbolVersions: {
      'symbol-1': {
        updated_at: '2026-01-03T03:04:05.000Z',
        generation: 4,
      },
    },
    generation: 9,
    micrositePrefix: 'members',
  });

  assert.equal(result.indexable, true);
  assert.equal(result.metadata.layout_type, 'hybrid');
  assert.equal(result.metadata.microsite_id, null);
  assert.equal(result.metadata.source_updated_at, '2026-01-02T03:04:05.000Z');
  assert.equal(result.link, '/members/public-canvas');
  assert.deepEqual(result.provenance.dependencies, [{
    contentType: 'canvas_symbol',
    sourceId: 'symbol-1',
    generation: 4,
  }]);
  assert.equal(result.provenance.generation, 9);
  assert.equal(result.chunks.length, 1);
  assert.match(result.chunks[0].content, /Public editorial text/);
  assert.match(result.chunks[0].content, /Public symbol text/);
  assert.doesNotMatch(result.chunks[0].content, /member secret/);
  assert.doesNotMatch(result.chunks[0].content, /symbol member secret/);
});

test('snapshot rereads canonical page and fences referenced symbols by tenant generation', async () => {
  const { supabase, operations } = makeQueryMock({
    page: page({ microsite_id: 'microsite-1' }),
    microsite: {
      id: 'microsite-1',
      tenant_id: 'tenant-1',
      path_prefix: 'members',
      is_active: true,
    },
    symbols: [symbol()],
    generations: [{
      source_id: 'symbol-1',
      tenant_id: 'tenant-1',
      active_generation: '4',
    }],
  });

  const result = await buildCanvasGenerationSnapshot({
    supabase,
    tenantId: 'tenant-1',
    sourceId: 'page-1',
    claim: { generation: '9', claim_token: 'claim-token' },
  });

  assert.equal(result.indexable, true);
  assert.equal(result.link, '/members/public-canvas');
  assert.equal(result.layout_type, 'hybrid');
  assert.equal(result.microsite_id, 'microsite-1');
  assert.equal(result.source_updated_at, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(result.symbol_versions, {
    'symbol-1': {
      updated_at: '2026-01-03T03:04:05.000Z',
      generation: 4,
    },
  });
  assert.deepEqual(result.dependencies, [{
    contentType: 'canvas_symbol',
    sourceId: 'symbol-1',
    generation: 4,
  }]);
  assert.doesNotMatch(result.chunks[0].content, /member secret/);
  assert.doesNotMatch(JSON.stringify(result), /symbol member secret/);

  assert.deepEqual(
    operations.map((operation) => operation.table),
    [
      'i_edit_page',
      'microsite',
      'canvas_symbol',
      'member_content_source',
      'canvas_symbol',
    ]
  );
  assert.equal(operations[0].filters.tenant_id, 'tenant-1');
  assert.equal(operations[0].filters.id, 'page-1');
  assert.equal(operations[0].filters.builder_type, 'canvas');
  assert.equal(operations[2].filters.tenant_id, 'tenant-1');
  assert.equal(operations[3].filters.tenant_id, 'tenant-1');
  assert.equal(operations[3].filters.content_type, 'canvas_symbol');
});

test('non-public Canvas pages are removed without reading symbols', async () => {
  const { supabase, operations } = makeQueryMock({
    page: page({ layout_type: 'member' }),
  });

  const result = await buildCanvasGenerationSnapshot({
    supabase,
    tenantId: 'tenant-1',
    sourceId: 'page-1',
    claim: { generation: 1 },
  });

  assert.equal(result.indexable, false);
  assert.equal(result.reason, 'not-public-layout');
  assert.deepEqual(result.chunks, []);
  assert.deepEqual(operations.map((operation) => operation.table), [
    'i_edit_page',
  ]);
});

test('present symbols without an active generation fail closed', async () => {
  const { supabase } = makeQueryMock({
    page: page(),
    symbols: [symbol()],
    generations: [],
  });

  await assert.rejects(
    () => buildCanvasGenerationSnapshot({
      supabase,
      tenantId: 'tenant-1',
      sourceId: 'page-1',
      claim: { generation: 1 },
    }),
    (error) => {
      assert.equal(error.code, MEMBER_CONTENT_CANVAS_DEPENDENCY_UNAVAILABLE);
      return true;
    }
  );
});

test('a missing symbol row contributes no text or dependency', async () => {
  const { supabase } = makeQueryMock({
    page: page(),
    symbols: [],
    generations: [],
  });

  const result = await buildCanvasGenerationSnapshot({
    supabase,
    tenantId: 'tenant-1',
    sourceId: 'page-1',
    claim: { generation: 1 },
  });

  assert.equal(result.indexable, true);
  assert.deepEqual(result.dependencies, []);
  assert.deepEqual(result.symbol_versions, {});
  assert.match(result.chunks[0].content, /Public editorial text/);
  assert.doesNotMatch(result.chunks[0].content, /Public symbol text/);
});

test('snapshot requires the writer claim before rereading canonical content', async () => {
  const { supabase } = makeQueryMock({ page: page() });
  await assert.rejects(
    () => buildCanvasGenerationSnapshot({
      supabase,
      tenantId: 'tenant-1',
      sourceId: 'page-1',
    }),
    (error) => {
      assert.equal(error.code, MEMBER_CONTENT_CANVAS_CLAIM_REQUIRED);
      return true;
    }
  );
});

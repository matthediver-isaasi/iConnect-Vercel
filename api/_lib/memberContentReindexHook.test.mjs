import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTENT_TYPE_CONFIG, isIndexable } from './memberContentIndexer.js';

const source = readFileSync(new URL('./memberContentReindexHook.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
  .replace(/^export async function /gm, 'async function ');

function hooks(canonical, { readError = null } = {}) {
  const calls = [];
  const filters = [];
  const query = {
    select(columns) { calls.push({ columns }); return query; },
    eq(column, value) { filters.push([column, value]); return query; },
    async maybeSingle() { return { data: canonical, error: readError }; },
  };
  const deps = {
    supabase: { from(table) { calls.push({ table }); return query; } },
    CONTENT_TYPE_CONFIG,
    getDefaultOpenAIClient: () => ({}),
    reindexMemberContentItem: async (type, item) => { calls.push({ reindex: type, item }); },
    deleteMemberContentChunks: async (type, id) => { calls.push({ delete: type, id }); },
    scheduleMemberContentReindex: async () => { throw new Error('Unexpected deferred save'); },
    collectCanvasSymbolIds: () => new Set(),
    console: { error: (...args) => calls.push({ error: args }), warn() {} },
  };
  const api = new Function(...Object.keys(deps), `${source}
    return { reindexMemberContentEntitySafe, deleteMemberContentEntitySafe };`)(...Object.values(deps));
  return { ...api, calls, filters };
}

test('page saves select the canonical builder rather than a stale supplied partial', async () => {
  for (const [builder, expected] of [['canvas', 'canvas_page'], ['iedit', 'iedit_page'], [null, 'iedit_page']]) {
    const canonical = { id: 'page-1', tenant_id: 'tenant-a', builder_type: builder };
    const api = hooks(canonical);
    await api.reindexMemberContentEntitySafe('IEditPage', {
      id: 'page-1', tenant_id: 'tenant-a', builder_type: builder === 'canvas' ? 'elements' : 'canvas',
    });
    assert.deepEqual(api.calls.find(call => call.reindex), { reindex: expected, item: canonical });
    assert.deepEqual(api.filters, [['id', 'page-1'], ['tenant_id', 'tenant-a']]);
    assert.match(api.calls.find(call => call.columns).columns, /canvas_design/);
    assert.match(api.calls.find(call => call.columns).columns, /layout_type/);
  }
});

test('source-control iEdit type uses the real indexer config and exact canonical builder', () => {
  assert.equal(CONTENT_TYPE_CONFIG.iedit_page.table, 'i_edit_page');
  assert.deepEqual(CONTENT_TYPE_CONFIG.iedit_page.filterEq, { builder_type: 'iedit' });
  const page = { id: 'page-1', tenant_id: 'tenant-a', status: 'published', layout_type: 'member' };
  assert.equal(isIndexable('iedit_page', { ...page, builder_type: 'iedit' }), true);
  assert.equal(isIndexable('iedit_page', { ...page, builder_type: 'canvas' }), false);
  assert.equal(isIndexable('canvas_page', { ...page, builder_type: 'iedit' }), false);
});

test('missing or failed canonical page rereads never index stale supplied content', async () => {
  for (const readError of [null, new Error('Canonical read failed')]) {
    const api = hooks(null, { readError });
    await api.reindexMemberContentEntitySafe('IEditPage', {
      id: 'page-1', tenant_id: 'tenant-a', builder_type: 'canvas',
    });
    assert.equal(api.calls.some(call => call.reindex || call.delete), false);
    assert.equal(api.calls.some(call => call.error), !!readError);
  }
});

test('hard-delete cleanup covers both page builder identities', async () => {
  const api = hooks(null);
  await api.deleteMemberContentEntitySafe('IEditPage', 'page-1');
  assert.deepEqual(api.calls.filter(call => call.delete), [
    { delete: 'canvas_page', id: 'page-1' },
    { delete: 'iedit_page', id: 'page-1' },
  ]);
});

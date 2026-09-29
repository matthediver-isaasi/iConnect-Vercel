import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('./[pageId].js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?$/gm, '')
  .replace('export default async function handler', 'async function handler');

const metadata = {
  meta_title: 'Meta title',
  meta_description: 'Meta description',
  seo_title: 'SEO title',
  seo_description: 'SEO description',
  og_image_url: 'https://example.org/image.png',
};
const metadataColumns = Object.keys(metadata);

async function request({ legacy = false, values = metadata, context = {}, page = {} } = {}) {
  const selections = [];
  const row = {
    id: 'page-1', tenant_id: 'tenant-1', title: 'Canvas page', slug: 'canvas',
    status: 'draft', layout_type: 'canvas', builder_type: 'canvas',
    canvas_design: { version: 1, root: { sections: [] } },
    microsite_id: 'microsite-1', folder_id: 'folder-1',
    ...values, ...page,
  };
  const supabase = {
    from(table) {
      assert.equal(table, 'i_edit_page');
      let columns;
      const filters = {};
      const query = {
        select(projection) { columns = projection.split(',').map(value => value.trim()); selections.push(columns); return query; },
        eq(key, value) { filters[key] = value; return query; },
        async maybeSingle() {
          if (legacy && columns.includes('microsite_id')) {
            return { data: null, error: { code: '42703' } };
          }
          if (filters.id !== row.id || filters.tenant_id !== row.tenant_id) {
            return { data: null, error: null };
          }
          return { data: Object.fromEntries(columns.map(key => [key, row[key] ?? null])), error: null };
        },
      };
      return query;
    },
  };
  const handler = vm.runInNewContext(`${source}\nhandler`, {
    supabase,
    getTenantContext: async () => ({
      tenantId: 'tenant-1', isAuthenticated: true, tenantUserId: 'admin-1', ...context,
    }),
    hasFeatureAccess: async () => false,
    normalizeMemberOnlyFields: value => value,
    reindexMemberContentEntitySafe: async () => {},
    console,
  });
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method: 'GET', query: { pageId: 'page-1' } }, res);
  return { res, selections };
}

for (const legacy of [false, true]) {
  for (const values of [metadata, Object.fromEntries(metadataColumns.map(key => [key, null]))]) {
    test(`GET ${legacy ? 'legacy fallback' : 'normal'} returns ${values.meta_title === null ? 'null' : 'nonempty'} metadata`, async () => {
      const { res, selections } = await request({ legacy, values });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(Object.fromEntries(metadataColumns.map(key => [key, res.body.page[key]])), values);
      assert.equal(selections.length, legacy ? 2 : 1);
      for (const selection of selections) {
        for (const key of metadataColumns) assert.ok(selection.includes(key), `${key} missing from projection`);
      }
      assert.equal(selections[0].includes('microsite_id'), true);
      assert.equal(selections.at(-1).includes('microsite_id'), !legacy);
    });
  }
}

test('GET does not disclose another tenant page', async () => {
  const { res, selections } = await request({ page: { tenant_id: 'tenant-2' } });
  assert.equal(res.statusCode, 404);
  assert.equal(selections.length, 1);
});

for (const [label, context, status] of [
  ['missing tenant', { tenantId: null }, 403],
  ['unauthenticated', { isAuthenticated: false }, 401],
  ['non-admin without page editor access', { tenantUserId: null }, 404],
]) {
  test(`GET ${label} fails before querying page`, async () => {
    const { res, selections } = await request({ context });
    assert.equal(res.statusCode, status);
    assert.equal(selections.length, 0);
  });
}
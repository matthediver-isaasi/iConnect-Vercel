// Tests for demo-seeds/article-images.mjs
// Run: node --test demo-seeds/article-images.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demoArticleImageStoragePath,
  applyDemoArticleImage,
  linkExistingDemoArticleImages,
  buildArticleImagePrompt,
} from './article-images.mjs';

const TENANT_ID = 't-demo';
const URL = 'https://cdn.example.com/demo/article.jpg';

/**
 * Minimal chainable supabase mock (same style as news-images.test.mjs).
 */
function mockSb({ tables = {}, updates = [], storageFiles = [] } = {}) {
  const from = (table) => {
    const state = { table, filters: {}, nullFilters: {}, likeFilters: {}, patch: null, op: 'select' };
    const chain = {
      select: () => chain,
      update: (patch) => { state.op = 'update'; state.patch = patch; return chain; },
      eq: (k, v) => { state.filters[k] = v; return chain; },
      is: (k, v) => { state.nullFilters[k] = v; return chain; },
      ilike: (k, v) => { state.likeFilters[k] = v; return chain; },
      limit: () => chain,
      order: () => chain,
      maybeSingle: async () => ({ data: resolve()[0] || null, error: null }),
      then: (res) => Promise.resolve(run()).then(res),
    };
    const likeMatch = (val, pattern) => {
      const re = new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
      return re.test(String(val ?? ''));
    };
    const resolve = () => (tables[table] || []).filter((r) =>
      Object.entries(state.filters).every(([k, v]) => r[k] === v) &&
      Object.entries(state.nullFilters).every(([k, v]) => (v === null ? r[k] == null : r[k] != null)) &&
      Object.entries(state.likeFilters).every(([k, v]) => likeMatch(r[k], v)));
    const run = () => {
      if (state.op === 'update') {
        const matched = resolve();
        updates.push({ table, filters: { ...state.filters }, nullFilters: { ...state.nullFilters }, likeFilters: { ...state.likeFilters }, patch: state.patch });
        for (const row of matched) Object.assign(row, state.patch);
        return { data: matched.map((r) => ({ id: r.id })), error: null };
      }
      return { data: resolve(), error: null };
    };
    return chain;
  };
  const storage = {
    from: () => ({
      list: async (_prefix, { offset = 0 } = {}) => ({
        data: offset === 0 ? storageFiles.map((name) => ({ name })) : [],
        error: null,
      }),
      getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.example.com/${path}` } }),
    }),
  };
  return { from, storage };
}

const fileNameFor = (slug) => demoArticleImageStoragePath(TENANT_ID, slug).split('/')[1];
const samplePost = (over = {}) => ({ tenant_id: TENANT_ID, is_sample: true, feature_image_url: null, ...over });

// ---------------------------------------------------------------------------

test('storage path is deterministic and slug-keyed', () => {
  const a = demoArticleImageStoragePath(TENANT_ID, 'demo-post');
  assert.equal(a, demoArticleImageStoragePath(TENANT_ID, ' demo-post '));
  assert.notEqual(a, demoArticleImageStoragePath(TENANT_ID, 'demo-other'));
  assert.match(a, new RegExp(`^${TENANT_ID}/article-[0-9a-f]{40}\\.jpg$`));
});

test('applyDemoArticleImage links fill-null with is_sample + slug-prefix provenance', async () => {
  const tables = { blog_post: [samplePost({ id: 'p1', slug: 'demo-post' })] };
  const updates = [];
  const ok = await applyDemoArticleImage({ sb: mockSb({ tables, updates }), tenantId: TENANT_ID, postId: 'p1', url: URL, log: () => {} });
  assert.equal(ok, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.feature_image_url, URL);
  assert.equal(updates[0].likeFilters.slug, 'demo-%', 'UPDATE must carry slug-prefix provenance');
  assert.equal(updates[0].filters.is_sample, true, 'UPDATE must carry is_sample provenance');
  assert.ok('feature_image_url' in updates[0].nullFilters, 'UPDATE must re-check feature_image_url IS NULL');
});

test('existing image is never replaced', async () => {
  const tables = { blog_post: [samplePost({ id: 'p1', slug: 'demo-post', feature_image_url: 'https://cdn.example.com/manual.jpg' })] };
  const updates = [];
  const logs = [];
  const ok = await applyDemoArticleImage({ sb: mockSb({ tables, updates }), tenantId: TENANT_ID, postId: 'p1', url: URL, log: (m) => logs.push(m) });
  assert.equal(ok, false);
  assert.equal(updates.length, 0, 'no UPDATE when image already set');
  assert.ok(logs.some((l) => /keeps existing image/i.test(l)));
});

test('non-seeded rows are rejected (wrong slug prefix or not sample)', async () => {
  const tables = {
    blog_post: [
      samplePost({ id: 'p2', slug: 'real-post' }),
      samplePost({ id: 'p3', slug: 'demo-post', is_sample: false }),
    ],
  };
  await assert.rejects(
    applyDemoArticleImage({ sb: mockSb({ tables }), tenantId: TENANT_ID, postId: 'p2', url: URL, log: () => {} }),
    /not found/,
  );
  await assert.rejects(
    applyDemoArticleImage({ sb: mockSb({ tables }), tenantId: TENANT_ID, postId: 'p3', url: URL, log: () => {} }),
    /not found/,
  );
});

test('linkExistingDemoArticleImages links stored images and counts missing', async () => {
  const tables = {
    blog_post: [
      samplePost({ id: 'p1', slug: 'demo-scope-3' }),
      samplePost({ id: 'p2', slug: 'demo-bng' }), // no stored file
      samplePost({ id: 'p3', slug: 'demo-cpd', feature_image_url: 'set' }), // already has one
    ],
  };
  const updates = [];
  const logs = [];
  const sb = mockSb({ tables, updates, storageFiles: [fileNameFor('demo-scope-3'), 'unrelated.png'] });
  const { linked, missing } = await linkExistingDemoArticleImages({ sb, tenantId: TENANT_ID, log: (m) => logs.push(m) });
  assert.equal(linked, 1, 'demo-scope-3 linked');
  assert.equal(missing, 1, 'demo-bng has no stored image');
  assert.equal(tables.blog_post[0].feature_image_url, `https://cdn.example.com/${demoArticleImageStoragePath(TENANT_ID, 'demo-scope-3')}`);
  assert.equal(tables.blog_post[2].feature_image_url, 'set', 'already-set image untouched');
  assert.ok(logs.some((l) => /warning: 1 seeded article/.test(l)), 'missing warning cites the generation pass');
});

test('linkExistingDemoArticleImages returns zero when nothing needs an image', async () => {
  const tables = {
    blog_post: [samplePost({ id: 'p1', slug: 'demo-scope-3', feature_image_url: 'https://cdn.example.com/existing.jpg' })],
  };
  const sb = mockSb({ tables });
  const { linked, missing } = await linkExistingDemoArticleImages({ sb, tenantId: TENANT_ID, log: () => {} });
  assert.equal(linked, 0);
  assert.equal(missing, 0);
});

test('buildArticleImagePrompt picks a scene from tags/subcategories/title', () => {
  const carbon = buildArticleImagePrompt({ tags: ['Carbon'], subcategories: ['Carbon & Net Zero'], title: 'Scope 3 boundaries' }, { sector: 'environmental and sustainability' });
  assert.match(carbon, /decarbonisation|emissions/i);
  assert.match(carbon, /environmental theme/i);

  const bng = buildArticleImagePrompt({ tags: ['Biodiversity', 'BNG'], subcategories: [], title: 'BNG one year on' });
  assert.match(bng, /ecologist|field survey/i);

  const careers = buildArticleImagePrompt({ tags: ['Careers'], subcategories: ['Career Stories'], title: 'From graduate to consultant' });
  assert.match(careers, /career/i);

  const fallback = buildArticleImagePrompt({ tags: [], subcategories: [], title: 'Untitled' });
  assert.match(fallback, /long-form article/);

  for (const pr of [carbon, bng, careers, fallback]) {
    assert.match(pr, /no visible readable text, no logos, no watermarks/);
    assert.match(pr, /16:9 landscape/);
  }
});

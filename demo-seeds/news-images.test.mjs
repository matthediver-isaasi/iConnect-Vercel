// Tests for demo-seeds/news-images.mjs
// Run: node --test demo-seeds/news-images.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demoNewsImageStoragePath,
  applyDemoNewsImage,
  linkExistingDemoNewsImages,
  buildNewsImagePrompt,
} from './news-images.mjs';

const TENANT_ID = 't-demo';
const URL = 'https://cdn.example.com/demo/news.jpg';

/**
 * Minimal chainable supabase mock (same style as event-images.test.mjs) plus
 * ilike-prefix filters and a storage stub.
 * `tables` is a map of tableName -> array of row objects.
 * `updates` accumulates { table, filters, nullFilters, likeFilters, patch }.
 * `storageFiles` is a list of file names under the tenant folder.
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

const fileNameFor = (slug) => demoNewsImageStoragePath(TENANT_ID, slug).split('/')[1];

// ---------------------------------------------------------------------------

test('storage path is deterministic and slug-keyed', () => {
  const a = demoNewsImageStoragePath(TENANT_ID, 'demo-article');
  assert.equal(a, demoNewsImageStoragePath(TENANT_ID, ' demo-article '));
  assert.notEqual(a, demoNewsImageStoragePath(TENANT_ID, 'demo-other'));
  assert.match(a, new RegExp(`^${TENANT_ID}/news-[0-9a-f]{40}\\.jpg$`));
});

test('applyDemoNewsImage links fill-null with slug-prefix provenance on news_post', async () => {
  const tables = { news_post: [{ id: 'p1', tenant_id: TENANT_ID, slug: 'demo-article', feature_image_url: null }] };
  const updates = [];
  const ok = await applyDemoNewsImage({ sb: mockSb({ tables, updates }), tenantId: TENANT_ID, postId: 'p1', url: URL, log: () => {} });
  assert.equal(ok, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.feature_image_url, URL);
  assert.equal(updates[0].likeFilters.slug, 'demo-%', 'UPDATE must carry slug-prefix provenance');
  assert.ok('feature_image_url' in updates[0].nullFilters, 'UPDATE must re-check feature_image_url IS NULL');
});

test('existing image is never replaced', async () => {
  const tables = { news_post: [{ id: 'p1', tenant_id: TENANT_ID, slug: 'demo-article', feature_image_url: 'https://cdn.example.com/manual.jpg' }] };
  const updates = [];
  const logs = [];
  const ok = await applyDemoNewsImage({ sb: mockSb({ tables, updates }), tenantId: TENANT_ID, postId: 'p1', url: URL, log: (m) => logs.push(m) });
  assert.equal(ok, false);
  assert.equal(updates.length, 0, 'no UPDATE when image already set');
  assert.ok(logs.some((l) => /keeps existing image/i.test(l)));
});

test('non-seeded rows are rejected (wrong slug prefix)', async () => {
  const tables = {
    news_post: [{ id: 'p2', tenant_id: TENANT_ID, slug: 'real-article', feature_image_url: null }],
  };
  await assert.rejects(
    applyDemoNewsImage({ sb: mockSb({ tables }), tenantId: TENANT_ID, postId: 'p2', url: URL, log: () => {} }),
    /not found/,
  );
});

test('linkExistingDemoNewsImages links stored images and counts missing', async () => {
  const tables = {
    news_post: [
      { id: 'p1', tenant_id: TENANT_ID, slug: 'demo-survey', feature_image_url: null },
      { id: 'p2', tenant_id: TENANT_ID, slug: 'demo-conference', feature_image_url: null }, // no stored file
      { id: 'p3', tenant_id: TENANT_ID, slug: 'demo-careers', feature_image_url: 'set' }, // already has one
    ],
  };
  const updates = [];
  const logs = [];
  const sb = mockSb({ tables, updates, storageFiles: [fileNameFor('demo-survey'), 'unrelated.png'] });
  const { linked, missing } = await linkExistingDemoNewsImages({ sb, tenantId: TENANT_ID, log: (m) => logs.push(m) });
  assert.equal(linked, 1, 'demo-survey linked');
  assert.equal(missing, 1, 'demo-conference has no stored image');
  assert.equal(tables.news_post[0].feature_image_url, `https://cdn.example.com/${demoNewsImageStoragePath(TENANT_ID, 'demo-survey')}`);
  assert.equal(tables.news_post[2].feature_image_url, 'set', 'already-set image untouched');
  assert.ok(logs.some((l) => /warning: 1 seeded news post/.test(l)), 'missing warning cites the README pass');
});

test('linkExistingDemoNewsImages returns zero when all posts already have images', async () => {
  const tables = {
    news_post: [
      { id: 'p1', tenant_id: TENANT_ID, slug: 'demo-survey', feature_image_url: 'https://cdn.example.com/existing.jpg' },
    ],
  };
  const sb = mockSb({ tables });
  const { linked, missing } = await linkExistingDemoNewsImages({ sb, tenantId: TENANT_ID, log: () => {} });
  assert.equal(linked, 0);
  assert.equal(missing, 0);
});

test('buildNewsImagePrompt picks a scene from tags/title and stays text/logo free', () => {
  const survey = buildNewsImagePrompt({ tags: ['Research'], title: 'State of the Sustainability Profession survey' }, { sector: 'environmental and sustainability' });
  assert.match(survey, /survey results/);
  assert.match(survey, /environmental theme/i);

  const conference = buildNewsImagePrompt({ tags: ['Events'], title: 'Annual Conference 2026 programme announced' });
  assert.match(conference, /conference/i);

  const careers = buildNewsImagePrompt({ tags: ['Careers'], title: 'Environmental Careers Week launches' });
  assert.match(careers, /career/i);

  const policy = buildNewsImagePrompt({ tags: ['Policy'], title: 'AESP responds to planning reform consultation' });
  assert.match(policy, /policy|working group|consultation/i);

  const cpd = buildNewsImagePrompt({ tags: ['CPD'], title: 'Refreshed CPD framework takes effect' });
  assert.match(cpd, /guidance|cpd|framework|training/i);

  for (const p of [survey, conference, careers, policy, cpd]) {
    assert.match(p, /no visible readable text, no logos, no watermarks/);
    assert.match(p, /16:9 landscape/);
  }
});

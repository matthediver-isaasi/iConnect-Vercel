// Tests for the shared tolerant article-by-slug lookup used by the public
// article API, prerender and entity meta when the author segment is unknown,
// stale, or a placeholder ('member').
// Run: node --test api/_lib/articleSlugLookup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { findPublishedArticleBySlug } from './articleSlugLookup.js';

const TENANT_ID = 't1';

/** Chainable supabase mock over a blog_post table. */
function mockSb(rows) {
  return {
    from: (table) => {
      assert.equal(table, 'blog_post');
      const state = { eq: {}, like: null };
      const chain = {
        select: () => chain,
        eq: (k, v) => { state.eq[k] = v; return chain; },
        like: (k, v) => { state.like = [k, v]; return chain; },
        order: () => chain,
        limit: (n) => {
          let matched = rows.filter((r) =>
            Object.entries(state.eq).every(([k, v]) => r[k] === v));
          if (state.like) {
            const [k, pattern] = state.like;
            const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$');
            matched = matched.filter((r) => re.test(String(r[k] ?? '')));
          }
          matched = [...matched].sort((a, b) => String(a.slug).localeCompare(String(b.slug))).slice(0, n);
          return Promise.resolve({ data: matched, error: null });
        },
      };
      return chain;
    },
  };
}

const base = { tenant_id: TENANT_ID, status: 'published' };

test('exact slug match wins', async () => {
  const rows = [{ ...base, id: 'a', slug: 'my-post' }];
  const found = await findPublishedArticleBySlug(mockSb(rows), TENANT_ID, 'my-post', '*');
  assert.equal(found?.id, 'a');
});

test('legacy hyphenated-handle suffix resolves when no exact match exists', async () => {
  const rows = [{ ...base, id: 'b', slug: 'my-post-by-aisha-rahman' }];
  const found = await findPublishedArticleBySlug(mockSb(rows), TENANT_ID, 'my-post', '*');
  assert.equal(found?.id, 'b');
});

test('collision: clean slug and distinct legacy slug coexist — exact wins deterministically', async () => {
  const rows = [
    { ...base, id: 'legacy', slug: 'my-post-by-james-walker' },
    { ...base, id: 'clean', slug: 'my-post' },
  ];
  const found = await findPublishedArticleBySlug(mockSb(rows), TENANT_ID, 'my-post', '*');
  assert.equal(found?.id, 'clean');
});

test('unpublished and cross-tenant rows never resolve', async () => {
  const rows = [
    { id: 'draft', tenant_id: TENANT_ID, status: 'draft', slug: 'my-post' },
    { id: 'other', tenant_id: 't2', status: 'published', slug: 'my-post' },
  ];
  const found = await findPublishedArticleBySlug(mockSb(rows), TENANT_ID, 'my-post', '*');
  assert.equal(found, null);
});

test('missing inputs return null without querying', async () => {
  assert.equal(await findPublishedArticleBySlug(null, TENANT_ID, 's', '*'), null);
  assert.equal(await findPublishedArticleBySlug(mockSb([]), null, 's', '*'), null);
  assert.equal(await findPublishedArticleBySlug(mockSb([]), TENANT_ID, '', '*'), null);
});

test('source contract: prerender, entityMeta and the public article API all wire the shared fallback', async () => {
  const fs = await import('node:fs');
  for (const rel of ['../public/prerender.js', './entityMeta.js', '../public/article.js']) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /findPublishedArticleBySlug\(/, `${rel} must use the shared tolerant slug lookup`);
  }
});

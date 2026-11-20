import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { isArticlePublished, articlePublicationDateFilter } from './articlePublication.js';
import { applyArticleReadRelease } from '../api/_lib/articleReadRelease.js';
import { readFileSync } from 'node:fs';

const now = new Date('2026-11-20T10:00:00Z');
test('future posts stay hidden until the exact publication instant across timezones', () => {
  assert.equal(isArticlePublished({ status: 'published', published_date: '2026-11-20T10:00:01Z' }, now), false);
  assert.equal(isArticlePublished({ status: 'published', published_date: '2026-11-20T11:00:00+01:00' }, now), true);
  assert.equal(isArticlePublished({ status: 'published', published_date: '2026-11-19T10:00:00Z' }, now), true);
});
test('drafts, archived posts and malformed dates stay hidden; legacy undated posts remain live', () => {
  for (const status of ['draft', 'archived']) assert.equal(isArticlePublished({ status }, now), false);
  assert.equal(isArticlePublished({ status: 'published', published_date: 'invalid' }, now), false);
  assert.equal(isArticlePublished({ status: 'published', published_date: null }, now), true);
});
test('PostgREST keeps publication and slug predicates together, with no early query execution', async () => {
  let requested;
  const client = createClient('https://fixture.supabase.co', 'fixture-key', {
    global: { fetch: async url => {
      requested = new URL(url);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const { query } = await applyArticleReadRelease(client.from('blog_post').select('*'), {}, async () => false, now);
  assert.equal(requested, undefined);
  await query.or('slug.eq.example,slug.like.example-by-%').eq('tenant_id', 'tenant');
  assert.deepEqual(requested.searchParams.getAll('or'), [
    `(${articlePublicationDateFilter(now)})`, '(slug.eq.example,slug.like.example-by-%)',
  ]);
  assert.equal(requested.searchParams.get('tenant_id'), 'eq.tenant');
});
test('authors and admins retain preview access while other members retain the time restriction', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let filter;
  const query = { or(value) { filter = value; return this; } };
  await applyArticleReadRelease(query, { memberId: id }, async () => false, now);
  assert.equal(filter, `${articlePublicationDateFilter(now)},author_id.eq.${id}`);
  filter = null;
  assert.equal((await applyArticleReadRelease(query, {}, async () => true, now)).query, query);
  assert.equal(filter, null);
});

test('every public blog query includes the release predicate, including crawler and search queries', () => {
  for (const path of [
    '../api/public/articles.js', '../api/public/article.js', '../api/_lib/articleSlugLookup.js',
    '../api/public/search.js', '../api/public/sitemap.xml.js', '../api/public/prerender.js',
    '../api/_lib/entityMeta.js',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const queries = [...source.matchAll(/\.from\('blog_post'\)([\s\S]*?);/g)];
    assert.ok(queries.length > 0, path);
    for (const [, query] of queries) assert.match(query, /articlePublicationDateFilter\(\)/, path);
  }
});

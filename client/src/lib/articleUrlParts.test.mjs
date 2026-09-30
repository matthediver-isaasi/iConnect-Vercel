// Tests for client/src/lib/articleUrlParts.js
// Run: npx tsx --test client/src/lib/articleUrlParts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { getArticleUrlParts, articleSlugMatches, MEMBER_HANDLE_FALLBACK } from './articleUrlParts.js';

test('guest-writer article uses the guest segment', () => {
  const { authorHandle, cleanSlug } = getArticleUrlParts({ slug: 'demo-policy-gap', guest_writer_id: 'gw1', author_id: null });
  assert.equal(authorHandle, 'guest');
  assert.equal(cleanSlug, 'demo-policy-gap');
});

test('member author with known handle uses it', () => {
  const { authorHandle } = getArticleUrlParts(
    { slug: 'demo-bng', author_id: 'm1' },
    { m1: 'aisha-rahman' }
  );
  assert.equal(authorHandle, 'aisha-rahman');
});

test('member author WITHOUT a handle falls back to the member placeholder, never guest', () => {
  const { authorHandle } = getArticleUrlParts({ slug: 'demo-bng-first-year-lessons', author_id: 'm1' }, {});
  assert.equal(authorHandle, MEMBER_HANDLE_FALLBACK);
  assert.notEqual(authorHandle, 'guest');
});

test('legacy -by- slug suffix supplies the handle and is stripped from the slug', () => {
  const { authorHandle, cleanSlug } = getArticleUrlParts({ slug: 'my-post-by-jsmith', author_id: 'm2' }, {});
  assert.equal(authorHandle, 'jsmith');
  assert.equal(cleanSlug, 'my-post');
});

test('article with neither author nor guest writer avoids the guest segment', () => {
  const { authorHandle } = getArticleUrlParts({ slug: 'orphan-post' }, {});
  assert.equal(authorHandle, MEMBER_HANDLE_FALLBACK);
});

test('article with both author and guest writer prefers the member path', () => {
  const { authorHandle } = getArticleUrlParts({ slug: 's', author_id: 'm1', guest_writer_id: 'gw1' }, { m1: 'ann' });
  assert.equal(authorHandle, 'ann');
});

test('articleSlugMatches: exact match', () => {
  assert.ok(articleSlugMatches('my-post', 'my-post'));
  assert.ok(!articleSlugMatches('my-post', 'other'));
  assert.ok(!articleSlugMatches('', 'x'));
  assert.ok(!articleSlugMatches('x', ''));
});

test('articleSlugMatches: legacy suffix with a HYPHENATED handle matches the clean slug', () => {
  assert.ok(articleSlugMatches('my-post-by-aisha-rahman', 'my-post'));
  assert.ok(articleSlugMatches('my-post-by-jsmith', 'my-post'));
  assert.ok(!articleSlugMatches('my-post-by-aisha-rahman', 'my-post-by'));
});

test('articleSlugMatches agrees with getArticleUrlParts clean-slug stripping', () => {
  const stored = 'lessons-learned-by-daniel-brooks';
  const { cleanSlug } = getArticleUrlParts({ slug: stored, author_id: 'm1' }, {});
  assert.ok(articleSlugMatches(stored, cleanSlug));
});

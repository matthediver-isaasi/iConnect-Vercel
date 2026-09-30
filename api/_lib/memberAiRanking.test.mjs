// Task #2404 — unit tests for the Member AI Knowledge Assistant ranking
// helpers (api/_lib/memberAiRanking.js, used by api/member-ai/ask.js).
// Locks in: recency-question detection, recency score decay, per-chunk date
// formatting, cross-query candidate merge/dedupe, blended recency re-ranking,
// and per-source-capped context selection — so a future edit can't silently
// reorder or drop context chunks.
// Run with: node --test api/_lib/memberAiRanking.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRecencyQuestion,
  recencyScore,
  formatChunkDate,
  mergeCandidates,
  rerankByRecency,
  blendedRecencyScore,
  selectContextChunks,
  RECENCY_WEIGHT,
  RECENCY_HALF_LIFE_DAYS,
} from './memberAiRanking.js';

const NOW = new Date('2026-07-07T00:00:00Z');

// ---------------------------------------------------------------------------
// isRecencyQuestion
// ---------------------------------------------------------------------------

test('isRecencyQuestion: matches recency-signalling questions', () => {
  const hits = [
    'What are the latest developments in graduate hiring?',
    'Any recent news about membership fees?',
    'What happened recently?',
    'Are there new resources on safeguarding?',
    'What is the newest guidance?',
    'What are the current trends?',
    'What is currently happening?',
    'Any upcoming events?',
    'Is there an update on the merger?',
    'Any updates on policy?',
    'Has the guidance been updated?',
    'What is trending in the sector?',
    'Tell me about developments in AI',
    "What's new in the portal?",
    "what's happening this week?",
    'What changed this year?',
    'Any events this month?',
    'What do employers want nowadays?',
    'What matters these days?',
  ];
  for (const q of hits) {
    assert.equal(isRecencyQuestion(q), true, `expected recency hit: ${q}`);
  }
});

test('isRecencyQuestion: does not match plain factual questions', () => {
  const misses = [
    'How do I renew my membership?',
    'Where is the annual conference held?',
    'What does the safeguarding policy say?',
    'Who is the chair of the board?',
    'How much does a corporate membership cost?',
    'Explain the booking cancellation process',
  ];
  for (const q of misses) {
    assert.equal(isRecencyQuestion(q), false, `expected recency miss: ${q}`);
  }
});

test('isRecencyQuestion: word-boundary — does not fire on substrings', () => {
  // "renewal" contains "new", "recurrent" contains "current" but neither is a
  // whole-word recency signal.
  assert.equal(isRecencyQuestion('How does membership renewal work?'), false);
  assert.equal(isRecencyQuestion('Is this a recurrent charge?'), false);
});

// ---------------------------------------------------------------------------
// recencyScore
// ---------------------------------------------------------------------------

test('recencyScore: undated chunk scores 0', () => {
  assert.equal(recencyScore({}, NOW), 0);
  assert.equal(recencyScore({ published_date: null, start_date: null }, NOW), 0);
});

test('recencyScore: invalid date scores 0', () => {
  assert.equal(recencyScore({ published_date: 'not-a-date' }, NOW), 0);
});

test('recencyScore: today scores 1, decays with age', () => {
  const today = recencyScore({ published_date: '2026-07-07T00:00:00Z' }, NOW);
  assert.ok(Math.abs(today - 1) < 1e-9);

  // One half-life (180 days) ago -> e^-1
  const halfLifeAgo = new Date(
    NOW.getTime() - RECENCY_HALF_LIFE_DAYS * 86400000
  ).toISOString();
  const decayed = recencyScore({ published_date: halfLifeAgo }, NOW);
  assert.ok(Math.abs(decayed - Math.exp(-1)) < 1e-9);

  // Strictly monotonic: newer beats older.
  const newer = recencyScore({ published_date: '2026-07-01T00:00:00Z' }, NOW);
  const older = recencyScore({ published_date: '2025-07-01T00:00:00Z' }, NOW);
  assert.ok(newer > older);
});

test('recencyScore: future event dates score like equally-near past dates', () => {
  const futureWeek = recencyScore({ start_date: '2026-07-14T00:00:00Z' }, NOW);
  const pastWeek = recencyScore({ start_date: '2026-06-30T00:00:00Z' }, NOW);
  assert.ok(Math.abs(futureWeek - pastWeek) < 1e-9);
  assert.ok(futureWeek > 0.9); // one week away is very "current"
});

test('recencyScore: prefers published_date over start_date when both set', () => {
  const both = recencyScore(
    { published_date: '2026-07-07T00:00:00Z', start_date: '2020-01-01T00:00:00Z' },
    NOW
  );
  assert.ok(Math.abs(both - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// formatChunkDate
// ---------------------------------------------------------------------------

test('formatChunkDate: empty string for undated chunk', () => {
  assert.equal(formatChunkDate({ content_type: 'blog_post' }), '');
});

test('formatChunkDate: published label for articles/news/resources', () => {
  for (const type of ['blog_post', 'news_post', 'resource']) {
    assert.equal(
      formatChunkDate({
        content_type: type,
        published_date: '2026-03-05T00:00:00Z',
      }),
      ' (published: 5 Mar 2026)',
      `content_type=${type}`
    );
  }
});

test('formatChunkDate: event-date label for event + complex_event', () => {
  for (const type of ['event', 'complex_event']) {
    assert.equal(
      formatChunkDate({
        content_type: type,
        start_date: '2026-09-18T00:00:00Z',
      }),
      ' (event date: 18 Sept 2026)',
      `content_type=${type}`
    );
  }
});

// ---------------------------------------------------------------------------
// mergeCandidates
// ---------------------------------------------------------------------------

test('mergeCandidates: dedupes by id keeping the best similarity', () => {
  const q1 = [
    { id: 'a', similarity: 0.5 },
    { id: 'b', similarity: 0.4 },
  ];
  const q2 = [
    { id: 'a', similarity: 0.8, from: 'q2' },
    { id: 'c', similarity: 0.3 },
  ];
  const merged = mergeCandidates([q1, q2]);
  assert.equal(merged.length, 3);
  const a = merged.find((m) => m.id === 'a');
  assert.equal(a.similarity, 0.8);
  assert.equal(a.from, 'q2'); // the higher-similarity ROW wins, not just the number
});

test('mergeCandidates: keeps first occurrence on similarity tie', () => {
  const first = { id: 'a', similarity: 0.5, from: 'q1' };
  const second = { id: 'a', similarity: 0.5, from: 'q2' };
  const merged = mergeCandidates([[first], [second]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].from, 'q1');
});

test('mergeCandidates: sorts by similarity descending, missing similarity -> 0', () => {
  const merged = mergeCandidates([
    [{ id: 'low', similarity: 0.2 }, { id: 'none' }],
    [{ id: 'high', similarity: 0.9 }],
  ]);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['high', 'low', 'none']
  );
});

test('mergeCandidates: tolerates null/empty lists', () => {
  assert.deepEqual(mergeCandidates([null, [], undefined]), []);
});

// ---------------------------------------------------------------------------
// rerankByRecency
// ---------------------------------------------------------------------------

test('rerankByRecency: no-op (same reference) when recency=false', () => {
  const visible = [
    { id: 'old-relevant', similarity: 0.9, published_date: '2020-01-01' },
    { id: 'new-weak', similarity: 0.3, published_date: '2026-07-06' },
  ];
  const out = rerankByRecency(visible, { recency: false, now: NOW });
  assert.equal(out, visible); // untouched, same ordering
});

test('rerankByRecency: blends similarity with recency, does not mutate input', () => {
  // Similar similarity, very different dates -> fresh chunk should win.
  const stale = { id: 'stale', similarity: 0.6, published_date: '2020-01-01' };
  const fresh = { id: 'fresh', similarity: 0.55, published_date: '2026-07-06' };
  const visible = [stale, fresh];
  const out = rerankByRecency(visible, { recency: true, now: NOW });
  assert.deepEqual(out.map((m) => m.id), ['fresh', 'stale']);
  // Input array not mutated.
  assert.deepEqual(visible.map((m) => m.id), ['stale', 'fresh']);
});

test('rerankByRecency: similarity still dominates when the gap is large', () => {
  // RECENCY_WEIGHT is 0.3, so a big similarity gap must outweigh freshness.
  const strong = { id: 'strong', similarity: 0.9, published_date: '2020-01-01' };
  const weakFresh = { id: 'weak', similarity: 0.2, published_date: '2026-07-06' };
  const out = rerankByRecency([weakFresh, strong], { recency: true, now: NOW });
  assert.deepEqual(out.map((m) => m.id), ['strong', 'weak']);
});

test('rerankByRecency: undated chunks rank purely on similarity', () => {
  const undatedStrong = { id: 'undated', similarity: 0.8 };
  const datedWeak = { id: 'dated', similarity: 0.3, published_date: '2026-07-06' };
  const out = rerankByRecency([datedWeak, undatedStrong], {
    recency: true,
    now: NOW,
  });
  // 0.7*0.8 = 0.56 vs 0.7*0.3 + 0.3*~1 = ~0.51 -> undated wins.
  assert.deepEqual(out.map((m) => m.id), ['undated', 'dated']);
});

test('blendedRecencyScore: matches the documented blend formula', () => {
  const m = { similarity: 0.5, published_date: '2026-07-07T00:00:00Z' };
  const expected = (1 - RECENCY_WEIGHT) * 0.5 + RECENCY_WEIGHT * 1;
  assert.ok(Math.abs(blendedRecencyScore(m, NOW) - expected) < 1e-9);
});

// ---------------------------------------------------------------------------
// selectContextChunks
// ---------------------------------------------------------------------------

const chunk = (id, sourceId, type = 'resource') => ({
  id,
  source_id: sourceId,
  content_type: type,
});

test('selectContextChunks: caps chunks per source', () => {
  const ranked = [
    chunk('a1', 's1'),
    chunk('a2', 's1'),
    chunk('a3', 's1'),
    chunk('a4', 's1'), // over the cap of 3
    chunk('b1', 's2'),
  ];
  const out = selectContextChunks(ranked, { contextChunks: 4, maxPerSource: 3 });
  assert.deepEqual(
    out.map((m) => m.id),
    ['a1', 'a2', 'a3', 'b1'] // a4 skipped in favour of the other source
  );
});

test('selectContextChunks: backfills from leftovers when under budget', () => {
  const ranked = [
    chunk('a1', 's1'),
    chunk('a2', 's1'),
    chunk('a3', 's1'),
    chunk('a4', 's1'), // leftover
    chunk('a5', 's1'), // leftover
    chunk('b1', 's2'),
  ];
  const out = selectContextChunks(ranked, { contextChunks: 6, maxPerSource: 3 });
  // 4 within cap + backfilled leftovers in ranked order.
  assert.deepEqual(
    out.map((m) => m.id),
    ['a1', 'a2', 'a3', 'b1', 'a4', 'a5']
  );
});

test('selectContextChunks: respects the total context budget', () => {
  const ranked = [
    chunk('a1', 's1'),
    chunk('b1', 's2'),
    chunk('c1', 's3'),
    chunk('d1', 's4'),
  ];
  const out = selectContextChunks(ranked, { contextChunks: 2, maxPerSource: 3 });
  assert.deepEqual(out.map((m) => m.id), ['a1', 'b1']);
});

test('selectContextChunks: same source_id under different content types are separate sources', () => {
  const ranked = [
    chunk('e1', 'x', 'event'),
    chunk('e2', 'x', 'event'),
    chunk('e3', 'x', 'event'),
    chunk('r1', 'x', 'resource'), // different content_type -> own cap
  ];
  const out = selectContextChunks(ranked, { contextChunks: 4, maxPerSource: 3 });
  assert.deepEqual(out.map((m) => m.id), ['e1', 'e2', 'e3', 'r1']);
});

test('selectContextChunks: preserves ranked order (recency ordering survives selection)', () => {
  const ranked = [
    chunk('n1', 's1', 'news_post'),
    chunk('n2', 's2', 'news_post'),
    chunk('n3', 's3', 'news_post'),
  ];
  const out = selectContextChunks(ranked, { contextChunks: 3, maxPerSource: 3 });
  assert.deepEqual(out.map((m) => m.id), ['n1', 'n2', 'n3']);
});

test('selectContextChunks: empty input -> empty output', () => {
  assert.deepEqual(
    selectContextChunks([], { contextChunks: 16, maxPerSource: 3 }),
    []
  );
});

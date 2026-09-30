// Task #2404: pure ranking helpers for the Member AI Knowledge Assistant
// (api/member-ai/ask.js), extracted so they can be unit-tested without
// mocking OpenAI or Supabase. Covers: recency-question detection, recency
// score decay, per-chunk date formatting, cross-query candidate merge/dedupe,
// blended recency re-ranking, and per-source-capped context selection.
//
// SECURITY NOTE: none of these helpers perform visibility filtering. The
// caller (ask.js) MUST apply isChunkVisibleToMember BEFORE rerankByRecency /
// selectContextChunks — re-ranking and selection only ever operate on chunks
// the member is already allowed to see.

// Blend weights + decay for recency-aware re-ranking (applied only AFTER the
// visibility filter, and only when the question signals recency).
export const RECENCY_WEIGHT = 0.3;
export const RECENCY_HALF_LIFE_DAYS = 180;

// Recency signal in the question ("latest", "recent", "new", "this year", ...).
const RECENCY_RE =
  /\b(latest|recent|recently|new|newest|current|currently|upcoming|update|updates|updated|trend|trends|trending|development|developments|news|nowadays|what'?s (new|happening)|this (year|month|week)|these days)\b/i;

export function isRecencyQuestion(question) {
  return RECENCY_RE.test(question);
}

// Best available date for a chunk: published_date for articles/news, start_date
// for events. Returns a Date or null.
export function chunkDate(m) {
  const raw = m.published_date || m.start_date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Exponential decay on how far the chunk's date is from now (past OR future —
// an event next week is just as "current" as news from last week). Undated
// chunks score 0 so they rank purely on similarity.
export function recencyScore(m, now) {
  const d = chunkDate(m);
  if (!d) return 0;
  const ageDays = Math.abs(now.getTime() - d.getTime()) / 86400000;
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function formatChunkDate(m) {
  const d = chunkDate(m);
  if (!d) return '';
  const s = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const isEvent = m.content_type === 'event' || m.content_type === 'complex_event';
  return isEvent ? ` (event date: ${s})` : ` (published: ${s})`;
}

// Merge/dedupe candidate chunks across multiple retrieval queries, keeping
// each chunk's best similarity, then sort by similarity descending. Takes an
// array of arrays (one candidate list per query). This all happens BEFORE the
// visibility filter.
export function mergeCandidates(matchLists) {
  const byId = new Map();
  for (const list of matchLists) {
    for (const m of list || []) {
      const prev = byId.get(m.id);
      if (!prev || (m.similarity ?? 0) > (prev.similarity ?? 0)) {
        byId.set(m.id, m);
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)
  );
}

// Blended similarity + recency score used when the question signals recency.
export function blendedRecencyScore(m, now) {
  return (
    (1 - RECENCY_WEIGHT) * (m.similarity ?? 0) +
    RECENCY_WEIGHT * recencyScore(m, now)
  );
}

// Recency-aware re-rank. MUST only be called on already-visibility-filtered
// chunks. Returns a new array; input is not mutated. When `recency` is false
// the input ordering is preserved.
export function rerankByRecency(visible, { recency, now }) {
  if (!recency) return visible;
  return [...visible].sort(
    (a, b) => blendedRecencyScore(b, now) - blendedRecencyScore(a, now)
  );
}

// Select context chunks with a per-source cap so one source can't crowd out
// the rest; backfill from leftovers (in ranked order) if under budget.
export function selectContextChunks(ranked, { contextChunks, maxPerSource }) {
  const accessible = [];
  const perSource = new Map();
  const leftovers = [];
  for (const m of ranked) {
    if (accessible.length >= contextChunks) break;
    const key = `${m.content_type}:${m.source_id}`;
    const count = perSource.get(key) || 0;
    if (count < maxPerSource) {
      accessible.push(m);
      perSource.set(key, count + 1);
    } else {
      leftovers.push(m);
    }
  }
  for (const m of leftovers) {
    if (accessible.length >= contextChunks) break;
    accessible.push(m);
  }
  return accessible;
}

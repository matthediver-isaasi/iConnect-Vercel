import { randomUUID } from 'node:crypto';

const GFI_TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const PEOPLE_SOURCE_ID = 'b1012823-fe46-4cc2-98a7-2e40e3c9ce89';
const STAGES = new Set([
  'candidates_matched', 'similarity_filtered', 'metadata_filtered', 'sources_revalidated',
  'no_accessible_chunks', 'no_citeable_chunks', 'context_selected',
  'synthesis_completed', 'final_member_rejected', 'final_tenant_user_rejected',
  'final_sources_rejected', 'citations_checked', 'citations_repaired',
  'citations_rejected', 'answer_returned',
]);
const COUNTS = new Set([
  'chunks', 'peopleChunks', 'sources', 'inputTokens', 'outputTokens',
  'answerCharacters', 'expectedChunks', 'remainingChunks',
]);
const FLAGS = new Set(['valid', 'matchesFallback']);
const REASONS = new Set(['model_url', 'unknown_citation', 'missing_citation', 'repair_unavailable']);

// Temporary incident diagnostics. No source text, questions, identity, request
// headers or provider payloads enter logs. Correlation is server-generated, not
// supplied by the browser. This never changes eligibility or response payloads.
export function createGfiAskDiagnostics({ tenantId, mode, log = console.info }) {
  if (tenantId !== GFI_TENANT_ID) return () => {};
  const traceId = randomUUID();
  const sessionMode = ['member', 'admin', 'anonymous'].includes(mode) ? mode : 'unknown';
  return (stage, values = {}) => {
    if (!STAGES.has(stage)) return;
    const safe = {};
    for (const [key, value] of Object.entries(values)) {
      if (COUNTS.has(key) && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
      if (FLAGS.has(key) && typeof value === 'boolean') safe[key] = value;
      if (key === 'reason' && REASONS.has(value)) safe.reason = value;
      if (key === 'peopleSectionKeys' && Array.isArray(value)) {
        safe.peopleSectionKeys = [...new Set(value.filter(item =>
          typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)))].slice(0, 40);
      }
    }
    try {
      log('[Member AI GFI diagnostic] ' + JSON.stringify({ traceId, mode: sessionMode, stage, ...safe }));
    } catch {
      // An observability failure must not affect the authorization/answer path.
    }
  };
}

export function summarizeGfiContext(chunks, sources) {
  const people = chunks.filter(chunk =>
    chunk.content_type === 'iedit_page' && chunk.source_id === PEOPLE_SOURCE_ID);
  return {
    chunks: chunks.length,
    peopleChunks: people.length,
    peopleSectionKeys: [...new Set(people.map(chunk => chunk.provenance?.iedit?.sectionKey)
      .filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)))].slice(0, 40),
    sources: sources ? sources.length : new Set(chunks.map(chunk =>
      `${chunk.content_type}:${chunk.source_id}`)).size,
  };
}

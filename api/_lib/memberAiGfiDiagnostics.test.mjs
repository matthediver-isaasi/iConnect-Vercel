import test from 'node:test';
import assert from 'node:assert/strict';
import { createGfiAskDiagnostics, summarizeGfiContext } from './memberAiGfiDiagnostics.js';

const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
test('diagnostics are GFI-only and use independent server-generated correlation', () => {
  const entries = [];
  const log = line => entries.push(JSON.parse(line.slice(line.indexOf('{'))));
  createGfiAskDiagnostics({ tenantId: 'other', log })('citations_rejected');
  assert.equal(entries.length, 0);
  const first = createGfiAskDiagnostics({ tenantId, mode: 'member', log });
  first('context_selected', { chunks: 3 });
  first('citations_rejected');
  createGfiAskDiagnostics({ tenantId, mode: 'member', log })('citations_rejected');
  assert.equal(entries[0].traceId, entries[1].traceId);
  assert.notEqual(entries[0].traceId, entries[2].traceId);
  assert.equal(entries[0].mode, 'member');
});

test('untrusted fields and text never enter diagnostic output', () => {
  const entries = [];
  const emit = createGfiAskDiagnostics({ tenantId, mode: 'secret', log: line => entries.push(line) });
  emit('secret', { answer: 'secret' });
  emit('synthesis_completed', {
    answer: 'secret', memberId: 'secret', question: 'secret', traceId: 'secret',
    chunks: 'secret', sources: -1, inputTokens: Infinity, outputTokens: 1.5,
    answerCharacters: 42, valid: 'secret', matchesFallback: true,
  });
  assert.equal(entries.length, 1);
  assert.ok(!entries[0].includes('secret'));
  const data = JSON.parse(entries[0].slice(entries[0].indexOf('{')));
  assert.equal(data.answerCharacters, 42);
  assert.equal(data.matchesFallback, true);
  assert.equal(data.mode, 'unknown');
  assert.equal(data.inputTokens, undefined);
  assert.equal(data.chunks, undefined);
});

test('logger failures cannot change the answer path', () => {
  const emit = createGfiAskDiagnostics({ tenantId, log: () => { throw Error('unavailable'); } });
  assert.doesNotThrow(() => emit('final_sources_rejected', { expectedChunks: 3, remainingChunks: 0 }));
});

test('retrieval boundaries retain counts without exposing candidate contents', () => {
  const lines = [];
  const emit = createGfiAskDiagnostics({ tenantId, mode: 'member', log: line => lines.push(line) });
  const stages = ['candidates_matched', 'similarity_filtered', 'metadata_filtered', 'sources_revalidated'];
  for (const stage of stages) emit(stage, summarizeGfiContext([
    { content_type: 'iedit_page', source_id: 'b1012823-fe46-4cc2-98a7-2e40e3c9ce89', content: 'private' },
  ]));
  assert.equal(lines.length, stages.length);
  lines.forEach((line, i) => {
    const data = JSON.parse(line.slice(line.indexOf('{')));
    assert.equal(data.stage, stages[i]);
    assert.equal(data.peopleChunks, 1);
    assert.ok(!line.includes('private'));
  });
});

test('context summaries count only the specific People source and do not expose text', () => {
  assert.deepEqual(summarizeGfiContext([
    { content_type: 'iedit_page', source_id: 'b1012823-fe46-4cc2-98a7-2e40e3c9ce89', content: 'private' },
    { content_type: 'iedit_page', source_id: 'other', content: 'private' },
  ], [{ citationId: 'S1' }, { citationId: 'S2' }]), { chunks: 2, peopleChunks: 1, sources: 2 });
});

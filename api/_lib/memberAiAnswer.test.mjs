import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCitationSources,
  validateAnswerCitations,
  makeAnswerProvenance,
  verifyAnswerProvenance,
} from './memberAiAnswer.js';
import { preparePersistedMessages, redactHistoryByAuthorizedKeys } from './memberAiHistory.js';

process.env.MEMBER_AI_PROVENANCE_SECRET = 'member-ai-test-secret';

const source = {
  citationId: 'S1',
  title: 'Member guide',
  type: 'resource',
  typeLabel: 'Resource',
  link: '/Resources?resourceId=r1',
  sourceId: 'r1',
  sourceGeneration: '4',
  accessScope: 'authenticated',
  dates: [],
  supportingProvenance: [{
    kind: 'resource_pdf',
    fileId: 'f1',
    dependencies: [{ contentType: 'file_repository', sourceId: 'f1', generation: '8' }],
  }],
};

test('citation sources preserve server provenance and assign stable ids', () => {
  const { sources, sourceByKey } = makeCitationSources([{
    content_type: 'resource', source_id: 'r1', title: 'Member guide',
    link: '/Resources?resourceId=r1', source_generation: source.sourceGeneration,
    access_scope: 'authenticated', provenance: source.supportingProvenance[0],
  }], { resource: 'Resource' });
  assert.equal(sources[0].citationId, 'S1');
  assert.equal(sourceByKey.get('resource:r1').sourceId, 'r1');
});

test('a deduped citation retains every derived-chunk dependency fence', () => {
  const { sources } = makeCitationSources([
    {
      content_type: 'resource', source_id: 'r1', title: 'Member guide',
      link: '/Resources?resourceId=r1', source_generation: 4,
      provenance: {},
    },
    {
      content_type: 'resource', source_id: 'r1', title: 'Member guide',
      link: '/Resources?resourceId=r1', source_generation: 4,
      provenance: {
        kind: 'resource_pdf', fileId: 'f1',
        dependencies: [{ contentType: 'file_repository', sourceId: 'f1', generation: 8 }],
      },
    },
  ], { resource: 'Resource' });
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].supportingProvenance, [
    {},
    {
      kind: 'resource_pdf', fileId: 'f1',
      dependencies: [{ contentType: 'file_repository', sourceId: 'f1', generation: '8' }],
    },
  ]);
});

test('citation cards expose only meaningful authorized source dates, never indexing timestamps', () => {
  const chunks = [
    { content_type: 'news_post', source_id: 'n1', source_generation: 1,
      published_date: '2026-02-24', updated_at: '2026-03-05T10:00:00Z',
      indexed_at: '2026-03-06T10:00:00Z', provenance: {} },
    { content_type: 'event', source_id: 'e1', source_generation: 1,
      start_date: '2026-04-30T09:30:00+01:00', provenance: {} },
    { content_type: 'complex_event', source_id: 'e2', source_generation: 1,
      start_date: '2026-05-10', provenance: {} },
    { content_type: 'blog_post', source_id: 'b1', source_generation: 1,
      published_date: '2026-03-04T12:00:00Z', provenance: {} },
    { content_type: 'resource', source_id: 'r1', source_generation: 1,
      updated_at: '2026-03-05', indexed_at: '2026-03-06', provenance: {} },
    { content_type: 'canvas_page', source_id: 'c1', source_generation: 1,
      source_updated_at: '2026-03-07T10:00:00Z', provenance: {} },
  ];
  const { sources } = makeCitationSources(chunks);
  assert.deepEqual(sources.map(({ dates }) => dates), [
    [{ label: 'Published', value: '2026-02-24' }],
    [{ label: 'Event date', value: '2026-04-30T09:30:00+01:00' }],
    [{ label: 'Event date', value: '2026-05-10' }],
    [{ label: 'Published', value: '2026-03-04T12:00:00Z' }],
    [],
    [],
  ]);
});

test('invalid, unknown and index-only dates are omitted from source cards', () => {
  const { sources } = makeCitationSources([
    { content_type: 'news_post', source_id: 'n1', source_generation: 1,
      published_date: '2026-02-30', indexed_at: '2026-02-28T12:00:00Z', provenance: {} },
    { content_type: 'event', source_id: 'e1', source_generation: 1,
      start_date: 'not-a-date', updated_at: '2026-01-01', provenance: {} },
    { content_type: 'blog_post', source_id: 'b1', source_generation: 1,
      published_date: null, provenance: {} },
  ]);
  assert.deepEqual(sources.map(({ dates }) => dates), [[], [], []]);
});

test('signed provenance and history retain validated dates, rejecting fabricated date labels or values', () => {
  const datedSource = {
    ...source,
    dates: [
      { label: 'Published', value: '2024-02-29' },
      { label: 'Updated', value: '2026-03-04T15:00:00Z' },
      { label: 'Indexed', value: '2026-03-05' },
      { label: 'Event date', value: '2026-13-01' },
      { label: 'Published', value: '2026-03-05' },
    ],
  };
  const expectedDates = [
    { label: 'Published', value: '2024-02-29' },
    { label: 'Updated', value: '2026-03-04T15:00:00Z' },
  ];
  const answer = 'Read it [S1].';
  const token = makeAnswerProvenance({
    tenantId: 'tenant-1', memberId: 'member-1', answer,
    sources: [datedSource], now: Date.now(),
  });
  const verified = verifyAnswerProvenance(token, {
    tenantId: 'tenant-1', memberId: 'member-1', answer,
  });
  assert.deepEqual(verified.sources[0].dates, expectedDates);
  const saved = preparePersistedMessages([
    { role: 'assistant', content: answer, answerProvenance: token,
      sources: [{ ...datedSource, dates: [{ label: 'Published', value: '2099-01-01' }] }] },
  ], { tenantId: 'tenant-1', memberId: 'member-1' });
  assert.deepEqual(saved[0].sources[0].dates, expectedDates);
});

test('answer citations reject model-invented ids and only return cited cards', () => {
  assert.deepEqual(validateAnswerCitations('Read the guide [S1].', [source]).sources, [source]);
  assert.equal(validateAnswerCitations('Read this [S999].', [source]).ok, false);
  assert.equal(validateAnswerCitations('Read the guide.', [source]).ok, false);
  assert.equal(validateAnswerCitations('Read https://example.com [S1].', [source]).ok, false);
});

test('answer provenance binds tenant, member, answer, and source fences', () => {
  const token = makeAnswerProvenance({
    tenantId: 'tenant-1', memberId: 'member-1', answer: 'Read it [S1].',
    sources: [source], now: 1_000,
  });
  assert.deepEqual(verifyAnswerProvenance(token, {
    tenantId: 'tenant-1', memberId: 'member-1', answer: 'Read it [S1].', now: 2_000,
  }), { sources: [source], answerKind: 'content', structuredAccessFingerprint: null });
  assert.equal(verifyAnswerProvenance(token, {
    tenantId: 'tenant-2', memberId: 'member-1', answer: 'Read it [S1].', now: 2_000,
  }), null);
  assert.equal(verifyAnswerProvenance(token, {
    tenantId: 'tenant-1', memberId: 'member-1', answer: 'Changed [S1].', now: 2_000,
  }), null);
});

test('history persistence refuses browser-supplied citations without a matching envelope', () => {
  const token = makeAnswerProvenance({
    tenantId: 'tenant-1', memberId: 'member-1', answer: 'Read it [S1].',
    sources: [source], now: Date.now(),
  });
  const scope = { tenantId: 'tenant-1', memberId: 'member-1' };
  const saved = preparePersistedMessages([
    { role: 'user', content: 'Where is it?' },
    { role: 'assistant', content: 'Read it [S1].', answerProvenance: token, sources: [{ link: 'https://attacker.example' }] },
  ], scope);
  assert.deepEqual(saved?.[1].sources, [source]);
  assert.equal(preparePersistedMessages([
    { role: 'assistant', content: 'Read it [S1].', sources: [source] },
  ], scope), null);
});

test('structured history is redacted if its signed current-access fingerprint no longer matches', () => {
  const result = redactHistoryByAuthorizedKeys(
    [{ id: 'a1', role: 'assistant', content: 'Your current membership total is 3.', sources: [{ _memberAiAnswerKind: 'structured' }] }],
    new Set(),
    new Map([['a1', []]])
  );
  assert.match(result[0].content, /no longer available/i);
});

test('structured history remains visible only for an identical current-access fingerprint', () => {
  const result = redactHistoryByAuthorizedKeys(
    [{
      id: 'a1',
      role: 'assistant',
      content: 'Your current membership total is 3.',
      sources: [{ _memberAiAnswerKind: 'structured', accessFingerprint: 'fingerprint-a' }],
    }],
    new Set(['structured-current']),
    new Map([['a1', ['structured-current']]])
  );
  assert.equal(result[0].content, 'Your current membership total is 3.');
});
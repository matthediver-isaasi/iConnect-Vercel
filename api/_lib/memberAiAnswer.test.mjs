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
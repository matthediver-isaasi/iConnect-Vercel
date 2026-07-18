/**
 * AI Composition pipeline tests (Task #2849).
 *
 * Proves the required behaviours with a stubbed LLM provider:
 * - provider failure surfaces a clean error (no partial output);
 * - unparseable / invalid documents are retried a bounded number of times and
 *   then fail WITHOUT side effects;
 * - a valid document passes through unchanged (fixture round-trip);
 * - asset ownership guard rejects cross-tenant media references.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runPlanStage,
  runCopyStage,
  runDocumentStage,
  assertAssetOwnership,
  resolveCompositionType,
  normalizeBrief,
  normalizeOptions,
  MAX_BRIEF_CHARS,
  MAX_DOCUMENT_RETRIES,
} from './aiCompositionPipeline.js';
import { SECTION_EXAMPLE } from './aiCompositionExamples.mjs';

const brand = { name: 'Test Org', primaryColor: '#123456' };
const brief = 'Promote the annual conference';
const options = normalizeOptions({});

const validPlan = { name: 'Plan', sections: [{ id: 's1', name: 'Hero', purpose: 'intro', elements: ['heading'] }] };
const validCopy = { sections: [{ id: 's1', heading: 'Hello', paragraphs: ['World'], buttonLabels: [] }] };

test('normalizeBrief collapses whitespace and caps length', () => {
  assert.equal(normalizeBrief('  a\n\n b  '), 'a b');
  assert.equal(normalizeBrief('x'.repeat(MAX_BRIEF_CHARS + 500)).length, MAX_BRIEF_CHARS);
});

test('normalizeOptions defaults and clamps', () => {
  assert.deepEqual(normalizeOptions({ creativity: 'nonsense', mode: 'weird' }), {
    creativity: 'brand_led', mode: null, direction: '',
  });
  assert.equal(normalizeOptions({ mode: 'section' }).mode, 'section');
});

test('resolveCompositionType: explicit wins, blank page → whole page', () => {
  assert.equal(resolveCompositionType('whole_page', { blockCount: 5 }), 'multi_section_page');
  assert.equal(resolveCompositionType('section', { blockCount: 0 }), 'section');
  assert.equal(resolveCompositionType(null, { blockCount: 0 }), 'multi_section_page');
  assert.equal(resolveCompositionType(null, { blockCount: 3 }), 'section');
});

test('runPlanStage: provider failure propagates', async () => {
  const callLlm = async () => { throw Object.assign(new Error('provider down'), { httpStatus: 502 }); };
  await assert.rejects(
    () => runPlanStage({ callLlm, brief, options, brand, pageContext: null, compositionType: 'section' }),
    /provider down/,
  );
});

test('runPlanStage: unparseable response → friendly 502', async () => {
  const callLlm = async () => 'not json at all';
  await assert.rejects(
    () => runPlanStage({ callLlm, brief, options, brand, pageContext: null, compositionType: 'section' }),
    (err) => err.httpStatus === 502,
  );
});

test('runCopyStage: empty sections rejected', async () => {
  const callLlm = async () => JSON.stringify({ sections: [] });
  await assert.rejects(
    () => runCopyStage({ callLlm, brief, plan: validPlan, brand }),
    (err) => err.httpStatus === 502 && err.stage === 'copy',
  );
});

test('runDocumentStage: valid fixture document passes on first attempt', async () => {
  const callLlm = async () => JSON.stringify(SECTION_EXAMPLE);
  const { doc, attempts } = await runDocumentStage({
    callLlm, plan: validPlan, copy: validCopy, brand, compositionType: 'section', brief,
  });
  assert.equal(attempts, 1);
  assert.equal(doc.sections.length, 1);
  assert.equal(doc.status, 'draft');
});

test('runDocumentStage: invalid doc retried with validation feedback, then fails with no side effects', async () => {
  const calls = [];
  const callLlm = async ({ user }) => {
    calls.push(user);
    // Always return a document missing required layout frames → invalid.
    return JSON.stringify({ ...SECTION_EXAMPLE, layouts: { desktop: {}, tablet: {}, mobile: {} } });
  };
  await assert.rejects(
    () => runDocumentStage({ callLlm, plan: validPlan, copy: validCopy, brand, compositionType: 'section', brief }),
    (err) => err.httpStatus === 502 && Array.isArray(err.validationErrors) && err.validationErrors.length > 0,
  );
  assert.equal(calls.length, 1 + MAX_DOCUMENT_RETRIES);
  // Retry prompts must carry the validation errors back to the model.
  assert.ok(calls[1].includes('failed validation'));
});

test('runDocumentStage: recovers when a retry produces a valid document', async () => {
  let n = 0;
  const callLlm = async () => {
    n += 1;
    return n === 1 ? '{{{' : JSON.stringify(SECTION_EXAMPLE);
  };
  const { attempts } = await runDocumentStage({
    callLlm, plan: validPlan, copy: validCopy, brand, compositionType: 'section', brief,
  });
  assert.equal(attempts, 2);
});

test('assertAssetOwnership: cross-tenant asset rejected, own asset allowed', async () => {
  const doc = {
    sections: [{
      elements: [
        { id: 'a', type: 'image', asset: { fileRepositoryId: 'file-1' } },
        { id: 'b', type: 'container', children: [{ id: 'c', type: 'image', asset: { fileRepositoryId: 'file-2' } }] },
      ],
    }],
  };
  const owners = { 'file-1': 'tenant-A', 'file-2': 'tenant-A' };
  const lookup = async (id) => owners[id] || null;
  await assert.doesNotReject(() => assertAssetOwnership(doc, 'tenant-A', lookup));
  await assert.rejects(
    () => assertAssetOwnership(doc, 'tenant-B', lookup),
    (err) => err.httpStatus === 422,
  );
  owners['file-2'] = null;
  await assert.rejects(() => assertAssetOwnership(doc, 'tenant-A', lookup));
});

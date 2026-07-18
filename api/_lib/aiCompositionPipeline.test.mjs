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
  normalizeBriefRecords,
  sanitizePlan,
  reconcilePlaceholderRecords,
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
  const o = normalizeOptions({ creativity: 'nonsense', mode: 'weird' });
  assert.equal(o.creativity, 'brand_led');
  assert.equal(o.mode, null);
  assert.equal(o.direction, '');
  // Phase 5 advanced-brief fields default to empty/off.
  assert.equal(o.purpose, '');
  assert.equal(o.audience, '');
  assert.equal(o.desiredAction, '');
  assert.equal(o.contentNotes, '');
  assert.deepEqual(o.records, []);
  assert.equal(o.reviewPlan, false);
  assert.equal(o.generateSeo, false);
  assert.equal(normalizeOptions({ mode: 'section' }).mode, 'section');
  const p5 = normalizeOptions({ purpose: '  drive\nsignups ', reviewPlan: true, generateSeo: 'yes' });
  assert.equal(p5.purpose, 'drive signups');
  assert.equal(p5.reviewPlan, true);
  assert.equal(p5.generateSeo, false); // strict boolean, not truthy coercion
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

test('normalizeBriefRecords: allowlisted kinds + UUID ids only, deduped', () => {
  const out = normalizeBriefRecords([
    { kind: 'event_registration', id: UUID_A, title: '  Annual  Gala ', slug: 'gala' },
    { kind: 'event_registration', id: UUID_A, title: 'dup' },
    { kind: 'event_registration', id: 'not-a-uuid', title: 'bad id' },
    { kind: 'nonsense', id: UUID_B, title: 'bad kind' },
    'garbage',
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { kind: 'event_registration', id: UUID_A, title: 'Annual Gala', slug: 'gala' });
  assert.deepEqual(normalizeBriefRecords('nope'), []);
});

test('sanitizePlan: keeps known fields, filters components and record ids', () => {
  const records = [{ kind: 'event', id: UUID_A, title: 'Gala', slug: 'gala' }];
  const plan = sanitizePlan({
    name: 'My plan',
    audience: 'Members',
    narrative: 'story',
    sections: [
      {
        id: 'hero', name: 'Hero', purpose: 'intro',
        elements: ['heading', 'not_a_real_element'],
        components: [
          { componentKey: 'event_registration', recordId: UUID_A, reason: 'register' },
          { componentKey: 'event_registration', recordId: UUID_B }, // unverified id stripped
          { componentKey: 'made_up_component' }, // dropped entirely
        ],
      },
      null,
    ],
  }, { records });
  assert.equal(plan.name, 'My plan');
  assert.equal(plan.sections.length, 1);
  const s = plan.sections[0];
  assert.deepEqual(s.elements, ['heading']);
  assert.equal(s.components.length, 2);
  assert.equal(s.components[0].recordId, UUID_A);
  assert.equal(s.components[1].recordId, undefined);
  // Empty / invalid plans are rejected.
  assert.equal(sanitizePlan({ sections: [] }), null);
  assert.equal(sanitizePlan(null), null);
});

test('reconcilePlaceholderRecords: strips unverified ids, adds slug for verified', () => {
  const doc = {
    sections: [{
      elements: [
        { id: 'p1', type: 'canvas_component_placeholder', data: { componentKey: 'event_registration', recordId: UUID_A } },
        {
          id: 'c1', type: 'container', children: [
            { id: 'p2', type: 'canvas_component_placeholder', data: { componentKey: 'form', recordId: UUID_B, recordSlug: 'sneaky' } },
          ],
        },
      ],
    }],
  };
  reconcilePlaceholderRecords(doc, [{ kind: 'event', id: UUID_A, title: 'Gala', slug: 'gala' }]);
  const [p1, c1] = doc.sections[0].elements;
  assert.equal(p1.data.recordId, UUID_A);
  assert.equal(p1.data.recordSlug, 'gala');
  assert.equal(c1.children[0].data.recordId, undefined);
  assert.equal(c1.children[0].data.recordSlug, undefined);
});

test('findFirstImageUrl: doc-order first completed image; pending/failed/relative skipped', async () => {
  const { findFirstImageUrl } = await import('./aiCompositionPipeline.js');
  const doc = {
    sections: [
      { elements: [{ id: 'a', type: 'image', asset: { status: 'pending', url: 'https://x/pending.png' } }] },
      {
        elements: [{
          id: 'b', type: 'container', children: [
            { id: 'c', type: 'image', asset: { status: 'failed' } },
            { id: 'd', type: 'image', asset: { fileRepositoryId: 'f1', url: 'https://cdn.example/hero.png' } },
          ],
        }],
      },
    ],
  };
  assert.equal(findFirstImageUrl(doc), 'https://cdn.example/hero.png');
  assert.equal(findFirstImageUrl({ sections: [] }), null);
});

test('runCopyStage: generateSeo cleans and caps the seo block; dropped when absent', async () => {
  const withSeo = async () => JSON.stringify({
    sections: [{ id: 's1', heading: 'Hello', paragraphs: ['World'], buttonLabels: [] }],
    seo: { title: '  Great\nPage ', description: 'x'.repeat(400) },
  });
  const copy = await runCopyStage({ callLlm: withSeo, brief, plan: validPlan, brand, generateSeo: true });
  assert.equal(copy.seo.title, 'Great Page');
  assert.equal(copy.seo.description.length, 170);
  // Without the flag, any seo the model volunteers is discarded.
  const copy2 = await runCopyStage({ callLlm: withSeo, brief, plan: validPlan, brand });
  assert.equal(copy2.seo, undefined);
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

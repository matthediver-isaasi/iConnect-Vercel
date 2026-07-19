// AI Design Studio V2 Phase 6 — design-first workflow tests (Task #2910).
//
// Covers the hard invariants:
//   1. Manifest authority: the approved visual is never authoritative for
//      wording, links, facts or accessibility — the deconstruction sanitizer
//      strips every text/link carrier, and the blueprint prompt block
//      restates the rule.
//   2. Similarity repair-cycle limit: bounded repairs, then WARN — never a
//      rejection on similarity alone.
//   3. Warning path + skipped-compare-never-blocks semantics.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRevisionInstruction,
  buildVisualConceptPrompt,
  buildDeconstructionPrompt,
  parseDeconstructionResponse,
  sanitizeDeconstruction,
  designBlueprintBlock,
  parseSimilarityResponse,
  decideSimilarityOutcome,
  runSimilarityCompare,
  buildVisualWarning,
  MAX_VISUAL_REVISIONS,
} from './aiDesignFirst.js';
import { buildCodePrompt } from './aiCodeGeneration.js';

// ---------------------------------------------------------------------------
// Revision instructions
// ---------------------------------------------------------------------------

test('normalizeRevisionInstruction cleans and bounds the instruction', () => {
  assert.equal(normalizeRevisionInstruction('  make the   hero smaller '), 'make the hero smaller');
  assert.equal(normalizeRevisionInstruction(''), null);
  assert.equal(normalizeRevisionInstruction('ab'), null);
  assert.equal(normalizeRevisionInstruction('x'.repeat(600)).length, 500);
});

test('buildVisualConceptPrompt restates ALL surviving revisions, bounded', () => {
  const revisions = Array.from({ length: 15 }, (_, i) => `revision number ${i + 1}`);
  const prompt = buildVisualConceptPrompt({ brief: 'A hero section', revisions });
  assert.ok(!prompt.includes('revision number 1 '), 'oldest revisions beyond the cap are dropped');
  assert.ok(prompt.includes('revision number 15'));
  assert.ok(prompt.includes(`revision number ${15 - MAX_VISUAL_REVISIONS + 1}`));
  assert.ok(prompt.includes('apply ALL of them'));
});

test('buildVisualConceptPrompt differentiates breakpoints', () => {
  const d = buildVisualConceptPrompt({ brief: 'b', breakpoint: 'desktop' });
  const m = buildVisualConceptPrompt({ brief: 'b', breakpoint: 'mobile' });
  assert.ok(d.includes('DESKTOP'));
  assert.ok(m.includes('MOBILE'));
});

// ---------------------------------------------------------------------------
// 1. Manifest authority — the visual never carries wording/links/facts
// ---------------------------------------------------------------------------

test('sanitizeDeconstruction strips URLs, emails and quoted copy from every field', () => {
  const out = sanitizeDeconstruction({
    sections: [{
      key: 'hero',
      purpose: 'hero',
      layout: 'Two columns, see https://evil.example/phish for details',
      gridProportions: '60/40',
      background: 'Blue gradient "Buy now for £99!" region',
      cardRecipe: 'contact admin@evil.example rounded cards',
      typography: 'Large display heading “Save 50% today” over small caps',
      mediaPlacement: 'right column www.evil.example photo',
    }],
    responsiveIntent: 'stacks vertically, visit https://x.test',
    palette: ['#123456', 'red', '#ABC', 'javascript:alert(1)'],
  });
  const all = JSON.stringify(out);
  assert.ok(!all.includes('evil.example'));
  assert.ok(!all.includes('x.test'));
  assert.ok(!all.includes('Buy now'));
  assert.ok(!all.includes('Save 50%'));
  assert.ok(!all.includes('javascript:'));
  assert.deepEqual(out.palette, ['#123456', '#ABC']);
  assert.equal(out.sections[0].key, 'hero');
});

test('sanitizeDeconstruction whitelists structural fields only and repairs bad keys', () => {
  const out = sanitizeDeconstruction({
    sections: [{
      key: 'Not A Kebab Key!',
      layout: 'single column',
      headline: 'SHOULD NOT SURVIVE',
      ctaLabel: 'Click me',
      href: '/members',
    }],
  });
  const s = out.sections[0];
  assert.equal(s.key, 'visual-section-1');
  assert.ok(!('headline' in s));
  assert.ok(!('ctaLabel' in s));
  assert.ok(!('href' in s));
  assert.deepEqual(
    Object.keys(s).sort(),
    ['background', 'cardRecipe', 'gridProportions', 'key', 'layout', 'mediaPlacement', 'purpose', 'typography'],
  );
});

test('parseDeconstructionResponse rejects junk and empty blueprints', () => {
  assert.equal(parseDeconstructionResponse('not json').ok, false);
  assert.equal(parseDeconstructionResponse('[]').ok, false);
  assert.equal(parseDeconstructionResponse(JSON.stringify({ sections: [] })).ok, false);
  const good = parseDeconstructionResponse(JSON.stringify({
    sections: [{ key: 'hero', layout: 'two columns' }],
  }));
  assert.equal(good.ok, true);
  assert.equal(good.blueprint.sections.length, 1);
});

test('deconstruction prompt forbids transcribing wording and chrome', () => {
  const { system } = buildDeconstructionPrompt({});
  assert.ok(/Never transcribe wording/i.test(system));
  assert.ok(/headers or footers/i.test(system));
});

test('designBlueprintBlock restates that the visual is NOT authoritative for content', () => {
  const block = designBlueprintBlock({
    sections: [{ key: 'hero', purpose: 'hero', layout: 'two columns', gridProportions: '2fr 1fr', background: '', cardRecipe: '', typography: 'big display', mediaPlacement: '' }],
    responsiveIntent: 'stack',
    palette: ['#112233'],
  });
  assert.ok(block.includes('THE VISUAL IS NOT AUTHORITATIVE FOR CONTENT'));
  assert.ok(block.includes('never transcribe text'));
  assert.ok(block.includes('[hero]'));
  assert.equal(designBlueprintBlock(null), '');
  assert.equal(designBlueprintBlock({ sections: [] }), '');
});

test('buildCodePrompt carries the blueprint + concept images without touching the no-blueprint path', () => {
  const base = { brief: 'A hero', brand: null, compositionType: 'section' };
  const without = buildCodePrompt(base);
  const blueprint = {
    sections: [{ key: 'hero', purpose: 'hero', layout: 'two cols', gridProportions: '', background: '', cardRecipe: '', typography: '', mediaPlacement: '' }],
    responsiveIntent: '', palette: [],
  };
  const withBp = buildCodePrompt({
    ...base,
    designBlueprint: blueprint,
    conceptImages: [{ url: 'https://cdn.test/desktop.png' }, { url: 'https://cdn.test/mobile.png' }],
  });
  assert.ok(withBp.user.includes('APPROVED VISUAL BLUEPRINT'));
  assert.ok(withBp.user.includes('THE VISUAL IS NOT AUTHORITATIVE FOR CONTENT'));
  assert.equal(withBp.images.length, without.images.length + 2);
  assert.ok(!without.user.includes('APPROVED VISUAL BLUEPRINT'));
});

// ---------------------------------------------------------------------------
// 2 + 3. Similarity: repair-cycle limit, warning fallback, skipped never blocks
// ---------------------------------------------------------------------------

test('decideSimilarityOutcome passes at/above threshold', () => {
  assert.equal(decideSimilarityOutcome({ similarity: 0.7, threshold: 0.7 }).outcome, 'pass');
  assert.equal(decideSimilarityOutcome({ similarity: 0.95, threshold: 0.7 }).outcome, 'pass');
});

test('decideSimilarityOutcome repairs below threshold while budget remains', () => {
  const d = decideSimilarityOutcome({
    similarity: 0.4, threshold: 0.7, repairCycle: 0, maxRepairCycles: 2,
    differences: ['hero is left-aligned instead of centred'],
  });
  assert.equal(d.outcome, 'repair');
  assert.ok(d.reasons[0].includes('hero is left-aligned'));
  assert.equal(
    decideSimilarityOutcome({ similarity: 0.4, threshold: 0.7, repairCycle: 1, maxRepairCycles: 2 }).outcome,
    'repair',
  );
});

test('decideSimilarityOutcome WARNS (never rejects) once the repair budget is exhausted', () => {
  const d = decideSimilarityOutcome({ similarity: 0.1, threshold: 0.7, repairCycle: 2, maxRepairCycles: 2 });
  assert.equal(d.outcome, 'warn');
  assert.ok(d.reasons.length > 0);
  // maxRepairCycles=0 → straight to warning, still never a rejection.
  assert.equal(
    decideSimilarityOutcome({ similarity: 0, threshold: 0.7, repairCycle: 0, maxRepairCycles: 0 }).outcome,
    'warn',
  );
});

test('decideSimilarityOutcome NEVER produces a rejection for any input', () => {
  // Sweep the input space: only pass / repair / warn are possible outcomes.
  for (const similarity of [-1, 0, 0.3, 0.69, 0.7, 1, 2, NaN]) {
    for (const repairCycle of [0, 1, 2, 99]) {
      for (const status of ['compared', 'skipped']) {
        const d = decideSimilarityOutcome({ status, similarity, repairCycle, maxRepairCycles: 2 });
        assert.ok(['pass', 'repair', 'warn'].includes(d.outcome),
          `unexpected outcome ${d.outcome} for similarity=${similarity} cycle=${repairCycle} status=${status}`);
      }
    }
  }
});

test('buildVisualWarning coerces any prior similarity record to warning, never throws', () => {
  const prev = { status: 'below_threshold', similarity: 0.4, differences: ['x'], threshold: 0.7 };
  const w = buildVisualWarning(prev);
  assert.equal(w.status, 'warning');
  assert.equal(w.similarity, 0.4);
  assert.deepEqual(w.differences, ['x']);
  assert.equal(prev.status, 'below_threshold', 'input not mutated');
  assert.deepEqual(buildVisualWarning(null), { status: 'warning' });
  assert.deepEqual(buildVisualWarning(undefined), { status: 'warning' });
  assert.deepEqual(buildVisualWarning('junk'), { status: 'warning' });
});

test('a skipped compare never blocks — it passes with a skipped flag', () => {
  const d = decideSimilarityOutcome({ status: 'skipped', similarity: 0, repairCycle: 5 });
  assert.equal(d.outcome, 'pass');
  assert.equal(d.skipped, true);
});

test('parseSimilarityResponse clamps and bounds', () => {
  assert.equal(parseSimilarityResponse('junk').ok, false);
  assert.equal(parseSimilarityResponse('{"similarity":"high"}').ok, false);
  const over = parseSimilarityResponse(JSON.stringify({ similarity: 3, differences: Array(10).fill('d') }));
  assert.equal(over.similarity, 1);
  assert.equal(over.differences.length, 6);
  assert.equal(parseSimilarityResponse('{"similarity":-2}').similarity, 0);
});

test('runSimilarityCompare: happy path pairs rendered + concept per breakpoint', async () => {
  let seen;
  const result = await runSimilarityCompare({
    callVision: async (args) => { seen = args; return JSON.stringify({ similarity: 0.8, differences: [] }); },
    renderedShots: [
      { breakpoint: 'desktop', url: 'r-desktop' },
      { breakpoint: 'mobile', url: 'r-mobile' },
      { breakpoint: 'tablet', url: 'r-tablet' }, // no concept for tablet → excluded
    ],
    conceptImages: { desktop: 'c-desktop', mobile: 'c-mobile' },
  });
  assert.equal(result.status, 'compared');
  assert.equal(result.similarity, 0.8);
  assert.equal(seen.images.length, 4);
  assert.deepEqual(seen.images.map((i) => i.url), ['r-desktop', 'c-desktop', 'r-mobile', 'c-mobile']);
});

test('runSimilarityCompare never throws: failures and missing inputs are skipped', async () => {
  const failed = await runSimilarityCompare({
    callVision: async () => { throw new Error('boom'); },
    renderedShots: [{ breakpoint: 'desktop', url: 'r' }],
    conceptImages: { desktop: 'c' },
  });
  assert.equal(failed.status, 'skipped');

  const noVision = await runSimilarityCompare({ callVision: null, renderedShots: [], conceptImages: {} });
  assert.equal(noVision.status, 'skipped');

  const noPairs = await runSimilarityCompare({
    callVision: async () => '{}',
    renderedShots: [{ breakpoint: 'desktop', url: 'r' }],
    conceptImages: {},
  });
  assert.equal(noPairs.status, 'skipped');

  const badJson = await runSimilarityCompare({
    callVision: async () => 'not json',
    renderedShots: [{ breakpoint: 'desktop', url: 'r' }],
    conceptImages: { desktop: 'c' },
  });
  assert.equal(badJson.status, 'skipped');

  // The budget timer is unref'd (never keeps a serverless invocation alive),
  // so the slow call must hold the loop open with a real timer.
  const timedOut = await runSimilarityCompare({
    callVision: () => new Promise((resolve) => setTimeout(() => resolve('{"similarity":1}'), 500)),
    renderedShots: [{ breakpoint: 'desktop', url: 'r' }],
    conceptImages: { desktop: 'c' },
    budgetMs: 20,
  });
  assert.equal(timedOut.status, 'skipped');
});

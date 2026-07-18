// Quality-gate regression tests — Task #2894.
//
// Proves the two contractual outcomes:
//   1. A known-good composition (the hand-authored acceptance fixture from
//      the renderer suite) passes every gate.
//   2. A deliberately broken composition fails EVERY gate with a specific,
//      actionable failure.
// Plus unit coverage for the screenshot-review stage's pure pieces
// (HTML building, verdict parsing, skip semantics).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATE_BREAKPOINT_WIDTHS,
  QUALITY_GATES,
  sanitizePlanContract,
  checkPlanContract,
  derivePromptRequirements,
  checkPromptFulfilment,
  hasRealAction,
  hasMobileRecomposition,
  inspectLayout,
  validateAicStylesheet,
  runQualityGates,
} from './aiCompositionQualityGates.js';
import { buildAicCss } from '../../client/src/lib/aiCompositionRender.js';
import {
  buildGateHtml,
  buildScreenshotReviewPrompt,
  parseScreenshotReview,
  runScreenshotReview,
} from './aiCompositionScreenshotGate.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Known-good composition (mirrors the renderer suite's acceptance fixture):
// two-column desktop grid, one-column mobile override, real CTA link.
const validDoc = {
  schemaVersion: 1,
  id: 'comp_valid',
  name: 'Valid composition',
  compositionType: 'section',
  sections: [
    {
      id: 'sec_a',
      type: 'ai_section',
      readingOrder: ['a_heading', 'a_intro', 'a_grid', 'a_cta'],
      elements: [
        { id: 'a_heading', type: 'heading', role: 'h2', content: { text: 'Why members join' }, style: { fontSize: { value: 32, unit: 'px' } } },
        { id: 'a_intro', type: 'paragraph', content: { text: 'Two good reasons, side by side.' } },
        {
          id: 'a_grid',
          type: 'container',
          children: [
            {
              id: 'a_card_1',
              type: 'card',
              children: [
                { id: 'a_c1_img', type: 'generated_illustration', imageBrief: { subject: 'handshake illustration', styleNotes: 'flat' } },
                { id: 'a_c1_title', type: 'heading', role: 'h3', content: { text: 'Community' } },
                { id: 'a_c1_body', type: 'paragraph', content: { text: 'Meet peers across the sector.' } },
              ],
            },
            {
              id: 'a_card_2',
              type: 'card',
              children: [
                { id: 'a_c2_title', type: 'heading', role: 'h3', content: { text: 'Recognition' } },
                { id: 'a_c2_body', type: 'paragraph', content: { text: 'Professional standing that counts.' } },
              ],
            },
          ],
        },
        { id: 'a_cta', type: 'button', content: { text: 'Apply today' }, link: { kind: 'external', url: 'https://example.org/apply' }, resolvedHref: 'https://example.org/apply' },
      ],
    },
  ],
  layouts: {
    desktop: {
      a_heading: { mode: 'flow', w: 900 },
      a_intro: { mode: 'flow', w: 720 },
      a_grid: { mode: 'grid', w: 1100, grid: { columns: 2, gap: 24 } },
      a_card_1: { mode: 'flow' },
      a_c1_img: { mode: 'flow' },
      a_c1_title: { mode: 'flow' },
      a_c1_body: { mode: 'flow' },
      a_card_2: { mode: 'flow' },
      a_c2_title: { mode: 'flow' },
      a_c2_body: { mode: 'flow' },
      a_cta: { mode: 'flow', w: 220 },
    },
    mobile: {
      a_grid: { mode: 'grid', w: 360, grid: { columns: 1, gap: 16 } },
    },
  },
};

const validPlan = {
  contract: {
    intendedComposition: 'A two-column reasons-to-join section',
    desktopStructure: 'two-column card grid',
    mobileTransformation: 'single column stack',
    requiresIllustration: true,
    requiresCardRecipe: true,
    requiresResponsiveRecomposition: true,
    componentFamilies: ['card'],
  },
};

// Deliberately broken composition: blank section, all-absolute frames stacked
// at the origin, an off-canvas element, an empty container, an unreadably
// dense text box, a CTA with no destination, no mobile recomposition.
function brokenDoc() {
  return {
    schemaVersion: 1,
    id: 'comp_broken',
    name: 'Broken composition',
    compositionType: 'multi_section_page',
    sections: [
      {
        id: 's1',
        type: 'ai_section',
        readingOrder: ['b_head', 'b_para', 'b_sub', 'b_empty', 'b_off', 'b_dense', 'b_cta'],
        elements: [
          { id: 'b_head', type: 'heading', role: 'h2', content: { text: 'Broken hero' }, style: { fontSize: 'NaN' } },
          { id: 'b_para', type: 'paragraph', content: { text: 'Some overlapping paragraph text that stacks on the heading.' } },
          { id: 'b_sub', type: 'paragraph', content: { text: 'A third text piece stacked at the very same origin.' } },
          { id: 'b_empty', type: 'container', children: [] },
          { id: 'b_off', type: 'paragraph', content: { text: 'I live outside the canvas' } },
          { id: 'b_dense', type: 'paragraph', content: { text: 'x'.repeat(400) } },
          { id: 'b_cta', type: 'button', content: { text: 'Click me' } },
        ],
      },
      { id: 's2', type: 'ai_section', readingOrder: [], elements: [] },
    ],
    layouts: {
      desktop: {
        b_head: { mode: 'absolute', x: 0, y: 0, w: 400, h: 60 },
        b_para: { mode: 'absolute', x: 0, y: 0, w: 400, h: 60 },
        b_sub: { mode: 'absolute', x: 0, y: 0, w: 400, h: 60 },
        b_empty: { mode: 'absolute', x: 0, y: 0, w: 400, h: 200 },
        b_off: { mode: 'absolute', x: 1500, y: 40, w: 300, h: 40 },
        b_dense: { mode: 'absolute', x: 20, y: 300, w: 40, h: 40 },
        b_cta: { mode: 'absolute', x: 20, y: 400, w: 0, h: 0 },
      },
    },
  };
}

const brokenPlan = {
  contract: {
    intendedComposition: 'A rich multi-section page',
    requiresIllustration: true,
    requiresCardRecipe: true,
    requiresResponsiveRecomposition: true,
    componentFamilies: ['card'],
  },
};

// ---------------------------------------------------------------------------
// End-to-end gate runs
// ---------------------------------------------------------------------------

test('runQualityGates: the valid acceptance composition passes every gate', () => {
  const result = runQualityGates({ doc: validDoc, plan: validPlan, brief: 'A section on why members join with cards and an illustration' });
  assert.equal(result.ok, true, JSON.stringify(result.failures, null, 2));
  assert.deepEqual(result.failures, []);
  for (const gate of QUALITY_GATES) {
    assert.ok(result.report.gates[gate]?.ok === true, `report covers gate ${gate}`);
  }
});

test('runQualityGates: the broken composition fails EVERY gate', () => {
  const result = runQualityGates({ doc: brokenDoc(), plan: brokenPlan, brief: 'A page with cards and an illustration' });
  assert.equal(result.ok, false);
  const failedGates = new Set(result.failures.map((f) => f.match(/^\[(\w+)\]/)?.[1]));
  for (const gate of QUALITY_GATES) {
    assert.ok(failedGates.has(gate), `broken fixture fails gate "${gate}" (failed: ${[...failedGates].join(', ')})`);
  }
});

// ---------------------------------------------------------------------------
// Individual gates
// ---------------------------------------------------------------------------

test('sanitizePlanContract keeps known fields and drops junk', () => {
  const c = sanitizePlanContract({
    intendedComposition: 'x',
    requiresIllustration: 'yes', // truthy coerces
    componentFamilies: ['card', 42, 'timeline'],
    evil: 'dropped',
  });
  assert.equal(c.intendedComposition, 'x');
  assert.equal(typeof c.requiresIllustration, 'boolean');
  assert.deepEqual(c.componentFamilies, ['card', 'timeline']);
  assert.ok(!('evil' in c));
  assert.equal(sanitizePlanContract(null), null);
});

test('checkPlanContract flags a missing illustration/card/recomposition promise', () => {
  const failures = checkPlanContract(brokenDoc(), brokenPlan);
  assert.ok(failures.length >= 1);
  assert.ok(failures.every((f) => typeof f.message === 'string' && f.message.length));
});

test('checkPromptFulfilment flags briefed features missing from the doc', () => {
  const reqs = derivePromptRequirements({ brief: 'Include testimonial cards and an illustration and a signup button' });
  const failures = checkPromptFulfilment(brokenDoc(), reqs);
  assert.ok(failures.length >= 1);
});

test('hasRealAction: resolved and record-linked CTAs pass, bare CTAs fail', () => {
  assert.equal(hasRealAction({ resolvedHref: '/x' }), true);
  assert.equal(hasRealAction({ link: { kind: 'event', eventId: 'e1' } }), true);
  assert.equal(hasRealAction({ link: { kind: 'membership_application' } }), true);
  assert.equal(hasRealAction({ content: { text: 'Click' } }), false);
});

test('hasMobileRecomposition: mobile grid override counts, no overrides does not', () => {
  assert.equal(hasMobileRecomposition(validDoc), true);
  assert.equal(hasMobileRecomposition(brokenDoc()), false);
});

test('inspectLayout reports each deterministic defect class on the broken fixture', () => {
  const failures = inspectLayout(brokenDoc());
  const codes = new Set(failures.map((f) => f.code));
  for (const code of ['blank_section', 'empty_container', 'zero_size', 'off_canvas', 'text_density', 'stacked_at_origin', 'text_overlap']) {
    assert.ok(codes.has(code), `expected defect "${code}" (got: ${[...codes].join(', ')})`);
  }
});

test('inspectLayout does NOT flag inherited desktop frames on narrower breakpoints', () => {
  // A desktop-authored absolute frame wider than the mobile canvas is an
  // expected renderer-handled condition, not a generation defect.
  const doc = {
    schemaVersion: 1,
    id: 'c',
    compositionType: 'section',
    sections: [{
      id: 's1', type: 'ai_section', readingOrder: ['wide'],
      elements: [{ id: 'wide', type: 'paragraph', content: { text: 'Wide but fine on desktop, inherited below.' } }],
    }],
    layouts: { desktop: { wide: { mode: 'absolute', x: 40, y: 40, w: 1100, h: 80 } }, mobile: { wide: { mode: 'flow' } } },
  };
  const failures = inspectLayout(doc);
  assert.deepEqual(failures.filter((f) => f.code === 'off_canvas'), []);
});

test('validateAicStylesheet: renderer CSS for the valid doc passes; corrupt CSS fails', () => {
  const good = validateAicStylesheet(buildAicCss(validDoc, 'gate'));
  assert.equal(good.ok, true, JSON.stringify(good.errors, null, 2));
  assert.deepEqual(good.errors, []);

  const bad = validateAicStylesheet('[data-aic="x"] .aic-e-a{width:NaN;left:100}\n.unscoped{color:red}');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((f) => f.message.includes('NaN')));
  assert.ok(bad.errors.length >= 2);
});

// ---------------------------------------------------------------------------
// Screenshot review stage (pure pieces + skip semantics)
// ---------------------------------------------------------------------------

test('buildGateHtml produces a scoped static page with the renderer stylesheet applied', () => {
  const html = buildGateHtml(validDoc, { breakpoint: 'mobile' });
  assert.ok(html.includes('data-aic="gate"'));
  assert.ok(html.includes('aic-s-sec_a'));
  assert.ok(html.includes('aic-e-a_heading'));
  assert.ok(html.includes('Apply today'));
  // Unresolved illustration renders a visible placeholder, not a broken img.
  assert.ok(!html.includes('<img class="aic-e-a_c1_img"'));
});

test('parseScreenshotReview fills missing breakpoints as pass and rejects garbage', () => {
  const bps = Object.keys(GATE_BREAKPOINT_WIDTHS);
  const parsed = parseScreenshotReview(JSON.stringify({
    verdicts: [{ breakpoint: 'mobile', pass: false, issues: ['text stacked'] }],
  }), bps);
  assert.equal(parsed.mobile.pass, false);
  assert.deepEqual(parsed.mobile.issues, ['text stacked']);
  assert.equal(parsed.desktop.pass, true);
  assert.equal(parseScreenshotReview('not json', bps), null);
});

test('runScreenshotReview degrades to skipped when browserless is unconfigured', async () => {
  const prev = process.env.BROWSERLESS_API_TOKEN;
  delete process.env.BROWSERLESS_API_TOKEN;
  try {
    const result = await runScreenshotReview({ doc: validDoc, callVision: async () => '{}' });
    assert.equal(result.status, 'skipped');
    assert.ok(result.reason.includes('not configured'));
  } finally {
    if (prev !== undefined) process.env.BROWSERLESS_API_TOKEN = prev;
  }
});

test('runScreenshotReview fails only the breakpoints the reviewer failed', async () => {
  const prev = process.env.BROWSERLESS_API_TOKEN;
  process.env.BROWSERLESS_API_TOKEN = 'test-token';
  try {
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const callVision = async () => JSON.stringify({
      verdicts: [
        { breakpoint: 'desktop', pass: true },
        { breakpoint: 'tablet', pass: true },
        { breakpoint: 'mobile', pass: false, issues: ['content cut off'] },
      ],
    });
    const result = await runScreenshotReview({ doc: validDoc, callVision, fetchImpl });
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.failedBreakpoints, ['mobile']);
    assert.equal(result.breakpoints.desktop.pass, true);

    // Capture failure degrades to skipped, never fail.
    const broken = await runScreenshotReview({
      doc: validDoc,
      callVision,
      fetchImpl: async () => { throw new Error('network down'); },
    });
    assert.equal(broken.status, 'skipped');

    // Budget guard: a slow screenshot service degrades to `skipped` within
    // the wall-clock budget, never a hung invocation (serverless constraint).
    const slow = await runScreenshotReview({
      doc: validDoc,
      callVision,
      fetchImpl: () => new Promise(() => {}), // never resolves
      budgetMs: 200,
    });
    assert.equal(slow.status, 'skipped');
    assert.ok(slow.reason.includes('budget') || slow.reason.includes('capture failed'));

    // Budget guard on the vision call: captures succeed, reviewer hangs.
    const slowVision = await runScreenshotReview({
      doc: validDoc,
      callVision: () => new Promise(() => {}),
      fetchImpl,
      budgetMs: 300,
    });
    assert.equal(slowVision.status, 'skipped');
  } finally {
    if (prev !== undefined) process.env.BROWSERLESS_API_TOKEN = prev;
    else delete process.env.BROWSERLESS_API_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// New contract checks: required assets, component families, reference recipe
// ---------------------------------------------------------------------------

test('checkPlanContract: missing_required_assets when delivered visuals fall short of declared', () => {
  const plan = { contract: { requiredAssets: ['hero photo', 'team illustration', 'stats chart'] } };
  const failures = checkPlanContract(brokenDoc(), plan);
  assert.ok(failures.some((f) => f.code === 'missing_required_assets'));
  // The valid doc has one illustration; declaring one asset passes.
  const okPlan = { contract: { requiredAssets: ['illustration'] } };
  assert.ok(!checkPlanContract(validDoc, okPlan).some((f) => f.code === 'missing_required_assets'));
});

test('checkPlanContract: missing_component_family for recognised families only', () => {
  const plan = { contract: { componentFamilies: ['timeline', 'card', 'artisanal widget'] } };
  const failures = checkPlanContract(validDoc, plan);
  const fams = failures.filter((f) => f.code === 'missing_component_family').map((f) => f.family);
  assert.ok(fams.includes('timeline'), 'timeline promised but absent must fail');
  assert.ok(!fams.includes('card'), 'card is present, must not fail');
  assert.ok(!fams.includes('artisanal widget'), 'unrecognised family must be skipped, never guessed');
});

test('checkPromptFulfilment: missing_reference_recipe enforced only when a style reference was used', () => {
  const withRef = derivePromptRequirements({ brief: 'Make a section', options: { styleReference: { analysisId: 'a1' } } });
  assert.equal(withRef.referenceRecipe, true);
  const failures = checkPromptFulfilment(brokenDoc(), withRef);
  assert.ok(failures.some((f) => f.code === 'missing_reference_recipe'));
  // Valid doc has cards → recipe evidence present.
  assert.ok(!checkPromptFulfilment(validDoc, withRef).some((f) => f.code === 'missing_reference_recipe'));
  // No reference → never enforced.
  const noRef = derivePromptRequirements({ brief: 'Make a section' });
  assert.ok(!checkPromptFulfilment(brokenDoc(), noRef).some((f) => f.code === 'missing_reference_recipe'));
});

test('buildScreenshotReviewPrompt: semantic rubric always present; reference rule only with hasReference', () => {
  const base = buildScreenshotReviewPrompt({ doc: validDoc });
  for (const phrase of ['broken visual hierarchy', 'missing visual concept', 'unbalanced empty space', 'naive shrink']) {
    assert.ok(base.system.includes(phrase), `rubric must include "${phrase}"`);
  }
  assert.ok(!base.system.includes('reference design language'));
  const withRef = buildScreenshotReviewPrompt({ doc: validDoc, hasReference: true });
  assert.ok(withRef.system.includes('reference design language'));
});

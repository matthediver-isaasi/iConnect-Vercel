/**
 * Phase 0 tests for the AI Composition schema validator draft.
 *
 * Proves: (1) both example fixtures pass validation, and (2) the validator
 * rejects the specific failure modes the spec calls out — invented internal
 * URLs, non-allowlisted CSS, unsafe markup, missing reading order, unknown
 * element types, layouts referencing unknown elements, and malformed patches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateComposition,
  validatePatch,
  repairComposition,
  ELEMENT_TYPES,
  CSS_PROPERTY_ALLOWLIST,
} from './aiCompositionSchema.js';
import { WHOLE_PAGE_EXAMPLE, SECTION_EXAMPLE } from './aiCompositionExamples.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

test('whole-page example document validates', () => {
  const result = validateComposition(WHOLE_PAGE_EXAMPLE);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('single-section example document validates', () => {
  const result = validateComposition(SECTION_EXAMPLE);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('rejects unsupported schemaVersion', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.schemaVersion = 99;
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
});

test('rejects internal links carrying raw URLs (record IDs only)', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[3].link = { kind: 'form', formId: 'https://example.com/form' };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('raw URL')));
});

test('rejects internal link values that are not well-formed identifiers', () => {
  for (const badLink of [
    { kind: 'form', formId: 'javascript:alert(1)' },
    { kind: 'form', formId: 'not-a-uuid' },
    { kind: 'page', pageId: '12345' },
    { kind: 'event_registration', eventId: 'DROP TABLE events' },
    { kind: 'anchor', anchorId: 'has spaces' },
    { kind: 'email', address: 'not-an-email' },
    { kind: 'tel', number: 'call-me-maybe' },
  ]) {
    const doc = clone(SECTION_EXAMPLE);
    doc.sections[0].elements[3].link = badLink;
    const result = validateComposition(doc);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(badLink)}`);
  }
});

test('rejects transform values outside the rotate/translate/scale subset', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[0].style = { transform: 'skewX(20deg)' };
  assert.equal(validateComposition(doc).ok, false);

  const doc2 = clone(SECTION_EXAMPLE);
  doc2.sections[0].elements[0].style = { transform: 'rotate(3deg) translateY(-4px)' };
  assert.equal(validateComposition(doc2).ok, true);
});

test('rejects non-http(s) external links', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[3].link = { kind: 'external', url: 'javascript:alert(1)' };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
});

test('rejects style properties outside the allowlist', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[0].style = { position: 'fixed' };
  assert.equal(CSS_PROPERTY_ALLOWLIST.has('position'), false);
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not in the allowlist')));
});

test('rejects unsafe CSS values (url(), !important)', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[0].style = { color: 'red !important' };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);

  const doc2 = clone(SECTION_EXAMPLE);
  doc2.sections[0].elements[0].style = { backgroundImage: 'url(https://evil.example/x.png)' };
  assert.equal(validateComposition(doc2).ok, false);
});

test('rejects unsafe HTML content (script tags, event handlers)', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[1].content = { html: '<p onclick="steal()">hi</p>' };
  assert.equal(validateComposition(doc).ok, false);

  const doc2 = clone(SECTION_EXAMPLE);
  doc2.sections[0].elements[1].content = { html: '<script>alert(1)</script>' };
  assert.equal(validateComposition(doc2).ok, false);
});

test('rejects missing or incomplete readingOrder', () => {
  const doc = clone(SECTION_EXAMPLE);
  delete doc.sections[0].readingOrder;
  assert.equal(validateComposition(doc).ok, false);

  const doc2 = clone(SECTION_EXAMPLE);
  doc2.sections[0].readingOrder = doc2.sections[0].readingOrder.slice(1);
  const result = validateComposition(doc2);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('readingOrder is missing')));
});

test('rejects unknown element types', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[0].type = 'marquee';
  assert.equal(ELEMENT_TYPES.includes('marquee'), false);
  assert.equal(validateComposition(doc).ok, false);
});

test('rejects duplicate element ids across sections', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  doc.sections[1].elements[0].id = 'hero_heading';
  doc.sections[1].readingOrder[0] = 'hero_heading';
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate element id')));
});

test('rejects layout frames referencing unknown elements and missing desktop frames', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.layouts.desktop.ghost_element = { mode: 'flow' };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown element "ghost_element"')));

  const doc2 = clone(SECTION_EXAMPLE);
  delete doc2.layouts.desktop.process_cta;
  const result2 = validateComposition(doc2);
  assert.equal(result2.ok, false);
  assert.ok(result2.errors.some((e) => e.includes('missing frame for element "process_cta"')));
});

test('rejects protectedValues referencing unknown elements', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.protectedValues[0].elementId = 'nope';
  assert.equal(validateComposition(doc).ok, false);
});

test('section compositionType must have exactly one section', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  doc.compositionType = 'section';
  assert.equal(validateComposition(doc).ok, false);
});

test('image elements require an asset reference', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements.push({ id: 'img_1', type: 'image' });
  doc.sections[0].readingOrder.push('img_1');
  doc.layouts.desktop.img_1 = { mode: 'flow' };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('requires an asset reference')));
});

// ---------------------------------------------------------------------------
// repairComposition — mechanical self-healing (readingOrder + desktop frames)
// ---------------------------------------------------------------------------

test('repairComposition appends missing readingOrder entries in document order without touching existing ones', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  const original = clone(doc);
  const removed = doc.sections[0].readingOrder.splice(1, 2); // drop 2 of 4
  const remaining = [...doc.sections[0].readingOrder];

  const { doc: repaired, repairs } = repairComposition(doc);
  assert.equal(repairs.length, 2);
  // Existing entries preserved in place; missing ids appended in document order.
  assert.deepEqual(repaired.sections[0].readingOrder.slice(0, remaining.length), remaining);
  assert.deepEqual([...repaired.sections[0].readingOrder].sort(), [...original.sections[0].readingOrder].sort());
  for (const id of removed) {
    assert.ok(repaired.sections[0].readingOrder.includes(id));
  }
  assert.deepEqual(validateComposition(repaired).errors, []);
  // Input never mutated.
  doc.sections[0].readingOrder = original.sections[0].readingOrder;
  assert.deepEqual(doc, original);
});

test('repairComposition creates a wholly absent readingOrder from document order', () => {
  const doc = clone(SECTION_EXAMPLE);
  delete doc.sections[0].readingOrder;
  const { doc: repaired, repairs } = repairComposition(doc);
  assert.equal(repairs.length, 1);
  assert.deepEqual(
    repaired.sections[0].readingOrder,
    repaired.sections[0].elements.map((e) => e.id)
  );
  assert.deepEqual(validateComposition(repaired).errors, []);
});

test('repairComposition synthesizes a small number of missing desktop frames (inherit > stack > flow)', () => {
  // Inherit from mobile when a mobile frame exists.
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  const mobileFrame = clone(doc.layouts.mobile.hero_cta);
  delete doc.layouts.desktop.hero_cta;
  const { doc: repaired, repairs } = repairComposition(doc);
  assert.equal(repairs.length, 1);
  assert.ok(repairs[0].includes('mobile'));
  assert.deepEqual(repaired.layouts.desktop.hero_cta, mobileFrame);
  assert.deepEqual(validateComposition(repaired).errors, []);

  // No tablet/mobile frame + absolute section → stacked below last framed element.
  const doc2 = clone(WHOLE_PAGE_EXAMPLE);
  delete doc2.layouts.desktop.hero_sub;
  delete doc2.layouts.mobile.hero_sub;
  const { doc: repaired2, repairs: repairs2 } = repairComposition(doc2);
  assert.equal(repairs2.length, 1);
  const frame = repaired2.layouts.desktop.hero_sub;
  assert.equal(frame.mode, 'absolute');
  assert.ok(frame.y >= 560, 'stacked below the section bottom'); // hero_bg bottom = 560
  assert.deepEqual(validateComposition(repaired2).errors, []);

  // Flow-based section → flow frame.
  const doc3 = clone(WHOLE_PAGE_EXAMPLE);
  delete doc3.layouts.desktop.register_copy;
  const { doc: repaired3 } = repairComposition(doc3);
  assert.deepEqual(repaired3.layouts.desktop.register_copy, { mode: 'flow' });
  assert.deepEqual(validateComposition(repaired3).errors, []);
});

test('repairComposition never overwrites existing frames or changes content/protected values', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  delete doc.sections[0].readingOrder;
  delete doc.layouts.desktop.hero_cta;
  const { doc: repaired } = repairComposition(doc);
  // Content, protected values and untouched frames are byte-identical.
  assert.deepEqual(repaired.sections.map((s) => s.elements), doc.sections.map((s) => s.elements));
  assert.deepEqual(repaired.protectedValues, doc.protectedValues);
  assert.deepEqual(repaired.layouts.desktop.hero_bg, doc.layouts.desktop.hero_bg);
  assert.deepEqual(repaired.layouts.mobile, doc.layouts.mobile);
});

test('repairComposition refuses to repair a section missing most of its frames', () => {
  const doc = clone(SECTION_EXAMPLE);
  const ids = Object.keys(doc.layouts.desktop);
  // Remove most frames — beyond the per-section cap.
  for (const id of ids.slice(1)) delete doc.layouts.desktop[id];
  delete doc.layouts.mobile;
  const { doc: repaired, repairs } = repairComposition(doc);
  assert.deepEqual(repairs, []);
  assert.equal(repaired, doc, 'no-repair returns the original doc');
  assert.equal(validateComposition(repaired).ok, false);
});

test('repairComposition leaves genuinely invalid documents failing (unknown refs, duplicates)', () => {
  // Unknown readingOrder ref is never removed.
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].readingOrder.push('ghost_element');
  const { doc: repaired } = repairComposition(doc);
  assert.ok(repaired.sections[0].readingOrder.includes('ghost_element'));
  assert.equal(validateComposition(repaired).ok, false);

  // Frame referencing an unknown element is untouched.
  const doc2 = clone(SECTION_EXAMPLE);
  doc2.layouts.desktop.ghost_element = { mode: 'flow' };
  const { doc: repaired2 } = repairComposition(doc2);
  assert.equal(validateComposition(repaired2).ok, false);
});

// --- invalid nesting repairs (Task: repair invalid nesting in AI drafts) ---

/** Rebuild the whole-page hero section into the failed-job shape: a
 * `background` element wrapping the section's real content as children,
 * leaf elements carrying empty children arrays, and readingOrder pointing
 * at the nested ids. */
function nestHeroSection(doc) {
  const hero = doc.sections[0];
  const [bg, ...rest] = hero.elements;
  bg.children = rest;
  rest[0].children = []; // heading with a stray empty children key
  hero.elements = [bg];
  hero.readingOrder = ['hero_bg', 'hero_heading', 'hero_sub', 'hero_cta'];
  return doc;
}

test('repairComposition hoists children out of a background element and validates', () => {
  const doc = nestHeroSection(clone(WHOLE_PAGE_EXAMPLE));
  const original = clone(doc);
  // Sanity: this shape fails validation before repair, with the failed job's errors.
  const before = validateComposition(clone(doc));
  assert.equal(before.ok, false);
  assert.ok(before.errors.some((e) => e.includes('cannot have children')));

  const { doc: repaired, repairs } = repairComposition(doc);
  assert.ok(repairs.some((r) => r.includes('hoisted 3 children out of non-container "hero_bg"')));
  assert.ok(repairs.some((r) => r.includes('removed empty children from non-container "hero_heading"')));
  // Hoisted elements keep ids/content and land after the ex-parent in order.
  assert.deepEqual(
    repaired.sections[0].elements.map((e) => e.id),
    ['hero_bg', 'hero_heading', 'hero_sub', 'hero_cta']
  );
  assert.equal(repaired.sections[0].elements[0].children, undefined);
  assert.equal(repaired.sections[0].elements[1].children, undefined);
  assert.deepEqual(repaired.sections[0].elements[1].content, { text: 'Shaping the profession together' });
  // readingOrder refs that were "unknown" now resolve; frames untouched.
  assert.deepEqual(validateComposition(repaired).errors, []);
  assert.deepEqual(repaired.layouts, WHOLE_PAGE_EXAMPLE.layouts);
  // Input never mutated.
  assert.deepEqual(doc, original);
});

test('repairComposition strips empty children keys from leaf types without hoisting', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[1].children = [];
  const { doc: repaired, repairs } = repairComposition(doc);
  assert.equal(repairs.length, 1);
  assert.ok(repairs[0].includes('removed empty children'));
  assert.equal(repaired.sections[0].elements[1].children, undefined);
  assert.deepEqual(validateComposition(repaired).errors, []);
});

test('repairComposition fixes nesting inside legitimate containers (depth-first)', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  // Nest a paragraph under a statistic INSIDE a card (a real container).
  const card = doc.sections[1].elements[1].children[0];
  const [stat, para] = card.children;
  stat.children = [para];
  card.children = [stat];
  const { doc: repaired, repairs } = repairComposition(doc);
  assert.ok(repairs.some((r) => r.includes('hoisted 1 children out of non-container "benefit_1_stat"')));
  assert.deepEqual(
    repaired.sections[1].elements[1].children[0].children.map((e) => e.id),
    ['benefit_1_stat', 'benefit_1_copy']
  );
  assert.deepEqual(validateComposition(repaired).errors, []);
});

test('repairComposition refuses to hoist beyond the per-section cap', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  const hero = doc.sections[0];
  // 4 non-container parents each carrying a child → over the cap of 3.
  hero.elements = hero.elements.map((el, i) => ({
    ...el,
    children: [{ id: `nested_${i}`, type: 'paragraph', content: { text: 'x' } }],
  }));
  const { doc: repaired, repairs } = repairComposition(doc);
  assert.ok(!repairs.some((r) => r.includes('hoisted')), 'no hoists over the cap');
  assert.equal(validateComposition(repaired).ok, false);
});

test('repairComposition is a no-op on already-valid documents', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  const { doc: repaired, repairs } = repairComposition(doc);
  assert.deepEqual(repairs, []);
  assert.equal(repaired, doc);
});

// ---------------------------------------------------------------------------
// Geometry & hierarchy validation (Task #2893) — the broken-in-production
// failure modes must now be rejected at validation time.
// ---------------------------------------------------------------------------

test('rejects absolute frames with null/missing x, y or w on the effective frame', () => {
  // Null w (verbatim from the broken production doc).
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  doc.layouts.desktop.hero_bg = { mode: 'absolute', x: 0, y: 0, w: null, h: null };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('positive numeric w')));

  // Missing y.
  const doc2 = clone(WHOLE_PAGE_EXAMPLE);
  doc2.layouts.desktop.hero_cta = { mode: 'absolute', x: 510, w: 180, h: 48 };
  const result2 = validateComposition(doc2);
  assert.equal(result2.ok, false);
  assert.ok(result2.errors.some((e) => e.includes('numeric x and y')));

  // But h: null (content height) with numeric x/y/w stays valid (examples use it).
  assert.deepEqual(validateComposition(clone(WHOLE_PAGE_EXAMPLE)).errors, []);
});

test('partial breakpoint overrides stay valid; a breaking override is caught on the merged frame', () => {
  // The examples already carry partial mobile overrides — they must pass.
  assert.equal(validateComposition(clone(WHOLE_PAGE_EXAMPLE)).ok, true);

  // A mobile override that nulls the width breaks the EFFECTIVE mobile frame.
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  doc.layouts.mobile.hero_cta = { w: null };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('(mobile)') && e.includes('hero_cta')));
});

test('rejects a section whose absolute layout resolves to zero height', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  // Every absolute frame collapses to y:0, h:0 → the section renders 0px tall.
  for (const id of ['hero_bg', 'hero_heading', 'hero_sub', 'hero_cta']) {
    doc.layouts.desktop[id] = { mode: 'absolute', x: 0, y: 0, w: 1200, h: 0, minH: 0 };
  }
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('zero height')));
});

test('rejects flex/grid containers without children', () => {
  const doc = clone(WHOLE_PAGE_EXAMPLE);
  doc.sections[1].elements[1].children = [];
  doc.layouts.desktop = Object.fromEntries(
    Object.entries(doc.layouts.desktop).filter(([id]) => !id.startsWith('benefit_')),
  );
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"benefits_grid" is grid but has no children')));
});

test('rejects absolute children inside flex/grid containers', () => {
  const doc = clone(SECTION_EXAMPLE);
  // process_steps is a flex container; step_1 opts out into absolute.
  doc.layouts.desktop.step_1 = { mode: 'absolute', x: 0, y: 0, w: 300, h: 100 };
  const result = validateComposition(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('children of flex/grid containers must not be absolute')));
});

test('style { value, unit } objects validate by shape — never as "[object Object]"', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.sections[0].elements[0].style = { fontSize: { value: 32, unit: 'px' } };
  assert.deepEqual(validateComposition(doc).errors, []);

  const doc2 = clone(SECTION_EXAMPLE);
  doc2.sections[0].elements[0].style = { fontSize: { value: 'big', unit: 'px' } };
  const result2 = validateComposition(doc2);
  assert.equal(result2.ok, false);
  assert.ok(result2.errors.some((e) => e.includes('object value must be')));

  const doc3 = clone(SECTION_EXAMPLE);
  doc3.sections[0].elements[0].style = { fontSize: { value: 16, unit: 'pt' } };
  assert.equal(validateComposition(doc3).ok, false);
});

test('validatePatch accepts well-formed patches', () => {
  const result = validatePatch([
    { op: 'update_content', elementId: 'heading_01', changes: { text: 'New heading' } },
    { op: 'update_link', elementId: 'button_01', changes: { link: { kind: 'event_registration', eventId: '4f6f2f9e-0000-4000-8000-000000000001' } } },
    { op: 'update_style', elementId: 'card_02', breakpoint: 'mobile', changes: { style: { opacity: '0.9' } } },
    { op: 'reorder_sections', order: ['a', 'b'] },
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('validatePatch rejects unknown ops, missing targets, bad breakpoints and raw-URL links', () => {
  assert.equal(validatePatch([{ op: 'run_sql', elementId: 'x' }]).ok, false);
  assert.equal(validatePatch([{ op: 'update_content' }]).ok, false);
  assert.equal(validatePatch([{ op: 'update_style', elementId: 'x', breakpoint: 'watch' }]).ok, false);
  assert.equal(
    validatePatch([{ op: 'update_link', elementId: 'x', changes: { link: { kind: 'page', pageId: 'https://evil.example' } } }]).ok,
    false
  );
  assert.equal(validatePatch([]).ok, false);
});

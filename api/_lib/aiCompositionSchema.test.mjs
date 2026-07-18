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

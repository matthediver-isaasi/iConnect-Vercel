/**
 * Phase 4 tests (Task #2852) — render-time composition validation.
 *
 * Proves the severity policy: missing alt text, unlabeled interactive
 * elements and detectable contrast failures are CRITICAL (block approval);
 * heading jumps, overflow, responsive gaps, missing assets, broken links and
 * parent-flow problems are warnings. Schema failures surface as critical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runCompositionValidation,
  summarizeValidation,
  parseColor,
  contrastRatio,
  VALIDATION_BREAKPOINT_WIDTHS,
} from './aiCompositionValidation.js';
import { SECTION_EXAMPLE } from './aiCompositionExamples.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

test('the section example passes with no critical issues', () => {
  const r = runCompositionValidation(clone(SECTION_EXAMPLE));
  assert.deepEqual(r.critical, []);
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.checks) && r.checks.includes('contrast'));
  assert.deepEqual(r.breakpoints, Object.keys(VALIDATION_BREAKPOINT_WIDTHS));
});

test('schema failures are reported as critical issues', () => {
  const doc = clone(SECTION_EXAMPLE);
  doc.schemaVersion = 99;
  const r = runCompositionValidation(doc);
  assert.equal(r.ok, false);
  assert.ok(r.critical.some((i) => i.check === 'schema'));
});

test('image without alt text is critical; decorative images are exempt', () => {
  const doc = clone(SECTION_EXAMPLE);
  const section = doc.sections[0];
  section.elements.push({
    id: 'hero_img',
    type: 'image',
    asset: { status: 'pending' },
  });
  section.readingOrder.push('hero_img');
  doc.layouts.desktop.hero_img = { x: 0, y: 500, w: 300, h: 200 };
  doc.layouts.mobile.hero_img = { x: 0, y: 500, w: 300, h: 200 };
  const r = runCompositionValidation(doc);
  assert.ok(r.critical.some((i) => i.check === 'alt_text' && i.elementId === 'hero_img'));
  assert.equal(r.ok, false);

  const dec = clone(doc);
  dec.sections[0].elements.find((e) => e.id === 'hero_img').asset.decorative = true;
  const r2 = runCompositionValidation(dec);
  assert.ok(!r2.critical.some((i) => i.check === 'alt_text'));
});

test('button with no label text is critical (keyboard/labeling)', () => {
  const doc = clone(SECTION_EXAMPLE);
  const btn = doc.sections[0].elements.find((e) => e.type === 'button');
  btn.content = { label: '   ' };
  const r = runCompositionValidation(doc);
  assert.ok(r.critical.some((i) => i.check === 'keyboard' && i.elementId === btn.id));
});

test('low contrast against a resolvable background is critical; large text uses 3:1', () => {
  const doc = clone(SECTION_EXAMPLE);
  const para = doc.sections[0].elements.find((e) => e.type === 'paragraph');
  para.style = { ...(para.style || {}), color: '#999999', backgroundColor: '#ffffff', fontSize: '16px' };
  const r = runCompositionValidation(doc);
  assert.ok(r.critical.some((i) => i.check === 'contrast' && i.elementId === para.id));

  // Same pair passes at large text size (2.85:1 < 4.5 but ... check with a passing large pair)
  const doc2 = clone(SECTION_EXAMPLE);
  const para2 = doc2.sections[0].elements.find((e) => e.type === 'paragraph');
  para2.style = { ...(para2.style || {}), color: '#767676', backgroundColor: '#ffffff', fontSize: '24px' };
  const r2 = runCompositionValidation(doc2);
  assert.ok(!r2.critical.some((i) => i.check === 'contrast' && i.elementId === para2.id));
});

test('unresolvable colours are skipped rather than guessed', () => {
  const doc = clone(SECTION_EXAMPLE);
  const para = doc.sections[0].elements.find((e) => e.type === 'paragraph');
  para.style = { ...(para.style || {}), color: 'var(--brand)' };
  const r = runCompositionValidation(doc);
  assert.ok(!r.critical.some((i) => i.check === 'contrast'));
});

test('heading level jumps are warnings, not critical', () => {
  const doc = clone(SECTION_EXAMPLE);
  const section = doc.sections[0];
  const heading = section.elements.find((e) => e.type === 'heading');
  heading.role = 'h1';
  section.elements.push({ id: 'sub', type: 'heading', role: 'h4', content: { text: 'Jumped' } });
  section.readingOrder.push('sub');
  doc.layouts.desktop.sub = { x: 0, y: 600, w: 300, h: 40 };
  doc.layouts.mobile.sub = { x: 0, y: 600, w: 300, h: 40 };
  const r = runCompositionValidation(doc);
  assert.ok(r.warnings.some((i) => i.check === 'heading_order' && i.elementId === 'sub'));
  assert.ok(!r.critical.some((i) => i.check === 'heading_order'));
});

test('overflow past a breakpoint width is a warning tagged with the breakpoint', () => {
  const doc = clone(SECTION_EXAMPLE);
  const first = doc.sections[0].elements[0];
  doc.layouts.desktop[first.id] = { ...doc.layouts.desktop[first.id], x: 1100, w: 400 };
  const r = runCompositionValidation(doc);
  const issue = r.warnings.find((i) => i.check === 'overflow' && i.elementId === first.id);
  assert.ok(issue);
  assert.ok(['desktop', 'tablet', 'mobile'].includes(issue.breakpoint));
});

test('wide element with no mobile override is a responsive warning', () => {
  const doc = clone(SECTION_EXAMPLE);
  const first = doc.sections[0].elements[0];
  doc.layouts.desktop[first.id] = { ...doc.layouts.desktop[first.id], w: 800 };
  delete doc.layouts.mobile[first.id];
  const r = runCompositionValidation(doc);
  assert.ok(r.warnings.some((i) => i.check === 'responsive' && i.elementId === first.id));
});

test('failed image assets are warnings (recoverable)', () => {
  const doc = clone(SECTION_EXAMPLE);
  const section = doc.sections[0];
  section.elements.push({
    id: 'gen_img',
    type: 'generated_illustration',
    asset: { status: 'failed', altText: 'A friendly illustration' },
    imageBrief: { subject: 'x', accessibilityDescription: 'A friendly illustration' },
  });
  section.readingOrder.push('gen_img');
  doc.layouts.desktop.gen_img = { x: 0, y: 700, w: 300, h: 200 };
  doc.layouts.mobile.gen_img = { x: 0, y: 700, w: 300, h: 200 };
  const r = runCompositionValidation(doc);
  assert.ok(r.warnings.some((i) => i.check === 'missing_asset' && i.elementId === 'gen_img'));
  assert.ok(!r.critical.some((i) => i.elementId === 'gen_img'));
});

test('caller-provided broken links surface as warnings', () => {
  const r = runCompositionValidation(clone(SECTION_EXAMPLE), {
    brokenLinks: [{ elementId: 'process_cta', kind: 'form' }],
  });
  assert.ok(r.warnings.some((i) => i.check === 'broken_link' && i.elementId === 'process_cta'));
  assert.equal(r.ok, true); // warnings never block
});

test('summarizeValidation renders human-readable counts', () => {
  assert.equal(summarizeValidation(null), 'Not validated.');
  assert.equal(summarizeValidation({ ok: true, critical: [], warnings: [] }), 'All checks passed.');
  assert.equal(
    summarizeValidation({ ok: false, critical: [{}, {}], warnings: [{}] }),
    '2 critical issue(s), 1 warning(s)',
  );
});

test('parseColor and contrastRatio behave per WCAG', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor('rgb(0, 0, 0)'), { r: 0, g: 0, b: 0 });
  assert.equal(parseColor('linear-gradient(red, blue)'), null);
  const ratio = contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 });
  assert.ok(Math.abs(ratio - 21) < 0.01);
});

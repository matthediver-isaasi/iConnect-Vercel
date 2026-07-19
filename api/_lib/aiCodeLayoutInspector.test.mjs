// Phase 3 deterministic layout inspection tests (Task #2907).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectBreakpointMetrics,
  inspectCodeLayout,
  blockingIssues,
  scoreQuality,
} from './aiCodeLayoutInspector.js';

const el = (over = {}) => ({
  key: over.aiId || 'el-1',
  aiId: over.aiId || 'el-1',
  tag: 'p',
  action: null,
  slot: null,
  isHeading: false,
  isInteractive: false,
  rect: { x: 0, y: 0, w: 300, h: 40 },
  fontSize: 16,
  display: 'block',
  visibility: 'visible',
  overflowX: 0,
  textLength: 40,
  ancestors: [],
  broken: false,
  childElementCount: 0,
  ...over,
});

const baseMetrics = (over = {}) => ({
  viewport: { width: 1440, height: 900 },
  document: { scrollWidth: 1440, clientWidth: 1440 },
  wrapper: { height: 800 },
  elements: [],
  sections: [],
  ...over,
});

const codes = (r) => r.issues.map((i) => i.code);

test('clean metrics produce no issues', () => {
  const r = inspectBreakpointMetrics(baseMetrics({
    elements: [el(), el({ aiId: 'cta', tag: 'a', isInteractive: true, rect: { x: 100, y: 200, w: 180, h: 44 } })],
    sections: [{ aiId: 's1', rect: { x: 0, y: 0, w: 1440, h: 400 }, textLength: 300, childCount: 3, maxChildHeight: 300, hasSlot: false, hasSvg: false }],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('horizontal scroll (overflow) is detected and blocking', () => {
  const r = inspectBreakpointMetrics(baseMetrics({
    viewport: { width: 390, height: 844 },
    document: { scrollWidth: 620, clientWidth: 390 },
  }), { breakpoint: 'mobile', width: 390 });
  assert.ok(codes(r).includes('horizontal_scroll'));
  assert.equal(r.issues.find((i) => i.code === 'horizontal_scroll').severity, 'blocking');
});

test('severe overlap between non-ancestor text elements is detected', () => {
  const a = el({ aiId: 'h1', tag: 'h2', isHeading: true, rect: { x: 100, y: 100, w: 400, h: 60 } });
  const b = el({ aiId: 'p1', rect: { x: 110, y: 110, w: 380, h: 50 } });
  const r = inspectBreakpointMetrics(baseMetrics({ elements: [a, b] }));
  assert.ok(codes(r).includes('severe_overlap'));
});

test('ancestor/descendant boxes never count as overlap', () => {
  const parent = el({ aiId: 'card', tag: 'a', isInteractive: true, rect: { x: 100, y: 100, w: 400, h: 200 } });
  const child = el({ aiId: 'title', tag: 'h3', isHeading: true, rect: { x: 120, y: 120, w: 360, h: 40 }, ancestors: ['card'] });
  const r = inspectBreakpointMetrics(baseMetrics({ elements: [parent, child] }));
  assert.ok(!codes(r).includes('severe_overlap'));
});

test('zero-size content, off-canvas buttons, excessive width, clipped headings', () => {
  const r = inspectBreakpointMetrics(baseMetrics({
    elements: [
      el({ aiId: 'ghost', rect: { x: 0, y: 0, w: 0, h: 0 }, textLength: 30 }),
      el({ aiId: 'btn', tag: 'button', isInteractive: true, textLength: 8, rect: { x: 1500, y: 10, w: 160, h: 44 } }),
      el({ aiId: 'wide', rect: { x: 0, y: 300, w: 1600, h: 60 } }),
      el({ aiId: 'head', tag: 'h1', isHeading: true, overflowX: 40, rect: { x: 0, y: 400, w: 600, h: 50 } }),
    ],
  }));
  const c = codes(r);
  assert.ok(c.includes('zero_size'));
  assert.ok(c.includes('off_canvas_button'));
  assert.ok(c.includes('excessive_width'));
  assert.ok(c.includes('clipped_heading'));
});

test('tiny text is advisory, not blocking', () => {
  const r = inspectBreakpointMetrics(baseMetrics({
    elements: [el({ aiId: 'fine', fontSize: 9, textLength: 60 })],
  }));
  const issue = r.issues.find((i) => i.code === 'tiny_text');
  assert.equal(issue.severity, 'advisory');
  assert.equal(blockingIssues(r.issues).length, 0);
});

test('empty and collapsed sections are flagged', () => {
  const r = inspectBreakpointMetrics(baseMetrics({
    sections: [
      { aiId: 'empty', rect: { x: 0, y: 0, w: 1440, h: 8 }, textLength: 0, childCount: 0, maxChildHeight: 0, hasSlot: false, hasSvg: false },
      { aiId: 'collapsed', rect: { x: 0, y: 100, w: 1440, h: 60 }, textLength: 400, childCount: 2, maxChildHeight: 500, hasSlot: false, hasSvg: false },
    ],
  }));
  const c = codes(r);
  assert.ok(c.includes('empty_section'));
  assert.ok(c.includes('invalid_parent_height'));
});

test('slot-only sections are not "empty"', () => {
  const r = inspectBreakpointMetrics(baseMetrics({
    sections: [{ aiId: 's', rect: { x: 0, y: 0, w: 1440, h: 10 }, textLength: 0, childCount: 1, maxChildHeight: 0, hasSlot: true, hasSvg: false }],
  }));
  assert.ok(!codes(r).includes('empty_section'));
});

test('missing CTA: declared actions but nothing visible carrying data-ai-action', () => {
  const doc = { actions: [{ key: 'join' }] };
  const bad = inspectBreakpointMetrics(baseMetrics({ elements: [el()] }), { document: doc });
  assert.ok(codes(bad).includes('missing_cta'));
  const good = inspectBreakpointMetrics(baseMetrics({
    elements: [el({ aiId: 'cta', tag: 'a', action: 'join', isInteractive: true })],
  }), { document: doc });
  assert.ok(!codes(good).includes('missing_cta'));
});

test('broken media: failed img and zero-size svg', () => {
  const r = inspectBreakpointMetrics(baseMetrics({
    elements: [
      el({ aiId: 'img1', tag: 'img', broken: true, textLength: 0, rect: { x: 0, y: 0, w: 200, h: 100 } }),
      el({ aiId: 'svg1', tag: 'svg', textLength: 0, rect: { x: 0, y: 200, w: 0.5, h: 0.5 } }),
    ],
  }));
  // svg at ~0px is caught by zero_size or broken_media — either way it blocks.
  assert.ok(codes(r).filter((c) => c === 'broken_media' || c === 'zero_size').length >= 2);
});

test('inspectCodeLayout separates capture errors from inspected breakpoints', () => {
  const r = inspectCodeLayout([
    { breakpoint: 'desktop', width: 1440, metrics: baseMetrics() },
    { breakpoint: 'mobile', width: 390, metrics: { error: 'navigation_failed', message: 'timeout' } },
  ]);
  assert.equal(r.breakpointsInspected, 1);
  assert.equal(r.captureErrors.length, 1);
  assert.equal(r.captureErrors[0].breakpoint, 'mobile');
});

test('scoreQuality: blocking −15, advisory −5, review blocking −10/advisory −3, clamped', () => {
  assert.equal(scoreQuality({}), 100);
  assert.equal(scoreQuality({ layoutIssues: [{ severity: 'blocking' }, { severity: 'advisory' }] }), 80);
  assert.equal(scoreQuality({
    review: { findings: [{ severity: 'blocking' }, { severity: 'advisory' }] },
  }), 87);
  const many = Array.from({ length: 20 }, () => ({ severity: 'blocking' }));
  assert.equal(scoreQuality({ layoutIssues: many }), 0);
});

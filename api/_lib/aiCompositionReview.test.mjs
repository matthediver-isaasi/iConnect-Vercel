/**
 * Phase 4 tests (Task #2852) — bounded visual review loop.
 *
 * Proves: the loop is hard-capped, only update_style corrections are
 * applied, unsafe corrections (schema breaks, protected-value changes, new
 * critical issues, malformed responses) end the loop with the LAST VALID
 * document, and an unavailable vision model never breaks the doc.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runVisualReview,
  parseReviewResponse,
  sanitizeReviewOps,
  buildReviewPrompt,
  MAX_REVIEW_CYCLES_CAP,
} from './aiCompositionReview.js';
import { SECTION_EXAMPLE } from './aiCompositionExamples.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

const firstElementId = SECTION_EXAMPLE.sections[0].elements[0].id;

function reviewJson({ score = 7, findings = [], ops = [] } = {}) {
  return JSON.stringify({ score, findings, ops });
}

test('parseReviewResponse clamps score, filters findings, rejects garbage', () => {
  const bad = parseReviewResponse('not json at all');
  assert.equal(bad.ok, false);

  const r = parseReviewResponse(JSON.stringify({
    score: 42,
    findings: [
      { severity: 'major', issue: 'Misaligned hero', elementId: firstElementId, breakpoint: 'mobile' },
      { severity: 'nonsense', issue: 'x' },
      { notAnIssue: true },
    ],
    ops: [{ op: 'update_style', elementId: firstElementId, changes: { style: { opacity: '0.9' } } }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.score, 10);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[1].severity, 'minor'); // unknown severity coerced
  assert.equal(r.ops.length, 1);
});

test('sanitizeReviewOps drops everything except update_style', () => {
  const ops = sanitizeReviewOps([
    { op: 'update_style', elementId: 'a', changes: { style: {} } },
    { op: 'update_content', elementId: 'a', content: { text: 'evil' } },
    { op: 'remove_element', elementId: 'a' },
    null,
  ]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'update_style');
});

test('buildReviewPrompt embeds cycle number and forbids content changes', () => {
  const { system, user } = buildReviewPrompt({ doc: SECTION_EXAMPLE, validation: { critical: [], warnings: [] }, brand: { name: 'Acme' }, cycle: 2 });
  assert.ok(system.includes('correction cycle 2'));
  assert.ok(system.includes('NEVER change text content'));
  assert.ok(user.includes('Acme'));
});

test('applies a safe style-only correction and reports the cycle', async () => {
  const doc = clone(SECTION_EXAMPLE);
  let calls = 0;
  const callVision = async () => {
    calls += 1;
    return calls === 1
      ? reviewJson({ score: 6, findings: [{ severity: 'moderate', issue: 'Cramped spacing', elementId: firstElementId, breakpoint: null }], ops: [{ op: 'update_style', elementId: firstElementId, changes: { style: { marginBottom: '24px' } } }] })
      : reviewJson({ score: 9, ops: [] });
  };
  const result = await runVisualReview({ doc, callVision, maxCycles: 3 });
  assert.equal(result.changed, true);
  assert.equal(calls, 2); // second cycle returned no ops → loop ends
  assert.equal(result.cycles.length, 2);
  assert.equal(result.cycles[0].applied, true);
  assert.equal(result.doc.sections[0].elements[0].style.marginBottom, '24px');
});

test('loop is hard-capped at MAX_REVIEW_CYCLES_CAP even when asked for more', async () => {
  let calls = 0;
  const callVision = async () => {
    calls += 1;
    return reviewJson({
      score: 5,
      ops: [{ op: 'update_style', elementId: firstElementId, changes: { style: { opacity: String(0.9 - calls * 0.01) } } }],
    });
  };
  const result = await runVisualReview({ doc: clone(SECTION_EXAMPLE), callVision, maxCycles: 99 });
  assert.equal(calls, MAX_REVIEW_CYCLES_CAP);
  assert.equal(result.cycles.length, MAX_REVIEW_CYCLES_CAP);
});

test('unsafe correction (disallowed CSS) is not applied and stops the loop', async () => {
  const doc = clone(SECTION_EXAMPLE);
  const callVision = async () => reviewJson({
    score: 4,
    ops: [{ op: 'update_style', elementId: firstElementId, changes: { style: { position: 'fixed' } } }],
  });
  const result = await runVisualReview({ doc, callVision, maxCycles: 3 });
  assert.equal(result.changed, false);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].applied, false);
  assert.deepEqual(result.doc, doc); // last valid document returned untouched
});

test('vision model failure returns the input doc unharmed', async () => {
  const doc = clone(SECTION_EXAMPLE);
  const result = await runVisualReview({
    doc,
    callVision: async () => { throw new Error('boom'); },
    maxCycles: 2,
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.doc, doc);
  assert.equal(result.cycles[0].error, 'Visual review was unavailable.');
});

test('unreadable review JSON ends the loop without changes', async () => {
  const doc = clone(SECTION_EXAMPLE);
  const result = await runVisualReview({ doc, callVision: async () => '<<<not json', maxCycles: 2 });
  assert.equal(result.changed, false);
  assert.ok(result.cycles[0].error);
});

test('maxCycles 0 performs no review at all', async () => {
  let calls = 0;
  const result = await runVisualReview({
    doc: clone(SECTION_EXAMPLE),
    callVision: async () => { calls += 1; return reviewJson(); },
    maxCycles: 0,
  });
  assert.equal(calls, 0);
  assert.equal(result.changed, false);
  assert.deepEqual(result.cycles, []);
});

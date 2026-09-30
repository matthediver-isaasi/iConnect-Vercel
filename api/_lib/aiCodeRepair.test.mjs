// Phase 3 repair-loop decision tests (Task #2907).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REPAIR_CYCLES,
  decideValidationOutcome,
  buildRejectionCleanup,
  buildRepairPrompt,
  runRepairAttempt,
} from './aiCodeRepair.js';
import { runVisualReview, parseVisualReviewResponse } from './aiCodeVisualReview.js';

const blocking = (msg = 'overlap') => ({ code: 'severe_overlap', severity: 'blocking', breakpoint: 'desktop', message: msg });
const advisory = () => ({ code: 'tiny_text', severity: 'advisory', breakpoint: 'mobile', message: 'small' });

test('no blocking evidence passes; advisory-only never holds a release', () => {
  const r = decideValidationOutcome({ layoutIssues: [advisory()], breakpointsInspected: 3, repairCycle: 0 });
  assert.equal(r.outcome, 'pass');
});

test('blocking issues trigger repair while budget remains', () => {
  const r = decideValidationOutcome({ layoutIssues: [blocking()], breakpointsInspected: 3, repairCycle: 0, maxRepairCycles: 2 });
  assert.equal(r.outcome, 'repair');
  assert.equal(r.reasons.length, 1);
});

test('repair-cycle limit: at the cap the outcome is reject, never a third repair', () => {
  const r1 = decideValidationOutcome({ layoutIssues: [blocking()], breakpointsInspected: 3, repairCycle: 1, maxRepairCycles: 2 });
  assert.equal(r1.outcome, 'repair');
  const r2 = decideValidationOutcome({ layoutIssues: [blocking()], breakpointsInspected: 3, repairCycle: 2, maxRepairCycles: 2 });
  assert.equal(r2.outcome, 'reject');
});

test('validation that could not run at all (no breakpoints) passes as skipped', () => {
  const r = decideValidationOutcome({ layoutIssues: [], breakpointsInspected: 0, repairCycle: 0 });
  assert.equal(r.outcome, 'pass');
  assert.equal(r.skippedValidation, true);
});

test('a skipped review never blocks; blocking review findings do', () => {
  const skipped = decideValidationOutcome({
    layoutIssues: [], breakpointsInspected: 3, repairCycle: 0,
    review: { status: 'skipped', skipReason: 'budget' },
  });
  assert.equal(skipped.outcome, 'pass');
  const flagged = decideValidationOutcome({
    layoutIssues: [], breakpointsInspected: 3, repairCycle: 0,
    review: { status: 'reviewed', review: { verdict: 'fail', findings: [{ severity: 'blocking', breakpoint: 'mobile', message: 'unreadable' }] } },
  });
  assert.equal(flagged.outcome, 'repair');
});

test('rejection cleanup NEVER deletes the current version and only deletes new shells', () => {
  const c = buildRejectionCleanup({
    isNewComposition: false,
    candidateVersionIds: ['v-cand-1', 'v-cand-2', 'v-current'],
    currentVersionId: 'v-current',
  });
  assert.deepEqual(c.versionIdsToDelete, ['v-cand-1', 'v-cand-2']);
  assert.equal(c.deleteComposition, false);

  const fresh = buildRejectionCleanup({
    isNewComposition: true,
    candidateVersionIds: ['v1'],
    currentVersionId: null,
  });
  assert.deepEqual(fresh.versionIdsToDelete, ['v1']);
  assert.equal(fresh.deleteComposition, true);
});

test('MAX_REPAIR_CYCLES defaults to 2', () => {
  assert.equal(MAX_REPAIR_CYCLES, 2);
});

test('repair prompt carries evidence, keeps unscoped CSS, escalates on final cycle', () => {
  const doc = { compositionType: 'section', html: '<section data-ai-id="s"></section>', css: '[data-ai-composition="x"] p{}' };
  const p = buildRepairPrompt({
    document: doc,
    rawCss: 'p{color:red}',
    brief: 'Hero',
    layoutIssues: [blocking('overlaps CTA')],
    reviewFindings: [{ severity: 'advisory', breakpoint: 'mobile', message: 'cramped' }],
    screenshots: [{ breakpoint: 'desktop', width: 1440, url: 'https://x/y.jpg' }],
    repairCycle: 1,
    maxRepairCycles: 2,
    previousRepairErrors: ['CSS leaked outside its scope'],
  });
  assert.ok(p.user.includes('overlaps CTA'));
  assert.ok(p.user.includes('cramped'));
  assert.ok(p.user.includes('p{color:red}'));
  assert.ok(!p.user.includes('[data-ai-composition="x"]'));
  assert.ok(p.user.includes('CSS leaked outside its scope'));
  assert.ok(p.system.includes('FINAL repair attempt'));
  assert.equal(p.images.length, 1);
});

test('runRepairAttempt rejects a repair that fails parsing', async () => {
  const r = await runRepairAttempt({
    callLlm: async () => 'not json',
    compositionId: '00000000-0000-4000-8000-000000000001',
    document: { compositionType: 'section', html: '', css: '' },
    brief: 'x',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

test('runVisualReview: failure and timeout are skipped (non-blocking), success parses', async () => {
  const shots = [{ breakpoint: 'desktop', width: 1440, url: 'data:image/jpeg;base64,AA==' }];
  const failed = await runVisualReview({ callVision: async () => { throw new Error('boom'); }, screenshots: shots, brief: 'b' });
  assert.equal(failed.status, 'skipped');

  const slow = await runVisualReview({
    callVision: () => new Promise((resolve) => setTimeout(() => resolve('{}'), 50)),
    screenshots: shots, brief: 'b', budgetMs: 5,
  });
  assert.equal(slow.status, 'skipped');

  const ok = await runVisualReview({
    callVision: async () => JSON.stringify({ verdict: 'fail', summary: 's', findings: [{ severity: 'blocking', breakpoint: 'mobile', message: 'text unreadable' }] }),
    screenshots: shots, brief: 'b',
  });
  assert.equal(ok.status, 'reviewed');
  assert.equal(ok.review.verdict, 'fail');
  assert.equal(ok.review.findings[0].severity, 'blocking');

  const unconfigured = await runVisualReview({ callVision: null, screenshots: shots, brief: 'b' });
  assert.equal(unconfigured.status, 'skipped');
});

test('parseVisualReviewResponse: fail verdict without blocking findings normalises to pass', () => {
  const r = parseVisualReviewResponse(JSON.stringify({ verdict: 'fail', findings: [{ severity: 'advisory', message: 'meh' }] }));
  assert.equal(r.ok, true);
  assert.equal(r.review.verdict, 'pass');
});

test('visual review prompt/payload includes reference screenshots when present', async () => {
  const shots = [{ breakpoint: 'desktop', width: 1440, url: 'data:image/jpeg;base64,AA==' }];
  const refs = [{ url: 'https://tenant-assets/ref-desktop.jpg', label: 'desktop full_page' }];
  let captured;
  const r = await runVisualReview({
    callVision: async (payload) => { captured = payload; return JSON.stringify({ verdict: 'pass', summary: '', findings: [] }); },
    screenshots: shots,
    referenceImages: refs,
    brief: 'match our reference',
  });
  assert.equal(r.status, 'reviewed');
  assert.equal(captured.images.length, 2);
  assert.equal(captured.images[1].url, refs[0].url);
  assert.ok(captured.system.includes('STYLE REFERENCE'));
  assert.ok(captured.user.includes('desktop full_page'));
});

test('visual review without references omits reference framing entirely', async () => {
  const shots = [{ breakpoint: 'desktop', width: 1440, url: 'data:image/jpeg;base64,AA==' }];
  let captured;
  await runVisualReview({
    callVision: async (payload) => { captured = payload; return JSON.stringify({ verdict: 'pass', summary: '', findings: [] }); },
    screenshots: shots,
    brief: 'b',
  });
  assert.equal(captured.images.length, 1);
  assert.ok(!captured.system.includes('STYLE REFERENCE'));
  assert.ok(!captured.user.includes('STYLE REFERENCE'));
});

test('blocking review findings still block when metrics captures failed (0 breakpoints)', () => {
  const reviewed = {
    status: 'reviewed',
    review: { verdict: 'fail', findings: [{ severity: 'blocking', breakpoint: 'desktop', message: 'text unreadable over image' }] },
  };
  const r = decideValidationOutcome({ layoutIssues: [], breakpointsInspected: 0, repairCycle: 0, maxRepairCycles: 2, review: reviewed });
  assert.equal(r.outcome, 'repair');
  const atCap = decideValidationOutcome({ layoutIssues: [], breakpointsInspected: 0, repairCycle: 2, maxRepairCycles: 2, review: reviewed });
  assert.equal(atCap.outcome, 'reject');
});

test('metrics-skipped but clean review passes, flagged as metricsSkipped for the audit trail', () => {
  const r = decideValidationOutcome({
    layoutIssues: [], breakpointsInspected: 0, repairCycle: 0,
    review: { status: 'reviewed', review: { verdict: 'pass', findings: [] } },
  });
  assert.equal(r.outcome, 'pass');
  assert.equal(r.skippedValidation, true);
  assert.equal(r.metricsSkipped, true);
});

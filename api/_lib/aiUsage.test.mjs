/**
 * Phase 4 tests (Task #2852) — AI Design Studio usage metering.
 *
 * Pure decision logic: allowance evaluation (limits, rate limits, dedupe,
 * creativity gating, warnings), cost estimation, month windows and usage-row
 * summarization. No database required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAllowance,
  estimateCost,
  summarizeUsageRows,
  monthWindow,
  makeDedupeHash,
  COST_ESTIMATES,
} from './aiUsage.js';

const baseSettings = {
  enabled: true,
  allowImageGeneration: true,
  permittedCreativity: ['strict', 'brand_led'],
  monthlyGenerationAllowance: 10,
  monthlyImageAllowance: 5,
  perUserHourlyLimit: 20,
  maxPromptLength: 100,
  hardCostLimit: 50,
};

test('allows a plain generation under all limits', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'generation' });
  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined);
});

test('blocks when the studio is disabled', () => {
  const r = evaluateAllowance({ settings: { ...baseSettings, enabled: false }, operation: 'generation' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'AI_STUDIO_DISABLED');
});

test('blocks non-permitted creativity levels', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'generation', creativity: 'expressive' });
  assert.equal(r.ok, false);
  assert.equal(r.body.code, 'AI_CREATIVITY_NOT_PERMITTED');
  const ok = evaluateAllowance({ settings: baseSettings, operation: 'generation', creativity: 'brand_led' });
  assert.equal(ok.ok, true);
});

test('blocks over-long prompts', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'generation', promptLength: 101 });
  assert.equal(r.ok, false);
  assert.equal(r.body.code, 'AI_PROMPT_TOO_LONG');
  assert.equal(r.body.maxPromptLength, 100);
});

test('blocks duplicate submissions with 429', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'generation', isDuplicate: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'AI_DUPLICATE_SUBMISSION');
});

test('blocks when the per-user hourly limit is reached', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'edit', userHourEvents: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'AI_RATE_LIMITED');
});

test('blocks generation-family ops at the monthly generation allowance', () => {
  for (const operation of ['generation', 'section_generation', 'edit', 'redesign']) {
    const r = evaluateAllowance({ settings: baseSettings, operation, monthGenerations: 10 });
    assert.equal(r.ok, false, operation);
    assert.equal(r.body.code, 'AI_MONTHLY_LIMIT');
  }
  // Image ops are NOT counted against the generation allowance.
  const img = evaluateAllowance({ settings: baseSettings, operation: 'image_generation', monthGenerations: 10 });
  assert.equal(img.ok, true);
});

test('blocks image ops at the monthly image allowance or when images disabled', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'image_generation', monthImages: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.body.code, 'AI_IMAGE_LIMIT');

  const off = evaluateAllowance({
    settings: { ...baseSettings, allowImageGeneration: false },
    operation: 'image_edit',
  });
  assert.equal(off.ok, false);
  assert.equal(off.body.code, 'AI_IMAGES_DISABLED');
});

test('blocks at the hard cost limit', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'generation', monthCost: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.body.code, 'AI_COST_LIMIT');
});

test('null/absent limits mean unlimited', () => {
  const s = {
    ...baseSettings,
    monthlyGenerationAllowance: null,
    monthlyImageAllowance: null,
    perUserHourlyLimit: null,
    hardCostLimit: null,
    maxPromptLength: null,
  };
  const r = evaluateAllowance({
    settings: s, operation: 'generation',
    monthGenerations: 99999, monthCost: 99999, userHourEvents: 99999, promptLength: 99999,
  });
  assert.equal(r.ok, true);
});

test('emits a soft warning at 80% of the generation allowance', () => {
  const r = evaluateAllowance({ settings: baseSettings, operation: 'generation', monthGenerations: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.warning?.code, 'AI_USAGE_WARNING');
  assert.equal(r.warning.usedPct, 80);
  const under = evaluateAllowance({ settings: baseSettings, operation: 'generation', monthGenerations: 7 });
  assert.equal(under.warning, undefined);
});

test('estimateCost combines unit prices', () => {
  const cost = estimateCost({ textCalls: 2, images: 1, reviewCycles: 1 });
  assert.equal(cost, Math.round((2 * COST_ESTIMATES.textCall + COST_ESTIMATES.image + COST_ESTIMATES.reviewCycle) * 100000) / 100000);
  assert.equal(estimateCost({}), 0);
});

test('monthWindow spans the current UTC month', () => {
  const { start, end } = monthWindow(new Date('2026-07-18T12:00:00Z'));
  assert.equal(start, '2026-07-01T00:00:00.000Z');
  assert.equal(end, '2026-08-01T00:00:00.000Z');
});

test('makeDedupeHash is stable, case/whitespace-insensitive on prompt, and input-sensitive', () => {
  const a = makeDedupeHash({ tenantId: 't1', memberId: 'm1', operation: 'generation', prompt: '  Hello World ' });
  const b = makeDedupeHash({ tenantId: 't1', memberId: 'm1', operation: 'generation', prompt: 'hello world' });
  assert.equal(a, b);
  const c = makeDedupeHash({ tenantId: 't2', memberId: 'm1', operation: 'generation', prompt: 'hello world' });
  assert.notEqual(a, c);
});

test('summarizeUsageRows aggregates and skips blocked rows', () => {
  const rows = [
    { operation: 'generation', estimated_cost: 0.01, status: 'succeeded', member_id: 'm1' },
    { operation: 'image_generation', estimated_cost: 0.04, status: 'succeeded', member_id: 'm1' },
    { operation: 'visual_review', estimated_cost: 0.01, status: 'succeeded', member_id: 'm2' },
    { operation: 'generation', estimated_cost: 1, status: 'blocked', member_id: 'm2' },
  ];
  const s = summarizeUsageRows(rows);
  assert.equal(s.totalEvents, 3);
  assert.equal(s.generations, 1);
  assert.equal(s.images, 1);
  assert.equal(s.reviews, 1);
  assert.equal(s.estimatedCost, 0.06);
  assert.equal(s.byOperation.generation, 1);
  assert.deepEqual(s.byMember, { m1: 2, m2: 1 });
});

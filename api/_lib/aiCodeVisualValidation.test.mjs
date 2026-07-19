// Phase 3 evidence-capture orchestrator tests (Task #2907).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureValidationEvidence,
  viewportsForTargets,
} from './aiCodeVisualValidation.js';

const okScreenshot = async () => ({ buffer: Buffer.from('jpeg'), contentType: 'image/jpeg' });
const okMetrics = async () => ({ viewport: { width: 1440 }, document: { scrollWidth: 1440 }, wrapper: { height: 100 }, elements: [], sections: [] });
const storeShot = async ({ breakpoint }) => ({ url: `https://cdn/x-${breakpoint}.jpg`, fileRepositoryId: `fr-${breakpoint}` });

test('viewportsForTargets defaults to 1440/1024/390', () => {
  const v = viewportsForTargets(null);
  assert.deepEqual(v.map((x) => x.width), [1440, 1024, 390]);
  const custom = viewportsForTargets({ desktop: 1280, tablet: 900, mobile: 375 });
  assert.deepEqual(custom.map((x) => x.width), [1280, 900, 375]);
});

test('captures all three breakpoints (screenshots + metrics) when everything works', async () => {
  const r = await captureValidationEvidence({
    previewUrl: 'https://app/preview',
    storeShot,
    screenshotImpl: okScreenshot,
    metricsImpl: okMetrics,
    configuredImpl: () => true,
  });
  assert.equal(r.status, 'captured');
  assert.deepEqual(r.screenshots.map((s) => s.breakpoint), ['desktop', 'tablet', 'mobile']);
  assert.equal(r.metricsCaptures.length, 3);
  assert.equal(r.failures.length, 0);
});

test('Browserless not configured → skipped, never a failure', async () => {
  const r = await captureValidationEvidence({
    previewUrl: 'https://app/preview',
    storeShot,
    configuredImpl: () => false,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(r.skipReason, 'Browserless is not configured');
});

test('missing preview URL (no signing secret) → skipped', async () => {
  const r = await captureValidationEvidence({ previewUrl: null, storeShot });
  assert.equal(r.status, 'skipped');
});

test('total Browserless failure → skipped with per-breakpoint failures recorded', async () => {
  const boom = async () => { throw new Error('502 from browserless'); };
  const r = await captureValidationEvidence({
    previewUrl: 'https://app/preview',
    storeShot,
    screenshotImpl: boom,
    metricsImpl: boom,
    configuredImpl: () => true,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(r.skipReason, 'All Browserless captures failed');
  assert.equal(r.failures.length, 6); // 3 screenshots + 3 metrics
});

test('partial failure still yields evidence (metrics survive screenshot loss)', async () => {
  const r = await captureValidationEvidence({
    previewUrl: 'https://app/preview',
    storeShot,
    screenshotImpl: async () => { throw new Error('shot failed'); },
    metricsImpl: okMetrics,
    configuredImpl: () => true,
  });
  assert.equal(r.status, 'captured');
  assert.equal(r.screenshots.length, 0);
  assert.equal(r.metricsCaptures.length, 3);
  assert.equal(r.failures.filter((f) => f.kind === 'screenshot').length, 3);
});

test('captures exceeding the budget are recorded as failures, not hangs', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ buffer: Buffer.from('x') }), 100));
  const r = await captureValidationEvidence({
    previewUrl: 'https://app/preview',
    storeShot,
    screenshotImpl: slow,
    metricsImpl: okMetrics,
    configuredImpl: () => true,
    budgetMs: 10,
  });
  assert.equal(r.status, 'captured');
  assert.equal(r.metricsCaptures.length, 3);
  assert.equal(r.failures.filter((f) => f.kind === 'screenshot' && /budget/.test(f.error)).length, 3);
});

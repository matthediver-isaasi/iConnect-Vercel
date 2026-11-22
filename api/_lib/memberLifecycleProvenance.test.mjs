import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleEvidenceFingerprint, reviewedMembershipAbsence, reviewedLoginCoverage } from './memberLifecycleProvenance.js';
test('absent membership requires scoped reviewed provenance, never a guessed classification', () => {
  const fingerprint = lifecycleEvidenceFingerprint([]);
  const review = { historyKind: 'never', fingerprint, reference: 'Reviewed source register', reviewedAt: '2026-11-20' };
  assert.equal(reviewedMembershipAbsence([], null, fingerprint, '2026-11-22'), null);
  assert.equal(reviewedMembershipAbsence([], review, fingerprint, '2026-11-22').historyKind, 'never');
  assert.equal(reviewedMembershipAbsence([{ status: 'active' }], review, fingerprint, '2026-11-22'), null);
  assert.equal(reviewedMembershipAbsence([], review, 'changed', '2026-11-22'), null);
});
test('reviewed login coverage preserves newer observations and never overrides source errors', () => {
  const observed = { complete: false, lastOccurredAt: '2026-11-21', reasons: ['login_history_coverage_unverified'] };
  const review = { reference: 'Verified archive', reviewedAt: '2026-11-20', lastOccurredAt: '2020-01-01' };
  assert.equal(reviewedLoginCoverage(observed, review, '2026-11-22').lastOccurredAt, '2026-11-21');
  assert.equal(reviewedLoginCoverage(observed, review, '2026-11-22').complete, true);
  const unavailable = { ...observed, reasons: ['login_source_unavailable'] };
  assert.equal(reviewedLoginCoverage(unavailable, review, '2026-11-22').complete, false);
});

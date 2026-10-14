import assert from 'node:assert/strict';
import { sha, buildRecord as buildPreviousRecord } from './bnms-approved-72-core.mjs';
export { TENANT, sha, memberInvoice, financialProjection, assertRecord, approvalState } from './bnms-approved-72-core.mjs';

export const REVIEW_HASH = 'aef36ada4fb6af6d9c59bd95d35c8ebcb06478408adc34b036b983c82d68c6bc';
export const CSV_HASH = '1964b03d164d5c5e487768a058daef12abb180361bb0b62ab2d616ec649dff91';
export const CATEGORY = 'Paid current-term reconstruction candidate';
export const SOURCE_HASHES = {
  'recovery-sources.json': 'af2320540b763e32e4573b7d06a4a644102ba008be40a5f9459c626053db055d',
  'recovery-162.json': '0858754bf24df4131f7fa2565e52cd71ee4c2c1eb5a55228a7f6bf53f38e8cf4',
  'snapshot.json': 'db2f810e7b0d5a4c7ead2f0d814d178752cdfe33b01de839bec93f157ed71c54',
};
export function historyId(memberId) {
  const h = sha(`${REVIEW_HASH}:${memberId}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function approvedCandidates(bytes, csvBytes) {
  assert.equal(sha(bytes), REVIEW_HASH, 'Reviewed report changed');
  assert.equal(sha(csvBytes), CSV_HASH, 'Reviewed CSV changed');
  const rows = JSON.parse(bytes).rows.filter(r => r.category === CATEGORY);
  assert.equal(rows.length, 19);
  assert.equal(new Set(rows.map(r => r.memberId)).size, 19);
  assert.ok(rows.every(r => r.conditionalCandidate && r.paidInvoiceVerified && !r.holds.length));
  return rows;
}
export function assertAssessment(actual, approved) {
  for (const [key, value] of Object.entries(actual))
    assert.deepEqual(value, approved[key], `Approved assessment changed: ${key}`);
}
export function buildRecord(candidate, config, provider, evidenceHash) {
  const record = buildPreviousRecord(candidate, config, provider);
  const provenance = JSON.parse(record.notes);
  return { ...record, id: historyId(candidate.memberId),
    renewal_policy_snapshot: null,
    notes: JSON.stringify({ ...provenance,
      source: 'bnms_approved_19_xero_reconstruction',
      reviewSha256: REVIEW_HASH, csvSha256: CSV_HASH, evidenceSha256: evidenceHash,
      approval: 'Owner explicitly approved all 19 with the listed exact dates on 2026-10-14',
      sourceEvidenceSha256: SOURCE_HASHES['recovery-sources.json'],
      overseasWordingReconciled: candidate.aliasReconciled,
      memberClassUnchanged: true, renewalPolicyAuthority: false,
    }) };
}

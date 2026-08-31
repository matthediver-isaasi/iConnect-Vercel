import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFormProcessingHeaders,
  resolveTrustedFormProcessingAdmin,
  verifyFormProcessingRequest,
} from './formProcessingAuth.js';

test('internal form-processing signature is bound to tenant, form, submission, identity, admin authority, and time', () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'unit-test-form-processing-secret';
  try {
    const now = 1_800_000_000_000;
    const ids = {
      tenantId: 'tenant-1',
      formId: 'form-1',
      submissionId: 'submission-1',
      verifiedSubmitterMemberId: 'member-1',
      verifiedAdminAccess: true,
    };
    const headers = buildFormProcessingHeaders(ids, now);
    assert.equal(verifyFormProcessingRequest({ headers }, ids, now + 60_000), true);
    assert.equal(verifyFormProcessingRequest({ headers }, { ...ids, submissionId: 'submission-2' }, now), false);
    assert.equal(verifyFormProcessingRequest({ headers }, { ...ids, verifiedSubmitterMemberId: 'member-2' }, now), false);
    assert.equal(verifyFormProcessingRequest({ headers }, { ...ids, verifiedAdminAccess: false }, now), false);
    assert.equal(verifyFormProcessingRequest({ headers }, ids, now + 6 * 60_000), false);
    assert.equal(verifyFormProcessingRequest({ headers: {} }, ids, now), false);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test('only a signed-hop admin assertion grants trusted processing authority', () => {
  assert.equal(resolveTrustedFormProcessingAdmin({ trustedInternal: true, verifiedAdminAccess: true }), true);
  assert.equal(resolveTrustedFormProcessingAdmin({ trustedInternal: true, verifiedAdminAccess: false }), false);
  assert.equal(resolveTrustedFormProcessingAdmin({ trustedInternal: false, verifiedAdminAccess: true }), false);
  assert.equal(resolveTrustedFormProcessingAdmin({ trustedInternal: true, verifiedAdminAccess: 'true' }), false);
});
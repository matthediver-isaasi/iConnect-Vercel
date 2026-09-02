import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberFeeApproval } from './membershipFeeApproval.js';

function fakeClient({ required = true, rows = [], approvalError = null } = {}) {
  return {
    from(table) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        or() { return builder; },
        maybeSingle() {
          if (table === 'system_settings') {
            return Promise.resolve({
              data: { setting_value: required ? 'true' : 'false' },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) {
          return Promise.resolve({
            data: table === 'member_membership_invoicing' ? rows : null,
            error: table === 'member_membership_invoicing' ? approvalError : null,
          }).then(resolve);
        },
      };
      return builder;
    },
  };
}

test('approval-disabled tenants allow member fee actions without an invoicing row', async () => {
  const result = await resolveMemberFeeApproval(fakeClient({ required: false }), {
    tenantId: 'tenant-1',
    memberId: 'member-1',
    membershipYear: '2026/2027',
  });
  assert.deepEqual(result, { required: false, approved: true, source: 'not_required' });
});

test('year-specific approval wins over a legacy all-years approval', async () => {
  const result = await resolveMemberFeeApproval(fakeClient({
    rows: [
      { membership_year: null, fees_approved: true },
      { membership_year: '2026/2027', fees_approved: false },
    ],
  }), {
    tenantId: 'tenant-1',
    memberId: 'member-1',
    membershipYear: '2026/2027',
  });
  assert.deepEqual(result, { required: true, approved: false, source: 'year' });
});

test('legacy approval is used when no year-specific row exists', async () => {
  const result = await resolveMemberFeeApproval(fakeClient({
    rows: [{ membership_year: null, fees_approved: true }],
  }), {
    tenantId: 'tenant-1',
    memberId: 'member-1',
    membershipYear: '2026/2027',
  });
  assert.deepEqual(result, { required: true, approved: true, source: 'legacy' });
});

test('missing approval is blocked and database errors fail explicitly', async () => {
  const missing = await resolveMemberFeeApproval(fakeClient(), {
    tenantId: 'tenant-1',
    memberId: 'member-1',
    membershipYear: '2026/2027',
  });
  assert.deepEqual(missing, { required: true, approved: false, source: 'missing' });

  await assert.rejects(
    resolveMemberFeeApproval(fakeClient({ approvalError: new Error('read failed') }), {
      tenantId: 'tenant-1',
      memberId: 'member-1',
      membershipYear: '2026/2027',
    }),
    /read failed/,
  );
});
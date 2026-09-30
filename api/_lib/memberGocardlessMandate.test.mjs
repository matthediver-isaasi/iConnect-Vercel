import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  formatGocardlessMandateStatus,
  selectCurrentMemberMandate,
} from './memberGocardlessMandate.js';

const tenantId = 'tenant-1';
const memberId = 'member-1';

function agreement(overrides = {}) {
  return {
    id: 'agreement-1',
    tenant_id: tenantId,
    member_id: memberId,
    organization_id: null,
    agreement_type: 'member',
    gocardless_mandate_id: 'MD-old',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

test('prefers the current plan replacement mandate and resolves its status', () => {
  const result = selectCurrentMemberMandate({
    memberId,
    agreements: [agreement()],
    plans: [
      { id: 'old', billing_agreement_id: 'agreement-1', status: 'payment_plan_cancelled', gocardless_mandate_id: 'MD-old', created_at: '2026-04-01T00:00:00Z' },
      { id: 'new', billing_agreement_id: 'agreement-1', status: 'active', gocardless_mandate_id: 'MD-new', created_at: '2026-03-01T00:00:00Z' },
    ],
    mandates: [{ tenant_id: tenantId, gocardless_mandate_id: 'MD-new', status: 'pending_submission' }],
  });
  assert.deepEqual(result, {
    mandateId: 'MD-new',
    status: 'pending_submission',
    statusLabel: 'Pending Submission',
  });
});

test('uses the newest direct member agreement and excludes organisation-owned agreements', () => {
  const result = selectCurrentMemberMandate({
    memberId,
    agreements: [
      agreement(),
      agreement({ id: 'agreement-2', gocardless_mandate_id: 'MD-current', created_at: '2026-04-01T00:00:00Z' }),
      agreement({ id: 'org-agreement', organization_id: 'org-1', agreement_type: 'organization', gocardless_mandate_id: 'MD-org', created_at: '2026-05-01T00:00:00Z' }),
    ],
    mandates: [{ tenant_id: tenantId, gocardless_mandate_id: 'MD-current', status: 'active' }],
  });
  assert.equal(result.mandateId, 'MD-current');
  assert.equal(result.statusLabel, 'Active');
});

test('keeps the mandate ID when the mirrored status is missing or cross-tenant', () => {
  const result = selectCurrentMemberMandate({
    memberId,
    agreements: [agreement()],
    mandates: [{ tenant_id: 'other-tenant', gocardless_mandate_id: 'MD-old', status: 'active' }],
  });
  assert.deepEqual(result, { mandateId: 'MD-old', status: null, statusLabel: null });
});

test('returns empty values without a direct mandate', () => {
  assert.deepEqual(
    selectCurrentMemberMandate({ memberId, agreements: [] }),
    { mandateId: null, status: null, statusLabel: null },
  );
});

test('formats GoCardless statuses for display', () => {
  assert.equal(formatGocardlessMandateStatus('pending_customer_approval'), 'Pending Customer Approval');
  assert.equal(formatGocardlessMandateStatus(null), null);
});

test('admin endpoint enforces member-management authorization and tenant scoping', async () => {
  const source = await readFile(
    new URL('../admin/members/[memberId]/gocardless-mandate.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /hasAdminAccess\(context\)/);
  assert.match(source, /checkCrossMemberPermissions\(context\.roleId\)/);
  assert.match(source, /\.eq\('tenant_id', context\.tenantId\)/);
  assert.match(source, /\.eq\('member_id', memberId\)/);
  assert.match(source, /\.eq\('agreement_type', 'member'\)/);
  assert.match(source, /\.is\('organization_id', null\)/);
});
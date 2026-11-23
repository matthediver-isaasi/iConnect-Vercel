import test from 'node:test';
import assert from 'node:assert/strict';
import { previewLifecyclePrivacy } from './memberLifecyclePrivacy.js';
import { DEFAULT_LIFECYCLE_POLICY, evaluateMemberLifecycle } from '../../shared/memberLifecyclePolicy.mjs';

test('privacy previews reject renewed archived members before latest term retention ends', async () => {
  const memberId = '33333333-3333-4333-8333-333333333333';
  const policy = { ...DEFAULT_LIFECYCLE_POLICY };
  const evidence = { tenantId: 'tenant', memberId, membershipComplete: true,
    obligationsComplete: true, blockers: [],
    membership: { historyKind: 'former', graceEndDate: '2025-11-22' } };
  const member = { id: memberId, tenant_id: 'tenant', lifecycle_state: 'archived',
    lifecycle_archived_at: '2020-01-01' };
  const proposal = evaluateMemberLifecycle({ policy, tenantId: 'tenant', member,
    evidence, roles: [], now: '2026-11-22' });
  assert.equal(proposal.eligibleOn, '2030-11-22');
  for (const action of ['minimise_preview', 'delete_preview']) {
    await assert.rejects(previewLifecyclePrivacy({
      rpc: async () => assert.fail('Must not read fields or issue a disposal token'),
    }, {
      tenantId: 'tenant', actor: 'member:reviewer', saved: { revision: 1, policy },
      body: { action, memberId, expectedRevision: 1, reason: 'Retention review' },
    }, { detail: async () => ({ revision: 1, state: 'archived', blockers: [], proposal, evidence }) }),
    /not reached disposal review eligibility/);
  }
});

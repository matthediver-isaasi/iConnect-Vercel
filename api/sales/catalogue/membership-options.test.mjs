import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipOptionsHandler } from './membership-options.js';

const response = () => ({
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader() {},
});

test('concrete membership options entry reaches authentication without catch-all parameters', async () => {
  const handler = createMembershipOptionsHandler({ db: {}, getTenantContext: async () => null });
  const res = response();
  await handler({ method: 'GET', url: '/api/sales/catalogue/membership-options' }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Authentication required');
});

test('entry ignores caller path overrides and retains the disabled rollout response', async () => {
  const previous = process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED;
  delete process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED;
  try {
    const handler = createMembershipOptionsHandler({
      db: { from() { throw new Error('Disabled rollout must not query schedules'); } },
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'admin' }),
    });
    const res = response();
    await handler({ method: 'GET', url: '/api/sales/catalogue/membership-options', query: { path: ['products'] } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { items: [], enabled: false });
  } finally {
    if (previous === undefined) delete process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED;
    else process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED = previous;
  }
});

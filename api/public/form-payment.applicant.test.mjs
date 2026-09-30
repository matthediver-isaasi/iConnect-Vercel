import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './form-payment.js';

for (const action of ['quote', 'create', 'create_monthly_card']) {
  for (const scenario of [
    { name: 'owner', memberTenant: 'tenant', memberOrg: 'org', allowed: true },
    { name: 'administrator', adminTenant: 'tenant', allowed: true },
    { name: 'wrong organization owner', memberTenant: 'tenant', memberOrg: 'other' },
    { name: 'cross-tenant member', memberTenant: 'other', memberOrg: 'org' },
    { name: 'cross-tenant administrator', adminTenant: 'other' },
    { name: 'administrator targeting another tenant organization', adminTenant: 'tenant', target: 'foreign-org' },
    { name: 'bare claims only' },
  ]) {
    test(`${action} applicant policy session admission: ${scenario.name}`, async () => {
      const form = { id: 'form', tenant_id: 'tenant', is_active: true,
        mutation_access_policy: { version: 1, mode: 'applicant_continuation' },
        fields: [{ id: 'payment', type: 'payment', payment_providers: ['stripe', 'gocardless'] }],
      };
      const reads = [];
      const db = { from(table) {
        reads.push(table);
        assert.ok(['form', 'organization'].includes(table), 'No provider/submission writes');
        const filters = {};
        return { select() { return this; }, eq(k, v) { filters[k] = v; return this; },
          async single() { return { data: form }; },
          async maybeSingle() { return { data: filters.id === 'org' && filters.tenant_id === 'tenant' ? { id: 'org' } : null }; },
        };
      } };
      const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
      await handler({ method: 'POST', headers: {}, body: {
        action, provider: 'stripe', form_id: 'form',
        prefill_organization_id: scenario.target || 'org', submission_data: {},
        verified_admin_access: true, verified_submitter_member_id: 'forged-owner',
        email: 'owner@example.test',
      } }, res, {
        supabase: db, tenantData: { id: 'tenant' },
        getSessionMember: async () => scenario.memberTenant ? {
          id: 'owner', tenant_id: scenario.memberTenant, organization_id: scenario.memberOrg,
        } : null,
        getTenantContext: async () => scenario.adminTenant ? { tenantId: scenario.adminTenant } : null,
        hasAdminAccess: async () => true,
      });
      if (scenario.allowed) {
        // Real quote succeeds; create reaches its payment-specific guard rather
        // than charging a card in an authorization regression test.
        assert.equal(res.statusCode, action === 'quote' ? 200 : 400, JSON.stringify(res.body));
        if (action === 'create_monthly_card') {
          assert.equal(res.body.error, 'Monthly card payment is not available for this membership');
        } else assert.equal(res.body.code, 'NO_PAYMENT_REQUIRED');
        assert.ok(reads.includes('organization'));
      } else {
        assert.equal(res.statusCode, 403, JSON.stringify(res.body));
        assert.equal(res.body.code, 'APPLICANT_CONTINUATION_REQUIRED');
      }
    });
  }
}

for (const [action, provider] of [
  ['create', 'stripe'], ['create', 'gocardless'], ['create_monthly_card', undefined],
]) {
  test(`${action}/${provider || 'stripe'} rejects missing applicant proof before payment preparation`, async () => {
    const reads = [];
    const db = { from(table) {
      reads.push(table);
      assert.equal(table, 'form', 'No payment/submission/provider mutation may precede authorization');
      return { select() { return this; }, eq() { return this; }, async single() {
        return { data: { id: 'form', tenant_id: 'tenant', is_active: true,
          mutation_access_policy: { version: 1, mode: 'applicant_continuation' } } };
      } };
    } };
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', headers: {}, body: {
      action, provider, form_id: 'form', prefill_organization_id: 'org',
      submission_data: { email: 'hostile@example.test' },
    } }, res, { supabase: db, tenantData: { id: 'tenant' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'APPLICANT_CONTINUATION_REQUIRED');
    assert.deepEqual(reads, ['form']);
  });
}
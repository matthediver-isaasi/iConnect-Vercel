import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bindFormPersonalPaymentOwner, hasFormPersonalPaymentOwner } from './formPersonalPaymentAuthority.js';

const member = { id: 'member', tenant_id: 'tenant', organization_id: 'affiliation' };
const request = source => ({
  method: 'POST', body: { action: 'start' },
  membershipPaymentContext: { source, simulation: { config: { structure_scope_type: 'member' } } },
});
const owner = { tenantId: 'tenant', memberId: 'member', organizationId: null };

test('verified personal joining and renewal allow an existing CRM affiliation', () => {
  for (const source of ['form-joining', 'form-renewal']) {
    const req = request(source);
    bindFormPersonalPaymentOwner(req, owner);
    assert.equal(hasFormPersonalPaymentOwner(req, member), true);
    assert.equal(hasFormPersonalPaymentOwner(req, { ...member, id: 'other' }), false);
    assert.equal(hasFormPersonalPaymentOwner(req, { ...member, tenant_id: 'other' }), false);
    req.method = 'GET';
    assert.equal(hasFormPersonalPaymentOwner(req, member), false);
  }
});

test('body, query and unbound context cannot supply authority', () => {
  const req = request('form-joining');
  req.body.membershipPaymentContext = req.membershipPaymentContext;
  req.body.personalPaymentOwner = owner;
  req.query = { ...req.body };
  assert.equal(hasFormPersonalPaymentOwner(req, member), false);
});

test('organisation-owned and unverified simulations retain the original restriction', () => {
  for (const mutation of [
    req => { req.membershipPaymentContext.simulation.config.structure_scope_type = 'organization'; },
    req => { req.membershipPaymentContext.source = 'other'; },
    req => { delete req.membershipPaymentContext.simulation; },
  ]) {
    const req = request('form-joining');
    mutation(req);
    bindFormPersonalPaymentOwner(req, owner);
    assert.equal(hasFormPersonalPaymentOwner(req, member), false);
  }
  const req = request('form-joining');
  bindFormPersonalPaymentOwner(req, { ...owner, organizationId: 'organisation-payer' });
  assert.equal(hasFormPersonalPaymentOwner(req, member), false);
});

for (const file of ['direct-debit.js', 'monthly-card.js']) {
  test(`${file} retains auth and tenant checks while accepting verified personal checkout`, async () => {
    const text = readFileSync(new URL(`../membership/${file}`, import.meta.url), 'utf8');
    const start = text.indexOf('async function loadMember(');
    const code = text.slice(start, text.indexOf('\nasync function ', start + 1));
    let authorized = true;
    const query = { select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: member }) };
    const sandbox = vm.createContext({
      authorizeMemberAccess: async () => ({ ok: authorized }),
      supabase: { from: () => query }, hasFormPersonalPaymentOwner,
    });
    vm.runInContext(code, sandbox);
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    for (const source of ['form-joining', 'form-renewal']) {
      const req = request(source);
      assert.equal(await sandbox.loadMember(member.id, 'tenant', res, req), null);
      assert.equal(res.code, 400);
      bindFormPersonalPaymentOwner(req, owner);
      assert.equal(await sandbox.loadMember(member.id, 'tenant', res, req), member);
      assert.equal(await sandbox.loadMember(member.id, 'other-tenant', res, req), null);
      assert.equal(res.code, 403);
      authorized = false;
      assert.equal(await sandbox.loadMember(member.id, 'tenant', res, req), null);
      assert.equal(res.code, 403);
      authorized = true;
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVoucherSettings, voucherDisplayName, voucherOwnerType } from '../../shared/voucherPolicy.js';
import { canReadVoucher, assertVoucherEligible, releaseVoucherCredit } from './voucherCreditService.js';

test('new membership credit supports no expiry only in membership payment contexts',()=>{
 const v={tenant_id:'t',member_id:'m',value:10,status:'active',currency:'GBP',expires_at:null,
  funding_source:'membership_change'};
 const c={tenantId:'t',memberId:'m',settings:{individual_vouchers_enabled:true},allowMembershipChangeCredit:true};
 assert.equal(assertVoucherEligible(v,c),v);
 assert.throws(()=>assertVoucherEligible(v,{...c,allowMembershipChangeCredit:false}),/membership payments only/);
 assert.throws(()=>assertVoucherEligible({...v,expires_at:'2020-01-01'},c),/available/);
 assert.throws(()=>assertVoucherEligible({...v,funding_source:'other'},c),/available/);
});

test('owner names are independent, trimmed, default-off and fail-closed ownership', () => {
  assert.deepEqual(normalizeVoucherSettings(), {
    individual_vouchers_enabled: false, organization_voucher_display_name: 'Training Voucher',
    member_voucher_display_name: 'Training Voucher',
  });
  const settings = [{ setting_key: 'member_voucher_display_name', setting_value: ' Credit ' }];
  assert.equal(voucherDisplayName(settings, 'member'), 'Credit');
  assert.equal(voucherDisplayName(settings, 'organization'), 'Training Voucher');
  assert.equal(voucherDisplayName({ member_voucher_display_name: ' ' }, 'member'), 'Training Voucher');
  assert.equal(normalizeVoucherSettings({ individual_vouchers_enabled: 'false' }).individual_vouchers_enabled, false);
  assert.equal(voucherOwnerType({ organization_id: 'o', member_id: 'm' }), null);
  assert.equal(voucherOwnerType({}), null);
});

test('personal credit has no org role dependency; history survives scheme disablement', () => {
  const v = { tenant_id: 't', member_id: 'm', value: 10, status: 'active', currency: 'GBP', expires_at: '2099-01-01' };
  const c = { tenantId: 't', memberId: 'm', settings: { individual_vouchers_enabled: 'true' } };
  assert.equal(assertVoucherEligible(v, c), v);
  assert.equal(canReadVoucher(v, { ...c, settings: {} }), true);
  assert.equal(canReadVoucher(v, { ...c, tenantId: 'other', isAdmin: true }), false);
  assert.equal(canReadVoucher(v, { ...c, memberId: 'other' }), false);
  assert.throws(() => assertVoucherEligible(v, { ...c, settings: {} }), /disabled/);
  assert.throws(() => assertVoucherEligible(v, { ...c, currency: 'EUR' }), /currency/);
  assert.throws(() => assertVoucherEligible({ ...v, valid_from: '2098-01-01' }, c), /available/);
});

test('org credit requires authenticated matching tenant/org/role; unknown provider never releases', () => {
  const v = { tenant_id: 't', organization_id: 'o', value: 10, status: 'active', expires_at: '2099-01-01' };
  const c = { tenantId: 't', organizationId: 'o', isAuthenticated: true, roleId: 'r',
    organization: { id: 'o', tenant_id: 't', voucher_allowed_role_ids: ['r'] } };
  assert.equal(assertVoucherEligible(v, c), v);
  assert.throws(() => assertVoucherEligible(v, { ...c, isAuthenticated: false }), /authority/);
  assert.throws(() => assertVoucherEligible(v, { ...c, roleId: 'bad' }), /role/);
  assert.throws(() => releaseVoucherCredit({}, { providerOutcome: 'pending' }), /Reconcile/);
});

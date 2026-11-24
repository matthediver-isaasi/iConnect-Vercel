import test from 'node:test';
import assert from 'node:assert/strict';
import {
  membershipProductErrors, freezeMembershipBenefit, validateMembershipBenefitSnapshot,
  collectProposalMembershipBenefits, previewProposalMembershipBenefit, membershipBenefitLabel,
} from './proposalMembershipEntitlements.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const scheduleId = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const org = { id: orgId, tenant_id: tenant };
const schedule = { id: scheduleId, tenant_id: tenant, name: 'Organisation annual', structure_scope_type: 'organization', is_active: true };
const benefit = () => freezeMembershipBenefit(schedule, tenant);
const product = (quantity = '1') => ({ kind: 'product', quantity, catalogueSnapshot: { membershipBenefit: benefit() } });
const bundle = (quantity = '1', componentQuantity = '1') => ({
  kind: 'bundle', quantity, components: [{ quantity: componentQuantity, productSnapshot: { membershipBenefit: benefit() } }],
});
const entitlement = () => ({
  tenant_id: tenant, organization_id: orgId, schedule_id: scheduleId,
  consumed_history_id: null, benefit_snapshot: benefit(),
});
const preview = overrides => previewProposalMembershipBenefit({
  tenantId: tenant, organisationId: orgId, scheduleId, entitlement: entitlement(),
  baseNetMinor: 10000, baseVatMinor: 2000, ...overrides,
});

test('product contract accepts only an explicit schedule, never arbitrary benefit terms', () => {
  assert.deepEqual(membershipProductErrors({ scheduleId }), []);
  assert.deepEqual(membershipProductErrors(null), []);
  for (const value of [undefined, {}, { scheduleId, periods: 5 }, { scheduleId: 'bad' }, []]) {
    assert.ok(membershipProductErrors(value).length);
  }
});

test('schedule snapshot rejects member scope, inactive, missing and foreign schedules', () => {
  for (const candidate of [null, { ...schedule, tenant_id: other }, { ...schedule, structure_scope_type: 'member' },
    { ...schedule, is_active: false }, { ...schedule, name: '' }]) {
    assert.throws(() => freezeMembershipBenefit(candidate, tenant), /organisational membership schedule/);
  }
  assert.equal(freezeMembershipBenefit({ ...schedule, structure_scope_type: null }, tenant).scope, 'organization');
});

test('frozen meaning is independent of later catalogue or schedule edits', () => {
  const source = { ...schedule };
  const snapshot = freezeMembershipBenefit(source, tenant);
  source.name = 'Changed';
  source.id = other;
  assert.equal(snapshot.scheduleId, scheduleId);
  assert.equal(snapshot.scheduleName, schedule.name);
  const copy = validateMembershipBenefitSnapshot(snapshot);
  copy.scheduleName = 'Changed too';
  assert.equal(snapshot.scheduleName, schedule.name);
  assert.match(membershipBenefitLabel(snapshot), /next newly created matching period only/);
  assert.match(membershipBenefitLabel(snapshot), /Add-ons remain payable/);
  for (const patch of [{ periods: 2 }, { baseFeeOnly: false }, { version: 2 }, { coverage: 'forever' }, { extra: true }]) {
    assert.throws(() => validateMembershipBenefitSnapshot({ ...snapshot, ...patch }), /benefit is invalid/);
  }
});

test('standalone and bundled benefits identify their exact occurrence', () => {
  assert.deepEqual(collectProposalMembershipBenefits([product()], org, tenant),
    [{ lineIndex: 0, componentIndex: null, benefit: benefit() }]);
  assert.deepEqual(collectProposalMembershipBenefits([bundle()], org, tenant),
    [{ lineIndex: 0, componentIndex: 0, benefit: benefit() }]);
  assert.equal(collectProposalMembershipBenefits([product('1.000000')], org, tenant).length, 1);
  assert.deepEqual(collectProposalMembershipBenefits([{ kind: 'free_text' }], null, tenant), []);
});

test('duplicates and quantities are rejected, never collapsed into one grant', () => {
  for (const lines of [[product(), product()], [product(), bundle()], [bundle(), bundle()]]) {
    assert.throws(() => collectProposalMembershipBenefits(lines, org, tenant), /more than once/);
  }
  for (const line of [product('2'), product('0.5'), product('0'), product('NaN'), bundle('2'),
    bundle('1', '2'), bundle('0.5', '2'), bundle('2', '0.5')]) {
    assert.throws(() => collectProposalMembershipBenefits([line], org, tenant), /quantity/);
  }
});

test('membership benefits require a tenant-valid customer organisation', () => {
  for (const organisation of [null, {}, { ...org, tenant_id: other }]) {
    assert.throws(() => collectProposalMembershipBenefits([product()], organisation, tenant), /customer organisation/);
  }
});

test('preview waives only the base including its VAT, preserving all add-on economics', () => {
  const result = preview({ addonNetMinor: 3000, addonVatMinor: 600 });
  assert.equal(result.originalBaseNetMinor, 10000);
  assert.equal(result.waivedBaseNetMinor, 10000);
  assert.equal(result.waivedBaseVatMinor, 2000);
  assert.equal(result.remainingTotalMinor, 3600);
  assert.equal(result.noPaymentRequired, false);
  assert.equal(preview({}).noPaymentRequired, true);
  assert.equal('paidAt' in result, false);
  assert.equal('paymentStatus' in result, false);
});

test('preview does not consume, retrofit, cross tenants, or substitute a successor schedule', () => {
  const row = entitlement();
  preview({ entitlement: row });
  assert.equal(row.consumed_history_id, null);
  for (const overrides of [
    { existingHistoryId: other }, { scheduleId: other }, { organisationId: other }, { tenantId: other },
    { entitlement: { ...row, consumed_history_id: other } }, { entitlement: { ...row, consumed_history_id: undefined } },
    { entitlement: null },
  ]) {
    const result = preview(overrides);
    assert.equal(result.eligible, false);
    assert.equal(result.remainingTotalMinor, 12000);
  }
});

test('money validation refuses coercion and overflow', () => {
  for (const baseNetMinor of [null, undefined, '', '10000', NaN, Infinity, -1, 1.1]) {
    assert.throws(() => preview({ baseNetMinor }), /integer minor units/);
  }
  assert.throws(() => preview({ baseNetMinor: Number.MAX_SAFE_INTEGER }), /exceeds/);
  assert.throws(() => preview({ entitlement: { ...entitlement(), benefit_snapshot: { ...benefit(), scheduleId: other } } }),
    /does not match/);
});

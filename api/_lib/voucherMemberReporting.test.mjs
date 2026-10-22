import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDetailRows, filterDetailRows } from './voucherMonthlyReport.js';
import { buildMovements, rollupMonth, deriveOriginalValue, voucherReportOwnerFields } from './voucherMonthlyRollup.js';
import { loadVoucherOwnerPresentation } from './voucherOwnerPresentation.js';

test('personal detail retains owner and does not use delegate as credit owner', () => {
  const rows = buildDetailRows({
    vouchers: [{ id: 'personal', member_id: 'owner', organization_id: null, value: 70, issued_at: '2026-01-01' }],
    transactions: [{ id: 'usage', voucher_id: 'personal', owner_member_id: 'owner', member_id: 'delegate', amount: 30, type: 'booking_usage', created_at: '2026-02-01' }],
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.owner_type === 'member' && row.owner_member_id === 'owner' && !row.organization_id));
  assert.equal(filterDetailRows(rows, { memberId: 'delegate' }).length, 0);
  assert.equal(filterDetailRows(rows, { ownerType: 'member' }).length, 2);
});

test('legacy organisation detail keeps owner and allocation value', () => {
  const rows = buildDetailRows({
    vouchers: [{ id: 'shared', organization_id: 'org', value: 100, issued_at: '2026-01-01' }],
    transactions: [],
  });
  assert.equal(rows[0].organization_id, 'org');
  assert.equal(rows[0].owner_type, 'organization');
  assert.equal(rows[0].amount, 100);
});

test('award, reservation and commit count allocation and spend exactly once per owner', () => {
  const vouchers = [
    { id: 'personal', member_id: 'member-1', value: 70, issued_at: '2026-01-01' },
    { id: 'shared', organization_id: 'org-1', value: 50, issued_at: '2026-01-01' },
  ];
  const transactions = [
    { id: 'award', voucher_id: 'personal', owner_member_id: 'member-1', type: 'award', amount: 100, created_at: '2026-01-01' },
    { id: 'reserve', voucher_id: 'personal', owner_member_id: 'member-1', allocation_id: 'a', type: 'reservation', amount: 30, created_at: '2026-01-10' },
    { id: 'commit', voucher_id: 'personal', owner_member_id: 'member-1', allocation_id: 'a', type: 'booking_usage', amount: 30, created_at: '2026-01-11' },
  ];
  const movements = buildMovements({ vouchers, transactions });
  const summary = rollupMonth({ month: '2026-01', movements });
  assert.equal(summary['member:member-1'].allocated, 100);
  assert.equal(summary['member:member-1'].used, 30);
  assert.equal(summary['member:member-1'].closing_balance, 70);
  assert.equal(summary['member:member-1'].reserved_future, 0);
  assert.equal(summary['org-1'].closing_balance, 50);
  assert.deepEqual(voucherReportOwnerFields('member:member-1'), { organization_id: null, owner_member_id: 'member-1', owner_type: 'member' });
  const detail = buildDetailRows({ vouchers, transactions });
  assert.equal(detail.filter(row => row.owner_member_id === 'member-1').reduce((sum, row) => sum + row.amount, 0), 70);
});

test('pending reservation reduces availability, not finance liability; release restores availability', () => {
  const voucher = { id: 'v', member_id: 'm', value: 70, issued_at: '2026-01-01' };
  const reservation = { id: 'r', voucher_id: 'v', owner_member_id: 'm', allocation_id: 'a', type: 'reservation', amount: 30, created_at: '2026-01-15' };
  assert.equal(deriveOriginalValue(voucher, [reservation]), 100);
  let summary = rollupMonth({ month: '2026-01', movements: buildMovements({ vouchers: [voucher], transactions: [reservation] }) });
  assert.equal(summary['member:m'].closing_balance, 100);
  assert.equal(summary['member:m'].available_balance, 70);
  const release = { ...reservation, id: 'release', type: 'reservation_release', created_at: '2026-02-01' };
  const movements = buildMovements({ vouchers: [{ ...voucher, value: 100 }], transactions: [reservation, release] });
  summary = rollupMonth({ month: '2026-02', movements, openingByOrg: { 'member:m': 100, 'legacy-org': 25 } });
  assert.equal(summary['member:m'].available_balance, 100);
  assert.equal(summary['legacy-org'].opening_balance, 25);
});

test('owner presentation resolves tenant names and keeps independent unpluralized schemes', async () => {
  const scopes = [];
  const db = { from(table) {
    const query = {
      select() { return query; },
      eq(key, value) { scopes.push([table, key, value]); return query; },
      order() { return query; },
      async in() { return { data: [
        { setting_key: 'organization_voucher_display_name', setting_value: ' Credit ' },
        { setting_key: 'member_voucher_display_name', setting_value: ' Learning balance ' },
      ] }; },
      async range() { return { data: [{ id: 'm', first_name: 'Alex', last_name: 'Smith' }] }; },
    };
    return query;
  } };
  const presentation = await loadVoucherOwnerPresentation(db, 'tenant-a');
  assert.equal(presentation.label({ member_id: 'm' }), 'Individual member · Alex Smith · Learning balance');
  assert.equal(presentation.label({ organization_id: 'o' }, 'Example'), 'Organisation · Example · Credit');
  assert.ok(scopes.every(([, key, value]) => key === 'tenant_id' && value === 'tenant-a'));
});

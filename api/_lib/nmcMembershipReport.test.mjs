import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { NMC_TENANT as tenant_id, NMC_FIELDS, NMC_HEADERS, NMC_SHEETS, projectNmcReport, nmcSheet, completedMonths } from './nmcMembershipReport.js';
import { nmcMembershipWorkbook, NMC_EXPORT_COLUMNS } from './nmcMembershipWorkbook.js';
import { nmcReadAll, loadNmcReport } from './nmcMembershipReportLoader.js';
import { createNmcReportHandler } from '../admin/nmc-membership-report/index.js';
import { isResourceExcluded, __setRoleAccessOverlayForTests } from './roleVisibility.js';

__setRoleAccessOverlayForTests([]);

const classes = ['Full', 'Full junior', 'Overseas Full', 'Overseas Full junior', 'Associate', 'Overseas associate', 'Honorary', 'Retired', 'Trainee', 'Student', 'LMIC Full', 'LMIC Full junior', 'Former', 'Department contact', 'CPD Guest', 'Patient representative'];
const options = [...classes, ...classes.slice(0, 12).map(c => `${c} with NMC`)];
const fields = NMC_FIELDS.map(name => ({ id: name, name, tenant_id, entity_scope: 'member', is_active: true, options: name === 'member_class' ? options.map(value => ({ value })) : null }));
const member = { id: 'm1', tenant_id, first_name: 'Synthetic', last_name: 'Member', email: 'fixture@example.invalid', mobile: '+440012300', organization_id: 'o1' };
const term = { id: 'h1', member_id: 'm1', tenant_id, term_start_date: '2025-10-08', term_end_date: '2026-10-07', status: 'active', payment_status: 'paid', payment_method: 'manual' };
const pref = (name, value, id = 'm1') => ({ id: `${id}-${name}`, member_id: id, field_id: name, value });
function fixture(overrides = {}) {
  return { reportDate: '2026-10-07', members: [{ ...member }], history: [{ ...term }], fields,
    organizations: [{ id: 'o1', tenant_id, name: 'Fixture Organisation' },
      { id: 'bnms-primary', tenant_id, name: 'BNMS', is_primary: true }],
    preferences: [pref('member_class', 'Full with NMC'), pref('nmc_address_zip', '00120')], ...overrides };
}
function assertDiagnostics(result) {
  for (const [group, counts] of [['review', result.reviewCounts], ['pending', result.pendingCounts]]) {
    assert.deepEqual(Object.keys(result.diagnostics[group]).sort(), Object.keys(counts).sort());
    for (const [reason, count] of Object.entries(counts)) {
      const members = result.diagnostics[group][reason];
      assert.equal(members.length, count, `${group}/${reason}`);
      assert.equal(new Set(members.map(m => m.memberId)).size, count);
      for (const member of members) assert.deepEqual(Object.keys(member).sort(),
        ['memberId', 'firstName', 'lastName', 'email', 'memberClass'].sort());
    }
  }
}
const report = overrides => {
  const result = projectNmcReport(fixture(overrides));
  assertDiagnostics(result);
  return result;
};
function pendingFixture(provider = 'gocardless') {
  return {
    history: [{ ...term, billing_agreement_id: 'a1', membership_year: '2026/2027',
      status: 'pending_payment_setup', payment_status: 'unpaid' }],
    agreements: [{ id: 'a1', tenant_id, member_id: member.id, provider, environment: 'live',
      status: 'first_payment_pending', needs_attention: false,
      metadata: { [provider === 'stripe' ? 'card' : 'dd']: { activation_rule: 'first_payment' } } }],
    plans: [{ id: 'p1', tenant_id, member_id: member.id, billing_agreement_id: 'a1', provider,
      environment: 'live', status: 'first_payment_pending', interval_unit: 'monthly',
      membership_year: '2026/2027', instalments_paid: 0, instalments_total: 12,
      amount_minor: 1000, needs_attention: false }],
  };
}
test('live first-payment waits are separate from review and never exported; payment AND activation enable original class routing', () => {
  for (const provider of ['gocardless', 'stripe']) {
    for (const klass of ['Full with NMC', 'Full']) {
      const input = { ...pendingFixture(provider), preferences: [pref('member_class', klass)] };
      const pending = report(input);
      assert.deepEqual(pending.pendingCounts, { awaiting_first_payment: 1 });
      assert.deepEqual(pending.reviewCounts, {});
      assert.equal(pending.total, 0);
      assert.ok(pending.sheets.every(s => s.count === 0));
      const wb = XLSX.read(nmcMembershipWorkbook(pending), { type: 'buffer' });
      assert.equal(wb.Sheets[NMC_SHEETS[0]]['!ref'], 'A1:K1');
      assert.equal(wb.Sheets['Online-only']['!ref'], 'A1:E1');
      const paid = { ...input,
        plans: [{ ...input.plans[0], status: 'active', instalments_paid: 1, last_payment_status: 'confirmed' }],
        agreements: [{ ...input.agreements[0], status: 'active' }],
        history: [{ ...input.history[0], payment_status: 'partial' }] };
      assert.equal(report(paid).total, 0, 'payment alone does not activate');
      const active = report({ ...paid, history: [{ ...paid.history[0], status: 'active' }] });
      assert.equal(active.total, 1);
      assert.deepEqual(active.pendingCounts, {});
      assert.equal(active.rows[0].sheet, klass.includes('NMC') ? NMC_SHEETS[0] : 'Online-only');
    }
  }
});
test('manual, failed, malformed, mismatched, test and historical evidence cannot be healthy pending', () => {
  const base = pendingFixture();
  const variants = [
    ...[
      { metadata: { dd: { activation_rule: 'manual' } } }, { metadata: {} },
      { tenant_id: 'foreign' }, { member_id: 'other' }, { organization_id: 'o1' },
      { environment: 'sandbox' }, { status: 'payment_overdue' }, { needs_attention: true },
    ].map(patch => ({ agreements: [{ ...base.agreements[0], ...patch }] })),
    ...[
      { tenant_id: 'foreign' }, { member_id: 'other' }, { organization_id: 'o1' },
      { billing_agreement_id: 'wrong' }, { environment: 'sandbox' }, { status: 'payment_grace_period' },
      { last_payment_status: 'failed' }, { last_payment_status: 'charged_back' },
      { last_payment_status: 'confirmed' }, { needs_attention: true }, { retry_count: 1 },
      { instalments_paid: null }, { instalments_paid: 1 }, { amount_minor: null },
      { grace_expires_at: '2026-10-10' }, { membership_year: 'wrong' },
    ].map(patch => ({ plans: [{ ...base.plans[0], ...patch }] })),
    ...[
      { term_end_date: 'bad' }, { term_start_date: null }, { previous_term_id: 'old' },
      { payment_status: 'partial' }, { status: 'pending_manual_activation' },
    ].map(patch => ({ history: [{ ...base.history[0], ...patch }] })),
    { plans: [] }, { plans: [base.plans[0], { ...base.plans[0], id: 'p2' }] },
    { history: [base.history[0], { ...term, id: 'uncertain', payment_status: 'unpaid' }] },
    { organizations: fixture().organizations.filter(o => o.is_primary) },
  ];
  for (const patch of variants) {
    const result = report({ ...base, ...patch });
    assert.deepEqual(result.pendingCounts, {}, JSON.stringify(patch));
    assert.equal(result.total, 0, JSON.stringify(patch));
  }
});
test('submission event timestamps are not settlement evidence; timestamped failures remain review-only', () => {
  const input = pendingFixture();
  for (const status of ['pending_submission', 'submitted', 'failed', 'confirmed', 'paid_out', null]) {
    const result = report({ ...input, plans: [{ ...input.plans[0],
      last_payment_status: status, last_payment_at: '2026-10-07T10:00:00Z' }] });
    const waiting = ['pending_submission', 'submitted'].includes(status);
    assert.deepEqual(result.pendingCounts, waiting ? { [status === 'submitted' ? 'first_collection_submitted' : 'awaiting_first_payment']: 1 } : {}, status);
    assert.equal(result.total, 0);
    assert.deepEqual(result.reviewCounts, waiting ? {} : { [status === 'failed' ? 'first_collection_failed' : 'unproven_membership_evidence']: 1 });
  }
});
test('mandate-based setup and submitted first collections are diagnostics, never eligible recipients', () => {
  const base = pendingFixture();
  const setup = { ...base, agreements: [{ ...base.agreements[0], status: 'mandate_pending', metadata: { dd: { activation_rule: 'mandate' } } }], plans: [] };
  assert.deepEqual(report(setup).pendingCounts, { awaiting_mandate_setup: 1 });
  assert.equal(report(setup).total, 0);
  const submitted = { ...base, history: [{ ...base.history[0], status: 'active' }],
    agreements: [{ ...base.agreements[0], metadata: { dd: { activation_rule: 'mandate' } } }],
    plans: [{ ...base.plans[0], status: 'mandate_pending', last_payment_status: 'submitted', last_payment_at: '2026-10-07T10:00:00Z' }] };
  assert.deepEqual(report(submitted).pendingCounts, { first_collection_submitted: 1 });
  assert.equal(report(submitted).total, 0);
  assert.deepEqual(report(submitted).reviewCounts, {});
  for (const patch of [
    { history: [{ ...submitted.history[0], previous_term_id: 'old' }] },
    { history: [...submitted.history, { ...term, id: 'other' }] },
    { plans: [{ ...submitted.plans[0], member_id: 'foreign' }] },
    { plans: [{ ...submitted.plans[0], instalments_paid: 1 }] },
    { plans: [{ ...submitted.plans[0], last_payment_status: 'confirmed' }] },
    { agreements: [{ ...submitted.agreements[0], environment: 'sandbox' }] },
    { agreements: [{ ...submitted.agreements[0], metadata: { dd: { activation_rule: 'manual' } } }] },
  ]) {
    assert.deepEqual(report({ ...submitted, ...patch }).pendingCounts, {});
  }
  const failed = report({ ...base, plans: [{ ...base.plans[0], status: 'payment_grace_period', last_payment_status: 'failed', grace_expires_at: '2026-10-14' }] });
  assert.deepEqual(failed.reviewCounts, { first_collection_failed: 1 });
  assert.deepEqual(failed.pendingCounts, {});
  assert.equal(failed.total, 0);
});
test('default class mappings keep only full print classes; roles never determine routing', () => {
  const allowed = new Set(options);
  for (const c of classes) assert.equal(nmcSheet(c, allowed), NMC_SHEETS[1]);
  for (const c of classes.slice(0, 4)) assert.equal(nmcSheet(`${c} with NMC`, allowed), NMC_SHEETS[0]);
  for (const c of classes.slice(4, 12)) assert.equal(nmcSheet(`${c} with NMC`, allowed), null);
  for (const c of ['', 'No NMC', 'Full with NMC ', 'Unknown']) assert.equal(nmcSheet(c, allowed), null);
  assert.equal(report({ members: [{ ...member, role_id: 'Full with NMC', login_enabled: false }], preferences: [pref('member_class', 'Full')] }).rows[0].sheet, 'Online-only');
});
test('expiry day active; day 90 included; day 91 excluded; valid dates only', () => {
  assert.equal(report().rows[0].cells[12], 'Active');
  const historic = expiry => report({ history: [{ ...term, term_end_date: expiry }] });
  assert.equal(historic('2026-07-09').rows[0].cells[12], 'Expired');
  assert.equal(historic('2026-07-08').excludedCounts.expired_over_90_days, 1);
  assert.equal(historic('2026-07-09').rows[0].cells[13], 2);
  for (const expiry of ['2026-02-30', '07/09/2026', 'bad']) assert.equal(historic(expiry).reviewCounts.invalid_expiry_or_term, 1);
  assert.equal(report({ history: [{ ...term, term_start_date: '2027-01-01' }] }).reviewCounts.invalid_expiry_or_term, 1);
});
test('saved selections route renamed/new classes, exclude unselected classes and retain evidence boundaries', () => {
  const settings = { printedClasses: ['new-class-id'], onlineClasses: ['Full with NMC'], revision: 2 };
  const customFields = fields.map(f => f.name === 'member_class'
    ? { ...f, options: [...f.options, { value: 'new-class-id', label: 'New printed membership' }] } : f);
  const result = report({ settings, fields: customFields, preferences: [pref('member_class', 'new-class-id')] });
  assert.equal(result.rows[0].sheet, 'Full and Full Junior');
  assert.deepEqual(result.classCounts.printed, [{ value: 'new-class-id', label: 'New printed membership', count: 1 }]);
  assert.equal(result.classCounts.online[0].count, 0);
  assert.equal(report({ settings }).rows[0].sheet, 'Online-only', 'explicit online selection overrides NMC in name');
  const missing = report({ settings, fields: customFields, preferences: [pref('member_class', 'new-class-id')], history: [] });
  assert.equal(missing.total, 0);
  assert.equal(missing.reviewCounts.missing_membership_evidence, 1);
  const empty = report({ settings: { printedClasses: [], onlineClasses: [], revision: 1 } });
  assert.equal(empty.total, 0);
  assert.equal(empty.excludedCounts.class_not_selected_for_journal, 1);
  assert.deepEqual(empty.classCounts, { printed: [], online: [] });
});
test('completed calendar months clamp anniversaries to month end and preserve leap days', () => {
  for (const [expiry, today, expected] of [
    ['2026-01-31', '2026-02-28', 1], ['2024-01-31', '2024-02-29', 1],
    ['2026-01-31', '2026-03-30', 1], ['2026-01-31', '2026-03-31', 2],
    ['2024-02-29', '2025-02-28', 12], ['2026-10-07', '2026-10-07', 0],
  ]) assert.equal(completedMonths(expiry, today), expected);
});
test('custom legacy status and expiry are review-only; honorary exception narrowly owner-approved', () => {
  const legacyPrefs = [pref('member_class', 'Full'), pref('membership_status', 'Active'), pref('ym_date_membership_expires', '10/7/26')];
  assert.equal(report({ history: [], preferences: legacyPrefs }).reviewCounts.missing_membership_evidence, 1);
  const honorary = [pref('member_class', 'Honorary'), pref('membership_status', 'Active')];
  assert.equal(report({ history: [], preferences: honorary }).rows[0].sheet, 'Online-only');
  assert.equal(report({ history: [], preferences: [...honorary, pref('ym_date_membership_expires', 'bad')] }).total, 0);
  assert.equal(report({ history: [], preferences: [pref('member_class', 'Honorary')] }).total, 0);
  assert.equal(report({ history: [], preferences: [pref('member_class', 'Student'), pref('membership_status', 'Full application received')] }).excludedCounts.applicant_only, 1);
  // Retained DD history does not invalidate independent approved membership evidence.
  assert.equal(report({ members: [{ ...member, due_diligence_status: 'in_review', login_enabled: false }] }).total, 1);
});
test('reviewed expiry-only histories stay eligible without inventing start/settlement', () => {
  const legacy = { id: 'h1', tenant_id, member_id: 'm1', membership_year: '2025/2026',
    status: 'expired', payment_status: 'paid', payment_method: 'upfront', billing_period: 'annual',
    currency: 'GBP', tier_label: 'Full UK', term_end_date: '2026-09-01',
    notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill' }), final_cost: null, total_with_vat: null };
  assert.equal(report({ history: [legacy] }).rows[0].cells[12], 'Expired');
  assert.equal(report({ history: [{ ...legacy, notes: '{}' }] }).total, 0);
  assert.equal(report({ history: [{ ...legacy, payment_status: 'unpaid' }] }).total, 0);
});
test('administrative recognition binds tenant/member/history/agreement and expiry', () => {
  const h = { ...term, billing_agreement_id: 'a1', status: 'pending_payment_setup', payment_status: 'unpaid' };
  const a = { id: 'a1', tenant_id, member_id: 'm1', environment: 'live', status: 'first_payment_pending' };
  const r = { tenant_id, member_id: 'm1', history_id: 'h1', agreement_id: 'a1', effective_from: '2026-09-21', effective_until: '2027-10-01', revoked_at: null };
  const input = { history: [h], agreements: [a], recognitions: [r] };
  assert.equal(report(input).total, 1);
  for (const patch of [{ tenant_id: 'foreign' }, { member_id: 'foreign' }, { agreement_id: 'wrong' }, { revoked_at: '2026-10-01' }]) {
    assert.equal(report({ ...input, recognitions: [{ ...r, ...patch }] }).total, 0);
  }
  assert.equal(report({ ...input, recognitions: [r, r] }).reviewCounts.ambiguous_membership_evidence, 1);
  assert.equal(report({ ...input, agreements: [{ ...a, environment: 'sandbox' }] }).total, 0);
});
test('successors: one current row, future does not replace current, unproven commenced successor blocks resurrection', () => {
  const old = { ...term, id: 'old', term_start_date: '2025-09-01', term_end_date: '2026-08-31', status: 'expired' };
  const next = { ...term, id: 'new', term_start_date: '2026-09-01', term_end_date: '2027-08-31', previous_term_id: 'old' };
  assert.equal(report({ history: [old, next] }).total, 1);
  assert.equal(report({ history: [old, next] }).rows[0].cells[12], 'Active');
  assert.equal(report({ history: [term, { ...next, term_start_date: '2026-10-08', previous_term_id: 'h1' }] }).total, 1);
  assert.equal(report({ history: [old, { ...next, payment_status: 'unpaid', status: 'cancelled' }] }).total, 0);
  assert.equal(report({ history: [term, { ...term, id: 'overlap' }] }).reviewCounts.ambiguous_membership_evidence, 1);
});
test('deleted/test/contact-only records excluded; incomplete and ambiguous values reviewed', () => {
  for (const patch of [{ email: 'deleted_123@deleted.local' }, { is_sample: true }, { is_guest: true }]) assert.equal(report({ members: [{ ...member, ...patch }] }).total, 0);
  for (const klass of ['CPD Guest', 'Department contact']) assert.equal(report({ history: [], preferences: [pref('member_class', klass)] }).excludedCounts.nonmember_contact, 1);
  assert.equal(report({ preferences: [] }).reviewCounts.missing_class, 1);
  assert.equal(report({ preferences: [pref('member_class', 'unknown')] }).reviewCounts.unknown_class, 1);
  assert.equal(report({ preferences: [pref('member_class', 'Full'), pref('member_class', 'Full')] }).reviewCounts.duplicate_custom_values, 1);
  assert.equal(report({ organizations: fixture().organizations.filter(o => o.is_primary) }).reviewCounts.unresolved_organisation, 1);
  assert.throws(() => report({ fields: [] }));
  assert.throws(() => report({ members: [member, member] }));
  assert.throws(() => report({ members: [{ ...member, tenant_id: 'foreign' }] }));
});
test('two recipient sheets use exact reduced headers and literal text; class counts are separate', () => {
  const result = report({ members: [{ ...member, first_name: '=1+1', last_name: '@unsafe' }],
    preferences: [pref('member_class', 'Full with NMC'), pref('nmc_address_zip', '00120'), pref('nmc_address_line_1', ' \\t=HYPERLINK(\"bad\")')] });
  const wb = XLSX.read(nmcMembershipWorkbook(result), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, [...NMC_SHEETS, 'Class counts']);
  for (const name of NMC_SHEETS) {
    assert.ok(name.length <= 31);
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    assert.deepEqual(grid[0], NMC_EXPORT_COLUMNS[name].map(c => NMC_HEADERS[c]));
  }
  const sheet = wb.Sheets[NMC_SHEETS[0]];
  for (const cell of ['B2', 'C2', 'D2', 'H2', 'J2']) {
    assert.equal(sheet[cell].t, 's'); assert.equal(sheet[cell].f, undefined);
  }
  assert.equal(sheet.H2.v, '00120');
  assert.equal(sheet.E2.v, ''); assert.equal(sheet.K2.v, ''); assert.equal(sheet.L2, undefined);
  assert.equal(wb.Sheets['Class counts'].B5.v, 1);
  const empty = XLSX.read(nmcMembershipWorkbook(report({ members: [] })), { type: 'buffer' });
  assert.equal(empty.Sheets[NMC_SHEETS[0]]['!ref'], 'A1:K1');
  assert.equal(empty.Sheets['Online-only']['!ref'], 'A1:E1');
  assert.equal(empty.Sheets[NMC_SHEETS[0]].K1.v, 'NMC Customer Number');
  assert.equal(empty.Sheets['Online-only'].E1.v, 'NMC Customer Number');
});

test('customer numbers append to both recipient sheets as literal text without changing existing report data', () => {
  const numbers = ['0000123', '=1+1', '+00123', '-00123', '@SUM(A1:A2)', ' \t=HYPERLINK("https://example.invalid")', null, undefined];
  const members = NMC_SHEETS.flatMap((sheet, group) => numbers.map((_, index) => ({
    ...member, id: `g${group}-${index}`, last_name: `Recipient ${numbers.length - index}`, group,
  })));
  const input = {
    members,
    history: members.map(m => ({ ...term, id: `h-${m.id}`, member_id: m.id })),
    preferences: members.flatMap(m => [
      pref('member_class', m.group === 0 ? 'Full with NMC' : 'Full', m.id),
      pref('title', 'Dr', m.id), pref('nmc_address_zip', '00120', m.id),
    ]),
  };
  const baseline = report(input);
  const result = report({ ...input, preferences: [...input.preferences, ...members.flatMap(m => {
    const number = numbers[Number(m.id.split('-')[1])];
    return number === undefined ? [] : [pref('nmc_customer_number', number, m.id)];
  })] });
  assert.deepEqual({ ...result, rows: result.rows.map(row => ({ ...row, cells: [...row.cells.slice(0, 16), ''] })) }, baseline,
    'sorting, eligibility, routing, counts, diagnostics and all existing cells remain unchanged');
  const wb = XLSX.read(nmcMembershipWorkbook(result), { type: 'buffer', cellNF: true, cellStyles: true });
  const before = XLSX.read(nmcMembershipWorkbook(baseline), { type: 'buffer', cellNF: true, cellStyles: true });
  assert.deepEqual(wb.SheetNames, ['Full and Full Junior', 'Online-only', 'Class counts']);
  assert.deepEqual(wb.Sheets['Class counts'], before.Sheets['Class counts']);
  const expectedHeaders = [
    ['Title', 'First name', 'Last name', 'NMC address line 1', 'NMC address line 2', 'NMC address line 3',
      'NMC address city', 'NMC address post/zip code', 'NMC address country', 'Email address', 'NMC Customer Number'],
    ['Title', 'First name', 'Last name', 'Email address', 'NMC Customer Number'],
  ];
  NMC_SHEETS.forEach((name, group) => {
    const sheet = wb.Sheets[name], grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    assert.deepEqual(grid[0], expectedHeaders[group]);
    assert.equal(grid.length, numbers.length + 1);
    const lastColumn = expectedHeaders[group].length - 1;
    assert.ok(sheet['!cols'][lastColumn].wch >= 20);
    assert.equal(sheet['!autofilter'].ref, sheet['!ref']);
    result.rows.filter(row => row.sheet === name).forEach((row, index) => {
      const expected = numbers[Number(row.memberId.split('-')[1])] ?? '';
      assert.equal(row.cells[16], expected);
      const address = XLSX.utils.encode_cell({ r: index + 1, c: lastColumn });
      const cell = sheet[address];
      assert.equal(cell.v, expected); assert.equal(cell.t, 's'); assert.equal(cell.z, '@');
      assert.equal(cell.f, undefined); assert.equal(cell.l, undefined);
      for (let c = 0; c < lastColumn; c++) {
        const original = XLSX.utils.encode_cell({ r: index + 1, c });
        assert.deepEqual(sheet[original], before.Sheets[name][original]);
      }
    });
  });
});

test('customer-number definitions retain unique active member authority and duplicate values stay review-only', () => {
  const definition = fields.find(f => f.name === 'nmc_customer_number');
  const otherFields = fields.filter(f => f !== definition);
  for (const definitions of [
    [], [{ ...definition, tenant_id: 'foreign' }], [{ ...definition, entity_scope: 'organization' }],
    [{ ...definition, is_active: false }], [definition, { ...definition, id: 'second-definition' }],
  ]) assert.throws(() => report({ fields: [...otherFields, ...definitions] }), /Required report field is missing or ambiguous/);
  const result = report({ preferences: [...fixture().preferences,
    pref('nmc_customer_number', '0001'), { ...pref('nmc_customer_number', '0001'), id: 'duplicate' }] });
  assert.equal(result.total, 0);
  assert.deepEqual(result.reviewCounts, { duplicate_custom_values: 1 });
});

test('class labels and tenant-scoped RBAC role names are literal text and do not affect eligibility', () => {
  const result = report({
    members: [{ ...member, role_id: 'role-id' }],
    roles: [{ id: 'role-id', tenant_id, name: '=Super Admin' }],
    fields: fields.map(f => f.name === 'member_class' ? { ...f, options: options.map(value => ({ value, label: value === 'Full with NMC' ? 'Full membership with journal' : value })) } : f),
  });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].sheet, NMC_SHEETS[0]);
  assert.deepEqual(result.rows[0].cells.slice(14, 16), ['Full membership with journal', '=Super Admin']);
  const sheet = XLSX.read(nmcMembershipWorkbook(result), { type: 'buffer' }).Sheets[NMC_SHEETS[0]];
  assert.equal(sheet.O2, undefined);
  assert.equal(sheet.P2, undefined);
  assert.equal(result.classCounts.printed[0].label, 'Full membership with journal');
  assert.equal(report().rows[0].cells[15], 'No role assigned');
  const unavailable = report({ members: [{ ...member, role_id: 'foreign-role' }], roles: [{ id: 'foreign-role', tenant_id: 'foreign', name: 'Private name' }] });
  assert.equal(unavailable.rows[0].cells[15], 'Role unavailable');
  assert.equal(unavailable.total, 1);
});

function fakeDatabase(tables, { cap = 317, failTable, calls = [] } = {}) {
  return { from(table) {
    const filters = []; let key = 'id', limit = 500, columns = '*';
    const q = {
      select(selected, options) { columns = selected; if (options) assert.equal(options.count, 'exact'); return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, values) { filters.push(r => values.includes(r[k])); return q; },
      gt(k, v) { filters.push(r => r[k] > v); return q; },
      order(k) { key = k; return q; }, limit(n) { limit = n; return q; },
      async maybeSingle() {
        const result = await q;
        return { ...result, data: result.data?.[0] || null };
      },
      then(resolve, reject) {
        calls.push(table);
        const all = (tables[table] || []).filter(r => filters.every(f => f(r))).sort((a, b) => a[key].localeCompare(b[key]));
        return Promise.resolve(table === failTable ? { data: null, error: { message: 'private error' } }
          : { data: all.slice(0, Math.min(cap, limit)).map(row => columns === '*' ? row
            : Object.fromEntries(columns.split(',').map(column => [column, row[column]]))),
            error: null, count: all.length }).then(resolve, reject);
      },
    }; return q;
  } };
}
test('full loader/export passes 1000-row limit and smaller provider caps, with unique rows and scoped preferences', async () => {
  const members = Array.from({ length: 1207 }, (_, i) => ({ ...member, role_id: 'report-role', id: `m${String(i).padStart(5, '0')}` }));
  const customerField = fields.find(f => f.name === 'nmc_customer_number');
  const customerFieldId = 'customer-definition-id';
  const calls = [];
  const db = fakeDatabase({
    member: [...members, { ...member, id: 'foreign', tenant_id: 'foreign' }],
    preference_field: [...fields.map(f => f === customerField ? { ...f, id: customerFieldId } : f),
      { ...customerField, id: 'foreign-field', tenant_id: 'foreign' },
      { ...customerField, id: 'org-field', entity_scope: 'organization' },
      { ...customerField, id: 'inactive-field', is_active: false },
      { ...customerField, id: 'unrelated-field', name: 'unrelated' }],
    member_membership_history: members.map(m => ({ ...term, id: `h-${m.id}`, member_id: m.id })),
    organization: fixture().organizations,
    role: [{ id: 'report-role', tenant_id, name: 'Super Admin' }, { id: 'foreign-role', tenant_id: 'foreign', name: 'Other tenant' }],
    member_preference_value: [
      ...members.flatMap((m, i) => [pref('member_class', i % 2 ? 'Full' : 'Full with NMC', m.id),
        pref('nmc_address_zip', '00001', m.id),
        ...(i % 3 ? [pref(customerFieldId, `00${i}`, m.id)] : []),
        ...['foreign-field', 'org-field', 'inactive-field', 'unrelated-field'].map(f => pref(f, 'wrong value', m.id))]),
      pref(customerFieldId, 'foreign member value', 'foreign'),
    ],
  }, { cap: 73, calls });
  const result = await loadNmcReport(db, '2026-10-07');
  assert.equal(result.total, 1207); assert.equal(new Set(result.rows.map(r => r.memberId)).size, 1207);
  result.rows.forEach(row => {
    const index = Number(row.memberId.slice(1));
    assert.equal(row.cells[14], index % 2 ? 'Full' : 'Full with NMC');
    assert.equal(row.cells[15], 'Super Admin');
    assert.equal(row.cells[16], index % 3 ? `00${index}` : '');
  });
  assert.ok(calls.filter(table => table === 'member_preference_value').length > 39, 'preferences span multiple pages within member batches');
  const wb = XLSX.read(nmcMembershipWorkbook(result), { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Online-only']).length, 603);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets[NMC_SHEETS[0]]).length, 604);
  for (const name of NMC_SHEETS) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    assert.deepEqual(grid.slice(1).map(row => row.at(-1)), result.rows.filter(row => row.sheet === name).map(row => row.cells[16]));
  }
  await assert.rejects(loadNmcReport(fakeDatabase({}, { failTable: 'member' }), '2026-10-07'));
  await assert.rejects(nmcReadAll(() => ({ order() { return this; }, limit() { return Promise.resolve({ data: [], count: 1 }); } })));
});

test('customer-number loading fails closed on read errors and out-of-scope values', async () => {
  const tables = { member: [member], preference_field: fields, organization: fixture().organizations,
    member_membership_history: [term],
    member_preference_value: [...fixture().preferences, pref('nmc_customer_number', '000123')] };
  for (const failTable of ['preference_field', 'member_preference_value']) {
    await assert.rejects(loadNmcReport(fakeDatabase(tables, { failTable }), '2026-10-07'),
      /Report data could not be loaded completely/);
  }
  for (const patch of [{ member_id: 'foreign-member' }, { field_id: 'foreign-field' }]) {
    const db = fakeDatabase(tables);
    const from = db.from;
    db.from = table => {
      const query = from(table);
      if (table === 'member_preference_value') {
        const then = query.then;
        query.then = (resolve, reject) => then(result => resolve({ ...result, data: result.data.map(row =>
          row.field_id === 'nmc_customer_number' ? { ...row, ...patch } : row) }), reject);
      }
      return query;
    };
    await assert.rejects(loadNmcReport(db, '2026-10-07'), /Preference ownership mismatch/);
  }
  const duplicate = await loadNmcReport(fakeDatabase({ ...tables, member_preference_value: [
    ...tables.member_preference_value, { ...pref('nmc_customer_number', '000123'), id: 'second-value' },
  ] }, { cap: 1 }), '2026-10-07');
  assert.equal(duplicate.total, 0);
  assert.deepEqual(duplicate.reviewCounts, { duplicate_custom_values: 1 });
});

test('complete-read safeguards reject changing totals, repeated keys and truncated pages', async () => {
  for (const pages of [
    [{ data: [{ id: 'a' }], count: 2 }, { data: [{ id: 'b' }], count: 2 }],
    [{ data: [{ id: 'a' }], count: 2 }, { data: [{ id: 'a' }], count: 1 }],
    [{ data: [{ id: 'a' }], count: 2 }, { data: [], count: 1 }],
  ]) {
    let page = 0;
    await assert.rejects(nmcReadAll(() => ({
      order() { return this; }, limit() { return this; }, gt() { return this; },
      then(resolve) { return Promise.resolve(pages[page++]).then(resolve); },
    })), /Report data changed|Report pagination ambiguous|Report pagination incomplete/);
  }
});

function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; },
    json(v) { this.body = v; return this; }, send(v) { this.body = v; return this; } };
}
test('BNMS primary organisation staff disappear before every counter, regardless of email or evidence', async () => {
  const baseline = fixture();
  // An ordinary external member with a BNMS email must remain eligible.
  baseline.members[0].email = 'ordinary@bnms.org.uk';
  const staff = [
    { id: 'staff-missing' },
    { id: 'staff-paid' },
    { id: 'staff-duplicate' },
    { id: 'staff-deleted', status: 'deleted' },
    { id: 'staff-sample', is_sample: true },
    { id: 'staff-guest', is_guest: true },
  ].map(m => ({ ...member, ...m, organization_id: 'bnms-primary', email: `${m.id}@external.invalid` }));
  const input = {
    ...baseline,
    members: [...baseline.members, ...staff, { ...member, id: 'external-missing' }],
    organizations: [...baseline.organizations,
      { id: 'o1', tenant_id: 'foreign', name: 'Foreign primary', is_primary: true }],
    history: [...baseline.history, { ...term, id: 'staff-history', member_id: 'staff-paid' }],
    preferences: [...baseline.preferences, pref('member_class', 'Full with NMC', 'staff-paid'),
      pref('member_class', 'Full', 'staff-duplicate'),
      { ...pref('member_class', 'Full', 'staff-duplicate'), id: 'staff-duplicate-second-value' }],
  };
  const before = structuredClone(input);
  const expected = projectNmcReport({ ...baseline, members: [...baseline.members, { ...member, id: 'external-missing' }] });
  const projected = projectNmcReport(input);
  assert.deepEqual(projected, expected);
  assert.deepEqual(projected.reviewCounts, { missing_class: 1 });
  assert.deepEqual(projected.excludedCounts, {});
  assert.equal(projected.total, 1);
  const tables = {
    member: [...input.members, { ...member, id: 'foreign-member', tenant_id: 'foreign' }],
    preference_field: input.fields, member_membership_history: input.history,
    member_preference_value: input.preferences, organization: input.organizations,
  };
  assert.deepEqual(await loadNmcReport(fakeDatabase(tables, { cap: 2 }), input.reportDate), expected);
  assert.deepEqual(input, before, 'projection and loader must not mutate members or memberships');
  const wb = XLSX.read(nmcMembershipWorkbook(projected), { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets[NMC_SHEETS[0]]).length, 1);
});

test('primary organisation authority must be complete and unique, never inferred from name or email', async () => {
  for (const organizations of [
    [],
    [{ id: 'o1', tenant_id, name: 'BNMS', domain: 'bnms.org.uk' }],
    [...fixture().organizations, { id: 'second-primary', tenant_id, is_primary: true }],
    [{ id: 'foreign-primary', tenant_id: 'foreign', is_primary: true }],
  ]) {
    assert.throws(() => report({ organizations }), /Primary report organisation/);
  }
  await assert.rejects(loadNmcReport(fakeDatabase({}, { failTable: 'organization' }), '2026-10-07'));
});

test('loader reads scoped plans completely and fails closed when plans cannot load', async () => {
  const input = pendingFixture();
  const tables = { member: [member], preference_field: fields,
    member_membership_history: input.history, membership_billing_agreements: input.agreements,
    membership_payment_plans: [...input.plans, { ...input.plans[0], id: 'foreign', tenant_id: 'foreign' }],
    organization: fixture().organizations, member_preference_value: fixture().preferences };
  const result = await loadNmcReport(fakeDatabase(tables, { cap: 1 }), '2026-10-07');
  assert.deepEqual(result.pendingCounts, { awaiting_first_payment: 1 });
  await assert.rejects(loadNmcReport(fakeDatabase(tables, { failTable: 'membership_payment_plans' }), '2026-10-07'));
});
const ctx = { isAuthenticated: true, tenantId: tenant_id, roleId: 'admin', memberExcludedFeatures: [] };
test('individual admin revocation denies JSON and XLSX even when the report permission remains; tenant-user admin path preserved', async () => {
  for (const format of ['json', 'xlsx']) {
    for (const memberExcludedFeatures of [['admin.role-management'], ['admin']]) {
      let loaded = false;
      const deps = { db: {}, getTenantContext: async () => ({ ...ctx, memberExcludedFeatures }),
        hasAdminAccess: async () => true,
        hasFeatureAccess: async (role, feature, exclusions) => {
          assert.equal(role, 'admin');
          return !isResourceExcluded(exclusions, feature);
        },
        loadReport: async () => { loaded = true; return report(); } };
      assert.equal(isResourceExcluded(memberExcludedFeatures, 'membership.nmc-membership-report'), false);
      const denied = response();
      await createNmcReportHandler(deps)({ method: 'GET', query: { format } }, denied);
      assert.equal(denied.statusCode, 403); assert.equal(loaded, false);
      const tenantUser = response();
      await createNmcReportHandler({ ...deps,
        getTenantContext: async () => ({ ...ctx, roleId: null, tenantUserId: 'tenant-admin', memberExcludedFeatures }),
      })({ method: 'GET', query: { format } }, tenantUser);
      assert.equal(tenantUser.statusCode, 200); assert.equal(loaded, true);
    }
  }
});
test('JSON and workbook authenticate, enforce tenant/admin/feature, never trust client tenant', async () => {
  for (const format of ['json', 'xlsx']) {
    for (const [context, admin, feature, expected] of [
      [null, true, true, 401], [{ ...ctx, isAuthenticated: false }, true, true, 401],
      [{ ...ctx, tenantId: 'foreign' }, true, true, 404], [{ ...ctx, tenantMismatch: true }, true, true, 404],
      [ctx, false, true, 403], [ctx, true, false, 403], [{ ...ctx, roleId: null }, true, true, 403],
    ]) {
      let loaded = false;
      const handler = createNmcReportHandler({ db: {}, getTenantContext: async () => context, hasAdminAccess: async () => admin,
        hasFeatureAccess: async () => feature, loadReport: async () => { loaded = true; return report(); } });
      const res = response(); await handler({ method: 'GET', query: { format } }, res);
      assert.equal(res.statusCode, expected); assert.equal(loaded, false);
      assert.equal(res.headers['Cache-Control'], 'private, no-store');
    }
  }
  let featureArgs;
  const deps = { db: {}, getTenantContext: async () => ctx, hasAdminAccess: async () => true,
    hasFeatureAccess: async (...args) => { featureArgs = args; return true; },
    loadReport: async (_, date) => { assert.equal(date, '2026-10-07'); return report(); }, now: () => new Date('2026-10-07T23:59:59Z') };
  const handler = createNmcReportHandler(deps);
  const json = response(); await handler({ method: 'GET' }, json);
  assert.equal(json.statusCode, 200); assert.equal(json.body.rows, undefined); assert.equal(json.body.total, 1);
  assert.deepEqual(featureArgs, ['admin', 'membership.nmc-membership-report', []]);
  const excel = response(); await handler({ method: 'GET', query: { format: 'xlsx' } }, excel);
  assert.equal(excel.statusCode, 200); assert.ok(Buffer.isBuffer(excel.body));
  for (const query of [{ tenantId: tenant_id }, { date: '2026-01-01' }, { format: 'csv' }]) {
    const res = response(); await handler({ method: 'GET', query }, res); assert.equal(res.statusCode, 400);
  }
  const failed = response();
  await createNmcReportHandler({ ...deps, loadReport: async () => { throw new Error('secret PII'); } })({ method: 'GET', query: { format: 'xlsx' } }, failed);
  assert.equal(failed.statusCode, 500); assert.ok(!JSON.stringify(failed).includes('secret PII')); assert.equal(failed.headers['Content-Disposition'], undefined);
});

test('every review and first-payment branch retains the exact minimal member identity', () => {
  const base = pendingFixture();
  const cases = [
    ['review', 'missing_class', { preferences: [] }, null],
    ['review', 'unknown_class', { preferences: [pref('member_class', 'not-known')] }, null],
    ['review', 'duplicate_custom_values', { preferences: [pref('member_class', 'Full'), pref('member_class', 'Full')] }, null],
    ['review', 'duplicate_custom_values', { preferences: [pref('member_class', 'Full'), pref('title', 'A'), pref('title', 'B')] }, 'Full'],
    ['review', 'unresolved_organisation', { members: [{ ...member, organization_id: 'missing' }] }],
    ['review', 'unresolved_organisation', { ...base, members: [{ ...member, organization_id: 'missing' }] }],
    ['review', 'missing_membership_evidence', { history: [] }],
    ['review', 'invalid_expiry_or_term', { history: [{ ...term, term_end_date: 'bad' }] }],
    ['review', 'missing_expiry', { history: [{ ...term, term_end_date: null }] }],
    ['review', 'unproven_membership_evidence', { history: [{ ...term, payment_status: 'unpaid' }] }],
    ['review', 'ambiguous_membership_evidence', { history: [term, { ...term, id: 'h2' }] }],
    ['review', 'first_collection_failed', { ...base, plans: [{ ...base.plans[0], last_payment_status: 'failed' }] }],
    ['pending', 'awaiting_first_payment', base],
    ['pending', 'first_collection_submitted', { ...base, plans: [{ ...base.plans[0], last_payment_status: 'submitted' }] }],
    ['pending', 'awaiting_mandate_setup', { ...base, agreements: [{ ...base.agreements[0], status: 'mandate_pending' }], plans: [] }],
  ];
  for (const [group, reason, overrides, memberClass = 'Full with NMC'] of cases) {
    const result = report(overrides);
    assert.deepEqual(result[`${group}Counts`], { [reason]: 1 }, reason);
    assert.deepEqual(result.diagnostics[group][reason], [{
      memberId: 'm1', firstName: 'Synthetic', lastName: 'Member',
      email: 'fixture@example.invalid', memberClass,
    }], reason);
    assert.deepEqual(result.diagnostics[group === 'review' ? 'pending' : 'review'], {});
    assert.equal(result.total, 0);
  }
});

test('diagnostic names and labels use honest missing values, without leaking raw unknown classes', () => {
  const result = report({ members: [{ ...member, first_name: null, last_name: '  ', email: null }],
    preferences: [pref('member_class', 'raw-unknown-value')] });
  assert.deepEqual(result.diagnostics.review.unknown_class, [{
    memberId: 'm1', firstName: null, lastName: null, email: null, memberClass: null,
  }]);
  const labelled = report({ history: [], fields: fields.map(f => f.name === 'member_class'
    ? { ...f, options: options.map(value => ({ value, label: value === 'Full with NMC' ? 'Printed full member' : value })) } : f) });
  assert.equal(labelled.diagnostics.review.missing_membership_evidence[0].memberClass, 'Printed full member');
});

test('complete diagnostic loading beyond 1000 members is stable by last name, first name and ID; staff/foreign rows stay absent', async () => {
  const members = Array.from({ length: 1207 }, (_, i) => ({
    ...member, id: `m${String(i).padStart(5, '0')}`, last_name: i % 2 ? 'Alpha' : 'Zulu',
    first_name: i % 3 ? 'Bea' : 'Ada',
  }));
  const staff = { ...member, id: 'staff', organization_id: 'bnms-primary' };
  const tables = {
    member: [...members, staff, { ...member, id: 'foreign', tenant_id: 'foreign' }],
    preference_field: fields, organization: fixture().organizations,
    member_preference_value: [...members, staff].map(m => pref('member_class', 'Full', m.id)),
  };
  const expected = [...members].sort((a, b) => a.last_name.localeCompare(b.last_name, 'en-GB')
    || a.first_name.localeCompare(b.first_name, 'en-GB') || a.id.localeCompare(b.id)).map(m => m.id);
  const loaded = await loadNmcReport(fakeDatabase(tables, { cap: 113 }), '2026-10-07');
  assertDiagnostics(loaded);
  assert.deepEqual(loaded.reviewCounts, { missing_membership_evidence: 1207 });
  const ids = loaded.diagnostics.review.missing_membership_evidence.map(m => m.memberId);
  assert.deepEqual(ids, expected);
  const reversed = projectNmcReport(fixture({ members: [...members].reverse(), history: [],
    preferences: tables.member_preference_value }));
  assert.deepEqual(reversed.diagnostics, loaded.diagnostics);
  const pages = Array.from({ length: Math.ceil(ids.length / 25) }, (_, page) => ids.slice(page * 25, (page + 1) * 25));
  assert.deepEqual(pages.flat(), expected);
  assert.equal(pages.at(-1).length, 7);
  assert.equal(loaded.total, 0);
});

test('staff with pending or failed collections never enter diagnostics', () => {
  const base = pendingFixture();
  for (const last_payment_status of [null, 'submitted', 'failed']) {
    const result = report({ ...base, members: [{ ...member, organization_id: 'bnms-primary' }],
      plans: [{ ...base.plans[0], last_payment_status }] });
    assert.deepEqual(result.diagnostics, { review: {}, pending: {} });
    assert.deepEqual(result.reviewCounts, {});
    assert.deepEqual(result.pendingCounts, {});
  }
});

test('JSON allowlists diagnostic fields and projection fields; workbook ignores diagnostics entirely', async () => {
  const projected = report({ history: [] });
  const contaminated = { ...projected, rawHistory: 'PRIVATE_HISTORY', addresses: 'PRIVATE_ADDRESS',
    diagnostics: { ...projected.diagnostics, excluded: { private: ['PRIVATE_EXCLUDED'] },
      review: { missing_membership_evidence: projected.diagnostics.review.missing_membership_evidence.map(m => ({
        ...m, cells: ['PRIVATE_CELLS'], history: ['PRIVATE_HISTORY'], metadata: 'PRIVATE_PAYMENT',
        address: 'PRIVATE_ADDRESS', mobile: 'PRIVATE_PHONE',
      })) } } };
  const deps = { db: {}, getTenantContext: async () => ctx, hasAdminAccess: async () => true,
    hasFeatureAccess: async () => true, loadReport: async () => contaminated };
  const res = response();
  await createNmcReportHandler(deps)({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(res.body.diagnostics, projected.diagnostics);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|"rows"|"cells"/);
  assert.deepEqual(Object.keys(res.body).sort(), ['reportDate', 'settings', 'classOptions', 'classCounts',
    'sheets', 'total', 'reviewCounts', 'excludedCounts', 'pendingCounts', 'diagnostics'].sort());
  const original = XLSX.read(nmcMembershipWorkbook(projected), { type: 'buffer' });
  const withDiagnostics = XLSX.read(nmcMembershipWorkbook(contaminated), { type: 'buffer' });
  assert.deepEqual(withDiagnostics, original);
  for (const sheet of Object.values(withDiagnostics.Sheets)) assert.doesNotMatch(JSON.stringify(sheet), /PRIVATE_|fixture@example/);
});

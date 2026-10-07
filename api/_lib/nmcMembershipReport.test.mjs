import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { NMC_TENANT as tenant_id, NMC_FIELDS, NMC_HEADERS, NMC_SHEETS, projectNmcReport, nmcSheet, completedMonths } from './nmcMembershipReport.js';
import { nmcMembershipWorkbook } from './nmcMembershipWorkbook.js';
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
    organizations: [{ id: 'o1', tenant_id, name: 'Fixture Organisation' }],
    preferences: [pref('member_class', 'Full with NMC'), pref('nmc_address_zip', '00120')], ...overrides };
}
const report = overrides => projectNmcReport(fixture(overrides));
test('all valid class mappings; non-NMC precedence never inferred from category or roles', () => {
  const allowed = new Set(options);
  for (const c of classes) assert.equal(nmcSheet(c, allowed), NMC_SHEETS[3]);
  for (const c of classes.slice(0, 4)) assert.equal(nmcSheet(`${c} with NMC`, allowed), NMC_SHEETS[0]);
  for (const c of classes.slice(4, 8)) assert.equal(nmcSheet(`${c} with NMC`, allowed), NMC_SHEETS[1]);
  for (const c of classes.slice(8, 12)) assert.equal(nmcSheet(`${c} with NMC`, allowed), NMC_SHEETS[2]);
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
  assert.equal(report({ organizations: [] }).reviewCounts.unresolved_organisation, 1);
  assert.throws(() => report({ fields: [] }));
  assert.throws(() => report({ members: [member, member] }));
  assert.throws(() => report({ members: [{ ...member, tenant_id: 'foreign' }] }));
});
test('four-sheet workbook always retains exact headers and literal text, never formula cells', () => {
  const result = report({ members: [{ ...member, first_name: '=1+1', last_name: '@unsafe' }],
    preferences: [pref('member_class', 'Full with NMC'), pref('nmc_address_zip', '00120'), pref('nmc_address_line_1', ' \\t=HYPERLINK(\"bad\")')] });
  const wb = XLSX.read(nmcMembershipWorkbook(result), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, NMC_SHEETS);
  for (const name of NMC_SHEETS) {
    assert.ok(name.length <= 31);
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    assert.deepEqual(grid[0], NMC_HEADERS);
  }
  const sheet = wb.Sheets[NMC_SHEETS[0]];
  for (const cell of ['B2', 'C2', 'E2', 'I2', 'L2']) {
    assert.equal(sheet[cell].t, 's'); assert.equal(sheet[cell].f, undefined);
  }
  assert.equal(sheet.I2.v, '00120'); assert.equal(sheet.L2.v, '+440012300');
  assert.equal(sheet.F2.v, ''); assert.equal(sheet.N2.v, 0);
  const empty = XLSX.read(nmcMembershipWorkbook(report({ members: [] })), { type: 'buffer' });
  for (const name of empty.SheetNames) assert.equal(empty.Sheets[name]['!ref'], 'A1:N1');
});

function fakeDatabase(tables, { cap = 317, failTable, calls = [] } = {}) {
  return { from(table) {
    const filters = []; let key = 'id', limit = 500;
    const q = {
      select(_, options) { assert.equal(options.count, 'exact'); return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, values) { filters.push(r => values.includes(r[k])); return q; },
      gt(k, v) { filters.push(r => r[k] > v); return q; },
      order(k) { key = k; return q; }, limit(n) { limit = n; return q; },
      then(resolve, reject) {
        calls.push(table);
        const all = (tables[table] || []).filter(r => filters.every(f => f(r))).sort((a, b) => a[key].localeCompare(b[key]));
        return Promise.resolve(table === failTable ? { data: null, error: { message: 'private error' } }
          : { data: all.slice(0, Math.min(cap, limit)), error: null, count: all.length }).then(resolve, reject);
      },
    }; return q;
  } };
}
test('full loader/export passes 1000-row limit and smaller provider caps, with unique rows and scoped preferences', async () => {
  const members = Array.from({ length: 1207 }, (_, i) => ({ ...member, id: `m${String(i).padStart(5, '0')}` }));
  const db = fakeDatabase({
    member: [...members, { ...member, id: 'foreign', tenant_id: 'foreign' }], preference_field: fields,
    member_membership_history: members.map(m => ({ ...term, id: `h-${m.id}`, member_id: m.id })),
    organization: fixture().organizations,
    member_preference_value: members.flatMap(m => [pref('member_class', 'Full', m.id), pref('nmc_address_zip', '00001', m.id)]),
  });
  const result = await loadNmcReport(db, '2026-10-07');
  assert.equal(result.total, 1207); assert.equal(new Set(result.rows.map(r => r.memberId)).size, 1207);
  const wb = XLSX.read(nmcMembershipWorkbook(result), { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Online-only']).length, 1207);
  await assert.rejects(loadNmcReport(fakeDatabase({}, { failTable: 'member' }), '2026-10-07'));
  await assert.rejects(nmcReadAll(() => ({ order() { return this; }, limit() { return Promise.resolve({ data: [], count: 1 }); } })));
});

function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; },
    json(v) { this.body = v; return this; }, send(v) { this.body = v; return this; } };
}
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

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Only pure production modules are copied. All database/provider/email effects
// terminate in this in-memory harness; run through run-isolated-tests.mjs.
const state = { tables: {}, writes: [], invoices: [], duplicate: false, mismatch: false, previewOnly: false, authorized: true };
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-08-15T12:00:00Z'])); }
  static now() { return new RealDate('2026-08-15T12:00:00Z').getTime(); }
}
let root, handler, resolveEligibility;
function database() {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table) {
      const filters = [];
      let operation = 'select', payload;
      const query = {
        select() { return this; }, order() { return this; }, limit() { return this; },
        or() { return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        insert(value) { operation = 'insert'; payload = value; return this; },
        update(value) { operation = 'update'; payload = value; return this; },
        delete() { operation = 'delete'; return this; },
        run(single = false) {
          const rows = state.tables[table] ||= [];
          let matches = rows.filter(row => filters.every(fn => fn(row)));
          if (operation !== 'select') {
            state.writes.push({ table, operation, payload });
            if (operation === 'insert') {
              if (table === 'organisation_membership_history' && state.duplicate) {
                return { data: null, error: { code: '23505' } };
              }
              const row = { id: `new-${rows.length}`, ...payload };
              rows.push(row); matches = [row];
            } else if (operation === 'update') matches.forEach(row => Object.assign(row, payload));
            else state.tables[table] = rows.filter(row => !matches.includes(row));
          }
          return { data: single ? matches[0] || null : matches, error: null };
        },
        single() { return Promise.resolve(this.run(true)); },
        maybeSingle() { return Promise.resolve(this.run(true)); },
        then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); },
      };
      return query;
    },
  };
}
before(async () => {
  globalThis.Date = FixedDate;
  globalThis.__task4858 = { state, db: database() };
  root = await mkdtemp(path.join(os.tmpdir(), 'invoice-4858-'));
  const lib = path.join(root, 'api/_lib');
  await mkdir(lib, { recursive: true });
  await mkdir(path.join(root, 'api/membership'));
  await mkdir(path.join(root, 'shared'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  for (const file of [
    'membershipSimulationCore.js', 'membershipConfigResolverCore.js',
    'discountHelperCore.js', 'vatOverrideHelperCore.js', 'selectionMatcher.js',
    'invoiceAddressResolver.js', 'tierBandMatcher.js', 'membershipYear.js',
    'annualRenewalPolicy.js', 'membershipIncentiveSnapshot.js',
  ]) await cp(new URL(`../_lib/${file}`, import.meta.url), path.join(lib, file));
  await cp(new URL('../../shared/rollingMembershipTerm.js', import.meta.url), path.join(root, 'shared/rollingMembershipTerm.js'));
  await cp(new URL('./org-membership-invoicing.js', import.meta.url), path.join(root, 'api/membership/handler.js'));
  const stubs = {
    'database.js': 'export const supabase = globalThis.__task4858.db;',
    'tenantContext.js': `export const getTenantContext = async () => globalThis.__task4858.state.authorized ? {tenantId:"tenant"} : null;
      export const hasAdminAccess = async () => globalThis.__task4858.state.admin;`,
    'membershipSimulation.js': `import {createMembershipSimulator} from './membershipSimulationCore.js';
      import {supabase} from './database.js';
      export async function simulateMembershipForOrg(...args) {
        globalThis.__task4858.state.simulationOptions = args[2];
        const result = await createMembershipSimulator(supabase).simulateMembershipForOrg(...args);
        if (globalThis.__task4858.state.mismatch && result.success) result.membershipYear.label = '2027/2028';
        if (globalThis.__task4858.state.previewOnly && result.success) result.previewOnly = true;
        return result;
      }`,
    'membershipConfigResolver.js': `import {createMembershipConfigResolver} from './membershipConfigResolverCore.js';
      import {supabase} from './database.js';
      export const getConfigForOrganisation = (...args) => createMembershipConfigResolver(supabase).getConfigForOrganisation(...args);`,
    'upfrontRollingRenewal.js': 'export const upfrontRollingCommitment = () => ({});',
    'accountingProvider.js': `export const getAccountingProvider = async () => ({name:'xero', createMembershipInvoice: async data => {
      globalThis.__task4858.state.invoices.push(data); return {invoice_id:'invoice', invoice_number:'TEST'}; }});
      export const buildInvoiceColumnUpdate = () => ({xero_invoice_id:'invoice'});`,
    'membershipInvoiceEmail.js': 'export const sendMembershipInvoiceEmail = async () => {};',
    'membershipNominalCode.js': 'export const resolveMembershipNominalCode = async () => "200";',
    'membershipAddons.js': `export const loadAddonLines = async () => [];
      export const computeAddonTotals = () => ({totalWithVat:0});
      export const buildExtraLineItems = () => [];
      export const processTrainingFundAddons = async () => {};
      export const getMembershipAddonSettings = async () => ({});
      export const validateAddonLines = () => ({valid:true, lines:[]});`,
    'zeroDueMembership.js': `export const isZeroDueExistingMembership = () => false;
      export const isZeroDueMembership = () => false;
      export const zeroDuePaymentFields = () => ({});
      export const fireNewZeroDueMembershipPaidWorkflow = async () => {};`,
  };
  for (const [file, content] of Object.entries(stubs)) await writeFile(path.join(lib, file), content);
  ({ default: handler } = await import(pathToFileURL(path.join(root, 'api/membership/handler.js'))));
  ({ resolveEntityAnnualRenewalEligibility: resolveEligibility } = await import(pathToFileURL(path.join(lib, 'annualRenewalPolicy.js'))));
});
after(async () => {
  globalThis.Date = RealDate;
  delete globalThis.__task4858;
  if (root) await rm(root, { recursive: true, force: true });
});
function reset() {
  Object.assign(state, { writes: [], invoices: [], duplicate: false, mismatch: false, previewOnly: false, authorized: true, admin: true });
  state.tables = {
    organization: [{ id: 'org', tenant_id: 'tenant', name: 'Isolated organisation' }],
    membership_tier_config: [{
      id: 'config', tenant_id: 'tenant', name: 'Annual', structure_scope_type: 'organization',
      effective_from: '2020-01-01', start_mode: 'fixed', billing_period: 'annual',
      membership_start_month: 8, membership_start_day: 1,
      pricing_model: 'flat', flat_cost: 1000, currency: 'GBP',
      prorata_enabled: false, rollover_enabled: false,
      renewal_open_days: 30, renewal_grace_days: 7,
    }],
    preference_field: [{ id: 'go-live', tenant_id: 'tenant', entity_scope: 'organization', is_active: true, name: 'go_live', label: 'Go live' }],
    organization_preference_value: [{ organization_id: 'org', field_id: 'go-live', value: '2026-08-01' }],
  };
}
async function request(advance, extra = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', headers: {}, body: {
    organizationId: 'org', membershipYear: '2026/2027', advance, ...extra,
  } }, res);
  return res;
}
const history = extra => ({
  id: 'prior', tenant_id: 'tenant', organization_id: 'org', config_id: 'config',
  membership_year: '2025/2026', year_number: 6, billing_period: 'annual',
  payment_status: 'unpaid', created_at: '2025-08-01T00:00:00Z', ...extra,
});
for (const advance of [false, true]) {
  const mode = advance ? 'advance' : 'manual';
  test(`${mode}: prospective simulation cannot be recorded or invoiced`, async () => {
    reset(); state.previewOnly = true;
    const res = await request(advance);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'prospective_membership_preview_only');
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: genuine initial history-free invoice uses real price and dates`, async () => {
    reset();
    const res = await request(advance);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.record.final_cost, 1000);
    assert.equal(res.body.record.annual_cost, 1000);
    assert.equal(res.body.record.year_number, 1);
    assert.equal(res.body.record.membership_year, '2026/2027');
    assert.equal(res.body.record.term_start_date, '2026-08-01');
    assert.equal(res.body.record.term_end_date, '2027-07-31');
    assert.equal(state.invoices.length, 1);
    assert.equal(state.invoices[0].finalCost, 1000);
  });
  test(`${mode}: requested/simulated year disagreement has no effects`, async () => {
    reset(); state.mismatch = true;
    const res = await request(advance);
    assert.equal(res.body.code, 'membership_year_mismatch');
    assert.equal(res.statusCode, 400);
    assert.deepEqual(state.writes, []); assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: eligible successor dates must agree with the priced window`, async () => {
    reset();
    state.tables.organization_preference_value[0].value = '2021-07-16';
    state.tables.membership_tier_config[0].renewal_grace_days = 30;
    state.tables.organisation_membership_history = [history({})];
    const res = await request(advance, { membershipYear: '2027/2028' });
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'membership_year_mismatch');
    assert.deepEqual(state.writes, []); assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: established organisation admin invoice remains available after zero grace`, async () => {
    reset();
    state.tables.organization_preference_value[0].value = '2021-07-16';
    state.tables.membership_tier_config[0].renewal_grace_days = 0;
    state.tables.organisation_membership_history = [history({})];
    const res = await request(advance);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.record.final_cost, 1000);
    assert.equal(res.body.record.term_start_date, '2026-08-01');
    assert.equal(res.body.record.term_end_date, '2027-07-31');
    assert.equal(state.tables.organisation_membership_history[0].payment_status, 'unpaid');
    assert.equal(state.invoices.length, 1);
  });
  test(`${mode}: organisation admin may invoice the contiguous term before renewal opens`, async () => {
    reset();
    state.tables.organization_preference_value[0].value = '2021-07-16';
    state.tables.organisation_membership_history = [history({ membership_year: '2026/2027' })];
    const res = await request(advance, { membershipYear: '2027/2028' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.record.term_start_date, '2027-08-01');
    assert.equal(res.body.record.term_end_date, '2028-07-31');
    assert.equal(res.body.record.status, 'scheduled');
    assert.equal(res.body.record.scheduled_activation_date, '2027-08-01');
    assert.equal(state.invoices.length, 1);
  });
  for (const provider of ['stripe', 'gocardless']) test(`${mode}: ${provider} reservation blocks initial invoice`, async () => {
    reset();
    state.tables.membership_billing_agreements = [{ id: 'agreement', tenant_id: 'tenant', organization_id: 'org', provider, status: 'payment_setup_required' }];
    const res = await request(advance);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'recurring_membership_managed_separately');
    assert.deepEqual(state.writes, []); assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: existing target blocks a second invoice`, async () => {
    reset(); state.tables.organisation_membership_history = [history({ membership_year: '2026/2027' })];
    const res = await request(advance);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /already exists/);
    assert.deepEqual(state.writes, []); assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: approval required before writes`, async () => {
    reset(); state.tables.system_settings = [{ tenant_id: 'tenant', setting_key: 'membership_require_approval', setting_value: 'true' }];
    const res = await request(advance);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /approved/);
    assert.deepEqual(state.writes, []); assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: tenant boundary rejects another tenant's organisation`, async () => {
    reset(); state.tables.organization[0].tenant_id = 'other-tenant';
    const res = await request(advance);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(state.writes, []); assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: ordinary members cannot use admin invoicing`, async () => {
    reset(); state.admin = false;
    const res = await request(advance);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(state.writes, []); assert.deepEqual(state.invoices, []);
  });
  test(`${mode}: duplicate insert race never reaches provider`, async () => {
    reset(); state.duplicate = true;
    const res = await request(advance);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /duplicate prevented/);
    assert.deepEqual(state.invoices, []);
  });
}

test('advance ignores arbitrary client asOfDate in favour of the server clock', async () => {
  reset();
  const res = await request(true, { asOfDate: '2040-01-01' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(state.simulationOptions.asOfDate, undefined);
  assert.equal(res.body.record.term_start_date, '2026-08-01');
});

test('advance derives next-year pricing without a client clock', async () => {
  reset();
  state.tables.organization_preference_value[0].value = '2027-08-01';
  const res = await request(true, { membershipYear: '2027/2028', asOfDate: '2040-01-01' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(state.simulationOptions.asOfDate, undefined);
  assert.equal(res.body.record.term_start_date, '2027-08-01');
  assert.equal(res.body.record.term_end_date, '2028-07-31');
});

test('individual shared eligibility still blocks expired zero-grace renewal', async () => {
  reset();
  state.tables.membership_tier_config[0].renewal_grace_days = 0;
  state.tables.member_membership_history = [history({ member_id: 'member' })];
  const result = await resolveEligibility(globalThis.__task4858.db, {
    tenantId: 'tenant', memberId: 'member',
    config: state.tables.membership_tier_config[0],
    membershipYear: { label: '2026/2027', start: '2026-08-01', end: '2027-07-31' },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.code, 'annual_renewal_grace_expired');
  assert.equal(result.lifecycle.renewalGraceEndDate, '2026-07-31');
});
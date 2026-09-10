import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';

const CONFIG_ID = '696d519c-31af-43b9-983f-fa68a31ffa16';
const TENANT_ID = 'tenant-4358';
const ORG_ID = 'org-4358';
const GOVERNANCE_FIELD_ID = 'governance-region';
const GO_LIVE_FIELD_ID = 'go-live';
const STANDARD_VAT = JSON.stringify({ taxType: 'OUTPUT2', name: '20% (VAT on Income)' });
const ZERO_VAT = JSON.stringify({ taxType: 'ZERORATEDOUTPUT', name: 'Zero Rated Income' });
const VAT_RATES = JSON.stringify({
  rates: [
    { taxType: 'OUTPUT2', effectiveRate: 20 },
    { taxType: 'ZERORATEDOUTPUT', effectiveRate: 0 },
  ],
});

const RealDate = Date;
const frozenNow = new RealDate('2026-01-15T12:00:00.000Z');
class FrozenDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [frozenNow.getTime()]));
  }
  static now() {
    return frozenNow.getTime();
  }
}
globalThis.Date = FrozenDate;

function baseConfig(overrides = {}) {
  return {
    id: CONFIG_ID,
    tenant_id: TENANT_ID,
    name: '01/08/2026 - 31/07/2027',
    structure_scope_type: 'organization',
    structure_field_id: null,
    structure_match_value: null,
    effective_from: '2026-01-01',
    effective_to: '2027-07-31',
    start_mode: 'fixed',
    membership_start_month: 8,
    membership_start_day: 1,
    pricing_model: 'tiered',
    field_source: 'core',
    field_name: 'member_count',
    currency: 'GBP',
    prorata_enabled: false,
    free_period_amount: null,
    free_period_unit: null,
    rollover_enabled: false,
    invoice_description: 'Annual membership {year}',
    invoice_address_field_name: null,
    invoice_address_field_id: null,
    ...overrides,
  };
}

function makeTables({ governanceValue = '["Republic of Ireland"]', flat = false } = {}) {
  const config = baseConfig(flat
    ? { pricing_model: 'flat', flat_cost: 1000, flat_vat_rate: STANDARD_VAT }
    : {});
  return {
    organization: [{
      id: ORG_ID,
      tenant_id: TENANT_ID,
      name: 'Task 4358 Organisation',
      invoicing_address: '1 Test Street, Dublin',
      invoicing_email: 'accounts@example.test',
    }],
    organisation_membership_invoicing: [],
    membership_tier_config: [config],
    membership_tier_band: flat ? [] : [{
      id: 'band-standard',
      config_id: CONFIG_ID,
      tenant_id: TENANT_ID,
      label: 'Standard',
      min_value: 0,
      max_value: null,
      annual_cost: 1000,
      vat_rate: STANDARD_VAT,
      nominal_code: '200',
      display_order: 1,
    }],
    member: Array.from({ length: 10 }, (_, index) => ({
      id: `member-${index}`,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
    })),
    membership_tier_discount: [],
    membership_tier_vat_override: [{
      id: 'roi-zero-rate',
      config_id: CONFIG_ID,
      tenant_id: TENANT_ID,
      field_id: GOVERNANCE_FIELD_ID,
      field_label: 'Governance region',
      match_value: 'Republic of Ireland',
      match_condition: 'equals',
      vat_rate: ZERO_VAT,
      label: 'ROI zero-rated membership',
      sort_order: 1,
    }],
    organization_preference_value: [
      { organization_id: ORG_ID, field_id: GOVERNANCE_FIELD_ID, value: governanceValue },
      { organization_id: ORG_ID, field_id: GO_LIVE_FIELD_ID, value: '2026-08-01' },
    ],
    preference_field: [{
      id: GO_LIVE_FIELD_ID,
      tenant_id: TENANT_ID,
      entity_scope: 'organization',
      is_active: true,
      name: 'go_live',
      label: 'Go live',
    }],
    organisation_membership_history: [],
    organisation_membership_override: [],
    system_settings: [
      { tenant_id: TENANT_ID, setting_key: 'membership_nominal_ledger', setting_value: '200' },
      { tenant_id: TENANT_ID, setting_key: 'xero_invoice_status', setting_value: 'DRAFT' },
      { setting_key: `xero_vat_rates_${TENANT_ID}`, setting_value: VAT_RATES },
    ],
  };
}

function createSupabaseMock(state) {
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }
    select() { return this; }
    eq(column, value) {
      this.filters.push(row => row?.[column] === value);
      return this;
    }
    in(column, values) {
      this.filters.push(row => values.includes(row?.[column]));
      return this;
    }
    or() { return this; }
    order() { return this; }
    rows() {
      return (state.tables[this.table] || []).filter(row =>
        this.filters.every(filter => filter(row)));
    }
    maybeSingle() {
      return Promise.resolve({ data: this.rows()[0] || null, error: null });
    }
    then(resolve, reject) {
      return Promise.resolve({ data: this.rows(), error: null }).then(resolve, reject);
    }
  }
  return { from: table => new Query(table) };
}

const state = { tables: makeTables() };
globalThis.__membershipVatSimulationSupabase = createSupabaseMock(state);

let temporaryRoot;
let simulateMembershipForOrg;
let renewalHandler;

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'membership-vat-4358-'));
  const libRoot = path.join(temporaryRoot, 'api', '_lib');
  const membershipRoot = path.join(temporaryRoot, 'api', 'membership');
  await cp(new URL('./membershipSimulation.js', import.meta.url), path.join(libRoot, 'membershipSimulation.js'), { recursive: true });
  for (const file of [
    'discountHelper.js',
    'vatOverrideHelper.js',
    'membershipConfigResolver.js',
    'invoiceAddressResolver.js',
    'tierBandMatcher.js',
    'membershipYear.js',
  ]) {
    await cp(new URL(`./${file}`, import.meta.url), path.join(libRoot, file));
  }
  await writeFile(
    path.join(libRoot, 'database.js'),
    'export const supabase = globalThis.__membershipVatSimulationSupabase;\n',
  );
  await writeFile(
    path.join(libRoot, 'tenantContext.js'),
    `export async function getTenantContext() { return { tenantId: ${JSON.stringify(TENANT_ID)} }; }\n`,
  );
  await cp(
    new URL('../membership/simulate-renewal.js', import.meta.url),
    path.join(membershipRoot, 'simulate-renewal.js'),
  );

  ({ simulateMembershipForOrg } = await import(
    `${pathToFileURL(path.join(libRoot, 'membershipSimulation.js')).href}?task=4358`
  ));
  ({ default: renewalHandler } = await import(
    `${pathToFileURL(path.join(membershipRoot, 'simulate-renewal.js')).href}?task=4358`
  ));
});

after(async () => {
  globalThis.Date = RealDate;
  delete globalThis.__membershipVatSimulationSupabase;
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

async function simulate({ governanceValue, flat = false } = {}) {
  state.tables = makeTables({ governanceValue, flat });
  return simulateMembershipForOrg(TENANT_ID, ORG_ID, {
    source: 'simulate',
    mode: 'manual',
    targetYear: '2026/2027',
  });
}

function assertScheduleAndInvoice(result) {
  assert.equal(result.success, true);
  assert.equal(result.config.id, CONFIG_ID);
  assert.equal(result.membershipYear.label, '2026/2027');
  assert.equal(result.membershipYear.start.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(result.membershipYear.end.toISOString().slice(0, 10), '2027-07-31');
  assert.equal(result.yearNumber, 1);
  assert.equal(result.finalCost, 1000);
  assert.equal(result.invoicePreview.lineItems[0].unitAmount, '1000.00');
}

test('real simulation zero-rates a JSON-encoded ROI governance picklist', async () => {
  const result = await simulate({ governanceValue: '["Republic of Ireland"]' });
  assertScheduleAndInvoice(result);
  assert.equal(result.vatOverrideApplied, true);
  assert.equal(result.taxType, 'ZERORATEDOUTPUT');
  assert.equal(result.taxLabel, 'Zero Rated Income');
  assert.equal(result.vatRatePercent, 0);
  assert.equal(result.vatAmount, 0);
  assert.equal(result.totalWithVat, result.finalCost);
  assert.deepEqual(
    {
      taxType: result.invoicePreview.lineItems[0].taxType,
      taxLabel: result.invoicePreview.lineItems[0].taxLabel,
    },
    { taxType: 'ZERORATEDOUTPUT', taxLabel: 'Zero Rated Income' },
  );
  assert.match(
    result.steps.find(step => step.step === 'VAT Override')?.detail || '',
    /ROI zero-rated membership/,
  );
  assert.equal(
    result.steps.find(step => step.step === 'Invoice Preview - VAT / Tax Type')?.detail,
    'Zero Rated Income (ZERORATEDOUTPUT)',
  );
});

test('scalar ROI remains a zero-rated control', async () => {
  const result = await simulate({ governanceValue: 'Republic of Ireland' });
  assertScheduleAndInvoice(result);
  assert.equal(result.vatOverrideApplied, true);
  assert.equal(result.taxType, 'ZERORATEDOUTPUT');
  assert.equal(result.vatAmount, 0);
  assert.equal(result.totalWithVat, 1000);
});

test('unmatched region retains the tier band standard 20% VAT', async () => {
  const result = await simulate({ governanceValue: 'Northern Ireland' });
  assertScheduleAndInvoice(result);
  assert.equal(result.vatOverrideApplied, false);
  assert.equal(result.taxType, 'OUTPUT2');
  assert.equal(result.taxLabel, '20% (VAT on Income)');
  assert.equal(result.vatRatePercent, 20);
  assert.equal(result.vatAmount, 200);
  assert.equal(result.totalWithVat, 1200);
  assert.equal(result.invoicePreview.lineItems[0].taxType, 'OUTPUT2');
  assert.equal(result.invoicePreview.lineItems[0].taxLabel, '20% (VAT on Income)');
});

test('unmatched region retains flat-pricing VAT fallback', async () => {
  const result = await simulate({ governanceValue: 'Northern Ireland', flat: true });
  assertScheduleAndInvoice(result);
  assert.equal(result.tierLabel, 'Flat Rate');
  assert.equal(result.vatOverrideApplied, false);
  assert.equal(result.taxType, 'OUTPUT2');
  assert.equal(result.vatRatePercent, 20);
  assert.equal(result.vatAmount, 200);
  assert.equal(result.totalWithVat, 1200);
  assert.match(
    result.steps.find(step => step.step === 'Flat Rate VAT')?.detail || '',
    /20% \(VAT on Income\).*OUTPUT2/,
  );
});

test('simulate-renewal handler exposes the real simulation invoice preview', async () => {
  state.tables = makeTables({ governanceValue: '["Republic of Ireland"]' });
  const req = {
    method: 'POST',
    body: {
      organizationId: ORG_ID,
      mode: 'manual',
      targetYear: '2026/2027',
    },
  };
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await renewalHandler(req, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.organization, 'Task 4358 Organisation');
  assert.equal(response.payload.membershipYear, '2026/2027');
  assert.equal(response.payload.finalCost, 1000);
  assert.deepEqual(
    {
      unitAmount: response.payload.invoicePreview.lineItems[0].unitAmount,
      taxType: response.payload.invoicePreview.lineItems[0].taxType,
      taxLabel: response.payload.invoicePreview.lineItems[0].taxLabel,
    },
    {
      unitAmount: '1000.00',
      taxType: 'ZERORATEDOUTPUT',
      taxLabel: 'Zero Rated Income',
    },
  );
  assert.ok(response.payload.steps.some(step =>
    step.step === 'Invoice Preview - VAT / Tax Type'
    && step.detail === 'Zero Rated Income (ZERORATEDOUTPUT)'));
});
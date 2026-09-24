import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOrganisationMembershipValueCatalog,
  runOrganisationMembershipValueWidget,
  validateOrganisationMembershipValueConfig,
} from './organisationMembershipValue.js';

const tenant = 'tenant-a';
const baseTables = {
  membership_tier_config: [
    { id: 'cfg-a', tenant_id: tenant, name: 'Corporate', currency: 'GBP', effective_from: '2025-04-01', effective_to: null },
    { id: 'cfg-b', tenant_id: tenant, name: 'Affiliate', currency: 'GBP', effective_from: '2025-09-01', effective_to: null },
    { id: 'cfg-foreign', tenant_id: 'tenant-b', name: 'Foreign', currency: 'USD', effective_from: '2025-04-01' },
  ],
  membership_tier_band: [
    { id: 'band-a', tenant_id: tenant, config_id: 'cfg-a', label: 'Gold', annual_cost: '100' },
    { id: 'band-b', tenant_id: tenant, config_id: 'cfg-b', label: 'Silver', annual_cost: '50' },
    { id: 'band-foreign', tenant_id: 'tenant-b', config_id: 'cfg-foreign', label: 'Foreign', annual_cost: '1' },
  ],
  preference_field: [
    { id: 'field-type', tenant_id: tenant, name: 'org_type', label: 'Organisation type', field_type: 'dropdown', options: ['Charity', 'Company'], entity_scope: 'organization', is_active: true },
    { id: 'field-hidden', tenant_id: tenant, name: 'hidden', label: 'Hidden', field_type: 'text', entity_scope: 'organization', is_active: false },
    { id: 'field-foreign', tenant_id: 'tenant-b', name: 'org_type', label: 'Foreign', field_type: 'text', entity_scope: 'organization', is_active: true },
  ],
  organization: [
    { id: 'org-1', tenant_id: tenant },
    { id: 'org-2', tenant_id: tenant },
    { id: 'org-x', tenant_id: 'tenant-b' },
  ],
  organization_preference_value: [],
  organisation_membership_history: [],
};

function record(id, overrides = {}) {
  return {
    id,
    tenant_id: tenant,
    organization_id: 'org-1',
    status: 'active',
    payment_status: 'unpaid',
    config_id: 'cfg-a',
    band_id: 'band-a',
    final_cost: '100.00',
    currency: 'GBP',
    commitment_snapshot: null,
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    source: 'organisation_membership',
    measure: { aggregator: 'sum' },
    filters: [],
    membershipValue: { startMonth: 4, startYear: 2025, ...overrides },
  };
}

function mockClient(tableOverrides = {}, { cap = Infinity, errors = {} } = {}) {
  const tables = Object.fromEntries(Object.entries({ ...baseTables, ...tableOverrides })
    .map(([name, rows]) => [name, rows.map(row => structuredClone(row))]));
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, filters: [], from: 0, to: Infinity, count: false };
      calls.push(state);
      const builder = {
        select(_columns, options) { state.count = options?.count === 'exact'; return builder; },
        eq(field, value) { state.filters.push(['eq', field, value]); return builder; },
        is(field, value) { state.filters.push(['is', field, value]); return builder; },
        in(field, values) { state.filters.push(['in', field, values]); return builder; },
        order() { return builder; },
        range(from, to) { state.from = from; state.to = to; return builder; },
        then(resolve, reject) {
          if (errors[table]) return Promise.resolve({ data: null, error: new Error(errors[table]), count: null }).then(resolve, reject);
          let rows = [...(tables[table] || [])];
          for (const [op, field, value] of state.filters) {
            if (field === 'organization.tenant_id') {
              rows = rows.filter(row => tables.organization.some(org =>
                org.id === row.organization_id && (op === 'eq' ? org.tenant_id === value : org.tenant_id == null)));
            } else if (op === 'eq') rows = rows.filter(row => row[field] === value);
            else if (op === 'is') rows = rows.filter(row => row[field] == null);
            else if (op === 'in') rows = rows.filter(row => value.includes(row[field]));
          }
          rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
          const count = state.count ? rows.length : null;
          const requested = Math.max(0, state.to - state.from + 1);
          const data = rows.slice(state.from, state.from + Math.min(requested, cap));
          return Promise.resolve({ data, error: null, count }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

test('validates the narrow annual-value and custom-classification contract', () => {
  assert.deepEqual(validateOrganisationMembershipValueConfig(config({
    currency: 'gbp', configIds: ['cfg-a', 'cfg-a'], bandIds: ['band-a'],
  })), {
    startMonth: 4, startYear: 2025, currency: 'GBP',
    configIds: ['cfg-a'], bandIds: ['band-a'], filters: [],
  });
  assert.throws(() => validateOrganisationMembershipValueConfig(config({ startMonth: 13 })), /startMonth/);
  assert.throws(() => validateOrganisationMembershipValueConfig({
    ...config(), filters: [{ fieldKind: 'system', field: 'status', operator: 'eq', value: 'active' }],
  }), /custom field/);
  assert.throws(() => validateOrganisationMembershipValueConfig({
    ...config(), filters: [{ fieldKind: 'custom', fieldId: 'x', operator: 'gt', value: 1 }],
  }), /unsupported operator/);
});

test('counts durable unpaid and expired rows, but excludes checkout drafts and terminal reversals', async () => {
  const statuses = ['active', 'scheduled', 'expired', 'pending_payment_setup', 'draft', 'cancelled', 'void', 'superseded'];
  const rows = statuses.map((status, index) => record(`r-${index}`, {
    status, final_cost: '10', payment_status: index === 0 ? 'unpaid' : 'paid',
  }));
  const result = await runOrganisationMembershipValueWidget(
    config(), tenant, mockClient({ organisation_membership_history: rows }),
  );
  assert.equal(result.value, 30);
  assert.equal(result.total, 3);
  assert.equal(result.membershipValue.excludedRecords.lifecycle, 5);
  assert.equal(result.membershipValue.netOfVat, true);
});

test('uses snapshot structure evidence first and tenant-verified config fallback second', async () => {
  const rows = [
    record('snapshot', {
      config_id: 'missing',
      final_cost: '1.10',
      commitment_snapshot: { config: { id: 'cfg-b', effective_from: '2025-04-01', currency: 'GBP' } },
    }),
    record('fallback', { final_cost: '2.20' }),
    record('partial-same-id', {
      final_cost: '3.30',
      commitment_snapshot: { config: { id: 'cfg-a' } },
    }),
    record('partial-mismatched-id', {
      config_id: 'cfg-a',
      final_cost: '500',
      commitment_snapshot: { config: { id: 'cfg-b' } },
    }),
    record('foreign-fallback', { config_id: 'cfg-foreign', final_cost: '999' }),
  ];
  const result = await runOrganisationMembershipValueWidget(
    config(), tenant, mockClient({ organisation_membership_history: rows }),
  );
  assert.equal(result.value, 6.6);
  assert.equal(result.membershipValue.exactValue, '6.6');
  assert.deepEqual(new Set(result.membershipValue.warnings.map(w => w.code)), new Set([
    'missing_effective_from', 'missing_structure_evidence',
  ]));
});

test('allocates effective_from into a half-open configured annual period', async () => {
  const rows = [
    record('start', { final_cost: '1', commitment_snapshot: { config: { id: 'cfg-a', effective_from: '2025-04-01' } } }),
    record('last', { final_cost: '2', commitment_snapshot: { config: { id: 'cfg-a', effective_from: '2026-03-31' } } }),
    record('end', { final_cost: '4', commitment_snapshot: { config: { id: 'cfg-a', effective_from: '2026-04-01' } } }),
    record('before', { final_cost: '8', commitment_snapshot: { config: { id: 'cfg-a', effective_from: '2025-03-31' } } }),
  ];
  const result = await runOrganisationMembershipValueWidget(
    config(), tenant, mockClient({ organisation_membership_history: rows }),
  );
  assert.equal(result.value, 3);
  assert.deepEqual(result.membershipValue.period, {
    start: '2025-04-01', end: '2026-03-31',
    endExclusive: '2026-04-01', label: '2025-04-01 – 2026-03-31',
  });
  assert.equal(result.membershipValue.excludedRecords.period, 2);
});

test('sums persisted final_cost exactly as net VAT and exposes an exact decimal', async () => {
  const rows = [
    record('a', { final_cost: '0.1' }),
    record('b', { final_cost: '0.2' }),
    record('c', { final_cost: '1000000000000.0001' }),
  ];
  const result = await runOrganisationMembershipValueWidget(
    config(), tenant, mockClient({ organisation_membership_history: rows }),
  );
  assert.equal(result.membershipValue.exactValue, '1000000000000.3001');
  assert.equal(result.value, Number('1000000000000.3001'));
});

test('rejects mixed currencies unless an explicit currency is selected', async () => {
  const rows = [record('gbp'), record('usd', { currency: 'USD' })];
  await assert.rejects(
    runOrganisationMembershipValueWidget(config(), tenant, mockClient({ organisation_membership_history: rows })),
    /multiple currencies \(GBP, USD\)/,
  );
  const selected = await runOrganisationMembershipValueWidget(
    config({ currency: 'GBP' }), tenant, mockClient({ organisation_membership_history: rows }),
  );
  assert.equal(selected.value, 100);
  assert.equal(selected.membershipValue.currency, 'GBP');
});

test('warns rather than presenting missing eligible evidence as a confident zero', async () => {
  const rows = [
    record('missing-cost', { final_cost: null }),
    record('missing-date', { config_id: 'missing' }),
  ];
  const result = await runOrganisationMembershipValueWidget(
    config(), tenant, mockClient({ organisation_membership_history: rows }),
  );
  assert.equal(result.value, 0);
  assert.equal(result.total, 0);
  assert.equal(result.available, false);
  assert.deepEqual(new Set(result.membershipValue.warnings.map(w => w.code)), new Set([
    'missing_final_cost', 'missing_structure_evidence', 'incomplete_zero',
  ]));
});

test('classification reads tenant organisation preferences and never duplicates history value', async () => {
  const rows = [
    record('one', { organization_id: 'org-1', final_cost: '25' }),
    record('two', { organization_id: 'org-2', final_cost: '40' }),
  ];
  const prefs = [
    { id: 'p1', organization_id: 'org-1', field_id: 'field-type', value: 'Charity' },
    { id: 'p2', organization_id: 'org-1', field_id: 'field-type', value: 'Charity' },
    { id: 'p3', organization_id: 'org-2', field_id: 'field-type', value: 'Company' },
    { id: 'px', organization_id: 'org-x', field_id: 'field-type', value: 'Charity' },
  ];
  const filteredConfig = {
    ...config(),
    filters: [{ fieldKind: 'custom', fieldId: 'field-type', operator: 'in', value: ['Charity'] }],
  };
  const result = await runOrganisationMembershipValueWidget(
    filteredConfig, tenant,
    mockClient({ organisation_membership_history: rows, organization_preference_value: prefs }),
  );
  assert.equal(result.value, 25);
  assert.equal(result.total, 1);
  assert.equal(result.membershipValue.excludedRecords.classification, 1);
});

test('classification validates tenant field ownership even when no membership rows exist', async () => {
  const filteredConfig = {
    ...config(),
    filters: [{ fieldKind: 'custom', fieldId: 'field-foreign', operator: 'eq', value: 'Charity' }],
  };
  await assert.rejects(
    runOrganisationMembershipValueWidget(filteredConfig, tenant, mockClient()),
    /does not belong to this tenant/,
  );
});

test('classification chunks large organisation ID lists without bypassing total bounds', async () => {
  const organizations = [];
  const rows = [];
  const prefs = [];
  for (let index = 0; index < 205; index++) {
    const id = `org-${String(index).padStart(3, '0')}`;
    organizations.push({ id, tenant_id: tenant });
    rows.push(record(`record-${String(index).padStart(3, '0')}`, { organization_id: id, final_cost: '1' }));
    prefs.push({ id: `pref-${String(index).padStart(3, '0')}`, organization_id: id, field_id: 'field-type', value: 'Charity' });
  }
  const client = mockClient({
    organization: organizations,
    organisation_membership_history: rows,
    organization_preference_value: prefs,
  });
  const result = await runOrganisationMembershipValueWidget({
    ...config(),
    filters: [{ fieldKind: 'custom', fieldId: 'field-type', operator: 'eq', value: 'Charity' }],
  }, tenant, client);
  assert.equal(result.value, 205);
  const preferenceCalls = client.calls.filter(call => call.table === 'organization_preference_value');
  assert.equal(preferenceCalls.length, 2);
  assert.ok(preferenceCalls.every(call => {
    const orgFilter = call.filters.find(([op, field]) => op === 'in' && field === 'organization_id');
    return orgFilter && orgFilter[2].length <= 200;
  }));
});

test('unknown, quote, simulation and missing lifecycle states are disclosed and excluded', async () => {
  const rows = [
    record('active', { status: 'active', final_cost: '10' }),
    record('quote', { status: 'quote', final_cost: '100' }),
    record('simulation', { status: 'simulation', final_cost: '100' }),
    record('missing', { status: null, final_cost: '100' }),
    record('empty', { status: '', final_cost: '100' }),
  ];
  const result = await runOrganisationMembershipValueWidget(
    config(), tenant, mockClient({ organisation_membership_history: rows }),
  );
  assert.equal(result.value, 10);
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].value, 10);
  assert.equal(result.membershipValue.excludedRecords.unknownLifecycle, 4);
  assert.deepEqual(result.warnings.map(warning => warning.code), ['unknown_lifecycle_status']);
  assert.equal(result.warnings[0].count, 4);
});

test('continues pagination after provider-short pages by using exact count', async () => {
  const rows = Array.from({ length: 7 }, (_, index) => record(`r-${index}`, { final_cost: '1' }));
  const client = mockClient({ organisation_membership_history: rows }, { cap: 2 });
  const result = await runOrganisationMembershipValueWidget(config(), tenant, client);
  assert.equal(result.value, 7);
  assert.ok(client.calls.filter(call => call.table === 'organisation_membership_history').length >= 4);
});

test('complete retrieval failure throws and cannot degrade into a zero', async () => {
  await assert.rejects(
    runOrganisationMembershipValueWidget(config(), tenant, mockClient({}, {
      errors: { organisation_membership_history: 'provider unavailable' },
    })),
    /Could not completely retrieve organisation_membership_history/,
  );
});

test('catalog is tenant scoped and supplies structures, bands, currencies and active custom fields', async () => {
  const client = mockClient({
    organisation_membership_history: [record('r1'), record('r2', { currency: 'EUR' })],
  });
  const catalog = await getOrganisationMembershipValueCatalog(client, tenant);
  assert.equal(catalog.id, 'organisation_membership');
  assert.deepEqual(catalog.structures.map(option => option.value), ['cfg-b', 'cfg-a']);
  assert.deepEqual(catalog.bands.map(option => option.value).sort(), ['band-a', 'band-b']);
  assert.deepEqual(catalog.currencies.map(option => option.value), ['EUR', 'GBP']);
  assert.deepEqual(catalog.customFields.map(field => field.id), ['field-type']);
  assert.ok(client.calls.every(call =>
    call.table === 'organization_preference_value'
    || call.filters.some(([, field, value]) => field === 'tenant_id' && value === tenant)));
});
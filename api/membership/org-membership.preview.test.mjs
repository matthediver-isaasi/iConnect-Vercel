import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMembershipSimulator } from '../_lib/membershipSimulationCore.js';
import { createMembershipConfigResolver } from '../_lib/membershipConfigResolverCore.js';
import { calculateMembershipYearWindow, calculateNextMembershipYearWindow } from '../_lib/membershipYear.js';

// Evaluate the actual endpoint with every imported dependency substituted. No
// SDK, provider, credentials or write-capable database client is loaded.
const forbidden = () => { throw new Error('Unexpected side effect'); };
const config = {
  id: 'flat', name: 'Flat membership', tenant_id: 'tenant', pricing_model: 'flat',
  flat_cost: 1000, currency: 'GBP', billing_period: 'annual',
  membership_start_month: 1, membership_start_day: 1,
};
const windows = {
  current: { label: '2026', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-12-31T00:00:00Z') },
  next: { label: '2027', start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-12-31T00:00:00Z') },
};
const review = { success: false, code: 'new_member_incentive_review_required', error: 'Original incentive requires review' };
const thrownMessage = 'Could not calculate membership fees. Please try again or review the membership configuration.';
const success = year => ({
  success: true, membershipYear: { label: year }, config,
  yearNumber: year === '2026' ? 1 : 2, annualCost: 1000,
  annualCostBeforeDiscounts: 1000, finalCost: year === '2026' ? 800 : 900,
  freeDiscount: year === '2026' ? 200 : 0, rolloverDiscount: year === '2027' ? 100 : 0,
  vatRatePercent: 20, vatAmount: year === '2026' ? 160 : 180,
  totalWithVat: year === '2026' ? 960 : 1080,
});

function readOnlyDb({ org = { id: 'org', name: 'Organisation', tenant_id: 'tenant' }, history = [],
  failTable = null, historyError = false } = {}) {
  const rows = {
    organization: org ? [org] : [],
    membership_tier_band: [],
    organisation_membership_history: history,
    organisation_membership_override: [],
    preference_field: [],
  };
  const reads = [];
  return {
    reads,
    from(table) {
      reads.push(table);
      if (table === failTable) throw new Error(`Cannot read ${table}`);
      const filters = [];
      const query = {
        select() { return query; },
        eq(field, value) { filters.push(row => row[field] === value); return query; },
        order() { return query; },
        maybeSingle() { return Promise.resolve(result(true)); },
        then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
        insert: forbidden, update: forbidden, upsert: forbidden, delete: forbidden,
      };
      function result(single) {
        if (historyError && table === 'organisation_membership_history') {
          return { data: null, error: { message: 'History unavailable' } };
        }
        const found = (rows[table] || []).filter(row => filters.every(filter => filter(row)));
        return { data: single ? found[0] || null : found, error: null };
      }
      return query;
    },
  };
}

async function isolatedRoute({ db = readOnlyDb(), simulation = async (_tenant, _org, { targetYear }) => success(targetYear),
  tenantContext = { tenantId: 'tenant' }, resolveConfig = async () => config,
  currentWindow = () => windows.current, nextWindow = () => windows.next } = {}) {
  const source = await readFile(new URL('./org-membership.js', import.meta.url), 'utf8');
  const deps = {
    supabase: db, getTenantContext: async () => tenantContext,
    getConfigForOrganisation: resolveConfig, resolveBasisFieldLabel: async () => 'Membership',
    matchBand: () => null, calculateMembershipYearWindow: currentWindow,
    calculateNextMembershipYearWindow: nextWindow,
    simulateMembershipForOrg: simulation,
  };
  const body = source.replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"][^'"]+['"];?/g, (_, names) => {
    for (const name of names.split(',').map(part => part.trim()).filter(Boolean)) deps[name] ??= forbidden;
    return '';
  }).replace('export default async function handler', 'async function handler');
  return new Function(...Object.keys(deps), `${body}; return handler;`)(...Object.values(deps));
}

async function get(options = {}, organizationId = 'org') {
  const handler = await isolatedRoute(options);
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method: 'GET', query: { organizationId }, headers: {} }, res);
  return res;
}

function assertWarning(value, year, code, message) {
  assert.deepEqual(value, { membershipYear: year, code, message });
}

test('current preview remains usable when next year returns a review failure', async () => {
  const calls = [];
  const res = await get({ simulation: async (_tenant, _org, options) => {
    calls.push(options);
    return options.targetYear === '2027' ? review : success(options.targetYear);
  } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currentYearCost.finalCost, 800);
  assert.equal(res.body.currentYearCost.freeDiscount, 200);
  assert.equal(res.body.nextYearPreview, null);
  assert.equal(res.body.previewWarnings.currentYear, null);
  assertWarning(res.body.previewWarnings.nextYear, '2027', review.code, review.error);
  assert.deepEqual(calls.map(call => call.targetYear), ['2026', '2027']);
  assert.equal(calls[1].asOfDate, '2027-01-01');
  assert.equal(res.body.config.id, config.id);
});

test('thrown next-year simulator errors remain local to that preview', async () => {
  const res = await get({ simulation: async (_tenant, _org, { targetYear }) => {
    if (targetYear === '2027') throw Object.assign(new Error('Original record unavailable'), { code: 'new_member_incentive_review_required' });
    return success(targetYear);
  } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currentYearCost.finalCost, 800);
  assert.equal(res.body.nextYearPreview, null);
  assertWarning(res.body.previewWarnings.nextYear, '2027', 'new_member_incentive_review_required', thrownMessage);
});

test('current-year failure does not hide valid next-year quote', async () => {
  const res = await get({ simulation: async (_tenant, _org, { targetYear }) =>
    targetYear === '2026' ? review : success(targetYear) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currentYearCost, null);
  assertWarning(res.body.previewWarnings.currentYear, '2026', review.code, review.error);
  assert.equal(res.body.nextYearPreview.finalCost, 900);
  assert.equal(res.body.nextYearPreview.rolloverDiscount, 100);
  assert.equal(res.body.previewWarnings.nextYear, null);
});

test('a successful simulator result with the wrong year is not shown as a price for either year', async () => {
  const res = await get({ simulation: async (_tenant, _org, { targetYear }) =>
    targetYear === '2027' ? success('2026') : success('2027') });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currentYearCost, null);
  assert.equal(res.body.nextYearPreview, null);
  assertWarning(res.body.previewWarnings.currentYear, '2026', 'membership_year_mismatch',
    'The calculated membership year does not match this preview. Please review the membership schedule.');
  assertWarning(res.body.previewWarnings.nextYear, '2027', 'membership_year_mismatch',
    'The calculated membership year does not match this preview. Please review the membership schedule.');
});

test('ordinary thrown current-year simulator error is a local warning, not a 500', async () => {
  const res = await get({ simulation: async (_tenant, _org, { targetYear }) => {
    if (targetYear === '2026') throw new Error('Price is unavailable');
    return success(targetYear);
  } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currentYearCost, null);
  assert.equal(res.body.previewWarnings.currentYear.membershipYear, '2026');
  assertWarning(res.body.previewWarnings.currentYear, '2026', 'membership_preview_unavailable', thrownMessage);
  assert.equal(res.body.nextYearPreview.finalCost, 900);
});

test('both valid previews have no warnings', async () => {
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.previewWarnings, { currentYear: null, nextYear: null });
  assert.equal(res.body.currentYearCost.totalWithVat, 960);
  assert.equal(res.body.nextYearPreview.totalWithVat, 1080);
});

test('saved current-year history remains intact when next-year simulation fails', async () => {
  const record = {
    id: 'saved', tenant_id: 'tenant', organization_id: 'org', membership_year: '2026',
    annual_cost: 1200, final_cost: 700, total_with_vat: 840, vat_amount: 140,
    vat_rate_percent: 20, free_period_discount: 500, currency: 'GBP', status: 'active',
  };
  const calls = [];
  const res = await get({
    db: readOnlyDb({ history: [record] }),
    resolveConfig: async () => ({ ...config, flat_cost: null }),
    simulation: async (_tenant, _org, options) => { calls.push(options.targetYear); return review; },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['2027']);
  assert.equal(res.body.currentYearCost.recordedFromHistory, true);
  assert.equal(res.body.currentYearCost.finalCost, 700);
  assert.equal(res.body.currentYearCost.totalWithVat, 840);
  assert.deepEqual(res.body.history, [record]);
  assert.equal(res.body.previewWarnings.currentYear, null);
  assert.equal(res.body.nextYearPreview, null);
  assertWarning(res.body.previewWarnings.nextYear, '2027', review.code, review.error);
});

test('no tenant context is unauthorized and never queries the database', async () => {
  const db = { from: forbidden };
  const res = await get({ db, tenantContext: null });
  assert.equal(res.statusCode, 401);
});

test('tenant mismatch returns not found without simulating another tenant organisation', async () => {
  const db = readOnlyDb({ org: { id: 'org', tenant_id: 'other', name: 'Other tenant' } });
  const res = await get({ db, simulation: forbidden, resolveConfig: forbidden });
  assert.equal(res.statusCode, 404);
  assert.equal(db.reads.length, 1);
});

test('foundational organisation and history read failures remain server errors', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const table of ['organization', 'organisation_membership_history']) {
      const res = await get({ db: readOnlyDb({ failTable: table }), simulation: forbidden });
      assert.equal(res.statusCode, 500, `${table} read must not be converted into a preview warning`);
    }
    const res = await get({ db: readOnlyDb({ historyError: true }), simulation: forbidden });
    assert.equal(res.statusCode, 500, 'history query errors must not be treated as empty history');
  } finally {
    console.error = originalError;
  }
});

test('config resolution errors remain 500 rather than presenting no membership structure', async () => {
  let strictOptions;
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await get({
      simulation: forbidden,
      resolveConfig: async (_tenant, _org, _fields, _date, options) => {
        strictOptions = options;
        throw new Error('Structure read failed');
      },
    });
    assert.deepEqual(strictOptions, { strict: true });
    assert.equal(res.statusCode, 500);
  } finally {
    console.error = originalError;
  }
});

test('approving fees cannot persist approval when calculation fails or resolves a different year', async () => {
  const source = await readFile(new URL('./org-membership-invoicing.js', import.meta.url), 'utf8');
  for (const quote of [
    review,
    { ...success('2026'), membershipYear: { label: '2026' } },
    new Error('Calculator unavailable'),
  ]) {
    const deps = {
      supabase: { from: forbidden }, getTenantContext: async () => ({ tenantId: 'tenant' }),
      getConfigForOrganisation: async () => config,
      calculateNextMembershipYearWindow: () => windows.next,
      simulateMembershipForOrg: async () => {
        if (quote instanceof Error) throw quote;
        return quote;
      },
    };
    const body = source.replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"][^'"]+['"];?/g, (_, names) => {
      for (const name of names.split(',').map(part => part.trim()).filter(Boolean)) deps[name] ??= forbidden;
      return '';
    }).replace('export default async function handler', 'async function handler');
    const handler = new Function(...Object.keys(deps), `${body}; return handler;`)(...Object.values(deps));
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'PATCH', body: { organizationId: 'org', membershipYear: '2027', action: 'approve' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, quote === review ? review.code
      : quote instanceof Error ? 'membership_preview_unavailable' : 'membership_year_mismatch');
  }
});

test('future scheduled structure with a different start month keeps the next preview approvable', async () => {
  const oldConfig = {
    ...config, id: 'august', membership_start_month: 8, effective_from: '2023-01-01',
    created_at: '2023-01-01', updated_at: '2023-01-01',
  };
  const futureConfig = {
    ...oldConfig, id: 'october', membership_start_month: 10,
    effective_from: '2027-08-01', created_at: '2026-01-01', updated_at: '2026-01-01',
    flat_cost: 1200,
  };
  const today = new Date('2026-09-24T00:00:00Z');
  const tables = {
    organization: [{ id: 'org', tenant_id: 'tenant', name: 'Organisation' }],
    membership_tier_config: [futureConfig, oldConfig],
    organisation_membership_history: [],
    organisation_membership_invoicing: [],
    organisation_membership_override: [],
    membership_tier_discount: [],
    preference_field: [{ id: 'go-live', tenant_id: 'tenant', name: 'go_live', entity_scope: 'organization', is_active: true }],
    organization_preference_value: [{ organization_id: 'org', field_id: 'go-live', value: '2023-09-18' }],
  };
  const db = {
    rpc: async () => ({ error: null }),
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(field, value) { filters.push(row => row[field] === value); return query; },
        or(expression) {
          const date = expression.match(/effective_(?:from|to)\.(?:lte|gte)\.(\d{4}-\d{2}-\d{2})/)?.[1];
          if (date && expression.startsWith('effective_from')) filters.push(row => !row.effective_from || row.effective_from <= date);
          if (date && expression.startsWith('effective_to')) filters.push(row => !row.effective_to || row.effective_to >= date);
          return query;
        },
        order(field, { ascending = true } = {}) {
          query.sortBy = field;
          query.sortAscending = ascending;
          return query;
        },
        maybeSingle() { return Promise.resolve(result(true)); },
        then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
        insert(value) {
          assert.equal(table, 'organisation_membership_invoicing');
          tables[table].push(value);
          return Promise.resolve({ data: value, error: null });
        },
        update: forbidden, upsert: forbidden, delete: forbidden,
      };
      function result(single) {
        const found = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        if (query.sortBy) found.sort((a, b) => query.sortAscending
          ? String(a[query.sortBy] || '').localeCompare(String(b[query.sortBy] || ''))
          : String(b[query.sortBy] || '').localeCompare(String(a[query.sortBy] || '')));
        return { data: single ? found[0] || null : found, error: null };
      }
      return query;
    },
  };
  const resolver = createMembershipConfigResolver(db);
  const simulator = createMembershipSimulator(db, () => today);
  const currentWindow = base => calculateMembershipYearWindow(base, today);
  const nextWindow = base => calculateNextMembershipYearWindow(base, today);
  const nextYear = nextWindow(oldConfig);
  assert.equal(nextYear.label, '2027/2028');

  // The real calculator preserves its server-selected window even when the
  // future pricing configuration changes the schedule's start month.
  const withoutBoundary = await simulator.simulateMembershipForOrg('tenant', 'org', {
    source: 'tab', targetYear: nextYear.label,
  });
  assert.equal(withoutBoundary.membershipYear?.label, '2027/2028');
  assert.equal(withoutBoundary.membershipYear.start.toISOString().slice(0, 10), '2027-08-01');
  assert.equal(withoutBoundary.config.id, futureConfig.id);

  const previewResponse = await get({
    db, resolveConfig: resolver.getConfigForOrganisation,
    simulation: simulator.simulateMembershipForOrg,
    currentWindow, nextWindow,
  });
  assert.equal(previewResponse.statusCode, 200);
  assert.equal(previewResponse.body.nextYearPreview?.membershipYear, nextYear.label,
    JSON.stringify(previewResponse.body.previewWarnings));

  const source = await readFile(new URL('./org-membership-invoicing.js', import.meta.url), 'utf8');
  const deps = {
    supabase: db, getTenantContext: async () => ({ tenantId: 'tenant' }),
    getConfigForOrganisation: resolver.getConfigForOrganisation,
    calculateNextMembershipYearWindow: nextWindow,
    simulateMembershipForOrg: simulator.simulateMembershipForOrg,
  };
  const body = source.replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"][^'"]+['"];?/g, (_, names) => {
    for (const name of names.split(',').map(part => part.trim()).filter(Boolean)) deps[name] ??= forbidden;
    return '';
  }).replace('export default async function handler', 'async function handler');
  const handler = new Function(...Object.keys(deps), `${body}; return handler;`)(...Object.values(deps));
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'PATCH', body: {
    organizationId: 'org', membershipYear: nextYear.label, action: 'approve',
    asOfDate: '2099-01-01', // ignored: the boundary must come from the server schedule
  } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.fees_approved, true);
  assert.equal(tables.organisation_membership_invoicing[0].membership_year, nextYear.label);
});
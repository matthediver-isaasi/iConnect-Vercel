import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { opportunityConvertedProjections, loadOpportunityConvertedProjections } from './salesConvertedProjection.js';

const opportunity = { id: 'o', currency: 'GBP', value_minor: 90000 };
const quote = { id: 'q', opportunity_id: 'o', current_version: 2 };
const version = { id: 'v', quote_id: 'q', currency: 'GBP', net_minor: 10000, gross_minor: 12000 };
const sale = { id: 's', opportunity_id: 'o', quote_id: 'q', quote_version_id: 'v' };
const project = (quotes = [quote], versions = [version], sales = [sale]) =>
  opportunityConvertedProjections([opportunity], quotes, versions, sales).get('o');

test('production forecast migration pins reviewed functions and never updates historical rows', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/202702050001_opportunity_forecast_values.sql', import.meta.url), 'utf8');
  for (const checksum of ['db1d00c0a9b6c434a2741308044e85e3', '69c1648ada44853fbbc051012a0469cf',
    '2f6705d6cdd598c659a7dc7673a2d170', '8245bf1098aca1a9eb8c07b02d37a2de']) assert(sql.includes(checksum));
  assert.match(sql, /md5\(definition\) <> target\.before_md5/);
  assert.match(sql, /md5\(replacement\) <> target\.after_md5/);
  assert.match(sql, /md5\(definition\) = target\.after_md5 THEN CONTINUE/);
  assert.match(sql, /pg_get_functiondef\(function_id\)/);
  assert.doesNotMatch(sql, /\bUPDATE\s+(?:public\.)?opportunity\b|\bALTER\b.*\bOWNER\b|\bGRANT\b/i);
});

test('converted sums confirmed net versions, not forecasts, VAT or newer amendments', () => {
  const result = project([quote, { id: 'q2', opportunity_id: 'o' }, { id: 'draft', opportunity_id: 'o' }], [
    version, { ...version, id: 'amendment', net_minor: 999999 },
    { ...version, id: 'v2', quote_id: 'q2', net_minor: 5000 },
  ], [sale, sale, { ...sale, id: 's2', quote_id: 'q2', quote_version_id: 'v2' }]);
  assert.deepEqual(result, { convertedValueMinor: 15000, convertedValueSource: 'proposal', convertedProposalCount: 2 });
  assert.equal(opportunity.value_minor, 90000);
});

test('unconverted proposals never contribute; no conversions and confirmed zero are genuine zero', () => {
  assert.equal(project([quote], [version], []).convertedValueMinor, 0);
  assert.equal(project([], [], []).convertedValueMinor, 0);
  assert.equal(project([quote], [{ ...version, net_minor: 0 }]).convertedValueMinor, 0);
});

test('archived converted proposals and legacy sale linkage retain confirmed evidence', () => {
  assert.equal(project([{ ...quote, archived_at: '2026-01-01' }]).convertedValueMinor, 10000);
  assert.equal(project([quote], [version], [{ ...sale, opportunity_id: null }]).convertedValueMinor, 10000);
});

test('unavailable, mismatched, duplicate or overflowing evidence cannot become gross, partial or zero totals', () => {
  for (const versions of [[], [{ ...version, net_minor: null }], [{ ...version, currency: 'EUR' }],
    [{ ...version, quote_id: 'wrong' }], [{ ...version, net_minor: 0.5 }]]) {
    assert.equal(project([quote], versions).convertedValueMinor, null);
  }
  assert.equal(project([quote], [version], [sale, { ...sale, id: 'conflicting' }]).convertedValueMinor, null);
  assert.equal(project([quote], [{ ...version, net_minor: Number.MAX_SAFE_INTEGER },
    { ...version, id: 'v2', quote_id: 'q2' }], [sale,
    { ...sale, id: 's2', quote_id: 'q2', quote_version_id: 'v2' }]).convertedValueMinor, null);
});

test('persisted sale ownership wins over later quote re-parenting', () => {
  const result = opportunityConvertedProjections([opportunity, { id: 'other', currency: 'GBP' }],
    [{ ...quote, opportunity_id: 'other' }], [version], [sale]);
  assert.equal(result.get('o').convertedValueMinor, 10000);
  assert.equal(result.get('other').convertedValueMinor, 0);
});

test('loader scopes, batches and pages receipts, fetching only converted version IDs', async () => {
  const calls = [];
  const sales = Array.from({ length: 1001 }, (_, i) => ({
    ...sale, id: `s${i}`, quote_id: `q${i}`, quote_version_id: `v${i}`,
  }));
  const versions = sales.map(row => ({ ...version, id: row.quote_version_id, quote_id: row.quote_id, net_minor: 1 }));
  const db = { from(table) {
    const filters = {}; const call = { table, filters }; calls.push(call);
    const q = {
      select() { return q; }, eq(key, value) { filters[key] = value; return q; },
      in(key, values) { filters[key] = values; return q; }, order() { return q; },
      async range(from, to) {
        call.range = [from, to];
        assert.equal(filters.tenant_id, 'tenant');
        const all = table === 'sales_commercial_sale' ? sales : table === 'sales_quote_version' ? versions : [];
        const key = Object.keys(filters).find(key => key !== 'tenant_id');
        return { data: all.filter(row => filters[key].includes(row[key])).slice(from, to + 1), error: null };
      },
    }; return q;
  } };
  const result = await loadOpportunityConvertedProjections(db, 'tenant', [opportunity]);
  assert.equal(result.get('o').convertedValueMinor, 1001);
  assert(calls.some(call => call.table === 'sales_commercial_sale' && call.range[0] === 1000));
  assert(calls.filter(call => call.table === 'sales_quote_version').every(call =>
    call.filters.id.length <= 100 && call.filters.quote_id === undefined));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { opportunityNetProjections, loadOpportunityNetProjections, netPipelineGroups, netMinor } from './salesNetProjection.js';

test('manual, taxed, tax-free, zero and historically converted values use net evidence', () => {
  const opportunities = ['taxed', 'free', 'zero', 'manual', 'converted', 'missing'].map(id =>
    ({ id, currency: 'GBP', value_minor: 12000, stage: { probability: 33 } }));
  const quotes = ['taxed', 'free', 'zero', 'converted', 'missing'].map(id =>
    ({ id: `q-${id}`, opportunity_id: id, current_version: 2 }));
  const versions = ['taxed', 'free', 'zero', 'converted'].map(id =>
    ({ id: `v-${id}`, quote_id: `q-${id}`, version_number: 2, currency: 'GBP',
      net_minor: id === 'zero' ? 0 : 10000, tax_minor: id === 'free' ? 0 : 2000,
      gross_minor: id === 'free' ? 10000 : 12000 }));
  versions.push({ id: 'sale-version', quote_id: 'q-converted', version_number: 1,
    currency: 'GBP', net_minor: 8000, gross_minor: 9600 });
  const sales = [{ opportunity_id: 'converted', quote_id: 'q-converted', quote_version_id: 'sale-version' }];
  const projected = opportunityNetProjections(opportunities, quotes, versions, sales);
  for (const id of ['taxed', 'free']) assert.equal(projected.get(id).netValueMinor, 10000);
  assert.equal(projected.get('zero').netValueMinor, 0);
  assert.deepEqual(projected.get('manual'), { netValueMinor: 12000, netValueSource: 'manual' });
  assert.equal(projected.get('converted').netValueMinor, 8000, 'confirmed version, not later revision or stored gross');
  assert.equal(projected.get('missing').netValueMinor, null);
  const rows = opportunities.map(row => ({ ...row, ...projected.get(row.id) }));
  assert.deepEqual(netPipelineGroups(rows), [{ currency: 'GBP', count: 6, unavailableCount: 1, valueMinor: null, weightedValueMinor: null }]);
  assert.equal(netPipelineGroups(rows.slice(0, 5))[0].weightedValueMinor, 13200);
  assert.equal(opportunities[0].value_minor, 12000, 'read side never overwrites history');
});

test('ambiguous proposals, currency mismatch and missing sale evidence cannot fall back to gross', () => {
  const opportunity = { id: 'o', currency: 'GBP', value_minor: 12000 };
  const q = { id: 'q', opportunity_id: 'o', current_version: 1 };
  const version = { id: 'v', quote_id: 'q', version_number: 1, currency: 'GBP', net_minor: 10000 };
  for (const [quotes, versions, sales] of [
    [[q, { ...q, id: 'q2' }], [version], []],
    [[q], [{ ...version, currency: 'EUR' }], []],
    [[q], [version], [{ opportunity_id: 'o', quote_version_id: 'missing' }]],
    [[q], [{ ...version, net_minor: null }], []],
  ]) assert.equal(opportunityNetProjections([opportunity], quotes, versions, sales).get('o').netValueMinor, null);
  for (const bad of [null, undefined, '', false, {}, 'unknown', 0.5]) assert.equal(netMinor(bad), null);
  assert.equal(netMinor('0'), 0);
  const groups = netPipelineGroups([{ currency: 'GBP', netValueMinor: 10001, stage: { probability: 25 } },
    { currency: 'EUR', netValueMinor: 0, stage: { probability: 100 } }]);
  assert.equal(groups.find(row => row.currency === 'GBP').weightedValueMinor, 2500);
  assert.equal(groups.find(row => row.currency === 'EUR').valueMinor, 0);
});

test('net loader scopes evidence to tenant and pages before deciding authority; errors fail explicitly', async () => {
  const calls = [];
  const db = { from(table) {
    const call = { table }; calls.push(call);
    return {
      select() { return this; }, eq(key, value) { assert.equal(key, 'tenant_id'); assert.equal(value, 'tenant'); return this; },
      in(key, ids) { call.key = key; call.ids = ids; return this; }, order() { return this; },
      async range(from) {
        call.from = from;
        return { data: table === 'sales_quote' ? [{ id: 'q', opportunity_id: 'o', current_version: 1 }]
          : table === 'sales_quote_version' ? from === 0
            ? Array.from({ length: 1000 }, (_, i) => ({ id: `v${i}`, quote_id: 'q', version_number: i + 2 }))
            : [{ id: 'current', quote_id: 'q', version_number: 1, net_minor: 10000, currency: 'GBP' }]
            : [] };
      },
    };
  } };
  const result = await loadOpportunityNetProjections(db, 'tenant', [{ id: 'o', value_minor: 12000, currency: 'GBP' }]);
  assert.equal(result.get('o').netValueMinor, 10000);
  assert.deepEqual(calls.filter(row => row.table === 'sales_quote_version').map(row => row.from), [0, 1000]);
  await assert.rejects(loadOpportunityNetProjections({ from() { throw Error('unavailable'); } }, 'tenant', [{ id: 'o' }]), /unavailable/);
});

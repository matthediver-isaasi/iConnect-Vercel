import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpportunityBillingOrganization } from './salesOpportunityBilling.js';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';
import { readFile } from 'node:fs/promises';

function database({ missing = false, fail = false, empty = false } = {}) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, conditions: [] }; calls.push(call);
    const chain = {
      select(fields) { call.fields = fields; return chain; },
      eq(key, value) { call.conditions.push([key,value]); return chain; },
      async maybeSingle() {
        if (table === 'organization') return { data: missing ? null : { invoicing_address: 'Legacy\nExample City' } };
        return { data: empty ? null : {
          invoicing_address_line1: 'One street', invoicing_address_line2: 'Suite 2', invoicing_city: 'Example City',
          invoicing_region: 'Example Region', invoicing_postal_code: 'AB1 2CD', invoicing_country: 'United Kingdom',
          owner_id: 'private metadata must not leak',
        }, error: fail ? { code: 'PGRST205' } : null };
      },
    }; return chain;
  } };
}

test('authorised opportunity billing defaults read private fields with exact tenant/owner scope', async () => {
  const db = database();
  const result = await loadOpportunityBillingOrganization(db, 'tenant', 'organisation');
  assert.equal(result.invoicing_city, 'Example City');
  assert.equal(result.invoicing_postal_code, 'AB1 2CD');
  assert.equal(result.invoicing_address, 'Legacy\nExample City');
  assert.deepEqual(Object.keys(result).sort(), ['invoicing_address',...INVOICING_ADDRESS_KEYS].sort());
  assert.deepEqual(db.calls[1], {
    table: 'invoicing_address_private', fields: INVOICING_ADDRESS_KEYS.join(','),
    conditions: [['tenant_id','tenant'],['owner_type','organization'],['owner_id','organisation']],
  });
  assert.deepEqual(db.calls[0].conditions, [['tenant_id','tenant'],['id','organisation']]);
});

test('missing structured data preserves legacy; private lookup failures do not silently fall back', async () => {
  const result = await loadOpportunityBillingOrganization(database({ empty:true }), 'tenant', 'organisation');
  assert.equal(result.invoicing_address, 'Legacy\nExample City');
  assert.ok(INVOICING_ADDRESS_KEYS.every(key => result[key] === ''));
  await assert.rejects(loadOpportunityBillingOrganization(database({ fail:true }), 'tenant', 'organisation'), e => e.status === 503);
  const missing = database({ missing:true });
  await assert.rejects(loadOpportunityBillingOrganization(missing, 'tenant', 'organisation'), e => e.status === 404);
  assert.equal(missing.calls.length,1);
});

test('private billing defaults are loaded only in the already-authorised opportunity detail', async () => {
  const detail = await readFile(new URL('../opportunities/[id].js', import.meta.url),'utf8');
  const collection = await readFile(new URL('../opportunities/index.js', import.meta.url),'utf8');
  assert.match(detail, /async function fullDetail[\s\S]*loadOpportunityBillingOrganization\(db,/);
  assert.match(detail, /loadOpportunityAccess[\s\S]*fullDetail\(db,/);
  assert.doesNotMatch(collection, /loadOpportunityBillingOrganization|invoicing_address_private/);
});

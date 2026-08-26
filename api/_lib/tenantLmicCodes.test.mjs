import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTenantLmicCodes } from './tenantLmicCodes.js';

function queryResult(result) {
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    is() {
      return query;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return query;
}

test('strict LMIC loading rejects a country query failure instead of returning authoritative empty', async () => {
  const supabase = {
    from(table) {
      assert.equal(table, 'tenant_lmic_country');
      return queryResult({
        data: null,
        error: { message: 'database unavailable' },
      });
    },
  };

  await assert.rejects(
    loadTenantLmicCodes(supabase, 'tenant-1', { strict: true }),
    /Failed to load tenant LMIC codes/
  );
});

test('strict LMIC loading returns empty only when the seed marker confirms it', async () => {
  const supabase = {
    from(table) {
      if (table === 'tenant_lmic_country') {
        return queryResult({ data: [], error: null });
      }
      assert.equal(table, 'tenant_lmic_seed');
      return queryResult({
        data: { tenant_id: 'tenant-1' },
        error: null,
      });
    },
  };

  assert.deepEqual(
    await loadTenantLmicCodes(supabase, 'tenant-1', { strict: true }),
    []
  );
});

test('strict LMIC loading rejects a seed-marker query failure', async () => {
  const supabase = {
    from(table) {
      if (table === 'tenant_lmic_country') {
        return queryResult({ data: [], error: null });
      }
      assert.equal(table, 'tenant_lmic_seed');
      return queryResult({
        data: null,
        error: { message: 'seed marker unavailable' },
      });
    },
  };

  await assert.rejects(
    loadTenantLmicCodes(supabase, 'tenant-1', { strict: true }),
    /Failed to confirm tenant LMIC seed state/
  );
});
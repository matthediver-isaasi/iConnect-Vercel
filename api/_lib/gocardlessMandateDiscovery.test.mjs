import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMandateDiscovery, normalizeDiscoveryEmail } from './gocardlessMandateDiscovery.js';

const TENANT = 'tenant-a';

function fakeDb(members, batches = []) {
  const state = { batches: batches.map((row) => ({ ...row })), rows: [], touched: [] };
  return {
    state,
    from(table) {
      state.touched.push(table);
      if (table === 'member') {
        const q = {
          select() { return q; }, eq() { return q; }, order() { return q; },
          range: async (from, to) => ({ data: members.slice(from, to + 1), error: null }),
        };
        return q;
      }
      if (table === 'gocardless_mandate_discovery_row') {
        return {
          upsert: async (rows) => {
            for (const row of rows) {
              const i = state.rows.findIndex((x) => x.batch_id === row.batch_id && x.gocardless_mandate_id === row.gocardless_mandate_id);
              if (i >= 0) state.rows[i] = row; else state.rows.push(row);
            }
            return { error: null };
          },
        };
      }
      if (table === 'gocardless_mandate_discovery_batch') {
        const query = {
          value: null, filters: {},
          insert(value) { query.value = value; query.mode = 'insert'; return query; },
          update(value) { query.value = value; query.mode = 'update'; return query; },
          select() { return query; },
          eq(key, value) { query.filters[key] = value; return query; },
          lt(key, value) { query.filters[`lt:${key}`] = value; return query; },
          then(resolve) {
            if (query.mode === 'update') {
              const changed = state.batches.filter((row) => {
                if (query.filters.id && row.id !== query.filters.id) return false;
                if (query.filters.tenant_id && row.tenant_id !== query.filters.tenant_id) return false;
                if (query.filters.status && row.status !== query.filters.status) return false;
                if (query.filters['lt:updated_at'] && !(row.updated_at < query.filters['lt:updated_at'])) return false;
                return true;
              });
              changed.forEach((row) => Object.assign(row, query.value));
              return resolve({ data: changed, error: null });
            }
            return resolve({ data: null, error: null });
          },
          async single() {
            if (query.mode === 'insert') {
              const row = { id: `batch-${state.batches.length + 1}`, ...query.value };
              state.batches.push(row);
              return { data: row, error: null };
            }
            const row = state.batches.find((x) => !query.filters.id || x.id === query.filters.id);
            Object.assign(row, query.value);
            return { data: { ...row }, error: null };
          },
        };
        return query;
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function creds(tenantId) {
  return Promise.resolve({ source: 'tenant', tenantId, environment: 'sandbox', accessToken: 'sandbox_test' });
}

test('normalizes email exactly by trimming and lowercasing', () => {
  assert.equal(normalizeDiscoveryEmail('  Person@Example.COM '), 'person@example.com');
});

test('paginates every mandate and stages exact, ambiguous, and unmatched outcomes', async () => {
  const db = fakeDb([
    { id: 'member-1', email: 'unique@example.com' },
    { id: 'member-2', email: 'dupe@example.com' },
    { id: 'member-3', email: ' DUPE@example.com ' },
  ]);
  const cursors = [];
  const customers = {
    C1: { email: ' UNIQUE@EXAMPLE.COM ', given_name: 'One', family_name: 'Member' },
    C2: { email: 'dupe@example.com' },
    C3: { email: 'missing@example.com' },
  };
  const clientFactory = () => ({
    async listMandatesPage({ after }) {
      cursors.push(after);
      return after
        ? { mandates: [{ id: 'M3', status: 'active', links: { customer: 'C3' } }], after: null }
        : { mandates: [
          { id: 'M1', status: 'active', links: { customer: 'C1' } },
          { id: 'M2', status: 'pending_submission', links: { customer: 'C2' } },
        ], after: 'cursor-2' };
    },
    async getCustomer(id) { return customers[id]; },
  });
  const result = await runMandateDiscovery({ db, tenantId: TENANT, credentialsLoader: creds, clientFactory });
  assert.deepEqual(cursors, [null, 'cursor-2']);
  assert.equal(result.status, 'complete');
  assert.deepEqual(
    db.state.rows.map((r) => [r.gocardless_mandate_id, r.match_outcome, r.matched_member_id]),
    [['M1', 'matched', 'member-1'], ['M2', 'ambiguous', null], ['M3', 'unmatched', null]],
  );
  assert.deepEqual(
    [result.total_count, result.matched_count, result.unmatched_count, result.ambiguous_count, result.failed_count],
    [3, 1, 1, 1, 0],
  );
});

test('customer and provider failures are explicit and safe retries create auditable batches', async () => {
  const db = fakeDb([{ id: 'member-1', email: 'one@example.com' }]);
  let run = 0;
  const clientFactory = () => ({
    async listMandatesPage() {
      run += 1;
      if (run === 2) throw new Error('provider unavailable');
      return { mandates: [{ id: 'M1', status: 'active', links: { customer: 'C1' } }], after: null };
    },
    async getCustomer() { throw new Error('customer denied'); },
  });
  const first = await runMandateDiscovery({ db, tenantId: TENANT, credentialsLoader: creds, clientFactory });
  const second = await runMandateDiscovery({ db, tenantId: TENANT, credentialsLoader: creds, clientFactory });
  assert.equal(first.status, 'partial');
  assert.equal(first.failed_count, 1);
  assert.equal(second.status, 'failed');
  assert.match(second.error_message, /provider unavailable/);
  assert.equal(db.state.batches.length, 2);
  assert.equal(db.state.rows.length, 1);
});

test('rejects any credential loader that does not return this tenant account', async () => {
  const db = fakeDb([]);
  await assert.rejects(
    () => runMandateDiscovery({
      db, tenantId: TENANT,
      credentialsLoader: async () => ({ source: 'platform-env', tenantId: null, environment: 'sandbox' }),
    }),
    /Tenant-specific GoCardless credentials are required/,
  );
  assert.equal(db.state.batches.length, 0);
});

test('reclaims an abandoned running batch so a tenant can retry safely', async () => {
  const db = fakeDb([], [{
    id: 'abandoned', tenant_id: TENANT, environment: 'sandbox', status: 'running',
    updated_at: '2020-01-01T00:00:00.000Z',
  }]);
  const result = await runMandateDiscovery({
    db, tenantId: TENANT, credentialsLoader: creds,
    clientFactory: () => ({ listMandatesPage: async () => ({ mandates: [], after: null }) }),
  });
  assert.equal(db.state.batches[0].status, 'failed');
  assert.match(db.state.batches[0].error_message, /released for retry/);
  assert.equal(result.status, 'complete');
  assert.equal(db.state.batches.length, 2);
});

test('discovery only touches staging tables and tenant-scoped member reads', async () => {
  const db = fakeDb([]);
  await runMandateDiscovery({
    db, tenantId: TENANT, credentialsLoader: creds,
    clientFactory: () => ({
      listMandatesPage: async () => ({ mandates: [{ id: 'M1', status: 'active', links: { customer: 'C1' } }], after: null }),
      getCustomer: async () => ({ email: 'nobody@example.com' }),
    }),
  });
  const liveBillingTables = [
    'gocardless_customers', 'gocardless_mandates', 'membership_billing_agreements',
    'membership_payment_plans', 'subscriptions', 'member_membership_history',
  ];
  assert.equal(db.state.touched.some((table) => liveBillingTables.includes(table)), false);
  assert.deepEqual([...new Set(db.state.touched)].sort(), [
    'gocardless_mandate_discovery_batch', 'gocardless_mandate_discovery_row', 'member',
  ]);
});
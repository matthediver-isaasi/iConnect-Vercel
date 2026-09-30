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
        ? { mandates: [{ id: 'M3', status: 'active', links: { customer: 'C3' } }], after: null, cursorMetadataPresent: true }
        : { mandates: [
          { id: 'M1', status: 'active', links: { customer: 'C1' } },
          { id: 'M2', status: 'pending_submission', links: { customer: 'C2' } },
        ], after: 'cursor-2', cursorMetadataPresent: true };
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
      return { mandates: [{ id: 'M1', status: 'active', links: { customer: 'C1' } }], after: null, cursorMetadataPresent: true };
    },
    async getCustomer() { throw new Error('customer denied'); },
  });
  const first = await runMandateDiscovery({ db, tenantId: TENANT, credentialsLoader: creds, clientFactory });
  const second = await runMandateDiscovery({ db, tenantId: TENANT, credentialsLoader: creds, clientFactory });
  assert.equal(first.status, 'partial');
  assert.equal(first.failed_count, 1);
  assert.equal(second.status, 'failed');
  assert.match(second.error_message, /could not return mandate page 1.*Retry the sync/);
  assert.doesNotMatch(second.error_message, /provider unavailable/);
  assert.equal(first.error_message, 'Some customer records could not be retrieved');
  assert.equal(db.state.rows[0].error_message, 'The linked GoCardless customer could not be retrieved');
  assert.equal(db.state.batches.length, 2);
  assert.equal(db.state.rows.length, 1);
});

test('does not expose provider details, credentials, or untrusted request IDs in batch diagnostics', async (t) => {
  for (const requestId of ['REQ_safe-123', 'live_token-shaped-secret', 'arbitraryCredentialLikeText']) {
    await t.test(requestId, async () => {
      const db = fakeDb([]);
      const sensitive = 'customer person@example.com token other-secret-value live_abc123';
      const result = await runMandateDiscovery({
        db, tenantId: TENANT, credentialsLoader: creds,
        clientFactory: () => ({
          async listMandatesPage() {
            const error = new Error(sensitive);
            error.requestId = requestId;
            throw error;
          },
        }),
      });
      assert.equal(result.status, 'failed');
      assert.match(result.error_message, /mandate page 1/);
      assert.doesNotMatch(
        result.error_message,
        /person@example\.com|other-secret-value|live_abc123|REQ_safe-123|arbitraryCredentialLikeText/,
      );
    });
  }
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
    clientFactory: () => ({ listMandatesPage: async () => ({ mandates: [], after: null, cursorMetadataPresent: true }) }),
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
      listMandatesPage: async () => ({ mandates: [{ id: 'M1', status: 'active', links: { customer: 'C1' } }], after: null, cursorMetadataPresent: true }),
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

test('retrieves more than 350 mandates across every account-wide cursor despite creditor credentials', async () => {
  const db = fakeDb([]);
  const mandates = Array.from({ length: 375 }, (_, i) => ({
    id: `M${i + 1}`,
    status: 'active',
    links: { customer: `C${i + 1}` },
  }));
  const calls = [];
  const result = await runMandateDiscovery({
    db,
    tenantId: TENANT,
    credentialsLoader: async (tenantId) => ({
      source: 'tenant', tenantId, environment: 'live',
      accessToken: 'live_test', creditorId: 'CR-live-billing',
    }),
    clientFactory: () => ({
      async listMandatesPage(options) {
        calls.push(options);
        const start = options.after ? Number(options.after.slice(7)) : 0;
        const page = mandates.slice(start, start + 125);
        const next = start + page.length;
        return {
          mandates: page,
          after: next < mandates.length ? `cursor-${next}` : null,
          cursorMetadataPresent: true,
        };
      },
      async getCustomer(id) { return { email: `${id.toLowerCase()}@example.com` }; },
    }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.total_count, 375);
  assert.equal(db.state.rows.length, 375);
  assert.deepEqual(calls.map(({ after }) => after), [null, 'cursor-125', 'cursor-250']);
  assert.equal(calls.every(({ accountWide, limit }) => accountWide === true && limit === 500), true);
});

test('marks repeated, missing, and malformed cursor sequences incomplete with actionable diagnostics', async (t) => {
  const scenarios = [
    {
      name: 'repeated cursor',
      pages: [
        { mandates: [{ id: 'M1', links: { customer: 'C1' } }], after: 'same', cursorMetadataPresent: true },
        { mandates: [{ id: 'M2', links: { customer: 'C2' } }], after: 'same', cursorMetadataPresent: true },
      ],
      message: /repeated pagination cursor/,
    },
    {
      name: 'missing cursor metadata',
      pages: [{ mandates: [{ id: 'M1', links: { customer: 'C1' } }], after: null, cursorMetadataPresent: false }],
      message: /pagination was incomplete on page 1.*next cursor was missing/,
    },
    {
      name: 'malformed cursor',
      pages: [{ mandates: [{ id: 'M1', links: { customer: 'C1' } }], after: 42, cursorMetadataPresent: true }],
      message: /pagination was malformed on page 1.*invalid next cursor/,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const db = fakeDb([]);
      let index = 0;
      const result = await runMandateDiscovery({
        db, tenantId: TENANT, credentialsLoader: creds,
        clientFactory: () => ({
          listMandatesPage: async () => scenario.pages[Math.min(index++, scenario.pages.length - 1)],
          getCustomer: async () => ({ email: 'nobody@example.com' }),
        }),
      });
      assert.notEqual(result.status, 'complete');
      assert.match(result.error_message, scenario.message);
    });
  }
});

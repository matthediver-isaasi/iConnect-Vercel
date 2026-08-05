import test from 'node:test';
import assert from 'node:assert/strict';

import { recordSucceededMembershipPaymentIntent, reconcileRow } from './membershipPaymentReconciliation.js';

/**
 * Task #3278 — safety-net recorder for succeeded Stripe membership
 * PaymentIntents that the client-driven confirm step failed to record.
 *
 * Invariants under test:
 *  - dedupe by PI: a history row already referencing the PI => no-op
 *    (idempotent against a successful client confirm / webhook overlap)
 *  - an existing unpaid row is marked paid exactly once, and the shared
 *    membership-paid workflow fires exactly once
 *  - losing the atomic not-yet-paid -> paid race never fires the workflow
 *  - non-membership / mismatched PIs are rejected, and a succeeded PI with
 *    no matching row is surfaced as `unmatched` (never guessed into a row)
 */

const TENANT = 't-1';

function makePI(overrides = {}) {
  return {
    id: 'pi_test_123',
    status: 'succeeded',
    amount: 120,
    currency: 'gbp',
    metadata: {
      tenant_id: TENANT,
      membership_year: '2026/2027',
      member_id: 'm-1',
      token_id: 'tok-1',
    },
    ...overrides,
  };
}

// Minimal chainable supabase-like fake. `state` maps table -> behaviour.
function makeDb(state) {
  const calls = [];
  function from(table) {
    const q = { table, filters: {}, op: 'select', payload: null };
    const chain = {
      select() { return chain; },
      insert(payload) { q.op = 'insert'; q.payload = payload; return chain; },
      update(payload) { q.op = 'update'; q.payload = payload; return chain; },
      upsert(payload) { q.op = 'upsert'; q.payload = payload; return chain; },
      eq(col, val) { q.filters[col] = val; return chain; },
      neq(col, val) { q.filters[`neq:${col}`] = val; return chain; },
      is(col, val) { q.filters[`is:${col}`] = val; return chain; },
      or(expr) { q.filters.or = expr; return chain; },
      maybeSingle() {
        calls.push(q);
        if (q.op === 'insert') {
          const fn = state[table]?.insertResult;
          return Promise.resolve(fn ? fn(q) : { data: null, error: null });
        }
        const fn = state[table]?.maybeSingle;
        return Promise.resolve({ data: fn ? fn(q) : null, error: null });
      },
      then(resolve) {
        // awaited chain without maybeSingle (e.g. update().eq() ... .select())
        calls.push(q);
        const fn = state[table]?.exec;
        return Promise.resolve(fn ? fn(q) : { data: null, error: null }).then(resolve);
      },
    };
    return chain;
  }
  return { from, calls };
}

test('rejects a non-succeeded or non-membership PI', async () => {
  const db = makeDb({});
  const r1 = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI({ status: 'requires_payment_method' }) },
    { db, fireWorkflow: async () => ({ fired: true }) },
  );
  assert.equal(r1.status, 'invalid');

  const r2 = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI({ metadata: { tenant_id: TENANT } }) },
    { db, fireWorkflow: async () => ({ fired: true }) },
  );
  assert.equal(r2.status, 'invalid');

  const r3 = await recordSucceededMembershipPaymentIntent(
    { tenantId: 'other-tenant', paymentIntent: makePI() },
    { db, fireWorkflow: async () => ({ fired: true }) },
  );
  assert.equal(r3.status, 'invalid');
});

test('dedupes by PI: already-recorded is a no-op and fires no workflow', async () => {
  let fired = 0;
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => ({ id: 'tok-1', member_id: 'm-1', tenant_id: TENANT, membership_year: '2026/2027', status: 'paid' }) },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id === 'pi_test_123'
        ? { id: 'row-1', payment_status: 'paid' }
        : null),
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'already-recorded');
  assert.equal(r.recordId, 'row-1');
  assert.equal(fired, 0);
});

test('marks an existing unpaid row paid and fires the workflow exactly once', async () => {
  let fired = 0;
  let paidUpdate = null;
  const row = { id: 'row-2', tenant_id: TENANT, member_id: 'm-1', membership_year: '2026/2027', payment_status: 'unpaid', paid_at: null, total_with_vat: 1.2, stripe_payment_intent_id: null };
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => ({ id: 'tok-1', member_id: 'm-1', tenant_id: TENANT, membership_year: '2026/2027', history_record_id: 'row-2', status: 'pending' }) },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id ? null : (q.filters.id === 'row-2' ? row : null)),
      exec: (q) => {
        if (q.op === 'update' && q.payload?.payment_status === 'paid') {
          paidUpdate = q;
          return { data: [{ id: 'row-2' }], error: null }; // atomic guard wins
        }
        return { data: null, error: null };
      },
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; }, applyPayment: async () => ({}) },
  );
  assert.equal(r.status, 'recorded');
  assert.equal(fired, 1);
  assert.ok(paidUpdate, 'expected a paid-marking update');
  assert.equal(paidUpdate.payload.stripe_payment_intent_id, 'pi_test_123');
  assert.equal(paidUpdate.filters['neq:payment_status'], 'paid', 'update must be guarded against already-paid rows');
});

test('repairs a PI-stamped but still-unpaid row (confirm crashed mid-flight) and fires workflow once', async () => {
  // The confirm handlers stamp the PI on the row BEFORE marking it paid; a
  // crash in that window must be recoverable — not treated as recorded.
  let fired = 0;
  let paidUpdate = null;
  const row = { id: 'row-stamped', tenant_id: TENANT, member_id: 'm-1', membership_year: '2026/2027', payment_status: 'unpaid', paid_at: null, total_with_vat: 1.2, stripe_payment_intent_id: 'pi_test_123' };
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id === 'pi_test_123' ? row : null),
      exec: (q) => {
        if (q.op === 'update' && q.payload?.payment_status === 'paid') {
          paidUpdate = q;
          return { data: [{ id: 'row-stamped' }], error: null };
        }
        return { data: null, error: null };
      },
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'recorded');
  assert.equal(r.recordId, 'row-stamped');
  assert.equal(fired, 1);
  assert.ok(paidUpdate, 'expected the stamped-unpaid row to be marked paid');
  assert.match(paidUpdate.filters.or || '', /stripe_payment_intent_id\.eq\.pi_test_123/, 'atomic guard must accept a same-PI stamp');
});

test('a settled (paid) row referencing the PI is terminal — no re-fire', async () => {
  let fired = 0;
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id === 'pi_test_123'
        ? { id: 'row-paid', payment_status: 'paid', stripe_payment_intent_id: 'pi_test_123' }
        : null),
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'already-recorded');
  assert.equal(fired, 0);
});

test('a row stamped with a DIFFERENT PI is a conflict — never overwritten', async () => {
  let fired = 0;
  const row = { id: 'row-other', tenant_id: TENANT, member_id: 'm-1', membership_year: '2026/2027', payment_status: 'unpaid', total_with_vat: 1.2, stripe_payment_intent_id: 'pi_OTHER' };
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id === 'pi_test_123' ? null : row),
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI({ metadata: { tenant_id: TENANT, membership_year: '2026/2027', member_id: 'm-1' } }) },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'conflict');
  assert.equal(fired, 0);
});

test('losing the concurrent-confirm race fires no workflow', async () => {
  let fired = 0;
  const row = { id: 'row-3', tenant_id: TENANT, member_id: 'm-1', membership_year: '2026/2027', payment_status: 'unpaid', total_with_vat: 1.2, stripe_payment_intent_id: null };
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id ? null : row),
      exec: (q) => (q.op === 'update' ? { data: [], error: null } : { data: null, error: null }), // guard loses
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI({ metadata: { tenant_id: TENANT, membership_year: '2026/2027', member_id: 'm-1' } }) },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'raced');
  assert.equal(fired, 0);
});

test('webhook-before-any-row: reconstructs a validated paid row and fires workflow once', async () => {
  // Form-flow confirm can fail BEFORE inserting the history row. The
  // recorder must reconstruct it from validated PI metadata (entity
  // verified in-tenant), mark it paid, and fire the workflow once.
  let fired = 0;
  let insertedPayload = null;
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member: { maybeSingle: (q) => (q.filters.id === 'm-1' && q.filters.tenant_id === TENANT ? { id: 'm-1' } : null) },
    member_membership_history: {
      maybeSingle: () => null,
      insertResult: (q) => { insertedPayload = q.payload; return { data: { id: 'row-new', ...q.payload }, error: null }; },
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI({ metadata: { tenant_id: TENANT, membership_year: '2026/2027', member_id: 'm-1' } }) },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'recorded');
  assert.equal(fired, 1);
  assert.ok(insertedPayload);
  assert.equal(insertedPayload.payment_status, 'paid');
  assert.equal(insertedPayload.stripe_payment_intent_id, 'pi_test_123');
  assert.equal(insertedPayload.total_with_vat, 1.2);
});

test('reconstruction race: concurrent confirm insert (23505) is adopted, never doubled', async () => {
  let fired = 0;
  const racedRow = { id: 'row-conc', tenant_id: TENANT, member_id: 'm-1', membership_year: '2026/2027', payment_status: 'paid', stripe_payment_intent_id: 'pi_test_123', total_with_vat: 1.2 };
  // The row does not exist when the recorder first looks, but a concurrent
  // confirm inserts it before the recorder's own insert lands (23505).
  let rowVisible = false;
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member: { maybeSingle: () => ({ id: 'm-1' }) },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id || !rowVisible ? null : (q.filters.member_id === 'm-1' ? racedRow : null)),
      insertResult: () => { rowVisible = true; return { data: null, error: { code: '23505', message: 'duplicate' } }; },
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI({ metadata: { tenant_id: TENANT, membership_year: '2026/2027', member_id: 'm-1' } }) },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'already-recorded');
  assert.equal(fired, 0);
});

test('token/PI binding mismatch (different member or year) is refused as conflict', async () => {
  let fired = 0;
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => ({ id: 'tok-1', tenant_id: TENANT, member_id: 'OTHER-member', membership_year: '2026/2027', status: 'pending' }) },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() }, // metadata member m-1 vs token OTHER-member
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'conflict');
  assert.equal(fired, 0);

  const db2 = makeDb({
    membership_fee_token: { maybeSingle: () => ({ id: 'tok-1', tenant_id: TENANT, member_id: 'm-1', membership_year: '2025/2026', status: 'pending' }) },
  });
  const r2 = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() }, // metadata year 2026/2027 vs token 2025/2026
    { db: db2, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r2.status, 'conflict');
  assert.equal(fired, 0);
});

test('fee-token reconstruction uses token snapshot amounts and links history_record_id back', async () => {
  let fired = 0;
  let insertedPayload = null;
  let tokenUpdate = null;
  const feeToken = { id: 'tok-1', tenant_id: TENANT, member_id: 'm-1', membership_year: '2026/2027', status: 'pending', final_cost: '1.00', currency: 'GBP', cost_breakdown: { totalWithVat: 1.2, vatAmount: 0.2 }, history_record_id: null };
  const db = makeDb({
    membership_fee_token: {
      maybeSingle: () => feeToken,
      exec: (q) => { if (q.op === 'update') tokenUpdate = q.payload; return { data: null, error: null }; },
    },
    member: { maybeSingle: () => ({ id: 'm-1' }) },
    member_membership_history: {
      maybeSingle: () => null,
      insertResult: (q) => { insertedPayload = q.payload; return { data: { id: 'row-tok', ...q.payload }, error: null }; },
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'recorded');
  assert.equal(fired, 1);
  assert.equal(insertedPayload.membership_year, '2026/2027');
  assert.equal(insertedPayload.final_cost, 1.0);
  assert.equal(insertedPayload.total_with_vat, 1.2);
  assert.equal(insertedPayload.vat_amount, 0.2);
  assert.ok(tokenUpdate, 'expected token updates');
  // token got history_record_id linked (first update) and/or paid flip
  assert.ok(tokenUpdate.status === 'paid' || tokenUpdate.history_record_id === 'row-tok');
});

test('a succeeded PI whose entity does not exist stays unmatched (never invents rows)', async () => {
  let fired = 0;
  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member: { maybeSingle: () => null },
    member_membership_history: { maybeSingle: () => null },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() },
    { db, fireWorkflow: async () => { fired += 1; return { fired: true }; } },
  );
  assert.equal(r.status, 'unmatched');
  assert.equal(fired, 0);
});

test('RACE: webhook records mid-confirm, then the stale inline/cron reconcile must not double-fire', async () => {
  // The public fee-token confirm inserts the history row (unpaid, PI
  // stamped) and only LATER runs reconcileRow with that in-memory
  // snapshot. If the webhook recorder marks the row paid in between,
  // the reconciler's guarded update must change nothing and fire NO
  // second workflow — exactly-once across confirm + webhook + cron.
  let workflowFires = 0;
  // Shared mutable "DB row" — starts as the fee-token confirm left it.
  const dbRow = { id: 'row-race', tenant_id: TENANT, member_id: 'm-1', membership_year: '2026/2027', payment_status: 'unpaid', paid_at: null, total_with_vat: 1.2, stripe_payment_intent_id: 'pi_test_123', accounting_invoice_id: 'inv-1' };

  const db = makeDb({
    membership_fee_token: { maybeSingle: () => null },
    member_membership_history: {
      maybeSingle: (q) => (q.filters.stripe_payment_intent_id === 'pi_test_123' ? { ...dbRow } : null),
      exec: (q) => {
        if (q.op !== 'update') return { data: null, error: null };
        // Emulate the DB's conditional update semantics. The reconcile
        // guard is NULL-safe (IS DISTINCT FROM) via an .or() of
        // `payment_status.neq.<target>,payment_status.is.null`.
        const target = q.payload?.payment_status;
        const guarded = q.filters['neq:payment_status'] === target
          || q.filters.or === `payment_status.neq.${target},payment_status.is.null`;
        if (guarded && dbRow.payment_status === target) {
          return { data: [], error: null }; // guard: no row matched
        }
        Object.assign(dbRow, q.payload);
        return { data: [{ id: dbRow.id }], error: null };
      },
    },
  });
  const fireWorkflow = async () => { workflowFires += 1; return { fired: true }; };

  // Confirm handler took its stale snapshot BEFORE the webhook fired:
  const staleSnapshot = { ...dbRow };

  // 1. Webhook recorder wins the transition.
  const rec = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI() },
    { db, fireWorkflow, applyPayment: async () => ({}) },
  );
  assert.equal(rec.status, 'recorded');
  assert.equal(dbRow.payment_status, 'paid');
  assert.equal(workflowFires, 1);

  // 2. Inline confirm reconciliation then runs with its stale unpaid
  //    snapshot; the provider reports the invoice as paid.
  const outcome = await reconcileRow(
    { table: 'member_membership_history', row: staleSnapshot },
    { db, fireWorkflow, fetchStatus: async () => ({ status: 'paid', paidAt: '2026-08-02T00:00:00Z' }) },
  );
  assert.equal(outcome.transitioned, false);
  assert.equal(outcome.skippedReason, 'transition-raced');
  assert.equal(workflowFires, 1, 'workflow must fire exactly once across webhook + inline reconcile');

  // 3. A later cron pass sees the (now terminal) paid row and skips it.
  const cronOutcome = await reconcileRow(
    { table: 'member_membership_history', row: { ...dbRow } },
    { db, fireWorkflow, fetchStatus: async () => ({ status: 'paid' }) },
  );
  assert.equal(cronOutcome.transitioned, false);
  assert.equal(workflowFires, 1);
});

test('org-scoped metadata routes to the organisation history table', async () => {
  const seen = [];
  const db = makeDb({
    organisation_membership_history: {
      maybeSingle: (q) => { seen.push(q.table); return { id: 'row-org', payment_status: 'paid' }; },
    },
  });
  const r = await recordSucceededMembershipPaymentIntent(
    { tenantId: TENANT, paymentIntent: makePI({ metadata: { tenant_id: TENANT, membership_year: '2026/2027', organization_id: 'org-1' } }) },
    { db, fireWorkflow: async () => ({ fired: true }) },
  );
  assert.equal(r.status, 'already-recorded');
  assert.ok(seen.includes('organisation_membership_history'));
});

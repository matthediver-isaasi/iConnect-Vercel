import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileFormPayments } from './formPaymentReconciliation.js';

const form = {
  id: 'form-1',
  tenant_id: 'tenant-1',
  fields: [],
  entity_pipelines: {},
  submission_emails: [],
};

function queryFor(table, rows) {
  const filters = [];
  const query = {
    select() { return query; },
    eq(column, value) { filters.push([column, value]); return query; },
    not() { return query; },
    filter() { return query; },
    or() { return query; },
    gte() { return query; },
    lte() { return query; },
    order() { return query; },
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => {
      if (table === 'form') return { data: form, error: null };
      const id = filters.find(([column]) => column === 'id')?.[1];
      return { data: rows.find(row => row.id === id) || null, error: null };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    },
  };
  return query;
}

function makeDb({
  addressClaims = [],
  completionRows = [],
  managedClaims = null,
  managedError = null,
}) {
  const rows = new Map([...addressClaims, ...completionRows].map(row => [row.id, structuredClone(row)]));
  const calls = [];
  let managedClaimIndex = 0;
  const queue = managedClaims || [
    ...addressClaims.map(row => ({
      work_kind: 'address',
      submission: rows.get(row.id),
      lease_token: `lease-${row.id}`,
    })),
    ...completionRows.map(row => ({
      work_kind: 'completion',
      submission: rows.get(row.id),
      lease_token: null,
    })),
  ];
  const db = {
    calls,
    async rpc(name, args = {}) {
      calls.push({ name, args });
      if (name === 'claim_form_payment_reconciliation_work') {
        if (managedError) return { data: null, error: managedError };
        const claim = queue[managedClaimIndex++];
        return { data: claim ? [claim] : [], error: null };
      }
      if (name === 'capture_form_stripe_billing_address_once') {
        const row = rows.get(args.p_submission_id);
        row.payment_meta = { ...row.payment_meta, stripe_billing_address: args.p_address };
        return { data: row.payment_meta, error: null };
      }
      if (name === 'finish_form_stripe_address_mapping_retry') {
        return { data: true, error: null };
      }
      if (name === 'mark_one_off_form_due_diligence_ready') return { data: true, error: null };
      if (name === 'claim_form_due_diligence_initialization') {
        return { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      }
      return { data: [], error: null };
    },
    from(table) {
      return queryFor(table, [...rows.values()]);
    },
  };
  return db;
}

function stripeIntent(row) {
  return {
    paymentIntent: {
      id: row.payment_reference,
      status: 'succeeded',
      latest_charge: `charge-${row.id}`,
      customer: `customer-${row.id}`,
      metadata: {
        type: 'form_payment',
        form_submission_id: row.id,
        tenant_id: row.tenant_id,
      },
    },
    stripe: {
      charges: {
        retrieve: async () => ({
          billing_details: {
            address: {
              line1: '1 Test Street',
              city: 'Leeds',
              postal_code: 'LS1 1AA',
              country: 'GB',
            },
          },
        }),
      },
      customers: { update: async () => ({}) },
    },
  };
}

function baseAddressRow(id, paymentMeta = {}) {
  return {
    id,
    tenant_id: 'tenant-1',
    form_id: 'form-1',
    payment_provider: 'stripe',
    payment_status: 'paid',
    payment_reference: `pi-${id}`,
    payment_meta: paymentMeta,
  };
}

test('an uncreated target is reported as waiting, not configuration drift, and does not block completion', async () => {
  const oldRow = baseAddressRow('old-target', {
    stripe_billing_address: {
      line1: '1 Old Street',
      city: 'Leeds',
      postal_code: 'LS1 1AA',
      country: 'GB',
    },
    stripe_address_mapping_config: {
      version: 1,
      mappings: [{
        source: 'line1',
        target_entity: 'member',
        target_type: 'custom',
        target_field: 'billing_line1',
      }],
    },
  });
  const newerRow = baseAddressRow('newer-ready', {
    completion: { version: 1, status: 'done' },
  });
  const db = makeDb({
    addressClaims: [oldRow],
    completionRows: [newerRow],
    managedClaims: [
      { work_kind: 'address', submission: oldRow, lease_token: 'lease-old-target' },
      { work_kind: 'completion', submission: newerRow, lease_token: null },
    ],
  });
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    timeBudgetMs: 36_000,
    retrievePaymentIntent: async (_tenantId, _feature, paymentReference) => {
      const row = paymentReference === oldRow.payment_reference ? oldRow : newerRow;
      return stripeIntent(row);
    },
  });

  assert.equal(result.addressRecovery.attempted, 1);
  assert.equal(result.addressRecovery.failed, 0);
  assert.equal(result.addressRecovery.waitingForTarget, 1);
  assert.equal(result.addressRecovery.succeeded, 0);
  assert.equal(result.completion.claimed, 1);
  assert.equal(result.completion.attempted, 1);
  assert.equal(result.completion.completed, 1);
  assert.equal(result.completion.waitingForAddress, 0);
  assert.ok(result.issues.some(issue =>
    issue.submissionId === oldRow.id
      && issue.code === 'address-target-not-created'));
  assert.ok(!result.issues.some(issue => issue.code === 'target-resolution-changed'));
  assert.ok(db.calls.some(call =>
    call.name === 'finish_form_stripe_address_mapping_retry'
      && call.args.p_submission_id === oldRow.id
      && call.args.p_succeeded === false));
});

test('managed claims are one-at-a-time and do not reserve an unused batch', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => baseAddressRow(`bounded-${index}`));
  const db = makeDb({ addressClaims: rows });
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    retrievePaymentIntent: async (_tenantId, _feature, paymentReference) => {
      const row = rows.find(candidate => candidate.payment_reference === paymentReference);
      return stripeIntent(row);
    },
  });
  const claims = db.calls.filter(call => call.name === 'claim_form_payment_reconciliation_work');

  assert.equal(claims.length, 11);
  assert.ok(claims.every(call => Object.keys(call.args).length === 0));
  assert.equal(result.addressRecovery.attempted, 10);
  assert.equal(result.addressRecovery.succeeded, 10);
  assert.equal(result.addressRecovery.failed, 0);
  assert.equal(
    db.calls.filter(call => call.name === 'finish_form_stripe_address_mapping_retry').length,
    10,
  );
  assert.equal(result.completion.claimed, 0);
});

test('budget stop claims no address lease and reports waiting completion safely', async () => {
  const row = baseAddressRow('budget-row', {
    membership: { quote: { target: 'member' } },
  });
  const db = makeDb({ addressClaims: [row], completionRows: [{ ...row }] });
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    timeBudgetMs: 5_000,
  });

  assert.equal(result.addressRecovery.attempted, 0);
  assert.equal(db.calls.filter(call => call.name === 'claim_form_payment_reconciliation_work').length, 0);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.completion.claimed, 0);
  assert.equal(result.completion.waitingForAddress, 0);
  assert.equal(result.partial, true);
  assert.equal(result.managed.skippedBudget, 1);
});

test('a slow completion consumes this invocation and the next invocation selects newer work', async () => {
  const oldRow = baseAddressRow('slow-completion', {
    stripe_billing_address: { line1: 'old' },
    completion: { version: 1, status: 'queued' },
  });
  const newerRow = baseAddressRow('newer-completion', {
    stripe_billing_address: { line1: 'new' },
    completion: { version: 1, status: 'queued' },
  });
  const db = makeDb({ completionRows: [oldRow, newerRow] });
  const realNow = Date.now;
  let clock = 1_000_000;
  const finalized = [];
  Date.now = () => clock;
  try {
    const options = {
      baseUrl: 'https://tenant.example.test',
      timeBudgetMs: 40_000,
      finalizeCompletion: async ({ submission }) => {
        finalized.push(submission.id);
        clock += 30_000;
        return { finalized: true };
      },
    };
    const first = await reconcileFormPayments(db, options);
    const second = await reconcileFormPayments(db, options);
    assert.equal(first.budgetExhausted, true);
    assert.equal(first.completion.completed, 1);
    assert.equal(second.completion.completed, 1);
    assert.deepEqual(finalized, ['slow-completion', 'newer-completion']);
  } finally {
    Date.now = realNow;
  }
});

test('a slow address capture is followed by ready completion on the next invocation', async () => {
  const row = baseAddressRow('slow-address', {
    membership: { quote: { target: 'member' } },
    completion: { version: 1, status: 'queued' },
  });
  const db = makeDb({ addressClaims: [row], completionRows: [row] });
  const realNow = Date.now;
  let clock = 2_000_000;
  const finalized = [];
  Date.now = () => clock;
  try {
    const options = {
      baseUrl: 'https://tenant.example.test',
      timeBudgetMs: 40_000,
      retrievePaymentIntent: async () => {
        clock += 30_000;
        return stripeIntent(row);
      },
      finalizeCompletion: async ({ submission }) => {
        finalized.push(submission.id);
        return { finalized: true };
      },
    };
    const first = await reconcileFormPayments(db, options);
    const second = await reconcileFormPayments(db, options);
    assert.equal(first.addressRecovery.attempted, 1);
    assert.equal(first.completion.claimed, 0);
    assert.equal(second.completion.completed, 1);
    assert.deepEqual(finalized, ['slow-address']);
  } finally {
    Date.now = realNow;
  }
});

test('one fair stream advances both completion and address classes without priority starvation', async () => {
  const completionOne = baseAddressRow('fair-completion-1', {
    stripe_billing_address: { line1: 'ready-1' },
    completion: { version: 1, status: 'queued' },
  });
  const address = baseAddressRow('fair-address', {
    membership: { quote: { target: 'member' } },
    completion: { version: 1, status: 'queued' },
  });
  const completionTwo = baseAddressRow('fair-completion-2', {
    stripe_billing_address: { line1: 'ready-2' },
    completion: { version: 1, status: 'queued' },
  });
  const db = makeDb({
    addressClaims: [address],
    completionRows: [completionOne, completionTwo],
    managedClaims: [
      { work_kind: 'completion', submission: completionOne, lease_token: null },
      { work_kind: 'address', submission: address, lease_token: 'lease-fair-address' },
      { work_kind: 'completion', submission: completionTwo, lease_token: null },
    ],
  });
  const finalized = [];
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    retrievePaymentIntent: async () => stripeIntent(address),
    finalizeCompletion: async ({ submission }) => {
      finalized.push(submission.id);
      return { finalized: true };
    },
  });
  const workOrder = db.calls
    .filter(call => call.name === 'claim_form_payment_reconciliation_work')
    .slice(0, 3)
    .map((_, index) => ['completion', 'address', 'completion'][index]);
  assert.deepEqual(workOrder, ['completion', 'address', 'completion']);
  assert.deepEqual(finalized, ['fair-completion-1', 'fair-completion-2']);
  assert.equal(result.addressRecovery.attempted, 1);
  assert.equal(result.managed.released, 1);
});

test('a missing managed-work RPC is visible, partial, and never falls back to old queues', async () => {
  const db = makeDb({
    managedError: { message: 'function claim_form_payment_reconciliation_work() does not exist' },
  });
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    timeBudgetMs: 40_000,
  });
  assert.equal(result.partial, true);
  assert.equal(result.managed.missingRpc, true);
  assert.ok(result.issues.some(issue => issue.scope === 'reconciliation-work-claim'));
  assert.equal(db.calls.filter(call =>
    call.name === 'claim_form_payment_completion_retries'
      || call.name === 'claim_form_stripe_address_mapping_retries').length, 0);
});
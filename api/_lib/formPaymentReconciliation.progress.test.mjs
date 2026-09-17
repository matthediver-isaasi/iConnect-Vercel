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

function makeDb({ addressClaims, completionRows = [] }) {
  const rows = new Map(addressClaims.map(row => [row.id, structuredClone(row)]));
  const calls = [];
  let addressClaimIndex = 0;
  let completionClaimed = false;
  const db = {
    calls,
    async rpc(name, args = {}) {
      calls.push({ name, args });
      if (name === 'claim_form_stripe_address_mapping_retries') {
        const row = addressClaims[addressClaimIndex++];
        return { data: row ? [{ submission: rows.get(row.id), lease_token: `lease-${row.id}` }] : [], error: null };
      }
      if (name === 'capture_form_stripe_billing_address_once') {
        const row = rows.get(args.p_submission_id);
        row.payment_meta = { ...row.payment_meta, stripe_billing_address: args.p_address };
        return { data: row.payment_meta, error: null };
      }
      if (name === 'finish_form_stripe_address_mapping_retry') {
        return { data: true, error: null };
      }
      if (name === 'claim_form_payment_completion_retries') {
        if (completionClaimed) return { data: [], error: null };
        completionClaimed = true;
        return { data: completionRows, error: null };
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
  const db = makeDb({ addressClaims: [oldRow, newerRow], completionRows: [newerRow] });
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    timeBudgetMs: 36_000,
    retrievePaymentIntent: async (_tenantId, _feature, paymentReference) => {
      const row = paymentReference === oldRow.payment_reference ? oldRow : newerRow;
      return stripeIntent(row);
    },
  });

  assert.equal(result.addressRecovery.attempted, 2);
  assert.equal(result.addressRecovery.failed, 0);
  assert.equal(result.addressRecovery.waitingForTarget, 1);
  assert.equal(result.addressRecovery.succeeded, 1);
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
  assert.ok(db.calls.some(call =>
    call.name === 'finish_form_stripe_address_mapping_retry'
      && call.args.p_submission_id === newerRow.id
      && call.args.p_succeeded === true));
});

test('address claims are one-at-a-time, capped at eight, and stop before completion reserve', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => baseAddressRow(`bounded-${index}`));
  const db = makeDb({ addressClaims: rows });
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    retrievePaymentIntent: async (_tenantId, _feature, paymentReference) => {
      const row = rows.find(candidate => candidate.payment_reference === paymentReference);
      return stripeIntent(row);
    },
  });
  const claims = db.calls.filter(call => call.name === 'claim_form_stripe_address_mapping_retries');

  assert.equal(claims.length, 8);
  assert.ok(claims.every(call => call.args.p_limit === 1));
  assert.equal(result.addressRecovery.attempted, 8);
  assert.equal(result.addressRecovery.succeeded, 8);
  assert.equal(result.addressRecovery.failed, 0);
  assert.equal(
    db.calls.filter(call => call.name === 'finish_form_stripe_address_mapping_retry').length,
    8,
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
  assert.equal(db.calls.filter(call => call.name === 'claim_form_stripe_address_mapping_retries').length, 0);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.completion.claimed, 1);
  assert.equal(result.completion.waitingForAddress, 1);
  assert.equal(result.partial, true);
  const issue = result.issues.find(entry => entry.submissionId === row.id);
  assert.deepEqual(
    { code: issue.code, message: issue.message },
    {
      code: 'address-prerequisite-missing',
      message: 'Stripe billing address prerequisite is not available.',
    },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(issue, 'error'), false);
});
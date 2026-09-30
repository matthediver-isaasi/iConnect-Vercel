import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileFormPaymentSubmission } from './formPaymentTargetedRecovery.js';

const form = {
  id: 'form-1',
  tenant_id: 'tenant-1',
  access_policy: null,
  fields: [],
  entity_pipelines: null,
};

function makeDb(submissions, forms = { 'form-1': form }) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const state = { table, filters: [] };
      const query = {
        select() { return query; },
        eq(column, value) {
          state.filters.push([column, value]);
          return query;
        },
        async maybeSingle() {
          calls.push({ table: state.table, filters: [...state.filters] });
          if (state.table === 'form_submission') {
            const id = state.filters.find(([column]) => column === 'id')?.[1];
            return { data: submissions[id] || null, error: null };
          }
          const id = state.filters.find(([column]) => column === 'id')?.[1];
          return { data: forms[id] || null, error: null };
        },
      };
      return query;
    },
  };
  return db;
}

function paid(overrides = {}) {
  return {
    id: 'sub-1',
    form_id: 'form-1',
    tenant_id: 'tenant-1',
    payment_provider: 'stripe',
    payment_status: 'paid',
    payment_meta: {
      stripe_billing_address: { line1: 'immutable' },
    },
    ...overrides,
  };
}

const finalizeDone = async () => ({ finalized: true });

test('targeted recovery reads and finalizes only the requested submission', async () => {
  const db = makeDb({
    'sub-1': paid(),
    'sub-2': paid({ id: 'sub-2' }),
  });
  let finalized = 0;
  const result = await reconcileFormPaymentSubmission(db, {
    submissionId: 'sub-1',
    testdeps: {
      finalizeFormSubmission: async (args) => {
        finalized += 1;
        assert.equal(args.submission.id, 'sub-1');
        assert.equal(args.form.id, 'form-1');
        return finalizeDone();
      },
      resolveBaseUrl: async (tenantId) => {
        assert.equal(tenantId, 'tenant-1');
        return 'https://tenant.example.test';
      },
    },
  });
  assert.equal(finalized, 1);
  assert.equal(result.submissionId, 'sub-1');
  assert.equal(result.checked, 1);
  assert.equal(result.paid, 0);
  assert.equal(result.paymentStatus, 'paid');
  assert.equal(result.finalized, 1);
  assert.equal(result.completion.completed, 1);
  assert.equal(result.partial, false);
  assert.ok(db.calls.every((call) => call.filters.some(([column, value]) => column !== 'id' || value === 'sub-1')));
});

test('access proof and billing-address gates have no finalizer side effects', async () => {
  let calls = 0;
  const restrictedForm = { ...form, access_policy: { type: 'members' } };
  const missingProof = await reconcileFormPaymentSubmission(
    makeDb({ 'sub-1': paid() }, { 'form-1': restrictedForm }),
    { submissionId: 'sub-1', testdeps: { finalizeFormSubmission: async () => { calls += 1; return finalizeDone(); } } },
  );
  assert.equal(missingProof.completion.waitingForAccess, 1);
  assert.equal(missingProof.finalized, 0);

  const missingAddress = await reconcileFormPaymentSubmission(
    makeDb({ 'sub-1': paid({ payment_meta: { membership: {} } }) }),
    { submissionId: 'sub-1', testdeps: { finalizeFormSubmission: async () => { calls += 1; return finalizeDone(); } } },
  );
  assert.equal(missingAddress.completion.waitingForAddress, 1);
  assert.equal(missingAddress.issues[0].code, 'address-prerequisite-missing');
  assert.equal(calls, 0);
});

test('only paid Stripe submissions are eligible and unsupported states are safe', async () => {
  for (const submission of [
    paid({ payment_provider: 'gocardless' }),
    paid({ payment_status: 'pending' }),
  ]) {
    let finalized = false;
    const result = await reconcileFormPaymentSubmission(
      makeDb({ 'sub-1': submission }),
      { submissionId: 'sub-1', testdeps: { finalizeFormSubmission: async () => { finalized = true; return finalizeDone(); } } },
    );
    assert.equal(finalized, false);
    assert.equal(result.finalized, 0);
    assert.equal(result.partial, true);
    assert.match(result.issues[0].message, /^[A-Z]/);
  }
});

test('retryable, in-progress, and budget outcomes remain explicit', async () => {
  const makeOptions = (outcome) => ({
    submissionId: 'sub-1',
    testdeps: {
      resolveBaseUrl: async () => 'https://tenant.example.test',
      finalizeFormSubmission: async () => outcome,
    },
  });
  const db = makeDb({ 'sub-1': paid() });

  const retryable = await reconcileFormPaymentSubmission(db, makeOptions({ retryable: true }));
  assert.equal(retryable.completion.failed, 1);
  assert.equal(retryable.budgetExhausted, false);

  const inProgress = await reconcileFormPaymentSubmission(db, makeOptions({ inProgress: true }));
  assert.equal(inProgress.issues[0].code, 'completion-in-progress');
  assert.equal(inProgress.failed, 0);

  let called = false;
  const exhausted = await reconcileFormPaymentSubmission(db, {
    submissionId: 'sub-1',
    timeBudgetMs: 0,
    testdeps: {
      finalizeFormSubmission: async () => { called = true; return finalizeDone(); },
    },
  });
  assert.equal(exhausted.budgetExhausted, true);
  assert.equal(called, false);
});

test('missing rows and database failures never expose raw errors', async () => {
  const missing = await reconcileFormPaymentSubmission(makeDb({}), { submissionId: 'missing' });
  assert.equal(missing.failed, 1);
  assert.equal(missing.issues[0].code, 'submission-not-found');

  const db = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: { message: 'secret database details' } }; },
      };
    },
  };
  const failed = await reconcileFormPaymentSubmission(db, { submissionId: 'sub-1' });
  assert.equal(failed.failed, 1);
  assert.doesNotMatch(JSON.stringify(failed), /secret database details/);
});

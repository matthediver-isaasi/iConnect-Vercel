import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeFormMembership,
  isDefinitiveInvoiceCreateRejection,
} from './formMembershipFinalize.js';
import { settleFormStripeInvoice } from './formStripeInvoiceSettlement.js';

const TENANT_ID = 'tenant-1';
const SUBMISSION_ID = 'submission-1';
const PAYMENT_REFERENCE = 'pi_form_1';

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function quote(overrides = {}) {
  return {
    config_id: 'config-1',
    membership_year: '2027',
    target: 'member',
    annual_cost: 100,
    prorata_cost: 100,
    final_cost: 100,
    total_with_vat: 100,
    currency: 'GBP',
    tier_label: 'Standard',
    billing_period: 'annual',
    ...overrides,
  };
}

function fixture({
  provider = 'xero',
  progress = {},
  histories = [],
  processing_notes = null,
  quoteOverrides = {},
} = {}) {
  const submission = {
    id: SUBMISSION_ID,
    tenant_id: TENANT_ID,
    form_id: 'form-1',
    form_name: 'Membership form',
    payment_provider: 'stripe',
    payment_status: 'paid',
    payment_paid_at: '2027-01-15T12:00:00.000Z',
    payment_reference: PAYMENT_REFERENCE,
    submitted_by_email: 'member@example.test',
    created_member_id: 'member-1',
    processing_notes,
    payment_meta: {
      stripe_feature: 'membership',
      stripe_billing_address: {
        line1: '1 Test Street',
        city: 'Testville',
        postal_code: 'T1 1ST',
        country: 'GB',
      },
      membership: { quote: quote(quoteOverrides) },
      membership_result: {
        ...progress,
      },
    },
  };
  const historyRows = histories.length ? histories : [];
  return {
    submission,
    histories: historyRows,
    members: [{
      id: 'member-1',
      tenant_id: TENANT_ID,
      first_name: 'Test',
      last_name: 'Member',
      email: 'member@example.test',
    }],
    provider,
  };
}

/**
 * A small PostgREST-shaped database fake. In particular, the progress RPC is
 * not an Object.assign shortcut: it checks every expected value, scopes by
 * tenant and submission, and returns the current value on a lost CAS. This
 * catches tests which accidentally make a stale caller look like the winner.
 */
function makeDb(initial, { onMerge } = {}) {
  const state = {
    submissions: [clone(initial.submission)],
    histories: clone(initial.histories || []),
    members: clone(initial.members || []),
    organizations: clone(initial.organizations || []),
    notes: [],
  };
  const db = {
    state,
    rpcCalls: [],
    updateCalls: [],
    insertCalls: [],
    selectCalls: [],
    getSubmission() {
      return clone(state.submissions[0]);
    },
    historyRows(table = 'member_membership_history') {
      return clone(state.histories.filter((row) => row.table === table || !row.table));
    },
    from(table) {
      const operation = { kind: 'select', payload: null, filters: [], returning: false };
      const q = {
        select() {
          operation.returning = true;
          return q;
        },
        update(payload) {
          operation.kind = 'update';
          operation.payload = clone(payload);
          return q;
        },
        insert(payload) {
          operation.kind = 'insert';
          operation.payload = clone(payload);
          return q;
        },
        eq(column, value) {
          operation.filters.push([column, value]);
          return q;
        },
        maybeSingle() {
          return q.execute();
        },
        then(resolve, reject) {
          return q.execute().then(resolve, reject);
        },
        async execute() {
          const rows = db.rowsFor(table);
          const matches = rows.filter((row) => operation.filters.every(
            ([column, value]) => row?.[column] === value,
          ));
          if (operation.kind === 'select') {
            db.selectCalls.push({
              table,
              filters: clone(operation.filters),
              row: clone(matches[0] || null),
            });
            return { data: clone(matches[0] || null), error: null };
          }
          if (operation.kind === 'insert') {
            const payloads = Array.isArray(operation.payload)
              ? operation.payload : [operation.payload];
            const inserted = [];
            for (const payload of payloads) {
              const row = clone(payload);
              if (table.endsWith('membership_history')) {
                const duplicate = rows.find((candidate) => candidate.tenant_id === row.tenant_id
                  && candidate.membership_year === row.membership_year
                  && (candidate.member_id === row.member_id
                    || candidate.organization_id === row.organization_id));
                if (duplicate) {
                  return { data: null, error: { code: '23505', message: 'membership already exists' } };
                }
                row.id ||= `history-${state.histories.length + 1}`;
                row.table = table;
                state.histories.push(row);
              } else if (table === 'form_submission') {
                state.submissions.push(row);
              } else if (table === 'member_note' || table === 'organization_note') {
                state.notes.push({ table, ...row });
              } else {
                rows.push(row);
              }
              inserted.push(row);
              db.insertCalls.push({ table, payload: clone(row) });
            }
            return {
              data: clone(operation.returning ? inserted[0] : null),
              error: null,
            };
          }
          if (operation.kind === 'update') {
            for (const row of matches) Object.assign(row, clone(operation.payload));
            db.updateCalls.push({
              table,
              payload: clone(operation.payload),
              filters: clone(operation.filters),
              matched: matches.length,
            });
            return {
              data: clone(operation.returning ? matches[0] || null : null),
              error: null,
            };
          }
          throw new Error(`unsupported fake operation ${operation.kind}`);
        },
      };
      return q;
    },
    rowsFor(table) {
      if (table === 'form_submission') return state.submissions;
      if (table.endsWith('membership_history')) {
        return state.histories.filter((row) => row.table === table || !row.table);
      }
      if (table === 'member') return state.members;
      if (table === 'organization') return state.organizations;
      if (table === 'member_note' || table === 'organization_note') return state.notes;
      return [];
    },
    async rpc(name, args) {
      db.rpcCalls.push({ name, args: clone(args) });
      if (name === 'merge_form_membership_result') {
        const submission = state.submissions.find((row) => row.id === args.p_submission_id
          && row.tenant_id === args.p_tenant_id);
        if (!submission) {
          return { data: { ok: false, code: 'SUBMISSION_NOT_FOUND' }, error: null };
        }
        const current = clone(submission.payment_meta?.membership_result || {});
        const override = await onMerge?.({ db, args, current: clone(current) });
        if (override) return override;
        const expected = args.p_expected || {};
        const expectedMatches = Object.entries(expected).every(([key, value]) => (
          (current[key] === undefined ? null : current[key]) === value
          || (current[key] !== undefined && JSON.stringify(current[key]) === JSON.stringify(value))
        ));
        if (!expectedMatches) {
          return {
            data: { ok: false, code: 'PROGRESS_CHANGED', membership_result: current },
            error: null,
          };
        }
        submission.payment_meta = {
          ...(submission.payment_meta || {}),
          membership_result: {
            ...current,
            ...(args.p_patch || {}),
            updated_at: 'fake-updated-at',
          },
        };
        return {
          data: {
            ok: true,
            membership_result: clone(submission.payment_meta.membership_result),
          },
          error: null,
        };
      }
      if (name === 'link_recovered_form_membership_invoice') {
        const submission = state.submissions.find((row) => row.id === args.p_submission_id
          && row.tenant_id === args.p_tenant_id);
        const history = state.histories.find((row) => row.id === args.p_history_id
          && row.tenant_id === args.p_tenant_id);
        const current = submission?.payment_meta?.membership_result || {};
        if (!submission || !history || current.invoice_state !== 'processing'
            || current.invoice_claimed_at !== args.p_expected_claimed_at
            || current.history_id !== args.p_history_id
            || current.accounting_provider !== args.p_provider
            || JSON.stringify(current.provider_context) !== JSON.stringify(args.p_provider_context)) {
          return { data: { ok: false, code: 'PROGRESS_CHANGED' }, error: null };
        }
        Object.assign(history, {
          accounting_provider: args.p_provider,
          accounting_invoice_id: args.p_invoice_id,
          accounting_invoice_number: args.p_invoice_number,
          ...(args.p_provider === 'xero' ? {
            xero_invoice_id: args.p_invoice_id,
            xero_invoice_number: args.p_invoice_number,
          } : {}),
        });
        submission.payment_meta.membership_result = {
          ...current,
          invoice_state: 'done',
          invoice_number: args.p_invoice_number,
          settlement_state: 'pending',
          updated_at: 'fake-updated-at',
        };
        return {
          data: {
            ok: true,
            membership_result: clone(submission.payment_meta.membership_result),
          },
          error: null,
        };
      }
      throw new Error(`unsupported fake RPC ${name}`);
    },
  };
  return db;
}

function contextFor(provider) {
  return provider === 'xero'
    ? { xero_tenant_id: 'xero-company-1' }
    : { quickbooks_realm_id: 'qbo-realm-1', environment: 'sandbox' };
}

function makeProvider(providerName, {
  rawContext = false,
  invoiceId = 'invoice-1',
  invoiceNumber = 'INV-1',
  invoiceOverrides = {},
  settle = null,
} = {}) {
  const providerContext = contextFor(providerName);
  const calls = { create: [], settle: [] };
  const provider = {
    name: providerName,
    calls,
    async getRawAccessToken() {
      return providerName === 'xero'
        ? { tenantId: 'xero-company-1' }
        : { realmId: 'qbo-realm-1', environment: 'sandbox' };
    },
    async createMembershipInvoice(args) {
      calls.create.push(args);
      return {
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        provider: providerName,
        ...(rawContext ? { raw: { provider_context: providerContext } }
          : { providerContext }),
        ...invoiceOverrides,
      };
    },
    async settleFormStripeInvoice(args) {
      calls.settle.push(args);
      return settle ? settle(args) : {
        settlement_state: 'done',
        payment_recorded: true,
        annotation_recorded: true,
        provider_context: providerContext,
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        balance: 0,
        account: 'Stripe Clearing',
      };
    },
  };
  return provider;
}

function successfulIntent() {
  return {
    paymentIntent: {
      id: PAYMENT_REFERENCE,
      status: 'succeeded',
      amount_received: 10000,
      currency: 'gbp',
      metadata: {
        type: 'form_payment',
        tenant_id: TENANT_ID,
        form_id: 'form-1',
        form_submission_id: SUBMISSION_ID,
      },
    },
  };
}

function realSettlement(db, provider, { retrieve = successfulIntent } = {}) {
  return (args) => settleFormStripeInvoice({
    ...args,
    dryRun: false,
    retrievePaymentIntent: async () => retrieve(),
    getProvider: async () => provider,
  });
}

function simpleSettlement(db, { state = 'done' } = {}) {
  return async ({ submissionId, tenantId }) => {
    if (state !== 'done') return { settlement_state: state, error: 'settlement still processing' };
    const current = db.getSubmission().payment_meta.membership_result;
    const claimedAt = 'settlement-claim';
    await db.rpc('merge_form_membership_result', {
      p_tenant_id: tenantId,
      p_submission_id: submissionId,
      p_expected: { settlement_state: current.settlement_state },
      p_patch: { settlement_state: 'processing', settlement_claimed_at: claimedAt },
    });
    await db.rpc('merge_form_membership_result', {
      p_tenant_id: tenantId,
      p_submission_id: submissionId,
      p_expected: { settlement_state: 'processing', settlement_claimed_at: claimedAt },
      p_patch: {
        settlement_state: 'done',
        payment_state: 'done',
        annotation_state: 'done',
        settlement_error: null,
        accounting_error: null,
      },
    });
    return { settlement_state: 'done' };
  };
}

function linkedHistory({
  provider = 'xero',
  invoiceId = 'invoice-1',
  invoiceNumber = 'INV-1',
} = {}) {
  return {
    id: 'history-1',
    tenant_id: TENANT_ID,
    table: 'member_membership_history',
    member_id: 'member-1',
    membership_year: '2027',
    config_id: 'config-1',
    payment_method: 'stripe',
    payment_status: 'paid',
    paid_at: '2027-01-15T12:00:00.000Z',
    stripe_payment_intent_id: PAYMENT_REFERENCE,
    billing_agreement_id: null,
    accounting_provider: provider,
    accounting_invoice_id: invoiceId,
    accounting_invoice_number: invoiceNumber,
    ...(provider === 'xero' ? {
      xero_invoice_id: invoiceId,
      xero_invoice_number: invoiceNumber,
    } : {}),
  };
}

for (const spec of [
  { name: 'Xero', provider: 'xero', rawContext: false },
  { name: 'QuickBooks', provider: 'quickbooks', rawContext: true },
]) {
  test(`finalizer completes a successful ${spec.name} invoice and Stripe settlement`, async () => {
    const db = makeDb(fixture({ provider: spec.provider }));
    const provider = makeProvider(spec.provider, { rawContext: spec.rawContext });
    const workflowCalls = [];
    const result = await finalizeFormMembership(
      { supabase: db, submission: db.getSubmission(), baseUrl: 'https://app.test' },
      {
        getAccountingProvider: async () => provider,
        getConfigByIdDirect: async () => ({}),
        settleFormStripeInvoice: realSettlement(db, provider),
        fireWorkflowForPaidRow: async (args) => workflowCalls.push(args),
      },
    );

    assert.equal(result.invoiceState, 'done');
    assert.equal(result.settlementState, 'done');
    assert.equal(result.workflowState, 'done');
    assert.equal(provider.calls.create.length, 1);
    assert.equal(provider.calls.settle.length, 1);
    assert.equal(workflowCalls.length, 1);
    assert.equal(db.historyRows().length, 1);
    const history = db.historyRows()[0];
    assert.equal(history.accounting_provider, spec.provider);
    assert.equal(history.accounting_invoice_id, 'invoice-1');
    assert.equal(db.getSubmission().payment_meta.membership_result.accounting_error, null);
    assert.deepEqual(
      db.getSubmission().payment_meta.membership_result.provider_context,
      contextFor(spec.provider),
    );
    if (spec.provider === 'quickbooks') {
      assert.equal(history.xero_invoice_id, undefined);
    }
  });
}

test('a retry with a pinned provider resolves through getAccountingProviderByName', async () => {
  const provider = makeProvider('xero');
  const db = makeDb(fixture({
    progress: {
      status: 'created',
      history_id: 'history-1',
      table: 'member_membership_history',
      entity_id: 'member-1',
      invoice_state: 'retry',
      invoice_attempts: 1,
      accounting_provider: 'xero',
      provider_context: contextFor('xero'),
      settlement_state: 'pending',
      workflow_state: 'done',
    },
    histories: [linkedHistory({ invoiceId: null, invoiceNumber: null })],
  }));
  const providerLookups = [];
  const result = await finalizeFormMembership(
    { supabase: db, submission: db.getSubmission() },
    {
      getAccountingProvider: async () => {
        throw new Error('un-pinned provider lookup must not be used');
      },
      getAccountingProviderByName: (name) => {
        providerLookups.push(name);
        return provider;
      },
      getConfigByIdDirect: async () => ({}),
      settleFormStripeInvoice: simpleSettlement(db),
      fireWorkflowForPaidRow: async () => {},
    },
  );

  assert.deepEqual(providerLookups, ['xero']);
  assert.equal(result.invoiceState, 'done');
  assert.equal(provider.calls.create.length, 1);
  assert.equal(db.historyRows()[0].accounting_invoice_id, 'invoice-1');
});

test('raw and direct provider context mismatches, and missing invoice ids, never link an invoice', async () => {
  for (const scenario of [
    {
      name: 'mismatched provider context',
      providerOptions: {
        invoiceOverrides: {
          providerContext: { xero_tenant_id: 'wrong-company' },
          raw: { provider_context: { xero_tenant_id: 'wrong-company' } },
        },
      },
      expectedError: /unexpected provider company context/,
    },
    {
      name: 'missing invoice id',
      providerOptions: { invoiceId: null, invoiceNumber: null },
      expectedError: /did not return an invoice id/,
    },
  ]) {
    const db = makeDb(fixture());
    const provider = makeProvider('xero', scenario.providerOptions);
    const result = await finalizeFormMembership(
      { supabase: db, submission: db.getSubmission() },
      {
        getAccountingProvider: async () => provider,
        getConfigByIdDirect: async () => ({}),
        fireWorkflowForPaidRow: async () => {},
      },
    );
    assert.equal(result.invoiceState, 'processing', scenario.name);
    assert.equal(provider.calls.create.length, 1);
    assert.equal(db.historyRows()[0].accounting_invoice_id, undefined, scenario.name);
    assert.match(
      db.getSubmission().payment_meta.membership_result.accounting_error,
      scenario.expectedError,
      scenario.name,
    );
  }
});

test('provider preparation errors are durable and do not create an invoice', async () => {
  const db = makeDb(fixture());
  let workflowCalls = 0;
  const result = await finalizeFormMembership(
    { supabase: db, submission: db.getSubmission() },
    {
      getAccountingProvider: async () => {
        throw new Error('provider token is unavailable');
      },
      fireWorkflowForPaidRow: async () => { workflowCalls += 1; },
    },
  );

  assert.equal(result.invoiceState, 'retry');
  assert.equal(workflowCalls, 1);
  assert.equal(db.historyRows()[0].accounting_sync_status, 'failed');
  assert.equal(db.getSubmission().payment_meta.membership_result.accounting_error, 'provider token is unavailable');
  assert.match(db.getSubmission().processing_notes, /provider preparation failed/);
  assert.equal(db.rpcCalls.some((call) => call.args.p_patch?.invoice_state === 'processing'), false);
});

test('an invoice claim lost by CAS cannot create an invoice or dispatch its workflow', async () => {
  const db = makeDb(fixture(), {
    onMerge: ({ args, current }) => {
      if (args.p_patch?.invoice_state === 'processing'
          || args.p_patch?.workflow_state === 'claimed') {
        return {
          data: { ok: false, code: 'PROGRESS_CHANGED', membership_result: current },
          error: null,
        };
      }
      return null;
    },
  });
  const provider = makeProvider('xero');
  let workflowCalls = 0;
  const result = await finalizeFormMembership(
    { supabase: db, submission: db.getSubmission() },
    {
      getAccountingProvider: async () => provider,
      getConfigByIdDirect: async () => ({}),
      fireWorkflowForPaidRow: async () => { workflowCalls += 1; },
    },
  );

  assert.equal(result.invoiceState, 'pending');
  assert.equal(result.workflowState, 'pending');
  assert.equal(provider.calls.create.length, 0);
  assert.equal(workflowCalls, 0);
  assert.equal(db.historyRows().length, 1, 'history is stamped before the lost side-effect claim');
  assert.equal(
    db.rpcCalls.filter((call) => call.args.p_patch?.invoice_state === 'processing').length,
    1,
  );
});

test('partial invoice linkage survives a progress RPC failure and retry without duplicates', async () => {
  let failedInvoiceDoneRpc = false;
  const db = makeDb(fixture(), {
    onMerge: ({ args }) => {
      if (args.p_patch?.invoice_state === 'done' && !failedInvoiceDoneRpc) {
        failedInvoiceDoneRpc = true;
        throw new Error('progress RPC temporarily unavailable');
      }
      return null;
    },
  });
  const provider = makeProvider('xero');
  let workflowCalls = 0;
  const deps = {
    getAccountingProvider: async () => provider,
    getConfigByIdDirect: async () => ({}),
    settleFormStripeInvoice: simpleSettlement(db),
    fireWorkflowForPaidRow: async () => { workflowCalls += 1; },
  };

  const first = await finalizeFormMembership(
    { supabase: db, submission: db.getSubmission() },
    deps,
  );
  assert.equal(first.invoiceState, 'processing');
  assert.equal(provider.calls.create.length, 1);
  assert.equal(workflowCalls, 1);
  assert.equal(db.historyRows().length, 1);
  assert.equal(db.historyRows()[0].accounting_invoice_id, 'invoice-1');
  assert.equal(failedInvoiceDoneRpc, true);

  const second = await finalizeFormMembership(
    { supabase: db, submission: db.getSubmission() },
    deps,
  );
  assert.equal(second.invoiceState, 'done');
  assert.equal(second.settlementState, 'done');
  assert.equal(provider.calls.create.length, 1, 'retry must not create a second invoice');
  assert.equal(db.historyRows().length, 1, 'retry must not create a second history row');
  assert.equal(workflowCalls, 1, 'retry must not dispatch a second workflow');
});

for (const settlementState of ['done', 'processing']) {
  test(`linked invoice recovery preserves settlement ${settlementState} state`, async () => {
    const context = contextFor('xero');
    const progress = {
      status: 'created',
      history_id: 'history-1',
      table: 'member_membership_history',
      entity_id: 'member-1',
      invoice_state: 'processing',
      invoice_claimed_at: '2027-01-01T00:00:00.000Z',
      accounting_provider: 'xero',
      provider_context: context,
      settlement_state: settlementState,
      ...(settlementState === 'processing' ? {
        settlement_claimed_at: new Date().toISOString(),
      } : {}),
      workflow_state: 'done',
    };
    const db = makeDb(fixture({
      progress,
      histories: [linkedHistory()],
    }));
    let settlementCalls = 0;
    const result = await finalizeFormMembership(
      { supabase: db, submission: db.getSubmission() },
      {
        settleFormStripeInvoice: async () => {
          settlementCalls += 1;
          return { settlement_state: settlementState };
        },
        fireWorkflowForPaidRow: async () => {},
      },
    );

    assert.equal(result.invoiceState, 'done');
    assert.equal(db.getSubmission().payment_meta.membership_result.settlement_state, settlementState);
    assert.equal(settlementCalls, settlementState === 'done' ? 0 : 1);
    assert.equal(db.historyRows()[0].accounting_invoice_id, 'invoice-1');
  });
}

test('bank settlement errors remain retryable after the invoice has been linked', async () => {
  const db = makeDb(fixture());
  const provider = makeProvider('xero', {
    settle: async () => {
      throw new Error('bank settlement account is unavailable');
    },
  });
  let workflowCalls = 0;
  const result = await finalizeFormMembership(
    { supabase: db, submission: db.getSubmission() },
    {
      getAccountingProvider: async () => provider,
      getConfigByIdDirect: async () => ({}),
      settleFormStripeInvoice: realSettlement(db, provider),
      fireWorkflowForPaidRow: async () => { workflowCalls += 1; },
    },
  );

  assert.equal(result.invoiceState, 'done');
  assert.equal(workflowCalls, 1);
  assert.equal(db.getSubmission().payment_meta.membership_result.settlement_state, 'retry');
  assert.equal(db.historyRows()[0].accounting_sync_status, 'failed');
  assert.match(db.getSubmission().processing_notes, /settlement did not complete/);
});

for (const note of [
  'Payment succeeded and the membership was created, but the accounting invoice step failed: old failure.',
  'An unrelated admin note must remain intact.',
]) {
  test(`successful settlement ${note.startsWith('Payment') ? 'clears' : 'preserves'} processing notes`, async () => {
    const db = makeDb(fixture({ processing_notes: note }));
    const provider = makeProvider('xero');
    await finalizeFormMembership(
      { supabase: db, submission: db.getSubmission() },
      {
        getAccountingProvider: async () => provider,
        getConfigByIdDirect: async () => ({}),
        settleFormStripeInvoice: realSettlement(db, provider),
        fireWorkflowForPaidRow: async () => {},
      },
    );
    assert.equal(
      db.getSubmission().processing_notes,
      note.startsWith('Payment') ? null : note,
    );
  });
}

test('only definitive create rejections are safely recreated after a fresh claim', () => {
  assert.equal(isDefinitiveInvoiceCreateRejection({ status: 400 }), true);
  assert.equal(isDefinitiveInvoiceCreateRejection({ response: { status: 422 } }), true);
  assert.equal(isDefinitiveInvoiceCreateRejection({ statusCode: 408 }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection({ status: 409 }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection({ response: { status: 429 } }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection({ code: 'ETIMEDOUT' }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection(new Error('socket closed')), false);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSucceededMembershipPaymentIntent, reconcileRow } from './membershipPaymentReconciliation.js';
import { buildRollingCommitment } from './rollingMembershipCommitment.js';
import { completeReminderFeeAccounting } from './reminderFeeAccounting.js';

function fixture({ method = 'invoice', startDate = '2099-09-15', member = true } = {}) {
  const commitment = buildRollingCommitment({
    config: { id: 'tier-a', start_mode: 'immediate', billing_period: 'annual', currency: 'GBP' },
    startDate, paymentMethod: method, paymentFrequency: 'upfront',
    amounts: { annual_cost: 240, final_cost: 240, vat_amount: 48, total_with_vat: 288, currency: 'GBP' },
  });
  const owner = member ? { member_id: 'owner-a' } : { organization_id: 'owner-a' };
  const token = {
    id: 'token-a', tenant_id: 'tenant-a', ...owner,
    membership_year: commitment.term_key, status: 'pending',
    final_cost: 240, currency: 'GBP', cost_breakdown: { commitment, totalWithVat: 288, vatAmount: 48 },
  };
  const pi = {
    id: 'pi-a', status: 'succeeded', amount: 28800, currency: 'gbp',
    metadata: { tenant_id: 'tenant-a', ...owner, membership_year: commitment.term_key, token_id: token.id },
  };
  return { commitment, token, pi, owner, table: member ? 'member_membership_history' : 'organisation_membership_history' };
}
function database(f, existing = []) {
  const tables = {
    membership_fee_token: [structuredClone(f.token)],
    [f.table]: structuredClone(existing),
    member: [{ id: 'owner-a', tenant_id: 'tenant-a' }],
    organization: [{ id: 'owner-a', tenant_id: 'tenant-a' }],
  };
  const writes = [];
  return {
    tables, writes,
    from(table) {
      tables[table] ||= [];
      const predicates = [];
      let insert, update;
      function execute(single = false) {
        let data = tables[table].filter(row => predicates.every(predicate => predicate(row)));
        if (insert) {
          const row = { id: `new-${table}`, created_at: new Date().toISOString(), ...structuredClone(insert) };
          tables[table].push(row);
          writes.push({ table, insert: row });
          data = [row];
        } else if (update) {
          for (const row of data) Object.assign(row, structuredClone(update));
          writes.push({ table, update: structuredClone(update) });
        }
        return { data: structuredClone(single ? data[0] || null : data), error: null };
      }
      return {
        select() { return this; },
        eq(key, value) { predicates.push(row => row[key] === value); return this; },
        neq(key, value) { predicates.push(row => row[key] !== value); return this; },
        or() { return this; },
        insert(row) { insert = row; return this; },
        update(row) { update = row; return this; },
        async maybeSingle() { return execute(true); },
        async single() { return execute(true); },
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      };
    },
  };
}

for (const member of [true, false]) {
  test(`${member ? 'member' : 'organisation'} fee-token reconciliation restores frozen commitment, not callback date`, async () => {
    const f = fixture({ member });
    const db = database(f);
    let fired = 0;
    const deps = { db, fireWorkflow: async () => { fired++; return { fired: true }; } };
    const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, deps);
    assert.equal(result.status, 'recorded');
    const row = db.tables[f.table][0];
    assert.equal(row.term_start_date, '2099-09-15');
    assert.equal(row.membership_renewal_date, '2100-09-15');
    assert.equal(row.status, 'scheduled');
    assert.equal(row.scheduled_activation_date, '2099-09-15');
    assert.equal(row.payment_status, 'paid');
    assert.equal(row.payment_method, 'invoice');
    assert.equal(row.stripe_payment_intent_id, 'pi-a');
    assert.equal(row.final_cost, 240);
    assert.equal(row.vat_amount, 48);
    assert.equal(row.total_with_vat, 288);
    const replay = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, deps);
    assert.equal(replay.status, 'already-recorded');
    assert.equal(db.tables[f.table].length, 1);
    assert.equal(fired, 1);
  });
}

test('upfront reserved invoice settles without changing immutable agreed method', async () => {
  const f = fixture({ startDate: '2020-09-15' });
  const existing = {
    id: 'history-a', ...f.commitment, ...f.owner, tenant_id: 'tenant-a',
    membership_year: f.commitment.term_key, payment_method: 'invoice',
    payment_status: 'unpaid', status: 'pending_payment_setup', total_with_vat: 288, currency: 'GBP',
  };
  const db = database(f, [existing]);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, {
    db, fireWorkflow: async () => ({ fired: true }),
  });
  assert.equal(result.status, 'recorded');
  assert.equal(db.tables[f.table][0].payment_method, 'invoice');
  assert.equal(db.tables[f.table][0].status, 'active');
});

test('a charged payment with mismatched amount cannot activate or reprice a commitment', async () => {
  const f = fixture();
  f.pi.amount = 30000;
  const db = database(f);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, {
    db, fireWorkflow: async () => { throw new Error('must not fire'); },
  });
  assert.equal(result.status, 'conflict');
  assert.equal(db.writes.length, 0);
});

test('legacy rolling payment without evidence is reported, never guessed from payment time', async () => {
  const f = fixture();
  delete f.token.cost_breakdown.commitment;
  const db = database(f);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, { db });
  assert.equal(result.status, 'unmatched');
  assert.match(result.detail, /no (?:authoritative )?saved membership|no saved commitment/);
  assert.equal(db.writes.length, 0);
});

test('fee token pointing to another owner is not allowed to redirect settlement', async () => {
  const f = fixture();
  f.token.member_id = 'another-member';
  const db = database(f);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, { db });
  assert.equal(result.status, 'conflict');
  assert.equal(db.writes.length, 0);
});

for (const member of [true, false]) for (const provider of ['quickbooks', 'xero']) {
  test(`${provider} ${member ? 'member' : 'org'} linked invoice retry preserves identity, dates and one paid workflow`, async () => {
    const f = fixture({ member });
    f.token.history_record_id = 'history-a';
    // Legacy tokens can contain a QBO ID under xero_invoice_id.
    f.token.xero_invoice_id = 'invoice-a';
    const row = { id: 'history-a', ...f.commitment, ...f.owner, tenant_id: 'tenant-a',
      membership_year: f.token.membership_year, payment_status: 'unpaid', total_with_vat: 288,
      currency: 'GBP', accounting_provider: provider, accounting_invoice_id: 'invoice-a' };
    const db = database(f, [row]);
    let attempts = 0, workflows = 0;
    const deps = { db, fireWorkflow: async () => { workflows++; return { fired: true }; },
      applyPayment: async ({ invoiceReference }) => {
        assert.equal(invoiceReference.provider, provider);
        assert.equal(invoiceReference.invoiceId, 'invoice-a');
        attempts++;
        if (attempts === 1) throw new Error('temporary provider failure');
        return { payment_recorded: true };
      } };
    const run = () => recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, deps);
    assert.equal((await run()).status, 'accounting-pending');
    assert.equal(db.tables[f.table][0].status, 'scheduled');
    assert.equal((await run()).status, 'recorded');
    assert.equal((await run()).status, 'already-recorded');
    assert.equal(workflows, 1);
    assert.equal(attempts, 2);
    assert.equal(db.tables[f.table].length, 1);
    assert.equal(db.tables[f.table][0].accounting_sync_status, null);
    if (provider === 'quickbooks') assert.equal(db.tables[f.table][0].xero_invoice_id, undefined);
  });
}

test('invoice polling does not activate an early fixed-year renewal or undo a paid callback', async () => {
  const f = fixture();
  const row = { id: 'history-a', tenant_id: 'tenant-a', ...f.owner,
    accounting_provider: 'quickbooks', accounting_invoice_id: 'invoice-a',
    term_start_date: '2099-01-01', term_end_date: '2099-12-31', payment_status: 'unpaid' };
  const db = database(f, [row]);
  let fired = 0;
  await reconcileRow({ table: f.table, row }, { db,
    fetchStatus: async () => ({ status: 'paid', paidAt: '2026-01-01' }),
    fireWorkflow: async () => { fired++; } });
  assert.equal(db.tables[f.table][0].status, 'scheduled');
  assert.equal(db.tables[f.table][0].scheduled_activation_date, '2099-01-01');
  await reconcileRow({ table: f.table, row: db.tables[f.table][0] }, { db,
    fetchStatus: async () => { throw new Error('paid row should not be polled'); } });
  assert.equal(fired, 1);
});

for (const member of [true, false]) for (const providerName of ['quickbooks', 'xero']) {
  for (const first of ['stripe_membership_webhook', 'public_fee_confirm']) {
    test(`${providerName} ${member ? 'member' : 'org'} new reminder invoice ${first} first creates and settles once`, async () => {
      const f = fixture({ member });
      f.token.cost_breakdown.renewalQuote = {
        config: { id: 'tier-a', billing_period: 'annual' },
        membershipYear: { label: f.token.membership_year, start: '2099-09-15', end: '2100-09-14' },
      };
      const db = database(f);
      db.tables[member ? 'member' : 'organization'][0].name = 'Invoice owner';
      let creates = 0, applies = 0, workflow = 0;
      const provider = { name: providerName,
        createMembershipInvoice: async args => {
          creates++;
          assert.equal(args.finalCost, 240);
          assert.equal(args.deferStripeSettlement, true);
          assert.equal(args.markAsPaid, false);
          assert.ok(args.idempotencyKey);
          return { invoiceId: 'new-invoice', invoiceNumber: 'RENEW-1' };
        },
        applyStripePaymentToInvoice: async args => {
          applies++;
          assert.equal(args.invoiceId, 'new-invoice');
          assert.ok(args.idempotencyKey);
          return { invoice_id: 'new-invoice', payment_recorded: true };
        } };
      const deps = { db, fireWorkflow: async () => { workflow++; return { fired: true }; },
        completeReminderAccounting: args => completeReminderFeeAccounting(args, {
          getProvider: async () => provider, getProviderByName: name => {
            assert.equal(name, providerName); return provider;
          },
        }) };
      assert.equal((await recordSucceededMembershipPaymentIntent({
        tenantId: 'tenant-a', paymentIntent: f.pi, source: first,
      }, deps)).status, 'recorded');
      assert.equal((await recordSucceededMembershipPaymentIntent({
        tenantId: 'tenant-a', paymentIntent: f.pi,
        source: first === 'public_fee_confirm' ? 'stripe_membership_webhook' : 'public_fee_confirm',
      }, deps)).status, 'already-recorded');
      assert.equal(creates, 1);
      assert.equal(applies, 1);
      assert.equal(workflow, 1);
      assert.equal(db.tables[f.table][0].status, 'scheduled');
      assert.equal(db.tables[f.table][0].accounting_provider, providerName);
      assert.equal(db.tables.membership_fee_token[0].accounting_invoice_id, 'new-invoice');
    });
  }
}

for (const member of [true, false]) for (const failure of ['owner', 'address']) {
  test(`${member ? 'member' : 'organisation'} transient ${failure} preflight failure retries creation without stranding a claim`, async () => {
    const f = fixture({ member });
    f.token.cost_breakdown.renewalQuote = {
      config: { id: 'tier-a' },
      membershipYear: { label: f.token.membership_year, start: '2099-09-15', end: '2100-09-14' },
    };
    const db = database(f);
    const ownerTable = member ? 'member' : 'organization';
    let failPreflight = true, creates = 0, applies = 0, workflows = 0;
    const owner = { ...db.tables[ownerTable][0], name: 'Owner' };
    const provider = {
      name: 'quickbooks',
      createMembershipInvoice: async args => {
        creates++;
        assert.equal(db.tables.membership_reminder_accounting.length, 1);
        assert.equal(args.invoicingAddress, 'Saved invoice address');
        return { invoice_id: 'retry-invoice' };
      },
      findFormStripeInvoice: async () => { assert.fail('Preflight failure must not enter discovery-only recovery'); },
      applyStripePaymentToInvoice: async () => { applies++; return { payment_recorded: true }; },
    };
    const deps = { db, fireWorkflow: async () => { workflows++; return { fired: true }; },
      completeReminderAccounting: async args => {
        // Ownership validation already succeeded; model a transient local
        // lookup failure specifically in accounting's owner-data preflight.
        if (failure === 'owner' && failPreflight) db.tables[ownerTable] = [];
        try {
          return await completeReminderFeeAccounting(args, {
            getProvider: async () => provider,
            getProviderByName: () => provider,
            resolveInvoiceAddress: async () => {
              assert.equal(db.tables.membership_reminder_accounting.length, 0, 'Address resolution must precede the creation claim');
              if (failure === 'address' && failPreflight) throw new Error('Transient address lookup failure');
              return 'Saved invoice address';
            },
          });
        } finally { db.tables[ownerTable] = [owner]; }
      } };
    const run = () => recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, deps);
    assert.equal((await run()).status, 'accounting-pending');
    assert.equal(creates, 0);
    assert.equal(applies, 0);
    assert.equal(db.tables.membership_reminder_accounting.length, 0, 'Known-not-attempted preflight must leave no durable claim');
    failPreflight = false;
    db.tables[ownerTable] = [owner];
    assert.equal((await run()).status, 'recorded');
    assert.equal((await run()).status, 'already-recorded');
    assert.equal(creates, 1);
    assert.equal(applies, 1);
    assert.equal(workflows, 1);
    assert.equal(db.tables[f.table][0].accounting_invoice_id, 'retry-invoice');
  });
}

test('ambiguous invoice create is discovered through its pinned provider, never created twice', async () => {
  const f = fixture();
  f.token.cost_breakdown.renewalQuote = {
    config: { id: 'tier-a' },
    membershipYear: { label: f.token.membership_year, start: '2099-09-15', end: '2100-09-14' },
  };
  const db = database(f);
  db.tables.member[0].name = 'Owner';
  let creates = 0, discovers = 0, applies = 0;
  const provider = { name: 'quickbooks',
    createMembershipInvoice: async () => { creates++; throw new Error('response lost after remote create'); },
    findFormStripeInvoice: async args => {
      discovers++; assert.equal(args.stripePaymentIntentId, f.pi.id);
      assert.ok(args.createdAfter);
      if (discovers === 1) return null; // Provider search can lag a completed create.
      return { invoice_id: 'recovered-invoice' };
    },
    applyStripePaymentToInvoice: async () => { applies++; return { payment_recorded: true }; },
  };
  const deps = { db, fireWorkflow: async () => ({ fired: true }),
    completeReminderAccounting: args => completeReminderFeeAccounting(args, {
      getProvider: async () => provider,
      getProviderByName: name => { assert.equal(name, 'quickbooks'); return provider; },
    }) };
  const run = () => recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, deps);
  assert.equal((await run()).status, 'accounting-pending');
  assert.equal(db.tables.membership_reminder_accounting.length, 1);
  assert.equal((await run()).status, 'accounting-pending');
  assert.equal(creates, 1, 'An empty discovery result is not permission to repeat an ambiguous create');
  assert.equal(applies, 0);
  assert.equal((await run()).status, 'recorded');
  assert.equal((await run()).status, 'already-recorded');
  assert.equal(creates, 1);
  assert.equal(discovers, 2);
  assert.equal(applies, 1);
});
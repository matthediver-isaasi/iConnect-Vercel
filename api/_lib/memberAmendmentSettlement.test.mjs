import test from 'node:test';
import assert from 'node:assert/strict';
import { amendmentFixture, uuid } from '../../scripts/test-support/member-amendment-fixtures.mjs';
import { buildMemberAmendmentQuote } from './memberAmendmentQuote.js';
import { amendmentMoney, amendmentMinor, createMemberAmendmentFinance } from './memberAmendmentFinance.js';
test('accounting transport exposes only definitive throttling as retryable',async()=>{
 for(const [status,header,expected] of [[429,'90',90],[429,'invalid',60],[429,'9999999',86400],[500,'90',null]]){
  const finance=createMemberAmendmentFinance({
   providerForTenant:async()=>({name:'xero',getRawAccessToken:async()=>({accessToken:'fixture',tenantId:'books'})}),
   fetcher:async()=>({ok:false,status,headers:{get:()=>header}}),
  });
  await assert.rejects(finance.verifyCreditLiability('tenant',{accountCode:'850',currency:'GBP'}),error=>{
   assert.equal(error.status,status===429?429:502);
   assert.equal(error.retryAfter,expected??undefined);
   return true;
  });
 }
});
import { createMemberAmendmentSettlementService, resolveMemberAmendmentOverlay, runMemberAmendmentRecovery } from './memberAmendmentSettlement.js';
import { createMemberAmendmentRecoveryHandler } from '../cron/member-amendments.js';

function financeFixture({ credit = false } = {}) {
  const f = amendmentFixture();
  f.current.xero_invoice_id = uuid(61);
  f.current.stripe_payment_intent_id = 'pi_isolated_original';
  if (credit) f.config.flat_cost = 50;
  const q = buildMemberAmendmentQuote({ ...f, effectiveDate: f.today, quotedAt: f.quotedAt });
  const a = { id: uuid(60), tenant_id: f.tenantId, member_id: f.memberId, quote: q };
  const invoice = {
    InvoiceID: f.current.xero_invoice_id, Type: 'ACCREC', Status: 'PAID',
    Contact: { ContactID: uuid(62), EmailAddress: 'original-payer@example.invalid' }, CurrencyCode: 'GBP',
    SubTotal: 100, TotalTax: 0, Total: 100, AmountPaid: 100, AmountCredited: 0, AmountDue: 0,
    LineItems: [{ AccountCode: '200', TaxType: 'NONE' }], Payments: [{ PaymentID: uuid(63) }],
  };
  const payments = {
    [uuid(63)]: { PaymentID: uuid(63), Invoice: { InvoiceID: invoice.InvoiceID }, Status: 'AUTHORISED', Account: { AccountID: uuid(64) }, Amount: 100 },
  };
  const bankAccounts=[{AccountID:uuid(64),Type:'BANK'}];
  const calls = [];
  const documents = [];
  const makeDoc = (args, isCredit = false) => ({
    ...(isCredit ? { CreditNoteID: uuid(65), RemainingCredit: args.grossMinor / 100 } : {
      InvoiceID: uuid(65), AmountDue: args.grossMinor / 100, AmountPaid: 0, AmountCredited: 0,
    }),
    Type: isCredit ? 'ACCRECCREDIT' : 'ACCREC', Status: 'AUTHORISED',
    Reference: `MA:${a.id}`, Contact: invoice.Contact, CurrencyCode: 'GBP',
    SubTotal: args.netMinor / 100, TotalTax: args.taxMinor / 100, Total: args.grossMinor / 100,
    LineItems: [{ AccountCode: '200', TaxType: invoice.LineItems[0].TaxType }], Payments: [], Allocations: [],
  });
  const provider = {
    name: 'xero', getRawAccessToken: async () => ({ accessToken: 'isolated-fixture-token', tenantId: uuid(66) }),
    async createSalesInvoice(tenant, args) {
      assert.equal(tenant, a.tenant_id);
      calls.push({ kind: 'createInvoice', args });
      documents.push(makeDoc(args));
      return { id: uuid(65) };
    },
  };
  const fetcher = async (url, options) => {
    const pathname = new URL(url).pathname.split('/2.0/')[1];
    calls.push({ path: pathname, method: options.method, body: options.body, key: options.headers['Idempotency-Key'] });
    let body;
    if (pathname === `Invoices/${invoice.InvoiceID}`) body = { Invoices: [invoice] };
    else if(pathname==='Accounts')body={Accounts:bankAccounts};
    else if (pathname.startsWith('Payments/')) body = { Payments: [payments[pathname.split('/')[1]]] };
    else if(pathname==='Payments'){
      const where=new URL(url).searchParams.get('where');
      body={Payments:Object.values(payments).filter(p=>where===`Reference==${JSON.stringify(p.Reference)}`)};
    }
    else if (pathname.endsWith('/OnlineInvoice')) body = { OnlineInvoices: [{ OnlineInvoiceUrl: 'https://invoice.example.invalid/pay' }] };
    else if (pathname === 'CreditNotes' && options.method === 'POST') {
      const payload = JSON.parse(options.body).CreditNotes[0];
      documents.push(makeDoc({ netMinor: payload.LineItems[0].UnitAmount * 100,
        taxMinor: payload.LineItems[0].TaxAmount * 100,
        grossMinor: (payload.LineItems[0].UnitAmount + payload.LineItems[0].TaxAmount) * 100 }, true));
      body = { CreditNotes: documents };
    } else if (pathname.startsWith('CreditNotes')) body = { CreditNotes: documents };
    else if (pathname.startsWith('Invoices')) body = { Invoices: documents };
    else throw new Error(`Unexpected isolated provider request ${pathname}`);
    return { ok: true, json: async () => structuredClone(body) };
  };
  const originalCard = { id: f.current.stripe_payment_intent_id, status: 'succeeded', currency: 'gbp',
    amount_received: 10000, latest_charge: 'ch_isolated_original', customer: 'cus_isolated_payer',
    metadata: { tenant_id: a.tenant_id, member_id: a.member_id } };
  const originalCharge = { id: 'ch_isolated_original', payment_intent: originalCard.id,
    paid: true, disputed: false, amount_refunded: 0, currency: 'gbp', amount: 10000, customer: 'cus_isolated_payer' };
  const finance = createMemberAmendmentFinance({ providerForTenant: async () => provider, fetcher,
    paymentIntentForTenant: async () => ({ paymentIntent: originalCard,
      stripe: { charges: { retrieve: async () => originalCharge } } }) });
  return { ...f, a, finance, invoice, payments, documents, calls, provider, makeDoc, originalCard, originalCharge,bankAccounts };
}

test('money validation rejects mixed-sign/tax-only and imprecise amounts; independent quoted VAT is retained', () => {
  assert.throws(() => amendmentMinor(1.001), /Exact/);
  assert.throws(() => amendmentMoney({ delta: { netMinor: 100, vatMinor: -10, grossMinor: 90 } }, 'collect'), /Mixed-sign/);
  assert.throws(() => amendmentMoney({ delta: { netMinor: 100, vatMinor: -100, grossMinor: 0 } }, 'none'), /Mixed-sign/);
  assert.deepEqual(amendmentMoney({ delta: { netMinor: -101, vatMinor: -21, grossMinor: -122 } }, 'credit'),
    { netMinor: 101, taxMinor: 21, grossMinor: 122 });
});

test('funding recovery is read-only and rejects absent or duplicate accounting payments',async()=>{
  const f=financeFixture();
  const context=await f.finance.prepare(f.a,'collect');
  const p=f.payments[uuid(63)];
  p.Reference='member-funding:isolated';
  const binding={providerTenantId:context.xeroTenantId,accountId:p.Account.AccountID};
  const entry={invoiceId:f.invoice.InvoiceID,reference:p.Reference,amountMinor:10000};
  const result=await f.finance.findCreditFundingPayment(f.tenantId,binding,entry);
  assert.equal(result.payment_id,p.PaymentID);
  f.payments[uuid(68)]={...p,PaymentID:uuid(68)};
  await assert.rejects(f.finance.findCreditFundingPayment(f.tenantId,binding,entry),/no single confirmed payment/);
  delete f.payments[uuid(63)];delete f.payments[uuid(68)];
  await assert.rejects(f.finance.findCreditFundingPayment(f.tenantId,binding,entry),/no single confirmed payment/);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('non-cash liability payments cannot become original cash settlement evidence',async()=>{
  const f=financeFixture();
  f.a.quote.sourceSnapshot.payment_method='invoice';
  f.bankAccounts[0].Type='CURRENTLIABILITY';
  await assert.rejects(f.finance.verifyOriginal(f.a),/not non-cash liability/);
});

test('source evidence reader verifies provider payments without creating accounting documents', async () => {
  const f = financeFixture();
  const proof = await f.finance.verifyOriginal(f.a);
  assert.equal(proof.sourceInvoiceId, f.invoice.InvoiceID);
  assert.equal(proof.originalPaidMinor, 10000);
  assert.deepEqual(proof.originalAmounts, f.a.quote.originalFullTerm);
  assert.deepEqual(proof.originalPaymentIds, [uuid(63)]);
  assert.equal(proof.contactId, f.invoice.Contact.ContactID);
  assert.equal(f.documents.length, 0);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  f.invoice.Status = 'AUTHORISED';
  await assert.rejects(f.finance.verifyOriginal(f.a), /fully paid/);
});

test('a confirmed funding fingerprint cannot silently use a new payer at settlement', async () => {
  const f = financeFixture();
  const original = await f.finance.verifyOriginal(f.a);
  f.a.quote.fundingEvidence = {
    provider: original.provider, providerTenantId: original.xeroTenantId,
    sourceInvoiceId: original.sourceInvoiceId, contactId: original.contactId,
    paymentIds: original.originalPaymentIds, paidMinor: original.originalPaidMinor,
    originalAmounts: original.originalAmounts,
  };
  await f.finance.prepare(f.a, 'collect');
  f.invoice.Contact.ContactID = uuid(91);
  await assert.rejects(f.finance.prepare(f.a, 'collect'), /funding changed since confirmation/);
  assert.equal(f.documents.length, 0);
});

test('a zero-price change verifies original payment at reservation and again before application', async () => {
  const f = financeFixture();
  f.a.quote.delta = { netMinor: 0, vatMinor: 0, grossMinor: 0 };
  const context = await f.finance.prepare(f.a, 'none');
  assert.equal(context.provider, 'none');
  assert.equal(context.sourceInvoiceId, f.invoice.InvoiceID);
  const settlement = { context, choice: 'none' };
  assert.equal((await f.finance.execute(f.a, settlement)).state, 'settled');
  assert.deepEqual((await f.finance.inspect(f.a, settlement)).evidence.originalPaymentIds, [uuid(63)]);
  assert.equal(f.documents.length, 0);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  f.originalCharge.amount_refunded = 1;
  await assert.rejects(f.finance.inspect(f.a, settlement), /refunds\/disputes/);
});

test('a zero-price change cannot rely on local paid status or skip invoice verification', async () => {
  for (const damage of [
    f => { f.invoice.AmountPaid = 0; },
    f => { f.payments[uuid(63)].Status = 'DELETED'; },
    f => { f.originalCard.status = 'requires_payment_method'; },
    f => { f.a.quote.sourceSnapshot.xero_invoice_id = null; },
    f => { f.a.quote.sourceSnapshot.billing_agreement_id = uuid(70); },
  ]) {
    const f = financeFixture();
    f.a.quote.delta = { netMinor: 0, vatMinor: 0, grossMinor: 0 };
    damage(f);
    await assert.rejects(f.finance.prepare(f.a, 'none'), { code: 'finance_evidence_required' });
    assert.equal(f.documents.length, 0);
  }
});

test('zero-price reconciliation refuses changed original payer or replaced payment evidence', async () => {
  for (const damage of [
    f => { f.invoice.Contact.ContactID = uuid(91); },
    f => {
      f.payments[uuid(92)] = { ...f.payments[uuid(63)], PaymentID: uuid(92) };
      f.invoice.Payments = [{ PaymentID: uuid(92) }];
    },
  ]) {
    const f = financeFixture();
    f.a.quote.delta = { netMinor: 0, vatMinor: 0, grossMinor: 0 };
    const context = await f.finance.prepare(f.a, 'none');
    damage(f);
    await assert.rejects(f.finance.inspect(f.a, { choice: 'none', context }), /evidence changed/);
  }
});

test('legacy zero-price reservation without original evidence requires review, not automatic application', async () => {
  const f = financeFixture();
  f.a.quote.delta = { netMinor: 0, vatMinor: 0, grossMinor: 0 };
  await assert.rejects(f.finance.inspect(f.a, {
    choice: 'none', context: { provider: 'none', amounts: { netMinor: 0, taxMinor: 0, grossMinor: 0 } },
  }), /evidence changed/);
});

test('connected Xero collection uses original payer, exact accepted amounts and stable identity; credit allocation is not payment', async () => {
  const f = financeFixture();
  const context = await f.finance.prepare(f.a, 'collect');
  assert.equal(context.contactId, f.invoice.Contact.ContactID);
  assert.equal(context.payerEmail, 'original-payer@example.invalid');
  const s = { context, choice: 'collect' };
  const pending = await f.finance.execute(f.a, s);
  assert.equal(pending.state, 'awaiting_payment');
  assert.equal(pending.evidence.paymentUrl, 'https://invoice.example.invalid/pay');
  const args = f.calls.find(c => c.kind === 'createInvoice').args;
  assert.equal(args.idempotencyKey, `MA:${f.a.id}`);
  assert.equal(args.netMinor + args.taxMinor, args.grossMinor);
  const doc = f.documents[0];
  doc.Status = 'PAID'; doc.AmountDue = 0; doc.AmountPaid = doc.Total;
  const pid = uuid(68);
  doc.Payments = [{ PaymentID: pid }];
  f.payments[pid] = { PaymentID: pid, Status: 'AUTHORISED', Amount: doc.Total,
    Invoice: { InvoiceID: doc.InvoiceID }, Account: { AccountID: uuid(64) } };
  assert.equal((await f.finance.inspect(f.a, s)).state, 'settled');
  doc.AmountCredited = 1;
  await assert.rejects(f.finance.inspect(f.a, s), /settled with credit/);
});

test('retained credit and manual cash refund are exclusive; refund requires consumed note and exact-reference reconciled bank evidence', async () => {
  const f = financeFixture({ credit: true });
  const context = await f.finance.prepare(f.a, 'credit');
  const credit = { context, choice: 'credit' };
  assert.equal((await f.finance.execute(f.a, credit)).evidence.kind, 'retained_credit');
  const write = f.calls.find(c => c.method === 'POST');
  assert.equal(write.key, context.reference);
  assert.equal(JSON.parse(write.body).CreditNotes[0].Type, 'ACCRECCREDIT');
  const refund = { context, choice: 'refund' };
  assert.equal((await f.finance.inspect(f.a, refund)).evidence.kind, 'awaiting_recorded_manual_refund');
  const doc = f.documents[0];
  doc.RemainingCredit = 0;
  const pid = uuid(69);
  doc.Payments = [{ PaymentID: pid }];
  f.payments[pid] = { PaymentID: pid, Status: 'AUTHORISED', IsReconciled: false,
    CreditNote: { CreditNoteID: doc.CreditNoteID }, Account: { AccountID: uuid(64) },
    Reference: `${context.reference}:refund`, Amount: doc.Total };
  await assert.rejects(f.finance.inspect(f.a, refund), /bank-reconciled/);
  f.payments[pid].IsReconciled = true;
  const verified = await f.finance.inspect(f.a, refund);
  assert.equal(verified.state, 'settled');
  assert.equal(verified.evidence.retainedCreditMinor, 0);
  f.bankAccounts[0].Type='CURRENTLIABILITY';
  await assert.rejects(f.finance.inspect(f.a,refund),/not non-cash liability/);
  f.bankAccounts[0].Type='BANK';
  await assert.rejects(f.finance.inspect(f.a, credit), /consumed/);
  doc.Allocations = [{ Amount: doc.Total }];
  await assert.rejects(f.finance.inspect(f.a, refund), /cash refund plus retained credit/);
});

test('taxable document preserves separately rounded VAT exactly; partial original card refunds block new credit', async () => {
  const f = financeFixture();
  f.invoice.TotalTax = 20; f.invoice.Total = 120; f.invoice.AmountPaid = 120;
  f.invoice.LineItems[0].TaxType = 'OUTPUT20';
  f.payments[uuid(63)].Amount = 120;
  f.a.quote.originalFullTerm = { netMinor: 10000, vatMinor: 2000, grossMinor: 12000 };
  f.originalCard.amount_received = 12000; f.originalCharge.amount = 12000;
  f.a.quote.delta = { netMinor: 5041, vatMinor: 1008, grossMinor: 6049 };
  f.a.quote.targetSnapshot.config.flat_vat_rate = '{"taxType":"OUTPUT20"}';
  const context = await f.finance.prepare(f.a, 'collect');
  assert.deepEqual(context.amounts, { netMinor: 5041, taxMinor: 1008, grossMinor: 6049 });
  // Verify exact line tax sent to shared accounting producer, without tax-label
  // parsing, aggregate-gross rate inference or silent one-penny capping.
  const { netMinor, taxMinor, grossMinor } = context.amounts;
  await f.finance.execute(f.a, { choice: 'collect', context });
  assert.equal(f.calls.find(call => call.kind === 'createInvoice').args.lines[0].taxMinor, 1008);
  const c = financeFixture({ credit: true });
  c.originalCharge.amount_refunded = 1;
  await assert.rejects(c.finance.prepare(c.a, 'credit'), /refunds\/disputes/);
  assert.equal(netMinor + taxMinor, grossMinor);
});

test('ownership, mixed invoices, source credits, monthly commitments, provider switches and ambiguous reconciliation fail closed', async () => {
  const f = financeFixture();
  const context = await f.finance.prepare(f.a, 'collect');
  f.documents.push(f.makeDoc(context.amounts), f.makeDoc(context.amounts));
  assert.equal((await f.finance.inspect(f.a, { choice: 'collect', context })).state, 'uncertain');
  f.invoice.AmountCredited = 5;
  await assert.rejects(f.finance.prepare(f.a, 'collect'), /Original payer invoice/);
  f.invoice.AmountCredited = 0;
  f.invoice.LineItems.push({ AccountCode: '999', TaxType: 'NONE' });
  await assert.rejects(f.finance.prepare(f.a, 'collect'), /Mixed or unidentified/);
  f.a.quote.sourceSnapshot.billing_agreement_id = uuid(70);
  await assert.rejects(f.finance.prepare(f.a, 'collect'), /Monthly/);
  f.a.quote.sourceSnapshot.billing_agreement_id = null;
  f.provider.name = 'quickbooks';
  await assert.rejects(f.finance.inspect(f.a, { choice: 'collect', context }), /unsupported/);
});

function serviceDb(a) {
  const tables = {
    member_membership_amendment: [a], member_membership_amendment_settlement: [],
    member_membership_amendment_application: [], member_membership_amendment_notification: [],
    member: [{ id: a.member_id, tenant_id: a.tenant_id, email: 'member@example.invalid' }],
  };
  let failFinish = false;
  const calls = [];
  const db = {
    tables, calls, set failFinish(value) { failFinish = value; },
    from(table) {
      const filters = [];
      const chain = {
        select: () => chain, eq(k, v) { filters.push(r => r[k] === v); return chain; },
        lte(k, v) { filters.push(r => r[k] <= v); return chain; },
        gt(k, v) { filters.push(r => r[k] > v); return chain; },
        in(k, v) { filters.push(r => v.includes(r[k])); return chain; },
        order: () => chain, limit: () => chain,
        maybeSingle() { return chain.then(r => ({ data: r.data[0] || null })); },
        single() { return chain.maybeSingle(); },
        then(resolve) { return Promise.resolve(resolve({ data: structuredClone((tables[table] || []).filter(r => filters.every(fn => fn(r)))) })); },
      };
      return chain;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'recover_stale_member_amendment_notifications') return { data: 0 };
      if (name === 'reserve_member_amendment_settlement') {
        let s = tables.member_membership_amendment_settlement[0];
        const claimed = !s;
        if (!s) {
          s = { amendment_id: a.id, tenant_id: a.tenant_id, member_id: a.member_id, actor_id: uuid(7),
            state: 'reserved', choice: args.p_choice, context: args.p_context, evidence: {}, next_attempt_at: '2020-01-01' };
          tables.member_membership_amendment_settlement.push(s);
        }
        return { data: { claimed, settlement: structuredClone(s) } };
      }
      if (name === 'finish_member_amendment_settlement') {
        if (failFinish) return { error: { code: 'isolated_local_failure' } };
        Object.assign(tables.member_membership_amendment_settlement[0], { state: args.p_state, evidence: args.p_evidence });
        return { data: tables.member_membership_amendment_settlement[0] };
      }
      if (name === 'claim_member_amendment_notification') {
        const n = tables.member_membership_amendment_notification.find(n => n.kind === args.p_kind && n.state === 'pending');
        if (n) n.state = 'sending';
        return { data: n || null };
      }
      if (name === 'finish_member_amendment_notification') {
        Object.assign(tables.member_membership_amendment_notification.find(n => n.kind === args.p_kind), { state: args.p_state });
        return { data: null };
      }
      if (name === 'apply_member_membership_amendment') {
        assert.equal(tables.member_membership_amendment_settlement[0].state, 'settled');
        return { data: { conflict: true, code: 'late_settlement_conflict' } };
      }
      throw new Error(`Unexpected isolated RPC ${name}`);
    },
  };
  return db;
}

test('provider success/local failure recovers read-only; concurrent confirmations execute exactly once and locked choice cannot switch', async () => {
  const f = financeFixture();
  const db = serviceDb(f.a);
  let mutations = 0; let inspections = 0;
  const finance = {
    prepare: async () => ({ provider: 'isolated' }),
    execute: async () => { mutations++; return { state: 'settled', evidence: { verified: true } }; },
    inspect: async () => { inspections++; return { state: 'settled', evidence: { verified: true } }; },
  };
  const service = createMemberAmendmentSettlementService({ db, finance });
  db.failFinish = true;
  await assert.rejects(service.settle(f.tenantId, uuid(7), { amendmentId: f.a.id, settlementChoice: 'collect' }), { code: 'database_error' });
  assert.equal(db.tables.member_membership_amendment_settlement[0].state, 'reserved');
  db.failFinish = false;
  await Promise.all(Array.from({ length: 5 }, () => service.settle(f.tenantId, uuid(7), { amendmentId: f.a.id, settlementChoice: 'collect' })));
  assert.equal(mutations, 1);
  assert.equal(inspections, 5);
  await assert.rejects(service.settle(f.tenantId, uuid(7), { amendmentId: f.a.id, settlementChoice: 'refund' }), { code: 'settlement_choice_locked' });
  await assert.rejects(service.apply(f.tenantId, uuid(7), { amendmentId: f.a.id }), { code: 'late_settlement_conflict' });
  await assert.rejects(service.reconcile(uuid(99), uuid(7), { amendmentId: f.a.id }), { code: 'amendment_not_found' });
});

test('uncertain provider result never retries a mutation and never permits application', async () => {
  const f = financeFixture();
  const db = serviceDb(f.a);
  let mutations = 0;
  const finance = { prepare: async () => ({}), execute: async () => { mutations++; throw new Error('lost response'); },
    inspect: async () => ({ state: 'uncertain', evidence: { reason: 'not_found' } }) };
  const service = createMemberAmendmentSettlementService({ db, finance });
  await assert.rejects(service.settle(f.tenantId, uuid(7), { amendmentId: f.a.id, settlementChoice: 'collect' }), { code: 'provider_outcome_uncertain' });
  await service.settle(f.tenantId, uuid(7), { amendmentId: f.a.id, settlementChoice: 'collect' });
  assert.equal(mutations, 1);
  assert.equal(db.tables.member_membership_amendment_settlement[0].state, 'uncertain');
});

test('historic proposals outside operational reader scope cannot settle or apply: zero provider or lifecycle side effects', async () => {
  const f = financeFixture();
  for (const change of [
    a => { a.quote.targetSnapshot.config.start_mode = 'fixed_date'; },
    a => { a.quote.sourceSnapshot.commitment_snapshot.config.start_mode = 'fixed_date'; },
    a => { a.quote.sourceSnapshot.commitment_snapshot.start_mode = 'fixed_date'; },
    a => { a.quote.sourceSnapshot.term_key = 'fixed:2026'; },
    a => { a.quote.sourceSnapshot.term_duration_months = 6; },
    a => { a.quote.targetSnapshot.config.billing_period = 'monthly'; },
  ]) {
    const a = structuredClone(f.a);
    change(a);
    for (const historicalReservation of [false, true]) {
      const db = serviceDb(a);
      if (historicalReservation) db.tables.member_membership_amendment_settlement.push({
        amendment_id: a.id, tenant_id: a.tenant_id, state: 'reserved', choice: 'collect',
      });
      let providerCalls = 0;
      const touch = async () => { providerCalls++; throw new Error('Unsupported proposal reached provider'); };
      const service = createMemberAmendmentSettlementService({ db,
        finance: { prepare: touch, execute: touch, inspect: touch } });
      for (const action of ['settle', 'apply']) {
        await assert.rejects(service[action](a.tenant_id, uuid(7),
          { amendmentId: a.id, settlementChoice: 'collect' }), { code: 'operational_scope_unsupported' });
      }
      assert.equal(providerCalls, 0);
      assert.equal(db.calls.length, 0);
    }
  }
});

test('overlay preserves original purchase and dates and is tenant/term scoped', async () => {
  const f = financeFixture();
  const db = serviceDb(f.a);
  const app = { tenant_id: f.tenantId, amendment_id: f.a.id, source_record_id: f.current.id,
    member_id: f.memberId, id: uuid(99),
    effective_date: f.today, expires_on: f.current.membership_renewal_date, snapshot: f.a.quote };
  db.tables.member_membership_amendment_application.push(app);
  const result = await resolveMemberAmendmentOverlay({ db, tenantId: f.tenantId, history: f.current, asOf: f.today });
  assert.equal(result.config_id, f.current.config_id);
  assert.equal(result.effective_config_id, f.config.id);
  assert.deepEqual(result.commitment_snapshot, f.current.commitment_snapshot);
  assert.deepEqual(result.effective_commitment_snapshot.amounts, f.current.commitment_snapshot.amounts);
  assert.equal(result.membership_renewal_date, f.current.membership_renewal_date);
  assert.equal((await resolveMemberAmendmentOverlay({ db, tenantId: f.tenantId, history: f.current, asOf: app.expires_on })).effective_config_id, undefined);
});

test('durable notification claim prevents duplicate send; definite non-submission retries but ambiguous outcomes do not', async () => {
  const f = financeFixture();
  const db = serviceDb(f.a);
  db.tables.member_membership_amendment_settlement.push({ amendment_id: f.a.id, tenant_id: f.tenantId,
    context: { payerEmail: 'payer@example.invalid' }, choice: 'refund', state: 'awaiting_payment', evidence: {} });
  db.tables.member_membership_amendment_notification.push({ amendment_id: f.a.id, tenant_id: f.tenantId, kind: 'settlement', state: 'pending' });
  let sends = 0;
  let next = { success: false, notSubmitted: true };
  const service = createMemberAmendmentSettlementService({ db, sendEmail: async args => {
    sends++; assert.match(args.text, /No automatic refund has been sent/); return next;
  } });
  await service.notify(f.tenantId, uuid(7), { amendmentId: f.a.id });
  assert.equal(db.tables.member_membership_amendment_notification[0].state, 'pending');
  next = { success: false };
  await Promise.all([service.notify(f.tenantId, uuid(7), { amendmentId: f.a.id }), service.notify(f.tenantId, uuid(7), { amendmentId: f.a.id })]);
  assert.equal(sends, 2);
  assert.equal(db.tables.member_membership_amendment_notification[0].state, 'uncertain');
  await service.notify(f.tenantId, uuid(7), { amendmentId: f.a.id });
  assert.equal(sends, 2);
});

test('bounded cron recovery invokes read-only reconciliation and pending delivery; cron secret fails closed', async () => {
  const f = financeFixture();
  const db = serviceDb(f.a);
  db.tables.member_membership_amendment_settlement.push({ amendment_id: f.a.id, tenant_id: f.tenantId, actor_id: uuid(7),
    state: 'uncertain', next_attempt_at: '2020-01-01' });
  db.tables.member_membership_amendment_notification.push({ amendment_id: f.a.id, tenant_id: f.tenantId, kind: 'settlement', state: 'pending' });
  const called = [];
  await runMemberAmendmentRecovery({ db, service: { reconcile: async () => called.push('read'), notify: async () => called.push('notify') } });
  assert.deepEqual(called, ['read', 'notify']);
  const res = { setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  const handler = createMemberAmendmentRecoveryHandler({ db, secret: () => null, run: async () => { throw new Error('should not run'); } });
  await handler({ method: 'GET', headers: { authorization: 'Bearer undefined' } }, res);
  assert.equal(res.statusCode, 401);
});

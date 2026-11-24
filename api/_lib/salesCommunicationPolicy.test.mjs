import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateSalesCommunicationPolicy, SALES_AUTOMATIC_COMMUNICATIONS } from '../../shared/salesCommunicationPolicy.js';
import { checkSalesAutomaticDelivery } from './salesCommunicationPolicy.js';
import { finalizeAndNotifySalesAgreement } from './salesAgreement.js';
import { deliverSalesSchedule } from './salesInvoiceSchedule.js';
import { deliverCustomerFulfilment } from './salesCustomerFulfilment.js';
import { publicQuoteDto } from '../public/sales-quote/[...path].js';

process.env.SESSION_SECRET = 'isolated-silent-mode-fixture-only';
const pdf = Buffer.from('%PDF-retained');
const envelope = { id: 'envelope',tenant_id: 'tenant',customer: {},finalization_status: 'complete',
  final_pdf_path: 'file',final_pdf_hash: crypto.createHash('sha256').update(pdf).digest('hex') };
const schedule = { id: 'schedule',tenant_id: 'tenant',provider: 'xero',provider_company_id: 'company',
  snapshot: { recipient: { email: 'billing@example.test' },name: 'Tickets' } };
const fulfilment = { id: 'fulfilment',tenant_id: 'tenant',sale_id: 'sale',customer_email: 'customer@example.test' };
function fixture(policies) {
  const updates = []; const checks = [];
  const states = {};
  return {
    updates, checks, states,
    storage: { from: () => ({ download: async () => ({ data: new Blob([pdf]) }) }) },
    async rpc(name,args) {
      if (name === 'check_sales_automatic_delivery') {
        checks.push(args);
        const value = policies[args.p_category];
        if (value === 'error') return { error: new Error('policy unavailable') };
        if (value === 'suppressed') states[args.p_category] = 'suppressed';
        return { data: value };
      }
      if (name === 'claim_sales_agreement_completion_notice') {
        return { data: states[`agreement_${args.p_party}`] ? null : { attempts: 1,recipient_email: `${args.p_party}@example.test` } };
      }
      if (name === 'claim_sales_schedule_delivery') return { data: !states.invoice };
      if (name === 'claim_sales_customer_fulfilment') return { data: states.customer_fulfilment ? null : fulfilment };
      updates.push({ name,...args }); return { data: true };
    },
    from(table) {
      const q = {
        select() { return q; },eq() { return q; },
        update(value) { updates.push({ table,...value }); return q; },
        single: async () => ({ data: { slug: 'fixture' } }),
        maybeSingle: async () => ({ data: table === 'sales_accounting_invoice_link'
          ? { provider_invoice_id: 'invoice' } : { status: 'suppressed' } }),
        then(resolve) { resolve({ data: null }); },
      }; return q;
    },
  };
}
const dependencies = send => ({
  send, resolveBinding: async () => ({ companyId: 'company' }),
  getProvider: () => ({ fetchInvoicePdf: async () => pdf }),
  loadBranding: async () => ({ name: 'Fixture tenant' }),
});
test('strict policy validation rejects coercion, unknowns and duplicates', () => {
  for (const [enabled,allowed] of [['true',[]],[true,null],[true,['unknown']],[false,['invoice','invoice']],[true,[null]]]) {
    assert.throws(() => validateSalesCommunicationPolicy(enabled,allowed));
  }
  assert.deepEqual(validateSalesCommunicationPolicy(false,['invoice']), { silentMode:false,automaticCommunications:['invoice'] });
});
test('unknown database result is not permission to send or deliberate suppression', async () => {
  for (const data of [null,true,{},'failed']) {
    await assert.rejects(checkSalesAutomaticDelivery({ rpc: async () => ({ data }) },
      { tenantId:'tenant',category:'invoice',id:'id',claim:'lease' }), /could not be resolved/);
  }
});
for (let mask = 0; mask < 16; mask++) {
  test(`all automatic delivery boundaries obey checkbox combination ${mask}`, async () => {
    const policies = Object.fromEntries(SALES_AUTOMATIC_COMMUNICATIONS.map((item,i) => [item.id, mask & (1<<i) ? 'permitted' : 'suppressed']));
    const db = fixture(policies); const messages = [];
    const send = async message => { messages.push(message); return { success:true,messageId:'fixture-message' }; };
    const completed = await finalizeAndNotifySalesAgreement(db,envelope,{ sendEmail:send });
    const invoice = await deliverSalesSchedule(db,schedule,dependencies(send));
    const customer = await deliverCustomerFulfilment(db,fulfilment,{ send });
    assert.equal(completed.finalization_status,'complete');
    for (const party of ['sender','customer']) assert.equal(completed.completionNotifications[party],policies[`agreement_${party}`] === 'permitted' ? 'sent' : 'suppressed');
    assert.equal(invoice.status,policies.invoice === 'permitted' ? 'sent' : 'suppressed');
    assert.equal(customer,policies.customer_fulfilment === 'permitted' ? 'sent' : 'suppressed');
    assert.equal(messages.length,Object.values(policies).filter(v => v === 'permitted').length);
    assert.equal(db.checks.length,policies.invoice === 'permitted' ? 5 : 4);
    assert.ok(db.checks.every(c => c.p_tenant === 'tenant' && c.p_claim));
    assert.equal(db.updates.length,messages.length,'suppressed work must not run sent/failed finalizers');
  });
}
test('lookup failures preserve retryable outcomes and finalized agreement without any mail', async () => {
  const db = fixture(Object.fromEntries(SALES_AUTOMATIC_COMMUNICATIONS.map(c => [c.id,'error'])));
  const send = () => assert.fail('must never reach provider');
  const completed = await finalizeAndNotifySalesAgreement(db,envelope,{ sendEmail:send });
  assert.equal(completed.finalization_status,'complete');
  assert.deepEqual(completed.completionNotifications,{ sender:'failed',customer:'failed' });
  assert.equal((await deliverSalesSchedule(db,schedule,dependencies(send))).status,'rejected');
  assert.equal(await deliverCustomerFulfilment(db,fulfilment,{ send }),'pending');
  assert.deepEqual(db.states,{});
});
test('invoice suppression avoids even PDF retrieval and respects edits during preparation', async () => {
  const policies = { invoice:'suppressed' };
  const db = fixture(policies);
  const deps = dependencies(() => assert.fail('must not send'));
  deps.getProvider = () => assert.fail('suppressed invoices need no provider calls');
  assert.equal((await deliverSalesSchedule(db,schedule,deps)).status,'suppressed');
  const fresh = fixture(policies);
  policies.invoice = 'permitted';
  deps.getProvider = () => ({ fetchInvoicePdf: async () => {
    policies.invoice = 'suppressed'; // Edit while the worker is preparing.
    return pdf;
  } });
  assert.equal((await deliverSalesSchedule(fresh,schedule,deps)).status,'suppressed');
  assert.equal(fresh.checks.length,2);
});
test('suppressed occurrences do not catch up when policy is switched off', async () => {
  const policies = Object.fromEntries(SALES_AUTOMATIC_COMMUNICATIONS.map(c => [c.id,'suppressed']));
  const db = fixture(policies);
  const send = () => assert.fail('no replay');
  await finalizeAndNotifySalesAgreement(db,envelope,{ sendEmail:send });
  await deliverSalesSchedule(db,schedule,dependencies(send));
  await deliverCustomerFulfilment(db,fulfilment,{ send });
  for (const key of Object.keys(policies)) policies[key] = 'permitted';
  await finalizeAndNotifySalesAgreement(db,envelope,{ sendEmail:send });
  assert.deepEqual(await deliverSalesSchedule(db,schedule,dependencies(send)),{ skipped:true });
  assert.equal(await deliverCustomerFulfilment(db,fulfilment,{ send }),'skipped');
});
test('public quote allowlist does not reveal private opportunity settings', () => {
  const policy = { silent_mode:true,automatic_communications:['invoice'] };
  const dto = publicQuoteDto({ ...policy,opportunity:policy },{ ...policy,lines:[] });
  assert.doesNotMatch(JSON.stringify(dto),/silent_mode|automatic_communications/);
});

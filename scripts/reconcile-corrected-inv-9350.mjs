// Owner-approved, exact-invoice repair. No invoice creation, email, or Stripe writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

destinationTarget(process.env);
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const T = 'ff2df806-b321-4254-b651-3af11fccf1db';
const M = '325e0bff-c2dc-45c3-9c0e-50d974d2404a';
const H = '1057a98d-8656-40aa-9ed0-68e3c5ff1d4f';
const S = '2f60fa81-3842-4edd-b6b0-840c264b11da';
const PI = 'pi_3USCS00UfSpC8b2b1qHRtuQS';
const I = '455ff0fc-181c-4d96-9028-fb36bc1cc381';
const C = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const OLD = 'Stripe amount 71.00 does not match Xero invoice total 85.20';
const apply = process.argv.includes('--apply');
const { supabase } = await import('../api/_lib/database.js');
const { retrieveTenantPaymentIntent } = await import('../api/_lib/stripeCredentials.js');
const xero = await import('../api/_lib/xero.js');
const { settleFormStripeInvoice, mergeFormMembershipProgress } = await import('../api/_lib/formStripeInvoiceSettlement.js');
const { attachMembershipAccountingProgress } = await import('../api/_lib/membershipAccountingProgress.js');
const db = await connectDestination();
try {
  const read = async () => {
    const h = (await db.query('SELECT to_jsonb(h) AS value FROM member_membership_history h WHERE id=$1 AND tenant_id=$2 AND member_id=$3', [H,T,M])).rows[0]?.value;
    const s = (await db.query('SELECT to_jsonb(s) AS value FROM form_submission s WHERE id=$1 AND tenant_id=$2', [S,T])).rows[0]?.value;
    assert(h && s);
    return { h, s };
  };
  const before = await read();
  const { h, s } = before;
  const p = s.payment_meta?.membership_result;
  assert.equal(h.accounting_invoice_id, I);
  assert.equal(h.xero_invoice_number, 'INV-9350');
  assert.equal(h.stripe_payment_intent_id, PI);
  assert.equal(h.payment_status, 'paid');
  assert.equal(h.total_with_vat, 71);
  assert.equal(h.billing_agreement_id, null);
  assert.equal(s.payment_reference, PI);
  assert.equal(s.payment_status, 'paid');
  assert.equal(p.history_id, H);
  assert.equal(p.entity_id, M);
  assert.equal(p.invoice_state, 'done');
  assert.equal(p.provider_context.xero_tenant_id, C);
  assert.equal(s.payment_meta.membership.quote.target, 'member');
  assert.equal(Number(s.payment_meta.membership.quote.total_with_vat ?? s.payment_meta.membership.quote.final_cost), 71);
  assert(!p.integrity_state && p.status !== 'blocked');
  assert(p.settlement_state === 'done' || (p.settlement_state === 'blocked' && p.settlement_error === OLD));
  const found = await retrieveTenantPaymentIntent(T, s.payment_meta.stripe_feature || 'membership', PI);
  const pi = found.paymentIntent;
  assert.equal(pi.id, PI);
  assert.equal(pi.status, 'succeeded');
  assert.equal(pi.livemode, true);
  assert.equal(pi.amount_received, 7100);
  assert.equal(pi.currency, 'gbp');
  assert.equal(pi.metadata.tenant_id, T);
  assert.equal(pi.metadata.form_submission_id, S);
  assert.equal(pi.metadata.form_id, s.form_id);
  const charge = await found.stripe.charges.retrieve(typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id);
  assert.equal(charge.amount_refunded, 0);
  assert.equal(charge.disputed, false);
  assert.equal(charge.paid, true);
  const auth = await xero.getValidXeroAccessToken(T);
  assert.equal(auth.tenantId, C);
  const get = async path => {
    const r = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': C, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    assert(r.ok, `Xero read failed ${r.status}`);
    return r.json();
  };
  const invoice = (await get(`Invoices/${I}`)).Invoices[0];
  assert.equal(invoice.InvoiceNumber, 'INV-9350');
  assert.equal(invoice.Total, 71);
  assert.equal(invoice.TotalTax, 0);
  assert.equal(invoice.CurrencyCode, 'GBP');
  assert(['AUTHORISED','PAID'].includes(invoice.Status));
  assert(invoice.LineItems.some(l => l.Description.includes(PI)));
  const contact = (await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
  const member = (await db.query('SELECT email FROM member WHERE id=$1 AND tenant_id=$2', [M,T])).rows[0];
  assert.equal(contact.EmailAddress.toLowerCase(), member.email.toLowerCase());
  const bank = (await db.query("SELECT setting_value FROM system_settings WHERE tenant_id=$1 AND setting_key='xero_stripe_bank_account_code'", [T])).rows[0];
  assert.equal(bank.setting_value, '600');
  const operationKey = `form-stripe-invoice:${T}:${S}:${I}:${PI}`;
  const preview = await xero.settleFormStripeXeroInvoice({
    appTenantId:T, invoiceId:I, stripePaymentIntentId:PI, amount:71, currency:'GBP',
    paidAt:s.payment_paid_at, expectedAccount:'600', expectedProviderContext:C,
    operationKey, dryRun:true,
  });
  console.log(JSON.stringify({ mode:apply?'apply':'verify', stripeStatus:pi.status, live:true,
    amount:71, refund:0, invoice:'INV-9350', invoiceStatus:invoice.Status, preview }));
  assert.notEqual(preview.settlement_state, 'blocked', preview.error);
  if (apply && p.settlement_state !== 'done') {
    await mkdir('generated-artifacts/inv-9350-repair', { recursive:true });
    await writeFile(`generated-artifacts/inv-9350-repair/before-${Date.now()}.json`, JSON.stringify(before,null,2), { mode:0o600 });
    // CAS only the exact reviewed obsolete diagnostic; leave attempts and audit
    // evidence intact. The normal settlement helper acquires its own claim.
    const unblocked = await mergeFormMembershipProgress(supabase, {
      tenantId:T, submissionId:S,
      expected:{settlement_state:'blocked',settlement_error:OLD,history_id:H,invoice_state:'done'},
      patch:{settlement_state:'retry',settlement_error:null},
    });
    assert(unblocked.updated, 'Progress changed; stop');
    const result = await settleFormStripeInvoice({
      supabase, tenantId:T, submissionId:S, dryRun:false, expectedAccount:'600',
      expectedProviderContext:{xero_tenant_id:C},
    });
    console.log(JSON.stringify({settlement:result}));
    assert.equal(result.settlement_state,'done');
    assert(result.payment_recorded && result.annotation_recorded);
  }
  if (apply || p.settlement_state === 'done') {
    const finalInvoice = (await get(`Invoices/${I}`)).Invoices[0];
    assert.equal(finalInvoice.Status, 'PAID');
    assert.equal(finalInvoice.AmountPaid, 71);
    assert.equal(finalInvoice.AmountDue, 0);
    const after = await read();
    const stripDiagnostics = value => {
      const {accounting_sync_status,accounting_sync_error,...rest} = value;
      return rest;
    };
    assert.deepEqual(stripDiagnostics(after.h),stripDiagnostics(h));
    assert.equal(after.h.accounting_sync_status,null);
    assert.equal(after.h.accounting_sync_error,null);
    const rows=[{...after.h,membership_source:'personal'}];
    await attachMembershipAccountingProgress(supabase,{tenantId:T,history:rows});
    assert.equal(rows[0].accounting_progress.state,'complete');
    // Legacy processing_notes is JSONB, not text. Clear only this exact stale
    // diagnostic after provider settlement and local completion are verified.
    if (apply && typeof after.s.processing_notes === 'string'
        && after.s.processing_notes.startsWith('Payment succeeded and the membership was created, but accounting invoice settlement did not complete:')
        && after.s.processing_notes.includes(OLD)) {
      const cleared = await db.query(`UPDATE form_submission SET processing_notes=NULL
        WHERE id=$1 AND tenant_id=$2 AND processing_notes=$3::jsonb
        AND payment_meta->'membership_result'->>'settlement_state'='done'
        AND payment_meta->'membership_result'->>'history_id'=$4 RETURNING id`,
      [S,T,JSON.stringify(after.s.processing_notes),H]);
      assert.equal(cleared.rowCount,1,'Diagnostic changed concurrently');
      assert.equal((await read()).s.processing_notes,null);
      console.log(JSON.stringify({staleDiagnosticCleared:true}));
    }
    console.log(JSON.stringify({verified:true,accountingProgress:rows[0].accounting_progress,
      invoiceStatus:finalInvoice.Status,paid:finalInvoice.AmountPaid,due:finalInvoice.AmountDue,
      membershipUnchanged:true}));
  }
} finally { await db.end(); }

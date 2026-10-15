// Owner-approved correction of ten never-attempted BNMS checkout invoices.
// Provider operations are GET-only. The normal sweep remains the sole writer.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {connectDestination} from './lib/member-index-destination.mjs';
import {validRecoverySnapshot} from '../api/_lib/eventInvoiceRecovery.js';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',event='20bae95f-3b24-45f8-bd6b-b984cdbee3cf';
const migration='supabase/migrations/202612310001_event_invoice_tax_correction_audit.sql';
const dir='generated-artifacts/bnms-event-tax-recovery';
assert(process.argv.slice(2).every(a=>a==='--apply'));
const apply=process.argv.includes('--apply');
const db=await connectDestination();
const q=(text,params=[])=>db.query(text,params);
try {
  await q('begin read only');
  const rows=(await q(`select r.*,b.id booking_id,b.stripe_payment_intent_id,b.status booking_status,
    b.total_cost,b.event_id from event_invoice_recovery r join booking b
    on b.tenant_id=r.tenant_id and b.booking_group_reference=r.booking_group_reference
    where r.tenant_id=$1 and r.source='booking' and b.event_id=$2 and r.status='needs_review'
    and r.snapshot is not null order by r.id`,[tenant,event])).rows;
  assert.equal(rows.length,10,'Cohort changed; re-review before proceeding');
  await q('rollback');
  process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
  const {getStripeCredentials}=await import('../api/_lib/stripeCredentials.js');
  const credentials=await getStripeCredentials(tenant,'events');
  assert(credentials.secret_key&&credentials.mode==='live','Live Stripe credentials required');
  const corrected=[];
  for(const row of rows){
    assert.equal(row.booking_status,'confirmed');assert.equal(Number(row.total_cost),200);
    assert.equal(row.attempts,0);assert.equal(row.invoice_write_started_at,null);
    assert.equal(row.payment_write_started_at,null);assert.equal(row.invoice_id,null);
    assert.equal(row.payment_id,null);
    assert.deepEqual(row.snapshot.reviewReasons,['Historical invoice gross total does not match the checkout amount']);
    assert.equal(row.snapshot.amount,200);
    const pi=row.snapshot.settlement.paymentIntentId;
    assert.equal(pi,row.stripe_payment_intent_id);
    const response=await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(pi)}?expand%5B%5D=latest_charge`,
      {headers:{Authorization:`Bearer ${credentials.secret_key}`},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Stripe read failed: HTTP ${response.status}`);
    const payment=await response.json();
    assert.equal(payment.id,pi);assert.equal(payment.status,'succeeded');assert.equal(payment.livemode,true);
    assert.equal(payment.amount_received,20000);assert.equal(payment.currency,'gbp');
    assert.equal(payment.metadata.event_id,event);
    assert.equal(payment.latest_charge.id,row.snapshot.settlement.chargeId);
    assert.equal(payment.latest_charge.captured,true);assert.equal(payment.latest_charge.amount_refunded,0);
    assert.equal(payment.latest_charge.disputed,false);
    const s=structuredClone(row.snapshot),invoice=structuredClone(s.originalInvoice);
    assert.equal(invoice.LineAmountTypes,'Exclusive');assert.equal(invoice.LineItems.length,1);
    assert.equal(invoice.LineItems[0].Quantity,1);assert.equal(invoice.LineItems[0].UnitAmount,200);
    assert.equal(invoice.LineItems[0].TaxAmount,40);assert.equal(invoice.LineItems[0].TaxType,'OUTPUT2');
    invoice.LineAmountTypes='Inclusive';invoice.LineItems[0].TaxAmount=33.33;
    s.invoice=invoice;s.invoiceLineAmountPolicies=['Inclusive'];
    delete s.originalInvoice;delete s.reviewReasons;
    assert(validRecoverySnapshot(s),'Corrected snapshot must satisfy normal worker validation');
    corrected.push({row,snapshot:s,providerVerifiedAt:new Date().toISOString()});
  }
  await q('begin');
  await q("set local lock_timeout='5s'; set local statement_timeout='30s'");
  await q("select pg_advisory_xact_lock(hashtextextended('bnms-event-tax-correction',0))");
  const current=(await q(`select prosrc from pg_proc where oid='public.event_invoice_recovery_immutable()'::regprocedure`)).rows[0].prosrc;
  const historical=await readFile('supabase/migrations/202611300002_event_invoice_recovery_historical.sql','utf8');
  const original=historical.split('CREATE OR REPLACE FUNCTION public.event_invoice_recovery_immutable()')[1].split('AS $$')[1].split('$$;')[0];
  assert.equal(current.replace(/\s/g,''),original.replace(/\s/g,''),'Unexpected live immutable guard; do not replace');
  const ddl=(await readFile(migration,'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
  await q(ddl);
  for(const {row,snapshot} of corrected){
    const locked=(await q('select * from event_invoice_recovery where id=$1 for update',[row.id])).rows[0];
    assert.deepEqual(locked.snapshot,row.snapshot);assert.equal(locked.status,'needs_review');
    assert.equal(locked.attempts,0);assert.equal(locked.updated_at.toISOString(),row.updated_at.toISOString());
    const bookings=(await q('select id,status,stripe_payment_intent_id,total_cost from booking where tenant_id=$1 and booking_group_reference=$2 for update',[tenant,row.booking_group_reference])).rows;
    assert.equal(bookings.length,1);assert.equal(bookings[0].id,row.booking_id);
    assert.equal(bookings[0].status,'confirmed');assert.equal(Number(bookings[0].total_cost),200);
    assert.equal(bookings[0].stripe_payment_intent_id,row.stripe_payment_intent_id);
    await q(`insert into event_invoice_tax_correction_audit(operation_id,original_snapshot,corrected_snapshot,authority)
      values($1,$2::jsonb,$3::jsonb,$4)`,[row.id,JSON.stringify(row.snapshot),JSON.stringify(snapshot),
      'Administrator confirmed all ticket prices include tax on 2026-10-15. Original GBP 200 payment reverified live: captured, unrefunded, undisputed. Retain original purchaser, provider, dates, tax code and settlement identity.']);
    await q(`update event_invoice_recovery set snapshot=$2::jsonb,status='pending',reason_code=null,next_attempt_at=now(),updated_at=now()
      where id=$1`,[row.id,JSON.stringify(snapshot)]);
  }
  await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(`${dir}/${apply?'apply':'dry-run'}.json`,JSON.stringify({committed:false,migration,corrected},null,2),{mode:0o600});
  await q(apply?'commit':'rollback');
  await writeFile(`${dir}/${apply?'apply':'dry-run'}.json`,JSON.stringify({committed:apply,migration,corrected},null,2),{mode:0o600});
  console.log(JSON.stringify({committed:apply,corrected:corrected.length,grossEach:200,vatEach:33.33,providerWrites:0,migration:apply?migration:null}));
}catch(error){
  await q('rollback').catch(()=>{});
  console.error(error instanceof assert.AssertionError?`Recovery assertion failed: ${error.message}`:String(error.message).slice(0,180));
  process.exitCode=1;
}finally{await db.end();}

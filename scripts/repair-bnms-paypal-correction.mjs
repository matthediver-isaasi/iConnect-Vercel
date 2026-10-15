import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode=process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db', member='fd961c88-01ed-4be9-9e2f-158c57c5766f';
const id='8a93eadf-7ff6-58c8-a7bc-ab9300af3d4c', invoiceId='18c13fa0-6f41-40a6-b3e6-f39be1ccbbbc';
const paymentId='a2bf85b8-ff03-49f0-8692-15a6fa570375';
const dir='generated-artifacts/bnms-paypal-repair';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name,data)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2),{mode:0o600});
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const {gocardlessForTenant}=await import('../api/_lib/gocardless.js');
const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
const get=async path=>{
  const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{
    Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
    signal:AbortSignal.timeout(30000)});
  assert.equal(r.status,200,'Xero verification failed');return r.json();
};
const invoice=(await get(`Invoices/${invoiceId}`)).Invoices[0];
const payment=(await get(`Payments/${paymentId}`)).Payments[0];
const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
assert.equal(invoice.InvoiceNumber,'300005132');
assert.equal(invoice.Status,'PAID');assert.equal(invoice.Type,'ACCREC');
assert.equal(invoice.Total,156);assert.equal(invoice.AmountPaid,156);assert.equal(invoice.AmountDue,0);
assert.equal(invoice.CurrencyCode,'GBP');assert.equal(invoice.TotalTax,0);
if(invoice.AmountCredited!=null)assert.equal(invoice.AmountCredited,0);
assert.equal((invoice.CreditNotes||[]).length,0);
assert.equal(invoice.LineItems.length,1);assert.equal(invoice.LineItems[0].Description,'Full Membership UK');
assert.equal(payment.Invoice.InvoiceID,invoiceId);assert.equal(payment.Amount,156);
assert.equal(payment.Status,'AUTHORISED');assert.equal(payment.Account.Name,'GBP PayPal');
const paidAt=new Date(Number(/\/Date\((\d+)/.exec(payment.Date)[1])).toISOString();
assert.equal(paidAt.slice(0,10),'2026-03-27');
const gc=await gocardlessForTenant(tenant);
assert.equal((await gc.getMandate('MD00330X82MCB8')).status,'cancelled');
const gcPayment=await gc.getPayment('PM01XW45EMJ920VVC1A0WX4RNSPR');
assert.equal(gcPayment.status,'cancelled');assert.equal(gcPayment.links.mandate,'MD00330X82MCB8');
const sql=fs.readFileSync('supabase/migrations/20261015063000_bnms_verified_paypal_correction.sql','utf8');
const db=await connectDestination();
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  // Briefly serialize all affected writes while the transaction-local exception exists.
  await db.query('LOCK TABLE member_membership_history,membership_billing_agreements,membership_payment_plans IN ACCESS EXCLUSIVE MODE');
  const read=async table=>(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1 AND member_id=$2 ORDER BY id`,[tenant,member])).rows.map(r=>r.data);
  const history=await read('member_membership_history'),agreements=await read('membership_billing_agreements'),plans=await read('membership_payment_plans');
  assert.equal(history.length,1);const before=history[0];assert.equal(before.id,id);
  assert.equal(agreements.length,1);assert.equal(plans.length,1);
  assert.equal(agreements[0].status,'payment_plan_cancelled');
  assert.equal(plans[0].status,'payment_plan_cancelled');assert.equal(plans[0].instalments_paid,0);
  assert.equal(plans[0].last_payment_status,'cancelled');
  const m=(await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[member,tenant])).rows[0].data;
  assert.equal(m.email.toLowerCase(),contact.EmailAddress.toLowerCase());
  const prefs=(await db.query(`SELECT f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
    WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY f.name,v.id`,[member,tenant])).rows;
  assert.equal(prefs.find(p=>p.name==='member_class').value,'Full');
  assert.equal(prefs.find(p=>p.name==='ym_date_membership_expires').value,'01/04/2027');
  const replay=before.payment_method==='upfront'&&before.accounting_invoice_id===invoiceId;
  if(!replay){
    assert.notEqual(mode,'verify');
    assert.equal(before.status,'pending_payment_setup');assert.equal(before.payment_status,'unpaid');
    assert.equal(before.payment_method,'direct_debit');assert.equal(before.billing_agreement_id,agreements[0].id);
    assert.equal(before.term_start_date,'2026-10-01');assert.equal(before.term_end_date,'2027-09-30');
    assert.equal(before.accounting_invoice_id,null);assert.equal(before.xero_invoice_id,null);
    assert.equal((await db.query(`SELECT count(*)::int n FROM member_membership_history
      WHERE tenant_id=$1 AND (accounting_invoice_id=$2 OR xero_invoice_id=$2)`,[tenant,invoiceId])).rows[0].n,0);
    const config=(await db.query('SELECT to_jsonb(c) data FROM membership_tier_config c WHERE id=$1 AND tenant_id=$2',[before.config_id,tenant])).rows[0].data;
    assert.equal(config.structure_match_value,'Full');assert.equal(config.billing_period,'annual');
    const amounts={annual_cost:156,final_cost:156,total_with_vat:156,vat_amount:0,currency:'GBP'};
    const commitment=buildRollingCommitment({config,startDate:'2026-04-02',paymentMethod:'upfront',
      paymentFrequency:'upfront',amounts,pricingSnapshot:{tier_label:'Full',...amounts}});
    assert.equal(commitment.term_end_date,'2027-04-01');
    const provenance={source:'operator_approved_paypal_upfront_correction',approvalDate:'2026-10-15',
      termAuthority:'operator_approved_2026-04-02_to_2027-04-01',invoiceId,paymentId,
      scheduleAuthority:'Retained existing Full class schedule; not evidence of its existence at the reconstructed start.',
      futureCollectionConsent:false,providerWrites:0,priorMembership:before};
    const after={...before,...commitment,...amounts,membership_year:commitment.term_key,
      tier_label:'Full',field_value:'Full',billing_period:'annual',payment_method:'upfront',
      status:'active',payment_status:'paid',paid_at:paidAt,billing_agreement_id:null,
      accounting_provider:'xero',accounting_invoice_id:invoiceId,accounting_invoice_number:invoice.InvoiceNumber,
      xero_invoice_id:invoiceId,xero_invoice_number:invoice.InvoiceNumber,notes:JSON.stringify(provenance)};
    // jsonb timestamps are serialized by PostgreSQL, not JavaScript.
    const normalized=(await db.query('SELECT to_jsonb(r) data FROM jsonb_populate_record(NULL::member_membership_history,$1) r',[JSON.stringify(after)])).rows[0].data;
    const pin={before,after:normalized};
    if(mode==='apply')assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/dry-run.json`,'utf8')).pin,pin);
    await db.query('CREATE TEMP TABLE approved_paypal_correction(old_row jsonb,new_row jsonb) ON COMMIT DROP');
    await db.query('INSERT INTO approved_paypal_correction VALUES($1,$2)',[JSON.stringify(before),JSON.stringify(normalized)]);
    if(mode==='apply')save(`backup-${Date.now()}`,{pin,agreements,plans,invoice,payment});
    await db.query(sql);
    // The final guard must reject further financial changes, but allow expiry.
    await db.query('SAVEPOINT guard_test');
    let blocked=false;
    try{await db.query('UPDATE member_membership_history SET annual_cost=157 WHERE id=$1',[id]);}
    catch(e){assert.match(e.message,/financial\/dated terms are immutable/);blocked=true;}
    await db.query('ROLLBACK TO SAVEPOINT guard_test');assert.equal(blocked,true);
    await db.query('UPDATE member_membership_history SET status=$1 WHERE id=$2',['expired',id]);
    await db.query('ROLLBACK TO SAVEPOINT guard_test');
    // Agreement provider identity remains protected by the shared function.
    let agreementBlocked=false;
    try{await db.query("UPDATE membership_billing_agreements SET gocardless_mandate_id='INVALID' WHERE id=$1",[agreements[0].id]);}
    catch(e){assert.match(e.message,/immutable consent\/provider drift/);agreementBlocked=true;}
    await db.query('ROLLBACK TO SAVEPOINT guard_test');assert.equal(agreementBlocked,true);
    // Another alpha history retains the original financial protection.
    const other=(await db.query(`SELECT h.id FROM member_membership_history h JOIN bnms_dd_alpha_adoption a ON a.history_id=h.id
      WHERE h.tenant_id=$1 AND h.id<>$2 LIMIT 1`,[tenant,id])).rows[0];
    assert.ok(other);
    let otherBlocked=false;
    try{await db.query('UPDATE member_membership_history SET annual_cost=coalesce(annual_cost,0)+1 WHERE id=$1',[other.id]);}
    catch(e){assert.match(e.message,/immutable|reviewed release/);otherBlocked=true;}
    await db.query('ROLLBACK TO SAVEPOINT guard_test');assert.equal(otherBlocked,true);
    if(mode==='dry-run')save('dry-run',{pin});
  }
  const current=(await read('member_membership_history'))[0];
  assert.equal(current.payment_status,'paid');assert.equal(current.accounting_invoice_id,invoiceId);
  assert.equal(current.billing_agreement_id,null);
  const display=shapePersistedCommitment(current);
  assert.equal(display.paymentMethod,'upfront');assert.equal(display.paymentFrequency,'upfront');
  assert.equal(display.lifecycle,'current');assert.equal(display.startDate,'2026-04-02');
  assert.equal(display.endDate,'2027-04-01');assert.equal(display.renewalDate,'2027-04-02');
  assert.equal(display.agreedPrice,156);
  assert.deepEqual(await read('membership_billing_agreements'),agreements);
  assert.deepEqual(await read('membership_payment_plans'),plans);
  assert.deepEqual((await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1',[member])).rows[0].data,m);
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  save(`${mode}-${Date.now()}`,{current,display,replay});
  console.log(JSON.stringify({mode,replay,invoice:invoice.InvoiceNumber,start:display.startDate,end:display.endDate,
    renewal:display.renewalDate,method:display.paymentMethod,amount:156,providerWrites:0,cancelledBillingUnchanged:true}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}

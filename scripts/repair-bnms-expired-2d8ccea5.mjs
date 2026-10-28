// Owner-authorised, single-member expired-term repair. No provider financial writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {connectDestination} from './annual-meeting-destination.mjs';
import {buildRollingCommitment} from '../api/_lib/rollingMembershipCommitment.js';
import {classifyAnnualRenewal} from '../api/_lib/annualRenewalPolicy.js';
const mode=process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',member='2d8ccea5-c596-48c2-b741-f9da4f5fb972';
const historyId='defca80d-7eb2-5702-aefe-c3bb96552e5b',configId='07f35246-907a-411d-be78-2b3a9587ce3a';
const invoiceId='2f98b9c0-0ed7-49ff-b72c-9a2d082264e3',paymentId='cb6ff369-460a-4e3e-b742-86e8215e1496';
const source='bnms_owner_approved_expired_term_reconstruction';
const dir='generated-artifacts/bnms-expired-2d8ccea5';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path){
 const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{
  Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
  signal:AbortSignal.timeout(30000)});
 assert.equal(r.status,200,'Xero evidence unavailable');return r.json();
}
const invoices=(await get('Invoices?InvoiceNumbers=300004746')).Invoices;
assert.equal(invoices.length,1);
const invoice=invoices[0];
for(const [key,value] of Object.entries({InvoiceID:invoiceId,InvoiceNumber:'300004746',Status:'PAID',
 Type:'ACCREC',CurrencyCode:'GBP',Total:156,AmountPaid:156,AmountDue:0,AmountCredited:0,TotalTax:0})){
 assert.equal(invoice[key],value);
}
assert.equal(invoice.LineItems.length,1);assert.equal(invoice.LineItems[0].Description,'Full Membership UK');
for(const key of ['CreditNotes','Prepayments','Overpayments'])assert.equal((invoice[key]||[]).length,0);
assert.equal(invoice.Payments.length,1);assert.equal(invoice.Payments[0].PaymentID,paymentId);
const payment=(await get(`Payments/${paymentId}`)).Payments[0];
assert.equal(payment.Invoice.InvoiceID,invoiceId);assert.equal(payment.Amount,156);
assert.equal(payment.Status,'AUTHORISED');assert.equal(payment.IsReconciled,true);
const paidAt=new Date(Number(/\/Date\((\d+)/.exec(payment.Date)?.[1])).toISOString();
assert.equal(paidAt,'2025-12-01T00:00:00.000Z');
const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
const db=await connectDestination();
try{
 await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await db.query("SET LOCAL lock_timeout='10s'");
 const owner=(await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[member,tenant])).rows[0].data;
 assert.equal(owner.email.toLowerCase(),contact.EmailAddress.toLowerCase());
 const histories=(await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE member_id=$1 AND tenant_id=$2 FOR UPDATE',[member,tenant])).rows;
 assert.equal(histories.length,1);const before=histories[0].data;assert.equal(before.id,historyId);
 const prefs=(await db.query(`SELECT f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
  WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.name IN ('member_class','ym_date_membership_expires')`,[member,tenant])).rows;
 assert.equal(prefs.length,2);assert.equal(prefs.find(p=>p.name==='member_class').value,'Full with NMC');
 assert.equal(prefs.find(p=>p.name==='ym_date_membership_expires').value,'30/09/2026');
 for(const table of ['membership_billing_agreements','membership_payment_quote','membership_successor_election']){
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${table} WHERE member_id=$1 AND tenant_id=$2`,[member,tenant])).rows[0].n,0);
 }
 const config=(await db.query('SELECT to_jsonb(c) data FROM membership_tier_config c WHERE id=$1 AND tenant_id=$2 FOR SHARE',[configId,tenant])).rows[0].data;
 assert.equal(config.structure_match_value,'Full with NMC');assert.equal(config.is_active,true);
 assert.equal(config.renewal_open_days,90);assert.equal(config.renewal_grace_days,90);
 const amounts={annual_cost:156,final_cost:156,vat_amount:0,total_with_vat:156,currency:'GBP'};
 const commitment=buildRollingCommitment({config,startDate:'2025-10-01',paymentMethod:'upfront',
  paymentFrequency:'upfront',amounts,pricingSnapshot:{tier_label:'Full with NMC',...amounts}});
 assert.equal(commitment.term_end_date,'2026-09-30');assert.equal(commitment.membership_renewal_date,'2026-10-01');
 const verify=after=>{
  for(const [k,v] of Object.entries({...commitment,...amounts,status:'expired',payment_status:'paid',
   accounting_invoice_id:invoiceId,accounting_invoice_number:'300004746'}))assert.deepEqual(after[k],v,k);
  assert.equal(new Date(after.paid_at).toISOString(),paidAt);
  const eligibility=classifyAnnualRenewal({previousRecord:after,config,now:new Date('2026-10-28T12:00:00Z')});
  assert.equal(eligibility.eligible,true);
  assert.equal(eligibility.target.start.toISOString().slice(0,10),'2026-10-01');
  assert.equal(eligibility.target.end.toISOString().slice(0,10),'2027-09-30');
  return eligibility;
 };
 if(mode==='verify'){
  assert.equal(JSON.parse(before.notes).source,source);const eligibility=verify(before);
  await db.query('ROLLBACK');console.log(JSON.stringify({mode,writes:0,verified:true,eligibility})); 
 }else{
  assert.equal(JSON.parse(before.notes).source,'bnms_non_dd_current_backfill');
  assert.equal(before.term_key,null);assert.equal(before.term_end_date,'2026-09-30');
  const patch={...commitment,...amounts,config_id:configId,field_value:'Full with NMC',tier_label:'Full with NMC',
   membership_year:commitment.term_key,status:'expired',paid_at:paidAt,accounting_provider:'xero',
   accounting_invoice_id:invoiceId,accounting_invoice_number:'300004746',xero_invoice_id:invoiceId,xero_invoice_number:'300004746',
   notes:JSON.stringify({source,version:1,originalRecord:before,
    termAuthority:'owner_requested_expired_annual_reconstruction_retaining_legacy_expiry',
    structureAuthority:'current_member_class_mapping_for_reconstruction_not_original_purchase_configuration',
    paymentAuthority:'xero_authorised_reconciled_payment',invoiceId,paymentId,
    providerWrites:0,futureCollectionConsent:false})};
  const proposed={owner,before,config,patch};
  if(mode==='apply')assert.deepEqual(proposed,JSON.parse(fs.readFileSync(`${dir}/dry-run.json`)));
  fs.writeFileSync(`${dir}/${mode}-${Date.now()}.json`,JSON.stringify({proposed,invoice,payment},null,2),{flag:'wx',mode:0o600});
  const keys=Object.keys(patch);
  const updated=await db.query(`UPDATE member_membership_history h SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')}
   WHERE id=$${keys.length+1} AND tenant_id=$${keys.length+2} AND to_jsonb(h)=$${keys.length+3}::jsonb RETURNING to_jsonb(h) data`,
   [...keys.map(k=>patch[k]!==null&&typeof patch[k]==='object'?JSON.stringify(patch[k]):patch[k]),historyId,tenant,JSON.stringify(before)]);
  assert.equal(updated.rowCount,1);const after=updated.rows[0].data,eligibility=verify(after);
  assert.deepEqual((await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1',[member])).rows[0].data,owner);
  if(mode==='dry-run')fs.writeFileSync(`${dir}/dry-run.json`,JSON.stringify(proposed,null,2),{mode:0o600});
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({mode,committed:mode==='apply',updated:1,invoice:'300004746',
   termStart:after.term_start_date,termEnd:after.term_end_date,status:after.status,eligibility}));
 }
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}

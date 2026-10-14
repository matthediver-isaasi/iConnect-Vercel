// Individually approved repair. Only Xero GET requests; no billing entrypoints.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode=process.argv[2];assert.ok(['dry-run','apply'].includes(mode));
process.on('uncaughtException',e=>{
  console.error('Reconstruction stopped; transaction rolled back unless a receipt confirms commit.',
    {code:e.code||e.name,message:e.code==='ERR_ASSERTION'?'Verification assertion failed':e.code||'Operation failed'});
  process.exitCode=1;
});
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',member='eda44595-1c5d-4bf8-8395-8c75b19774b5';
const priorId='c32e2104-2921-5b2d-a948-59caa9e62a31',id='0c8429c7-b6c2-5fd3-a963-94fe9d1e76d7';
const invoiceId='3ebe46c7-6c02-41c9-8b23-e74724a6bbc0',paymentId='cdcee6f8-3a96-4fcf-b65a-e0832de248d3';
const directory='generated-artifacts/bnms-reviewed-xero-renewal';
fs.mkdirSync(directory,{recursive:true,mode:0o700});
const save=(name,data)=>fs.writeFileSync(`${directory}/${name}-${Date.now()}.json`,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
const get=async path=>{
  const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{
    headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
    signal:AbortSignal.timeout(30000)});
  assert.equal(r.status,200,'Xero verification incomplete');return r.json();
};
const invoice=(await get(`Invoices/${invoiceId}`)).Invoices?.[0];
const payment=(await get(`Payments/${paymentId}`)).Payments?.[0];
const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts?.[0];
assert.equal(contact.AccountNumber,'56480781');
assert.equal(invoice.InvoiceID,invoiceId);assert.equal(invoice.InvoiceNumber,'300005490');
assert.equal(invoice.Status,'PAID');assert.equal(invoice.Type,'ACCREC');assert.equal(invoice.CurrencyCode,'GBP');
assert.equal(invoice.Total,156);assert.equal(invoice.AmountPaid,156);assert.equal(invoice.AmountDue,0);
if(invoice.AmountCredited!=null)assert.equal(invoice.AmountCredited,0);
assert.equal((invoice.CreditNotes||[]).length,0);
assert.equal(invoice.TotalTax,0);assert.equal(invoice.LineItems.length,1);
assert.equal(invoice.LineItems[0].Description,'Full Membership UK');
assert.equal(payment.PaymentID,paymentId);assert.equal(payment.Invoice.InvoiceID,invoiceId);
assert.equal(payment.Status,'AUTHORISED');assert.equal(payment.Amount,156);
const date=value=>new Date(Number(/\/Date\((\d+)/.exec(value)?.[1])).toISOString();
const paidAt=date(payment.Date);
const db=await connectDestination();
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='60s'");
  await db.query('LOCK TABLE member_membership_history,member,member_preference_value,membership_tier_config IN SHARE ROW EXCLUSIVE MODE');
  const read=async(table,where='tenant_id=$1',values=[tenant])=>(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE ${where} ORDER BY id`,values)).rows.map(r=>r.data);
  const histories=await read('member_membership_history');
  const members=await read('member'),m=members.find(x=>x.id===member);
  assert.equal(m.email.toLowerCase(),contact.EmailAddress.toLowerCase());
  const prior=histories.find(h=>h.id===priorId),existing=histories.find(h=>h.id===id);
  assert.equal(prior.member_id,member);assert.equal(prior.term_end_date,'2026-08-27');
  assert.equal(prior.status,'expired');
  assert.equal(histories.filter(h=>h.member_id===member).length,existing?2:1);
  const prefs=(await db.query(`SELECT v.id,v.value,f.id field_id,f.name FROM member_preference_value v
    JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2
    AND f.entity_scope='member' AND f.name IN ('member_class','ym_date_membership_expires') ORDER BY v.id`,[member,tenant])).rows;
  assert.equal(prefs.length,2);
  const klass=prefs.find(p=>p.name==='member_class'),expiry=prefs.find(p=>p.name==='ym_date_membership_expires');
  assert.equal(klass.value,'Full with NMC');
  assert.equal(expiry.value,existing?'27/08/2027':'27/08/2026');
  const configs=(await read('membership_tier_config')).filter(c=>c.is_active&&c.structure_scope_type==='member'
    &&c.structure_field_id===klass.field_id&&c.structure_match_value===klass.value
    &&c.effective_from<='2026-10-14'&&(!c.effective_to||c.effective_to>='2026-10-14'));
  assert.equal(configs.length,1);
  const config=configs[0];
  assert.equal(config.id,'07f35246-907a-411d-be78-2b3a9587ce3a');
  const amounts={annual_cost:156,final_cost:156,vat_amount:0,total_with_vat:156,currency:'GBP'};
  const commitment=buildRollingCommitment({config,startDate:'2026-08-28',paymentMethod:'upfront',
    paymentFrequency:'upfront',amounts,pricingSnapshot:{tier_label:klass.value,...amounts}});
  // The predecessor is expiry-only, with no authoritative rolling anchor.
  // Keep the audit link below rather than inventing predecessor commitment dates.
  assert.equal(commitment.previous_term_id,null);
  assert.equal(commitment.term_end_date,'2027-08-27');
  assert.equal(commitment.membership_renewal_date,'2027-08-28');
  const provenance={source:'bnms_operator_reviewed_xero_renewal',version:1,approvalDate:'2026-10-14',
    termAuthority:'operator_approved_12_month_successor_of_retained_expiry',
    structureAuthority:'operator_approved_current_member_class_mapping',
    historicalScheduleCaveat:'Selected structure became effective 2026-09-01; mapping approved during reconstruction, not evidence of original August configuration.',
    paymentAuthority:'xero_authorised_payment',invoiceId,paymentId,priorHistoryId:priorId,
    predecessorLinkAuthority:'audit_only_predecessor_has_no_rolling_anchor',
    providerWrites:0,futureCollectionConsent:false};
  const record={id,tenant_id:tenant,member_id:member,config_id:config.id,tier_label:klass.value,
    field_value:klass.value,membership_year:commitment.term_key,...commitment,...amounts,
    billing_period:'annual',status:'active',payment_status:'paid',payment_method:'upfront',paid_at:paidAt,
    accounting_provider:'xero',accounting_invoice_id:invoiceId,accounting_invoice_number:invoice.InvoiceNumber,
    xero_invoice_id:invoiceId,xero_invoice_number:invoice.InvoiceNumber,accounting_sync_status:null,
    notes:JSON.stringify(provenance)};
  const agreements=await read('membership_billing_agreements'),plans=await read('membership_payment_plans');
  if(!existing){
    if(mode==='apply')save('before',{histories,prefs,member:m,record,invoice,payment});
    const keys=Object.keys(record);
    await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
      keys.map(k=>record[k]!=null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
    await db.query('UPDATE member_membership_history SET tier_label=$1 WHERE id=$2 AND tenant_id=$3',[klass.value,priorId,tenant]);
    await db.query('UPDATE member_preference_value SET value=$1 WHERE id=$2 AND value=$3',['27/08/2027',expiry.id,'27/08/2026']);
  }
  const after=await read('member_membership_history'),current=after.find(h=>h.id===id);
  for(const [key,value] of Object.entries(record)){
    if(key==='paid_at')assert.equal(Date.parse(current[key]),Date.parse(value));
    else assert.deepEqual(current[key],value,`Unexpected ${key}`);
  }
  assert.deepEqual(after.filter(h=>![id,priorId].includes(h.id)),histories.filter(h=>![id,priorId].includes(h.id)));
  const oldAfter=after.find(h=>h.id===priorId);
  assert.deepEqual({...oldAfter,updated_at:prior.updated_at},{...prior,tier_label:klass.value});
  const membersAfter=await read('member');
  for(const oldMember of members){
    const actual=membersAfter.find(x=>x.id===oldMember.id);
    const expected=oldMember.id===member&&!existing
      ? {...oldMember,survey_invitation_revision:oldMember.survey_invitation_revision+1,updated_at:actual.updated_at}
      : oldMember;
    assert.ok(isDeepStrictEqual(actual,expected),'Member changed beyond the normal preference-update timestamp/revision');
  }
  assert.deepEqual(await read('membership_billing_agreements'),agreements);
  assert.deepEqual(await read('membership_payment_plans'),plans);
  const display=shapePersistedCommitment(current,new Date('2026-10-14T12:00:00Z'));
  assert.equal(display.structureName,config.name);assert.equal(display.lifecycle,'current');
  assert.equal(display.agreedPrice,156);
  assert.equal((await db.query('SELECT value FROM member_preference_value WHERE id=$1',[expiry.id])).rows[0].value,'27/08/2027');
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  if(mode==='apply'){
    const committed=(await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1',[id])).rows[0].data;
    assert.deepEqual(committed,current);
    save('receipt',{current,display,provenance,invoice,payment,replayed:!!existing});
  }
  console.log(JSON.stringify({mode,replayed:!!existing,structure:display.structureName,start:display.startDate,
    end:display.endDate,renewal:display.renewalDate,price:display.agreedPrice,invoice:invoice.InvoiceNumber,
    paidAt,providerWrites:0,existingBillingUnchanged:true}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}

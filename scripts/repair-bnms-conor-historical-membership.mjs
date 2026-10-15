// Approved historical reconstruction. No collections, workflows or provider writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {buildRollingCommitment} from '../api/_lib/rollingMembershipCommitment.js';
const mode=process.argv[2];assert.ok(['dry-run','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',member='fc39d583-0d05-4089-a4e0-d91b433b6dd2';
const id='59ac25a1-c93b-4f69-aeb2-8c2dcf414ce0',invoiceId='be6020dc-672b-4a88-a460-06442e3cd323';
const paymentId='760c859b-459b-4326-bd5f-dc12004436e7';
const dir='generated-artifacts/bnms-conor-historical-repair';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name,data)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2),{mode:0o600});
destinationTarget(process.env);process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {projectMembershipPaymentReport}=await import('../api/_lib/membershipPaymentReport.js');
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
const get=async path=>{
  const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{Authorization:`Bearer ${auth.accessToken}`,
    'xero-tenant-id':auth.tenantId,Accept:'application/json'},signal:AbortSignal.timeout(30000)});
  assert.equal(r.status,200);return r.json();
};
const invoice=(await get(`Invoices/${invoiceId}`)).Invoices[0];
const payment=(await get(`Payments/${paymentId}`)).Payments[0];
const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
assert.equal(invoice.InvoiceNumber,'300004432');assert.equal(invoice.Status,'PAID');assert.equal(invoice.Type,'ACCREC');
assert.equal(invoice.Total,156);assert.equal(invoice.AmountPaid,156);assert.equal(invoice.AmountDue,0);
assert.equal(invoice.CurrencyCode,'GBP');assert.equal(invoice.TotalTax,0);
if(invoice.AmountCredited!=null)assert.equal(invoice.AmountCredited,0);
assert.equal((invoice.CreditNotes||[]).length,0);
assert.equal(invoice.LineItems.length,1);assert.equal(invoice.LineItems[0].Description,'Full Membership UK');
assert.equal(payment.Invoice.InvoiceID,invoiceId);assert.equal(payment.Status,'AUTHORISED');assert.equal(payment.Amount,156);
const paidAt=new Date(Number(/\/Date\((\d+)/.exec(payment.Date)[1])).toISOString();
assert.equal(paidAt.slice(0,10),'2025-05-29');
const db=await connectDestination();
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  const m=(await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[member,tenant])).rows[0].data;
  assert.equal(m.email.toLowerCase(),contact.EmailAddress.toLowerCase());
  const read=async table=>(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1 AND member_id=$2 ORDER BY id`,[tenant,member])).rows.map(r=>r.data);
  const before=await read('member_membership_history');
  assert.equal((await read('membership_billing_agreements')).length,0);
  assert.equal((await read('membership_payment_plans')).length,0);
  const prefs=(await db.query(`SELECT f.name,f.id field_id,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
    WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY f.name,v.id`,[member,tenant])).rows;
  const klass=prefs.find(p=>p.name==='member_class');
  assert.equal(klass.value,'Full with NMC');
  assert.equal(prefs.find(p=>p.name==='ym_date_membership_expires').value,'29/05/2026');
  const config=(await db.query(`SELECT to_jsonb(c) data FROM membership_tier_config c
    WHERE tenant_id=$1 AND id=$2 AND structure_field_id=$3 AND structure_match_value=$4`,
  [tenant,'07f35246-907a-411d-be78-2b3a9587ce3a',klass.field_id,klass.value])).rows[0].data;
  assert.equal(config.billing_period,'annual');
  const amounts={annual_cost:156,final_cost:156,vat_amount:0,total_with_vat:156,currency:'GBP'};
  const commitment=buildRollingCommitment({config,startDate:'2025-05-30',paymentMethod:'upfront',paymentFrequency:'upfront',
    amounts,pricingSnapshot:{tier_label:klass.value,...amounts}});
  assert.equal(commitment.term_end_date,'2026-05-29');
  const record={id,tenant_id:tenant,member_id:member,config_id:config.id,...commitment,...amounts,
    membership_year:commitment.term_key,tier_label:klass.value,field_value:klass.value,billing_period:'annual',
    status:'expired',payment_status:'paid',payment_method:'upfront',paid_at:paidAt,
    accounting_provider:'xero',accounting_invoice_id:invoiceId,accounting_invoice_number:invoice.InvoiceNumber,
    xero_invoice_id:invoiceId,xero_invoice_number:invoice.InvoiceNumber,
    notes:JSON.stringify({source:'operator_approved_historical_paid_membership',approvalDate:'2026-10-15',
      termAuthority:'operator_approved_12_month_reconstruction_retaining_2026-05-29_expiry',
      paymentAuthority:'verified_xero_payment',invoiceId,paymentId,
      scheduleAuthority:'Current Full with NMC schedule selected by operator approval; not evidence of its existence or price at the historical start.',
      scope:'expired_historical_term_only',futureCollectionConsent:false,providerWrites:0})};
  const existing=before.find(h=>h.id===id);assert.equal(before.length,existing?1:0);
  const pin={record,prefs};
  if(!existing){
    assert.notEqual(mode,'verify');
    assert.equal((await db.query(`SELECT count(*)::int n FROM member_membership_history
      WHERE tenant_id=$1 AND (accounting_invoice_id=$2 OR xero_invoice_id=$2)`,[tenant,invoiceId])).rows[0].n,0);
    if(mode==='apply'){
      assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/dry-run.json`,'utf8')),pin);
      save(`before-${Date.now()}`,{m,before,prefs,record,invoice,payment});
    }
    const keys=Object.keys(record);
    await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
      keys.map(k=>record[k]!==null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
  }
  const history=await read('member_membership_history'),current=history[0];
  for(const [key,value] of Object.entries(record)){
    if(key==='paid_at')assert.equal(Date.parse(current[key]),Date.parse(value));
    else assert.deepEqual(current[key],value,key);
  }
  const display=shapePersistedCommitment(current);assert.equal(display.lifecycle,'past');
  assert.equal(display.structureName,config.name);assert.equal(display.endDate,'2026-05-29');
  const report=projectMembershipPaymentReport({tenantId:tenant,members:[m],history,configs:[config],today:'2026-10-15'});
  const reportRows=report;
  assert.ok(reportRows.some(r=>r.memberId===member&&r.historyId===id),'Expired member missing from payment report');
  assert.equal(reportRows.find(r=>r.memberId===member).status,'expired');
  assert.deepEqual((await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1',[member])).rows[0].data,m);
  assert.equal((await read('membership_billing_agreements')).length,0);
  assert.equal((await read('membership_payment_plans')).length,0);
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  if(mode==='dry-run')save('dry-run',pin);
  save(`${mode}-${Date.now()}`,{current,display,report,replay:!!existing});
  console.log(JSON.stringify({mode,replay:!!existing,invoice:invoice.InvoiceNumber,start:display.startDate,
    end:display.endDate,renewal:display.renewalDate,status:current.status,lifecycle:display.lifecycle,
    reportIncluded:true,providerWrites:0}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}

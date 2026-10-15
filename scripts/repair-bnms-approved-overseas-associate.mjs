// Operator-approved reconstruction; Xero GETs only, no billing entrypoints.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode=process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',member='783a6e78-21bd-4b77-a4ea-d4271368d2f8';
const id='93a4f54c-fae8-4c76-ae69-e43b689b79b5';
const invoiceId='0ecd75a9-22fe-44e5-9e63-9745559ea2e1',paymentId='2ec5c928-4afb-434b-b915-014ada0b7ec6';
const dir='generated-artifacts/bnms-overseas-associate-repair';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name,data)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2),{mode:0o600});
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
const get=async path=>{
  const response=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{
    Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
    signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200,'Xero verification failed');return response.json();
};
const invoice=(await get(`Invoices/${invoiceId}`)).Invoices[0];
const payment=(await get(`Payments/${paymentId}`)).Payments[0];
const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
assert.equal(invoice.InvoiceNumber,'300005461');assert.equal(invoice.Type,'ACCREC');
assert.equal(invoice.Status,'PAID');assert.equal(invoice.Total,71);assert.equal(invoice.AmountPaid,71);
assert.equal(invoice.AmountDue,0);assert.equal(invoice.TotalTax,0);assert.equal(invoice.CurrencyCode,'GBP');
if(invoice.AmountCredited!=null)assert.equal(invoice.AmountCredited,0);
assert.equal((invoice.CreditNotes||[]).length,0);
assert.equal(invoice.LineItems.length,1);assert.equal(invoice.LineItems[0].Description,'Associate Membership Overseas');
assert.equal(payment.Status,'AUTHORISED');assert.equal(payment.Amount,71);
assert.equal(payment.Invoice.InvoiceID,invoiceId);assert.equal(payment.Account.Name,'GBP PayPal');
const paidAt=new Date(Number(/\/Date\((\d+)/.exec(payment.Date)[1])).toISOString();
assert.equal(paidAt.slice(0,10),'2026-09-06');
const db=await connectDestination();
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  const m=(await db.query('SELECT to_jsonb(m) data FROM member m WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,member])).rows[0].data;
  assert.equal(m.email.toLowerCase(),contact.EmailAddress.toLowerCase());
  const prefs=(await db.query(`SELECT f.id field_id,f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
    WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY f.name,v.id`,[member,tenant])).rows;
  const klass=prefs.find(p=>p.name==='member_class');
  assert.equal(klass.value,'Overseas associate');
  assert.equal(prefs.find(p=>p.name==='ym_date_membership_expires').value,'01/05/2027');
  const read=async table=>(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1 AND member_id=$2 ORDER BY id`,[tenant,member])).rows.map(r=>r.data);
  const history=await read('member_membership_history');
  assert.equal((await read('membership_billing_agreements')).length,0);
  assert.equal((await read('membership_payment_plans')).length,0);
  const configs=(await db.query(`SELECT to_jsonb(c) data FROM membership_tier_config c WHERE tenant_id=$1 AND structure_scope_type='member'
    AND structure_field_id=$2 AND structure_match_value=$3 AND is_active=true
    AND effective_from<=CURRENT_DATE AND (effective_to IS NULL OR effective_to>=CURRENT_DATE)`,
  [tenant,klass.field_id,klass.value])).rows.map(r=>r.data);
  assert.equal(configs.length,1);const config=configs[0];assert.equal(config.billing_period,'annual');
  const amounts={annual_cost:71,final_cost:71,total_with_vat:71,vat_amount:0,currency:'GBP'};
  const commitment=buildRollingCommitment({config,startDate:'2026-05-02',paymentMethod:'upfront',
    paymentFrequency:'upfront',amounts,pricingSnapshot:{tier_label:klass.value,...amounts}});
  assert.equal(commitment.term_end_date,'2027-05-01');
  const record={id,tenant_id:tenant,member_id:member,config_id:config.id,...commitment,...amounts,
    membership_year:commitment.term_key,tier_label:klass.value,field_value:klass.value,billing_period:'annual',
    status:'active',payment_status:'paid',payment_method:'upfront',paid_at:paidAt,
    accounting_provider:'xero',accounting_invoice_id:invoiceId,accounting_invoice_number:invoice.InvoiceNumber,
    xero_invoice_id:invoiceId,xero_invoice_number:invoice.InvoiceNumber,
    notes:JSON.stringify({source:'operator_approved_xero_membership_reconstruction',approvalDate:'2026-10-15',
      termAuthority:'operator_approved_2026-05-02_to_2027-05-01_retained_expiry',
      paymentAuthority:'xero_authorised_paypal_payment',invoiceId,paymentId,
      scheduleAuthority:'Current member-class schedule applied by operator approval; not evidence of its existence at the reconstructed start.',
      futureCollectionConsent:false,providerWrites:0})};
  const existing=history.find(h=>h.id===id);
  assert.equal(history.length,existing?1:0);
  if(!existing){
    assert.notEqual(mode,'verify','Repair missing');
    assert.equal((await db.query(`SELECT count(*)::int n FROM member_membership_history WHERE tenant_id=$1
      AND (accounting_invoice_id=$2 OR xero_invoice_id=$2)`,[tenant,invoiceId])).rows[0].n,0);
    const pin={record,prefs};
    if(mode==='apply'){
      assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/dry-run.json`,'utf8')),pin);
      save(`before-${Date.now()}`,{m,history,prefs,invoice,payment,record});
    }
    const keys=Object.keys(record);
    await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
      keys.map(k=>record[k]!==null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
    if(mode==='dry-run')save('dry-run',pin);
  }
  const current=(await read('member_membership_history'))[0];
  for(const [key,value] of Object.entries(record)){
    if(key==='paid_at')assert.equal(Date.parse(current[key]),Date.parse(value));
    else assert.deepEqual(current[key],value,key);
  }
  assert.deepEqual((await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1',[member])).rows[0].data,m);
  assert.equal((await read('membership_billing_agreements')).length,0);
  assert.equal((await read('membership_payment_plans')).length,0);
  const display=shapePersistedCommitment(current);
  assert.equal(display.lifecycle,'current');assert.equal(display.paymentMethod,'upfront');
  assert.equal(display.paymentFrequency,'upfront');assert.equal(display.agreedPrice,71);
  assert.equal(display.structureName,'2026-2027 Overseas Associate member');
  assert.equal(display.startDate,'2026-05-02');assert.equal(display.endDate,'2027-05-01');
  assert.equal(display.renewalDate,'2027-05-02');
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  save(`${mode}-${Date.now()}`,{current,display,replay:!!existing});
  console.log(JSON.stringify({mode,replay:!!existing,invoice:invoice.InvoiceNumber,amount:71,paidAt,
    start:display.startDate,end:display.endDate,renewal:display.renewalDate,providerWrites:0}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}

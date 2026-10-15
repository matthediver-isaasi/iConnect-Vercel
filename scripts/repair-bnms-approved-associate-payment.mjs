// One owner-approved paid term. Xero GET-only; no activation/send/collection APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {buildRollingCommitment} from '../api/_lib/rollingMembershipCommitment.js';
const mode=process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db', member='c639f9e1-918b-4dc7-bb3b-6d565e1b608d';
const configId='9b1615b0-0699-487f-8ee5-c34746b72493', contactId='8ee6c299-cb0b-468c-b01a-c10445b8d545';
const classField='87f120ff-92e6-4d52-944b-9ba9d7b1fac0', expiryField='2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae';
const paymentId='8448aa1f-9cfe-4269-b38d-a23620ea6417';
const dir='generated-artifacts/bnms-approved-associate-payment';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name,data)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2),{mode:0o600});
const stableId=label=>{
  const h=createHash('sha256').update(`${tenant}:${member}:${label}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
const {projectMembershipPaymentReport}=await import('../api/_lib/membershipPaymentReport.js');
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path,params={}){
  await new Promise(r=>setTimeout(r,2100));
  const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}?${new URLSearchParams(params)}`,{
    headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
  });
  assert.equal(r.status,200,`Xero GET failed: ${r.status}`);
  return r.json();
}
const contact=(await get(`Contacts/${contactId}`)).Contacts[0];
const invoices=(await get('Invoices',{where:`Contact.ContactID==Guid("${contactId}")`,page:'1'})).Invoices;
assert.ok(invoices.length<100,'Contact requires paginated review');
const membershipInvoices=invoices.filter(i=>!['VOIDED','DELETED'].includes(i.Status)
  && i.LineItems.some(l=>/membership/i.test(l.Description)));
assert.equal(membershipInvoices.length,1,'Membership invoice evidence changed');
const invoice=membershipInvoices[0];
assert.equal(invoice.InvoiceNumber,'300005501');
assert.equal(invoice.Status,'PAID');assert.equal(invoice.CurrencyCode,'GBP');
assert.equal(invoice.Total,71);assert.equal(invoice.AmountPaid,71);
assert.equal(invoice.AmountDue,0);assert.equal(invoice.AmountCredited,0);
assert.equal(invoice.LineItems.length,1);assert.equal(invoice.LineItems[0].Description,'Associate Membership UK');
assert.ok(invoice.Payments.some(p=>p.PaymentID===paymentId));
const payment=(await get(`Payments/${paymentId}`)).Payments[0];
assert.equal(payment.Status,'AUTHORISED');assert.equal(payment.Amount,71);
assert.equal(payment.Invoice.InvoiceID,invoice.InvoiceID);
const paidAt=new Date(Number(/\/Date\((\d+)/.exec(payment.Date)[1])).toISOString();
assert.equal(paidAt.slice(0,10),'2026-09-11');
const db=await connectDestination();
try{
  await db.query(mode==='verify'?'BEGIN READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  const m=(await db.query(`select id,tenant_id,email,login_enabled from member where id=$1 and tenant_id=$2 ${mode==='verify'?'':'FOR UPDATE'}`,[member,tenant])).rows[0];
  assert.ok(m);assert.equal(m.email.toLowerCase(),contact.EmailAddress.toLowerCase());
  const read=async table=>(await db.query(`select to_jsonb(r) data from ${table} r where tenant_id=$1 and member_id=$2 order by id`,[tenant,member])).rows.map(r=>r.data);
  const prefs=async()=>(await db.query(`select v.id,v.field_id,v.value from member_preference_value v
    join preference_field f on f.id=v.field_id where v.member_id=$1 and f.tenant_id=$2 order by v.id`,[member,tenant])).rows;
  const before={member:m,prefs:await prefs(),history:await read('member_membership_history')};
  for(const table of ['membership_billing_agreements','membership_payment_plans'])assert.equal((await read(table)).length,0);
  const config=(await db.query(`select to_jsonb(c) data from membership_tier_config c where tenant_id=$1 and id=$2`,[tenant,configId])).rows[0]?.data;
  assert.ok(config?.is_active);assert.equal(config.structure_field_id,classField);
  assert.equal(config.structure_match_value,'Associate');assert.equal(config.billing_period,'annual');
  assert.equal(config.start_mode,'immediate');assert.ok(config.effective_from<='2026-09-11');
  assert.ok(!config.effective_to||config.effective_to>='2026-09-11');
  const amounts={annual_cost:71,final_cost:71,vat_amount:0,total_with_vat:71,currency:'GBP'};
  const commitment=buildRollingCommitment({config,startDate:'2026-09-11',paymentMethod:'upfront',
    paymentFrequency:'upfront',amounts,pricingSnapshot:{tier_label:'Associate',...amounts}});
  assert.equal(commitment.term_end_date,'2027-09-10');
  const record={id:stableId('paid-membership'),tenant_id:tenant,member_id:member,config_id:configId,
    ...commitment,...amounts,membership_year:commitment.term_key,tier_label:'Associate',field_value:'Associate',
    billing_period:'annual',status:'active',payment_status:'paid',payment_method:'upfront',paid_at:paidAt,
    accounting_provider:'xero',accounting_invoice_id:invoice.InvoiceID,accounting_invoice_number:invoice.InvoiceNumber,
    xero_invoice_id:invoice.InvoiceID,xero_invoice_number:invoice.InvoiceNumber,
    notes:JSON.stringify({source:'operator_approved_associate_paid_term',approvalDate:'2026-10-15',
      termAuthority:'Owner explicitly approved 11/09/2026–10/09/2027; coverage is an approved assumption, not stated by Xero.',
      classificationAuthority:'Owner approved correcting CPD Guest to Associate on verified Associate Membership UK payment.',
      scheduleAuthority:'Applied current class-matched annual Associate schedule, retaining verified £71 settlement.',
      paymentAuthority:'Xero authorised payment',paymentId,invoiceId:invoice.InvoiceID,
      futureCollectionConsent:false,providerWrites:0})};
  const existing=before.history.find(h=>h.id===record.id);
  assert.equal(before.history.length,existing?1:0,'Unexpected membership history');
  const classRows=before.prefs.filter(p=>p.field_id===classField);
  const expiryRows=before.prefs.filter(p=>p.field_id===expiryField);
  assert.equal(classRows.length,1);
  if(!existing){
    assert.notEqual(mode,'verify');assert.equal(classRows[0].value,'CPD Guest');assert.equal(expiryRows.length,0);
    assert.equal((await db.query(`select count(*)::int n from member_membership_history where tenant_id=$1
      and (accounting_invoice_id=$2 or xero_invoice_id=$2)`,[tenant,invoice.InvoiceID])).rows[0].n,0);
    if(mode==='apply'){
      const pin=JSON.parse(fs.readFileSync(`${dir}/dry-run.json`));
      assert.ok(Date.now()-pin.at<1800000,'Repeat dry run before applying');
      assert.deepEqual(pin.before,before);assert.deepEqual(pin.record,record);
      save(`before-${Date.now()}`,{before,record,invoice,payment});
    }
    const keys=Object.keys(record);
    await db.query(`insert into member_membership_history (${keys.join(',')}) values (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
      keys.map(k=>record[k]!==null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
    const changed=await db.query(`update member_preference_value set value='Associate' where id=$1 and member_id=$2 and value='CPD Guest'`,[classRows[0].id,member]);
    assert.equal(changed.rowCount,1);
    await db.query(`insert into member_preference_value (id,member_id,field_id,value) values ($1,$2,$3,$4)`,
      [stableId('expiry-preference'),member,expiryField,'10/09/2027']);
  }
  const after=await read('member_membership_history');
  assert.equal(after.length,1);
  for(const [key,value] of Object.entries(record)){
    if(key==='paid_at')assert.equal(Date.parse(after[0][key]),Date.parse(value));
    else assert.deepEqual(after[0][key],value,key);
  }
  const afterPrefs=await prefs();
  assert.equal(afterPrefs.filter(p=>p.field_id===classField).length,1);
  assert.equal(afterPrefs.find(p=>p.field_id===classField).value,'Associate');
  assert.equal(afterPrefs.filter(p=>p.field_id===expiryField).length,1);
  assert.equal(afterPrefs.find(p=>p.field_id===expiryField).value,'10/09/2027');
  const untouched=rows=>rows.filter(p=>![classField,expiryField].includes(p.field_id));
  assert.deepEqual(untouched(afterPrefs),untouched(before.prefs));
  assert.deepEqual((await db.query('select id,tenant_id,email,login_enabled from member where id=$1',[member])).rows[0],m);
  for(const table of ['membership_billing_agreements','membership_payment_plans'])assert.equal((await read(table)).length,0);
  const display=shapePersistedCommitment(after[0],new Date('2026-10-15'));
  assert.equal(display.lifecycle,'current');assert.equal(display.structureName,config.name);
  assert.equal(display.startDate,'2026-09-11');assert.equal(display.endDate,'2027-09-10');
  const report=projectMembershipPaymentReport({tenantId:tenant,members:[m],history:after,configs:[config],today:'2026-10-15'});
  assert.ok(report.some(r=>r.memberId===member&&r.historyId===record.id),'Missing from payment report');
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  if(mode==='dry-run')save('dry-run',{at:Date.now(),before,record});
  save(`${mode}-${Date.now()}`,{record,display,report,replay:!!existing});
  console.log(JSON.stringify({mode,replay:!!existing,classification:'Associate',status:'active',payment:'paid',
    start:display.startDate,end:display.endDate,renewal:display.renewalDate,invoice:invoice.InvoiceNumber,providerWrites:0}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}

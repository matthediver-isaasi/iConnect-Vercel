// Owner-approved six-month entitlement; no inferred annual price or renewal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const mode=process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',member='6c73e1ab-a2c4-42cd-ac46-12a6a6a53d4b';
const oldId='2791c1c8-f595-5e8f-abb9-61a94349b8f7',id='852c0873-130a-4250-9900-21b023851f62';
const invoiceId='9eff34d1-af54-415c-8546-d7ffa5e1b7cb';
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
const response=await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`,{
  headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
  signal:AbortSignal.timeout(30000)});
assert.equal(response.status,200);
const invoice=(await response.json()).Invoices[0];
assert.equal(invoice.InvoiceNumber,'300005496');
assert.equal(invoice.Contact.Name,'Pairavi Gnanananthan');
assert.equal(invoice.Status,'PAID');
assert.equal(invoice.CurrencyCode,'GBP');
assert.equal(invoice.Total,30.5);
assert.equal(invoice.TotalTax,0);
assert.equal(invoice.AmountPaid,30.5);
assert.equal(invoice.AmountDue,0);
assert.equal(invoice.AmountCredited||0,0);
assert.equal(invoice.LineItems.length,1);
assert.match(invoice.LineItems[0].Description,/Trainee Membership.*6-Month Eligibility/);
assert.equal(invoice.Payments.length,1);
assert.equal(invoice.Payments[0].Amount,30.5);
const paidAt=new Date(Number(invoice.Payments[0].Date.match(/\d+/)[0])).toISOString();
const db=await connectDestination();
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const rows=(await db.query('select to_jsonb(h) data from member_membership_history h where tenant_id=$1 and member_id=$2 for update',[tenant,member])).rows.map(r=>r.data);
  const replay=rows.find(r=>r.id===id);
  assert.equal(rows.length,replay?2:1);
  if(mode==='verify')assert.ok(replay);
  assert.ok(rows.some(r=>r.id===oldId&&r.status==='expired'));
  const capture=async()=>{
    const result={};
    for(const table of ['member','member_preference_value','historical_member_invoice','membership_billing_agreements','membership_payment_plans']){
      result[table]=(await db.query(`select to_jsonb(t) data from ${table} t where ${table==='member'?'id':'member_id'}=$1 order by id`,[member])).rows.map(r=>r.data);
    }
    return result;
  };
  const before=await capture();
  const expiry=before.member_preference_value.find(v=>v.id==='448c1d97-3a58-481c-89dc-b8fc1e94bfe9');
  assert.equal(expiry.value,replay?'31/03/2027':'28/02/2027');
  assert.ok(before.historical_member_invoice.some(i=>i.xero_document_id===invoiceId&&i.invoice_number==='300005496'));
  assert.equal(before.membership_billing_agreements.length,0);
  const record={id,tenant_id:tenant,member_id:member,membership_year:'2026/2027 (6-month eligibility)',
    term_start_date:'2026-10-01',term_end_date:'2027-03-31',tier_label:'Trainee — 6-month eligibility',
    field_value:'Trainee',billing_period:'one_off',status:'active',payment_status:'paid',payment_method:'upfront',
    paid_at:paidAt,currency:'GBP',final_cost:30.5,vat_amount:0,total_with_vat:30.5,
    accounting_provider:'xero',accounting_sync_status:null,accounting_invoice_id:invoiceId,
    accounting_invoice_number:'300005496',xero_invoice_id:invoiceId,xero_invoice_number:'300005496',
    notes:replay?.notes||JSON.stringify({source:'owner_approved_six_month_invoice_reconstruction',version:1,
      termAuthority:'owner_explicit_1_october_2026_six_months',historicalDurationMonths:6,
      invoiceId,invoiceNumber:'300005496',paymentId:invoice.Payments[0].PaymentID,paidAmount:30.5,
      historicalPriceAuthority:'live_xero_six_month_membership_line',annualPriceAuthority:'not_inferred',
      futureCollectionConsent:false,renewalScheduleAuthority:'not_assigned',providerWrites:0})};
  if(!replay){
    if(mode==='apply'){
      fs.mkdirSync('generated-artifacts/six-month-membership',{recursive:true,mode:0o700});
      fs.writeFileSync(`generated-artifacts/six-month-membership/before-${Date.now()}.json`,
        JSON.stringify({rows,before,record},null,2),{mode:0o600,flag:'wx'});
    }
    const keys=Object.keys(record);
    await db.query(`insert into member_membership_history (${keys.join(',')}) values (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record));
    const changed=await db.query("update member_preference_value set value='31/03/2027' where id=$1 and member_id=$2 and value='28/02/2027'",[expiry.id,member]);
    assert.equal(changed.rowCount,1);
  }
  const after=(await db.query('select to_jsonb(h) data from member_membership_history h where tenant_id=$1 and member_id=$2',[tenant,member])).rows.map(r=>r.data);
  assert.equal(after.length,2);
  assert.deepEqual(after.find(r=>r.id===oldId),rows.find(r=>r.id===oldId));
  const current=after.find(r=>r.id===id);
  for(const [key,value] of Object.entries(record)){
    if(key==='paid_at')assert.equal(Date.parse(current[key]),Date.parse(value));else assert.deepEqual(current[key],value,key);
  }
  const expected=structuredClone(before);
  expected.member_preference_value.find(v=>v.id===expiry.id).value='31/03/2027';
  const captured=await capture();
  // Preference writes intentionally invalidate previously issued survey
  // eligibility. Retain that security trigger; do not restore its old revision.
  assert.equal(captured.member[0].survey_invitation_revision,
    expected.member[0].survey_invitation_revision+(replay?0:1));
  expected.member[0].survey_invitation_revision=captured.member[0].survey_invitation_revision;
  expected.member[0].updated_at=captured.member[0].updated_at;
  assert.deepEqual(captured,expected);
  const {selectCanvasCommitment,buildCanvasSummary}=await import('../api/membership/canvas-summary.js');
  const today=new Date().toISOString().slice(0,10);
  const selected=selectCanvasCommitment(after.map(r=>({...r,membership_source:'personal'})),[],today);
  assert.equal(selected.record.id,id);
  const summary=buildCanvasSummary({selected,today});
  assert.equal(summary.membership.state,'active');
  assert.equal(selected.record.term_end_date,'2027-03-31');
  assert.equal(summary.payment.state,'paid');
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({mode,replay:!!replay,period:[current.term_start_date,current.term_end_date],
    invoice:current.accounting_invoice_number,paid:30.5,status:summary.membership.state,payment:summary.payment.state,
    priorHistoryPreserved:true,providerWrites:0}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}

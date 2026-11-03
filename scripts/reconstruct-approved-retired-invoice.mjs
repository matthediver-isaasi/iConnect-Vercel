// Scoped owner-approved historical repair; no provider requests or collections.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {connectDestination} from './lib/member-index-destination.mjs';
import {buildRollingCommitment} from '../api/_lib/rollingMembershipCommitment.js';
const apply=process.argv.includes('--apply');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',member='d0a62d02-5140-4e21-936e-3834b560ff6d';
const id='44b5eff6-a7ac-4c20-8f09-30d63f298923';
const db=await connectDestination();
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const m=(await db.query('SELECT * FROM member WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[member,tenant])).rows[0];
  assert.ok(m);assert.equal(m.membership_paused,false);assert.equal(m.membership_cancelled,false);
  const histories=(await db.query('SELECT * FROM member_membership_history WHERE member_id=$1 AND tenant_id=$2',[member,tenant])).rows;
  assert.ok(!histories.length || (histories.length===1&&histories[0].id===id));
  const prefs=(await db.query(`SELECT v.*,f.name FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
    WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.name IN ('member_class','ym_date_membership_expires')`,[member,tenant])).rows;
  assert.equal(prefs.find(p=>p.name==='member_class')?.value,'Retired');
  assert.equal(prefs.find(p=>p.name==='ym_date_membership_expires')?.value,'22/10/2026');
  const invoices=(await db.query(`SELECT * FROM historical_member_invoice WHERE member_id=$1 AND tenant_id=$2 AND invoice_number='300004651'`,[member,tenant])).rows;
  assert.equal(invoices.length,1);const invoice=invoices[0];
  assert.equal(Number(invoice.amount_minor),4700);assert.equal(invoice.status,'paid');
  assert.equal(invoice.accounting_payment_status,'paid');
  assert.equal(invoice.xero_document_id,'7c55deb6-d199-4f1e-a7b9-abc13ef2e39b');
  const config=(await db.query(`SELECT * FROM membership_tier_config WHERE tenant_id=$1 AND id='bec78df3-4233-456b-8da5-c1d50263aa5a'`,[tenant])).rows[0];
  assert.equal(config.structure_match_value,'Retired');assert.equal(config.renewal_grace_days,90);assert.equal(config.renewal_open_days,90);
  const amounts={annual_cost:47,final_cost:47,vat_amount:0,total_with_vat:47,currency:'GBP'};
  const commitment=buildRollingCommitment({config,startDate:'2025-10-23',paymentMethod:'upfront',paymentFrequency:'upfront',amounts});
  assert.equal(commitment.term_end_date,'2026-10-22');
  const record={id,tenant_id:tenant,member_id:member,config_id:config.id,tier_label:'Retired',field_value:'Retired',
    membership_year:commitment.term_key,...commitment,...amounts,renewal_policy_snapshot:config,
    billing_period:'annual',status:'active',payment_status:'paid',payment_method:'upfront',paid_at:null,
    accounting_provider:'xero',accounting_invoice_id:invoice.xero_document_id,accounting_invoice_number:'300004651',
    xero_invoice_id:invoice.xero_document_id,xero_invoice_number:'300004651',accounting_sync_status:null,
    notes:JSON.stringify({source:'owner_approved_retired_membership_reconstruction',approval_date:'2026-11-03',
      term_authority:'owner_approved_annual_term_from_imported_expiry',payment_authority:'imported_paid_invoice_and_retained_xero_paid_status',
      invoice_date_is_not_payment_date:true,provider_not_requeried:true,
      policy_authority:'owner_approved_current_Retired_schedule_90_day_renewal_and_grace',
      schedule_caveat:'Current schedule is approved reconstruction policy, not evidence of original purchase configuration.',
      historical_invoice_id:invoice.id,provider_writes:0,future_collection_consent:false})};
  if(!histories.length){
    if(apply){fs.mkdirSync('generated-artifacts/approved-retired-reconstruction',{recursive:true,mode:0o700});
      fs.writeFileSync(`generated-artifacts/approved-retired-reconstruction/before-${Date.now()}.json`,JSON.stringify({member:m,prefs,histories,invoice,record}),{mode:0o600,flag:'wx'});}
    const keys=Object.keys(record);
    await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,
      keys.map(k=>record[k]&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
  }
  const after=(await db.query('SELECT to_jsonb(h) AS data FROM member_membership_history h WHERE id=$1',[id])).rows[0].data;
  for(const [key,value] of Object.entries(record))assert.deepEqual(after[key],JSON.parse(JSON.stringify(value)),key);
  assert.deepEqual((await db.query('SELECT * FROM member WHERE id=$1 AND tenant_id=$2',[member,tenant])).rows[0],m);
  await db.query(apply?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({mode:apply?'applied':'rolled-back dry-run',inserted:!histories.length,termStart:after.term_start_date,termEnd:after.term_end_date,invoice:after.accounting_invoice_number,paymentStatus:after.payment_status,graceDays:config.renewal_grace_days}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}

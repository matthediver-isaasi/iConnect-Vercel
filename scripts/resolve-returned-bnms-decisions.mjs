import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connectDestination} from './lib/member-index-destination.mjs';
import {assessFormMembershipRenewalEvidence} from '../api/_lib/formMembershipRenewalEvidence.js';
const root='generated-artifacts/bnms-returned-membership-review';
const mode=process.argv[2];assert(['rehearse','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const evidence=JSON.parse(await fs.readFile(`${root}/evidence.json`,'utf8'));
const ids=['8a90afd9-82f3-5ec6-a55e-b243a5ff9de6','852c0873-130a-4250-9900-21b023851f62'];
const db=await connectDestination();
try {
 await db.query('begin isolation level serializable');
 await db.query("set local lock_timeout='5s';set local statement_timeout='30s'");
 const read=async(table,where,params)=>(await db.query(`select to_jsonb(t) row from ${table} t where ${where} order by id`,params)).rows.map(r=>r.row);
 const configs=await read('membership_tier_config', "tenant_id=$1 and id=$2", [tenant,'5ab8875e-25a7-4224-a8b9-b9ff53871800']);
 const config=configs[0];assert.equal(config.structure_match_value,'Trainee');assert.equal(config.renewal_open_days,90);assert.equal(config.renewal_grace_days,90);
 const prepared=mode==='rehearse'?null:JSON.parse(await fs.readFile(`${root}/decisions-rehearse.json`,'utf8'));
 if(mode!=='verify')await db.query(`create table if not exists public.bnms_returned_decisions_audit(
 id uuid primary key,tenant_id uuid not null,member_id uuid not null,before_record jsonb not null,after_record jsonb not null,
 authority text not null,created_at timestamptz not null default now());
 alter table public.bnms_returned_decisions_audit enable row level security;
 revoke all on public.bnms_returned_decisions_audit from public,anon,authenticated,service_role;
 grant select on public.bnms_returned_decisions_audit to service_role`);
 const original=(await db.query("select pg_get_functiondef('public.guard_membership_successor_owner()'::regprocedure) def")).rows[0].def;
 const results=[];
 for(const id of ids){
  await db.query('select id from member_membership_history where id=$1 and tenant_id=$2 for update',[id,tenant]);
  const row=(await read('member_membership_history','id=$1 and tenant_id=$2',[id,tenant]))[0];
  const source=evidence.find(r=>r.histories.some(h=>h.id===id));assert(source);
  const old=source.histories.find(h=>h.id===id);
  const capture=async()=>Object.fromEntries(await Promise.all([
   ['member','id=$1'],['member_preference_value','member_id=$1'],['historical_member_invoice','member_id=$1'],
   ...Object.keys(source.related).map(t=>[t,'member_id=$1'])
  ].map(async([t,w])=>[t,await read(t,w,[source.id])])));
  const protectedBefore=await capture();
  const isHannah=id===ids[0];
  assert.equal(old.payment_status,'paid');
  if(!isHannah){
   assert.equal(old.term_start_date,'2026-10-01');assert.equal(old.term_end_date,'2027-03-31');
   assert.equal(old.final_cost,30.5);assert.equal(old.renewal_policy_snapshot,null);
  }
  const policy={...config,reviewed_historical_renewal:{
   authority:'owner_approved_future_renewal_policy_not_historical_purchase_configuration',
   preserved_term_start:old.term_start_date,preserved_term_end:old.term_end_date,preserved_price:old.final_cost,
   futureCollectionConsent:false
  }};
  const patch=isHannah?{
   status:'cancelled',payment_status:'unpaid',paid_at:null,
   notes:JSON.stringify({source:'owner_returned_workbook_payment_correction',originalNotes:old.notes,
    authority:'owner_confirmed_workbook_unpaid_and_former_over_disputed_imported_paid_evidence',
    retainedInvoiceNumber:old.accounting_invoice_number||old.xero_invoice_number,providerWrites:0})
  }:{renewal_policy_snapshot:policy};
  const expected={...old,...patch};
  if(prepared)assert.deepEqual(prepared.find(r=>r.id===id).expected,expected,'Reviewed input changed');
  if(mode==='verify'){
   assert.deepEqual(row,expected);
   const audit=(await read('bnms_returned_decisions_audit','id=$1',[id]))[0];
   assert.deepEqual(audit.before_record,old);assert.deepEqual(audit.after_record,expected);
  } else {
   assert.deepEqual(row,old);
   if(!isHannah){
    const literal=JSON.stringify(policy).replace(/'/g,"''");
    const exception=`BEGIN
     IF TG_OP='UPDATE' AND TG_TABLE_NAME='member_membership_history'
      AND OLD.id='${id}'::uuid AND OLD.tenant_id='${tenant}'::uuid
      AND OLD.member_id='${source.id}'::uuid AND OLD.renewal_policy_snapshot IS NULL
      AND NEW.renewal_policy_snapshot='${literal}'::jsonb
      AND (to_jsonb(NEW)-'renewal_policy_snapshot')=(to_jsonb(OLD)-'renewal_policy_snapshot')
     THEN RETURN NEW; END IF;`;
    await db.query(original.replace(/\bBEGIN\b/,exception));
   }
   const keys=Object.keys(patch);
   await db.query(`update member_membership_history set ${keys.map((k,i)=>`"${k}"=$${i+1}`).join(',')} where id=$${keys.length+1}`,
    [...keys.map(k=>typeof patch[k]==='object'&&patch[k]!==null?JSON.stringify(patch[k]):patch[k]),id]);
   if(!isHannah)await db.query(original);
   assert.deepEqual((await read('member_membership_history','id=$1',[id]))[0],expected);
   await db.query('insert into bnms_returned_decisions_audit(id,tenant_id,member_id,before_record,after_record,authority) values($1,$2,$3,$4,$5,$6)',
    [id,tenant,source.id,JSON.stringify(old),JSON.stringify(expected),isHannah?'Owner approved workbook payment correction':'Owner approved Trainee renewal policy; historical term preserved']);
  }
  assert.deepEqual(await capture(),protectedBefore);
  const histories=await read('member_membership_history','member_id=$1 and tenant_id=$2',[source.id,tenant]);
  if(isHannah)assert(histories.every(h=>['cancelled','canceled','void','expired_checkout'].includes(h.status)));
  else {
   const assessment=assessFormMembershipRenewalEvidence({tenantId:tenant,memberId:source.id,histories,agreements:[],successorConfig:config,now:new Date('2027-02-01T12:00:00Z')});
   assert.equal(assessment.state,'eligible_renewal',JSON.stringify(assessment));
   assert.equal(assessment.successorStart,'2027-04-01');
   await db.query('savepoint guard_probe');let blocked=false;
   try{await db.query('update member_membership_history set renewal_policy_snapshot=null where id=$1',[id]);}
   catch(e){assert.match(e.message,/immutable/);blocked=true;}
   await db.query('rollback to savepoint guard_probe');assert(blocked);
  }
  results.push({id,memberId:source.id,expected});
 }
 assert.equal((await db.query("select pg_get_functiondef('public.guard_membership_successor_owner()'::regprocedure) def")).rows[0].def,original);
 if(mode==='rehearse')await fs.writeFile(`${root}/decisions-rehearse.json`,JSON.stringify(results,null,2),{mode:0o600});
 await db.query(mode==='apply'?'commit':'rollback');
 console.log(JSON.stringify({mode,verified:results.length,otherRecordsUnchanged:true,renewalPolicyGuard:'enforced',providerWrites:0}));
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}

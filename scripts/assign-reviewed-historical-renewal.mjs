import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { createClient } from '@supabase/supabase-js';
const mode = process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const tenant='ff2df806-b321-4254-b651-3af11fccf1db', member='979d3059-213a-4c3c-aed6-064c517e7d20';
const historyId='301a1007-b2c1-5b7b-a905-fa24353903eb', configId='bec78df3-4233-456b-8da5-c1d50263aa5a';
const {gocardlessForTenant}=await import('../api/_lib/gocardless.js');
const gc=await gocardlessForTenant(tenant);
assert.equal(gc.credentials.environment,'live');
const mandate=await gc.getMandate('MD00330X5BR04C');
assert.equal(mandate.status,'cancelled');
const db=await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const read=async(table,condition,values)=>(await db.query(`select to_jsonb(t) data from ${table} t where ${condition}`,values)).rows.map(r=>r.data);
  const [before]=await read('member_membership_history','id=$1 and tenant_id=$2',[historyId,tenant]);
  assert.equal(before.member_id,member);
  assert.equal(before.total_with_vat,156.48);
  assert.equal(before.payment_status,'paid');
  assert.equal(before.term_start_date,'2025-10-01');
  assert.equal(before.term_end_date,'2026-09-30');
  assert.equal(before.billing_agreement_id,null);
  const notes=JSON.parse(before.notes);
  assert.equal(notes.source,'approved_settled_monthly_historical_membership');
  assert.equal(notes.cashPaidMinor,9128);
  assert.equal(notes.creditedMinor,6520);
  assert.equal(notes.instalments.length,12);
  const [config]=await read('membership_tier_config','id=$1 and tenant_id=$2',[configId,tenant]);
  assert.equal(config.structure_match_value,'Retired');
  assert.equal(config.renewal_grace_days,90);
  assert.equal(config.renewal_open_days,90);
  const capture=async()=>({
    member:await read('member','id=$1',[member]),
    prefs:await read('member_preference_value','member_id=$1',[member]),
    agreements:await read('membership_billing_agreements','member_id=$1',[member]),
    invoices:await read('historical_member_invoice','member_id=$1',[member]),
    elections:await read('membership_successor_election','member_id=$1',[member]),
  });
  const protectedBefore=await capture();
  assert.equal(protectedBefore.agreements.length,0);
  assert.equal(protectedBefore.elections.length,0);
  const replay=!!before.renewal_policy_snapshot?.historical_settlement_renewal;
  if(mode==='verify')assert.ok(replay);
  const policy=replay?before.renewal_policy_snapshot:{...config,historical_settlement_renewal:{
    version:1,history_id:historyId,tenant_id:tenant,member_id:member,
    approved_at:new Date().toISOString(),mandate_id:mandate.id,mandate_status:'cancelled',
    provider_verified_at:new Date().toISOString(),start:before.term_start_date,end:before.term_end_date,
    cash_minor:9128,credit_minor:6520,currency:'GBP',
    authority:'owner_assigned_future_renewal_policy_not_historical_purchase_configuration',
  }};
  assert.equal(policy.id,configId);
  const after={...before,renewal_policy_snapshot:policy};
  // Read-only overlay allows the full simulator to preflight the exact proposed
  // policy before any production change becomes visible.
  const rest=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const proxyQuery=query=>new Proxy(query,{get(target,key){
    if(key==='then')return (resolve,reject)=>target.then(result=>{
      const overlay=row=>row?.id===historyId?{...row,renewal_policy_snapshot:policy}:row;
      return resolve({...result,data:Array.isArray(result.data)?result.data.map(overlay):overlay(result.data)});
    },reject);
    const value=target[key];
    return typeof value==='function'?(...args)=>proxyQuery(value.apply(target,args)):value;
  }});
  const client={from:table=>table==='member_membership_history'?proxyQuery(rest.from(table)):rest.from(table),
    rpc:(...args)=>rest.rpc(...args)};
  const {loadFormMembershipRenewalContext}=await import('../api/_lib/formMembershipRenewalContext.js');
  const {createMembershipSimulator}=await import('../api/_lib/membershipSimulationCore.js');
  const {loadCanvasRenewalEligibility}=await import('../api/_lib/canvasRenewalEligibility.js');
  const {loadMemberGraceWarning}=await import('../api/_lib/memberGraceWarning.js');
  const now=new Date(), owner=protectedBefore.member[0], personal=[{...after,membership_source:'personal'}];
  const eligibility=await loadCanvasRenewalEligibility(client,{selected:{record:personal[0]},owner,history:personal,today:now.toISOString().slice(0,10)});
  assert.equal(eligibility.eligible,true,JSON.stringify(eligibility));
  const warning=await loadMemberGraceWarning(client,{member:owner,history:personal,now});
  assert.ok(warning&&!warning.policyUnknown&&!warning.expired,JSON.stringify(warning));
  const result=await loadFormMembershipRenewalContext(client,{tenantId:tenant,memberId:member,
    now,simulate:createMembershipSimulator(client,()=>now).simulateMembershipForMember});
  assert.equal(result.renewal.eligible,true,JSON.stringify(result.renewal));
  assert.equal(result.simulation?.success,true);
  assert.equal(result.simulation.config.id,configId);
  assert.equal(result.renewal.successorStart,'2026-10-01');
  assert.equal(result.renewal.successorEnd,'2027-09-30');
  if(!replay){
    assert.equal(before.renewal_policy_snapshot,null);
    // One-record approval, not a relaxation of purchased-policy immutability.
    // PostgreSQL DDL is transactional: other sessions never see this temporary
    // exact-value exception, and the original definition is restored below.
    const original=(await db.query("select pg_get_functiondef('public.guard_membership_successor_owner()'::regprocedure) definition")).rows[0].definition;
    const literal=JSON.stringify(policy).replace(/'/g,"''");
    const exception=`BEGIN
      IF TG_OP='UPDATE' AND TG_TABLE_NAME='member_membership_history'
        AND OLD.id='${historyId}'::uuid AND OLD.tenant_id='${tenant}'::uuid
        AND OLD.member_id='${member}'::uuid AND OLD.renewal_policy_snapshot IS NULL
        AND NEW.renewal_policy_snapshot='${literal}'::jsonb
        AND (to_jsonb(NEW)-'renewal_policy_snapshot')=(to_jsonb(OLD)-'renewal_policy_snapshot')
      THEN RETURN NEW; END IF;`;
    assert.ok(/\bBEGIN\b/.test(original));
    await db.query(original.replace(/\bBEGIN\b/,exception));
    await db.query('update member_membership_history set renewal_policy_snapshot=$1 where id=$2 and tenant_id=$3',
      [JSON.stringify(policy),historyId,tenant]);
    await db.query(original);
    assert.equal((await db.query("select pg_get_functiondef('public.guard_membership_successor_owner()'::regprocedure) definition")).rows[0].definition,original);
  }
  await db.query('SAVEPOINT immutable_policy_probe');
  let immutable=false;
  try { await db.query('update member_membership_history set renewal_policy_snapshot=null where id=$1',[historyId]); }
  catch(e){assert.match(e.message,/immutable/);immutable=true;}
  await db.query('ROLLBACK TO SAVEPOINT immutable_policy_probe');
  assert.equal(immutable,true,'Purchased-policy protection must remain enforced');
  // Exercise the real atomic reservation guard, then remove the probe within
  // the same transaction. No payment quote, provider call or collection follows.
  await db.query('SAVEPOINT reservation_probe');
  const reserved=(await db.query(`select reserve_membership_successor($1,$2,null,$3,$4,$5,'upfront','form',$6) data`,
    [tenant,member,historyId,result.renewal.successorStart,result.renewal.successorEnd,
      JSON.stringify({simulation:result.simulation,payerMemberId:member,addonLines:[]})])).rows[0].data;
  assert.equal(reserved.previous_term_id,historyId);
  await db.query('ROLLBACK TO SAVEPOINT reservation_probe');
  const [persisted]=await read('member_membership_history','id=$1',[historyId]);
  assert.deepEqual(persisted,{...before,renewal_policy_snapshot:policy});
  assert.deepEqual(await capture(),protectedBefore);
  if(mode==='apply'&&!replay){
    fs.mkdirSync('generated-artifacts/reviewed-historical-renewal',{recursive:true,mode:0o700});
    fs.writeFileSync(`generated-artifacts/reviewed-historical-renewal/before-${Date.now()}.json`,
      JSON.stringify({before,policy},null,2),{mode:0o600,flag:'wx'});
  }
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({mode,replay,portalEligible:eligibility.eligible,graceEnds:eligibility.graceEndDate,
    policyWarning:!!warning.policyUnknown,quote:{schedule:result.simulation.config.name,
      amount:result.simulation.totalWithVat,start:result.renewal.successorStart,end:result.renewal.successorEnd},
    reservationProbe:'passed_and_rolled_back',protectedRecordsUnchanged:true,providerWrites:0}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
// Minimal predecessor schema; the installed cancellation contracts are real.
const SCHEMA=`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE EXTENSION btree_gist;
CREATE TABLE tenant(id uuid PRIMARY KEY);
CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,name text,is_tenant_admin boolean DEFAULT false);
CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,role_id uuid,membership_paused boolean DEFAULT false);
CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,status text,
 payment_status text,membership_renewal_date date,term_start_date date,billing_agreement_id uuid,config_id uuid,band_id uuid,
 term_key text,commitment_snapshot jsonb,membership_source text,payment_method text);
CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
 agreement_type text,status text,provider text,environment text,gocardless_mandate_id text,metadata jsonb DEFAULT '{}');
CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
 billing_agreement_id uuid,provider text,environment text,status text,gocardless_subscription_id text,
 gocardless_mandate_id text,collection_stopped_at timestamptz,metadata jsonb DEFAULT '{}',
 completed_at timestamptz,needs_attention boolean DEFAULT false);
CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,dd_arrears_fallback_role_id uuid);
CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
 term_key text,quote jsonb,stripe_payment_intent_id text);
CREATE TABLE member_change_authority(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,source_record_id uuid);
CREATE TABLE member_membership_amendment(LIKE member_change_authority INCLUDING ALL);
CREATE TABLE membership_arrears_role_action(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,plan_id uuid,
 previous_role_id uuid,assigned_role_id uuid,restored_at timestamptz,restoration_status text,updated_at timestamptz,
 CONSTRAINT membership_arrears_role_action_restoration_status_check CHECK(restoration_status IS NULL
  OR restoration_status IN ('restored','manual_change_preserved','member_missing')));
CREATE TABLE membership_change_policy(tenant_id uuid PRIMARY KEY,revision bigint,policy jsonb,updated_at timestamptz,updated_by text);
CREATE TABLE member_replacement_execution(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,source_record_id uuid);
CREATE TABLE member_replacement_application(id uuid PRIMARY KEY,execution_id uuid);
CREATE FUNCTION reject_member_change_authority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable audit'; END $$;
ALTER TABLE member_membership_history ADD CONSTRAINT member_membership_history_rolling_no_overlap
 EXCLUDE USING gist(tenant_id WITH =,member_id WITH =,daterange(term_start_date,membership_renewal_date,'[)') WITH &&)
 WHERE(term_key IS NOT NULL AND status IS DISTINCT FROM 'replaced');
CREATE FUNCTION enforce_rolling_membership_commitment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM membership_payment_quote q,(SELECT NULL::jsonb payment_quote) x WHERE true
  AND q.id IS DISTINCT FROM (payment_quote->>'id')::uuid;
 RETURN NEW;
END $$;`;
const MIGRATIONS=['202612310047_member_cancellation_journal','202612310048_member_cancellation_access',
 '202612310049_member_cancellation_admission','202612310050_member_cancellation_recovery',
 '202612310056_retired_membership_arrears_roles','202612310057_retired_membership_role_outcome',
 '202612310058_pending_cancellation_conflicts','202612310059_withdraw_pending_cancellation',
 '202702090001_member_dd_paid_period_cancellation'];

test('member paid-period cancellation fences collections, keeps access and applies only the fallback role',{timeout:180000},async()=>{
 const h=await createLocalPostgresHarness('member-dd-cancel-'),clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
   `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<3;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
   await c.connect();clients.push(c);}
  const [admin,a,b]=clients;
  await admin.query(SCHEMA);
  for(const m of MIGRATIONS)await admin.query(readFileSync(`supabase/migrations/${m}.sql`,'utf8'));
  // Readiness is the explicit installed contract.
  await a.query('SET ROLE service_role');await b.query('SET ROLE service_role');
  assert.equal((await a.query('SELECT member_dd_cancellation_available() v')).rows[0].v,true);

  const T=id(1),M=id(2),MEMBER_ROLE=id(3),FALLBACK=id(4),ADMIN_ROLE=id(5),CONFIG=id(6),H=id(7),AG=id(8),PLAN=id(9);
  await admin.query('INSERT INTO tenant VALUES($1)',[T]);
  await admin.query(`INSERT INTO role VALUES($1,$4,'Member',false),($2,$4,'Supporter',false),($3,$4,'Admin',true)`,
   [MEMBER_ROLE,FALLBACK,ADMIN_ROLE,T]);
  await admin.query('INSERT INTO member(id,tenant_id,role_id) VALUES($1,$2,$3)',[M,T,MEMBER_ROLE]);
  await admin.query('INSERT INTO membership_tier_config VALUES($1,$2,$3)',[CONFIG,T,FALLBACK]);
  await admin.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,payment_status,term_start_date,
   membership_renewal_date,billing_agreement_id,config_id,term_key,membership_source,payment_method)
   VALUES($1,$2,$3,'active','paid',current_date-200,current_date+165,$4,$5,'t1','personal','direct_debit')`,[H,T,M,AG,CONFIG]);
  await admin.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,agreement_type,status,provider,environment,gocardless_mandate_id)
   VALUES($1,$2,$3,'member','active','gocardless','sandbox','MD1')`,[AG,T,M]);
  await admin.query(`INSERT INTO membership_payment_plans(id,tenant_id,member_id,billing_agreement_id,provider,environment,status,
   gocardless_subscription_id,gocardless_mandate_id) VALUES($1,$2,$3,$4,'gocardless','sandbox','active','SB1','MD1')`,[PLAN,T,M,AG]);
  const snap=async(table,rowId)=>(await admin.query(`SELECT to_jsonb(t) j FROM ${table} t WHERE id=$1`,[rowId])).rows[0].j;
  const effective=(await admin.query("SELECT to_char(current_date+30,'YYYY-MM-DD') d")).rows[0].d;
  const paidThrough=(await admin.query("SELECT to_char(current_date+29,'YYYY-MM-DD') d")).rows[0].d;
  const authority=async(over={})=>({mode:'member_paid_period',tenantId:T,memberId:M,actorId:M,reason:'Moving abroad',
   threshold:12,successfulCollections:12,collectionsInFlight:0,effectiveDate:effective,paidThroughDate:paidThrough,
   fallbackRoleId:FALLBACK,fallbackRoleName:'Supporter',
   sourceSnapshot:await snap('member_membership_history',H),agreementSnapshot:await snap('membership_billing_agreements',AG),
   planSnapshot:await snap('membership_payment_plans',PLAN),
   providerPrepared:{fingerprint:'b'.repeat(64),authority:{provider:'gocardless',environment:'sandbox',tenantId:T,memberId:M,
    agreementId:AG,subscriptionId:'SB1',mandateId:'MD1'}},...over});
  const begin=(c,key,auth,fp='a'.repeat(64))=>c.query(
   'SELECT begin_member_dd_paid_period_cancellation($1,$2,$3,$4,$5) v',[T,M,key,fp,auth]);

  // Below the agreed threshold, another member's scope or a past boundary cannot be scheduled.
  await assert.rejects(begin(a,'member-dd:below',await authority({successfulCollections:11})),/self-scoped/);
  await assert.rejects(begin(a,'member-dd:other',await authority({actorId:id(99)})),/self-scoped/);
  await assert.rejects(begin(a,'member-dd:past',await authority({effectiveDate:paidThrough,paidThroughDate:paidThrough})),/Paid-through/);
  // An administrator fallback role is never applied.
  await admin.query('UPDATE membership_tier_config SET dd_arrears_fallback_role_id=$1',[ADMIN_ROLE]);
  await assert.rejects(begin(a,'member-dd:admin',await authority({fallbackRoleId:ADMIN_ROLE})),/fallback role/);
  await admin.query('UPDATE membership_tier_config SET dd_arrears_fallback_role_id=$1',[FALLBACK]);
  // A stale snapshot (purchase changed after preview) fails closed.
  const stale=await authority();stale.planSnapshot={...stale.planSnapshot,status:'paused'};
  await assert.rejects(begin(a,'member-dd:stale',stale),/plan changed/);

  // Double confirmation racing on two connections creates one request.
  const auth=await authority();
  const [first,second]=await Promise.all([begin(a,'member-dd:key-1',auth),begin(b,'member-dd:key-1',auth)]);
  assert.equal(first.rows[0].v.id,second.rows[0].v.id);
  const request=first.rows[0].v;
  assert.equal(request.mode,'member_paid_period');assert.equal(request.timing,'paid_period');
  assert.equal(request.fallback_role_id,FALLBACK);assert.equal(request.previous_role_id,MEMBER_ROLE);
  await assert.rejects(begin(a,'member-dd:key-1',auth,'c'.repeat(64)),/different evidence/);
  // A different key for the same purchase cannot create a second cancellation.
  await assert.rejects(begin(b,'member-dd:key-2',auth));

  // Collections are fenced immediately; access and status are unchanged.
  const fenced=await admin.query('SELECT collection_stopped_at FROM membership_payment_plans');
  assert.ok(fenced.rows[0].collection_stopped_at);
  await assert.rejects(admin.query('UPDATE membership_payment_plans SET collection_stopped_at=NULL'),/stopped collections/);
  const member=await admin.query('SELECT role_id,membership_cancelled FROM member');
  assert.deepEqual(member.rows[0],{role_id:MEMBER_ROLE,membership_cancelled:false});
  assert.equal((await admin.query('SELECT status FROM member_membership_history WHERE id=$1',[H])).rows[0].status,'active');
  // Provider stop recovery is due now, not at the boundary.
  const job=await admin.query("SELECT next_attempt_at<=now()+interval '1 second' due FROM member_cancellation_job WHERE kind='lifecycle'");
  assert.equal(job.rows[0].due,true);

  // Automatic renewal of the cancelled agreement is rejected.
  await assert.rejects(admin.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,agreement_type,status,provider,metadata)
   VALUES($1,$2,$3,'member','mandate_pending','gocardless',$4)`,[id(20),T,M,{dd:{renewal_of_agreement_id:AG}}]),
   /cannot be renewed automatically|pending cancellation/);

  // Exactly one provider stop claim, before access ends.
  const claim=c=>c.query('SELECT claim_member_dd_cancellation_provider_stop($1,$2,$3,$4) v',[T,M,request.id,M]);
  const claims=await Promise.all([claim(a),claim(b)]);
  assert.equal(claims.filter(r=>r.rows[0].v.claimed).length,1);
  const token=claims.find(r=>r.rows[0].v.claimed).rows[0].v.operation.claim_token;
  const observe=evidence=>a.query('SELECT record_member_dd_cancellation_provider_stop($1,$2,$3,$4,$5,$6) v',
   [T,M,request.id,M,token,evidence]);
  await assert.rejects(observe({state:'stopped',subscriptionId:'OTHER'}),/another subscription/);
  // A timeout stays uncertain; a later "active" read never re-opens a submission.
  assert.equal((await observe({state:'uncertain',subscriptionId:'SB1'})).rows[0].v.state,'uncertain');
  assert.equal((await observe({state:'active',subscriptionId:'SB1'})).rows[0].v.state,'uncertain');
  assert.equal((await claim(a)).rows[0].v.claimed,false);
  assert.equal((await observe({state:'stopped',subscriptionId:'SB1'})).rows[0].v.state,'stopped');

  // The boundary cannot be applied early, by the administrator path, or withdrawn.
  const apply=c=>c.query('SELECT apply_member_dd_paid_period_cancellation($1,$2,$3,$4) v',[T,M,request.id,M]);
  await assert.rejects(apply(a),/not yet effective/);
  await assert.rejects(a.query('SELECT apply_member_cancellation_access($1,$2,$3,$4)',[T,M,request.id,M]),/own lifecycle/);
  await assert.rejects(a.query('SELECT withdraw_member_cancellation($1,$2,$3,$4,$5)',[T,M,request.id,M,'changed mind']),
   /cannot be withdrawn|Provider execution/);

  // At the boundary: purchase retired, fallback role applied, no login block.
  await admin.query("ALTER TABLE member_cancellation_request DISABLE TRIGGER USER");
  await admin.query('UPDATE member_cancellation_request SET effective_date=current_date,paid_through_date=current_date-1');
  await admin.query("ALTER TABLE member_cancellation_request ENABLE TRIGGER USER");
  const [applied,again]=await Promise.all([apply(a),apply(b)]);
  assert.equal(applied.rows[0].v.role_outcome,'applied');assert.equal(again.rows[0].v.id,request.id);
  const after=await admin.query('SELECT role_id,membership_cancelled FROM member');
  assert.deepEqual(after.rows[0],{role_id:FALLBACK,membership_cancelled:false});
  assert.equal((await admin.query('SELECT status FROM member_membership_history WHERE id=$1',[H])).rows[0].status,'cancelled_by_request');
  const events=(await admin.query('SELECT kind FROM member_cancellation_event ORDER BY created_at')).rows.map(r=>r.kind);
  assert.ok(events.includes('member_confirmed')&&events.includes('access_ended'));

  // Late receipts go to review; the outcome is recorded once and never reactivates.
  const finance=(state)=>a.query('SELECT record_member_dd_cancellation_finance($1,$2,$3,$4,$5,$6) v',
   [T,M,request.id,M,state,{latePayments:['PM9']}]);
  assert.equal((await finance('manual_review')).rows[0].v.financial_state,'manual_review');
  assert.equal((await finance('settled')).rows[0].v.financial_state,'manual_review');
  assert.equal((await admin.query('SELECT status FROM member_membership_history WHERE id=$1',[H])).rows[0].status,'cancelled_by_request');

  for(const role of ['anon','authenticated']){
   const grants=await admin.query(`SELECT has_function_privilege($1,'begin_member_dd_paid_period_cancellation(uuid,uuid,text,text,jsonb)','EXECUTE') b,
    has_function_privilege($1,'apply_member_dd_paid_period_cancellation(uuid,uuid,uuid,uuid)','EXECUTE') a`,[role]);
   assert.deepEqual(grants.rows[0],{b:false,a:false});
  }
 }finally{
  for(const c of clients)await c.end().catch(()=>{});
  if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});

test('fallback role compare-and-set preserves manual and administrator roles',{timeout:180000},async()=>{
 // Covered by the role outcome branches in apply_member_dd_paid_period_cancellation;
 // see the main test for the applied outcome. Manual changes are exercised here.
 const h=await createLocalPostgresHarness('member-dd-role-'),clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
   `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);
  await c.query(SCHEMA);
  for(const m of MIGRATIONS)await c.query(readFileSync(`supabase/migrations/${m}.sql`,'utf8'));
  const T=id(1),FALLBACK=id(4),ADMIN_ROLE=id(5),CONFIG=id(6);
  await c.query('INSERT INTO tenant VALUES($1)',[T]);
  await c.query(`INSERT INTO role VALUES($1,$4,'Member',false),($2,$4,'Supporter',false),($3,$4,'Admin',true),($5,$4,'Committee',false)`,
   [id(3),FALLBACK,ADMIN_ROLE,T,id(30)]);
  await c.query('INSERT INTO membership_tier_config VALUES($1,$2,$3)',[CONFIG,T,FALLBACK]);
  const cases=[[40,id(30),'manual_change_preserved'],[50,ADMIN_ROLE,'administrator_preserved'],[60,FALLBACK,'already_assigned']];
  for(const [n,laterRole,expected] of cases){
   const M=id(n),H=id(n+1),AG=id(n+2),PLAN=id(n+3);
   await c.query('INSERT INTO member(id,tenant_id,role_id) VALUES($1,$2,$3)',[M,T,id(3)]);
   await c.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,term_start_date,membership_renewal_date,
    billing_agreement_id,config_id,term_key) VALUES($1,$2,$3,'active',current_date-10,current_date+355,$4,$5,'t')`,[H,T,M,AG,CONFIG]);
   await c.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,agreement_type,status,provider,environment)
    VALUES($1,$2,$3,'member','active','gocardless','sandbox')`,[AG,T,M]);
   await c.query(`INSERT INTO membership_payment_plans(id,tenant_id,member_id,billing_agreement_id,provider,environment,status,metadata)
    VALUES($1,$2,$3,$4,'gocardless','sandbox','active','{"collection_mode":"dynamic"}')`,[PLAN,T,M,AG]);
   const snap=async(table,rowId)=>(await c.query(`SELECT to_jsonb(t) j FROM ${table} t WHERE id=$1`,[rowId])).rows[0].j;
   const dates=(await c.query("SELECT to_char(current_date+20,'YYYY-MM-DD') e,to_char(current_date+19,'YYYY-MM-DD') p")).rows[0];
   const r=(await c.query('SELECT begin_member_dd_paid_period_cancellation($1,$2,$3,$4,$5) v',[T,M,`member-dd:${n}`,'a'.repeat(64),{
    mode:'member_paid_period',tenantId:T,memberId:M,actorId:M,reason:'Retiring',threshold:12,successfulCollections:12,
    effectiveDate:dates.e,paidThroughDate:dates.p,fallbackRoleId:FALLBACK,
    sourceSnapshot:await snap('member_membership_history',H),agreementSnapshot:await snap('membership_billing_agreements',AG),
    planSnapshot:await snap('membership_payment_plans',PLAN),providerPrepared:null}])).rows[0].v;
   // Dynamic collection plans have no provider subscription: the fence is the stop.
   assert.equal((await c.query('SELECT count(*)::int n FROM member_cancellation_provider_stop WHERE id=$1',[r.id])).rows[0].n,0);
   await c.query('UPDATE member SET role_id=$1 WHERE id=$2',[laterRole,M]);
   await c.query('ALTER TABLE member_cancellation_request DISABLE TRIGGER USER');
   await c.query('UPDATE member_cancellation_request SET effective_date=current_date,paid_through_date=current_date-1 WHERE id=$1',[r.id]);
   await c.query('ALTER TABLE member_cancellation_request ENABLE TRIGGER USER');
   const out=(await c.query('SELECT apply_member_dd_paid_period_cancellation($1,$2,$3,$4) v',[T,M,r.id,M])).rows[0].v;
   assert.equal(out.role_outcome,expected);
   assert.equal((await c.query('SELECT role_id FROM member WHERE id=$1',[M])).rows[0].role_id,laterRole);
  }
 }finally{
  for(const c of clients)await c.end().catch(()=>{});
  if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});

test('a renewed member with a retained predecessor agreement and a fully collected plan can confirm',{timeout:180000},async()=>{
 const h=await createLocalPostgresHarness('member-dd-renewed-'),clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
   `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);
  await c.query(SCHEMA);
  for(const m of MIGRATIONS)await c.query(readFileSync(`supabase/migrations/${m}.sql`,'utf8'));
  const T=id(1),M=id(2),FALLBACK=id(4),CONFIG=id(6),PREV_H=id(10),PREV_AG=id(11),PREV_PLAN=id(12),H=id(20),AG=id(21),PLAN=id(22);
  await c.query('INSERT INTO tenant VALUES($1)',[T]);
  await c.query(`INSERT INTO role VALUES($1,$3,'Member',false),($2,$3,'Supporter',false)`,[id(3),FALLBACK,T]);
  await c.query('INSERT INTO member(id,tenant_id,role_id) VALUES($1,$2,$3)',[M,T,id(3)]);
  await c.query('INSERT INTO membership_tier_config VALUES($1,$2,$3)',[CONFIG,T,FALLBACK]);
  // Auto-renewal retains the predecessor agreement as 'active'; its term has ended.
  await c.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,term_start_date,membership_renewal_date,
   billing_agreement_id,config_id,term_key) VALUES($1,$2,$3,'expired',current_date-400,current_date-35,$4,$5,'t0'),
   ($6,$2,$3,'active',current_date-35,current_date+330,$7,$5,'t1')`,[PREV_H,T,M,PREV_AG,CONFIG,H,AG]);
  await c.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,agreement_type,status,provider,environment,metadata)
   VALUES($1,$3,$4,'member','active','gocardless','live','{}'),($2,$3,$4,'member','active','gocardless','live',$5)`,
   [PREV_AG,AG,T,M,{dd:{renewal_of_agreement_id:PREV_AG}}]).catch(async error=>{throw error;});
  // Current fixed plan finished after every instalment was collected.
  await c.query(`INSERT INTO membership_payment_plans(id,tenant_id,member_id,billing_agreement_id,provider,environment,status,
   gocardless_subscription_id,completed_at) VALUES($1,$3,$4,$5,'gocardless','live','expired','SB0',now()-interval '40 days'),
   ($2,$3,$4,$6,'gocardless','live','expired','SB1',now())`,[PREV_PLAN,PLAN,T,M,PREV_AG,AG]);
  const snap=async(table,rowId)=>(await c.query(`SELECT to_jsonb(t) j FROM ${table} t WHERE id=$1`,[rowId])).rows[0].j;
  const dates=(await c.query("SELECT to_char(current_date+330,'YYYY-MM-DD') e,to_char(current_date+329,'YYYY-MM-DD') p")).rows[0];
  const authority=async(lineage)=>({mode:'member_paid_period',tenantId:T,memberId:M,actorId:M,reason:'Retiring',
   threshold:12,successfulCollections:24,effectiveDate:dates.e,paidThroughDate:dates.p,fallbackRoleId:FALLBACK,
   lineageAgreementIds:lineage,sourceSnapshot:await snap('member_membership_history',H),
   agreementSnapshot:await snap('membership_billing_agreements',AG),planSnapshot:await snap('membership_payment_plans',PLAN),
   providerPrepared:null});
  const begin=async(key,auth)=>(await c.query('SELECT begin_member_dd_paid_period_cancellation($1,$2,$3,$4,$5) v',
   [T,M,key,'a'.repeat(64),auth])).rows[0].v;
  // Without the signed lineage, the retained predecessor is a competing arrangement.
  await assert.rejects(begin('member-dd:no-lineage',await authority([AG])),/Another membership purchase/);
  // A predecessor that is still collecting is never treated as lineage.
  await c.query(`UPDATE membership_payment_plans SET status='active' WHERE id=$1`,[PREV_PLAN]);
  await assert.rejects(begin('member-dd:collecting',await authority([AG,PREV_AG])),/Another membership purchase/);
  await c.query(`UPDATE membership_payment_plans SET status='expired' WHERE id=$1`,[PREV_PLAN]);
  const r=await begin('member-dd:renewed',await authority([AG,PREV_AG]));
  assert.equal(r.mode,'member_paid_period');
  // A completed plan needs no provider stop; collections are still fenced.
  assert.equal((await c.query('SELECT count(*)::int n FROM member_cancellation_provider_stop')).rows[0].n,0);
  assert.ok((await c.query('SELECT collection_stopped_at FROM membership_payment_plans WHERE id=$1',[PLAN])).rows[0].collection_stopped_at);
 }finally{
  for(const c of clients)await c.end().catch(()=>{});
  if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});

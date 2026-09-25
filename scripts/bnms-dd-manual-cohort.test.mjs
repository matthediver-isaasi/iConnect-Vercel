import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from './test-support/local-postgres-harness.mjs';
import {canonicalRows,scopeHash,stableId,assertExecutableManifest,SCOPE_SHA,MIGRATION,INVOICE_MIGRATION} from './bnms-dd-manual-cohort.mjs';
import {MANUAL_TENANT as tenant,MANUAL_WORKBOOK,MANUAL_GATE} from '../api/_lib/bnmsManualCohort.js';
import {hash} from './bnms-dd-beta-invoices.mjs';

test('manual scope is independent, deterministic, and incomplete contact evidence cannot authorize execution',()=>{
 assert.equal(stableId('plan','test'),stableId('plan','test'));
 assert.notEqual(stableId('plan','test'),stableId('agreement','test'));
 assert.throws(()=>assertExecutableManifest({blockers:['missing contacts']}),/unresolved/);
 assert.throws(()=>assertExecutableManifest({blockers:[],members:[],noOps:[]}),/scope/);
});

test('manual 95 disposable SQL: atomic scope, ownership, unforgeable entitlement, October gate, invoice uncertainty and restricted grants',async()=>{
 const h=await createLocalPostgresHarness('manual-95-');
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 let started=false,c,other;
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const prices=[...Array(42).fill(1300),...Array(16).fill(392),...Array(13).fill(1066),...Array(21).fill(508),...Array(3).fill(592)];
 const people=prices.map((price,i)=>({memberId:id(i+1),customerId:`CU${i+1}`,mandateId:`MD${i+1}`,monthlyQuoteMinor:price}));
 const evidenceFor=(m,i)=>({...m,dd:{accepted_at:null,billing_request_mode:'migration_existing_mandate',collection_policy:{pricing_policy:'dynamic'},invoicing_mode:'per_instalment'},
  structure:{nominal_code:'200'},accounting:{contactId:id(501+i),contactEmail:`test${i}@example.test`,
   xeroTenantId:'3d57dce6-2205-462f-abf6-9c7cbf00be23',bankAccountId:'d115eacc-1fa7-476d-844e-d3d7f07f5db5',revenueCode:'200',
   contactEvidence:{ContactID:id(501+i),ContactStatus:'ACTIVE',EmailAddress:`test${i}@example.test`},
   bankEvidence:{AccountID:'d115eacc-1fa7-476d-844e-d3d7f07f5db5',Status:'ACTIVE',Type:'BANK',CurrencyCode:'GBP'}}});
 const fixtureScope=scopeHash(people);
 const q=async(sql,args)=>c.query(sql,args);
 const rejected=async(sql,args,pattern)=>{await q('SAVEPOINT bad');await assert.rejects(q(sql,args),pattern);await q('ROLLBACK TO bad');};
 try{
  run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();
  other=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await other.connect();
  // Capture and CAS both use PostgreSQL JSON under UTC, retaining sub-ms
  // timestamps, nulls, dates and numeric values without JS Date coercion.
  await c.query(`CREATE TEMP TABLE codec_guard (
    stamp timestamptz, local_stamp timestamp, day date, amount numeric, optional text);
    INSERT INTO codec_guard VALUES ('2026-09-25T12:34:56.123456+01:00',
    '2026-09-25T12:34:56.123456','2026-10-01',13.00,NULL)`);
  await c.query("SET TIME ZONE 'Europe/London'");
  await c.query('BEGIN');
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  const captured=(await c.query('SELECT to_jsonb(t) row FROM codec_guard t')).rows[0].row;
  const decoded=JSON.parse(JSON.stringify((await c.query('SELECT * FROM codec_guard')).rows[0]));
  assert.notEqual(hash(captured),hash(decoded));
  assert.equal(captured.stamp,'2026-09-25T11:34:56.123456+00:00');
  assert.equal(captured.optional,null);
  await c.query('COMMIT');
  await c.query("SET TIME ZONE 'America/New_York'");
  await c.query('BEGIN');
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  assert.equal(hash(captured),hash((await c.query('SELECT to_jsonb(t) row FROM codec_guard t')).rows[0].row));
  for(const mutation of ["stamp=stamp+interval '1 microsecond'","amount=amount+0.01",
    "optional=''","day=day+1","local_stamp=local_stamp+interval '1 microsecond'"]){
    await c.query('SAVEPOINT mutation');
    await c.query(`UPDATE codec_guard SET ${mutation}`);
    assert.notEqual(hash(captured),hash((await c.query('SELECT to_jsonb(t) row FROM codec_guard t')).rows[0].row));
    await c.query('ROLLBACK TO mutation');
  }
  await c.query('ROLLBACK');
  await q(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
   CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,status text,membership_paused boolean);
   CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,gocardless_customer_id text,
    gocardless_mandate_id text,provider text,environment text,status text,metadata jsonb,commitment_snapshot jsonb);
   CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
    gocardless_mandate_id text,gocardless_subscription_id text,provider text,environment text,status text,metadata jsonb,
    dynamic_next_check_at timestamptz,dynamic_next_collection_date date,collection_stopped_at timestamptz,amount_minor integer,currency text);
   CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
    status text,payment_status text,paid_at timestamptz,term_start_date date,term_end_date date,commitment_snapshot jsonb);
   CREATE TABLE gocardless_collection_reservations(id uuid PRIMARY KEY,tenant_id uuid,plan_id uuid,billing_agreement_id uuid,
    currency text,due_date date,requested_charge_date date,amount_minor integer,collection_number integer,provider_evidence jsonb,gocardless_payment_id text);
   CREATE TABLE gocardless_payments(id uuid PRIMARY KEY,tenant_id uuid,plan_id uuid,gocardless_payment_id text,
    gocardless_mandate_id text,status text,environment text,currency text,amount_minor integer,charge_date date);`);
  const schema=readFileSync(MIGRATION,'utf8');
  await q(schema);
  await q(readFileSync(INVOICE_MIGRATION,'utf8'));
  await q('BEGIN');
  await q(`INSERT INTO bnms_dd_manual_manifest VALUES($1,$2,$3,'{}',now())`,['a'.repeat(64),tenant,MANUAL_WORKBOOK]);
  await rejected('SET CONSTRAINTS ALL IMMEDIATE',[],/Exact 95-person/);
  await q('ROLLBACK');
  assert.equal(Number((await q('SELECT count(*) n FROM bnms_dd_manual_manifest')).rows[0].n),0);
  // Fixture-only replacement of exact identity digest, never production migration/source.
  const body=schema.slice(schema.indexOf('CREATE FUNCTION public.bnms_manual_complete_scope()'),schema.indexOf('-- The immutable, unique manifest'))
   .replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION').replace(SCOPE_SHA,fixtureScope);
  await q(body);
  for(const scenario of ['tampered-source','missing-release','changed-economics','extra-member','valid']){
  await q('BEGIN');
  await q(`SELECT pg_advisory_xact_lock(hashtextextended('bnms-manual-95:ddbc1a3d',0))`);
  assert.equal((await other.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('bnms-manual-95:ddbc1a3d',0)) locked`)).rows[0].locked,false);
  await q('INSERT INTO bnms_dd_manual_manifest(sha256,tenant_id,workbook_sha256,evidence) VALUES($1,$2,$3,$4)',
   ['a'.repeat(64),tenant,MANUAL_WORKBOOK,{members:people.map(evidenceFor),approval:{
    legacyCollectorHandover:'user_confirmed_all_95_disabled_no_other_collections',invoicePreflight:'explicit_user_no_invoice_retrieval',
    recognitionFrom:'2026-09-24',recognitionUntil:'2027-10-01'}}]);
  const cohort=scenario==='extra-member'?[...people,{memberId:id(96),customerId:'CU96',mandateId:'MD96',monthlyQuoteMinor:1300}]:people;
  const releases=[];
  for(let i=0;i<cohort.length;i++){
   const m=cohort[i],agreement=id(101+i),plan=id(201+i),history=id(301+i),adoption=id(401+i);
   const dd={accepted_at:null,billing_request_mode:'migration_existing_mandate',collection_policy:{pricing_policy:'dynamic'},invoicing_mode:'per_instalment'};
   const metadata={dd,collection_mode:'dynamic',dynamic_first_date:'2026-10-01',bnms_manual_cohort:MANUAL_WORKBOOK};
   const evidence=evidenceFor(m,i);
   if(i===0&&scenario==='tampered-source')evidence.sourceTampered=true;
   if(i===0&&scenario==='changed-economics')evidence.monthlyQuoteMinor++;
   await q('INSERT INTO member VALUES($1,$2,$3,false)',[m.memberId,tenant,'active']);
   await q("INSERT INTO membership_billing_agreements VALUES($1,$2,$3,$4,$5,'gocardless','live','first_payment_pending',$6,'{}')",[agreement,tenant,m.memberId,m.customerId,m.mandateId,metadata]);
   await q("INSERT INTO membership_payment_plans VALUES($1,$2,$3,$4,$5,NULL,'gocardless','live','first_payment_pending',$6,$7,'2026-10-01',NULL,$8,'GBP')",[plan,tenant,m.memberId,agreement,m.mandateId,metadata,MANUAL_GATE,m.monthlyQuoteMinor]);
   await q("INSERT INTO member_membership_history VALUES($1,$2,$3,$4,'pending_payment_setup','unpaid',NULL,'2026-10-01','2027-09-30','{}')",[history,tenant,m.memberId,agreement]);
   await q('INSERT INTO bnms_dd_manual_adoption(id,tenant_id,member_id,customer_id,mandate_id,agreement_id,plan_id,history_id,workbook_sha256,manifest_sha256,evidence_sha256,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [adoption,tenant,m.memberId,m.customerId,m.mandateId,agreement,plan,history,MANUAL_WORKBOOK,'a'.repeat(64),'b'.repeat(64),evidence]);
   if(!(scenario==='missing-release'&&i===94))releases.push({id:id(601+i),tenant_id:tenant,
    member_id:m.memberId,adoption_id:adoption,plan_id:plan,manifest_sha256:'a'.repeat(64),processing_not_before:MANUAL_GATE});
  }
  // A single multi-row statement must have the same deferred safety contract.
  await q(`INSERT INTO bnms_dd_manual_release(id,tenant_id,member_id,adoption_id,plan_id,manifest_sha256,processing_not_before)
   SELECT id,tenant_id,member_id,adoption_id,plan_id,manifest_sha256,processing_not_before
   FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,tenant_id uuid,member_id uuid,adoption_id uuid,plan_id uuid,manifest_sha256 text,processing_not_before timestamptz)`,
   [JSON.stringify(releases)]);
  if(scenario!=='valid'){
   await assert.rejects(q('SET CONSTRAINTS ALL IMMEDIATE'),scenario==='tampered-source'?/manifest authority/:/Exact 95-person/);
   await q('ROLLBACK');
   assert.equal(Number((await q('SELECT count(*) n FROM bnms_dd_manual_manifest')).rows[0].n),0);
   continue;
  }
  await q('SET CONSTRAINTS ALL IMMEDIATE');
  // Rechecking does not use a forgeable session flag or create writes.
  await q('SET CONSTRAINTS ALL DEFERRED');
  await q('SET CONSTRAINTS ALL IMMEDIATE');
  await q('COMMIT');
  }
  assert.equal(Number((await q('SELECT count(*) n FROM bnms_dd_manual_membership_recognition')).rows[0].n),95);
  await q('BEGIN');
  await rejected('DELETE FROM bnms_dd_manual_release',[],/immutable/);
  await rejected("UPDATE bnms_dd_manual_manifest SET evidence='{}'",[],/immutable/);
  await rejected('INSERT INTO bnms_dd_manual_release SELECT * FROM bnms_dd_manual_release LIMIT 1',[],/duplicate key/);
  await rejected("UPDATE member_membership_history SET payment_status='paid'",[],/first managed/);
  await rejected("UPDATE membership_billing_agreements SET metadata='{}'",[],/terms/);
  await rejected('UPDATE membership_payment_plans SET member_id=$1 WHERE id=$2',[id(2),id(201)],/owner/);
  await q('SET LOCAL ROLE service_role');
  await rejected("INSERT INTO bnms_dd_manual_manifest VALUES($1,$2,$3,'{}',now())",['c'.repeat(64),tenant,MANUAL_WORKBOOK],/permission denied/);
  assert.equal(Number((await q('SELECT count(*) n FROM bnms_dd_manual_membership_recognition')).rows[0].n),95);await q('RESET ROLE');
  // Old worker direct reservation is blocked by DB clock before the October gate.
  if(Date.now()<Date.parse(MANUAL_GATE))await rejected(
   "INSERT INTO gocardless_collection_reservations VALUES($1,$2,$3,$4,'GBP','2026-10-01','2026-10-01',1300,1,$5,NULL)",
   [id(901),tenant,id(201),id(101),{status:'active',checked_at:new Date().toISOString(),next_possible_charge_date:'2026-10-01'}],/October 1/);
  await q('ROLLBACK');
  // Completed journal read has zero additional writes; invoice mismatches fail before any claim.
  const before=(await q('SELECT count(*) n FROM bnms_dd_manual_adoption')).rows[0].n;
  await q('BEGIN READ ONLY');await q('SELECT * FROM bnms_dd_manual_release');await q('ROLLBACK');
  assert.equal((await q('SELECT count(*) n FROM bnms_dd_manual_adoption')).rows[0].n,before);
  await assert.rejects(q('SELECT bnms_manual_claim_invoice($1,$2,$3,$4)',[tenant,id(201),'PMunknown',{}]),/canonical collection/);
  // Advance only the disposable function clocks, never production SQL or evidence.
  for(const name of ['bnms_manual_reservation_gate','bnms_manual_payment_guard','bnms_manual_claim_invoice']){
   const definition=(await q("SELECT pg_get_functiondef(oid) body FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace",[name])).rows[0].body;
   await q(definition.replaceAll('clock_timestamp()',"(TIMESTAMPTZ '2026-10-01 00:05:00 Europe/London')"));
  }
  const providerEvidence={status:'active',checked_at:'2026-09-30T23:04:00Z',next_possible_charge_date:'2026-10-01'};
  await q("INSERT INTO gocardless_collection_reservations VALUES($1,$2,$3,$4,'GBP','2026-10-01','2026-10-01',1300,1,$5,NULL)",
   [id(901),tenant,id(201),id(101),providerEvidence]);
  await q('BEGIN');
  await rejected('UPDATE gocardless_collection_reservations SET amount_minor=1299 WHERE id=$1',[id(901)],/amount/);
  await rejected("UPDATE gocardless_collection_reservations SET provider_evidence=provider_evidence||'{\"checked_at\":\"2026-10-01T00:00:00Z\"}' WHERE id=$1",[id(901)],/immutable/);
  await rejected('INSERT INTO membership_billing_agreements(id,tenant_id,member_id) VALUES($1,$2,$3)',[id(9998),tenant,id(1)],/duplicate/);
  await q('ROLLBACK');
  await q("UPDATE gocardless_collection_reservations SET gocardless_payment_id='PMmanaged',provider_evidence=provider_evidence||'{\"status\":\"pending_submission\"}' WHERE id=$1",[id(901)]);
  await q("INSERT INTO gocardless_payments VALUES($1,$2,$3,'PMmanaged','MD1','confirmed','live','GBP',1300,'2026-10-01')",[id(902),tenant,id(201)]);
  const identity={contactId:id(501),xeroTenantId:'3d57dce6-2205-462f-abf6-9c7cbf00be23',revenueCode:'200',currency:'GBP',
   amountMinor:1300,paymentReference:'GoCardless DD: PMmanaged',idempotencyKey:'unique-invoice',paymentIdempotencyKey:'unique-settlement'};
  const claim=(await q('SELECT bnms_manual_claim_invoice($1,$2,$3,$4) value',[tenant,id(201),'PMmanaged',identity])).rows[0].value;
  assert.ok(claim.token);
  await assert.rejects(q('SELECT bnms_manual_claim_invoice($1,$2,$3,$4)',[tenant,id(201),'PMmanaged',identity]),/uncertain; never re-POST/);
  await q('SELECT bnms_manual_link_invoice($1,$2,$3)',[claim.id,claim.token,id(903)]);
  const replay=(await q('SELECT bnms_manual_claim_invoice($1,$2,$3,$4) value',[tenant,id(201),'PMmanaged',identity])).rows[0].value;
  assert.equal(replay.invoice_id,id(903));assert.equal(replay.token,null);
  assert.equal(Number((await q('SELECT count(*) n FROM bnms_manual_invoice_operations')).rows[0].n),1);
  await assert.rejects(q('SELECT bnms_manual_claim_invoice($1,$2,$3,$4)',[tenant,id(201),'PMmanaged',{...identity,contactId:id(502)}]),/ownership/);
  await q('SELECT bnms_manual_assert_invoice($1,$2,$3,$4,$5)',[tenant,id(201),'PMmanaged',id(903),id(501)]);
  const untouched=id(9999);
  await q("INSERT INTO membership_billing_agreements(id,tenant_id) VALUES($1,$2)",[untouched,tenant]);
  await q("UPDATE membership_billing_agreements SET status='active' WHERE id=$1",[untouched]);
  assert.equal((await q('SELECT status FROM membership_billing_agreements WHERE id=$1',[untouched])).rows[0].status,'active');
 }finally{
  if(other)await other.end();if(c)await c.end();
  if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);await h.cleanup();
 }
});
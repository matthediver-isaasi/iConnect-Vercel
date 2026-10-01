import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { betaReleaseManifest, validateBetaScope, validateBetaHandover, verifyBetaReleaseSchema, releaseBeta, readBetaReleaseEvidence, assertBetaEvidenceFresh, assertBetaReleaseFresh, assertBetaReleaseCommitFresh, assertBetaReleaseReplay, betaManualHoldBody, betaGuardMatches, stateHash, MIGRATION } from './bnms-dd-beta-release.mjs';
import { parseBetaReleaseArgs, safeBetaReleaseError, main as betaReleaseMain } from './run-bnms-dd-beta-release.mjs';
import { TENANT_ID,BATCH_HASH } from './bnms-dd-beta-invoices.mjs';
import { fingerprint } from './bnms-dd-pilot-history.mjs';
import { BNMS_BETA_REVENUE, betaAccountingMapping } from '../api/_lib/bnmsBetaAccounting.js';
const betaIds=Object.keys(BNMS_BETA_REVENUE);
const uuid=n=>n>=11&&n<=20?betaIds[n-11]:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const accountingFor=memberId=>{const mapping=betaAccountingMapping(memberId);return {mapping,
  bankAccountId:mapping.bank_account_id,xeroTenantId:mapping.xero_tenant_id,revenueCode:mapping.revenue_account_code};};
test('release CLI/scope/readiness refuse identity overrides, ambiguous handover and unreviewed apply',()=>{
  for(const args of [['--apply'],['--out','/tmp/a','--member','x'],['--schema','--out','/tmp/a'],['--out','/tmp/a','--replay','/tmp/old'],['--apply','--out','/tmp/a',`--review-sha256=${'a'.repeat(64)}`]])assert.throws(()=>parseBetaReleaseArgs(args));
  assert.equal(parseBetaReleaseArgs(['--schema']).apply,false);
  assert.equal(parseBetaReleaseArgs(['--out','/tmp/a','--proof','/tmp/p','--attestation','/tmp/attestation']).attestation,'/tmp/attestation');
  assert.throws(()=>parseBetaReleaseArgs(['--out','/tmp/a','--deployed']),/Unsupported/);
  assert.throws(()=>validateBetaScope({tenant_id:TENANT_ID,evidence_sha256:BATCH_HASH,evidence:{}},Array(10).fill({})),/immutable/);
  assert.throws(()=>validateBetaHandover({tenantId:TENANT_ID,batchHash:BATCH_HASH,automaticLegacyCollectionsDisabled:true},[uuid(1)]));
  const memberIds=betaIds;
  const handover={tenantId:TENANT_ID,batchHash:BATCH_HASH,memberIds,automaticLegacyCollectionsDisabled:true,
    confirmedAt:'2026-09-20T00:00:00Z',confirmedBy:'Fixture reviewer',evidenceReference:'isolated fixture'};
  validateBetaHandover(handover,memberIds);
  assert.throws(()=>validateBetaHandover({...handover,memberIds:memberIds.slice(1)},memberIds));
  const report={tenantId:TENANT_ID,batchHash:BATCH_HASH,handover,globalBlockers:[],stateHash:'fixture',
    members:memberIds.map(memberId=>({memberId,accounting:accountingFor(memberId),blockers:[],provider:{mandate:{next_possible_charge_date:'2026-09-24'}}}))};
  assert.throws(()=>betaReleaseManifest(report,null),/deployment proof/);
  const proof={deploymentId:'fixture',commit:'fixture',sourceHashes:{}};
  assert.throws(()=>betaReleaseManifest(report,{...proof,
    provenance:{kind:'user-supplied-local-vercel-attestation'}}),/provenance/);
  const manifest=betaReleaseManifest(report,proof);
  assert.equal(manifest.processingNotBefore,'2026-09-30T23:00:00Z');
  assert.equal(manifest.members.length,10);
  report.members[0].blockers.push('external subscription exists');
  assert.throws(()=>betaReleaseManifest(report,proof),/blocked/);
  assert.equal(stateHash({rows:[{id:'a',value:1,updated_at:'before'}]}),stateHash({rows:[{updated_at:'after',value:1,id:'a'}]}));
  assert.notEqual(stateHash({rows:[{id:'a',value:1}]}),stateHash({rows:[{id:'a',value:2}]}));
});

test('oldest evidence and handover age include the entire scan and transaction, not just end time',()=>{
  const r={observedAt:'2026-09-20T10:00:00Z',completedAt:'2026-09-20T10:14:00Z',
    handover:{confirmedAt:'2026-09-19T10:15:00Z'}};
  assertBetaEvidenceFresh(r,new Date('2026-09-20T10:15:00Z'));
  assert.throws(()=>assertBetaEvidenceFresh(r,new Date('2026-09-20T10:15:00.001Z')),/Oldest readiness/);
  assert.throws(()=>assertBetaEvidenceFresh({...r,handover:{confirmedAt:'2026-09-19T10:13:59Z'}},new Date('2026-09-20T10:14:00Z')),/24 hours/);
  assert.throws(()=>assertBetaEvidenceFresh({...r,completedAt:'2026-09-20T09:00:00Z'},new Date('2026-09-20T10:14:00Z')),/Oldest readiness/);
  assert.throws(()=>assertBetaEvidenceFresh({...r,handover:{confirmedAt:'2026-09-21T00:00:00Z'}},new Date('2026-09-20T10:14:00Z')),/24 hours/);
});
test('readiness captures its oldest timestamp before its first database read',async()=>{
  const order=[];
  await assert.rejects(readBetaReleaseEvidence({from(){order.push('database');throw Error('fixture stop');}},
    {now(){order.push('clock');return new Date('2026-09-20T10:00:00Z');}}),/fixture stop/);
  assert.deepEqual(order,['clock','database']);
});

test('beta attestation CLI is explicit, proof-bound and separate from schema/replay',()=>{
  const base=['--out','/tmp/beta.json','--proof','/tmp/proof.json'];
  assert.equal(parseBetaReleaseArgs(base).attestation,undefined);
  assert.equal(parseBetaReleaseArgs([...base,'--attestation','/tmp/curl.json']).apply,false);
  assert.equal(parseBetaReleaseArgs([...base,'--attestation','/tmp/curl.json','--apply',
    `--review-sha256=${'a'.repeat(64)}`]).apply,true);
  for(const args of [
    ['--out','/tmp/beta.json','--attestation','/tmp/curl.json'],
    ['--schema','--attestation','/tmp/curl.json'],
    [...base,'--attestation'],[...base,'--attestation','--apply'],
    [...base,'--attestation','a','--attestation','b'],
    [...base,'--attestation','a','--apply'],
    ['--out','/tmp/replay.json','--replay','/tmp/original.json',`--review-sha256=${'a'.repeat(64)}`,'--attestation','a'],
    ['--out','/tmp/replay.json','--replay','/tmp/original.json',`--review-sha256=${'a'.repeat(64)}`,'--proof','a'],
  ])assert.throws(()=>parseBetaReleaseArgs(args));
  assert.equal(parseBetaReleaseArgs(['--out','/tmp/replay.json','--replay','/tmp/original.json',
    `--review-sha256=${'a'.repeat(64)}`]).apply,false);
  // Both verifier calls are exclusive branches, not a catch/fallback. Attestation
  // is passed as raw bytes/text and proof is checked before mutable readiness GETs.
  const source=betaReleaseMain.toString();
  assert.match(source,/proof=o.attestation\s*\?await verifyUserDeploymentAttestation\(reviewedProof,await readFile\(resolve\(o.attestation\),'utf8'\)\)\s*:await verifyDeploymentProof\(reviewedProof,\{vercelRequest\}\)/);
  assert.ok(source.indexOf('verifyUserDeploymentAttestation(reviewedProof')<source.indexOf('report=await readBetaReleaseEvidence'));
});

function attestedBetaFixture(){
  const proof={deploymentId:'dpl_fixture',commit:'a'.repeat(40),sourceHashes:{'vercel.json':'b'.repeat(64)},
    provenance:{kind:'user-supplied-local-vercel-attestation',agentLiveVerified:false,
      observedAt:'2026-10-01T10:57:12.044613+00:00',attestationSha256:'c'.repeat(64)}};
  const report={tenantId:TENANT_ID,batchHash:BATCH_HASH,globalBlockers:[],stateHash:'fixture',
    observedAt:'2026-10-01T11:10:00.000Z',completedAt:'2026-10-01T11:11:00.000Z',
    handover:{tenantId:TENANT_ID,batchHash:BATCH_HASH,memberIds:betaIds,automaticLegacyCollectionsDisabled:true,
      confirmedAt:'2026-10-01T10:50:00.000Z',confirmedBy:'Mock reviewer',evidenceReference:'Mock handover'},
    members:betaIds.map((memberId,index)=>({memberId,adoptionId:uuid(index+1),planId:uuid(index+21),
      accounting:accountingFor(memberId),blockers:[],provider:{mandate:{next_possible_charge_date:'2026-10-08'}}}))};
  return {report,proof};
}
test('beta attestation provenance is strict and original digest/time remain in the review hash',()=>{
  const {report,proof}=attestedBetaFixture(),manifest=betaReleaseManifest(report,proof);
  assert.deepEqual(manifest.production.provenance,proof.provenance);
  const reviewed=fingerprint(manifest);
  for(const patch of [
    {observedAt:'2026-10-01T10:58:12.044613+00:00'},{attestationSha256:'d'.repeat(64)},
  ])assert.notEqual(fingerprint(betaReleaseManifest(report,{...proof,provenance:{...proof.provenance,...patch}})),reviewed);
  for(const provenance of [null,{},false,{...proof.provenance,kind:'machine-verified'},
    {...proof.provenance,agentLiveVerified:true},{...proof.provenance,attestationSha256:'invalid'},
    {...proof.provenance,observedAt:'2026-02-30T10:57:12.044Z'},{...proof.provenance,observedAt:'not-a-date'}])
    assert.throws(()=>betaReleaseManifest(report,{...proof,provenance}),/provenance|timestamp/);
  const machine={...proof};delete machine.provenance;
  assert.doesNotThrow(()=>betaReleaseManifest(report,machine));
});
test('beta attestation original freshness cannot be renewed by readiness and includes lock waits',()=>{
  const {report,proof}=attestedBetaFixture();
  assertBetaReleaseFresh(report,proof,new Date('2026-10-01T11:12:12.043Z'));
  for(const instant of ['2026-10-01T11:12:12.044Z','2026-10-01T11:12:13.000Z']){
    assertBetaEvidenceFresh(report,new Date(instant));
    assert.throws(()=>assertBetaReleaseFresh(report,proof,new Date(instant)),/attestation.*15 minutes/);
  }
  assert.throws(()=>assertBetaReleaseFresh(report,{...proof,provenance:{...proof.provenance,
    observedAt:'2026-10-01T11:13:00.000Z'}},new Date('2026-10-01T11:12:00.000Z')),/future-dated/);
  // Keep the existing readiness and handover budgets as independent gates.
  assert.throws(()=>assertBetaReleaseFresh({...report,observedAt:'2026-10-01T10:00:00.000Z'},
    proof,new Date('2026-10-01T11:12:00.000Z')),/Oldest readiness/);
  assert.throws(()=>assertBetaReleaseFresh({...report,handover:{...report.handover,
    confirmedAt:'2026-09-30T10:00:00.000Z'}},proof,new Date('2026-10-01T11:12:00.000Z')),/24 hours/);
  const source=releaseBeta.toString();
  assert.match(source,/assertBetaReleaseFresh\(report,proof,now\(\)\);\s*await c.query\(`LOCK TABLE/);
  assert.match(source,/assertHistoricalInvoicesComplete\(histories,links\);\s*assertBetaReleaseFresh\(report,proof,now\(\)\);\s*if\(!apply\)/);
});
test('beta attestation expires against final database clock and rolls back rather than committing',async()=>{
  const {report,proof}=attestedBetaFixture();
  for(const [clock,expired] of [['2026-10-01T11:12:12.043Z',false],['2026-10-01T11:12:12.044Z',true]]){
    const seen=[],c={query:async sql=>{seen.push(sql);return {rows:[{checked_at:clock}]};}};
    const transaction=async()=>{
      try{await assertBetaReleaseCommitFresh(c,report,proof);await c.query('COMMIT');}
      catch(error){await c.query('ROLLBACK');throw error;}
    };
    if(expired)await assert.rejects(transaction(),/attestation.*15 minutes/);
    else await transaction();
    assert.deepEqual(seen,['SELECT clock_timestamp() AS checked_at',expired?'ROLLBACK':'COMMIT']);
  }
  assert.match(releaseBeta.toString(),/await assertBetaReleaseCommitFresh\(c,report,proof\);\s*await c.query\('COMMIT'\)/);
  assert.match(releaseBeta.toString(),/catch\(e\)\{await c.query\('ROLLBACK'\);throw e;\}/);
});
test('beta attestation completed replay validates immutable provenance without historical freshness recheck',()=>{
  const {report,proof}=attestedBetaFixture(),manifest=betaReleaseManifest(report,proof),hash=fingerprint(manifest);
  const prior=manifest.members.map(m=>({adoption_id:m.adoptionId,member_id:m.memberId,plan_id:m.planId,
    evidence_sha256:hash,evidence:{...m,production:proof,handover:report.handover,readinessObservedAt:report.observedAt}}));
  assert.doesNotThrow(()=>assertBetaReleaseReplay(prior,manifest,hash,report,proof));
  assert.throws(()=>assertBetaReleaseFresh(report,proof,new Date('2026-10-02T11:00:00.000Z')));
  for(const mutate of [
    rows=>rows.pop(),rows=>rows[1]=rows[0],
    rows=>rows[0].evidence.production.provenance.attestationSha256='d'.repeat(64),
    rows=>rows[0].evidence.production.provenance.observedAt='2026-10-01T11:00:00.000Z',
    rows=>rows[0].evidence.production.provenance.agentLiveVerified=true,
    rows=>rows[0].evidence_sha256='d'.repeat(64),rows=>rows[0].member_id='wrong',
  ]){
    const changed=structuredClone(prior);mutate(changed);
    assert.throws(()=>assertBetaReleaseReplay(changed,manifest,hash,report,proof),/reconciliation/);
  }
  const source=releaseBeta.toString();
  assert.match(source,/if\(prior.length\)\{\s*assertBetaReleaseReplay\(prior,manifest,hash,report,proof\);\s*await c.query\('ROLLBACK'\);return \{mode:'release_replay',hash,writes:0,readinessRevalidated:false\};\s*\}\s*assertBetaReleaseFresh/);
});

test('beta schema accepts only exact pinned manual timing evolution and unchanged guard security',()=>{
  const sql=readFileSync(MIGRATION,'utf8'),name='bnms_dd_beta_hold_guard';
  const original=[...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(\) RETURNS trigger[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)].find(m=>m[1]===name)[2];
  const manualSql=readFileSync(new URL('../supabase/migrations/20261123_gocardless_manual_collection.sql',import.meta.url),'utf8');
  const patched=betaManualHoldBody(original,manualSql);
  assert.equal(createHash('sha256').update(patched).digest('hex'),'f49d2c772cbcdfaea56a866d9c6e34cce54b6e07ada4ee35524fd8854e71bfba');
  const row={prosrc:patched,prosecdef:false,proconfig:['search_path=public'],nspname:'public',lanname:'plpgsql',
    returns_trigger:true,provolatile:'v',owner:'postgres'};
  assert.equal(betaGuardMatches(row,name,patched),true);
  assert.equal(betaGuardMatches({...row,prosrc:original},name,original),true);
  for(const patch of [{prosrc:patched+' '},{prosrc:patched.replace('AND NOT public.gocardless_manual_reservation_authorized','OR public.gocardless_manual_reservation_authorized')},
    {prosecdef:true},{proconfig:['search_path=public, pg_temp']},{owner:'service_role'},
    {nspname:'other'},{lanname:'sql'},{returns_trigger:false},{provolatile:'s'}])
    assert.equal(betaGuardMatches({...row,...patch},name,patched),false);
  assert.throws(()=>betaManualHoldBody(original,manualSql+' '),/hash differs/);
  assert.throws(()=>betaManualHoldBody(original.replace('clock_timestamp()<released.processing_not_before','true'),manualSql),/gate source/);
  assert.match(verifyBetaReleaseSchema.toString(),/inspectContract\(c,manualSql,\{requireManual:true,allowExistingAuditRows:true\}\)/);
});
test('beta schema diagnostics collect independent mismatches in one mock-only read pass',async()=>{
  const seen=[],c={query:async sql=>{assert.match(sql,/^\s*SELECT/);seen.push(sql);return {rows:[]};}};
  await assert.rejects(verifyBetaReleaseSchema(c),error=>{
    assert.ok(error.betaSchemaMismatches.some(m=>m.includes('function/security')));
    assert.ok(error.betaSchemaMismatches.some(m=>m.includes('trigger')));
    assert.ok(error.betaSchemaMismatches.some(m=>m.includes('RLS')));
    assert.ok(error.betaSchemaMismatches.some(m=>m.includes('columns')));
    assert.ok(error.betaSchemaMismatches.some(m=>m.includes('constraints')));
    const safe=safeBetaReleaseError(error);
    assert.deepEqual(safe.schemaMismatches,error.betaSchemaMismatches);return true;
  });
  assert.ok(seen.length>=9);
});
test('beta diagnostic output preserves completed readiness before SQL and sanitizes failures',()=>{
  const source=betaReleaseMain.toString();
  assert.ok(source.indexOf("mode:'readiness_collected_pending_validation'")<source.indexOf("stage='sql_release_validation'"));
  assert.match(source,/mode:'beta_readiness_stopped',stage,\.\.\.safeBetaReleaseError\(error\)/);
  assert.deepEqual(safeBetaReleaseError({code:'42501'}),{reason:'Database validation failed',sqlState:'42501'});
  assert.ok(!JSON.stringify(safeBetaReleaseError(Error('Bearer private-token member@example.test'))).includes('private-token'));
});

test('isolated PostgreSQL beta arming is atomic, immutable, October-gated and first-confirmed-payment activated',{timeout:60000},async()=>{
  const h=await createLocalPostgresHarness('beta-release-'),{root,data,socket}=h;
  const run=(cmd,args,input)=>{const r=spawnSync(cmd,args,{input,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const conn=['-h',socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'];
  const sql=input=>run('psql',conn,input);
  const reject=(input,pattern)=>{const r=spawnSync('psql',conn,{input,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,pattern);};
  let started=false,c;
  try{
    run('initdb',['-D',data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -k ${socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    sql(`
      CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
      CREATE FUNCTION bnms_dd_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable';END$$;
      CREATE TABLE bnms_dd_beta_batch(id uuid PRIMARY KEY,evidence_sha256 text);
      CREATE TABLE bnms_dd_beta_adoption(id uuid PRIMARY KEY,batch_id uuid,tenant_id uuid,member_id uuid,
        plan_id uuid,agreement_id uuid,history_id uuid,mandate_id text,customer_id text,evidence jsonb,UNIQUE(id,tenant_id,member_id));
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
        provider text,environment text,gocardless_mandate_id text,gocardless_subscription_id text,
        collection_stopped_at timestamptz,status text,metadata jsonb,updated_at timestamptz);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,provider text,environment text,
        gocardless_mandate_id text,gocardless_customer_id text,status text,metadata jsonb,updated_at timestamptz,needs_attention boolean,attention_reason text);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
        status text,payment_status text,paid_at timestamptz,updated_at timestamptz,notes text,term_start_date date,final_cost numeric);
      CREATE TABLE gocardless_collection_reservations(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,plan_id uuid,billing_agreement_id uuid,
        collection_number integer,due_date date,requested_charge_date date,amount_minor integer,currency text,provider_evidence jsonb,gocardless_payment_id text);
      CREATE TABLE gocardless_payments(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,gocardless_payment_id text,gocardless_mandate_id text,status text,charge_date date);
      CREATE FUNCTION bnms_dd_beta_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'old hold';END$$;
      CREATE FUNCTION bnms_dd_beta_canonical_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'old hold';END$$;
      CREATE FUNCTION bnms_dd_beta_protect_payment() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
        IF NEW.gocardless_payment_id='historical' THEN RAISE EXCEPTION 'historical evidence immutable';END IF;RETURN NEW;END$$;
      CREATE TRIGGER bnms_dd_beta_plan_hold BEFORE UPDATE ON membership_payment_plans FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_hold_guard();
      CREATE TRIGGER bnms_dd_beta_reservation_hold BEFORE INSERT OR UPDATE ON gocardless_collection_reservations FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_hold_guard();
      CREATE TRIGGER bnms_dd_beta_agreement_hold BEFORE UPDATE ON membership_billing_agreements FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_canonical_guard();
      CREATE TRIGGER bnms_dd_beta_history_hold BEFORE UPDATE ON member_membership_history FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_canonical_guard();
      CREATE TRIGGER bnms_dd_beta_no_historical_replay BEFORE INSERT OR UPDATE ON gocardless_payments FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_protect_payment();
      INSERT INTO bnms_dd_beta_batch VALUES('${uuid(1000)}','${BATCH_HASH}');
    `);
    const sourceFunction=(file,name)=>readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8')
      .match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(\\)[\\s\\S]*?END \\$\\$;`))[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
    sql(`CREATE TABLE bnms_dd_beta_provider_history(provider_payment_id text);
      INSERT INTO bnms_dd_beta_provider_history VALUES('historical');
      ${sourceFunction('20261108_bnms_dd_pilot_history.sql','bnms_dd_reject_history_mutation')}
      ${sourceFunction('20261112_bnms_dd_beta_held.sql','bnms_dd_beta_protect_payment')}`);
    for(let n=1;n<=10;n++)sql(`
      INSERT INTO bnms_dd_beta_adoption VALUES('${uuid(n)}','${uuid(1000)}','${TENANT_ID}','${uuid(n+10)}','${uuid(n+20)}','${uuid(n+30)}','${uuid(n+40)}','MD${n}','CU${n}','{"immutable":"original"}');
      INSERT INTO membership_payment_plans VALUES('${uuid(n+20)}','${TENANT_ID}','${uuid(n+10)}','${uuid(n+30)}','gocardless','live','MD${n}',NULL,now(),'first_payment_pending',
        '{"collection_mode":"dynamic","dynamic_first_date":"2026-10-01","bnms_beta_held":true,"bnms_release_required":true}',now());
      INSERT INTO membership_billing_agreements VALUES('${uuid(n+30)}','${TENANT_ID}','${uuid(n+10)}','gocardless','live','MD${n}','CU${n}','first_payment_pending',
        '{"dd":{"activation_rule":"first_payment","collection_policy":{"version":1,"pricing_policy":"dynamic"},"invoicing_mode":"per_instalment","instalment_count":12,"currency":"GBP","commitment":{"term_key":"rolling:2026-10-01","term_start_date":"2026-10-01","term_end_date":"2027-09-30"}},"bnms_beta_approval":{"held":true}}',now(),true,'held');
      INSERT INTO member_membership_history VALUES('${uuid(n+40)}','${TENANT_ID}','${uuid(n+10)}','${uuid(n+30)}','pending_payment_setup','unpaid',NULL,now(),'immutable terms','2026-10-01',NULL);
    `);
    const migration=readFileSync(MIGRATION,'utf8');
    sql(`BEGIN;${migration}COMMIT;`);
    c=new pg.Client({host:socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();
    await verifyBetaReleaseSchema(c);
    // Names alone are not authority: bind exact schema/relation/function/timing/events.
    for(const corruption of [
      `CREATE FUNCTION public.noop_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$;
       DROP TRIGGER bnms_dd_beta_reservation_hold ON gocardless_collection_reservations;
       CREATE TRIGGER bnms_dd_beta_reservation_hold BEFORE INSERT OR UPDATE ON gocardless_collection_reservations FOR EACH ROW EXECUTE FUNCTION public.noop_guard();`,
      `DROP TRIGGER bnms_dd_beta_reservation_hold ON gocardless_collection_reservations;
       CREATE TRIGGER bnms_dd_beta_reservation_hold BEFORE INSERT OR UPDATE ON membership_payment_plans FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_hold_guard();`,
      `DROP TRIGGER bnms_dd_beta_reservation_hold ON gocardless_collection_reservations;
       CREATE TRIGGER bnms_dd_beta_reservation_hold AFTER INSERT OR UPDATE ON gocardless_collection_reservations FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_hold_guard();`,
      `DROP TRIGGER bnms_dd_beta_reservation_hold ON gocardless_collection_reservations;
       CREATE TRIGGER bnms_dd_beta_reservation_hold BEFORE INSERT ON gocardless_collection_reservations FOR EACH ROW EXECUTE FUNCTION bnms_dd_beta_hold_guard();`,
      `DROP TRIGGER bnms_dd_beta_reservation_hold ON gocardless_collection_reservations;
       CREATE TRIGGER bnms_dd_beta_reservation_hold BEFORE INSERT OR UPDATE ON gocardless_collection_reservations FOR EACH STATEMENT EXECUTE FUNCTION bnms_dd_beta_hold_guard();`,
      `ALTER TABLE gocardless_collection_reservations DISABLE TRIGGER bnms_dd_beta_reservation_hold;`,
      `ALTER FUNCTION bnms_dd_beta_hold_guard() SECURITY DEFINER;`,
      `ALTER FUNCTION bnms_dd_beta_hold_guard() SET search_path=pg_temp,public;`,
      `ALTER FUNCTION bnms_dd_beta_hold_guard() OWNER TO service_role;`,
      `GRANT TRUNCATE ON bnms_dd_beta_release TO service_role;`,
      `GRANT SELECT ON bnms_dd_beta_release TO PUBLIC;`,
      `ALTER TABLE bnms_dd_beta_release DISABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE bnms_dd_beta_release DROP CONSTRAINT bnms_dd_beta_release_plan_id_fkey;`,
      `ALTER TABLE bnms_dd_beta_release DROP CONSTRAINT bnms_dd_beta_release_processing_not_before_check;`,
    ]){
      await c.query('BEGIN');await c.query(corruption);
      await assert.rejects(verifyBetaReleaseSchema(c),/differs|differ/);await c.query('ROLLBACK');
    }
    const replayMembers=Array.from({length:10},(_,index)=>({memberId:uuid(index+11),adoptionId:uuid(index+1),planId:uuid(index+21),
      mandateId:`MD${index+1}`,customerId:`CU${index+1}`,price:{monthly_amount_minor:1300,currency:'GBP'},
      accounting:accountingFor(uuid(index+11)),blockers:[],provider:{mandate:{next_possible_charge_date:'2026-09-24'}}}));
    const replayReport={tenantId:TENANT_ID,batchHash:BATCH_HASH,globalBlockers:[],members:replayMembers,
      handover:{tenantId:TENANT_ID,batchHash:BATCH_HASH,memberIds:replayMembers.map(m=>m.memberId),automaticLegacyCollectionsDisabled:true,
        confirmedBy:'Fixture operator',evidenceReference:'Fixture handover',confirmedAt:'2026-09-20T00:00:00Z'}};
    const replayProof={deploymentId:'fixture',commit:'fixture',sourceHashes:{}};
    const releaseHash=fingerprint(betaReleaseManifest(replayReport,replayProof));
    assert.equal(sql("SELECT has_table_privilege('service_role','bnms_dd_beta_release','INSERT');").trim(),'f');
    reject(`UPDATE membership_payment_plans SET collection_stopped_at=NULL WHERE id='${uuid(21)}';`,/reviewed release/);
    reject(`UPDATE member_membership_history SET status='active' WHERE id='${uuid(41)}';`,/cannot activate/);
    const arm=n=>{
      const evidence={...betaReleaseManifest(replayReport,replayProof).members[n-1],production:replayProof,
        handover:replayReport.handover,readinessObservedAt:replayReport.observedAt};
      return `INSERT INTO bnms_dd_beta_release(adoption_id,tenant_id,member_id,plan_id,evidence_sha256,evidence)
        VALUES('${uuid(n)}','${TENANT_ID}','${uuid(n+10)}','${uuid(n+20)}','${releaseHash}','${JSON.stringify(evidence)}');
        UPDATE membership_billing_agreements SET needs_attention=false,attention_reason=NULL WHERE id='${uuid(n+30)}';
        UPDATE membership_payment_plans SET collection_stopped_at=NULL,metadata=jsonb_set(metadata,'{bnms_release_required}','false') WHERE id='${uuid(n+20)}';`;
    };
    const all=Array.from({length:10},(_,n)=>arm(n+1)).join('\n');
    reject(`BEGIN;${all}SELECT 1/0;COMMIT;`,/division by zero/);
    assert.equal(sql('SELECT count(*) FROM bnms_dd_beta_release;').trim(),'0');
    assert.equal(sql('SELECT count(*) FROM membership_payment_plans WHERE collection_stopped_at IS NOT NULL;').trim(),'10');
    sql(`BEGIN;${all}COMMIT;`);
    await assert.rejects(releaseBeta(c,replayReport,replayProof,{apply:true}),/exact reviewed/);
    const replay=await releaseBeta(c,replayReport,replayProof,{apply:true,verifiedDestination:true,reviewSha256:releaseHash});
    assert.equal(replay.mode,'release_replay');assert.equal(replay.writes,0);assert.equal(replay.readinessRevalidated,false);
    assert.equal(sql("SELECT count(*) FROM member_membership_history WHERE status='pending_payment_setup' AND payment_status='unpaid';").trim(),'10');
    reject(arm(1),/duplicate key/);
    reject("UPDATE bnms_dd_beta_release SET evidence='{}';",/immutable/);
    reject(`UPDATE membership_billing_agreements SET metadata='{}' WHERE id='${uuid(31)}';`,/immutable consent/);
    reject(`UPDATE member_membership_history SET status='active' WHERE id='${uuid(41)}';`,/confirmed first/);
    reject(`INSERT INTO gocardless_payments(tenant_id,gocardless_payment_id,gocardless_mandate_id,status,charge_date)
      VALUES('${TENANT_ID}','historical','MD1','confirmed','2026-09-08');`,/historical/i);
    // Deterministic clock in this disposable fixture only, not the production SQL.
    sql(`CREATE FUNCTION public.test_beta_clock() RETURNS timestamptz LANGUAGE sql AS $$ SELECT current_setting('test.clock')::timestamptz $$;
      ${migration.match(/CREATE OR REPLACE FUNCTION public.bnms_dd_beta_hold_guard\(\)[\s\S]*?END \$\$;/)[0].replaceAll('clock_timestamp()','public.test_beta_clock()')}`);
    // Real reservation/attachment RPCs, including the deployed cadence wrappers
    // and monotonic settlement implementation. Only the clock is a test seam.
    sql(`
      CREATE TABLE tenant(id uuid PRIMARY KEY);INSERT INTO tenant VALUES('${TENANT_ID}');
      CREATE TABLE member(id uuid,tenant_id uuid,membership_paused boolean,status text);
      CREATE TABLE organization(LIKE member);
      INSERT INTO member SELECT member_id,tenant_id,false,'active' FROM bnms_dd_beta_adoption;
      CREATE TABLE membership_tier_config(id uuid,tenant_id uuid);INSERT INTO membership_tier_config VALUES('${uuid(901)}','${TENANT_ID}');
      CREATE TABLE membership_monthly_arrears_period(plan_id uuid,tenant_id uuid,settled_at timestamptz);
      CREATE TABLE organisation_membership_history(id uuid,tenant_id uuid,billing_agreement_id uuid,organization_id uuid,term_key text,payment_status text,paid_at timestamptz,final_cost numeric);
      CREATE TABLE membership_payment_status_history(tenant_id uuid,entity_type text,entity_id uuid,from_status text,to_status text,reason text,source text);
      ALTER TABLE member_membership_history ADD COLUMN term_key text DEFAULT 'rolling:2026-10-01';
      ALTER TABLE membership_billing_agreements ADD COLUMN organization_id uuid;
      ALTER TABLE membership_payment_plans ADD COLUMN organization_id uuid,
        ADD COLUMN amount_minor integer DEFAULT 1300,ADD COLUMN next_charge_date date,
        ADD COLUMN dynamic_next_collection_date date DEFAULT '2026-10-01',
        ADD COLUMN dynamic_next_check_at timestamptz,ADD COLUMN dynamic_collection_error text,ADD COLUMN completed_at timestamptz;
      ALTER TABLE gocardless_collection_reservations ADD PRIMARY KEY(id),ADD COLUMN status text DEFAULT 'reserved',
        ADD COLUMN term_key text,ADD COLUMN price_snapshot jsonb,ADD COLUMN idempotency_key text UNIQUE,
        ADD COLUMN provider_charge_date date,ADD COLUMN updated_at timestamptz,ADD COLUMN blocked_reason text,
        ADD UNIQUE(plan_id,collection_number);
      ALTER TABLE gocardless_payments ADD COLUMN plan_id uuid,ADD COLUMN amount_minor integer,
        ADD COLUMN currency text,ADD COLUMN updated_at timestamptz,ADD UNIQUE(gocardless_payment_id);
      GRANT SELECT ON gocardless_collection_reservations,gocardless_payments TO service_role;
      GRANT UPDATE ON gocardless_payments TO service_role;
      GRANT SELECT ON bnms_dd_beta_provider_history TO service_role;
    `);
    const original=readFileSync(new URL('../supabase/migrations/20261108_explicit_direct_debit_collection_policy.sql',import.meta.url),'utf8');
    sql(original.slice(original.indexOf('CREATE OR REPLACE FUNCTION public.reserve_gocardless_dynamic_collection(')));
    sql(original.slice(original.indexOf('CREATE OR REPLACE FUNCTION public.guard_gocardless_dynamic_reservation()'),original.indexOf('CREATE OR REPLACE FUNCTION public.guard_dd_collection_policy_snapshot()')));
    sql(readFileSync(new URL('../supabase/migrations/20261109_gocardless_dynamic_term_completion.sql',import.meta.url),'utf8'));
    sql(readFileSync(new URL('../supabase/migrations/20261109_manage_monthly_collection_days.sql',import.meta.url),'utf8'));
    const reserve=(plan,date='2026-10-07',checked='2026-09-30T23:00:00Z')=>`
      SELECT id FROM reserve_gocardless_dynamic_collection('${TENANT_ID}','${plan}',1,'2026-10-01',
        '{"config_id":"${uuid(901)}","monthly_amount_minor":1300,"currency":"GBP","intended_date":"2026-10-01"}',
        '{"status":"active","next_possible_charge_date":"${date}","checked_at":"${checked}"}','stable-${plan}');`;
    const reservation=(date,checked)=>reserve(uuid(21),date,checked);
    const attach=(plan,payment,status,mandate)=>`SELECT id FROM attach_gocardless_dynamic_payment('${TENANT_ID}',
      (SELECT id FROM gocardless_collection_reservations WHERE plan_id='${plan}'),
      '{"id":"${payment}","amount":1300,"currency":"GBP","charge_date":"2026-10-07","status":"${status}","links":{"mandate":"${mandate}"}}');`;
    reject(`SET test.clock='2026-09-30T22:59:59.999Z';${reservation()}`,/processing-not-before/);
    reject(`SET test.clock='2026-09-30T23:00:00Z';${reservation('2026-10-09')}`,/reviewed price/);
    reject(`SET test.clock='2026-09-30T23:00:00Z';${reservation('2026-10-07','2026-09-30T22:59:59Z')}`,/post-gate/);
    reject(`SET test.clock='2026-10-08T12:00:00Z';${reservation()}`,/in the past/);
    const reserved=sql(`SET test.clock='2026-09-30T23:00:00Z';SET ROLE service_role;${reservation()}`).trim().split('\n').at(-1);
    sql(`CREATE FUNCTION fixture_attachment_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF current_setting('test.fail_attachment',true)='true' THEN RAISE EXCEPTION 'injected local attachment failure';END IF;RETURN NEW;END$$;
      CREATE TRIGGER fixture_attachment_failure BEFORE INSERT ON gocardless_payments FOR EACH ROW EXECUTE FUNCTION fixture_attachment_failure();`);
    reject(`SET test.clock='2026-10-01T00:00:00Z';SET test.fail_attachment='true';SET ROLE service_role;${attach(uuid(21),'PMfixture','pending_submission','MD1')}`,/injected local attachment/);
    assert.equal(sql(`SELECT status||':'||coalesce(gocardless_payment_id,'none') FROM gocardless_collection_reservations WHERE id='${reserved}';`).trim(),'reserved:none');
    const recovered=sql(`SET test.clock='2026-10-01T00:00:00Z';SET ROLE service_role;${reservation()}`).trim().split('\n').at(-1);
    assert.equal(recovered,reserved);
    sql(`SET test.clock='2026-10-01T00:00:00Z';SET ROLE service_role;${attach(uuid(21),'PMfixture','pending_submission','MD1')}`);
    assert.equal(sql("SELECT status FROM gocardless_payments WHERE gocardless_payment_id='PMfixture';").trim(),'pending_submission');
    reject(`UPDATE member_membership_history SET status='active' WHERE id='${uuid(41)}';`,/confirmed first/);
    for(const status of ['submitted','confirmed','paid_out']){
      sql(`SET test.clock='2026-10-07T12:00:00Z';SET ROLE service_role;${attach(uuid(21),'PMfixture',status,'MD1')}`);
      assert.equal(sql("SELECT provider_evidence->>'status' FROM gocardless_collection_reservations WHERE gocardless_payment_id='PMfixture';").trim(),status);
    }
    sql(`SET test.clock='2026-10-07T12:00:00Z';SET ROLE service_role;${attach(uuid(21),'PMfixture','pending_submission','MD1')}`);
    assert.equal(sql("SELECT provider_evidence->>'status' FROM gocardless_collection_reservations WHERE gocardless_payment_id='PMfixture';").trim(),'paid_out');
    assert.equal(sql("SELECT count(*) FROM gocardless_payments WHERE gocardless_payment_id='PMfixture';").trim(),'1');
    reject(`SET test.clock='2026-10-07T12:00:00Z';UPDATE gocardless_collection_reservations SET provider_evidence=jsonb_set(provider_evidence,'{checked_at}','"2026-10-02T00:00:00Z"') WHERE plan_id='${uuid(21)}';`,/immutable post-gate|post-gate provider/);
    // RPC attachment preserves payment evidence; canonical status is persisted
    // independently by the webhook. Neither alone can activate this membership.
    reject(`UPDATE member_membership_history SET status='active' WHERE id='${uuid(41)}';`,/confirmed first/);
    sql(`SET ROLE service_role;UPDATE gocardless_payments SET status='paid_out' WHERE gocardless_payment_id='PMfixture';RESET ROLE;
      UPDATE member_membership_history SET status='active',payment_status='partial' WHERE id='${uuid(41)}';`);
    assert.equal(sql(`SELECT status||':'||payment_status FROM member_membership_history WHERE id='${uuid(41)}';`).trim(),'active:partial');
    reject(`BEGIN;${migration}COMMIT;`,/reservations exist/);
    // Non-beta/alpha plans are not selected by the beta registry and are untouched.
    sql(`SET test.clock='2026-09-01T00:00:00Z';INSERT INTO gocardless_collection_reservations(tenant_id,plan_id) VALUES('${TENANT_ID}','${uuid(999)}');`);
    // Reproduce the applied pilot defect, roll that isolated transaction back,
    // then exercise the additive correction with the very same real RPCs.
    const pilotMember='33e5d54d-162e-436d-9bff-ec6676d198f9',pilotPlan=uuid(301),pilotAgreement=uuid(302);
    sql(`
      CREATE TABLE bnms_dd_pilot_adoption(id uuid,tenant_id uuid,member_id uuid,plan_id uuid);
      CREATE TABLE bnms_dd_pilot_release(adoption_id uuid,tenant_id uuid,member_id uuid);
      INSERT INTO bnms_dd_pilot_adoption VALUES('${uuid(300)}','${TENANT_ID}','${pilotMember}','${pilotPlan}');
      INSERT INTO bnms_dd_pilot_release VALUES('${uuid(300)}','${TENANT_ID}','${pilotMember}');
      INSERT INTO member VALUES('${pilotMember}','${TENANT_ID}',false,'active');
      INSERT INTO membership_billing_agreements(id,tenant_id,member_id,provider,environment,gocardless_mandate_id,status,metadata)
        SELECT '${pilotAgreement}',tenant_id,'${pilotMember}',provider,environment,'MDPILOT',status,metadata FROM membership_billing_agreements WHERE id='${uuid(31)}';
      INSERT INTO membership_payment_plans(id,tenant_id,member_id,billing_agreement_id,provider,environment,gocardless_mandate_id,status,metadata)
        VALUES('${pilotPlan}','${TENANT_ID}','${pilotMember}','${pilotAgreement}','gocardless','live','MDPILOT','first_payment_pending',
          '{"collection_mode":"dynamic","dynamic_first_date":"2026-10-01"}');
    `);
    const oldPilot=readFileSync(new URL('../supabase/migrations/20261114_bnms_dd_pilot_processing_start.sql',import.meta.url),'utf8');
    sql(`BEGIN;${oldPilot.replaceAll('clock_timestamp()','public.test_beta_clock()')}COMMIT;`);
    reject(`BEGIN;SET test.clock='2026-10-01T00:00:00Z';SET ROLE service_role;
      ${reserve(pilotPlan)}${attach(pilotPlan,'PMPILOT','pending_submission','MDPILOT')}COMMIT;`,/post-gate provider date evidence/);
    assert.equal(sql(`SELECT count(*) FROM gocardless_collection_reservations WHERE plan_id='${pilotPlan}';`).trim(),'0');
    const pilotCorrection=readFileSync(new URL('../supabase/migrations/20261116_bnms_dd_pilot_reservation_lifecycle.sql',import.meta.url),'utf8');
    sql(`BEGIN;${pilotCorrection}COMMIT;`);
    sql(pilotCorrection.slice(pilotCorrection.indexOf('CREATE OR REPLACE FUNCTION')).replaceAll('clock_timestamp()','public.test_beta_clock()'));
    reject(`SET test.clock='2026-09-30T22:59:59Z';SET ROLE service_role;${reserve(pilotPlan)}`,/processing-not-before/);
    sql(`SET test.clock='2026-10-01T00:00:00Z';SET ROLE service_role;${reserve(pilotPlan)}`);
    for(const status of ['pending_submission','submitted','confirmed','paid_out','pending_submission']){
      sql(`SET test.clock='2026-10-07T12:00:00Z';SET ROLE service_role;${attach(pilotPlan,'PMPILOT',status,'MDPILOT')}`);
    }
    assert.equal(sql("SELECT provider_evidence->>'status' FROM gocardless_collection_reservations WHERE gocardless_payment_id='PMPILOT';").trim(),'paid_out');
  }finally{
    await c?.end();if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);await h.cleanup();
  }
});
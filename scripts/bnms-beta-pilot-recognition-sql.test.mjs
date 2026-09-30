import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { recognitionCatalog, normalizedRecognitionCatalog } from './run-bnms-alpha-membership-recognition.mjs';

test('supplemental recognition SQL enforces exact scope, ownership, immutable audit and restricted grants', async () => {
  const h=await createLocalPostgresHarness('supplemental-recognition-');
  const run=(cmd,args,input)=>{
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr||r.stdout); return r.stdout;
  };
  const conn=['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'];
  const sql=input=>run('psql',conn,input);
  const reject=(input,pattern)=>{
    const r=spawnSync('psql',conn,{input,encoding:'utf8'});
    assert.notEqual(r.status,0); assert.match(r.stderr,pattern);
  };
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
  const approval='explicit-user-approval:exact-10-beta-1-pilot:2026-09-21-through-2027-09-30:preserve-collection-controls';
  let started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
        payment_method text,status text,payment_status text,term_start_date date,term_end_date date,membership_renewal_date date);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
        provider text,status text,collection_stopped_at timestamptz,metadata jsonb);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,provider text,status text);
      CREATE TABLE bnms_dd_beta_adoption(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,history_id uuid,agreement_id uuid,plan_id uuid);
      CREATE TABLE bnms_dd_pilot_adoption(LIKE bnms_dd_beta_adoption INCLUDING ALL);
      CREATE TABLE bnms_dd_alpha_membership_recognition(tenant_id uuid,member_id uuid,revoked_at timestamptz,effective_from date,effective_until date);`);
    const migration=readFileSync(new URL('../supabase/migrations/20261120_bnms_membership_recognition_beta_pilot.sql',import.meta.url),'utf8');
    sql(migration);
    const catalog=await recognitionCatalog({query:async q=>({rows:[{catalog:JSON.parse(sql(q.replace(
      "'bnms_dd_alpha_membership_recognition'","'bnms_membership_recognition_beta_pilot'")).trim())}]})});
    const catalogHash=createHash('sha256').update(JSON.stringify(normalizedRecognitionCatalog(catalog))).digest('hex');
    assert.equal(catalogHash,'5962cfddfb9ec75941c434bf6da27baf7aa1b89d5864c0b04dc24c1878f62c0c');
    const identities=[];
    for(let i=1;i<=11;i++) {
      const kind=i===11?'pilot':'beta',status=i===11?'mandate_pending':'first_payment_pending';
      identities.push([kind,id(i),tenant,id(100+i),id(200+i),id(300+i),id(400+i)].join('|'));
      sql(`INSERT INTO member VALUES('${id(100+i)}','${tenant}');
        INSERT INTO member_membership_history VALUES('${id(200+i)}','${tenant}','${id(100+i)}','${id(300+i)}','direct_debit','pending_payment_setup','unpaid','2026-10-01','2027-09-30','2027-10-01');
        INSERT INTO membership_payment_plans VALUES('${id(400+i)}','${tenant}','${id(100+i)}','${id(300+i)}','gocardless','${status}',${i===11?'NULL':"'2026-09-21'"} ,'{"bnms_release_required":${i!==11}}');
        INSERT INTO membership_billing_agreements VALUES('${id(300+i)}','${tenant}','${id(100+i)}','gocardless','${status}');
        INSERT INTO bnms_dd_${kind}_adoption VALUES('${id(i)}','${tenant}','${id(100+i)}','${id(200+i)}','${id(300+i)}','${id(400+i)}');`);
    }
    const insert=(i=1)=>`INSERT INTO bnms_membership_recognition_beta_pilot
      (adoption_id,cohort,tenant_id,member_id,history_id,agreement_id,plan_id,effective_from,effective_until,authorization_reference,review_sha256)
      VALUES('${id(i)}','${i===11?'pilot':'beta'}','${tenant}','${id(100+i)}','${id(200+i)}','${id(300+i)}','${id(400+i)}','2026-09-21','2027-10-01','${approval}','${'a'.repeat(64)}');`;
    reject(insert(),/Exact reviewed eleven-member/);
    // Substitute only the identity digest in the disposable DB, never in the reviewed migration.
    const fixtureHash=createHash('sha256').update(identities.sort().join('\n')).digest('hex');
    const body=migration.slice(migration.indexOf('CREATE FUNCTION'),migration.indexOf('REVOKE ALL ON FUNCTION'))
      .replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
      .replace('24f504d58be98163858ebeaf91d796074a50c27f4013d07169ef31e83d9a2c64',fixtureHash);
    sql(body);
    for(const bad of [
      insert().replace(tenant,id(999)),insert().replace(id(101),id(102)),
      insert().replace(id(201),id(202)),insert().replace(id(301),id(302)),
      insert().replace(id(401),id(402)),insert().replace("'beta'","'pilot'"),
      insert().replace('2026-09-21','2026-09-20'),insert().replace('2027-10-01','2027-10-02'),
      insert().replace(approval,'unapproved'),
    ]) reject(bad,/scope required|mismatch|check constraint/);
    for(const role of ['anon','authenticated','service_role']) reject(`SET ROLE ${role};${insert()}`,/permission denied/);
    for(const role of ['anon','authenticated']) reject(`SET ROLE ${role}; SELECT * FROM bnms_membership_recognition_beta_pilot;`,/permission denied/);
    reject('SET ROLE anon; SELECT public.validate_bnms_supplemental_recognition();',/permission denied/);
    sql(`INSERT INTO bnms_dd_beta_adoption SELECT '${id(999)}',tenant_id,member_id,history_id,agreement_id,plan_id FROM bnms_dd_beta_adoption LIMIT 1;`);
    reject(insert(),/Exact reviewed eleven-member/);
    sql(`DELETE FROM bnms_dd_beta_adoption WHERE id='${id(999)}';`);
    sql(`INSERT INTO bnms_dd_alpha_membership_recognition VALUES('${tenant}','${id(101)}',NULL,'2026-09-21','2027-10-01');`);
    reject(insert(),/overlaps/);
    sql('DELETE FROM bnms_dd_alpha_membership_recognition;');
    sql(`UPDATE membership_payment_plans SET member_id='${id(999)}' WHERE id='${id(401)}';`);
    reject(insert(),/ownership or source eligibility/);
    sql(`UPDATE membership_payment_plans SET member_id='${id(101)}' WHERE id='${id(401)}';`);
    sql(`UPDATE member_membership_history SET status='cancelled' WHERE id='${id(201)}';`);
    reject(insert(),/ownership or source eligibility/);
    sql(`UPDATE member_membership_history SET status='pending_payment_setup' WHERE id='${id(201)}';`);
    for(let i=1;i<=11;i++) sql(insert(i));
    assert.equal(sql('SET ROLE service_role; SELECT count(*) FROM bnms_membership_recognition_beta_pilot;').trim().split('\n').at(-1),'11');
    reject("UPDATE bnms_membership_recognition_beta_pilot SET review_sha256=repeat('b',64);",/immutable/);
    reject('DELETE FROM bnms_membership_recognition_beta_pilot;',/cannot be deleted/);
    sql('UPDATE member_membership_history SET status=\'cancelled\'; UPDATE bnms_membership_recognition_beta_pilot SET revoked_at=now();');
    reject('UPDATE bnms_membership_recognition_beta_pilot SET revoked_at=NULL;',/immutable/);
  } finally {
    if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
// Authentic private evidence, real disposable PostgreSQL, no network/providers.
// This never connects to DEST. Fixtures are excluded from source control.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {createLocalPostgresHarness} from './test-support/local-postgres-harness.mjs';
import {alphaSchemaBundle,verifyAlphaReleaseSchema} from './bnms-dd-alpha-release.mjs';
import {exceptionManifest,releaseOperatorException,readExceptionSnapshot,exceptionSnapshotHash} from './bnms-dd-alpha-operator-exception.mjs';

const fixturePath=process.env.BNMS_ALPHA_EXCEPTION_TEST_EVIDENCE||
  'exports/private-bnms-alpha-operator-exception-20260923/dryrun-5.json';
const catalogPath='exports/private-bnms-alpha-operator-exception-20260923/local-test-base-catalog.json';
const quote=name=>`"${name.replaceAll('"','""')}"`;
const migration=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
test('isolated exception transaction: actual guards, exact249 CAS, rollback, immutable audit, zero-write replay',
  {timeout:240000},async()=>{
    const saved=JSON.parse(await readFile(fixturePath,'utf8')),e=saved.evidence;
    assert.ok(e&&saved.result?.writes===0,'Reviewed read-only fixture required');
    const catalog=JSON.parse(await readFile(catalogPath,'utf8'));
    const h=await createLocalPostgresHarness('alpha-operator-exception-');
    const run=(cmd,args)=>{
      const r=spawnSync(cmd,args,{encoding:'utf8',timeout:20000});
      assert.equal(r.status,0,r.stderr);return r.stdout;
    };
    let c,started=false;
    try{
      run('initdb',['-D',h.data,'-A','trust','-U','postgres','--no-locale','--encoding=UTF8']);
      run('pg_ctl',['-D',h.data,'-l',`${h.root}/postgres.log`,'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
      c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();
      await c.query("SET timezone='UTC'; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      for(const {name,labels} of catalog.enums)
        await c.query(`CREATE TYPE ${quote(name)} AS ENUM (${labels.map(v=>`'${v.replaceAll("'","''")}'`).join(',')})`);
      for(const table of [...new Set(catalog.columns.map(x=>x.table_name))]){
        const columns=catalog.columns.filter(x=>x.table_name===table);
        await c.query(`CREATE TABLE ${quote(table)} (${columns.map(x=>`${quote(x.name)} ${x.type}${x.name==='id'?' PRIMARY KEY':''}`).join(',')})`);
      }
      const pilot=await migration('20261108_bnms_dd_pilot_history.sql');
      await c.query(pilot.match(/CREATE (?:OR REPLACE )?FUNCTION public\.bnms_dd_reject_history_mutation\(\) RETURNS trigger[\s\S]*?\$\$;/)[0]);
      await c.query(`CREATE TABLE bnms_dd_beta_adoption(member_id uuid,mandate_id text,customer_id text);
        CREATE TABLE bnms_dd_historical_payment(provider_payment_id text);
        CREATE TABLE bnms_dd_beta_invoice_link(xero_invoice_id uuid,xero_payment_id uuid);
        CREATE TABLE xero_token(app_tenant_id uuid,tenant_id uuid);`);
      const insert=async(table,rows)=>{
        for(let i=0;i<rows.length;i+=100)
          await c.query(`INSERT INTO ${quote(table)} SELECT * FROM jsonb_populate_recordset(NULL::${quote(table)},$1::jsonb)`,[JSON.stringify(rows.slice(i,i+100))]);
      };
      for(const [table,rows] of Object.entries(e.snapshot.state))await insert(table,rows);
      await insert('system_settings',e.snapshot.settings);
      await insert('tenant_accounting_settings',[{tenant_id:e.report.tenantId,...e.snapshot.provider}]);
      await insert('xero_token',e.snapshot.xeroIdentity);
      await insert('tenant_identity',[...new Map(e.snapshot.identity.bindings.filter(b=>b.identity_id).map(b=>[b.identity_id,
        {id:b.identity_id,email:b.identity_email,created_at:b.identity_created_at}])).values()]);
      // Synthetic local-only identities represent the observed global email
      // count for identities outside this cohort; no production path uses them.
      for(const b of e.snapshot.identity.bindings){
        const email=e.snapshot.identity.current.find(m=>m.id===b.member_id).email;
        const existing=(await c.query('SELECT count(*)::int n FROM tenant_identity WHERE lower(trim(email))=lower(trim($1))',[email])).rows[0].n;
        for(let i=existing;i<b.email_identity_count;i++)
          await c.query('INSERT INTO tenant_identity(id,email) VALUES(gen_random_uuid()::text,$1)',[email]);
      }
      await insert('tenant_membership',e.snapshot.identity.bindings.flatMap(b=>b.memberships||[]));
      await c.query(await migration('20261113_bnms_dd_alpha_held.sql'));
      await c.query('BEGIN');
      await insert('bnms_dd_alpha_adoption',e.snapshot.adoptions);
      await insert('bnms_dd_alpha_provider_history',e.snapshot.historical);
      await insert('bnms_dd_alpha_invoice_link',e.snapshot.links);
      await c.query('COMMIT');
      const bundle=await alphaSchemaBundle();
      await c.query('BEGIN');await c.query(bundle.releaseSql);await c.query(bundle.invoiceSql);await c.query('COMMIT');
      await verifyAlphaReleaseSchema(c);
      const ids=e.report.members.map(m=>m.memberId);
      const reproduced=await readExceptionSnapshot(c,ids);
      if(exceptionSnapshotHash(reproduced)!==exceptionSnapshotHash(e.snapshot)){
        console.log('Fixture differing components',Object.keys(e.snapshot).filter(k=>hash(e.snapshot[k])!==hash(reproduced[k])));
        console.log('Fixture identity mismatches',reproduced.identity.bindings.flatMap((b,i)=>{
          const old=e.snapshot.identity.bindings.find(x=>x.member_id===b.member_id);
          const fields=Object.keys(b).filter(k=>hash(b[k])!==hash(old[k]));
          return fields.length?[{index:i,fields}]:[];
        }));
      }
      assert.equal(exceptionSnapshotHash(reproduced),exceptionSnapshotHash(e.snapshot),
        'Fixture must faithfully reproduce current exact snapshot before testing writes');
      const prepared=await exceptionManifest(e);
      const dry=await releaseOperatorException(c,e);
      assert.equal(dry.writes,0);assert.equal(dry.reviewSha256,saved.result.reviewSha256);
      const counts=async()=>(await c.query(`SELECT (SELECT count(*)::int FROM bnms_dd_alpha_release) released,
        (SELECT count(*)::int FROM membership_payment_plans WHERE collection_stopped_at IS NOT NULL) held,
        (SELECT count(*)::int FROM gocardless_payments) payments,
        (SELECT count(*)::int FROM gocardless_collection_reservations) reservations`)).rows[0];
      assert.deepEqual(await counts(),{released:0,held:249,payments:0,reservations:0});
      // Actual transaction-scoped lock serializes with the normal Alpha runner.
      const contender=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
      await contender.connect();
      try{
        await contender.query('BEGIN');
        await contender.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-alpha-scheduled-release'))");
        await assert.rejects(releaseOperatorException(c,e),/lock timeout/);
        await contender.query('ROLLBACK');
      }finally{await contender.end();}
      // Reject invalid approval signature/hash before any writes.
      await assert.rejects(releaseOperatorException(c,e,{apply:true,reviewSha256:'0'.repeat(64)}),/reviewed/);
      const originalWaivers=e.audit.approval.waivers;
      e.audit.approval.waivers=[...originalWaivers,'PRICING'];
      await assert.rejects(releaseOperatorException(c,e,{apply:true,reviewSha256:prepared.reviewSha256}),/integrity/);
      e.audit.approval.waivers=originalWaivers;
      const originalTenant=e.report.tenantId;
      e.report.tenantId='00000000-0000-4000-8000-000000000001';
      await assert.rejects(releaseOperatorException(c,e),/immutable/);
      e.report.tenantId=originalTenant;
      const originalCommit=e.proof.commit;
      e.proof.commit='0'.repeat(40);
      await assert.rejects(releaseOperatorException(c,e),/source proof/);
      e.proof.commit=originalCommit;
      const originalObserved=e.audit.nonXeroStage.observedAt;
      e.audit.nonXeroStage.observedAt='2026-09-21T00:00:00Z';
      await assert.rejects(releaseOperatorException(c,e),/15 minutes/);
      e.audit.nonXeroStage.observedAt=originalObserved;
      const originalStatus=e.report.members[0].provider.mandate.status;
      e.report.members[0].provider.mandate.status='cancelled';
      await assert.rejects(releaseOperatorException(c,e,{apply:true,reviewSha256:prepared.reviewSha256}),/mandate/);
      e.report.members[0].provider.mandate.status=originalStatus;
      const subscriptions=e.report.members[0].provider.subscriptions;
      e.report.members[0].provider.subscriptions=[{id:'local-test-only',links:{mandate:e.report.members[0].mandateId}}];
      await assert.rejects(releaseOperatorException(c,e),/subscriptions/);
      e.report.members[0].provider.subscriptions=subscriptions;
      const payments=e.report.members[0].provider.payments;
      e.report.members[0].provider.payments=[...payments,{id:'local-test-only',
        links:{mandate:e.report.members[0].mandateId},status:'pending_submission',charge_date:'2026-10-01'}];
      await assert.rejects(releaseOperatorException(c,e),/payment history/);
      e.report.members[0].provider.payments=payments;
      const originalPrice=e.report.members[0].price.monthly_amount_minor;
      e.report.members[0].price.monthly_amount_minor++;
      await assert.rejects(releaseOperatorException(c,e),/total/);
      e.report.members[0].price.monthly_amount_minor=originalPrice;
      const originalPlan=e.report.members[0].planId;
      e.report.members[0].planId=e.report.members[1].planId;
      await assert.rejects(releaseOperatorException(c,e),/owner/);
      e.report.members[0].planId=originalPlan;
      // Real locked re-read rejects a concurrent canonical owner/profile edit.
      await c.query("UPDATE member SET email='changed@example.invalid' WHERE id=$1",[ids[0]]);
      await assert.rejects(releaseOperatorException(c,e),/Concurrent canonical/);
      await c.query('UPDATE member SET email=$1 WHERE id=$2',[e.snapshot.state.member.find(m=>m.id===ids[0]).email,ids[0]]);
      assert.deepEqual(await counts(),{released:0,held:249,payments:0,reservations:0});
      // Original hold prevents planholder mutation even by this test owner.
      await assert.rejects(c.query('UPDATE membership_payment_plans SET member_id=$1 WHERE id=$2',
        [ids[1],originalPlan]),/reviewed release/);
      const applied=await releaseOperatorException(c,e,{apply:true,reviewSha256:prepared.reviewSha256});
      assert.equal(applied.writes,747);
      assert.deepEqual(await counts(),{released:249,held:0,payments:0,reservations:0});
      assert.equal((await c.query(`SELECT count(*)::int n FROM bnms_dd_alpha_release
        WHERE evidence->'operatorRiskAcceptance'->>'fullAlphaReadinessComplete'='false'
        AND processing_not_before=TIMESTAMPTZ '2026-09-30 23:00:00+00'`)).rows[0].n,249);
      assert.equal((await c.query(`SELECT count(*)::int n FROM member_membership_history
        WHERE status='pending_payment_setup' AND payment_status='unpaid'`)).rows[0].n,249);
      const replay=await releaseOperatorException(c,e,{apply:true,reviewSha256:prepared.reviewSha256});
      assert.equal(replay.mode,'exception_release_replay');assert.equal(replay.writes,0);
      assert.deepEqual(await counts(),{released:249,held:0,payments:0,reservations:0});
      await assert.rejects(c.query("UPDATE bnms_dd_alpha_release SET evidence='{}'"),/immutable/i);
      await assert.rejects(c.query('DELETE FROM bnms_dd_alpha_release'),/immutable/i);
      await assert.rejects(c.query(`INSERT INTO gocardless_collection_reservations(id,tenant_id,plan_id,billing_agreement_id)
        VALUES(gen_random_uuid(),$1,$2,$3)`,[e.report.tenantId,originalPlan,e.report.members[0].agreementId]),/October 1/);
      // Runtime acceptance uses deployed readers without freshness fiction.
      const {resolveAlphaAccountingContext}=await import('../api/_lib/bnmsAlphaAccounting.js');
      const db={from:table=>({select(){return this;},filters:[],
        eq(key,value){this.filters.push([key,value]);return this;},
        async maybeSingle(){
          const where=this.filters.map(([key],i)=>`${quote(key)}=$${i+1}`).join(' AND ');
          const rows=(await c.query(`SELECT * FROM ${quote(table)} WHERE ${where}`,this.filters.map(([,v])=>v))).rows;
          return {data:rows[0]||null,error:rows.length>1?Error('ambiguous'):null};
        }})};
      const agreement=e.snapshot.state.membership_billing_agreements[0];
      const context=await resolveAlphaAccountingContext(agreement,db);
      assert.equal(context.memberId,agreement.member_id);
    }finally{
      if(c)await c.end();
      if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
      await h.cleanup();
    }
  });
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from './test-support/local-postgres-harness.mjs';
test('consent SQL isolates roles, deduplicates, bounds ingestion and protects settings',async()=>{
  const h=await createLocalPostgresHarness('cookie-consent-');
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  let db,started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
    await db.query(`create role anon;create role authenticated;create role service_role bypassrls;
      create table tenant(id uuid primary key,settings jsonb);
      create table platform_preferences(key text primary key,value jsonb);`);
    await db.query(readFileSync('supabase/migrations/202611020001_cookie_consent.sql','utf8'));
    const id='00000000-0000-4000-8000-000000000001';
    await db.query('insert into tenant values($1,$2)',[id,{}]);
    await db.query('set role authenticated');
    await assert.rejects(db.query('select * from cookie_consent_records'),/permission denied/);
    await assert.rejects(db.query(`select set_cookie_consent_settings(null,'{}')`),/permission denied/);
    await db.query('reset role');
    await assert.rejects(db.query(`update tenant set settings='{"cookie_consent":{"analyticsEnabled":true}}'`),/dedicated/);
    await db.query('set role service_role');
    await db.query(`select set_cookie_consent_settings(null,'{"retentionDays":7}')`);
    await db.query('select set_cookie_consent_settings($1,$2)',[id,{title:'Tenant'}]);
    const record={record_id:'a',consent_id:'visitor',domain:'tenant.test',categories:{necessary:true},regulation:'GDPR',action:'reject_all',source:'banner',taxonomy_hash:'x',policy_version:'1',policy_revision:'r',decided_at:new Date().toISOString()};
    assert.equal((await db.query('select ingest_cookie_consent($1,$2) as ok',[id,record])).rows[0].ok,true);
    await db.query('select ingest_cookie_consent($1,$2)',[id,{...record,source:'api'}]);
    const rows=await db.query('select * from cookie_consent_records');assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].source,'banner');
    await assert.rejects(db.query(`update cookie_consent_records set source='api'`),/permission denied/);
    await db.query('reset role');
    await db.query(`update cookie_consent_budget set requests=600,bucket=date_trunc('minute',clock_timestamp())`);
    await db.query('set role service_role');
    assert.equal((await db.query('select ingest_cookie_consent($1,$2) as ok',[id,{...record,record_id:'b'}])).rows[0].ok,false);
    await db.query('reset role');
    await db.query(`update cookie_consent_records set created_at=clock_timestamp()-interval '8 days'`);
    await db.query('set role service_role');
    assert.equal((await db.query('select cleanup_cookie_consent() as n')).rows[0].n,1);
  } finally {
    await db?.end();
    if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop'],{stdio:'ignore'});
    await h.cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
test('renewal journey settings enforce tenant ownership, revision CAS, audit and service-only writes', {timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('renewal-journey-');
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 let db,started=false;
 try {
  run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
  await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
   CREATE TABLE tenant(id uuid primary key);
   CREATE TABLE form(id uuid primary key,tenant_id uuid,is_active boolean,require_authentication boolean,slug text,form_type text);`);
  await db.query(readFileSync(new URL('../../supabase/migrations/202701210002_membership_renewal_journey.sql',import.meta.url),'utf8'));
  const t='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002',f='20000000-0000-0000-0000-000000000001';
  await db.query('insert into tenant values($1),($2)',[t,other]);
  await db.query("insert into form values($1,$2,true,true,'questionnaire','standard')",[f,t]);
  const save=(tenant,revision,mode='questionnaire',form=f)=>db.query('select save_membership_renewal_journey($1,$2,$3,$4,$5) as setting',[tenant,'test:admin',mode,form,revision]);
  await db.query('set role authenticated');await assert.rejects(save(t,0),/permission denied/);await db.query('reset role');
  await db.query('set role service_role');
  await assert.rejects(db.query('insert into membership_renewal_journey(tenant_id) values($1)',[t]),/permission denied/);
  assert.equal((await save(t,0)).rows[0].setting.revision,1);
  await assert.rejects(save(t,0),/Settings changed/);
  await assert.rejects(save(other,0),/from this tenant/);
  await db.query('reset role');await db.query('update form set require_authentication=false where id=$1',[f]);
  await assert.rejects(save(t,1),/from this tenant/);
  const result=await save(t,1,'same_schedule',null);assert.equal(result.rows[0].setting.mode,'same_schedule');
  assert.equal((await db.query('select count(*)::int as n from membership_renewal_journey_history')).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int as n from membership_renewal_journey where tenant_id=$1',[other])).rows[0].n,0);
 }finally{if(db)await db.end();if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop']);await h.cleanup();}
});

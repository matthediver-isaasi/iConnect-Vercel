import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
test('joining configuration permits public forms, preserves renewal, and enforces audit/CAS/tenant isolation',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('joining-journey-');
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 let db,started=false;
 try{
  run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
  await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
   CREATE TABLE tenant(id uuid primary key);
   CREATE TABLE form(id uuid primary key,tenant_id uuid,is_active boolean,require_authentication boolean,slug text,form_type text);`);
  for(const file of ['202701210002_membership_renewal_journey.sql','202701210003_membership_joining_journey.sql'])
   await db.query(readFileSync(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8'));
  const t='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002',f='20000000-0000-0000-0000-000000000001';
  await db.query('insert into tenant values($1),($2)',[t,other]);
  await db.query("insert into form values($1,$2,true,false,'join','standard')",[f,t]);
  const save=(tenant,revision,form=f)=>db.query('select save_membership_joining_journey($1,$2,$3,$4) as setting',[tenant,'test:admin',form,revision]);
  await db.query("select save_membership_renewal_journey($1,'test:admin','same_schedule',null,0)",[t]);
  const before=(await db.query('select * from membership_renewal_journey')).rows;
  await db.query('set role authenticated');await assert.rejects(save(t,0),/permission denied/);await db.query('reset role');
  await db.query('set role service_role');
  await assert.rejects(db.query('insert into membership_joining_journey(tenant_id) values($1)',[t]),/permission denied/);
  assert.equal((await save(t,0)).rows[0].setting.revision,1);
  await assert.rejects(save(t,0),/Settings changed/);
  await assert.rejects(save(other,0),/from this tenant/);
  await db.query('reset role');await db.query('update form set is_active=false where id=$1',[f]);
  await assert.rejects(save(t,1),/from this tenant/);
  assert.equal((await save(t,1,null)).rows[0].setting.form_id,null);
  assert.deepEqual((await db.query('select * from membership_renewal_journey')).rows,before);
  assert.equal((await db.query('select count(*)::int as n from membership_joining_journey_history')).rows[0].n,2);
 }finally{if(db)await db.end();if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop']);await h.cleanup();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
test('financial claims exclude unapproved and lifecycle work, serialize and never resend expired mail',{timeout:30000},async()=>{
 const run=(bin,args)=>{const r=spawnSync(bin,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 const root=await mkdtemp(path.join(tmpdir(),'cancel-worker-'));await mkdir(`${root}/socket`);
 const clients=[];let started=false;
 try{
  run('initdb',['-D',`${root}/data`,'-U','postgres','-A','trust','--no-locale']);
  run('pg_ctl',['-D',`${root}/data`,'-l',`${root}/log`,'-o',`-k ${root}/socket -h ''`,'-w','start']);started=true;
  async function connect(){
   const c=new pg.Client({host:`${root}/socket`,user:'postgres',database:'postgres'});
   await c.connect();clients.push(c);return c;
  }
  const db=await connect(),other=await connect();
  await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
   CREATE TABLE member_cancellation_request(id int PRIMARY KEY,tenant_id int,member_id int,access_ended_at timestamptz,withdrawn_at timestamptz,financial_state text);
   CREATE TABLE member_cancellation_finance(request_id int,tenant_id int,member_id int);
   CREATE TABLE member_cancellation_job(id int PRIMARY KEY,request_id int,kind text,state text DEFAULT 'pending',
    next_attempt_at timestamptz DEFAULT now(),claimed_at timestamptz,claim_token uuid,last_error text);
   INSERT INTO member_cancellation_request VALUES(1,1,1,now(),NULL,'settled'),(2,1,2,now(),NULL,'pending'),(3,1,3,NULL,NULL,'pending');
   INSERT INTO member_cancellation_finance VALUES(1,1,1),(3,1,3);
   INSERT INTO member_cancellation_job(id,request_id,kind) VALUES
    (1,1,'lifecycle'),(2,1,'notify_access'),(3,2,'finance'),(4,3,'finance'),(5,1,'finance'),(6,1,'notify_finance');
   UPDATE member_cancellation_job SET state='claimed',claimed_at=now()-interval '10 minutes' WHERE id=6;`);
  await db.query(await readFile('supabase/migrations/202612310054_member_cancellation_finance_worker.sql','utf8'));
  for(const role of ['anon','authenticated']){
   assert.equal((await db.query("SELECT has_function_privilege($1,'claim_member_cancellation_finance_jobs(integer)','EXECUTE') ok",[role])).rows[0].ok,false);
  }
  await db.query('SET ROLE service_role');await other.query('SET ROLE service_role');
  const claims=await Promise.all([db.query('SELECT * FROM claim_member_cancellation_finance_jobs(5)'),other.query('SELECT * FROM claim_member_cancellation_finance_jobs(5)')]);
  assert.deepEqual(claims.flatMap(r=>r.rows.map(row=>row.id)),[5]);
  await db.query('RESET ROLE');
  assert.equal((await db.query('SELECT state FROM member_cancellation_job WHERE id=6')).rows[0].state,'uncertain');
  assert.equal((await db.query("SELECT count(*) FROM member_cancellation_job WHERE id IN (1,2,3,4) AND state='pending'")).rows[0].count,'4');
 }finally{
  for(const c of clients)await c.end();
  if(started)run('pg_ctl',['-D',`${root}/data`,'-m','immediate','-w','stop']);
  await rm(root,{recursive:true,force:true});
 }
});

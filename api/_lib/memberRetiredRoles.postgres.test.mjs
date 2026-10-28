import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('retired purchase role recovery is scoped, atomic and preserves new membership roles',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('retired-roles-'),clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
   `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<2;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
   await c.connect();clients.push(c);}
  const [admin,worker]=clients;
  await admin.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
   CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,role_id uuid);
   CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,billing_agreement_id uuid);
   CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,status text);
   CREATE TABLE membership_arrears_role_action(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,plan_id uuid,
    previous_role_id uuid,assigned_role_id uuid,restored_at timestamptz,restoration_status text,updated_at timestamptz,
    CONSTRAINT membership_arrears_role_action_restoration_status_check CHECK(restoration_status IS NULL
     OR restoration_status IN ('restored','manual_change_preserved','member_missing')));`);
  await admin.query(readFileSync('supabase/migrations/202612310056_retired_membership_arrears_roles.sql','utf8'));
  await admin.query(readFileSync('supabase/migrations/202612310057_retired_membership_role_outcome.sql','utf8'));
  await admin.query('INSERT INTO member VALUES($1,$2,$3)',[id(1),id(2),id(3)]);
  await admin.query('INSERT INTO membership_payment_plans VALUES($1,$2,$3)',[id(4),id(2),id(5)]);
  await admin.query("INSERT INTO member_membership_history VALUES($1,$2,$3,$4,'active')",[id(6),id(2),id(1),id(5)]);
  const action=async n=>admin.query(`INSERT INTO membership_arrears_role_action(id,tenant_id,member_id,plan_id,previous_role_id,assigned_role_id)
   VALUES($1,$2,$3,$4,$5,$6)`,[id(n),id(2),id(1),id(4),id(7),id(3)]);
  const restore=async(n,tenant=id(2))=>(await worker.query(
   'SELECT * FROM restore_membership_arrears_fallback_role($1,$2)',[tenant,id(n)])).rows[0].result_status;
  await worker.query('SET ROLE service_role');
  await action(10);assert.equal(await restore(10,id(99)),'already_completed');
  assert.equal(await restore(10),'restored');assert.equal(await restore(10),'already_completed');
  for(const status of ['cancelled_by_request','replaced']){
   await admin.query('UPDATE member SET role_id=$1',[id(3)]);
   await admin.query('UPDATE member_membership_history SET status=$1',[status]);
   await action(status==='replaced'?12:11);
   assert.equal(await restore(status==='replaced'?12:11),'retired_purchase_preserved');
   assert.equal((await admin.query('SELECT role_id FROM member')).rows[0].role_id,id(3));
  }
  await admin.query("UPDATE member_membership_history SET status='active'");
  await action(13);
  await admin.query('BEGIN');await admin.query('SELECT * FROM member FOR UPDATE');
  const pending=restore(13);
  await admin.query("UPDATE member_membership_history SET status='cancelled_by_request'");
  await admin.query('COMMIT');
  assert.equal(await pending,'retired_purchase_preserved');
  for(const role of ['anon','authenticated']){
   await worker.query(`SET ROLE ${role}`);await assert.rejects(restore(13),{code:'42501'});
  }
 }finally{
  for(const c of clients)await c.end();
  if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});

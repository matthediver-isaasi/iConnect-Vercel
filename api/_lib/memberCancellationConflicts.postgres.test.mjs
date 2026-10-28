import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('pending cancellation serializes with purchases and amendments without blocking receipt enrichment',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('cancellation-conflicts-'),clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
   `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<2;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
   await c.connect();clients.push(c);}
  const [a,b]=clients;
  await a.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
   CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
   CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
    status text,payment_status text,membership_renewal_date date,term_start_date date);
   CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
    agreement_type text,status text,metadata jsonb);
   CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
    organization_id uuid,term_key text,quote jsonb);
   CREATE TABLE member_cancellation_request(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
    source_record_id uuid,source_snapshot jsonb,access_ended_at timestamptz,withdrawn_at timestamptz);
   CREATE TABLE member_change_authority(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,source_record_id uuid);
   CREATE TABLE member_membership_amendment(LIKE member_change_authority INCLUDING ALL);`);
  await a.query(readFileSync('supabase/migrations/202612310058_pending_cancellation_conflicts.sql','utf8'));
  await a.query('INSERT INTO member VALUES($1,$2)',[id(1),id(2)]);
  await a.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,membership_renewal_date)
   VALUES($1,$2,$3,'active',current_date+100)`,[id(10),id(2),id(1)]);
  const cancel=client=>client.query(`INSERT INTO member_cancellation_request(id,tenant_id,member_id,source_record_id,source_snapshot)
   VALUES($1,$2,$3,$4,'{}')`,[id(20),id(2),id(1),id(10)]);
  const future=client=>client.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,membership_renewal_date)
   VALUES($1,$2,$3,'pending_payment_setup',current_date+465)`,[id(11),id(2),id(1)]);
  // Purchase wins first: cancellation must not silently end a purchased future term.
  await a.query('BEGIN');await future(a);
  const rejectCancel=assert.rejects(cancel(b),/Another membership purchase/);
  await a.query('COMMIT');await rejectCancel;
  await a.query('DELETE FROM member_membership_history WHERE id=$1',[id(11)]);
  // Cancellation wins first: a racing purchase cannot slip through.
  await a.query('BEGIN');await cancel(a);
  const rejectPurchase=assert.rejects(future(b),/pending cancellation/);
  await a.query('COMMIT');await rejectPurchase;
  await a.query("UPDATE member_membership_history SET payment_status='partial'");
  await assert.rejects(a.query("UPDATE member_membership_history SET membership_renewal_date=current_date+200"),/pending cancellation/);
  for(const table of ['member_change_authority','member_membership_amendment']){
   await assert.rejects(a.query(`INSERT INTO ${table} VALUES($1,$2,$3,$4)`,
    [id(30),id(2),id(1),id(10)]),/competing amendment/);
  }
  await assert.rejects(a.query('INSERT INTO membership_payment_quote(id,tenant_id,member_id) VALUES($1,$2,$3)',
   [id(40),id(2),id(1)]),/pending cancellation/);
  // The member acting for an organisation is not their personal membership.
  await a.query('INSERT INTO membership_payment_quote(id,tenant_id,member_id,organization_id) VALUES($1,$2,$3,$4)',
   [id(41),id(2),id(1),id(50)]);
  await assert.rejects(a.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,agreement_type,status)
   VALUES($1,$2,$3,'member','mandate_pending')`,[id(60),id(2),id(1)]),/pending cancellation/);
  await a.query('UPDATE member_cancellation_request SET withdrawn_at=now()');
  await future(a);
  await a.query('DELETE FROM member_cancellation_request');
  await a.query('DELETE FROM member_membership_history WHERE id=$1',[id(11)]);
  await a.query('INSERT INTO member_change_authority VALUES($1,$2,$3,$4)',[id(30),id(2),id(1),id(10)]);
  await assert.rejects(cancel(a),/revised financial authority/);
  for(const role of ['anon','authenticated','service_role']){
   const checks=await a.query(`SELECT has_function_privilege($1,'guard_pending_cancellation_purchase()','EXECUTE') allowed`,[role]);
   assert.equal(checks.rows[0].allowed,false);
  }
 }finally{
  for(const c of clients)await c.end();
  if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('form opt-in is tenant protected, audited, versioned and does not enable financial execution',{timeout:30000},async()=>{
 const run=(bin,args)=>{const r=spawnSync(bin,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 const root=await mkdtemp(path.join(tmpdir(),'membership-form-'));await mkdir(path.join(root,'socket'));
 const clients=[];let started=false;
 try{
  run('initdb',['-D',`${root}/data`,'-U','postgres','-A','trust','--no-locale']);
  run('pg_ctl',['-D',`${root}/data`,'-l',`${root}/log`,'-o',`-k ${root}/socket -h ''`,'-w','start']);started=true;
  async function connect(role){
   const c=new pg.Client({host:`${root}/socket`,user:'postgres',database:'postgres'});await c.connect();
   clients.push(c);if(role)await c.query(`SET ROLE ${role}`);return c;
  }
  const db=await connect();
  await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
   CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,require_authentication boolean);
   CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean,structure_scope_type text);
   CREATE FUNCTION reject_member_change_authority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Immutable audit'; END $$;`);
  await db.query('INSERT INTO form VALUES($1,$2,true),($3,$2,false)',[id(3),id(1),id(5)]);
  await db.query("INSERT INTO membership_tier_config VALUES($1,$2,true,'member'),($3,$4,true,'member')",
   [id(4),id(1),id(6),id(2)]);
  await db.query(await readFile('supabase/migrations/202612310053_membership_change_forms.sql','utf8'));
  const signature='save_membership_change_form(uuid,uuid,uuid,integer,boolean,uuid[])';
  for(const role of ['anon','authenticated']){
   assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[role,signature])).rows[0].ok,false);
   assert.equal((await db.query("SELECT has_table_privilege($1,'membership_change_form','SELECT,INSERT,UPDATE,DELETE') ok",[role])).rows[0].ok,false);
  }
  const a=await connect('service_role'),b=await connect('service_role');
  const call='SELECT save_membership_change_form($1,$2,$3,$4,$5,$6) v';
  const args=[id(1),id(3),id(7),0,true,[id(4)]];
  const saves=await Promise.allSettled([a.query(call,args),b.query(call,args)]);
  assert.equal(saves.filter(r=>r.status==='fulfilled').length,1);
  assert.match(saves.find(r=>r.status==='rejected').reason.message,/Reload/);
  assert.equal((await db.query('SELECT count(*) FROM membership_change_form_history')).rows[0].count,'1');
  await assert.rejects(a.query(call,[id(2),id(3),id(7),1,true,[id(6)]]),/tenant/);
  await assert.rejects(a.query(call,[id(1),id(5),id(7),0,true,[id(4)]]),/sign-in/);
  await assert.rejects(a.query(call,[id(1),id(3),id(7),1,true,[id(6)]]),/this tenant/);
  await assert.rejects(a.query('UPDATE membership_change_form SET enabled=false'),/permission denied/);
  await assert.rejects(db.query("UPDATE membership_change_form_history SET settings='{}'"),/Immutable audit/);
  await db.query('UPDATE membership_tier_config SET is_active=false WHERE id=$1',[id(4)]);
  await assert.rejects(a.query(call,[id(1),id(3),id(7),1,true,[id(4)]]),/active member/);
  const disabled=(await a.query(call,[id(1),id(3),id(7),1,false,[id(4)]])).rows[0].v;
  assert.equal(disabled.enabled,false);assert.equal(disabled.revision,2);
  assert.equal((await db.query("SELECT count(*) FROM membership_change_form WHERE enabled")).rows[0].count,'0');
  await db.query('DELETE FROM form WHERE id=$1',[id(3)]);
  assert.equal((await db.query('SELECT count(*) FROM membership_change_form')).rows[0].count,'0');
  assert.equal((await db.query('SELECT count(*) FROM membership_change_form_history')).rows[0].count,'2');
 }finally{
  for(const c of clients)await c.end();
  if(started)run('pg_ctl',['-D',`${root}/data`,'-m','immediate','-w','stop']);
  await rm(root,{recursive:true,force:true});
 }
});

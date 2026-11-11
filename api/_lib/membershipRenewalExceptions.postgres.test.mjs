import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
test('renewal exceptions protect tenant scope, role changes, category checkout and revisions',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('renewal-exceptions-');let db,started=false;
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 try{
  run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'pg.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
  await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE TABLE tenant(id uuid primary key);
    CREATE TABLE role(id uuid primary key,tenant_id uuid,name text);
    CREATE TABLE member(id uuid primary key,tenant_id uuid,role_id uuid);
    CREATE TABLE preference_field(id uuid primary key,tenant_id uuid,entity_scope text);
    CREATE TABLE membership_tier_config(id uuid primary key,tenant_id uuid,structure_scope_type text,structure_field_id uuid,structure_match_value text);
    CREATE TABLE form(id uuid primary key,tenant_id uuid,is_active boolean,require_authentication boolean,archived_at timestamptz,deactivate_at timestamptz,form_type text,slug text);
    CREATE TABLE member_membership_history(id uuid primary key,tenant_id uuid,member_id uuid,config_id uuid,status text,payment_status text,
      term_start_date date,term_end_date date,renewal_policy_snapshot jsonb,commitment_snapshot jsonb,incentive_snapshot jsonb,
      membership_payment_quote_id uuid,billing_agreement_id uuid);
    CREATE TABLE membership_payment_quote(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,quote jsonb);
    CREATE TABLE membership_successor_election(LIKE membership_payment_quote INCLUDING ALL);
    CREATE TABLE membership_billing_agreements(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,metadata jsonb);`);
  await db.query(readFileSync(new URL('../../supabase/migrations/202701220003_membership_renewal_exceptions.sql',import.meta.url),'utf8'));
  await db.query(readFileSync(new URL('../../supabase/migrations/202701220004_renewal_exception_existing_checkout.sql',import.meta.url),'utf8'));
  await db.query('insert into tenant values($1),($2)',[id(1),id(2)]);
  await db.query("insert into role values($1,$3,'Retired'),($2,$3,'Former')",[id(3),id(4),id(1)]);
  await db.query('insert into member values($1,$2,$3)',[id(5),id(1),id(3)]);
  await db.query("insert into preference_field values($1,$2,'member')",[id(6),id(1)]);
  await db.query("insert into membership_tier_config values($1,$4,'member',$5,'Retired'),($2,$4,'member',$5,'Full'),($3,$4,'member',$5,'Retired')",[id(7),id(8),id(9),id(1),id(6)]);
  await db.query("insert into member_membership_history(id,tenant_id,member_id,config_id,status,payment_status,term_start_date,term_end_date,renewal_policy_snapshot) select $1,$2,$3,id,'expired','paid','2020-01-01','2020-12-31',to_jsonb(c) from membership_tier_config c where id=$4",[id(10),id(1),id(5),id(7)]);
  const rule={id:id(11),matchType:'membership_class',roleId:null,fieldId:id(6),classValue:'Retired',route:'same_schedule',formId:null,restrictToClass:true};
  const save=(revision,rules=[rule],tenant=id(1))=>db.query('select save_membership_renewal_exceptions($1,$2,$3,$4) result',[tenant,'test:admin',revision,JSON.stringify(rules)]);
  const resolve=()=>db.query('select resolve_membership_renewal_exception($1,$2) result',[id(1),id(5)]);
  await db.query('set role authenticated');await assert.rejects(save(0),/permission denied/);await db.query('reset role');
  await db.query('set role service_role');assert.equal((await save(0)).rows[0].result.revision,1);
  await assert.rejects(save(0),/Settings changed/);
  await assert.rejects(save(0,[rule],id(2)),/existing membership class/);
  await assert.rejects(save(1,[rule,rule]),/duplicate/);
  assert.equal((await resolve()).rows[0].result.purchasedClassValue,'Retired');
  await db.query('reset role');await db.query('update member set role_id=$1 where id=$2',[id(4),id(5)]);
  assert.equal((await resolve()).rows[0].result.route,'same_schedule','Former retains saved category');
  for(const table of ['membership_payment_quote','membership_successor_election']){
    const insert=(n,c)=>db.query(`insert into ${table} values($1,$2,$3,null,$4)`,[id(n),id(1),id(5),JSON.stringify({simResult:{config:{id:c}}})]);
    await assert.rejects(insert(20,id(8)),/existing category/);
    await insert(21,id(9));
  }
  await assert.rejects(db.query('insert into membership_billing_agreements values($1,$2,$3,null,$4)',
    [id(30),id(1),id(5),JSON.stringify({card:{config_id:id(8)}})]),/existing category/);
  await db.query('insert into membership_billing_agreements values($1,$2,$3,null,$4)',
    [id(31),id(1),id(5),JSON.stringify({dd:{config_id:id(9)}})]);
  await assert.rejects(db.query("insert into member_membership_history(id,tenant_id,member_id,config_id,status,payment_status) values($1,$2,$3,$4,'active','paid')",
    [id(40),id(1),id(5),id(8)]),/existing category/);
  const roleRule={...rule,id:id(12),matchType:'role',fieldId:null,classValue:null,roleId:id(4)};
  await save(1,[roleRule]);assert.equal((await resolve()).rows[0].result.matchType,'role');
  await save(2,[rule,roleRule]);await assert.rejects(resolve(),/Conflicting/);
  await db.query("insert into member_membership_history(id,tenant_id,member_id,config_id,status,payment_status,membership_payment_quote_id) values($1,$2,$3,$4,'active','paid',$5)",
    [id(41),id(1),id(5),id(9),id(21)]);
  await assert.rejects(db.query("insert into member_membership_history(id,tenant_id,member_id,config_id,status,payment_status,membership_payment_quote_id) values($1,$2,$3,$4,'active','paid',$5)",
    [id(42),id(1),id(5),id(8),id(21)]),/Conflicting/,'an unrelated config cannot borrow a quote');
  await save(3,[]);assert.equal((await resolve()).rows[0].result,null);
  assert.equal((await db.query('select count(*)::int n from membership_renewal_exceptions_history')).rows[0].n,4);
 }finally{if(db)await db.end();if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop']);await h.cleanup();}
});

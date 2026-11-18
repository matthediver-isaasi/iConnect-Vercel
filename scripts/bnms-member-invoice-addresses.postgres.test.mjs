import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { emptyUpsertSQL, writeCandidate } from './bnms-member-invoice-audit-db.mjs';
import { TENANT, keys } from './lib/bnms-member-invoice-audit.mjs';

test('isolated PostgreSQL: empty-only copy, tenant/role guards, concurrent edits and zero-write replay',async()=>{
  const h=await createLocalPostgresHarness('bnms-invoice-audit-');
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  let pool,started=false;
  const id='20000000-0000-0000-0000-000000000001';
  const guest='30000000-0000-0000-0000-000000000001';
  const role='30000000-0000-0000-0000-000000000002';
  const address=Object.fromEntries(keys.map((k,i)=>[k,['Line 1','Line 2','City','County','Postcode','Country'][i]]));
  const params=[TENANT,id,...keys.map(k=>address[k]),guest];
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    pool=new pg.Pool({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
    await pool.query(`create role anon;create role authenticated;create role service_role bypassrls;
      create table tenant(id uuid primary key);create table member(id uuid primary key,tenant_id uuid,email text,role_id uuid);
      create table organization(id uuid primary key,tenant_id uuid);create table organization_group(id uuid primary key,tenant_id uuid);`);
    await pool.query('insert into tenant values($1)',[TENANT]);
    await pool.query('insert into member values($1,$2,$3,$4)',[id,TENANT,'fixture@example.test',role]);
    await pool.query(readFileSync('supabase/migrations/202612310025_structured_invoicing_addresses.sql','utf8'));
    assert.equal((await pool.query(emptyUpsertSQL,params)).rowCount,1);
    assert.equal((await pool.query(emptyUpsertSQL,params)).rowCount,0,'Replay must not rewrite committed address');
    await pool.query('delete from invoicing_address_private');
    await pool.query("insert into invoicing_address_private(tenant_id,owner_type,owner_id,invoicing_city) values($1,'member',$2,'existing')",[TENANT,id]);
    assert.equal((await pool.query(emptyUpsertSQL,params)).rowCount,0);
    assert.equal((await pool.query('select invoicing_city from invoicing_address_private')).rows[0].invoicing_city,'existing');
    await pool.query("update invoicing_address_private set invoicing_city=E' \\t '");
    assert.equal((await pool.query(emptyUpsertSQL,params)).rowCount,1,'All-whitespace target accepted');
    await pool.query('delete from invoicing_address_private');
    await pool.query('update member set role_id=$1',[guest]);
    assert.equal((await pool.query(emptyUpsertSQL,params)).rowCount,0,'Guest recheck');
    await pool.query('update member set role_id=$1',[role]);
    assert.equal((await pool.query(emptyUpsertSQL,['10000000-0000-0000-0000-000000000002',...params.slice(1)])).rowCount,0,'Tenant recheck');
    // Real competing edit of an existing blank target while the upsert waits.
    await pool.query("insert into invoicing_address_private(tenant_id,owner_type,owner_id) values($1,'member',$2)",[TENANT,id]);
    const editor=await pool.connect(),writer=await pool.connect();
    try {
      await editor.query('begin');
      await editor.query("update invoicing_address_private set invoicing_city='Concurrent editor'");
      const pending=writer.query(emptyUpsertSQL,params);
      await editor.query('commit');
      assert.equal((await pending).rowCount,0,'Atomic guard must see committed concurrent partial target');
      assert.equal((await pool.query('select invoicing_city from invoicing_address_private')).rows[0].invoicing_city,'Concurrent editor');
    } finally {editor.release();writer.release();}
    // Secondary exclusion and identity/target rechecks short-circuit before SQL.
    const m={id,tenant_id:TENANT,role_id:role};
    const row={member:m,before:Object.fromEntries(keys.map(k=>[k,null])),proposed:address};
    let attempts=0;const fake={query:async()=>{attempts++;throw Error('must not write');}};
    const fresh={members:[m],guestRole:{id:guest},secondary:[{member_id:id,role_id:guest}],addresses:[]};
    assert.match((await writeCandidate(fake,row,fresh,{})).outcome,/eligibility/);assert.equal(attempts,0);
    fresh.secondary=[];fresh.members=[{...m,role_id:guest}];
    assert.match((await writeCandidate(fake,row,fresh,{})).outcome,/eligibility/);assert.equal(attempts,0);
    fresh.members=[m];fresh.addresses=[{owner_type:'member',owner_id:id,invoicing_city:'new edit'}];
    assert.match((await writeCandidate(fake,row,fresh,{})).outcome,/target/);assert.equal(attempts,0);
  } finally {
    if(pool)await pool.end();
    if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});

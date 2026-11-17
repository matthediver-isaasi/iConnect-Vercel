import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {startAwardsPostgrest} from '../../scripts/test-support/awards-postgrest.mjs';

test('Sales conflict migration preserves latest settings and returns bounded native HTTP conflicts', {timeout:60000}, async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'sales-http-'));
  const data=path.join(root,'db'),socket=path.join(root,'sock'),port=55479;
  mkdirSync(socket);
  const run=(cmd,args)=>execFileSync(cmd,args,{stdio:'pipe'});
  const migration=name=>readFileSync(`supabase/migrations/${name}.sql`,'utf8');
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const signature="public.patch_sales_settings(uuid,integer,jsonb,text,text)";
  let started=false,db,gateway;
  try {
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-locale','--encoding=UTF8']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-o',`-F -k ${socket} -p ${port} -c listen_addresses=''`,'-w','start']);started=true;
    db=new pg.Client({host:socket,port,user:'postgres',database:'postgres'});await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$
        SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
          current_setting('request.jwt.claims',true)::jsonb->>'role') $$;
      GRANT USAGE ON SCHEMA auth TO service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY); GRANT SELECT ON tenant TO service_role;
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features text[]);
      INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid);`);
    await db.query(migration('20260907_sales_foundation'));
    await db.query(migration('20260908_sales_catalogue'));
    await db.query(`${migration('202610120004_sales_automatic_quote_task_lists').split('-- Board links')[0]} COMMIT;`);
    for(const name of ['202610180001_sales_catalogue_visibility','202610180002_sales_quote_naming'])
      await db.query(migration(name));
    await db.query('ALTER TABLE sales_catalogue_product ADD COLUMN tax_code jsonb; ALTER TABLE sales_catalogue_product ADD COLUMN create_task_on_acceptance boolean NOT NULL DEFAULT false');
    await db.query(migration('202610130002_sales_catalogue_atomic_create'));
    for(const name of ['202610180004_sales_billing_configuration','202610180005_sales_partnership_terms'])
      await db.query(migration(name));
    const inspect=async()=> (await db.query(`SELECT pg_get_functiondef(oid) definition,proacl::text acl,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure`,[signature])).rows[0];
    const before=await inspect();
    const fix=migration('202701220070_sales_settings_http_conflict');
    await db.query(fix);await db.query(fix);
    const after=await inspect();
    assert.deepEqual(after,{...before,definition:before.definition.replace(
      "RAISE EXCEPTION 'Sales settings version conflict' USING ERRCODE='40001'",
      "RAISE EXCEPTION 'Sales settings version conflict' USING ERRCODE='PT409'")});
    for(const role of ['anon','authenticated']){
      const r=await db.query('SELECT has_function_privilege($1,$2,\'execute\') allowed',[role,signature]);
      assert.equal(r.rows[0].allowed,false);
    }
    gateway=await startAwardsPostgrest(socket,port);
    const patch=(version,fields,tenant=id(1))=>gateway.client.rpc('patch_sales_settings',{
      p_tenant_id:tenant,p_expected_version:version,p_patch:fields,p_actor_id:'fixture',p_actor_type:'tenant_user',
    });
    let result=await patch(1,{partnershipTermsHtml:'<p>Retain me</p>',showSku:true,quoteSingularName:'Estimate'});
    assert.equal(result.error,null);assert.equal(result.data[0].version,2);
    const snapshot=async()=> (await db.query('SELECT row_to_json(s) value FROM sales_settings s ORDER BY tenant_id')).rows;
    const saved=await snapshot();
    const startedAt=Date.now();
    result=await patch(1,{defaultTerms:'must not save'});
    assert.equal(result.status,409);assert.equal(result.error.code,'PT409');
    assert.ok(Date.now()-startedAt<5000,'stale response must be prompt');
    assert.deepEqual(await snapshot(),saved);
    const race=await Promise.all([patch(2,{defaultTerms:'A'}),patch(2,{defaultTerms:'B'})]);
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
    assert.equal((await db.query('SELECT count(*)::int n FROM sales_audit_event')).rows[0].n,2);
    assert.equal((await db.query('SELECT partnership_terms_html FROM sales_settings')).rows[0].partnership_terms_html,'<p>Retain me</p>');
    result=await patch(1,{defaultTerms:'other tenant'},id(2));assert.equal(result.error,null);
    assert.equal((await db.query('SELECT version FROM sales_settings WHERE tenant_id=$1',[id(1)])).rows[0].version,3);
    result=await patch(1,{showSku:'wrong'},id(2));assert.equal(result.status,400);
    // Fail closed on an unexpected function body rather than editing an arbitrary exception.
    await gateway.stop();gateway=null;
    await db.query(after.definition.replace('Sales settings version conflict','Unexpected conflict'));
    await assert.rejects(db.query(fix),/Unexpected Sales settings conflict contract/);
    await db.query('ROLLBACK');
  } finally {
    if(gateway)await gateway.stop();
    if(db)await db.end();
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(root,{recursive:true,force:true});
  }
});

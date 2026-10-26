import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('exhibition database generation, ownership, concurrency, rollback and lifecycle', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'exhibition-test-'));
  const socket = path.join(root,'socket'); await mkdir(socket);
  const run = (cmd,args,input='') => {
    const r = spawnSync(cmd,args,{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); return r.stdout.trim();
  };
  const args=['-h',socket,'-p','55449','-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-Atq'];
  const sql = text => run('psql',args,text);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  let started=false;
  try {
    run('initdb',['-D',path.join(root,'data'),'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'log'),'-o',`-F -k ${socket} -c listen_addresses= -p 55449`,'-w','start']); started=true;
    sql(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.role',true),''),'service_role') $$;
    CREATE TABLE tenant(id uuid primary key);
    CREATE TABLE event(id uuid primary key,tenant_id uuid,title text);
    CREATE TABLE complex_event(LIKE event INCLUDING ALL);
    CREATE TABLE sales_catalogue_product(id uuid primary key,tenant_id uuid,unique(tenant_id,id));
    CREATE TABLE opportunity_stage(id uuid primary key,tenant_id uuid,is_lost boolean);
    CREATE TABLE opportunity(id uuid primary key,tenant_id uuid,stage_id uuid);
    CREATE TABLE sales_quote(id uuid primary key,tenant_id uuid,quote_number text,current_version int,row_version int,opportunity_id uuid,updated_at timestamptz,updated_by text,unique(tenant_id,id));
    CREATE TABLE sales_quote_version(id uuid primary key,tenant_id uuid,quote_id uuid,version_number int,status text,event_snapshot jsonb,currency text,organisation_snapshot jsonb,customer_contact_snapshot jsonb,updated_at timestamptz);
    CREATE TABLE sales_quote_line(id uuid primary key,tenant_id uuid,quote_version_id uuid,display_order int,product_id uuid,quantity numeric,catalogue_snapshot jsonb);
    CREATE TABLE sales_quote_bundle_component(id uuid primary key,tenant_id uuid,quote_line_id uuid,product_id uuid,quantity numeric);
    CREATE TABLE sales_commercial_sale(id uuid,tenant_id uuid,quote_id uuid);
    CREATE TABLE sales_quote_status_history(tenant_id uuid,quote_id uuid,quote_version_id uuid,from_status text,to_status text,actor_id text,actor_type text,note text);
    CREATE FUNCTION save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
    CREATE FUNCTION amend_sales_quote(uuid,uuid,integer,text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
    CREATE FUNCTION transition_sales_quote(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_status text,p_note text,p_actor_id text,p_actor_type text) RETURNS jsonb LANGUAGE plpgsql AS $f$
    DECLARE v record;
    BEGIN
    -- IF p_status='accepted' AND (v.billing_schedule IS NOT NULL OR EXISTS(
    RETURN '{}'; END $f$;
    CREATE FUNCTION create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text) RETURNS jsonb LANGUAGE plpgsql AS $f$ BEGIN
    -- ticket_type_id, create_task_on_acceptance, created_by, updated_by
    -- COALESCE(v_product.create_task_on_acceptance, false), p_actor_id, p_actor_id
    RETURN '{}'; END $f$;
    INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
    INSERT INTO event VALUES('${id(3)}','${id(1)}','First'),('${id(4)}','${id(1)}','Second');
    `);
    sql(await readFile('supabase/migrations/202610260001_sales_exhibition_inventory.sql','utf8'));
    const command={action:'generate',name:'Bronze',requirementName:'Bronze requirement',eventId:id(3),eventKind:'simple',prefix:' bronze ',currency:'GBP',quantity:2,priceMinor:0,idempotencyKey:'generation-1'};
    const generated=JSON.parse(sql(`SELECT manage_sales_exhibition('${id(1)}','${JSON.stringify(command)}');`));
    assert.equal(JSON.parse(sql(`SELECT manage_sales_exhibition('${id(1)}','${JSON.stringify(command)}');`)).groupId,generated.groupId);
    assert.equal(sql('SELECT count(*) FROM sales_exhibition_space'),'2');
    const space=sql("SELECT id FROM sales_exhibition_space WHERE reference='BRONZE-1'");
    const requirement=sql('SELECT id FROM sales_space_requirement');
    const group2={...command,eventId:id(4),requirementId:requirement,idempotencyKey:'generation-2'};
    sql(`SELECT manage_sales_exhibition('${id(1)}','${JSON.stringify(group2)}');`);
    assert.equal(sql("SELECT count(*) FROM sales_exhibition_space WHERE reference='BRONZE-1'"),'2');
    sql(`INSERT INTO sales_catalogue_product VALUES('${id(5)}','${id(1)}','${requirement}');
      INSERT INTO sales_quote VALUES('${id(10)}','${id(1)}','Q1',1,1,null,null,null),('${id(11)}','${id(1)}','Q2',1,1,null,null,null);
      INSERT INTO sales_quote_version(id,tenant_id,quote_id,version_number,status,event_snapshot,currency) VALUES
      ('${id(20)}','${id(1)}','${id(10)}',1,'draft','{"id":"${id(3)}","kind":"simple"}','GBP'),
      ('${id(21)}','${id(1)}','${id(11)}',1,'draft','{"id":"${id(3)}","kind":"simple"}','GBP');`);
    const snap = key => JSON.stringify({exhibition:{slots:[{key,requirementId:requirement}],selections:[{slotKey:key,spaceId:space,reference:'BRONZE-1',priceMinor:0,currency:'GBP'}]}});
    sql(`INSERT INTO sales_quote_line VALUES('${id(30)}','${id(1)}','${id(20)}',0,'${id(5)}',1,'${snap('slot1')}'),
      ('${id(31)}','${id(1)}','${id(21)}',0,'${id(5)}',1,'${snap('slot2')}');`);
    const concurrent = text => new Promise(resolve => {
      const p=spawn('psql',args); let output=''; p.stderr.on('data',x=>output+=x); p.stdout.resume(); p.on('close',code=>resolve({code,output})); p.stdin.end(text);
    });
    const results=await Promise.all([10,11].map(n=>concurrent(`BEGIN; SELECT sync_sales_exhibition('${id(1)}','${id(n)}'); SELECT pg_sleep(.2); COMMIT;`)));
    assert.equal(results.filter(r=>r.code===0).length,1,JSON.stringify(results));
    assert.match(results.find(r=>r.code!==0).output,/reserved or sold/);
    assert.equal(sql("SELECT count(*) FROM sales_space_allocation WHERE state='reserved'"),'1');
    const winner=sql("SELECT quote_id FROM sales_space_allocation WHERE state='reserved'");
    const version=winner===id(10)?id(20):id(21);
    sql(`DO $$ BEGIN BEGIN PERFORM manage_sales_exhibition('${id(1)}','{"action":"edit","id":"${space}","blocked":true}'); RAISE EXCEPTION 'should fail'; EXCEPTION WHEN serialization_failure THEN NULL; END; END $$;`);
    sql(`SELECT manage_sales_exhibition('${id(1)}','{"action":"edit","id":"${space}","priceMinor":12000}'); SELECT sync_sales_exhibition('${id(1)}','${winner}');`);
    assert.equal(sql("SELECT price_minor FROM sales_space_allocation WHERE state='reserved'"),'0');
    sql(`BEGIN; UPDATE sales_quote_version SET status='accepted' WHERE id='${version}'; ROLLBACK;`);
    assert.equal(sql("SELECT state FROM sales_space_allocation WHERE quote_id='"+winner+"'"),'reserved');
    sql(`UPDATE sales_quote_version SET status='accepted' WHERE id='${version}';`);
    assert.equal(sql("SELECT state FROM sales_space_allocation WHERE quote_id='"+winner+"'"),'sold');
    assert.equal(sql("SELECT has_table_privilege('authenticated','sales_space_allocation','INSERT')"),'f');
    assert.equal(sql("SELECT has_function_privilege('authenticated','manage_sales_exhibition(uuid,jsonb)','EXECUTE')"),'f');
    const denied=await concurrent(`SET test.role='anon'; SELECT manage_sales_exhibition('${id(1)}','{"action":"requirement","name":"Denied"}');`);
    assert.notEqual(denied.code,0);
    const cross=await concurrent(`SELECT manage_sales_exhibition('${id(2)}','{"action":"edit","id":"${space}","priceMinor":1}');`);
    assert.notEqual(cross.code,0);
  } finally {
    if(started) run('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});

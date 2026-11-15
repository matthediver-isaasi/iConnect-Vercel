import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('subcategory migration preserves legacy selections and enforces tenant and child identity', {timeout:45000}, async () => {
  const h=await createLocalPostgresHarness('session-subcategories-');
  const run=(cmd,args,input,fail=false)=>{
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    if(fail)assert.notEqual(r.status,0,'Expected rejection');else assert.equal(r.status,0,r.stderr);
    return r.stdout.trim();
  };
  const sql=(input,fail)=>run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'],input,fail);
  const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002';
  let started=false;
  try{
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE resource_category(id uuid PRIMARY KEY,tenant_id text,is_active boolean,subcategories text[]);
      CREATE TABLE complex_event_session(id int PRIMARY KEY,tenant_id text,title text);
      INSERT INTO resource_category VALUES('${a}','a',true,ARRAY['Bone','Brain','Name: with colon']),('${b}','b',true,ARRAY['Bone']);`);
    sql(readFileSync(new URL('./202701250001_session_categories.sql',import.meta.url),'utf8'));
    sql(`INSERT INTO complex_event_session VALUES(1,'a','Existing',ARRAY['${a}']::uuid[])`);
    sql(readFileSync(new URL('./202701260001_session_subcategories.sql',import.meta.url),'utf8'));
    assert.equal(sql('SELECT cardinality(category_ids)||\':\'||cardinality(subcategory_keys) FROM complex_event_session'),'1:0');
    sql(`UPDATE complex_event_session SET subcategory_keys=ARRAY['${a}:Bone','${a}:Bone','${a}:Name: with colon'] WHERE id=1`);
    assert.equal(sql('SELECT cardinality(subcategory_keys) FROM complex_event_session'),'2');
    for(const value of [`ARRAY['${a}']`,`ARRAY['${b}:Bone']`,`ARRAY['${a}:Missing']`,'NULL','ARRAY[NULL]::text[]'])
      sql(`UPDATE complex_event_session SET subcategory_keys=${value} WHERE id=1`,true);
    sql("UPDATE complex_event_session SET tenant_id='b' WHERE id=1",true);
    sql(`UPDATE resource_category SET subcategories='{}',is_active=false WHERE id='${a}'`);
    sql(`UPDATE complex_event_session SET title='Edited',subcategory_keys=subcategory_keys WHERE id=1`);
    sql(`INSERT INTO complex_event_session(id,tenant_id,subcategory_keys) VALUES(2,'a',ARRAY['${a}:Bone'])`,true);
    sql(`DELETE FROM resource_category WHERE id='${a}'`);
    sql('UPDATE complex_event_session SET subcategory_keys=subcategory_keys WHERE id=1');
    sql("UPDATE complex_event_session SET subcategory_keys='{}' WHERE id=1");
    sql(`UPDATE complex_event_session SET subcategory_keys=ARRAY['${a}:Bone'] WHERE id=1`,true);
    assert.equal(sql("SELECT has_function_privilege('anon','validate_session_subcategory_keys()','EXECUTE') OR has_function_privilege('authenticated','validate_session_subcategory_keys()','EXECUTE')"),'f');
    assert.equal(sql('SELECT cardinality(category_ids) FROM complex_event_session'),'1');
  } finally {
    if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});

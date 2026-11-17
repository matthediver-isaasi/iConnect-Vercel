import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('source queues, shared desired sets, lease fencing, local mirror and service-only grants', {timeout:120000},async()=>{
  const h=await createLocalPostgresHarness('zoom-speakers-');let db,started=false;
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE zoom_webinar(id uuid PRIMARY KEY,tenant_id uuid,zoom_webinar_id text,status text,start_time timestamptz);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,zoom_webinar_id uuid,speaker_ids uuid[],title text);
      CREATE TABLE complex_event_session(id uuid PRIMARY KEY,tenant_id uuid,zoom_webinar_id text,speaker_ids uuid[]);
      CREATE TABLE event_agenda_item(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,zoom_webinar_id uuid,speaker_ids jsonb);
      CREATE TABLE speaker(id uuid PRIMARY KEY,tenant_id uuid,full_name text,email text);
      CREATE TABLE zoom_webinar_panelist(id uuid DEFAULT gen_random_uuid(),webinar_id uuid,name text,email text,role text,zoom_panelist_id text,status text);`);
    await db.query(await readFile('supabase/migrations/202611171230_zoom_speaker_panelist_sync.sql','utf8'));
    const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    await db.query(`INSERT INTO tenant VALUES($1),($2);
      `,[id(1),id(2)]);
    await db.query(`INSERT INTO zoom_webinar VALUES($1,$2,'provider','scheduled',now()+interval '1 day')`,[id(3),id(1)]);
    await db.query(`INSERT INTO speaker VALUES($1,$2,'Speaker','speaker@example.test')`,[id(4),id(1)]);
    await db.query(`INSERT INTO event VALUES($1,$2,$3,ARRAY[$4]::uuid[],'Copied event')`,[id(5),id(1),id(3),id(4)]);
    let job=(await db.query('SELECT claim_zoom_speaker_sync($1,$2) job',[id(1),id(3)])).rows[0].job;
    assert.equal(job.desired.length,1);assert.equal(job.desired[0].found,true);
    assert.equal((await db.query('SELECT claim_zoom_speaker_sync($1,$2) job',[id(1),id(3)])).rows[0].job,null);
    assert.equal((await db.query('SELECT claim_zoom_speaker_sync($1,$2) job',[id(2),id(3)])).rows[0].job,null);
    const save=async(patch,fence=false,token=job.lease_token)=>(await db.query(
      'SELECT checkpoint_zoom_speaker_sync($1,$2,$3,$4,$5,$6) ok',[id(3),id(1),token,job.generation,patch,fence])).rows[0].ok;
    assert.equal(await save({},true),true);
    await db.query(`UPDATE event SET title='Unrelated edit' WHERE id=$1`,[id(5)]);
    assert.equal(await save({},true),true);
    await db.query(`UPDATE speaker SET email='changed@example.test' WHERE id=$1`,[id(4)]);
    assert.equal(await save({},true),false);
    const managed={'speaker@example.test':{id:'p1',name:'Speaker',owned:true}};
    assert.equal(await save({managed,status:'completed'}),true);
    assert.equal((await db.query('SELECT status FROM zoom_speaker_sync')).rows[0].status,'pending');
    assert.equal((await db.query('SELECT count(*) FROM zoom_webinar_panelist')).rows[0].count,'1');
    job=(await db.query('SELECT claim_zoom_speaker_sync($1,$2) job',[id(1),id(3)])).rows[0].job;
    assert.equal(job.desired[0].email,'changed@example.test');
    assert.equal(await save({},true,id(99)),false);
    await save({status:'completed'});
    await db.query(`INSERT INTO complex_event_session VALUES($1,$2,$3,ARRAY[$4]::uuid[])`,[id(6),id(1),id(3),id(4)]);
    await db.query(`UPDATE event SET speaker_ids='{}' WHERE id=$1`,[id(5)]);
    assert.equal((await db.query('SELECT zoom_speaker_desired($1,$2) d',[id(1),id(3)])).rows[0].d.length,1);
    await db.query(`DELETE FROM complex_event_session WHERE id=$1`,[id(6)]);
    assert.equal((await db.query('SELECT zoom_speaker_desired($1,$2) d',[id(1),id(3)])).rows[0].d.length,0);
    await db.query(`INSERT INTO event_agenda_item VALUES($1,$2,$3,NULL,$4)`,[id(7),id(1),id(5),JSON.stringify([id(4)])]);
    assert.equal((await db.query('SELECT zoom_speaker_desired($1,$2) d',[id(1),id(3)])).rows[0].d.length,1);
    job=(await db.query('SELECT claim_zoom_speaker_sync($1,$2) job',[id(1),id(3)])).rows[0].job;
    await save({managed:{},status:'completed'});
    assert.equal((await db.query('SELECT count(*) FROM zoom_webinar_panelist')).rows[0].count,'0');
    await db.query(`DELETE FROM speaker WHERE id=$1`,[id(4)]);
    assert.equal((await db.query('SELECT zoom_speaker_desired($1,$2) d',[id(1),id(3)])).rows[0].d[0].found,false);
    const permissions=(await db.query(`SELECT has_table_privilege('authenticated','zoom_speaker_sync','select') r,
      has_function_privilege('anon','queue_zoom_speakers(uuid,text)','execute') q,
      has_function_privilege('authenticated','checkpoint_zoom_speaker_sync(uuid,uuid,uuid,bigint,jsonb,boolean)','execute') w,
      has_function_privilege('service_role','claim_zoom_speaker_sync(uuid,uuid)','execute') s`)).rows[0];
    assert.deepEqual(permissions,{r:false,q:false,w:false,s:true});
  } finally {await db?.end();if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);}
});

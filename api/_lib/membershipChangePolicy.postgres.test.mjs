import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS as defaults} from './membershipChangePolicy.js';

test('policy storage permissions, validation, append-only audit and first-save concurrency', {timeout:30000},async()=>{
  const run=(bin,args,input)=>{const r=spawnSync(bin,args,{input,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const root=await mkdtemp(path.join(tmpdir(),'membership-policy-'));await mkdir(path.join(root,'socket'));
  const clients=[];let started=false;
  try {
    run('initdb',['-D',path.join(root,'data'),'-U','postgres','-A','trust','--no-locale']);
    run('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'log'),'-o',`-k ${root}/socket -h ''`,'-w','start']);started=true;
    const db=new pg.Client({host:path.join(root,'socket'),user:'postgres',database:'postgres'});await db.connect();clients.push(db);
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      INSERT INTO tenant VALUES ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');`);
    await db.query(await readFile('supabase/migrations/20261217_membership_change_policy.sql','utf8'));
    for(const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(()=>db.query('SELECT * FROM membership_change_policy'),{code:'42501'});
      await assert.rejects(()=>db.query("SELECT save_membership_change_policy(null,'a','{}',0)"),{code:'42501'});
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    await assert.rejects(()=>db.query('DELETE FROM membership_change_policy'),{code:'42501'});
    await assert.rejects(()=>db.query('UPDATE membership_change_policy_history SET actor=\'tamper\''),{code:'42501'});
    const tenant='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
    const save=(c,t,policy,rev)=>c.query('SELECT save_membership_change_policy($1,$2,$3,$4) result',[t,'test',policy,rev]);
    for(const policy of [null,{}, {...defaults,creditExpiryDays:'90'}, {...defaults,creditExpiryDays:0},
      {...defaults,creditExpiryDays:0.5},{...defaults,surplusHandling:null},{...defaults,extra:true}]) {
      await assert.rejects(()=>save(db,tenant,policy,0),{code:'22023'});
    }
    const competitor=new pg.Client({host:path.join(root,'socket'),user:'postgres',database:'postgres'});
    await competitor.connect();clients.push(competitor);await competitor.query('SET ROLE service_role');
    const race=await Promise.allSettled([save(db,tenant,defaults,0),save(competitor,tenant,defaults,0)]);
    assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(race.find(x=>x.status==='rejected').reason.code,'40001');
    const next=await save(db,tenant,{...defaults,creditExpiryDays:90},1);
    assert.equal(next.rows[0].result.revision,2);
    assert.equal((await save(db,other,defaults,0)).rows[0].result.revision,1);
    assert.equal((await db.query('select count(*)::int n from membership_change_policy_history where tenant_id=$1',[tenant])).rows[0].n,2);
    await assert.rejects(()=>save(db,tenant,defaults,1),{code:'40001'});
    assert.equal((await db.query('select policy from membership_change_policy where tenant_id=$1',[tenant])).rows[0].policy.creditExpiryDays,90);
  } finally {
    for(const db of clients)await db.end();
    if(started)run('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});

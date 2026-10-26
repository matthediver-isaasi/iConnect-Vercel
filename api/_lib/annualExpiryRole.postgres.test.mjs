import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('isolated PostgreSQL: atomic role evidence, grants, CAS, rollback and no historical replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'expiry-role-pg-'));
  const run = (bin,args) => { const r=spawnSync(bin,args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  let db, started=false;
  const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  try {
    await mkdir(`${root}/socket`);
    run('initdb',['-D',`${root}/data`,'-U','postgres','-A','trust','--no-locale']);
    run('pg_ctl',['-D',`${root}/data`,'-l',`${root}/log`,'-o',`-k ${root}/socket -h ''`,'-w','start']); started=true;
    db = new pg.Client({host:`${root}/socket`,user:'postgres',database:'postgres'}); await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE member(id uuid PRIMARY KEY, tenant_id uuid, role_id uuid, membership_paused boolean, first_name text);
      CREATE TABLE role(id uuid PRIMARY KEY, tenant_id uuid, is_tenant_admin boolean);
      CREATE TABLE membership_expiry_action(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,action_state text,previous_role_id uuid,assigned_role_id uuid);
      INSERT INTO role VALUES ('${id(3)}','${id(1)}',false),('${id(4)}','${id(1)}',false);
      INSERT INTO member VALUES ('${id(2)}','${id(1)}','${id(3)}',false,'Fixture');
      INSERT INTO membership_expiry_action VALUES ('${id(5)}','${id(1)}','${id(2)}','pending','${id(3)}','${id(4)}');`);
    await db.query(await readFile(new URL('../../supabase/migrations/20261218_annual_expiry_role_events.sql',import.meta.url),'utf8'));
    for(const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT apply_annual_expiry_role($1,$2)',[id(1),id(5)]), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM membership_expiry_action'), /permission denied/);
      await db.query('RESET ROLE');
    }
    const apply = (tenant=id(1)) => db.query('SELECT apply_annual_expiry_role($1,$2)',[tenant,id(5)]);
    const state = async () => (await db.query('SELECT * FROM membership_expiry_action')).rows[0];
    await apply(id(99)); assert.equal((await state()).role_event_state,null);
    await db.query(`UPDATE member SET role_id='${id(4)}'`); await apply();
    assert.equal((await state()).role_event_state,null, 'already matching is not a transition');
    await db.query(`UPDATE member SET role_id='${id(99)}'`); await apply();
    assert.equal((await state()).role_event_state,null, 'manual edit wins');
    await db.query(`UPDATE member SET role_id='${id(3)}',membership_paused=true`); await apply();
    assert.equal((await state()).role_event_state,null);
    await db.query(`UPDATE member SET membership_paused=false; UPDATE role SET is_tenant_admin=true WHERE id='${id(3)}'`);
    await apply(); assert.equal((await state()).role_event_state,null);
    await db.query(`UPDATE role SET is_tenant_admin=false; UPDATE membership_expiry_action SET action_state='completed'`);
    await apply(); assert.equal((await state()).role_event_state,null,'old completed action is not replayed');
    await db.query(`UPDATE membership_expiry_action SET action_state='pending'`);
    await db.query('BEGIN'); await apply(); await db.query('ROLLBACK');
    assert.equal((await state()).role_event_state,null);
    assert.equal((await db.query('SELECT role_id FROM member')).rows[0].role_id,id(3));
    await db.query('SET ROLE service_role'); await apply(); await db.query('RESET ROLE');
    const saved = await state();
    assert.equal(saved.role_event_before.role_id,id(3)); assert.equal(saved.role_event_after.role_id,id(4));
    assert.equal(saved.role_event_before.first_name,'Fixture');
    await db.query(`UPDATE member SET role_id='${id(3)}'`); await apply();
    assert.deepEqual(await state(),saved, 'persisted event cannot be replaced');
    assert.equal((await db.query('SELECT role_id FROM member')).rows[0].role_id,id(3));
    await db.query(`CREATE TABLE membership_tier_config(tenant_id uuid,effective_to date);
      CREATE TABLE member_membership_history(tenant_id uuid,expiry_enforced_at timestamptz);
      CREATE TABLE organisation_membership_history(tenant_id uuid,expiry_enforced_at timestamptz);
      CREATE TABLE system_settings(tenant_id uuid,setting_key text,setting_value text);
      INSERT INTO member_membership_history VALUES ('${id(1)}',now());`);
    await db.query(await readFile(new URL('../../supabase/migrations/20261219_annual_expiry_role_discovery.sql',import.meta.url),'utf8'));
    await db.query('SET ROLE service_role');
    const discovered = (await db.query('SELECT * FROM membership_renewal_cron_tenants_with_events()')).rows;
    assert.deepEqual(discovered, [{tenant_id:id(1),scheduled_hour:6,unresolved_role_events:'1'}],
      'committed event discovers tenant without current config or unfinished history');
    await db.query('RESET ROLE');
    await db.query(`UPDATE membership_expiry_action SET role_event_state='review'`);
    assert.equal((await db.query('SELECT * FROM membership_renewal_cron_tenants_with_events()')).rows.length,1);
    await db.query(`UPDATE membership_expiry_action SET role_event_state='completed'`);
    assert.equal((await db.query('SELECT * FROM membership_renewal_cron_tenants_with_events()')).rows.length,0);
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT * FROM membership_renewal_cron_tenants_with_events()'),/permission denied/);
    await db.query('RESET ROLE');
  } finally {
    await db?.end();
    if(started) run('pg_ctl',['-D',`${root}/data`,'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('BNMS future expiry redirects preserve snapshots, boundaries and role events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bnms-expiry-role-pg-'));
  const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
  const former = 'd536896d-b43a-4377-89ef-6c95f1496358';
  const guest = 'b640bd84-3d84-4cde-9f27-c3e80edb762f';
  const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const run = (bin,args) => {
    const r=spawnSync(bin,args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr);
  };
  let db, started=false;
  try {
    await mkdir(`${root}/socket`);
    run('initdb',['-D',`${root}/data`,'-U','postgres','-A','trust','--no-locale']);
    run('pg_ctl',['-D',`${root}/data`,'-l',`${root}/log`,'-o',`-k ${root}/socket -h ''`,'-w','start']);
    started=true;
    db=new pg.Client({host:`${root}/socket`,user:'postgres',database:'postgres'});
    await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,role_id uuid,membership_paused boolean,login_enabled boolean);
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,is_tenant_admin boolean,is_admin boolean);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,commitment_snapshot jsonb);
      CREATE TABLE membership_expiry_action(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,history_id uuid,
        history_type text,action_state text,previous_role_id uuid,assigned_role_id uuid,details jsonb,login_disabled boolean);
      INSERT INTO role VALUES ('${former}','${tenant}',false,false),('${guest}','${tenant}',false,false),
        ('${id(3)}','${tenant}',false,false);
      INSERT INTO member VALUES ('${id(1)}','${tenant}','${id(3)}',false,true);
      INSERT INTO member_membership_history VALUES ('${id(2)}','${tenant}','${id(1)}',
        '{"config":{"renewal_fallback_role_id":"${former}"},"price":156}'::jsonb);`);
    const snapshot = (await db.query('SELECT commitment_snapshot FROM member_membership_history')).rows[0];
    const insert = async (n,changes={}) => {
      const r={tenant_id:tenant,member_id:id(1),history_id:id(2),history_type:'member',
        action_state:'pending',previous_role_id:id(3),assigned_role_id:former,details:{source:'fixture'},
        login_disabled:false,...changes};
      return (await db.query(`INSERT INTO membership_expiry_action
        (id,tenant_id,member_id,history_id,history_type,action_state,previous_role_id,assigned_role_id,details,login_disabled)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id(n),r.tenant_id,r.member_id,r.history_id,r.history_type,r.action_state,r.previous_role_id,
          r.assigned_role_id,r.details,r.login_disabled])).rows[0];
    };
    // Completed historical decisions are unchanged by installation.
    await insert(10,{action_state:'completed'});
    const oldAction=(await db.query('SELECT * FROM membership_expiry_action WHERE id=$1',[id(10)])).rows[0];
    await db.query(await readFile(new URL('../../supabase/migrations/20261218_annual_expiry_role_events.sql',import.meta.url),'utf8'));
    const migration=await readFile(new URL('../../supabase/migrations/202611162100_bnms_post_grace_guest_role.sql',import.meta.url),'utf8');
    await db.query(migration);
    await db.query(migration);
    const afterOld=(await db.query('SELECT * FROM membership_expiry_action WHERE id=$1',[id(10)])).rows[0];
    for (const [key,value] of Object.entries(oldAction)) assert.deepEqual(afterOld[key],value);

    for (const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM membership_expiry_action'),/permission denied/);
      await assert.rejects(db.query('SELECT bnms_post_grace_guest_role()'),/permission denied/);
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    const action=await insert(11);
    assert.equal(action.assigned_role_id,guest);
    assert.equal(action.login_disabled,false);
    assert.equal(action.details.source,'fixture');
    assert.equal(action.details.role_policy_override.source_role_id,former);
    assert.equal(action.details.role_policy_override.target_role_id,guest);
    await db.query('SELECT apply_annual_expiry_role($1,$2)',[tenant,id(11)]);
    await db.query('RESET ROLE');
    const applied=(await db.query('SELECT * FROM membership_expiry_action WHERE id=$1',[id(11)])).rows[0];
    assert.equal(applied.role_event_after.role_id,guest);
    assert.equal(applied.role_event_before.role_id,id(3));
    assert.equal(applied.role_event_state,'pending');
    assert.deepEqual((await db.query('SELECT role_id,login_enabled FROM member')).rows[0],{role_id:guest,login_enabled:true});
    assert.deepEqual((await db.query('SELECT commitment_snapshot FROM member_membership_history')).rows[0],snapshot);

    // A stale journal must still respect a subsequent manual role edit.
    await insert(12);
    await db.query('UPDATE member SET role_id=$1',[id(99)]);
    await db.query('SELECT apply_annual_expiry_role($1,$2)',[tenant,id(12)]);
    assert.equal((await db.query('SELECT role_id FROM member')).rows[0].role_id,id(99));
    assert.equal((await insert(13,{tenant_id:id(90)})).assigned_role_id,former);
    assert.equal((await insert(14,{history_type:'organisation'})).assigned_role_id,former);
    assert.equal((await insert(15,{assigned_role_id:null})).assigned_role_id,null);
    assert.equal((await insert(16,{assigned_role_id:id(3)})).assigned_role_id,id(3));
    assert.equal((await insert(17,{action_state:'completed'})).assigned_role_id,former);
    const alreadyGuest=await insert(18,{assigned_role_id:guest});
    assert.equal(alreadyGuest.assigned_role_id,guest);
    assert.equal(alreadyGuest.details.role_policy_override,undefined);
    await assert.rejects(insert(19,{member_id:id(99)}),/ownership mismatch/);
    await assert.rejects(insert(20,{history_id:id(99)}),/ownership mismatch/);
    await db.query('UPDATE role SET is_admin=true WHERE id=$1',[guest]);
    await assert.rejects(insert(21),/target unavailable/);
    await db.query('UPDATE role SET is_admin=false,tenant_id=$2 WHERE id=$1',[guest,id(90)]);
    await assert.rejects(insert(22),/target unavailable/);
  } finally {
    if(db)await db.end();
    if(started)spawnSync('pg_ctl',['-D',`${root}/data`,'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});

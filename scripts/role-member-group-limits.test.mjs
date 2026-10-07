import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { validateRoleMemberGroupPolicy } from '../shared/roleMemberGroupPolicy.js';

test('policy accepts only nullable nonnegative integers and boolean exclusion', () => {
  for (const value of [null,0,3]) assert.equal(validateRoleMemberGroupPolicy({max_member_groups:value}),null);
  for (const value of ['',false,-1,1.2,'3',Infinity]) assert.ok(validateRoleMemberGroupPolicy({max_member_groups:value}));
  assert.ok(validateRoleMemberGroupPolicy({exclude_auto_joined_groups_from_limit:null}));
});

test('isolated PostgreSQL limits, trusted provenance, grandfathering and last-slot concurrency', async () => {
  const h = await createLocalPostgresHarness('group-limits-');
  const config = {host:h.socket,port:h.port,user:'runner',database:'postgres'};
  let c; let other; let started=false;
  const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  try {
    execFileSync('initdb',['-D',h.data,'-A','trust','-U','runner','--no-locale'],{stdio:'pipe'});
    execFileSync('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-k ${h.socket} -p ${h.port} -h ''`,'-w','start'],{stdio:'pipe'});
    started=true;
    c=new pg.Client(config); await c.connect();
    await c.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE role(id uuid primary key,tenant_id uuid);
      CREATE TABLE organization(id uuid primary key,tenant_id uuid);
      CREATE TABLE member(id uuid primary key,tenant_id uuid,role_id uuid,organization_id uuid);
      CREATE TABLE member_group_guest(id uuid primary key,tenant_id uuid,member_id uuid);
      CREATE TABLE member_group_assignment(id uuid primary key default gen_random_uuid(),tenant_id uuid,group_id uuid,member_id uuid,guest_id uuid,
        assignment_source text default 'manual',group_role text,expires_at date,
        term_start_date date,term_end_date date,term_number integer,term_length_value integer,term_length_unit text,max_terms integer,
        unique(group_id,member_id));
      CREATE TABLE member_group_role_invitation(id uuid primary key,tenant_id uuid,group_id uuid,member_id uuid,group_role text,status text,
        expires_at timestamptz,decided_at timestamptz,assignment_id uuid);
      CREATE TABLE vacancy(id uuid primary key,tenant_id uuid,member_group_id uuid,positions_available integer);
      CREATE TABLE vacancy_award(id uuid default gen_random_uuid(),tenant_id uuid,member_group_id uuid,vacancy_id uuid,
        awarded_member_id uuid,source_type text,source_id uuid,awarded_by_member_id uuid);
      CREATE FUNCTION reconcile_automatic_membership(uuid,uuid,text,uuid[],uuid[],boolean,text,integer,bigint,text)
      RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO member_group_assignment(group_id,tenant_id,group_role,member_id,assignment_source)
        SELECT $1,$2,$3,unnest($4),'automatic'; RETURN '{}'; END $$;
    `);
    const sql=await readFile('supabase/migrations/20261209_role_member_group_limits.sql','utf8');
    await c.query(sql); await c.query(sql);
    await c.query('INSERT INTO role VALUES($1,$2,3,true)',[id(1),id(2)]);
    await c.query('INSERT INTO member VALUES($1,$2,$3,null)',[id(3),id(2),id(1)]);
    const join=(client,group,source='manual') => client.query('INSERT INTO member_group_assignment(tenant_id,member_id,group_id,assignment_source) VALUES($1,$2,$3,$4)',[id(2),id(3),id(group),source]);
    const auto=group=>c.query('SELECT reconcile_automatic_membership($1,$2,$3,$4,$4,true,null,null,null,null)',[id(group),id(2),'Member',[id(3)]]);
    await assert.rejects(join(c,10,'automatic'),/only be assigned/);
    await auto(10); await auto(11);
    await join(c,12); await join(c,13); await join(c,14);
    await assert.rejects(join(c,15),/limit reached/);
    await c.query('UPDATE role SET exclude_auto_joined_groups_from_limit=false');
    await c.query("UPDATE member_group_assignment SET group_role='Chair'");
    await assert.rejects(join(c,15),/limit reached/);
    await auto(16);
    await c.query('DELETE FROM member_group_assignment WHERE assignment_source <> $1',['automatic']);
    await c.query('DELETE FROM member_group_assignment WHERE group_id=$1',[id(16)]);
    await join(c,12);
    await assert.rejects(join(c,13),/limit reached/);
    await c.query('DELETE FROM member_group_assignment WHERE group_id=$1',[id(12)]);
    other=new pg.Client(config); await other.connect();
    await c.query('BEGIN');
    await join(c,17);
    const concurrent=join(other,18).then(()=>true,e=>e.message);
    await new Promise(resolve=>setTimeout(resolve,100));
    await c.query('COMMIT');
    assert.match(await concurrent,/limit reached/);
    await c.query('UPDATE role SET max_member_groups=0,exclude_auto_joined_groups_from_limit=true');
    await assert.rejects(c.query("UPDATE member_group_assignment SET assignment_source='manual' WHERE group_id=$1",[id(10)]),/limit reached/);
    await c.query('INSERT INTO member_group_role_invitation(id,tenant_id,group_id,member_id,group_role,status) VALUES($1,$2,$3,$4,$5,$6)',[id(30),id(2),id(31),id(3),'Member','pending']);
    await assert.rejects(c.query("SELECT apply_group_invitation_decision($1,'accept','{}')",[id(30)]),/limit reached/);
    assert.equal((await c.query('SELECT status FROM member_group_role_invitation')).rows[0].status,'pending');
    await c.query('INSERT INTO vacancy VALUES($1,$2,$3,1)',[id(40),id(2),id(41)]);
    await assert.rejects(c.query("SELECT award_group_vacancy($1,$2,$3,$4,'Member',null,null,null,'{}')",[id(2),id(41),id(40),id(3)]),/limit reached/);
    assert.equal((await c.query('SELECT count(*)::int n FROM vacancy_award')).rows[0].n,0);
    // Expired rows do not use capacity, but renewing them does.
    await c.query("INSERT INTO member_group_assignment(tenant_id,member_id,group_id,expires_at) VALUES($1,$2,$3,'2000-01-01')",[id(2),id(3),id(50)]);
    await assert.rejects(c.query('UPDATE member_group_assignment SET expires_at=null WHERE group_id=$1',[id(50)]),/limit reached/);
    await c.query("UPDATE member_group_assignment SET group_role='Editor' WHERE group_id=$1",[id(50)]);
    await c.query('UPDATE role SET max_member_groups=null');
    await join(c,51);
    await c.query('UPDATE member SET role_id=null');
    await c.query('UPDATE role SET max_member_groups=0');
    await join(c,52);
    await c.query('UPDATE member SET role_id=$1',[id(1)]);
    await c.query('INSERT INTO member_group_guest VALUES($1,$2,$3)',[id(60),id(2),id(3)]);
    await join(c,53);
    await c.query('DELETE FROM member_group_guest');
    await assert.rejects(c.query('INSERT INTO member_group_assignment(tenant_id,member_id,group_id) VALUES($1,$2,$3)',[id(99),id(3),id(54)]),/target member/);
    await c.query('INSERT INTO member VALUES($1,$2,null,null)',[id(70),id(2)]);
    await c.query('INSERT INTO member_group_assignment(tenant_id,member_id,group_id) VALUES($1,$2,$3)',[id(2),id(70),id(71)]);
    await assert.rejects(c.query('SELECT merge_member_group_assignments($1,$2,$3)',[id(2),id(70),id(3)]),/limit reached/);
    assert.equal((await c.query('SELECT count(*)::int n FROM member_group_assignment WHERE member_id=$1',[id(70)])).rows[0].n,1);
    assert.equal((await c.query("SELECT has_function_privilege('authenticated','apply_group_invitation_decision(uuid,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
    assert.equal((await c.query("SELECT has_table_privilege('service_role','member_group_automatic_write_context','INSERT') allowed")).rows[0].allowed,false);
    await c.query('UPDATE role SET max_member_groups=null');
    await c.query("SELECT apply_group_invitation_decision($1,'accept','{}')",[id(30)]);
    assert.equal((await c.query('SELECT status FROM member_group_role_invitation')).rows[0].status,'accepted');
    await c.query("SELECT award_group_vacancy($1,$2,$3,$4,'Member',null,null,null,'{}')",[id(2),id(41),id(40),id(3)]);
    assert.equal((await c.query('SELECT count(*)::int n FROM vacancy_award')).rows[0].n,1);
    await c.query('SELECT merge_member_group_assignments($1,$2,$3)',[id(2),id(70),id(3)]);
    assert.equal((await c.query('SELECT count(*)::int n FROM member_group_assignment WHERE member_id=$1',[id(70)])).rows[0].n,0);
  } finally {
    await c?.end(); await other?.end();
    if(started) execFileSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop'],{stdio:'pipe'});
    await h.cleanup();
  }
});

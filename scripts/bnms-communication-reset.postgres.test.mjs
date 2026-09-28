import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { TENANT_ID, buildResetPlan } from './lib/bnms-communication-reset-plan.mjs';
import {
  loadSnapshot, acquireIdentityLocks, executePlan, verifyChanges, independentPairCheck, changeCount,
} from './lib/bnms-communication-reset-db.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const other = id(900);
const member = { primary: id(1), disabled: id(2), missing: id(3), deleted: id(4), other: id(5) };
const category = { open: id(101), restricted: id(102), roleA: id(103), inactive: id(104), publicOnly: id(105) };
const role = { a: id(201), b: id(202) };

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function fixture(client) {
  await client.query(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE public.tenant (id uuid PRIMARY KEY, name text, slug text);
    CREATE TABLE public.role (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
    CREATE TABLE public.member (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, email text, role_id uuid,
      status text, login_enabled boolean DEFAULT true,
      communications_opted_out_all boolean,
      updated_at timestamptz NOT NULL DEFAULT now(), protected_note text NOT NULL DEFAULT 'unaltered'
    );
    CREATE TABLE public.communication_category (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text,
      is_active boolean NOT NULL DEFAULT true, member_enabled boolean DEFAULT true
    );
    CREATE TABLE public.communication_category_role (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, category_id uuid NOT NULL, role_id uuid NOT NULL
    );
    CREATE TABLE public.member_communication_preference (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      member_id uuid NOT NULL, category_id uuid NOT NULL, is_subscribed boolean,
      UNIQUE (member_id, category_id)
    );
    CREATE TABLE public.email_unsubscribe (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      email text NOT NULL, member_id uuid, unsubscribe_type text NOT NULL,
      communication_category_id uuid, campaign_id uuid, source text,
      unsubscribed_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.email_subscriber (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, email text NOT NULL,
      communication_category_id uuid, opted_out boolean DEFAULT false,
      opted_out_at timestamptz, updated_at timestamptz DEFAULT now()
    );
    CREATE FUNCTION public.member_touch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;
    CREATE TRIGGER member_touch BEFORE UPDATE ON public.member
      FOR EACH ROW EXECUTE FUNCTION public.member_touch();
  `);
  // Load the reviewed production RPC implementation, not a test double.
  const migration = await readFile(new URL('../supabase/migrations/20260831_repair_atomic_email_preference_global_state.sql', import.meta.url), 'utf8');
  await client.query(migration);
  await client.query(`
    INSERT INTO public.tenant VALUES
      ('${TENANT_ID}','BNMS','bnms'), ('${other}','Other','other');
    INSERT INTO public.role VALUES
      ('${role.a}','${TENANT_ID}'), ('${role.b}','${TENANT_ID}');
    INSERT INTO public.communication_category (id,tenant_id,name,is_active,member_enabled) VALUES
      ('${category.open}','${TENANT_ID}','Open',true,true),
      ('${category.restricted}','${TENANT_ID}','Restricted',true,true),
      ('${category.roleA}','${TENANT_ID}','Role A',true,true),
      ('${category.inactive}','${TENANT_ID}','Inactive',false,true),
      ('${category.publicOnly}','${TENANT_ID}','Public only',true,false),
      ('${id(901)}','${other}','Other category',true,true);
    INSERT INTO public.communication_category_role VALUES
      ('${id(301)}','${TENANT_ID}','${category.restricted}','${role.b}'),
      ('${id(302)}','${TENANT_ID}','${category.roleA}','${role.a}');
    INSERT INTO public.member (id,tenant_id,email,role_id,status,login_enabled,communications_opted_out_all) VALUES
      ('${member.primary}','${TENANT_ID}','  PRIMARY@Example.org  ','${role.a}','active',true,true),
      ('${member.disabled}','${TENANT_ID}','disabled@example.org','${role.b}','active',false,null),
      ('${member.missing}','${TENANT_ID}',null,'${role.a}','active',true,true),
      ('${member.deleted}','${TENANT_ID}','deleted_person@deleted.local','${role.a}','deleted',true,true),
      ('${member.other}','${other}','other@example.org',null,'active',true,true);
    INSERT INTO public.member_communication_preference (id,tenant_id,member_id,category_id,is_subscribed) VALUES
      ('${id(401)}','${TENANT_ID}','${member.primary}','${category.open}',false),
      ('${id(402)}','${TENANT_ID}','${member.primary}','${category.restricted}',false),
      ('${id(403)}','${TENANT_ID}','${member.disabled}','${category.restricted}',false),
      ('${id(404)}','${TENANT_ID}','${member.missing}','${category.open}',false),
      ('${id(405)}','${TENANT_ID}','${member.deleted}','${category.open}',false),
      ('${id(406)}','${other}','${member.other}','${id(901)}',false);
    INSERT INTO public.email_unsubscribe (id,tenant_id,email,member_id,unsubscribe_type,communication_category_id,source) VALUES
      ('${id(501)}','${TENANT_ID}','primary@example.org','${member.primary}','all',null,'user'),
      ('${id(502)}','${TENANT_ID}','primary@example.org','${member.primary}','category','${category.open}','user'),
      ('${id(503)}','${TENANT_ID}','primary@example.org','${member.primary}','category','${category.restricted}','user'),
      ('${id(504)}','${TENANT_ID}','primary@example.org','${member.primary}','campaign',null,'user'),
      ('${id(505)}','${TENANT_ID}','deleted_person@deleted.local','${member.deleted}','all',null,'user'),
      ('${id(506)}','${other}','other@example.org','${member.other}','all',null,'user');
    INSERT INTO public.email_subscriber (id,tenant_id,email,communication_category_id,opted_out) VALUES
      ('${id(601)}','${TENANT_ID}','outside@example.org','${category.open}',true),
      ('${id(602)}','${TENANT_ID}','PRIMARY@example.org','${category.open}',false);
  `);
}

const pair = (snapshot, memberId, categoryId) =>
  snapshot.preferences.find(p => p.member_id === memberId && p.category_id === categoryId);

test('BNMS reset is transactional, replay-free and serializes with consent writers', { timeout: 90000 }, async () => {
  const h = await createLocalPostgresHarness('bnms-communication-reset-');
  let started = false;
  let repair;
  let writer;
  let observer;
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    // Deliberately use only the disposable Unix socket: never an environment connection URL.
    const config = { host: h.socket, port: h.port, user: 'postgres', database: 'postgres' };
    repair = new pg.Client(config);
    writer = new pg.Client(config);
    observer = new pg.Client(config);
    await Promise.all([repair.connect(), writer.connect(), observer.connect()]);
    await fixture(repair);
    const before = await loadSnapshot(repair);
    const plan = buildResetPlan(before);
    assert.equal(plan.summary.excludedDeleted, 1);
    assert.equal(plan.summary.disabledLoginMembers, 1);
    assert.equal(plan.summary.missingEmails, 1);
    assert.equal(plan.summary.globalSuppressionsRemoved, 1);
    assert.equal(plan.summary.categorySuppressionsRemoved, 1);
    assert.deepEqual(plan.removeLedgerIds, [id(501), id(502)]);
    assert.equal(plan.members.find(m => m.id === member.primary).email, 'primary@example.org');
    assert.equal(plan.members.find(m => m.id === member.disabled).clearGlobal, true);
    assert.equal(plan.members.find(m => m.id === member.missing).email, null);
    assert.equal((await independentPairCheck(repair)).global_mismatches, 3);

    // The exact same work inside a rolled-back transaction must leave no trace.
    await repair.query('BEGIN');
    await acquireIdentityLocks(repair, before);
    await executePlan(repair, before, plan);
    const transient = await loadSnapshot(repair);
    assert.equal(verifyChanges(before, transient, plan).membersCovered, 3);
    assert.deepEqual(await independentPairCheck(repair), {
      members: 3, global_mismatches: 0, expected_pairs: 6, pair_mismatches: 0,
      global_suppressions: 0, category_suppression_pairs: 0,
    });
    await repair.query('ROLLBACK');
    assert.deepEqual(await loadSnapshot(repair), before);

    await repair.query('BEGIN');
    const fresh = await loadSnapshot(repair);
    await acquireIdentityLocks(repair, fresh);
    await executePlan(repair, fresh, buildResetPlan(fresh));
    const afterInTransaction = await loadSnapshot(repair);
    verifyChanges(fresh, afterInTransaction, plan);
    assert.equal(pair(afterInTransaction, member.primary, category.open).is_subscribed, true);
    assert.equal(pair(afterInTransaction, member.primary, category.roleA).is_subscribed, true);
    assert.equal(pair(afterInTransaction, member.primary, category.restricted).is_subscribed, false);
    assert.equal(pair(afterInTransaction, member.disabled, category.restricted).is_subscribed, true);
    assert.equal(afterInTransaction.members.find(m => m.id === member.disabled).login_enabled, false);
    assert.equal(pair(afterInTransaction, member.missing, category.open).is_subscribed, true);
    assert.equal(afterInTransaction.members.find(m => m.id === member.missing).communications_opted_out_all, false);
    assert.equal(pair(afterInTransaction, member.deleted, category.open).is_subscribed, false);
    assert.deepEqual(afterInTransaction.ledgers.map(row => row.id), [id(503), id(504), id(505)]);

    // The real production RPC must wait for the repair's transaction-level advisory lock.
    const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pending = writer.query(
      'SELECT public.set_email_preference_category_state($1,$2,$3,$4,false,null)',
      [TENANT_ID, ' PRIMARY@EXAMPLE.ORG ', member.primary, category.open],
    );
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = (await observer.query(
        'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid=$1', [writerPid],
      )).rows[0];
      if (activity?.wait_event_type === 'Lock' && activity.wait_event === 'advisory') {
        blocked = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true, 'consent RPC must block on the repair identity lock');
    await repair.query('COMMIT');
    await pending;
    const committed = await loadSnapshot(repair);
    assert.equal(pair(committed, member.primary, category.open).is_subscribed, false);
    assert.equal(committed.ledgers.some(row => row.email === 'primary@example.org'
      && row.unsubscribe_type === 'category' && row.communication_category_id === category.open), true);

    // Restore the user's opt-in, then independently assert a committed zero-change replay.
    await writer.query('SELECT public.set_email_preference_category_state($1,$2,$3,$4,true,null)',
      [TENANT_ID, 'PRIMARY@example.org', member.primary, category.open]);
    const repaired = await loadSnapshot(repair);
    assert.equal(changeCount(buildResetPlan(repaired)), 0);
    assert.deepEqual(await independentPairCheck(repair), {
      members: 3, global_mismatches: 0, expected_pairs: 6, pair_mismatches: 0,
      global_suppressions: 0, category_suppression_pairs: 0,
    });
    await repair.query('BEGIN');
    await acquireIdentityLocks(repair, repaired);
    await executePlan(repair, repaired, buildResetPlan(repaired));
    await repair.query('COMMIT');
    assert.deepEqual(await loadSnapshot(repair), repaired);
    // Repair must not disable future user consent: a global false -> true write
    // remains authoritative, and a later explicit opt-in can reverse it.
    await writer.query('SELECT public.set_email_preference_global_state($1,$2,$3,true,null,$4)',
      [TENANT_ID, ' PRIMARY@EXAMPLE.ORG ', member.primary, [category.open]]);
    assert.equal((await repair.query('SELECT communications_opted_out_all FROM public.member WHERE id=$1',
      [member.primary])).rows[0].communications_opted_out_all, true);
    assert.equal((await repair.query(`SELECT count(*)::int AS count FROM public.email_unsubscribe
      WHERE tenant_id=$1 AND email=$2 AND unsubscribe_type IN ('all','category')`,
    [TENANT_ID, 'primary@example.org'])).rows[0].count, 3);
    await assert.rejects(writer.query('SELECT public.set_email_preference_category_state($1,$2,$3,$4,true,null)',
      [TENANT_ID, 'primary@example.org', member.primary, category.open]), /global email opt-out is active/);
    await writer.query('SELECT public.set_email_preference_global_state($1,$2,$3,false,null,$4)',
      [TENANT_ID, 'primary@example.org', member.primary, []]);
    await writer.query('SELECT public.set_email_preference_category_state($1,$2,$3,$4,true,null)',
      [TENANT_ID, 'primary@example.org', member.primary, category.open]);
    assert.equal((await repair.query('SELECT communications_opted_out_all FROM public.member WHERE id=$1',
      [member.primary])).rows[0].communications_opted_out_all, false);
    assert.equal((await repair.query('SELECT communications_opted_out_all FROM public.member WHERE id=$1',
      [member.other])).rows[0].communications_opted_out_all, true);
    assert.equal((await repair.query('SELECT is_subscribed FROM public.member_communication_preference WHERE member_id=$1',
      [member.other])).rows[0].is_subscribed, false);
    assert.equal((await repair.query('SELECT count(*)::int AS count FROM public.email_unsubscribe WHERE tenant_id=$1',
      [other])).rows[0].count, 1);
  } finally {
    await Promise.all([repair?.end(), writer?.end(), observer?.end()]);
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
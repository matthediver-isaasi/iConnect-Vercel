#!/usr/bin/env node
// Self-contained disposable PostgreSQL cluster. Never reads DEST/SOURCE URLs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const root = await mkdtemp(join(tmpdir(), 'survey-attendee-pg-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const data = join(root, 'data');
const clients = [];
let started = false;
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
try {
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-U', 'postgres'], { stdio: 'pipe' });
  execFileSync('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-F -h 127.0.0.1 -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  const connect = async () => {
    const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
    clients.push(client);
    await client.connect();
    return client;
  };
  const db = await connect();
  await db.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE tenant(id uuid PRIMARY KEY);
    CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,login_enabled boolean,membership_paused boolean);
    CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,status text,attendee_email text,note text);
    CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
    CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean,form_type text,survey_settings jsonb,deactivate_at timestamptz);
    CREATE TABLE event_survey_assignment(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,event_type text,event_id uuid,
      complex_event_id uuid,status text,opens_at timestamptz,closes_at timestamptz);
    CREATE TABLE certificate_survey_entitlement(id uuid PRIMARY KEY,tenant_id uuid,booking_source text,booking_id uuid,
      assignment_id uuid,recipient_email text,expires_at timestamptz,revoked_at timestamptz,completed_at timestamptz);
    CREATE TABLE certificate_survey_credential(id uuid PRIMARY KEY,entitlement_id uuid,delivery_id uuid,campaign_delivery_id uuid,
      expires_at timestamptz,revoked_at timestamptz);
    CREATE TABLE attendee_cpd_certificate_delivery(id uuid PRIMARY KEY,tenant_id uuid,booking_source text,booking_id uuid,status text);
    CREATE TABLE campaign_survey_delivery(LIKE attendee_cpd_certificate_delivery INCLUDING ALL);
  `);
  const migration = await readFile(new URL('../supabase/migrations/20261125_survey_invitation_attendee.sql', import.meta.url), 'utf8');
  await db.query(migration);
  await db.query(migration);
  check(true, 'migration repeatable');
  const tenant = randomUUID(), otherTenant = randomUUID(), member = randomUUID(), booking = randomUUID();
  const form = randomUUID(), assignment = randomUUID(), event = randomUUID(), grant = randomUUID(), credential = randomUUID(), delivery = randomUUID();
  await db.query('INSERT INTO tenant VALUES($1),($2)', [tenant, otherTenant]);
  await db.query('INSERT INTO member(id,tenant_id,email,login_enabled) VALUES($1,$2,$3,true)', [member, tenant, 'attendee@test.org']);
  await db.query(`INSERT INTO booking(id,tenant_id,event_id,status,attendee_email) VALUES($1,$2,$3,'confirmed','attendee@test.org')`, [booking, tenant, event]);
  await db.query(`INSERT INTO form VALUES($1,$2,true,'survey','{"status":"published","current_version":1}',null)`, [form, tenant]);
  await db.query(`INSERT INTO event_survey_assignment(id,tenant_id,form_id,event_type,event_id,status)
    VALUES($1,$2,$3,'event',$4,'active')`, [assignment, tenant, form, event]);
  await db.query(`INSERT INTO certificate_survey_entitlement(id,tenant_id,booking_source,booking_id,assignment_id,recipient_email,expires_at)
    VALUES($1,$2,'standard',$3,$4,'attendee@test.org',now()+interval '1 day')`, [grant, tenant, booking, assignment]);
  await db.query(`INSERT INTO attendee_cpd_certificate_delivery VALUES($1,$2,'standard',$3,'accepted')`, [delivery, tenant, booking]);
  await db.query(`INSERT INTO certificate_survey_credential(id,entitlement_id,delivery_id,expires_at)
    VALUES($1,$2,$3,now()+interval '1 day')`, [credential, grant, delivery]);
  const snapshot = async (table = 'booking') => {
    const result = await db.query(`SELECT b.survey_invitation_revision AS b,g.survey_invitation_revision AS g,m.survey_invitation_revision AS m
      FROM ${table} b,certificate_survey_entitlement g,member m WHERE b.id=$1 AND g.id=$2 AND m.id=$3`, [booking, grant, member]);
    return result.rows[0];
  };
  const invoke = async (client, revisions, overrides = {}) => client.query(
    'SELECT confirm_survey_invitation_attendee($1,$2,$3,$4,$5,$6,$7,$8)',
    [overrides.tenant || tenant, grant, credential, member, revisions.b, revisions.g, revisions.m, 'a'.repeat(64)]);
  const service = await connect();
  await service.query('SET ROLE service_role');
  const denied = async action => {
    await assert.rejects(action, error => error.code === '42501');
    checks++;
  };
  for (const role of ['anon', 'authenticated']) {
    const client = await connect();
    await client.query(`SET ROLE ${role}`);
    await denied(() => client.query('SELECT * FROM survey_invitation_attendee'));
    await denied(() => invoke(client, { b: 0, g: 0, m: 0 }));
  }
  await denied(() => service.query(`INSERT INTO survey_invitation_attendee VALUES($1,$2,$3,'attendee@test.org',$4,now())`,
    [grant, tenant, member, 'a'.repeat(64)]));
  await denied(() => invoke(service, { b: 0, g: 0, m: 0 }, { tenant: otherTenant }));
  const size = async () => Number((await db.query('SELECT count(*) AS n FROM survey_invitation_attendee')).rows[0].n);
  await invoke(service, await snapshot());
  check(await size() === 1, 'service RPC creates association');
  await db.query(migration);
  check(await size() === 1, 'rerun preserves existing association');
  await service.query('SELECT * FROM survey_invitation_attendee');
  check(true, 'service can read association');

  // Each state mutation invalidates current authority; reverting cannot revive
  // a stale confirmation captured before the mutation.
  for (const [table, column, changed, restored] of [
    ['booking', 'attendee_email', "'other@test.org'", "'attendee@test.org'"],
    ['booking', 'note', "'edited'", 'null'],
    ['member', 'email', "'other@test.org'", "'attendee@test.org'"],
    ['member', 'tenant_id', `'${otherTenant}'`, `'${tenant}'`],
    ['member', 'login_enabled', 'false', 'true'],
    ['member', 'membership_paused', 'true', 'null'],
    ['certificate_survey_entitlement', 'revoked_at', 'now()', 'null'],
    ['certificate_survey_entitlement', 'completed_at', 'now()', 'null'],
    ['certificate_survey_entitlement', 'recipient_email', "'other@test.org'", "'attendee@test.org'"],
  ]) {
    const stale = await snapshot();
    await invoke(service, stale);
    const id = table === 'member' ? member : table === 'booking' ? booking : grant;
    await db.query(`UPDATE ${table} SET ${column}=${changed} WHERE id=$1`, [id]);
    check(await size() === 0, `${table}.${column} invalidates association`);
    await denied(() => invoke(service, stale));
    await db.query(`UPDATE ${table} SET ${column}=${restored} WHERE id=$1`, [id]);
    await denied(() => invoke(service, stale));
    check(await size() === 0, 'reverted authority cannot restore stale confirmation');
  }
  // Concurrent change: RPC blocks on the locked booking, then rejects the
  // captured revision after commit rather than resurrecting its association.
  const updater = await connect();
  const beforeRace = await snapshot();
  await updater.query('BEGIN');
  await updater.query("UPDATE booking SET note='concurrent' WHERE id=$1", [booking]);
  let settled = false;
  const pending = invoke(service, beforeRace).then(
    () => { settled = true; return null; },
    error => { settled = true; return error; },
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  check(!settled, 'confirmation waits for booking update lock');
  await updater.query('COMMIT');
  check((await pending)?.code === '42501', 'stale concurrent confirmation rejected');
  check(await size() === 0, 'race leaves no association');
  // The reverse ordering is also safe: a later update deletes a committed link.
  await service.query('BEGIN');
  await invoke(service, await snapshot());
  let updateFinished = false;
  const update = updater.query("UPDATE booking SET note='after confirm' WHERE id=$1", [booking]).then(() => { updateFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  check(!updateFinished, 'booking update waits for confirmation share lock');
  await service.query('COMMIT');
  await update;
  check(await size() === 0, 'later booking update invalidates confirmed association');
  for (const [table, mutation, restore, id] of [
    ['member', "email='other@test.org'", "email='attendee@test.org'", member],
    ['certificate_survey_entitlement', 'revoked_at=now()', 'revoked_at=null', grant],
  ]) {
    const stale = await snapshot();
    await updater.query('BEGIN');
    await updater.query(`UPDATE ${table} SET ${mutation} WHERE id=$1`, [id]);
    let finished = false;
    const blocked = invoke(service, stale).then(() => { finished = true; return null; },
      error => { finished = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 100));
    check(!finished, `confirmation waits for ${table} authority lock`);
    await updater.query('COMMIT');
    check((await blocked)?.code === '42501', `${table} concurrent stale confirmation rejected`);
    await updater.query(`UPDATE ${table} SET ${restore} WHERE id=$1`, [id]);
    await denied(() => invoke(service, stale));
    check(await size() === 0, `${table} revert cannot revive the association`);
  }

  // Credential/delivery and survey authority are rechecked inside SQL.
  for (const [table, column, changed, restored, id] of [
    ['certificate_survey_credential', 'revoked_at', 'now()', 'null', credential],
    ['certificate_survey_credential', 'expires_at', "now()-interval '1 day'", "now()+interval '1 day'", credential],
    ['attendee_cpd_certificate_delivery', 'status', "'pending'", "'accepted'", delivery],
    ['event_survey_assignment', 'status', "'archived'", "'active'", assignment],
    ['event_survey_assignment', 'closes_at', "now()-interval '1 day'", 'null', assignment],
    ['form', 'is_active', 'false', 'true', form],
  ]) {
    await db.query(`UPDATE ${table} SET ${column}=${changed} WHERE id=$1`, [id]);
    await denied(async () => invoke(service, await snapshot()));
    await db.query(`UPDATE ${table} SET ${column}=${restored} WHERE id=$1`, [id]);
  }
  // Complex bookings and accepted campaign deliveries use the same boundary.
  await db.query('INSERT INTO complex_event_booking SELECT * FROM booking');
  await db.query("UPDATE certificate_survey_entitlement SET booking_source='complex' WHERE id=$1", [grant]);
  await db.query("UPDATE event_survey_assignment SET event_type='complex_event',complex_event_id=event_id,event_id=null WHERE id=$1", [assignment]);
  await db.query("INSERT INTO campaign_survey_delivery SELECT id,tenant_id,'complex',booking_id,status FROM attendee_cpd_certificate_delivery");
  await db.query('UPDATE certificate_survey_credential SET campaign_delivery_id=delivery_id,delivery_id=null WHERE id=$1', [credential]);
  await invoke(service, await snapshot('complex_event_booking'));
  check(await size() === 1, 'complex campaign confirmation');
  await db.query("UPDATE complex_event_booking SET note='edited' WHERE id=$1", [booking]);
  check(await size() === 0, 'complex edit invalidates');
  await invoke(service, await snapshot('complex_event_booking'));
  await db.query('DELETE FROM complex_event_booking WHERE id=$1', [booking]);
  check(await size() === 0, 'complex deletion invalidates');
  console.log(JSON.stringify({ passed: true, checks, disposableLocalPostgres: true, migrationAppliedToDestination: false }));
} finally {
  for (const client of clients) await client.end().catch(() => {});
  if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
  await rm(root, { recursive: true, force: true });
}
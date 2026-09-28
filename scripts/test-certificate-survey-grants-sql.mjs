#!/usr/bin/env node
// Only an empty, local, disposable database. Never connect to DEST or SOURCE.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.CERTIFICATE_SURVEY_TEST_DATABASE_URL;
if (!url) throw new Error('CERTIFICATE_SURVEY_TEST_DATABASE_URL is required');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)
  || target.pathname !== '/certificate_survey_test'
  || !target.port) throw new Error('Only a local disposable certificate_survey_test database is allowed');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const empty = await client.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
  if (empty.rows[0].count !== 0) throw new Error('Disposable database must be empty');
  await client.query(`DO $roles$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $roles$;
    CREATE TABLE public.tenant(id uuid PRIMARY KEY);
    CREATE TABLE public.event(id uuid PRIMARY KEY);
    CREATE TABLE public.complex_event(id uuid PRIMARY KEY);
    CREATE TABLE public.form(id uuid PRIMARY KEY, tenant_id uuid, form_type text,
      is_active boolean, deactivate_at timestamptz, survey_settings jsonb);
    CREATE TABLE public.survey_version(id uuid PRIMARY KEY, tenant_id uuid, form_id uuid, version_number integer);
    CREATE TABLE public.event_survey_assignment(id uuid PRIMARY KEY, tenant_id uuid, form_id uuid,
      event_type text, event_id uuid, complex_event_id uuid, status text,
      opens_at timestamptz, closes_at timestamptz);
    CREATE TABLE public.booking(id uuid PRIMARY KEY, tenant_id uuid, event_id uuid, status text, attendee_email text);
    CREATE TABLE public.complex_event_booking(id uuid PRIMARY KEY, tenant_id uuid, event_id uuid, status text, attendee_email text);
    CREATE TABLE public.attendee_cpd_certificate_delivery(
      id uuid PRIMARY KEY, tenant_id uuid, booking_source text, booking_id uuid, status text);
    CREATE TABLE public.form_submission(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
      form_id uuid, event_id uuid, complex_event_id uuid, survey_assignment_id uuid,
      survey_version_id uuid, submitted_by_email text);
    CREATE FUNCTION public.create_survey_submission(p_submission jsonb, p_answers jsonb)
      RETURNS SETOF public.form_submission LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public AS $f$
      BEGIN
        RETURN QUERY INSERT INTO public.form_submission(tenant_id,form_id,event_id,complex_event_id,
          survey_assignment_id,survey_version_id,submitted_by_email)
        VALUES ((p_submission->>'tenant_id')::uuid,(p_submission->>'form_id')::uuid,
          (p_submission->>'event_id')::uuid,(p_submission->>'complex_event_id')::uuid,
          (p_submission->>'survey_assignment_id')::uuid,(p_submission->>'survey_version_id')::uuid,
          p_submission->>'submitted_by_email') RETURNING *;
      END $f$;`);
  const sql = await readFile(new URL('../supabase/migrations/20261121_certificate_survey_grants.sql', import.meta.url), 'utf8');
  await client.query(sql);
  const id = () => randomUUID();
  const tenant = id(); const event = id(); const form = id();
  const version = id(); const assignment = id(); const booking = id();
  const tokenHash = 'a'.repeat(64);
  await client.query('INSERT INTO tenant(id) VALUES($1)', [tenant]);
  await client.query('INSERT INTO event(id) VALUES($1)', [event]);
  await client.query(`INSERT INTO form(id,tenant_id,form_type,is_active,survey_settings)
      VALUES($1,$2,'survey',true,'{"status":"published","current_version":1}')`, [form, tenant]);
  await client.query('INSERT INTO survey_version(id,tenant_id,form_id,version_number) VALUES($1,$2,$3,1)',
    [version, tenant, form]);
  await client.query(`INSERT INTO event_survey_assignment(id,tenant_id,form_id,event_type,event_id,status)
      VALUES($1,$2,$3,'event',$4,'active')`, [assignment, tenant, form, event]);
  await client.query(`INSERT INTO booking(id,tenant_id,event_id,status,attendee_email)
      VALUES($1,$2,$3,'confirmed','guest@example.org')`, [booking, tenant, event]);
  const entitlement = (await client.query(`INSERT INTO certificate_survey_entitlement
    (tenant_id,booking_source,booking_id,assignment_id,recipient_email,expires_at)
    VALUES($1,'standard',$2,$3,'guest@example.org',now()+interval '1 day') RETURNING id`,
  [tenant, booking, assignment])).rows[0].id;
  const delivery = id();
  await client.query(`INSERT INTO attendee_cpd_certificate_delivery(id,tenant_id,booking_source,booking_id,status)
    VALUES($1,$2,'standard',$3,'pending')`, [delivery, tenant, booking]);
  await client.query(`INSERT INTO certificate_survey_credential
    (entitlement_id,delivery_id,token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '1 day')`, [entitlement, delivery, tokenHash]);
  const payload = {
    tenant_id: tenant, form_id: form, event_id: event, survey_assignment_id: assignment,
    survey_version_id: version, submitted_by_email: 'guest@example.org',
  };
  const claim = () => client.query('SELECT * FROM create_certificate_survey_submission($1,$2,$3)',
    [payload, [], tokenHash]);
  await client.query('SET ROLE anon');
  await assert.rejects(claim(), /permission denied/);
  await assert.rejects(client.query('SELECT * FROM certificate_survey_entitlement'), /permission denied/);
  await client.query('RESET ROLE');
  await client.query('SET ROLE service_role');
  await assert.rejects(claim(), /invitation unavailable/);
  await client.query('RESET ROLE');
  await client.query(`UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1`, [delivery]);
  await client.query('SET ROLE service_role');
  const first = await claim();
  assert.equal(first.rowCount, 1);
  await assert.rejects(claim(), /invitation unavailable/);
  await client.query('RESET ROLE');
  assert.equal((await client.query('SELECT response_id FROM certificate_survey_entitlement WHERE id=$1',
    [entitlement])).rows[0].response_id, first.rows[0].id);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM form_submission')).rows[0].n, 1);
  await assert.rejects(client.query('UPDATE certificate_survey_entitlement SET completed_at = NULL WHERE id=$1', [entitlement]),
    /immutable/);
  await assert.rejects(client.query('UPDATE certificate_survey_entitlement SET response_id = NULL WHERE id=$1', [entitlement]),
    /immutable/);
  // A second booking of the same event cannot submit through the first
  // recipient's completed entitlement. Test live rechecks on its own grant.
  const secondBooking = id();
  const secondHash = 'b'.repeat(64);
  await client.query(`INSERT INTO booking(id,tenant_id,event_id,status,attendee_email)
    VALUES($1,$2,$3,'confirmed','other@example.org')`, [secondBooking, tenant, event]);
  const secondEntitlement = (await client.query(`INSERT INTO certificate_survey_entitlement
    (tenant_id,booking_source,booking_id,assignment_id,recipient_email,expires_at)
    VALUES($1,'standard',$2,$3,'other@example.org',now()+interval '1 day') RETURNING id`,
  [tenant, secondBooking, assignment])).rows[0].id;
  const mismatchedDelivery = id();
  await client.query(`INSERT INTO attendee_cpd_certificate_delivery(id,tenant_id,booking_source,booking_id,status)
    VALUES($1,$2,'standard',$3,'pending')`, [mismatchedDelivery, tenant, booking]);
  await assert.rejects(client.query(`INSERT INTO certificate_survey_credential
    (entitlement_id,delivery_id,token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '1 day')`,
  [secondEntitlement, mismatchedDelivery, 'd'.repeat(64)]), /must belong to its pending delivery/);
  const secondDelivery = id();
  await client.query(`INSERT INTO attendee_cpd_certificate_delivery(id,tenant_id,booking_source,booking_id,status)
    VALUES($1,$2,'standard',$3,'pending')`, [secondDelivery, tenant, secondBooking]);
  await client.query(`INSERT INTO certificate_survey_credential
    (entitlement_id,delivery_id,token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '1 day')`, [secondEntitlement, secondDelivery, secondHash]);
  await client.query(`UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1`, [secondDelivery]);
  const secondPayload = { ...payload, submitted_by_email: 'other@example.org' };
  const secondClaim = () => client.query('SELECT * FROM create_certificate_survey_submission($1,$2,$3)',
    [secondPayload, [], secondHash]);
  await client.query(`UPDATE attendee_cpd_certificate_delivery SET status='failed' WHERE id=$1`, [secondDelivery]);
  await assert.rejects(secondClaim(), /invitation unavailable/);
  await client.query(`UPDATE attendee_cpd_certificate_delivery SET status='unknown' WHERE id=$1`, [secondDelivery]);
  await assert.rejects(secondClaim(), /invitation unavailable/);
  await client.query(`UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1`, [secondDelivery]);
  await client.query('UPDATE booking SET status=$1 WHERE id=$2', ['cancelled', secondBooking]);
  await assert.rejects(secondClaim(), /no longer confirmed/);
  await client.query('UPDATE booking SET status=$1 WHERE id=$2', ['confirmed', secondBooking]);
  await client.query('UPDATE booking SET attendee_email=$1 WHERE id=$2', ['changed@example.org', secondBooking]);
  await assert.rejects(secondClaim(), /no longer confirmed/);
  await client.query('UPDATE booking SET attendee_email=$1 WHERE id=$2', ['other@example.org', secondBooking]);
  await client.query('UPDATE event_survey_assignment SET status=$1 WHERE id=$2', ['archived', assignment]);
  await assert.rejects(secondClaim(), /scope or publication/);
  await client.query('UPDATE event_survey_assignment SET status=$1 WHERE id=$2', ['active', assignment]);
  await assert.rejects(client.query('SELECT * FROM create_certificate_survey_submission($1,$2,$3)',
    [{ ...secondPayload, form_id: id() }, [], secondHash]), /scope or publication/);
  await client.query('UPDATE form SET survey_settings=$1 WHERE id=$2',
    [{ status: 'draft', current_version: 1 }, form]);
  await assert.rejects(secondClaim(), /scope or publication/);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM form_submission')).rows[0].n, 1);
  assert.equal((await client.query('SELECT completed_at FROM certificate_survey_entitlement WHERE id=$1',
    [secondEntitlement])).rows[0].completed_at, null);
  // Two independent connections racing the same booking must have exactly
  // one durable winner. No response row survives a losing transaction.
  await client.query('UPDATE form SET survey_settings=$1 WHERE id=$2',
    [{ status: 'published', current_version: 1 }, form]);
  const raceBooking = id();
  const raceHash = 'c'.repeat(64);
  await client.query(`INSERT INTO booking(id,tenant_id,event_id,status,attendee_email)
    VALUES($1,$2,$3,'confirmed','race@example.org')`, [raceBooking, tenant, event]);
  const raceEntitlement = (await client.query(`INSERT INTO certificate_survey_entitlement
    (tenant_id,booking_source,booking_id,assignment_id,recipient_email,expires_at)
    VALUES($1,'standard',$2,$3,'race@example.org',now()+interval '1 day') RETURNING id`,
  [tenant, raceBooking, assignment])).rows[0].id;
  const raceDelivery = id();
  await client.query(`INSERT INTO attendee_cpd_certificate_delivery(id,tenant_id,booking_source,booking_id,status)
    VALUES($1,$2,'standard',$3,'pending')`, [raceDelivery, tenant, raceBooking]);
  await client.query(`INSERT INTO certificate_survey_credential
    (entitlement_id,delivery_id,token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '1 day')`, [raceEntitlement, raceDelivery, raceHash]);
  await client.query(`UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1`, [raceDelivery]);
  const otherClient = new pg.Client({ connectionString: url });
  await otherClient.connect();
  try {
    const racePayload = { ...payload, submitted_by_email: 'race@example.org' };
    const result = await Promise.allSettled([client, otherClient].map(connection =>
      connection.query('SELECT * FROM create_certificate_survey_submission($1,$2,$3)',
        [racePayload, [], raceHash])));
    assert.deepEqual(result.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM form_submission')).rows[0].n, 2);
  } finally {
    await otherClient.end();
  }
  console.log('Disposable SQL grant, role, atomic completion and immutable-response checks passed');
} finally {
  await client.end();
}
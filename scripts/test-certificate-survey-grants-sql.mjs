#!/usr/bin/env node
// Only an empty, local, disposable database. Never connect to DEST or SOURCE.
/*
 * Run against a newly bootstrapped disposable local PostgreSQL instance
 * (requires initdb, pg_ctl, createdb, Node dependencies; do not use live DBs):
 *
 *   set -eu
 *   tmp=$(mktemp -d)
 *   trap 'pg_ctl -D "$tmp/db" -m immediate stop >/dev/null 2>&1 || :; rm -rf "$tmp"' EXIT
 *   port=$(node -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
 *   initdb -D "$tmp/db" -A trust -U "$(id -un)" >/dev/null
 *   pg_ctl -D "$tmp/db" -o "-h 127.0.0.1 -p $port -k $tmp" -l "$tmp/postgres.log" -w start >/dev/null
 *   createdb -h 127.0.0.1 -p "$port" -U "$(id -un)" certificate_survey_test
 *   CERTIFICATE_SURVEY_TEST_DATABASE_URL="postgres://$(id -un)@127.0.0.1:$port/certificate_survey_test" \
 *     node scripts/test-certificate-survey-grants-sql.mjs
 *
 * Execute in a single shell session so the trap shuts down and removes the DB.
 */
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
    CREATE TABLE public.email_campaign(id uuid PRIMARY KEY, tenant_id uuid);
    CREATE TABLE public.email_campaign_recipient(id uuid PRIMARY KEY, campaign_id uuid, email text, status text);
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
      survey_version_id uuid, submitted_by_email text, is_anonymous boolean NOT NULL DEFAULT false,
      survey_respondent_key text, submission_data jsonb, created_date timestamptz DEFAULT now());`);
  // Install the production nested RPC verbatim, not a stub: the real allowlists,
  // linkage checks, answer writes and transaction rollback must all execute.
  const surveySql = await readFile(new URL('../supabase/migrations/20260804_event_survey_assignment.sql', import.meta.url), 'utf8');
  const surveyFunction = surveySql.match(/CREATE OR REPLACE FUNCTION public\.create_survey_submission\(.*?\n\$fn\$;/s)?.[0];
  if (!surveyFunction) throw new Error('Production create_survey_submission definition not found');
  const scoreSql = await readFile(new URL('../supabase/migrations/20260804_survey_form_type_score.sql', import.meta.url), 'utf8');
  const answerTable = scoreSql.match(/CREATE TABLE IF NOT EXISTS survey_answer \(.*?\n\);/s)?.[0];
  if (!answerTable) throw new Error('Production survey_answer schema not found');
  await client.query(answerTable);
  await client.query(surveyFunction);
  const sql = await readFile(new URL('../supabase/migrations/20261121_certificate_survey_grants.sql', import.meta.url), 'utf8');
  await client.query(sql);
  const campaignSql = await readFile(new URL('../supabase/migrations/20261122_campaign_survey_delivery.sql', import.meta.url), 'utf8');
  await client.query(campaignSql);
  await client.query(campaignSql); // deployment reruns are safe
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
    [payload, '[]', tokenHash]);
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
    [secondPayload, '[]', secondHash]);
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
    [{ ...secondPayload, form_id: id() }, '[]', secondHash]), /scope or publication/);
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
        [racePayload, '[]', raceHash])));
    assert.deepEqual(result.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM form_submission')).rows[0].n, 2);
  } finally {
    await otherClient.end();
  }
  const campaign = id(); const campaignRecipient = id(); const campaignBooking = id();
  await client.query('INSERT INTO email_campaign VALUES($1,$2)', [campaign, tenant]);
  await client.query("INSERT INTO email_campaign_recipient VALUES($1,$2,'campaign@example.org','processing')", [campaignRecipient, campaign]);
  await client.query("INSERT INTO booking VALUES($1,$2,$3,'confirmed','campaign@example.org')", [campaignBooking, tenant, event]);
  const campaignEntitlement = (await client.query(`INSERT INTO certificate_survey_entitlement
    (tenant_id,booking_source,booking_id,assignment_id,recipient_email,expires_at)
    VALUES($1,'standard',$2,$3,'campaign@example.org',now()+interval '1 day') RETURNING id`,
  [tenant, campaignBooking, assignment])).rows[0].id;
  const insertDelivery = (purpose = 'live', destination = 'campaign@example.org') => client.query(`
    INSERT INTO campaign_survey_delivery(tenant_id,campaign_id,campaign_recipient_id,purpose,booking_source,
      booking_id,event_type,event_id,source_email,destination_email)
    VALUES($1,$2,$3,$4,'standard',$5,'event',$6,'campaign@example.org',$7) RETURNING id`,
  [tenant, campaign, purpose === 'live' ? campaignRecipient : null, purpose, campaignBooking, event, destination]);
  await assert.rejects(insertDelivery('live', 'other@example.org'), /check constraint/);
  const failedDelivery = (await insertDelivery()).rows[0].id;
  await assert.rejects(insertDelivery(), /unique constraint/);
  const campaignHash = 'd'.repeat(64);
  const insertCredential = (deliveryId, hash) => client.query(`INSERT INTO certificate_survey_credential
    (entitlement_id,campaign_delivery_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`,
  [campaignEntitlement, deliveryId, hash]);
  await insertCredential(failedDelivery, campaignHash);
  const campaignClaim = hash => client.query('SELECT * FROM create_certificate_survey_submission($1,$2,$3)',
    [{ ...payload, submitted_by_email: 'campaign@example.org' }, '[]', hash]);
  await assert.rejects(campaignClaim(campaignHash), /invitation unavailable/);
  await client.query("UPDATE campaign_survey_delivery SET status='failed',resolved_at=now() WHERE id=$1", [failedDelivery]);
  await assert.rejects(campaignClaim(campaignHash), /invitation unavailable/);
  const liveDelivery = (await insertDelivery()).rows[0].id;
  const liveHash = 'e'.repeat(64);
  await insertCredential(liveDelivery, liveHash);
  const testDelivery = (await insertDelivery('test', 'reviewer@example.org')).rows[0].id;
  const testHash = 'f'.repeat(64);
  await insertCredential(testDelivery, testHash);
  await client.query("UPDATE campaign_survey_delivery SET status='accepted',resolved_at=now() WHERE id=ANY($1)", [[liveDelivery, testDelivery]]);
  await assert.rejects(insertCredential(liveDelivery, '9'.repeat(64)), /pending delivery/);
  await assert.rejects(client.query("UPDATE campaign_survey_delivery SET status='failed' WHERE id=$1", [liveDelivery]), /immutable/);
  await assert.rejects(insertDelivery(), /unique constraint/);
  await client.query('SET ROLE anon');
  await assert.rejects(client.query('SELECT * FROM campaign_survey_delivery'), /permission denied/);
  await assert.rejects(client.query('SELECT * FROM survey_invitation_delivery'), /permission denied/);
  await assert.rejects(campaignClaim(testHash), /permission denied/);
  await client.query('RESET ROLE');
  for (const change of [
    ["UPDATE booking SET event_id=$1 WHERE id=$2", [id(), campaignBooking], "UPDATE booking SET event_id=$1 WHERE id=$2", [event, campaignBooking]],
    ["UPDATE booking SET status='cancelled' WHERE id=$1", [campaignBooking], "UPDATE booking SET status='confirmed' WHERE id=$1", [campaignBooking]],
  ]) {
    await client.query(change[0], change[1]);
    await assert.rejects(campaignClaim(testHash), /booking/);
    await client.query(change[2], change[3]);
  }
  await client.query('SET ROLE service_role');
  assert.equal((await campaignClaim(testHash)).rowCount, 1);
  await assert.rejects(campaignClaim(liveHash), /invitation unavailable/);
  await client.query('RESET ROLE');

  // Exercise real nested insertion for both delivery ledgers, both event
  // sources and both privacy modes. Each attempt has its own booking/grant.
  const fixture = async (kind, anonymous, complex = false) => {
    const eventId = id(); const assignmentId = id(); const bookingId = id();
    const recipient = `${id()}@example.org`;
    const source = complex ? 'complex' : 'standard';
    const eventType = complex ? 'complex_event' : 'event';
    await client.query(`INSERT INTO ${complex ? 'complex_event' : 'event'}(id) VALUES($1)`, [eventId]);
    await client.query(`INSERT INTO event_survey_assignment
      (id,tenant_id,form_id,event_type,event_id,complex_event_id,status)
      VALUES($1,$2,$3,$4,$5,$6,'active')`,
    [assignmentId, tenant, form, eventType, complex ? null : eventId, complex ? eventId : null]);
    await client.query(`INSERT INTO ${complex ? 'complex_event_booking' : 'booking'}
      (id,tenant_id,event_id,status,attendee_email) VALUES($1,$2,$3,'confirmed',$4)`,
    [bookingId, tenant, eventId, recipient]);
    const grantId = (await client.query(`INSERT INTO certificate_survey_entitlement
      (tenant_id,booking_source,booking_id,assignment_id,recipient_email,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 day') RETURNING id`,
    [tenant, source, bookingId, assignmentId, recipient])).rows[0].id;
    const hash = id().replaceAll('-', '').padEnd(64, 'a');
    let deliveryId;
    if (kind === 'certificate') {
      deliveryId = id();
      await client.query(`INSERT INTO attendee_cpd_certificate_delivery
        (id,tenant_id,booking_source,booking_id,status)
        VALUES($1,$2,$3,$4,'pending')`, [deliveryId, tenant, source, bookingId]);
      await client.query(`INSERT INTO certificate_survey_credential
        (entitlement_id,delivery_id,token_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '1 day')`, [grantId, deliveryId, hash]);
      await client.query("UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1", [deliveryId]);
    } else {
      const campaignId = id(); const campaignRecipientId = id();
      await client.query('INSERT INTO email_campaign(id,tenant_id) VALUES($1,$2)', [campaignId, tenant]);
      await client.query(`INSERT INTO email_campaign_recipient(id,campaign_id,email,status)
        VALUES($1,$2,$3,'processing')`, [campaignRecipientId, campaignId, recipient]);
      deliveryId = (await client.query(`INSERT INTO campaign_survey_delivery
        (tenant_id,campaign_id,campaign_recipient_id,purpose,booking_source,booking_id,
         event_type,event_id,source_email,destination_email)
        VALUES($1,$2,$3,'live',$4,$5,$6,$7,$8,$8) RETURNING id`,
      [tenant, campaignId, campaignRecipientId, source, bookingId, eventType, eventId, recipient])).rows[0].id;
      await client.query(`INSERT INTO certificate_survey_credential
        (entitlement_id,campaign_delivery_id,token_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '1 day')`, [grantId, deliveryId, hash]);
      await client.query("UPDATE campaign_survey_delivery SET status='accepted',resolved_at=now() WHERE id=$1", [deliveryId]);
    }
    const submission = {
      tenant_id: tenant, form_id: form, survey_version_id: version,
      survey_assignment_id: assignmentId,
      ...(complex ? { complex_event_id: eventId } : { event_id: eventId }),
      is_anonymous: anonymous,
      ...(!anonymous ? { submitted_by_email: recipient } : {}),
    };
    const answer = { tenant_id: tenant, form_id: form, survey_version_id: version,
      field_id: 'rating', raw_score: 3 };
    const submit = (answers = [answer], override = submission) =>
      client.query('SELECT * FROM create_certificate_survey_submission($1,$2,$3)',
        [override, JSON.stringify(answers), hash]);
    const counts = async () => {
      const response = await client.query(`SELECT e.response_id, e.completed_at,
        (SELECT count(*)::int FROM form_submission WHERE survey_assignment_id=$1) AS submissions,
        (SELECT count(*)::int FROM survey_answer a JOIN form_submission s ON s.id=a.submission_id
          WHERE s.survey_assignment_id=$1) AS answers
        FROM certificate_survey_entitlement e WHERE e.id=$2`, [assignmentId, grantId]);
      return response.rows[0];
    };
    return { submit, counts, grantId, hash, answer, submission };
  };
  for (const kind of ['certificate', 'campaign']) {
    for (const anonymous of [false, true]) {
      for (const complex of [false, true]) {
        const { submit, counts } = await fixture(kind, anonymous, complex);
        const response = await submit();
        assert.equal(response.rowCount, 1, `${kind} anonymous=${anonymous} complex=${complex}`);
        assert.equal(response.rows[0].is_anonymous, anonymous);
        assert.equal(response.rows[0].submitted_by_email === null, anonymous);
        const state = await counts();
        assert.equal(state.response_id, response.rows[0].id);
        assert.ok(state.completed_at);
        assert.equal(state.submissions, 1);
        assert.equal(state.answers, 1);
        await assert.rejects(submit(), /invitation unavailable/);
        assert.equal((await counts()).submissions, 1);
      }
    }
    for (const state of ['expired credential', 'revoked credential', 'expired entitlement', 'revoked entitlement']) {
      const item = await fixture(kind, false);
      if (state === 'expired credential' || state === 'revoked credential') {
        await client.query(`UPDATE certificate_survey_credential
          SET ${state.startsWith('expired') ? 'expires_at' : 'revoked_at'}=now()-interval '1 minute'
          WHERE token_hash=$1`, [item.hash]);
      } else {
        await client.query(`UPDATE certificate_survey_entitlement
          SET ${state.startsWith('expired') ? 'expires_at' : 'revoked_at'}=now()-interval '1 minute'
          WHERE id=$1`, [item.grantId]);
      }
      await assert.rejects(item.submit(), /invitation unavailable/, `${kind}: ${state}`);
      assert.equal((await item.counts()).submissions, 0);
      assert.equal((await item.counts()).answers, 0);
      assert.equal((await item.counts()).completed_at, null);
    }
    // A nested answer failure must undo the already-inserted response as well
    // as leave the entitlement claimable for a valid retry.
    const rollback = await fixture(kind, true);
    await assert.rejects(rollback.submit([{ ...rollback.answer, tenant_id: id() }]), /survey_answer linkage mismatch/);
    assert.equal((await rollback.counts()).submissions, 0);
    assert.equal((await rollback.counts()).answers, 0);
    assert.equal((await rollback.counts()).completed_at, null);
    await assert.rejects(rollback.submit([{ ...rollback.answer, injected: true }]), /Disallowed survey_answer column/);
    assert.equal((await rollback.counts()).submissions, 0);
    await assert.rejects(rollback.submit([rollback.answer, rollback.answer]), /unique constraint/);
    assert.equal((await rollback.counts()).submissions, 0);
    assert.equal((await rollback.counts()).answers, 0);
    await assert.rejects(rollback.submit([], {
      ...rollback.submission, communication_finalization_state: { status: 'pending' },
    }), /Disallowed form_submission column: communication_finalization_state/);
    assert.equal((await rollback.counts()).submissions, 0);
    assert.equal((await rollback.counts()).completed_at, null);
    assert.equal((await rollback.submit()).rowCount, 1);
    assert.equal((await rollback.counts()).answers, 1);

    const race = await fixture(kind, false);
    const peer = new pg.Client({ connectionString: url });
    await peer.connect();
    try {
      const results = await Promise.allSettled([
        race.submit(), peer.query('SELECT * FROM create_certificate_survey_submission($1,$2,$3)',
          [race.submission, JSON.stringify([race.answer]), race.hash]),
      ]);
      assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
      assert.match(results.find(result => result.status === 'rejected').reason.message, /invitation unavailable/);
      const winner = results.find(result => result.status === 'fulfilled').value.rows[0];
      assert.equal((await race.counts()).response_id, winner.id);
      assert.equal((await race.counts()).submissions, 1);
      assert.equal((await race.counts()).answers, 1);
    } finally {
      await peer.end();
    }
  }
  console.log('Disposable SQL real nested survey RPC: certificate/campaign, privacy, complex, expiry, revocation, rollback and concurrency checks passed');
} finally {
  await client.end();
}
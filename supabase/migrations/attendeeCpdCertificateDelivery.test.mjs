import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('delivery audit migration: real PostgreSQL atomic claims, concurrency, replay fences, tenant boundaries and RLS', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('attendee-cpd-delivery-');
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  let started = false;
  const clients = [];
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', `${h.root}/postgres.log`, '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const c = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await c.connect(); clients.push(c);
    }
    const [db, a, b] = clients;
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),'service_role') $$;
      CREATE TABLE public.tenant(id uuid PRIMARY KEY);
      CREATE TABLE public.booking(id uuid PRIMARY KEY,tenant_id uuid,status text);
      CREATE TABLE public.complex_event_booking(id uuid PRIMARY KEY,tenant_id uuid,status text);
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    `);
    const tenant = randomUUID(), other = randomUUID(), booking = randomUUID(), complex = randomUUID(), cancelled = randomUUID();
    await db.query('INSERT INTO tenant VALUES ($1),($2)', [tenant, other]);
    await db.query("INSERT INTO booking VALUES ($1,$2,'confirmed'),($3,$2,'cancelled')", [booking, tenant, cancelled]);
    await db.query("INSERT INTO complex_event_booking VALUES ($1,$2,'confirmed')", [complex, tenant]);
    const sql = readFileSync(new URL('./20261120_attendee_cpd_certificate_delivery.sql', import.meta.url), 'utf8');
    await db.query(sql); await db.query(sql);
    const renderedEmailSql = readFileSync(new URL('./20261122_attendee_cpd_rendered_email.sql', import.meta.url), 'utf8');
    await db.query(renderedEmailSql); await db.query(renderedEmailSql);
    const purposeSql = readFileSync(new URL('./20261124_certificate_test_delivery_purpose.sql', import.meta.url), 'utf8');
    await db.query(purposeSql); await db.query(purposeSql);
    const privilege = await db.query(`SELECT
      has_table_privilege('anon','attendee_cpd_certificate_delivery','SELECT') AS anon,
      has_table_privilege('authenticated','attendee_cpd_certificate_delivery','SELECT') AS member,
      has_table_privilege('service_role','attendee_cpd_certificate_delivery','INSERT,DELETE') AS insert_delete,
      has_column_privilege('service_role','attendee_cpd_certificate_delivery','provenance','UPDATE') AS provenance_update,
      has_column_privilege('service_role','attendee_cpd_certificate_delivery','status','UPDATE') AS status_update`);
    assert.deepEqual(privilege.rows[0], { anon: false, member: false, insert_delete: false, provenance_update: false, status_update: true });
    const fingerprint = 'a'.repeat(64);
    const claim = async (client, requestId, overrides = {}) => {
      const p = { tenant, source: 'standard', booking, fingerprint, resend: false, purpose: 'attendee',
        recipient: 'attendee@example.test', ...overrides };
      const { rows } = await client.query(`SELECT public.claim_attendee_cpd_certificate_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result`,
        [p.tenant, p.source, p.booking, requestId, p.fingerprint, 'member:admin', p.recipient, { template_id: 'template', values: { name: 'Real' } }, p.resend, p.purpose]);
      return rows[0].result;
    };
    const request = randomUUID();
    const parallel = await Promise.all([claim(a, request), claim(b, request)]);
    assert.equal(parallel.filter(result => result.claimed).length, 1);
    assert.equal(parallel.filter(result => result.reason === 'retry').length, 1);
    const first = parallel.find(result => result.claimed).delivery;
    assert.equal((await claim(db, randomUUID(), { resend: true })).reason, 'unresolved');
    assert.equal((await claim(db, request, { fingerprint: 'b'.repeat(64) })).reason, 'request_conflict');
    // Execute the actual finalization shape under the runtime role, not the
    // migration-owner superuser: RLS bypass does not bypass column ACLs.
    await a.query('SET ROLE service_role');
    const renderedEmail = { subject: 'Final subject', html: '<p>Final body with recipient footer</p>',
      text: null, from: 'sender@example.test', domain: 'example.test' };
    const finalized = await a.query(`UPDATE attendee_cpd_certificate_delivery
      SET status='accepted',provider_message_id='provider-accepted',error=NULL,updated_at=now(),rendered_email=$1
      WHERE tenant_id=$2 AND id=$3 AND status='pending'
      RETURNING status,provider_message_id,rendered_email,provenance,fingerprint`, [renderedEmail, tenant, first.id]);
    assert.equal(finalized.rowCount, 1);
    assert.equal(finalized.rows[0].status, 'accepted');
    assert.equal(finalized.rows[0].provider_message_id, 'provider-accepted');
    assert.deepEqual(finalized.rows[0].rendered_email, renderedEmail);
    assert.deepEqual(finalized.rows[0].provenance, first.provenance);
    assert.equal(finalized.rows[0].fingerprint, first.fingerprint);
    await assert.rejects(a.query("UPDATE attendee_cpd_certificate_delivery SET provenance='{}' WHERE id=$1", [first.id]), /permission denied/);
    await assert.rejects(a.query("UPDATE attendee_cpd_certificate_delivery SET fingerprint=$1 WHERE id=$2", ['b'.repeat(64), first.id]), /permission denied/);
    await a.query('RESET ROLE');
    const finalGrants = await db.query(`SELECT
      has_column_privilege('service_role','attendee_cpd_certificate_delivery','rendered_email','UPDATE') AS final_update,
      has_column_privilege('anon','attendee_cpd_certificate_delivery','rendered_email','UPDATE') AS anon_update,
      has_column_privilege('authenticated','attendee_cpd_certificate_delivery','rendered_email','UPDATE') AS member_update,
      has_column_privilege('service_role','attendee_cpd_certificate_delivery','provenance','UPDATE') AS initial_update`);
    assert.deepEqual(finalGrants.rows[0], { final_update: true, anon_update: false, member_update: false, initial_update: false });
    assert.equal((await claim(db, request)).reason, 'retry');
    assert.equal((await claim(db, randomUUID())).reason, 'resend_required');
    const resends = await Promise.all([claim(a, randomUUID(), { resend: true }), claim(b, randomUUID(), { resend: true })]);
    assert.equal(resends.filter(result => result.claimed).length, 1);
    assert.equal(resends.filter(result => result.reason === 'unresolved').length, 1);
    const resend = resends.find(result => result.claimed).delivery;
    await db.query("UPDATE attendee_cpd_certificate_delivery SET status='unknown' WHERE id=$1", [resend.id]);
    assert.equal((await claim(db, randomUUID(), { resend: true })).reason, 'unresolved');
    // Changing content does not defeat an unresolved provider fence.
    assert.equal((await claim(db, randomUUID(), { resend: true, fingerprint: 'c'.repeat(64) })).reason, 'unresolved');
    // Real attendee unknown delivery does not fence test mail; test unknown
    // fences only test purpose, even when changing recipient/fingerprint.
    const testRequest = randomUUID();
    const testOptions = { purpose: 'test', recipient: 'reviewer@example.test' };
    const tests = await Promise.all([claim(a, testRequest, testOptions), claim(b, testRequest, testOptions)]);
    assert.equal(tests.filter(row => row.claimed).length, 1);
    assert.equal(tests.filter(row => row.reason === 'retry').length, 1);
    const testDelivery = tests.find(row => row.claimed).delivery;
    assert.equal(testDelivery.purpose, 'test');
    assert.equal((await claim(db, testRequest)).reason, 'request_conflict');
    assert.equal((await claim(db, testRequest, { ...testOptions, recipient: 'different@example.test' })).reason, 'request_conflict');
    await db.query("UPDATE attendee_cpd_certificate_delivery SET status='unknown' WHERE id=$1", [testDelivery.id]);
    assert.equal((await claim(db, randomUUID(), testOptions)).reason, 'unresolved');
    await db.query("UPDATE attendee_cpd_certificate_delivery SET status='failed' WHERE id=$1", [resend.id]);
    const unaffectedLive = await claim(db, randomUUID(), { resend: true });
    assert.equal(unaffectedLive.claimed, true);
    await db.query("UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1", [testDelivery.id]);
    const nextTest = await claim(db, randomUUID(), testOptions);
    assert.equal(nextTest.claimed, true, 'accepted tests do not require deliberate attendee resend');
    await a.query('SET ROLE service_role');
    await assert.rejects(a.query("UPDATE attendee_cpd_certificate_delivery SET purpose='attendee' WHERE id=$1", [testDelivery.id]), /permission denied/);
    await a.query('RESET ROLE');
    await assert.rejects(claim(db, randomUUID(), { tenant: other }), /tenant booking/);
    await assert.rejects(claim(db, randomUUID(), { booking: cancelled }), /tenant booking/);
    const complexClaim = await claim(db, randomUUID(), { source: 'complex', booking: complex });
    assert.equal(complexClaim.claimed, true);
    await db.query("UPDATE attendee_cpd_certificate_delivery SET status='failed' WHERE id=$1", [complexClaim.delivery.id]);
    assert.equal((await claim(db, randomUUID(), { source: 'complex', booking: complex })).claimed, true);
    // During rolling deployment the old route sends exactly nine named RPC
    // arguments. PostgreSQL must resolve those without overload ambiguity and
    // default the omitted purpose to attendee.
    const legacyBooking = randomUUID();
    await db.query("INSERT INTO booking VALUES ($1,$2,'confirmed')", [legacyBooking, tenant]);
    const legacyRequest = randomUUID();
    const legacyArgs = [tenant, 'standard', legacyBooking, legacyRequest, fingerprint,
      'member:admin', 'attendee@example.test', { template_id: 'template' }, false];
    const legacySql = `SELECT public.claim_attendee_cpd_certificate_delivery(
      p_tenant_id => $1, p_booking_source => $2, p_booking_id => $3,
      p_request_id => $4, p_fingerprint => $5, p_actor => $6,
      p_recipient => $7, p_provenance => $8, p_deliberate_resend => $9
    ) AS result`;
    await a.query('SET ROLE service_role');
    const legacy = (await a.query(legacySql, legacyArgs)).rows[0].result;
    assert.equal(legacy.claimed, true);
    assert.equal(legacy.delivery.purpose, 'attendee');
    const legacyReplay = (await a.query(legacySql, legacyArgs)).rows[0].result;
    assert.equal(legacyReplay.reason, 'retry');
    assert.equal(legacyReplay.delivery.id, legacy.delivery.id);
    assert.equal(legacyReplay.delivery.purpose, 'attendee');
    await a.query('RESET ROLE');
    await db.query("SET request.jwt.claim.role='authenticated'");
    await assert.rejects(claim(db, randomUUID()), /service_role is required/);
    const count = await db.query('SELECT count(*)::int AS count FROM attendee_cpd_certificate_delivery');
    assert.equal(count.rows[0].count, 8);
  } finally {
    for (const client of clients) await client.end();
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
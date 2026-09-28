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
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
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
    const privilege = await db.query(`SELECT
      has_table_privilege('anon','attendee_cpd_certificate_delivery','SELECT') AS anon,
      has_table_privilege('authenticated','attendee_cpd_certificate_delivery','SELECT') AS member,
      has_table_privilege('service_role','attendee_cpd_certificate_delivery','INSERT,DELETE') AS insert_delete,
      has_column_privilege('service_role','attendee_cpd_certificate_delivery','provenance','UPDATE') AS provenance_update,
      has_column_privilege('service_role','attendee_cpd_certificate_delivery','status','UPDATE') AS status_update`);
    assert.deepEqual(privilege.rows[0], { anon: false, member: false, insert_delete: false, provenance_update: false, status_update: true });
    const fingerprint = 'a'.repeat(64);
    const claim = async (client, requestId, overrides = {}) => {
      const p = { tenant, source: 'standard', booking, fingerprint, resend: false, ...overrides };
      const { rows } = await client.query(`SELECT public.claim_attendee_cpd_certificate_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result`,
        [p.tenant, p.source, p.booking, requestId, p.fingerprint, 'member:admin', 'attendee@example.test', { template_id: 'template', values: { name: 'Real' } }, p.resend]);
      return rows[0].result;
    };
    const request = randomUUID();
    const parallel = await Promise.all([claim(a, request), claim(b, request)]);
    assert.equal(parallel.filter(result => result.claimed).length, 1);
    assert.equal(parallel.filter(result => result.reason === 'retry').length, 1);
    const first = parallel.find(result => result.claimed).delivery;
    assert.equal((await claim(db, randomUUID(), { resend: true })).reason, 'unresolved');
    assert.equal((await claim(db, request, { fingerprint: 'b'.repeat(64) })).reason, 'request_conflict');
    await db.query("UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1", [first.id]);
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
    await assert.rejects(claim(db, randomUUID(), { tenant: other }), /tenant booking/);
    await assert.rejects(claim(db, randomUUID(), { booking: cancelled }), /tenant booking/);
    const complexClaim = await claim(db, randomUUID(), { source: 'complex', booking: complex });
    assert.equal(complexClaim.claimed, true);
    await db.query("UPDATE attendee_cpd_certificate_delivery SET status='failed' WHERE id=$1", [complexClaim.delivery.id]);
    assert.equal((await claim(db, randomUUID(), { source: 'complex', booking: complex })).claimed, true);
    await db.query("SET request.jwt.claim.role='authenticated'");
    await assert.rejects(claim(db, randomUUID()), /service_role is required/);
    const count = await db.query('SELECT count(*)::int AS count FROM attendee_cpd_certificate_delivery');
    assert.equal(count.rows[0].count, 4);
  } finally {
    for (const client of clients) await client.end();
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
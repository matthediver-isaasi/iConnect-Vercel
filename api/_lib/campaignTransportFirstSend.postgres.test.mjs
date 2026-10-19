import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('first-send transport migration guards selection, history, conflicts, rollback and grants', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('campaign-transport-first-send-');
  const cmd = (name, args) => {
    const r = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  let db, competitor, started = false;
  try {
    cmd('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    cmd('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE email_campaign(id uuid PRIMARY KEY, tenant_id uuid,
        status text, updated_at timestamptz DEFAULT now(), scheduled_at timestamptz,
        category_review_required boolean DEFAULT false, preparation_generation uuid,
        preparation_actor_member_id uuid, sent_count integer, total_recipients integer, sent_at timestamptz);
      CREATE TABLE email_campaign_recipient(campaign_id uuid, status text);
      CREATE TABLE campaign_preparation(id uuid PRIMARY KEY, campaign_id uuid,
        tenant_id uuid, campaign_version timestamptz, snapshot jsonb);
    `);
    await db.query(readFileSync('migrations/20261012_campaign_delivery_transport.sql', 'utf8'));
    // Historical campaigns exist before this additive migration.
    for (const [n, status] of [[1, 'draft'], [2, 'scheduled'], [3, 'preparing'], [4, 'sending'],
      [5, 'sent'], [6, 'draft'], [7, 'paused'], [8, 'draft'], [9, 'draft'], [10, 'draft'], [11, 'draft']]) {
      await db.query('INSERT INTO email_campaign(id,tenant_id,status) VALUES($1,$2,$3)', [id(n), id(100), status]);
    }
    await db.query(readFileSync('migrations/20261017_campaign_transport_first_send.sql', 'utf8'));
    assert.equal((await db.query('SELECT count(*) FROM email_campaign WHERE delivery_transport_pinned_at IS NOT NULL')).rows[0].count, '0');
    // Preserve PostgreSQL microseconds in the optimistic concurrency token.
    const load = async n => (await db.query('SELECT *, updated_at::text AS updated_at FROM email_campaign WHERE id=$1', [id(n)])).rows[0];
    const claim = async (n, transport = 'mailgun_batch_v1', overrides = {}) => {
      const c = await load(n);
      return db.query(`SELECT campaign_preparation_begin($1::uuid,$2::uuid,$3::timestamptz,
        $4::text,$5::timestamptz,$6::uuid,$7::uuid,$8::text) AS campaign`,
      [c.id, overrides.tenant || c.tenant_id, overrides.version || c.updated_at,
        c.status, c.scheduled_at, overrides.generation || id(n + 1000), null, transport]);
    };
    for (const n of [1, 2]) {
      const c = (await claim(n)).rows[0].campaign;
      assert.equal(c.status, 'preparing');
      assert.equal(c.delivery_transport, 'mailgun_batch_v1');
      assert.ok(c.delivery_transport_pinned_at);
      const snapshot = (await db.query('SELECT snapshot FROM campaign_preparation WHERE campaign_id=$1', [id(n)])).rows[0].snapshot;
      assert.equal(snapshot.delivery_transport, c.delivery_transport);
      await assert.rejects(claim(n), /preparation conflict/i);
      await assert.rejects(db.query("UPDATE email_campaign SET delivery_transport='individual' WHERE id=$1", [id(n)]), /fixed after first preparation/);
      await assert.rejects(db.query('UPDATE email_campaign SET delivery_transport_pinned_at=NULL WHERE id=$1', [id(n)]), /fixed after first preparation/);
    }
    for (const n of [3, 4, 5, 7]) {
      await assert.rejects(claim(n), /preparation conflict/i);
      await assert.rejects(db.query("UPDATE email_campaign SET delivery_transport='mailgun_batch_v1' WHERE id=$1", [id(n)]), /fixed after first preparation/);
    }
    for (const status of ['pending', 'processing', 'sent', 'failed']) {
      await db.query('INSERT INTO email_campaign_recipient VALUES($1,$2)', [id(6), status]);
      await assert.rejects(claim(6), /reconciliation/);
    }
    await assert.rejects(claim(8, 'mailgun_batch_v1', { tenant: id(999) }), /preparation conflict/);
    await assert.rejects(claim(8, 'mailgun_batch_v1', { version: '2000-01-01' }), /preparation conflict/);
    await assert.rejects(claim(8, 'invalid'), /Invalid campaign delivery transport/);
    // A snapshot insertion failure must roll back both transport and status.
    await assert.rejects(claim(8, 'mailgun_batch_v1', { generation: id(1001) }), /duplicate key/);
    assert.equal((await load(8)).status, 'draft');
    assert.equal((await load(8)).delivery_transport, 'individual');
    assert.equal((await load(8)).delivery_transport_pinned_at, null);
    assert.equal((await claim(8, 'individual')).rows[0].campaign.delivery_transport, 'individual');
    // A previously prepared draft cannot reselect, even with no recipients.
    await db.query('UPDATE email_campaign SET preparation_generation=$1 WHERE id=$2', [id(888), id(9)]);
    await assert.rejects(claim(9), /reconciliation/);
    await assert.rejects(db.query("UPDATE email_campaign SET delivery_transport='mailgun_batch_v1' WHERE id=$1", [id(10)]), /fixed after first preparation/);
    // Older seven-argument workers only set status; the trigger pins the
    // existing transport without requiring the new RPC parameter.
    await db.query("UPDATE email_campaign SET status='preparing' WHERE id=$1", [id(10)]);
    assert.ok((await load(10)).delivery_transport_pinned_at);
    assert.equal((await load(10)).delivery_transport, 'individual');
    // Real concurrent connections cannot claim different transports.
    competitor = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await competitor.connect();
    const c = await load(11);
    const sql = `SELECT campaign_preparation_begin($1::uuid,$2::uuid,$3::timestamptz,
      $4::text,$5::timestamptz,$6::uuid,$7::uuid,$8::text)`;
    const args = [c.id, c.tenant_id, c.updated_at, c.status, c.scheduled_at, id(1011), null];
    const race = await Promise.allSettled([
      db.query(sql, [...args, 'mailgun_batch_v1']),
      competitor.query(sql, [...args, 'individual']),
    ]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(race.find(r => r.status === 'rejected').reason.message, /preparation conflict/);
    assert.equal((await db.query('SELECT count(*) FROM campaign_preparation WHERE campaign_id=$1', [c.id])).rows[0].count, '1');
    const signature = 'public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid,text)';
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, signature])).rows[0].allowed, false);
    }
    assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', ['service_role', signature])).rows[0].allowed, true);
  } finally {
    if (competitor) await competitor.end();
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});

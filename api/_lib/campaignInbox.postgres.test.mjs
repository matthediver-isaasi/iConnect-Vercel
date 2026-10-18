import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const migration = readFileSync('supabase/migrations/20261018_campaign_inbox_delivery_mode.sql', 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('campaign inbox migration, immutable history, scoped unread aggregation and grants', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('campaign-inbox-');
  const cmd = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let db, started = false;
  try {
    cmd('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    cmd('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE email_campaign(id uuid PRIMARY KEY, tenant_id uuid, subject text, is_test_mode boolean);
      CREATE TABLE email_campaign_recipient(
        id uuid PRIMARY KEY, campaign_id uuid REFERENCES email_campaign(id), member_id uuid,
        status text, sent_at timestamptz, mailgun_message_id text
      );
      CREATE TABLE member_inbox_message_state(
        recipient_id uuid, member_id uuid, tenant_id uuid,
        is_read boolean DEFAULT false, is_archived boolean DEFAULT false,
        UNIQUE(member_id, recipient_id)
      );
      GRANT SELECT, UPDATE ON email_campaign_recipient TO service_role;
      GRANT SELECT ON email_campaign, member_inbox_message_state TO service_role;
    `);
    for (const [n, tenant, mode] of [[1, 10, true], [2, 10, false], [3, 10, null], [4, 20, false]]) {
      await db.query('INSERT INTO email_campaign VALUES ($1,$2,$3,$4)', [id(n), id(tenant), `subject-${n}`, mode]);
    }
    // Tests have existing archive/read state; legacy NULL is a genuine send.
    for (const [n, campaign, member, status, sent] of [
      [101, 1, 30, 'sent', '2026-10-18'], [102, 1, 30, 'sent', '2026-10-18'],
      [103, 2, 30, 'sent', '2026-10-16'], [104, 2, 30, 'sent', '2026-10-15'],
      [105, 3, 30, 'sent', '2026-10-17'], [106, 2, 30, 'pending', null],
      [107, 4, 30, 'sent', '2026-10-18'], [108, 2, 40, 'sent', '2026-10-18'],
      [109, 1, 30, 'processing', null],
    ]) {
      await db.query('INSERT INTO email_campaign_recipient VALUES ($1,$2,$3,$4,$5,$6)',
        [id(n), id(campaign), id(member), status, sent, sent ? `provider-${n}` : null]);
    }
    for (const [recipient, member, tenant, read, archived] of [
      [101, 30, 10, true, false], [102, 30, 10, false, true], // hidden
      [104, 30, 10, true, false], [106, 30, 10, true, true], // unsent
      [999, 30, 10, true, false], // orphan
      [103, 30, 20, true, true], // wrong-tenant state may not suppress
    ]) {
      await db.query('INSERT INTO member_inbox_message_state VALUES ($1,$2,$3,$4,$5)',
        [id(recipient), id(member), id(tenant), read, archived]);
    }
    await db.query(migration);
    const mode = async n => (await db.query('SELECT delivery_is_test FROM email_campaign_recipient WHERE id=$1', [id(n)])).rows[0].delivery_is_test;
    assert.equal(await mode(101), true);
    assert.equal(await mode(103), false);
    assert.equal(await mode(105), false);
    assert.equal(await mode(106), null);
    assert.equal(await mode(109), true);
    const summary = async (tenant = 10, member = 30) =>
      (await db.query('SELECT * FROM campaign_inbox_unread_summary($1,$2)', [id(tenant), id(member)])).rows[0];
    let result = await summary();
    assert.equal(result.unread_count, '2');
    assert.equal(result.latest_recipient_id, id(105));
    assert.equal(result.latest_subject, 'subject-3');
    assert.equal((await summary(20)).unread_count, '1');
    assert.equal((await summary(10, 40)).unread_count, '1');
    assert.equal((await summary(90)).unread_count, '0');
    assert.equal((await summary(90)).latest_recipient_id, null);

    // Later settings + migration replay cannot invert existing classifications.
    await db.query('UPDATE email_campaign SET is_test_mode = NOT coalesce(is_test_mode, false)');
    await db.query(migration);
    assert.equal(await mode(101), true);
    assert.equal(await mode(103), false);
    assert.equal(await mode(105), false);
    assert.equal((await summary()).unread_count, '2');
    await assert.rejects(db.query('UPDATE email_campaign_recipient SET delivery_is_test=false WHERE id=$1', [id(101)]), /immutable/);
    await assert.rejects(db.query('UPDATE email_campaign_recipient SET delivery_is_test=NULL WHERE id=$1', [id(103)]), /immutable/);

    // Accepted-event reconciliation updates timestamps/status only.
    await db.query("UPDATE email_campaign_recipient SET status='sent',sent_at=now(),mailgun_message_id='reconciled' WHERE id=$1", [id(109)]);
    assert.equal(await mode(109), true);
    assert.equal((await summary()).unread_count, '2');
    // A newer old-worker delivery without evidence stays hidden until backfill.
    await db.query("UPDATE email_campaign_recipient SET sent_at=now() WHERE id=$1", [id(106)]);
    assert.equal((await summary()).unread_count, '2');

    // Exact aggregate over the REST cap, with same-timestamp deterministic latest.
    await db.query(`INSERT INTO email_campaign_recipient(id,campaign_id,member_id,status,sent_at,delivery_is_test)
      SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,$1,$2,'sent','2026-10-18',false
      FROM generate_series(1000,2204) n`, [id(2), id(30)]);
    await db.query('SET ROLE service_role');
    result = await summary();
    assert.equal(result.unread_count, '1207');
    assert.equal(result.latest_recipient_id, id(1000));
    assert.equal((await db.query('SELECT * FROM campaign_inbox_recipient')).rowCount, 1210);
    await db.query('RESET ROLE');
    // No state/history or provider identifiers were removed.
    assert.equal((await db.query('SELECT * FROM member_inbox_message_state')).rowCount, 6);
    assert.equal((await db.query('SELECT mailgun_message_id FROM email_campaign_recipient WHERE id=$1', [id(101)])).rows[0].mailgun_message_id, 'provider-101');
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM campaign_inbox_recipient'), /permission denied/);
      await assert.rejects(summary(), /permission denied/);
      await db.query('RESET ROLE');
    }
  } finally {
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});

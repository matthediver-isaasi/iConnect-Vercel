import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const obsolete = ['completed_at', 'cancelled_at', 'cancelled_by', 'paused_at', 'paused_by', 'pause_reason'];
const migration = name => readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8');

test('preparation lifecycle reset is forward-only, atomic, fenced and service-only for both overloads', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('campaign-preparation-lifecycle-');
  const cmd = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let db, competitor, started = false;
  try {
    cmd('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    cmd('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    const config = { host: h.socket, port: h.port, user: 'postgres', database: 'postgres' };
    db = new pg.Client(config);
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE email_campaign(id uuid PRIMARY KEY, tenant_id uuid, status text,
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), scheduled_at timestamptz,
        category_review_required boolean DEFAULT false, sent_count integer, total_recipients integer,
        sent_at timestamptz, completed_at timestamptz, cancelled_at timestamptz, cancelled_by uuid,
        paused_at timestamptz, paused_by uuid, pause_reason text);
      CREATE TABLE email_campaign_recipient(id uuid PRIMARY KEY, campaign_id uuid, status text, sent_at timestamptz);
      CREATE TABLE member(id uuid, tenant_id uuid, email text, first_name text, last_name text,
        communications_opted_out_all boolean, login_enabled boolean, organization_id uuid);
      CREATE TABLE email_unsubscribe(tenant_id uuid, email text);
      CREATE TABLE complex_event_session_checkin(tenant_id uuid, booking_id uuid, checked_in_at timestamptz);
    `);
    // Use actual RPC definitions, preparation tables, and transport guards.
    await db.query(migration('20261001_campaign_preparation'));
    await db.query(migration('20261012_campaign_delivery_transport'));
    await db.query(migration('20261017_campaign_transport_first_send'));
    for (const [n, status] of [[1, 'draft'], [2, 'scheduled'], [3, 'sent'], [4, 'sending'],
      [5, 'paused'], [6, 'cancelled'], [7, 'failed'], [8, 'preparing'], [9, 'draft'],
      [10, 'draft'], [11, 'draft']]) {
      await db.query(`INSERT INTO email_campaign(id,tenant_id,status,scheduled_at,
        completed_at,cancelled_at,cancelled_by,paused_at,paused_by,pause_reason,sent_count,total_recipients)
        VALUES($1,$2,$3,CASE WHEN $3='scheduled' THEN '2030-01-01'::timestamptz END,
          '2000-01-01','2000-01-02',$4,'2000-01-03',$4,'obsolete reason',42,43)`,
      [id(n), id(100), status, id(200)]);
    }
    await db.query("INSERT INTO email_campaign_recipient VALUES($1,$2,'sent','2000-01-01')", [id(300), id(3)]);
    await db.query(`INSERT INTO campaign_preparation(id,campaign_id,tenant_id,snapshot,phase)
      VALUES($1,$2,$3,'{"completed_at":"historical"}','complete')`, [id(400), id(3), id(100)]);
    const all = async () => (await db.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM email_campaign c) AS campaigns,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM email_campaign_recipient r) AS recipients,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM campaign_preparation p) AS preparations`)).rows[0];
    const before = await all();
    await db.query(migration('20261020_campaign_preparation_lifecycle_reset'));
    assert.deepEqual(await all(), before, 'migration must not rewrite any historical or draft rows');
    await db.query(migration('20261020_campaign_preparation_lifecycle_reset'));
    assert.deepEqual(await all(), before, 'reapplication must also be forward-only');
    const load = async n => (await db.query('SELECT to_jsonb(c) AS c FROM email_campaign c WHERE id=$1', [id(n)])).rows[0].c;
    const sql = arity => `SELECT campaign_preparation_begin(${[
      'uuid', 'uuid', 'timestamptz', 'text', 'timestamptz', 'uuid', 'uuid', 'text',
    ].slice(0, arity).map((type, i) => `$${i + 1}::${type}`).join(',')}) AS campaign`;
    const args = (c, arity, overrides = {}) => [
      overrides.campaign ?? c.id, overrides.tenant ?? c.tenant_id, overrides.version ?? c.updated_at,
      overrides.status ?? c.status, Object.hasOwn(overrides, 'scheduled') ? overrides.scheduled : c.scheduled_at,
      overrides.generation ?? id(Number(c.id.slice(-12)) + 1000), id(200),
      Object.hasOwn(overrides, 'transport') ? overrides.transport : 'mailgun_batch_v1',
    ].slice(0, arity);
    for (const arity of [7, 8]) {
      const c = await load(9);
      for (const override of [{ tenant: id(999) }, { campaign: id(999) }, { version: '2000-01-01' },
        { status: 'scheduled' }, { scheduled: '2030-01-01' }]) {
        await assert.rejects(db.query(sql(arity), args(c, arity, override)), /preparation conflict/);
        assert.deepEqual(await load(9), c);
      }
      await db.query('UPDATE email_campaign SET category_review_required=true WHERE id=$1', [c.id]);
      await assert.rejects(db.query(sql(arity), args(c, arity)), /preparation conflict/);
      await db.query('UPDATE email_campaign SET category_review_required=false WHERE id=$1', [c.id]);
      for (const status of ['pending', 'processing', 'sent', 'failed', 'cancelled']) {
        await db.query('INSERT INTO email_campaign_recipient(id,campaign_id,status) VALUES($1,$2,$3)', [id(301), c.id, status]);
        await assert.rejects(db.query(sql(arity), args(c, arity)), /reconciliation/);
        await db.query('DELETE FROM email_campaign_recipient WHERE id=$1', [id(301)]);
      }
      await db.query('UPDATE email_campaign SET preparation_generation=$1 WHERE id=$2', [id(401), c.id]);
      await assert.rejects(db.query(sql(arity), args(c, arity)), /reconciliation/);
      await db.query('UPDATE email_campaign SET preparation_generation=NULL WHERE id=$1', [c.id]);
      // A snapshot failure must roll back the reset, status, generation and transport pin.
      await assert.rejects(db.query(sql(arity), args(c, arity, { generation: id(400) })), /duplicate key/);
      assert.deepEqual(await load(9), c);
      for (const n of [3, 4, 5, 6, 7, 8]) {
        await assert.rejects(db.query(sql(arity), args(await load(n), arity)), /preparation conflict/);
      }
      const signature = `public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid${arity === 8 ? ',text' : ''})`;
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows[0].allowed, role === 'service_role');
        await db.query(`SET ROLE ${role}`);
        if (role !== 'service_role') await assert.rejects(db.query(sql(arity), args(c, arity)), /permission denied/);
        await db.query('RESET ROLE');
      }
      const candidate = await load(arity === 7 ? 1 : 2);
      await db.query('SET ROLE service_role');
      const claimed = (await db.query(sql(arity), args(candidate, arity))).rows[0].campaign;
      await db.query('RESET ROLE');
      for (const field of obsolete) assert.equal(claimed[field], null, `${arity}-arg ${field}`);
      assert.equal(claimed.status, 'preparing');
      assert.equal(claimed.sent_count, 0);
      assert.equal(claimed.total_recipients, 0);
      assert.equal(claimed.delivery_transport, arity === 7 ? 'individual' : 'mailgun_batch_v1');
      assert.ok(claimed.delivery_transport_pinned_at);
      const snapshot = (await db.query('SELECT snapshot FROM campaign_preparation WHERE id=$1', [claimed.preparation_generation])).rows[0].snapshot;
      assert.deepEqual(snapshot, claimed, 'snapshot is the atomically reset row');
      await assert.rejects(db.query(sql(arity), args(candidate, arity)), /preparation conflict/);
    }
    const c = await load(9);
    for (const transport of [null, 'invalid']) {
      await assert.rejects(db.query(sql(8), args(c, 8, { transport })), /Invalid campaign delivery transport/);
      assert.deepEqual(await load(9), c);
    }
    // The seven-argument overload's default actor remains callable by old clients.
    const legacy = await load(10);
    const defaultActorClaim = (await db.query(sql(6), args(legacy, 6))).rows[0].campaign;
    assert.equal(defaultActorClaim.preparation_actor_member_id, null);
    for (const field of obsolete) assert.equal(defaultActorClaim[field], null);
    // Exercise the pin guard independently of generation and recipient guards.
    await db.query("UPDATE email_campaign SET status='preparing' WHERE id=$1", [id(11)]);
    await db.query("UPDATE email_campaign SET status='draft' WHERE id=$1", [id(11)]);
    const pinned = await load(11);
    assert.ok(pinned.delivery_transport_pinned_at);
    assert.equal(pinned.preparation_generation, null);
    for (const arity of [7, 8]) {
      await assert.rejects(db.query(sql(arity), args(pinned, arity)), /reconciliation/);
      assert.deepEqual(await load(11), pinned);
    }
    // Real competing old/new workers share the same parent row lock.
    competitor = new pg.Client(config);
    await competitor.connect();
    const race = await Promise.allSettled([
      db.query(sql(7), args(c, 7)),
      competitor.query(sql(8), args(c, 8, { generation: id(9999) })),
    ]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(race.find(r => r.status === 'rejected').reason.message, /preparation conflict/);
    assert.equal((await db.query('SELECT count(*) FROM campaign_preparation WHERE campaign_id=$1', [c.id])).rows[0].count, '1');
    for (const field of obsolete) assert.equal((await load(9))[field], null);
    const after = await all();
    assert.deepEqual(after.campaigns.filter(c => Number(c.id.slice(-12)) >= 3 && Number(c.id.slice(-12)) <= 8),
      before.campaigns.filter(c => Number(c.id.slice(-12)) >= 3 && Number(c.id.slice(-12)) <= 8));
    assert.deepEqual(after.recipients, before.recipients);
    assert.deepEqual(after.preparations.find(p => p.id === id(400)), before.preparations[0]);
  } finally {
    if (competitor) await competitor.end();
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});

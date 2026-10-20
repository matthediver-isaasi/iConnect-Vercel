import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { amendmentFixture, uuid } from '../../scripts/test-support/member-amendment-fixtures.mjs';
import { buildMemberAmendmentQuote } from './memberAmendmentQuote.js';
import { memberAmendmentQuoteFingerprint } from './memberAmendments.js';

test('isolated PostgreSQL: additive repeatable migration, immutable tracked proposals, locks/retries, tenant isolation, stale snapshots, service-only access', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('member-amendments-');
  const clients = [];
  let started = false;
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const connection = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres',
        types: { getTypeParser: (oid, format) => oid === 1082 ? (value) => value : pg.types.getTypeParser(oid, format) } });
      await connection.connect();
      clients.push(connection);
    }
    const [admin, first, second] = clients;
    await admin.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant (id uuid PRIMARY KEY);
      CREATE TABLE member (id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE membership_tier_config (
        id uuid PRIMARY KEY, tenant_id uuid, name text, structure_scope_type text,
        start_mode text, billing_period text, currency text, is_active boolean,
        effective_from date, effective_to date, pricing_model text,
        flat_cost numeric, flat_vat_rate text, free_period_amount numeric, rollover_enabled boolean
      );
      CREATE TABLE membership_tier_band (
        id uuid PRIMARY KEY, tenant_id uuid, config_id uuid, annual_cost numeric, vat_rate text
      );
      CREATE TABLE membership_tier_discount (id uuid PRIMARY KEY, tenant_id uuid, config_id uuid);
      CREATE TABLE membership_tier_vat_override (id uuid PRIMARY KEY, tenant_id uuid, config_id uuid);
      CREATE TABLE system_settings (id uuid PRIMARY KEY, tenant_id uuid, setting_key text, setting_value text);
      CREATE TABLE member_membership_history (
        id uuid PRIMARY KEY, tenant_id uuid, member_id uuid, config_id uuid, band_id uuid,
        annual_cost numeric, final_cost numeric, vat_amount numeric, total_with_vat numeric, currency text,
        payment_method text, billing_period text, billing_agreement_id uuid, status text, payment_status text,
        term_start_date date, term_end_date date, membership_renewal_date date, term_duration_months integer,
        term_anchor_date date, term_key text, previous_term_id uuid, commitment_snapshot jsonb
      );
    `);
    const migration = readFileSync(new URL('../../supabase/migrations/202612310020_member_membership_amendments.sql', import.meta.url), 'utf8');
    await admin.query(migration);
    await admin.query(migration);
    await first.query('SET ROLE service_role');
    await second.query('SET ROLE service_role');
    const today = new Date().toISOString().slice(0, 10);
    const f = amendmentFixture(today);
    await admin.query('INSERT INTO tenant VALUES ($1),($2)', [f.tenantId, uuid(99)]);
    await admin.query('INSERT INTO member VALUES ($1,$2)', [f.memberId, f.tenantId]);
    const insert = async (table, row) => {
      const fields = Object.keys(row);
      return (await admin.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING to_jsonb(${table}) AS value`,
        Object.values(row))).rows[0].value;
    };
    f.config = await insert('membership_tier_config', f.config);
    await insert('membership_tier_config', f.current.commitment_snapshot.config);
    f.current = await insert('member_membership_history', f.current);
    const sourceBefore = JSON.stringify(f.current);
    const quote = () => buildMemberAmendmentQuote({ ...f, effectiveDate: today, quotedAt: new Date().toISOString() });
    const q = quote();
    f.request.expectedQuote = memberAmendmentQuoteFingerprint(q);
    const invoke = (connection, key, request = f.request, quoted = q, tenantId = f.tenantId) => connection.query(
      'SELECT propose_member_membership_amendment($1,$2,$3,$4,$5,$6) AS result',
      [tenantId, f.memberId, uuid(7), key, request, quoted],
    ).then((result) => result.rows[0].result);
    // Tenant injection cannot point at a member in another tenant.
    await assert.rejects(invoke(first, 'wrong-tenant', f.request, q, uuid(99)), /Member not found in tenant/);
    // No client-role RPC execution or history reads.
    await admin.query('SET ROLE authenticated');
    await assert.rejects(invoke(admin, 'client-denied'), /permission denied/);
    await assert.rejects(admin.query('SELECT * FROM member_membership_amendment'), /permission denied/);
    await admin.query('RESET ROLE');
    // Even service role cannot bypass the RPC using direct writes.
    await assert.rejects(first.query('DELETE FROM member_membership_amendment'), /permission denied/);
    // Snapshot drift aborts rather than persisting the price the user did not see.
    await admin.query('UPDATE membership_tier_config SET flat_cost = 201 WHERE id = $1', [f.config.id]);
    await assert.rejects(invoke(first, 'stale-config'), /Target structure changed/);
    await admin.query('UPDATE membership_tier_config SET flat_cost = 200 WHERE id = $1', [f.config.id]);
    await admin.query("UPDATE member_membership_history SET payment_status='unpaid' WHERE id=$1", [f.current.id]);
    await assert.rejects(invoke(first, 'stale-purchase'), /Original purchase changed/);
    await admin.query("UPDATE member_membership_history SET payment_status='paid' WHERE id=$1", [f.current.id]);
    await admin.query('INSERT INTO membership_tier_discount VALUES ($1,$2,$3)', [uuid(20), f.tenantId, f.config.id]);
    await assert.rejects(invoke(first, 'stale-discount'), /pricing policies changed/);
    await admin.query('DELETE FROM membership_tier_discount');
    await admin.query('INSERT INTO system_settings VALUES ($1,$2,$3,$4)', [uuid(21), f.tenantId, `xero_vat_rates_${f.tenantId}`, '{"rates":[]}']);
    await assert.rejects(invoke(first, 'stale-tax-cache'), /Saved tax rates changed/);
    await admin.query('DELETE FROM system_settings');
    // Confirm row locking: transaction one holds member lock after insertion.
    await first.query('BEGIN');
    const saved = await invoke(first, 'concurrent-key');
    let completed = false;
    const waiting = invoke(second, 'concurrent-key').then((result) => { completed = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(completed, false, 'second confirmation waits for first row lock');
    await first.query('COMMIT');
    const replay = await waiting;
    assert.equal(saved.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(saved.amendment.id, replay.amendment.id);
    assert.equal(saved.amendment.status, 'pending_settlement');
    assert.equal(saved.amendment.entitlement_applied, false);
    assert.equal(saved.amendment.settlement_status, 'not_started');
    await assert.rejects(invoke(first, 'concurrent-key', { ...f.request, reason: 'Changed reason' }), /different request/);
    await assert.rejects(invoke(first, 'another-key'), /duplicate key/);
    await assert.rejects(admin.query("UPDATE member_membership_amendment SET status='pending_application'"), /immutable/);
    await assert.rejects(admin.query('DELETE FROM member_membership_amendment'), /immutable/);
    assert.equal((await admin.query('SELECT count(*)::integer AS n FROM member_membership_amendment')).rows[0].n, 1);
    assert.equal(JSON.stringify((await admin.query('SELECT to_jsonb(h) AS value FROM member_membership_history h')).rows[0].value), sourceBefore);
    // A separate fully paid purchase proves zero-difference requests remain unapplied.
    const zeroFixture = amendmentFixture(today);
    zeroFixture.memberId = uuid(12);
    zeroFixture.current.member_id = zeroFixture.memberId;
    zeroFixture.current.id = uuid(15);
    zeroFixture.request.memberId = zeroFixture.memberId;
    await admin.query('INSERT INTO member VALUES ($1,$2)', [zeroFixture.memberId, f.tenantId]);
    zeroFixture.current = await insert('member_membership_history', zeroFixture.current);
    await admin.query('UPDATE membership_tier_config SET flat_cost=100 WHERE id=$1', [f.config.id]);
    zeroFixture.config = (await admin.query('SELECT to_jsonb(c) AS value FROM membership_tier_config c WHERE id=$1', [f.config.id])).rows[0].value;
    const zeroQuote = buildMemberAmendmentQuote({ ...zeroFixture, effectiveDate: today, quotedAt: new Date().toISOString() });
    zeroFixture.request.expectedQuote = memberAmendmentQuoteFingerprint(zeroQuote);
    const zero = (await first.query('SELECT propose_member_membership_amendment($1,$2,$3,$4,$5,$6) AS result',
      [f.tenantId, zeroFixture.memberId, uuid(7), 'zero-change-key', zeroFixture.request, zeroQuote])).rows[0].result;
    assert.equal(zero.amendment.status, 'pending_application');
    assert.equal(zero.amendment.entitlement_applied, false);
    // Replays remain stable after the live target config changes.
    assert.equal((await invoke(first, 'concurrent-key')).amendment.id, saved.amendment.id);
    // Settlement is an additive service-only lifecycle, never a purchase edit.
    const settlementMigration = readFileSync(new URL('../../supabase/migrations/202612310021_member_amendment_settlement.sql', import.meta.url), 'utf8');
    await admin.query(settlementMigration);
    await admin.query(settlementMigration);
    const supportedScope = async (source, target) => (await first.query(
      'SELECT member_amendment_operational_scope_supported($1,$2) AS supported', [source, target],
    )).rows[0].supported;
    assert.equal(await supportedScope(q.sourceSnapshot, q.targetSnapshot.config), true);
    for (const change of [
      (source) => { source.commitment_snapshot.config.start_mode = 'fixed_date'; },
      (source) => { source.commitment_snapshot.start_mode = 'fixed_date'; },
      (source) => { source.term_key = 'fixed:2026'; },
      (source) => { source.term_duration_months = 6; },
      (source) => { source.term_anchor_date = null; },
      (source, target) => { target.start_mode = 'fixed_date'; },
      (source, target) => { target.billing_period = 'monthly'; },
    ]) {
      const source = structuredClone(q.sourceSnapshot);
      const target = structuredClone(q.targetSnapshot.config);
      change(source, target);
      assert.equal(await supportedScope(source, target), false);
    }
    const reserve = (connection, a, choice, tenant = f.tenantId) => connection.query(
      'SELECT reserve_member_amendment_settlement($1,$2,$3,$4,$5) AS result',
      [tenant, a.id, uuid(7), choice, { provider: 'isolated-fixture' }],
    ).then(r => r.rows[0].result);
    const finish = (a, state = 'settled') => first.query(
      'SELECT finish_member_amendment_settlement($1,$2,$3,$4,$5,NULL) AS result',
      [f.tenantId, a.id, uuid(7), state, { verified: true, kind: 'isolated-test-only' }],
    );
    const apply = (a, tenant = f.tenantId) => first.query(
      'SELECT apply_member_membership_amendment($1,$2,$3) AS result', [tenant, a.id, uuid(7)],
    ).then(r => r.rows[0].result);
    await assert.rejects(reserve(first, saved.amendment, 'collect'), /Target pricing/);
    const zr = await reserve(first, zero.amendment, 'none');
    assert.equal(zr.claimed, true);
    await assert.rejects(apply(zero.amendment), /Verified settlement/);
    await finish(zero.amendment);
    const [za, secondApplication] = await Promise.all([
      apply(zero.amendment),
      second.query('SELECT apply_member_membership_amendment($1,$2,$3) AS result',
        [f.tenantId, zero.amendment.id, uuid(7)]).then(r => r.rows[0].result),
    ]);
    assert.equal(secondApplication.id, za.id);
    assert.equal(za.source_record_id, zeroFixture.current.id);
    assert.equal((await apply(zero.amendment)).id, za.id);
    assert.equal(za.expires_on, zeroFixture.current.membership_renewal_date);
    await assert.rejects(admin.query('UPDATE member_membership_amendment_application SET snapshot=\'{}\''), /immutable/);
    await admin.query('UPDATE membership_tier_config SET flat_cost=200 WHERE id=$1', [f.config.id]);
    await first.query('BEGIN');
    const claimed = await reserve(first, saved.amendment, 'collect');
    let reserveFinished = false;
    const concurrentReserve = reserve(second, saved.amendment, 'collect').then(r => { reserveFinished = true; return r; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(reserveFinished, false);
    await first.query('COMMIT');
    assert.equal(claimed.claimed, true);
    assert.equal((await concurrentReserve).claimed, false);
    await assert.rejects(reserve(first, saved.amendment, 'refund'), /choice is already locked/);
    await assert.rejects(reserve(first, saved.amendment, 'collect', uuid(99)), /Amendment not found/);
    await finish(saved.amendment);
    // A pause arriving after collection is a persisted conflict, not lost money
    // or applied membership. Subsequent application cannot override the guard.
    await admin.query('ALTER TABLE member ADD COLUMN membership_paused boolean DEFAULT false');
    await admin.query('UPDATE member SET membership_paused=true WHERE id=$1', [f.memberId]);
    assert.equal((await apply(saved.amendment)).code, 'late_settlement_conflict');
    assert.equal((await admin.query('SELECT state FROM member_membership_amendment_settlement WHERE amendment_id=$1', [saved.amendment.id])).rows[0].state, 'conflict');
    const extraProposal = async (n) => {
      const fixture = amendmentFixture(today);
      fixture.memberId = uuid(n);
      fixture.current.member_id = fixture.memberId;
      fixture.current.id = uuid(n + 1);
      fixture.request.memberId = fixture.memberId;
      await admin.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [fixture.memberId, f.tenantId]);
      fixture.current = await insert('member_membership_history', fixture.current);
      fixture.config = (await admin.query('SELECT to_jsonb(c) AS value FROM membership_tier_config c WHERE id=$1', [f.config.id])).rows[0].value;
      const quoted = buildMemberAmendmentQuote({ ...fixture, effectiveDate: today, quotedAt: new Date().toISOString() });
      fixture.request.expectedQuote = memberAmendmentQuoteFingerprint(quoted);
      const proposed = (await first.query('SELECT propose_member_membership_amendment($1,$2,$3,$4,$5,$6) AS result',
        [f.tenantId, fixture.memberId, uuid(7), `late-change-${n}`, fixture.request, quoted])).rows[0].result;
      await reserve(first, proposed.amendment, 'collect');
      await finish(proposed.amendment);
      return { fixture, amendment: proposed.amendment };
    };
    const renewalRace = await extraProposal(30);
    await insert('member_membership_history', { ...renewalRace.fixture.current, id: uuid(32),
      term_start_date: renewalRace.fixture.current.membership_renewal_date,
      membership_renewal_date: `${Number(today.slice(0, 4)) + 2}-01-01` });
    assert.equal((await apply(renewalRace.amendment)).conflict, true);
    const expiryRace = await extraProposal(40);
    await admin.query('UPDATE member_membership_history SET membership_renewal_date=$1 WHERE id=$2',
      [today, expiryRace.fixture.current.id]);
    assert.equal((await apply(expiryRace.amendment)).conflict, true);
    const sourceRace = await extraProposal(50);
    await admin.query("UPDATE member_membership_history SET payment_status='unpaid' WHERE id=$1", [sourceRace.fixture.current.id]);
    assert.equal((await apply(sourceRace.amendment)).conflict, true);
    const historical = amendmentFixture(today);
    historical.memberId = uuid(60);
    historical.current.member_id = historical.memberId;
    historical.current.id = uuid(61);
    historical.request.memberId = historical.memberId;
    await admin.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [historical.memberId, f.tenantId]);
    historical.current = await insert('member_membership_history', historical.current);
    historical.config = (await admin.query('SELECT to_jsonb(c) AS value FROM membership_tier_config c WHERE id=$1', [f.config.id])).rows[0].value;
    const historicQuote = buildMemberAmendmentQuote({ ...historical, effectiveDate: today, quotedAt: new Date().toISOString() });
    // Simulate a first-slice fixed-date proposal, created before the reader
    // scope release guard. The immutable old proposal remains readable.
    await admin.query("UPDATE membership_tier_config SET start_mode='fixed_date' WHERE id=$1", [f.config.id]);
    historicQuote.targetSnapshot.config.start_mode = 'fixed_date';
    historical.request.expectedQuote = memberAmendmentQuoteFingerprint(historicQuote);
    const historicProposal = (await first.query('SELECT propose_member_membership_amendment($1,$2,$3,$4,$5,$6) AS result',
      [f.tenantId, historical.memberId, uuid(7), 'historical-fixed-date', historical.request, historicQuote])).rows[0].result.amendment;
    await assert.rejects(reserve(first, historicProposal, 'collect'), /Unsupported operational amendment scope/);
    await assert.rejects(apply(historicProposal), /Unsupported operational amendment scope/);
    assert.equal((await admin.query('SELECT count(*)::integer AS n FROM member_membership_amendment_settlement WHERE amendment_id=$1', [historicProposal.id])).rows[0].n, 0);
    assert.equal((await admin.query('SELECT count(*)::integer AS n FROM member_membership_amendment_event WHERE amendment_id=$1', [historicProposal.id])).rows[0].n, 0);
    await admin.query("UPDATE membership_tier_config SET start_mode='immediate' WHERE id=$1", [f.config.id]);
    const sourceScopeRace = await extraProposal(70);
    await admin.query(`UPDATE member_membership_history SET commitment_snapshot=
      jsonb_set(commitment_snapshot,'{config,start_mode}','"fixed_date"') WHERE id=$1`, [sourceScopeRace.fixture.current.id]);
    assert.equal((await apply(sourceScopeRace.amendment)).conflict, true);
    await admin.query('SET ROLE authenticated');
    await assert.rejects(reserve(admin, zero.amendment, 'none'), /permission denied/);
    await assert.rejects(admin.query('SELECT * FROM member_membership_amendment_application'), /permission denied/);
    await admin.query('RESET ROLE');
    await assert.rejects(first.query("UPDATE member_membership_amendment_settlement SET state='applied'"), /permission denied/);
    assert.equal(JSON.stringify((await admin.query('SELECT to_jsonb(h) AS value FROM member_membership_history h WHERE id=$1', [f.current.id])).rows[0].value), sourceBefore);
  } finally {
    for (const connection of clients) await connection.end().catch(() => {});
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});

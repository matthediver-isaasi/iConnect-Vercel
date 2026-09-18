import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

// Never reads environment connection strings: this is a disposable Unix-socket
// cluster with no TCP listener and no production/provider side effects.
test('renewal cron continuation migration: claims, fencing, grants and paged discovery', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'renewal-cron-state-pg-'));
  const cluster = join(directory, 'data');
  let running = false;
  const clients = [];
  const ownerA = '00000000-0000-4000-8000-000000000001';
  const ownerB = '00000000-0000-4000-8000-000000000002';
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o', `-k ${directory} -p 55487 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    for (let i = 0; i < 3; i++) {
      const db = new pg.Client({ host: directory, port: 55487, user: 'runner', database: 'postgres' });
      await db.connect();
      await db.query("SET statement_timeout = '5s'");
      clients.push(db);
    }
    const [admin, first, second] = clients;
    await admin.query(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE TABLE public.membership_tier_config (id uuid PRIMARY KEY, tenant_id uuid, effective_to timestamptz);
      CREATE TABLE public.member_membership_history (id uuid PRIMARY KEY, tenant_id uuid, expiry_enforced_at timestamptz);
      CREATE TABLE public.organisation_membership_history (id uuid PRIMARY KEY, tenant_id uuid, expiry_enforced_at timestamptz);
      CREATE TABLE public.member (id uuid PRIMARY KEY, tenant_id uuid, organization_id uuid);
      CREATE TABLE public.system_settings (tenant_id uuid, setting_key text, setting_value text);
      CREATE TABLE public.membership_expiry_action (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        history_type text NOT NULL CHECK (history_type IN ('member', 'organisation')),
        history_id uuid NOT NULL,
        member_id uuid NOT NULL,
        config_id uuid,
        previous_login_enabled boolean,
        login_disabled boolean NOT NULL DEFAULT false,
        previous_role_id uuid,
        assigned_role_id uuid,
        applied_at timestamptz NOT NULL DEFAULT now(),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (history_type, history_id, member_id)
      );
    `);
    const migration = await readFile(new URL('../../supabase/migrations/20260922_membership_renewal_cron_state.sql', import.meta.url), 'utf8');
    await admin.query(migration);
    await admin.query(migration);
    await first.query('SET ROLE service_role');
    await second.query('SET ROLE service_role');
    const claim = async (db, owner) => (await db.query('SELECT public.claim_membership_renewal_cron($1) AS result', [owner])).rows[0].result;
    const save = async (db, owner, state, release = false) => (await db.query(
      'SELECT public.save_membership_renewal_cron($1, $2, $3) AS result', [owner, JSON.stringify(state), release],
    )).rows[0].result;

    await t.test('simultaneous claims have exactly one winner, without renewing an active lease', async () => {
      const results = await Promise.all([claim(first, ownerA), claim(second, ownerB)]);
      assert.equal(results.filter(row => row.claimed).length, 1);
      const winner = results[0].claimed ? ownerA : ownerB;
      const loser = winner === ownerA ? ownerB : ownerA;
      const acquired = results.find(row => row.claimed);
      assert.deepEqual(acquired.state, {});
      const leaseRemaining = Date.parse(acquired.lease_until) - Date.now();
      assert.ok(leaseRemaining > 110000 && leaseRemaining <= 121000);
      assert.deepEqual(await claim(first, winner), { claimed: false });
      await assert.rejects(save(second, loser, { wrong: true }), /ownership lost/);
      const saved = await save(first, winner, { expiry: { afterId: 'history-100' } });
      assert.equal(saved.lease_until, acquired.lease_until, 'saving does not extend the lease');
      await save(first, winner, { expiry: { afterId: 'history-100' } }, true);
      await assert.rejects(save(first, winner, {}), /ownership lost/);
      const next = await claim(second, loser);
      assert.deepEqual(next.state, { expiry: { afterId: 'history-100' } });
      await save(second, loser, {}, true);
    });

    await t.test('expired worker cannot checkpoint or release after takeover', async () => {
      await claim(first, ownerA);
      await save(first, ownerA, { billing: { tenant: 'pending' } });
      await admin.query("UPDATE public.membership_renewal_cron_state SET lease_until = clock_timestamp() - interval '1 second'");
      await assert.rejects(save(first, ownerA, { stale: true }), /ownership lost/);
      const takeover = await claim(second, ownerB);
      assert.equal(takeover.claimed, true);
      assert.deepEqual(takeover.state, { billing: { tenant: 'pending' } });
      await assert.rejects(save(first, ownerA, { stale: true }, true), /ownership lost/);
      await save(second, ownerB, { resumed: true }, true);
    });

    await t.test('invalid ownership and continuation inputs cannot create corrupt state', async () => {
      await assert.rejects(claim(first, null), /owner is required/);
      await claim(first, ownerA);
      await assert.rejects(save(first, ownerA, []), /object state/);
      await assert.rejects(save(first, ownerA, null), /object state/);
      await assert.rejects(first.query('SELECT public.save_membership_renewal_cron($1, $2, NULL)', [ownerA, '{}']), /release flag/);
      await save(first, ownerA, {}, true);
      await assert.rejects(admin.query("INSERT INTO public.membership_renewal_cron_state(singleton) VALUES(false)"), /check constraint/);
    });

    await t.test('only service role can execute RPCs and clients cannot access state directly', async () => {
      for (const role of ['anon', 'authenticated']) {
        await admin.query(`SET ROLE ${role}`);
        await assert.rejects(claim(admin, ownerA), /permission denied/);
        await assert.rejects(save(admin, ownerA, {}), /permission denied/);
        await assert.rejects(admin.query('SELECT * FROM public.membership_renewal_cron_tenants()'), /permission denied/);
        await assert.rejects(admin.query('SELECT * FROM public.membership_renewal_cron_state'), /permission denied/);
        await admin.query('RESET ROLE');
      }
      await assert.rejects(first.query("UPDATE public.membership_renewal_cron_state SET state = '{}'"), /permission denied/);
      const rls = (await admin.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.membership_renewal_cron_state'::regclass")).rows[0];
      assert.equal(rls.relrowsecurity, true);
    });

    await t.test('discovery includes expiry-only tenants and pages beyond the usual 1000 row cap', async () => {
      await admin.query(`
        INSERT INTO public.membership_tier_config
          SELECT md5('config-' || n)::uuid, md5('tenant-' || n)::uuid, NULL FROM generate_series(1, 1205) n;
        INSERT INTO public.membership_tier_config
          VALUES (md5('inactive-config')::uuid, md5('inactive-only')::uuid, now());
        INSERT INTO public.member_membership_history VALUES
          (md5('member-history')::uuid, md5('expired-member-only')::uuid, NULL),
          (md5('enforced-history')::uuid, md5('enforced-only')::uuid, now()),
          (md5('duplicate-history')::uuid, md5('tenant-1')::uuid, NULL);
        INSERT INTO public.organisation_membership_history VALUES
          (md5('org-history')::uuid, md5('expired-org-only')::uuid, NULL);
        INSERT INTO public.system_settings VALUES
          (md5('tenant-1')::uuid, 'membership_cron_time', '23:59'),
          (md5('tenant-2')::uuid, 'membership_cron_time', '00:00'),
          (md5('tenant-3')::uuid, 'membership_cron_time', '24:00'),
          (md5('tenant-4')::uuid, 'membership_cron_time', 'bogus'),
          (md5('tenant-5')::uuid, 'membership_cron_time', '99999999999999999999'),
          (md5('tenant-6')::uuid, 'membership_cron_time', '6:30'),
          (md5('tenant-7')::uuid, 'membership_cron_time', '07:99');
      `);
      const rows = [];
      for (let offset = 0; ; offset += 100) {
        const page = (await first.query(
          'SELECT * FROM public.membership_renewal_cron_tenants() ORDER BY tenant_id LIMIT 100 OFFSET $1', [offset],
        )).rows;
        rows.push(...page);
        if (page.length < 100) break;
      }
      assert.equal(rows.length, 1207);
      assert.equal(new Set(rows.map(row => row.tenant_id)).size, 1207);
      assert.ok(rows.every(row => typeof row.tenant_id === 'string'));
      const tenantId = async label => (await admin.query('SELECT md5($1)::uuid AS id', [label])).rows[0].id;
      for (const label of ['expired-member-only', 'expired-org-only']) {
        const id = await tenantId(label);
        assert.ok(rows.some(row => row.tenant_id === id));
      }
      for (const label of ['inactive-only', 'enforced-only']) {
        const id = await tenantId(label);
        assert.equal(rows.some(row => row.tenant_id === id), false);
      }
      for (const [n, expected] of [[1, 23], [2, 0], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6]]) {
        const id = await tenantId(`tenant-${n}`);
        assert.equal(rows.find(row => row.tenant_id === id).scheduled_hour, expected);
      }
    });

    await t.test('action journal installation classifies interrupted histories without rewriting provenance', async () => {
      const cases = [
        { label: 'member-complete', historyType: 'member', enforced: true, expected: 'completed' },
        { label: 'member-interrupted', historyType: 'member', enforced: false, expected: 'pending' },
        { label: 'org-complete', historyType: 'organisation', enforced: true, expected: 'completed' },
        { label: 'org-interrupted', historyType: 'organisation', enforced: false, expected: 'pending' },
        { label: 'other-source', historyType: 'member', enforced: false, source: 'manual', expected: 'completed' },
        { label: 'wrong-tenant', historyType: 'organisation', enforced: false, wrongTenant: true, expected: 'completed' },
        { label: 'missing-history', historyType: 'member', noHistory: true, expected: 'completed' },
      ];
      for (const entry of cases) {
        const table = entry.historyType === 'member' ? 'member_membership_history' : 'organisation_membership_history';
        if (!entry.noHistory) {
          await admin.query(`
            INSERT INTO public.${table}(id, tenant_id, expiry_enforced_at)
            VALUES (md5($1)::uuid, md5($2)::uuid, $3::timestamptz)
          `, [entry.label, entry.wrongTenant ? 'journal-other-tenant' : 'journal-tenant', entry.enforced ? '2026-09-01T12:00:00Z' : null]);
        }
        await admin.query(`
          INSERT INTO public.membership_expiry_action (
            id, tenant_id, history_type, history_id, member_id, config_id,
            previous_login_enabled, login_disabled, previous_role_id, assigned_role_id, applied_at, details
          ) VALUES (
            md5($1)::uuid, md5('journal-tenant')::uuid, $2, md5($1)::uuid,
            md5('journal-member-' || $1)::uuid, md5('journal-config')::uuid,
            true, true, md5('original-role')::uuid, md5('fallback-role')::uuid,
            '2026-09-01T11:59:00Z', jsonb_build_object('source', $3::text, 'original_note', $1::text)
          )
        `, [entry.label, entry.historyType, entry.source || 'annual_membership_expiry_sweep']);
      }
      const original = (await admin.query('SELECT to_jsonb(a) AS row FROM public.membership_expiry_action a ORDER BY id')).rows.map(({ row }) => row);
      const journalMigration = await readFile(new URL('../../supabase/migrations/20260922_membership_expiry_action_journal.sql', import.meta.url), 'utf8');
      await admin.query(journalMigration);
      const installed = (await admin.query('SELECT * FROM public.membership_expiry_action ORDER BY id')).rows;
      for (const entry of cases) {
        const action = installed.find(row => row.details.original_note === entry.label);
        assert.equal(action.action_state, entry.expected, entry.label);
        assert.equal(action.completed_at, null, 'migration must not invent a completion timestamp');
      }
      await admin.query(journalMigration);
      assert.deepEqual((await admin.query('SELECT * FROM public.membership_expiry_action ORDER BY id')).rows, installed, 'reapplying the journal migration is idempotent');
      const preserved = (await admin.query(`
        SELECT to_jsonb(a) - 'action_state' - 'completed_at' AS row
        FROM public.membership_expiry_action a ORDER BY id
      `)).rows.map(({ row }) => row);
      assert.deepEqual(preserved, original, 'original access state, roles, timestamp, IDs and details must be unchanged');

      // A new worker can finish the action before marking its history complete.
      // Reinstalling must not reopen that action or overwrite its receipt.
      await admin.query(`
        UPDATE public.membership_expiry_action
        SET action_state = 'completed', completed_at = '2026-09-02T12:00:00Z'
        WHERE details->>'original_note' = 'member-interrupted'
      `);
      const repaired = (await admin.query('SELECT * FROM public.membership_expiry_action ORDER BY id')).rows;
      await admin.query(journalMigration);
      await admin.query(migration);
      assert.deepEqual((await admin.query('SELECT * FROM public.membership_expiry_action ORDER BY id')).rows, repaired);
      await assert.rejects(admin.query(`
        UPDATE public.membership_expiry_action SET action_state = 'unknown'
        WHERE details->>'original_note' = 'org-interrupted'
      `), /check constraint/);
      const indexes = (await admin.query(`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
          'member_membership_history_expiry_keyset_idx',
          'organisation_membership_history_expiry_keyset_idx',
          'member_organisation_expiry_keyset_idx'
        )
      `)).rows;
      assert.equal(indexes.length, 3, 'both migrations share the same three keyset indexes');
    });
  } finally {
    await Promise.all(clients.map(db => db.end()));
    if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(directory, { recursive: true, force: true });
  }
});
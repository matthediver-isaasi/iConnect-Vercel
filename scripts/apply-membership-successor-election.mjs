import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

// No connection without an explicit command. This runner never falls back to
// DATABASE_URL, SUPABASE_URL or SOURCE. Do not run --apply without approval.
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verify = args.includes('--verify-dest');
const expected = args.find(arg => arg.startsWith('--expected-contract='))?.split('=')[1];
const recovery = args.includes('--payment-attempts');
const release = args.includes('--unused-release');
const settlement = args.includes('--attempt-settlement');
const migrationName = settlement ? '20261204_membership_successor_attempt_settlement'
  : release ? '20261203_membership_successor_unused_release'
  : recovery ? '20261202_membership_successor_payment_attempts' : '20261201_membership_successor_election';
const migration = await readFile(new URL(`../supabase/migrations/${migrationName}.sql`, import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
if (!apply && !verify) {
  console.log(JSON.stringify({ migration: migrationName,
    sha256: sha(migration), applied: false,
    next: 'With approval, use --verify-dest to inspect the installed contracts. --apply also requires --expected-contract=<reviewed hash>.' }));
} else {
  let db;
  try {
    if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
      throw new Error('Refusing connection: verified DEST target required');
    }
    if (apply && !/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Applying requires the reviewed installed-contract hash');
    db = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL });
    await db.connect();
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    if (apply) await db.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-successor-schema',0))");
    const { rows } = await db.query(`SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('enforce_rolling_membership_commitment','reserve_form_membership_payment_quote','bind_form_membership_payment_quote')
      ORDER BY p.proname,p.oid`);
    if (rows.length !== 3) throw new Error('Required installed membership contracts are missing or ambiguous');
    const contractHash = sha(JSON.stringify(rows));
    const settlementInstalled = rows.some(row => row.proname === 'enforce_rolling_membership_commitment'
      && row.definition.includes('public.membership_successor_payment_attempt attempt'));
    const installed = (await db.query("SELECT to_regclass('public.membership_successor_election') IS NOT NULL AS installed")).rows[0].installed;
    const attemptsInstalled = (await db.query("SELECT to_regclass('public.membership_successor_payment_attempt') IS NOT NULL AS installed")).rows[0].installed;
    const releaseInstalled = (await db.query("SELECT to_regprocedure('public.release_unused_membership_successor(uuid,uuid,uuid)') IS NOT NULL AS installed")).rows[0].installed;
    const rollout = installed
      ? (await db.query(`SELECT membership_successor_elections_enabled() AS enabled,
          (SELECT count(*)::integer FROM membership_successor_election) AS elections`)).rows[0]
      : null;
    if (!apply) {
      await db.query('ROLLBACK');
      console.log(JSON.stringify({ verifiedTarget: 'DEST', installed, attemptsInstalled, releaseInstalled, settlementInstalled, contractHash,
        migrationHash: sha(migration), rollout, applied: false }));
    } else {
      if (contractHash !== expected) throw new Error('Installed contracts differ from the reviewed hash; refusing migration');
      if (settlement ? (!installed || !attemptsInstalled || !releaseInstalled || settlementInstalled || rollout?.enabled !== false)
        : release ? (!installed || !attemptsInstalled || releaseInstalled || rollout?.enabled !== false)
        : recovery ? (!installed || attemptsInstalled || rollout?.enabled !== false) : installed) {
        throw new Error('Successor schema prerequisites or rollout state prevent applying this migration');
      }
      await db.query(migration.replace(/\bBEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
      const enabled = (await db.query('SELECT membership_successor_elections_enabled() enabled')).rows[0].enabled;
      if (enabled !== false) throw new Error('Successor schema unexpectedly enabled; refusing commit');
      await db.query("NOTIFY pgrst, 'reload schema'");
      await db.query('COMMIT');
      console.log(JSON.stringify({ target: 'DEST', applied: migrationName,
        renewalChoicesEnabled: false, migrationHash: sha(migration) }));
    }
  } catch (error) {
    if (db) await db.query('ROLLBACK').catch(() => {});
    // Provider connection errors can include host/user details; keep output safe.
    console.error(error.message?.startsWith('Refusing') || error.message?.includes('contract')
      || error.message?.includes('schema') || error.message?.includes('Applying')
      ? error.message : 'Migration verification/apply failed; no success is asserted.');
    process.exitCode = 1;
  } finally {
    if (db) await db.end();
  }
}
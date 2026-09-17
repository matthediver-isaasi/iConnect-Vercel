#!/usr/bin/env node
// Default: offline dry-run. Apply: explicit tenant + flag, service-role-only
// atomic CAS RPC. Install migrations 20260919, 20260920, then 20260921 first.
import { readFile } from 'node:fs/promises';
import { recoverRollingCommitment, applyRecoveredRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';

const args = process.argv.slice(2);
const usage = 'Usage: node scripts/recover-rolling-membership-commitments.mjs <evidence.json> [--tenant <uuid>] [--apply]\n'
  + 'Default is offline dry-run. --apply requires --tenant and DEST_DATABASE_URL (or DATABASE_URL),\n'
  + 'plus migrations 20260919/20260920/20260921. Input: [{history, agreement?, quote?}] exported from the DB.\n'
  + 'Apply re-reads evidence under locks; missing/stale/conflicting evidence is never modified. No provider calls.';
let db = null;
try {
  let file = null;
  let tenantId = null;
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--tenant' && !tenantId) tenantId = args[++i];
    else if (!args[i].startsWith('--') && !file) file = args[i];
    else throw new Error(usage);
  }
  if (!file || (apply && !tenantId) || (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))) throw new Error(usage);
  const evidence = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(evidence)) throw new Error('Evidence must be an array');
  if (tenantId && evidence.some((item) => item?.history?.tenant_id !== tenantId)) {
    throw new Error('Evidence contains a history row outside the explicitly selected tenant');
  }
  let client;
  if (apply) {
    const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Set DEST_DATABASE_URL or DATABASE_URL for explicit apply; no connection attempted');
    const { default: pg } = await import('pg');
    // Honour configured sslmode/certificates; never log the connection string.
    db = new pg.Client({ connectionString });
    await db.connect();
    client = {
      rpc: async (_name, params) => {
        const { rows } = await db.query('SELECT recover_rolling_membership_commitment($1,$2,$3,$4,$5,$6,$7) AS result', [
          params.p_tenant_id, params.p_history_type, params.p_history_id, params.p_expected_history,
          params.p_expected_agreement, params.p_expected_quote, params.p_commitment,
        ]);
        return { data: rows[0].result };
      },
    };
  }
  const results = [];
  for (const item of evidence) {
    try {
      results.push(apply
        ? await applyRecoveredRollingCommitment(client, { tenantId, evidence: item })
        : recoverRollingCommitment(item));
    } catch (error) {
      results.push({ status: 'conflict', id: item?.history?.id, reason: error.message });
      process.exitCode = 2;
    }
  }
  console.log(JSON.stringify({ dry_run: !apply, tenant_id: tenantId, results }, null, 2));
} catch (error) {
  console.error(`Recovery failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) await db.end();
}
#!/usr/bin/env node
// Offline plan by default. This script does NOT install its prerequisite
// migration, touch membership history, call providers, or clear cron reviews.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { connectDestination } from './annual-meeting-destination.mjs';
import { isAttestedExpiryOnlyHistory } from '../api/_lib/expiryOnlyRenewalPolicy.js';

export const APPROVED_ASSIGNMENT = Object.freeze({
  tenant_id: 'ff2df806-b321-4254-b651-3af11fccf1db',
  history_id: 'c74442a4-ede3-5df7-a1a1-11fea2c26afe',
  member_id: '295ba406-921e-42a9-817b-563fcd56378b',
  config_id: 'b59692c9-07b0-469d-9f6e-9d314a270926',
  config_name: '2026-2027 Full member', expiry_date: '2026-09-25',
  policy_snapshot: Object.freeze({ renewal_open_days: 90, renewal_grace_days: 90,
    renewal_disable_login: true, renewal_change_role: false, renewal_fallback_role_id: null }),
  approval_source: 'operator',
  approval_reference: 'Explicit operator instruction: existing BNMS expiry-only history uses 2026-2027 Full member renewal policy and 90-day grace; no historical pricing or commencement authority.',
});
const same = isDeepStrictEqual;

export async function assignApprovedPolicy(client) {
  const a = APPROVED_ASSIGNMENT;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    const locked = await client.query(`
      SELECT to_jsonb(h) AS history, to_jsonb(c) AS config
      FROM public.member_membership_history h
      JOIN public.membership_tier_config c ON c.id=$4 AND c.tenant_id=h.tenant_id
      WHERE h.tenant_id=$1 AND h.id=$2 AND h.member_id=$3 FOR UPDATE OF h,c`,
    [a.tenant_id, a.history_id, a.member_id, a.config_id]);
    if (locked.rowCount !== 1) throw new Error('Exact approved history/config binding was not found');
    const { history, config } = locked.rows[0];
    if (!isAttestedExpiryOnlyHistory(history, a.tenant_id) || history.term_end_date !== a.expiry_date
        || history.final_cost !== null || history.total_with_vat !== null
        || history.term_anchor_date !== null || history.previous_term_id !== null
        || history.tier_label !== 'Full Membership UK') throw new Error('Approved historical invariants changed');
    const existing = await client.query(`SELECT * FROM public.membership_expiry_policy_assignment
      WHERE history_id=$1`, [a.history_id]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      // pg's date parser may return a Date; SQL JSON uses an exact date string.
      const exact = await client.query(`SELECT to_jsonb(p) AS assignment
        FROM public.membership_expiry_policy_assignment p WHERE history_id=$1`, [a.history_id]);
      const saved = exact.rows[0].assignment;
      for (const key of Object.keys(a)) {
        if (key === 'policy_snapshot' ? !same(saved[key], a[key]) : saved[key] !== a[key]) {
          throw new Error('Existing assignment differs from the exact operator approval');
        }
      }
      await client.query('COMMIT');
      return { applied: false, idempotent: true, assignmentId: row.id };
    }
    if (history.expiry_enforced_at !== null || history.annual_renewal_state !== null
        || config.name !== a.config_name || config.start_mode !== 'immediate'
        || config.structure_scope_type !== 'member' || config.billing_period !== 'annual'
        || config.is_active !== true || config.effective_from !== '2026-09-01'
        || config.effective_to !== null
        || Date.parse(config.updated_at) !== Date.parse('2026-09-21T11:05:39.732Z')
        || Object.entries(a.policy_snapshot).some(([key, value]) => config[key] !== value)) {
      throw new Error('Approved configuration version/policy or expiry state changed');
    }
    const inserted = await client.query(`INSERT INTO public.membership_expiry_policy_assignment
      (tenant_id,history_id,member_id,config_id,config_name,expiry_date,policy_snapshot,approval_source,approval_reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
    [a.tenant_id, a.history_id, a.member_id, a.config_id, a.config_name, a.expiry_date,
      JSON.stringify(a.policy_snapshot), a.approval_source, a.approval_reference]);
    if (inserted.rowCount !== 1) throw new Error('Assignment insert did not affect exactly one row');
    const after = await client.query('SELECT to_jsonb(h) AS history FROM public.member_membership_history h WHERE id=$1', [a.history_id]);
    if (!same(after.rows[0]?.history || {}, history)) throw new Error('Historical membership changed during policy assignment');
    await client.query('COMMIT');
    return { applied: true, idempotent: false, assignmentId: inserted.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function main(args = process.argv.slice(2), connect = connectDestination) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
      || args.filter(arg => arg === '--apply').length > 1
      || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1) {
    throw new Error('Supported arguments: --apply --review-sha256=<reviewed script hash>');
  }
  const sha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, destination: 'DEST', writesPerformed: false,
      prerequisiteMigration: '20261128_membership_expiry_policy_assignment.sql',
      historyId: APPROVED_ASSIGNMENT.history_id, configId: APPROVED_ASSIGNMENT.config_id, sha256 }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed script hash does not match; no connection opened');
  const client = await connect();
  try { console.log(JSON.stringify(await assignApprovedPolicy(client))); }
  finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
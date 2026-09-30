// Read-only, aggregate-only reconciliation. No provider requests or repair mode.
import { pathToFileURL } from 'node:url';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { TENANT_ID } from './bnms-dd-pilot.mjs';

export async function reconcile(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const rows = async sql => (await client.query(sql, [TENANT_ID])).rows;
    const adoption = await rows(`
      WITH imports AS (
        SELECT 'pilot' AS cohort, member_id, agreement_id, plan_id, history_id FROM bnms_dd_pilot_adoption WHERE tenant_id=$1
        UNION ALL SELECT 'beta',member_id,agreement_id,plan_id,history_id FROM bnms_dd_beta_adoption WHERE tenant_id=$1
        UNION ALL SELECT 'alpha',member_id,agreement_id,plan_id,history_id FROM bnms_dd_alpha_adoption WHERE tenant_id=$1
      ), ranked AS (
        SELECT id,row_number() OVER (ORDER BY updated_at DESC,id DESC) AS position
        FROM membership_payment_plans WHERE tenant_id=$1
      )
      SELECT i.cohort,count(*)::int AS adopted,
        count(*) FILTER(WHERE m.id IS NULL)::int AS missing_members,
        count(*) FILTER(WHERE m.email ~* '^deleted_.+@deleted[.]local$')::int AS deleted_members,
        count(*) FILTER(WHERE a.id IS NOT NULL AND p.id IS NOT NULL AND h.id IS NOT NULL
          AND p.billing_agreement_id=a.id AND h.billing_agreement_id=a.id
          AND a.member_id=i.member_id AND p.member_id=i.member_id AND h.member_id=i.member_id)::int AS intact_linkage,
        count(*) FILTER(WHERE r.position>200)::int AS outside_legacy_200_window,
        count(*) FILTER(WHERE p.collection_stopped_at IS NOT NULL)::int AS collection_stopped,
        count(*) FILTER(WHERE p.metadata->>'bnms_release_required'='true')::int AS release_required,
        count(*) FILTER(WHERE p.status='first_payment_pending')::int AS first_payment_pending,
        count(*) FILTER(WHERE h.status='active')::int AS active_membership_history
      FROM imports i LEFT JOIN member m ON m.id=i.member_id AND m.tenant_id=$1
      LEFT JOIN membership_billing_agreements a ON a.id=i.agreement_id AND a.tenant_id=$1
      LEFT JOIN membership_payment_plans p ON p.id=i.plan_id AND p.tenant_id=$1
      LEFT JOIN member_membership_history h ON h.id=i.history_id AND h.tenant_id=$1
      LEFT JOIN ranked r ON r.id=i.plan_id GROUP BY i.cohort ORDER BY i.cohort`);
    const plans = await rows(`
      SELECT p.provider,p.status,count(*)::int AS plans,
        count(*) FILTER(WHERE m.email ~* '^deleted_.+@deleted[.]local$')::int AS deleted_agreement_members,
        count(*) FILTER(WHERE a.member_id IS NOT NULL AND m.id IS NULL)::int AS missing_agreement_members
      FROM membership_payment_plans p
      LEFT JOIN membership_billing_agreements a ON a.id=p.billing_agreement_id AND a.tenant_id=$1
      LEFT JOIN member m ON m.id=a.member_id AND m.tenant_id=$1
      WHERE p.tenant_id=$1 GROUP BY p.provider,p.status ORDER BY p.provider,p.status`);
    const discovery = await rows(`
      SELECT count(*)::int AS discovery_rows,
        count(*) FILTER(WHERE d.matched_member_id IS NOT NULL)::int AS matched_rows,
        count(*) FILTER(WHERE d.matched_member_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM membership_payment_plans p WHERE p.tenant_id=$1 AND p.member_id=d.matched_member_id
        ))::int AS matched_without_canonical_plan,
        count(*) FILTER(WHERE m.email ~* '^deleted_.+@deleted[.]local$')::int AS deleted_matched_members
      FROM gocardless_mandate_discovery_row d
      LEFT JOIN member m ON m.id=d.matched_member_id AND m.tenant_id=$1
      WHERE d.tenant_id=$1`);
    return { checkedAt: new Date().toISOString(), destination: 'verified_DEST',
      readOnly: true, writes: 0, providerCalls: 0, adoption, plans, discovery,
      legacyWindowNote: 'Unfiltered updated_at DESC window; id tie-breaker makes boundary deterministic. Search and pending activation were applied after this window.',
      discoveryNote: 'Discovery matches are not canonical adopted plans and must not be counted as imported plans.' };
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length) throw new Error('No arguments supported: read-only aggregate reconciliation only');
  const client = await destinationConnection();
  try {
    await client.connect();
    console.log(JSON.stringify(await reconcile(client), null, 2));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Driver errors can contain credentials or row details; do not log them.
    console.error('Read-only reconciliation failed; verify pinned DEST access and required schema.');
    process.exitCode = 1;
  });
}
// Read-only destination discovery. No provider APIs or credential reads.
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

destinationTarget(process.env);
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { destinationConnection } = await import('./run-bnms-dd-pilot-history.mjs');
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const file = await open('exports/bnms-beta-pilot-recognition-preflight.json', 'wx', 0o600);
let client;
try {
  client = await destinationConnection();
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const rows = (await client.query(`WITH cohort AS (
    SELECT 'beta' kind,id,tenant_id,member_id,agreement_id,plan_id,history_id
      FROM public.bnms_dd_beta_adoption WHERE tenant_id=$1
    UNION ALL
    SELECT 'pilot',id,tenant_id,member_id,agreement_id,plan_id,history_id
      FROM public.bnms_dd_pilot_adoption WHERE tenant_id=$1)
    SELECT to_jsonb(a) identity,to_jsonb(h) history,to_jsonb(p) plan,to_jsonb(b) agreement,
      m.id IS NOT NULL AS member_exists
    FROM cohort a
    LEFT JOIN public.member_membership_history h ON h.id=a.history_id
    LEFT JOIN public.membership_payment_plans p ON p.id=a.plan_id
    LEFT JOIN public.membership_billing_agreements b ON b.id=a.agreement_id
    LEFT JOIN public.member m ON m.id=a.member_id AND m.tenant_id=a.tenant_id
    ORDER BY a.kind,a.member_id`, [tenant])).rows;
  const summary = {
    target: 'lvmzliemqnieeoruhkik',
    beta: rows.filter(r => r.identity.kind === 'beta').length,
    pilot: rows.filter(r => r.identity.kind === 'pilot').length,
    ownershipValid: rows.every(({identity:a,history:h,plan:p,agreement:b,member_exists:m}) =>
      m && [h,p,b].every(r => r?.tenant_id===a.tenant_id && r?.member_id===a.member_id)
      && h.billing_agreement_id===a.agreement_id && p.billing_agreement_id===a.agreement_id),
    states: rows.map(({identity:a,history:h,plan:p,agreement:b}) => ({
      cohort:a.kind,historyStatus:h?.status,paymentStatus:h?.payment_status,
      planStatus:p?.status,agreementStatus:b?.status,
      start:h?.term_start_date,end:h?.term_end_date,renewal:h?.membership_renewal_date,
      held:!!p?.collection_stopped_at,releaseRequired:p?.metadata?.bnms_release_required,
    })),
    writes: 0, providerRequests: 0,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  await file.writeFile(JSON.stringify({summary,sha256,rows},null,2));
  await client.query('ROLLBACK');
  console.log(JSON.stringify({...summary,states:undefined,sha256}));
} catch (error) {
  await client?.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({error:'Read-only recognition preflight failed',code:error.code,writes:0}));
  process.exitCode=1;
} finally {
  await file.close();
  await client?.end();
}
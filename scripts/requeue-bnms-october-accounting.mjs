// Accounting queue only. Never calls GoCardless, Xero, or a webhook.
// Default is a read-only audit. Apply ONLY after the recovery code is deployed.
import { connectDestination } from './lib/member-index-destination.mjs';
import { bnmsOctoberRecovery } from '../api/_lib/accountingBnmsOctoberRecovery.js';

const apply = process.argv.includes('--apply');
if (apply && !process.argv.includes('--deployed-recovery-confirmed')) {
  throw new Error('Verify the production recovery deployment before releasing requests');
}
const db = await connectDestination();
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  const { rows } = await db.query(`
    SELECT q.* FROM public.accounting_request_queue q
    WHERE tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'
      AND source_type='gocardless_payment' AND provider='xero'
      AND state='review' AND preparation_status='pending'
      AND invoice_status='pending' AND payment_status='pending' AND link_status='pending'
      AND invoice_result IS NULL AND payment_result IS NULL AND link_result IS NULL
      AND resolved_snapshot IS NULL AND lease_token IS NULL
      AND last_error='ACCOUNTING_PREPARATION_NOT_COMPLETED'
    ${apply ? 'FOR UPDATE' : ''}
  `);
  const eligible = [], held = {};
  for (const row of rows) {
    try {
      const recovery = bnmsOctoberRecovery(row);
      if (!recovery) throw Object.assign(new Error(), { code: 'NOT_IMPORTED_OCTOBER' });
      // Prefix comes exclusively from the module's fixed allowlist.
      const { rows: operations } = await db.query(
        `SELECT id FROM public.${recovery.prefix}_invoice_operations WHERE tenant_id=$1 AND payment_id=$2`,
        [row.tenant_id, recovery.payment.gocardless_payment_id]);
      if (operations.length) throw Object.assign(new Error(), { code: 'PRIOR_OPERATION' });
      eligible.push(row.id);
    } catch (error) {
      const code = error.code || 'CHECK_FAILED';
      held[code] = (held[code] || 0) + 1;
    }
  }
  let released = 0;
  if (apply && eligible.length) {
    const result = await db.query(`
      UPDATE public.accounting_request_queue SET state='pending',next_attempt_at=now(),
        last_error=NULL,updated_at=now()
      WHERE id=ANY($1::uuid[]) AND state='review' RETURNING id
    `, [eligible]);
    if (result.rowCount !== eligible.length) throw new Error('Release count changed; rolling back');
    released = result.rowCount;
  }
  await db.query('COMMIT');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'read-only', eligible: eligible.length, held, released }));
} catch {
  await db.query('ROLLBACK');
  console.error('Recovery preflight/release failed; no transaction committed. Investigate without printing private rows.');
  process.exitCode = 1;
} finally {
  await db.end();
}

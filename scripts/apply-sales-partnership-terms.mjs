import { readFileSync } from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { PARTNERSHIP_TERMS_HTML } from '../client/src/components/sales/partnershipTerms.js';
import { sanitizeAgreementHtml } from '../api/_lib/salesAgreementHtml.js';

const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const migration = '202610180005_sales_partnership_terms.sql';
const db = await connectDestination();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  const exists = (await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='sales_settings' AND column_name='partnership_terms_html') AS installed`)).rows[0].installed;
  const tenant = (await db.query('SELECT name FROM public.tenant WHERE id=$1', [tenantId])).rows[0];
  if (tenant?.name !== 'Graduate Futures Institute') throw new Error('Expected GFI tenant not found');
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ target: 'DEST', migration, installed: exists, seedOnFirstInstall: !exists }));
    await db.query('ROLLBACK');
  } else {
    await db.query(readFileSync(`supabase/migrations/${migration}`, 'utf8').replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
    // Seed only the newly introduced column. A saved empty template is an
    // intentional choice and must never be restored by replaying this runner.
    if (!exists) {
      const version = (await db.query('SELECT version FROM public.sales_settings WHERE tenant_id=$1 FOR UPDATE', [tenantId])).rows[0]?.version ?? 1;
      await db.query("SET LOCAL request.jwt.claim.role='service_role'");
      await db.query('SELECT public.patch_sales_settings($1,$2,$3,$4,$5)', [
        tenantId, version, { partnershipTermsHtml: sanitizeAgreementHtml(PARTNERSHIP_TERMS_HTML) },
        'partnership-terms-initialization', 'system',
      ]);
    }
    const row = (await db.query('SELECT partnership_terms_html,version FROM public.sales_settings WHERE tenant_id=$1', [tenantId])).rows[0];
    if (!exists && row?.partnership_terms_html !== sanitizeAgreementHtml(PARTNERSHIP_TERMS_HTML)) throw new Error('GFI template verification failed');
    await db.query("NOTIFY pgrst,'reload schema'");
    await db.query('COMMIT');
    console.log(JSON.stringify({ applied: migration, target: 'DEST', gfiSeeded: !exists, version: row?.version }));
  }
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}

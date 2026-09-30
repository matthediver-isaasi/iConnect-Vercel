#!/usr/bin/env node
// Candidate inventory only. No application path until the dated mapping is reviewed.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { TENANT } from './audit-bnms-non-dd-pilot.mjs';

const TYPES = new Set([
  'Full Membership Overseas', 'Full Membership UK',
  'Associate Membership Overseas', 'Associate Membership UK',
  'Junior Membership Overseas', 'Junior Membership UK',
  'Trainee Membership UK', 'Retired Membership', 'Student Membership', 'Honorary Membership',
]);
export function legacyExpiry(value) {
  // Import source contracts: four-digit years are UK dates; two-digit years
  // are the pinned individual workbook's m/d/yy. Do not use Date.parse().
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(value || '');
  if (!match) return null;
  const [, a, b, year] = match;
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  const month = Number(year.length === 2 ? a : b), day = Number(year.length === 2 ? b : a);
  const date = new Date(Date.UTC(y, month - 1, day));
  return date.getUTCFullYear() === y && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null;
}
export function classify(row) {
  if (row.duplicate_fields) return 'conflicting_preferences';
  if (row.dd_evidence || row.preferences.direct_debit_payment === 'true'
    || /\bDD\b/i.test(row.preferences.ym_membership_type || '')) return 'direct_debit_excluded';
  if (row.history_count) return 'existing_history_excluded';
  if (row.preferences.membership_status !== 'Active'
    || !TYPES.has(row.preferences.ym_membership_type)) return 'outside_membership_cohort';
  if (!row.preferences.ym_web_site_member_id || !row.preferences.member_class) return 'missing_identity_or_class';
  if (!legacyExpiry(row.preferences.ym_date_membership_expires)) return 'missing_or_invalid_expiry';
  return 'requires_term_and_invoice_review';
}

export async function inventory() {
  const db = await destinationConnection();
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tenant = (await db.query('SELECT id,slug FROM tenant WHERE id=$1', [TENANT])).rows;
    if (tenant.length !== 1 || tenant[0].slug !== 'bnms') throw Error('BNMS identity mismatch');
    const rows = (await db.query(`
      WITH prefs AS (
        SELECT v.member_id,jsonb_object_agg(f.name,v.value) preferences,
          count(*)<>count(DISTINCT f.name) duplicate_fields
        FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
        WHERE f.tenant_id=$1 AND f.name IN ('ym_web_site_member_id','membership_status',
          'ym_date_membership_expires','ym_membership_type','member_class','direct_debit_payment')
        GROUP BY v.member_id
      ), dd AS (
        SELECT member_id FROM bnms_dd_alpha_adoption WHERE tenant_id=$1
        UNION SELECT member_id FROM bnms_dd_beta_adoption WHERE tenant_id=$1
        UNION SELECT member_id FROM bnms_dd_pilot_import WHERE tenant_id=$1
        UNION SELECT member_id FROM bnms_dd_historical_payment WHERE tenant_id=$1
        UNION SELECT m.id FROM member m JOIN membership_billing_agreements a ON a.tenant_id=m.tenant_id
          AND (a.member_id=m.id OR a.primary_contact_member_id=m.id OR a.organization_id=m.organization_id)
          WHERE m.tenant_id=$1 AND (a.provider='gocardless' OR a.gocardless_mandate_id IS NOT NULL
            OR a.gocardless_customer_id IS NOT NULL OR a.metadata ? 'dd')
        UNION SELECT m.id FROM member m JOIN membership_payment_plans p ON p.tenant_id=m.tenant_id
          AND (p.member_id=m.id OR p.organization_id=m.organization_id)
          WHERE m.tenant_id=$1 AND (p.provider='gocardless' OR p.gocardless_mandate_id IS NOT NULL
            OR p.gocardless_subscription_id IS NOT NULL)
        UNION SELECT m.id FROM member m JOIN gocardless_customers c ON c.tenant_id=m.tenant_id
          AND (c.member_id=m.id OR c.organization_id=m.organization_id
            OR lower(trim(c.email))=lower(trim(m.email)))
          WHERE m.tenant_id=$1
        UNION SELECT m.id FROM member m JOIN gocardless_mandate_discovery_row d ON d.tenant_id=m.tenant_id
          AND (d.matched_member_id=m.id OR d.normalized_email=lower(trim(m.email)))
          WHERE m.tenant_id=$1
        UNION SELECT member_id FROM member_membership_history WHERE tenant_id=$1
          AND payment_method IN ('direct_debit','gocardless')
      )
      SELECT m.id,md5(lower(trim(m.email))) email_hash,coalesce(p.preferences,'{}') preferences,coalesce(p.duplicate_fields,false) duplicate_fields,
        EXISTS(SELECT 1 FROM dd WHERE dd.member_id=m.id) dd_evidence,
        (SELECT count(*)::int FROM member_membership_history h WHERE h.tenant_id=$1 AND h.member_id=m.id) history_count
      FROM member m LEFT JOIN prefs p ON p.member_id=m.id WHERE m.tenant_id=$1 ORDER BY m.id`, [TENANT])).rows;
    const candidates = rows.map(row => ({
      ...row, category: classify(row), expiry: legacyExpiry(row.preferences.ym_date_membership_expires),
    }));
    const totals = {};
    for (const row of candidates) totals[row.category] = (totals[row.category] || 0) + 1;
    const sourceHash = createHash('sha256').update(JSON.stringify(candidates)).digest('hex');
    return { version: 1, tenant: tenant[0], sourceHash, total: candidates.length, totals,
      candidates, writes: 0, approved: false,
      authority: 'User confirmed paid assumption for membership establishment; not provider settlement evidence' };
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw Error('Read-only inventory accepts no arguments');
  const { candidates, ...summary } = await inventory();
  const classes = {};
  for (const row of candidates.filter(r => r.category === 'requires_term_and_invoice_review')) {
    const type = row.preferences.ym_membership_type;
    classes[type] = (classes[type] || 0) + 1;
  }
  console.log(JSON.stringify({ ...summary, classes }, null, 2));
}
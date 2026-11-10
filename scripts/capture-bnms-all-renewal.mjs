// Explicit production opt-in. SELECT-only repeatable-read capture, never provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const DIR = 'generated-artifacts/bnms-all-renewal';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tablesWanted = [
  'member', 'organization', 'role', 'preference_field', 'member_preference_value', 'form',
  'member_membership_history', 'organisation_membership_history',
  'membership_billing_agreements', 'membership_payment_plans', 'membership_tier_config',
  'membership_tier_band', 'membership_tier_discount', 'membership_tier_vat_override',
  'membership_expiry_policy_assignment', 'membership_successor_election', 'membership_payment_quote',
  'membership_successor_rollout', 'membership_successor_tenant_rollout',
  'membership_post_grace_policy', 'membership_post_grace_renewal', 'membership_post_grace_funding_evidence',
  'membership_renewal_journey', 'membership_joining_journey',
  'member_membership_amendment', 'member_membership_amendment_application',
  'member_membership_amendment_settlement', 'member_amendment_provider_operation',
  'membership_monthly_arrears_period', 'membership_monthly_arrears_accounting',
  'membership_monthly_collection_intent', 'membership_instalment_invoices',
  'member_membership_invoicing', 'organisation_membership_invoicing',
  'member_membership_override', 'organisation_membership_override',
  'membership_fee_token', 'membership_voucher_settlement', 'membership_voucher_collection',
  'membership_payment_term_claim', 'membership_payment_status_history',
  'gocardless_payments', 'gocardless_collection_reservations', 'gocardless_mandates',
  'gocardless_refunds', 'gocardless_dynamic_term_completions', 'payment_webhook_events',
  'historical_member_invoice', 'membership_reminder_accounting',
  'bnms_dd_alpha_membership_recognition', 'bnms_membership_recognition_beta_pilot',
  'bnms_dd_manual_membership_recognition', 'bnms_dd_pilot_adoption',
  'bnms_dd_alpha_adoption', 'bnms_dd_beta_adoption', 'bnms_dd_manual_adoption',
  'bnms_dd_historical_payment', 'bnms_dd_alpha_provider_history', 'bnms_dd_beta_provider_history',
  'bnms_dd_alpha_invoice_link', 'bnms_dd_beta_invoice_link',
];
const memberColumns = 'id tenant_id organization_id role_id status is_guest is_sample login_enabled membership_paused membership_cancelled created_on'.split(' ');
const minimal = {
  member: memberColumns,
  organization: ['id', 'tenant_id', 'status', 'is_sample'],
  role: ['id', 'tenant_id', 'name', 'is_admin'],
  form: ['id', 'tenant_id', 'slug', 'form_type', 'is_active', 'require_authentication'],
  preference_field: ['id', 'tenant_id', 'name', 'entity_scope'],
  payment_webhook_events: ['id', 'tenant_id', 'provider', 'event_id', 'resource_type', 'resource_id', 'action', 'processing_status', 'received_at', 'processed_at'],
};
// Remove bearer material and contact details before serialization, including nested snapshots.
const sensitive = /password|secret|(^|_)token($|_)|email|phone|address|redirect_url|authorization_url|online_invoice_url|billing_contact|recipient|first_name|last_name|client_secret/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !sensitive.test(k)).map(([k,v]) => [k, redact(v)]));
}
async function main() {
  assert.deepEqual(process.argv.slice(2), ['--read-only-dest']);
  assert(isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL));
  assert(execFileSync('git', ['check-ignore', `${DIR}/snapshot.json`], { encoding:'utf8' }).trim());
  assert.equal(execFileSync('git', ['ls-files', DIR], { encoding:'utf8' }).trim(), '');
  await fs.mkdir(DIR, { recursive:true, mode:0o700 });
  const db = await connectDestination();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='30s'");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const meta = (await db.query(`SELECT current_setting('transaction_read_only') read_only,
      current_setting('transaction_isolation') isolation, transaction_timestamp()::text as_of,
      txid_current_snapshot()::text snapshot, current_database() database`)).rows[0];
    assert.equal(meta.read_only, 'on'); assert.equal(meta.isolation, 'repeatable read');
    const tenant = (await db.query('SELECT id,slug,name FROM public.tenant WHERE id=$1', [TENANT])).rows;
    assert.equal(tenant.length, 1); assert.equal(tenant[0].slug, 'bnms');
    const columns = (await db.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`, [tablesWanted])).rows;
    const schema = {};
    for (const c of columns) (schema[c.table_name] ??= []).push(c.column_name);
    const tables = {}, completeness = {}, unavailable = [];
    for (const table of tablesWanted) {
      const cols = schema[table];
      if (!cols) { unavailable.push(table); continue; }
      assert(/^[a-z_]+$/.test(table));
      let where = cols.includes('tenant_id') ? 't.tenant_id=$1' : '';
      let args = where ? [TENANT] : [];
      if (table === 'member') where = `(t.tenant_id=$1 OR (t.tenant_id IS NULL AND EXISTS
        (SELECT 1 FROM public.organization o WHERE o.id=t.organization_id AND o.tenant_id=$1)))`;
      if (table === 'member_preference_value') {
        where = `EXISTS (SELECT 1 FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
          WHERE m.id=t.member_id AND (m.tenant_id=$1 OR (m.tenant_id IS NULL AND o.tenant_id=$1)))
          AND EXISTS (SELECT 1 FROM public.preference_field f WHERE f.id=t.field_id AND f.tenant_id=$1
            AND (f.name IN ('membership_status','member_class','ym_date_membership_expires')
              OR f.id IN (SELECT structure_field_id FROM public.membership_tier_config WHERE tenant_id=$1)))`;
        args = [TENANT];
      }
      assert(where || table === 'membership_successor_rollout', `Unscoped table ${table}`);
      const selected = (minimal[table] || cols.filter(c => !sensitive.test(c) && !['payload','evidence','request','provider_evidence'].includes(c))).filter(c => cols.includes(c));
      let projection = selected.map(c => `t."${c}"`).join(',');
      // Preserve deletion evidence without exporting the identifying address.
      // Member status remains "active" after anonymisation in this application.
      if (table === 'member') projection += `,(coalesce(t.email,'') LIKE 'deleted\\_%@deleted.local' ESCAPE '\\') is_deleted`;
      if (table === 'payment_webhook_events') projection += `,jsonb_build_object(
        'id',t.payload->'id','resource_type',t.payload->'resource_type',
        'action',t.payload->'action','links',t.payload->'links') payload,
        (t.processing_error IS NOT NULL) audit_has_processing_error`;
      const clause = where ? `WHERE ${where}` : '';
      const count = Number((await db.query(`SELECT count(*) n FROM public.${table} t ${clause}`, args)).rows[0].n);
      const rows = [];
      const order = cols.includes('id') ? 't.id' : selected.map(c => `t."${c}"::text`).join(',');
      for (let offset = 0; offset < count; offset += 500) {
        const result = await db.query(`SELECT to_jsonb(q) row FROM
          (SELECT ${projection} FROM public.${table} t ${clause} ORDER BY ${order}
           LIMIT 500 OFFSET $${args.length+1}) q`, [...args, offset]);
        assert(result.rows.length > 0);
        rows.push(...result.rows.map(r => redact(r.row)));
      }
      assert.equal(rows.length, count);
      if (cols.includes('id')) assert.equal(new Set(rows.map(r=>r.id)).size, count);
      tables[table] = rows;
      completeness[table] = { expected:count, captured:rows.length, sha256:hash(rows), columns:selected };
    }
    // Inspect capability definitions, never execute database functions.
    const functions = (await db.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) args,
      pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname,args`,
    [['membership_successor_elections_enabled','post_grace_checkout_ready','form_expiry_only_renewal_supported','form_expiry_only_mapped_renewal_supported']])).rows;
    const grants = (await db.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,
      has_function_privilege('service_role',p.oid,'EXECUTE') executable
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname=ANY($1::text[]) ORDER BY p.proname,args`,
    [['reserve_post_grace_renewal','apply_post_grace_record_dates','sync_post_grace_renewal_method']])).rows;
    await db.query('ROLLBACK');
    const snapshot = { meta:{ ...meta, project:PROJECT, tenant:tenant[0], capturedAt:new Date().toISOString(),
      codeRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), productionWrites:0 },
      completeness, unavailable, functions, grants, tables, snapshotHash:hash(tables) };
    await fs.writeFile(`${DIR}/snapshot.json`, JSON.stringify(snapshot), {mode:0o600});
    console.log(JSON.stringify({meta:snapshot.meta, snapshotHash:snapshot.snapshotHash,
      counts:Object.fromEntries(Object.entries(completeness).map(([k,v])=>[k,v.captured])),unavailable},null,2));
  } finally { await db.query('ROLLBACK').catch(()=>{}); await db.end(); }
}
if (process.argv[1]?.endsWith('/capture-bnms-all-renewal.mjs')) main().catch(e => {
  console.error(`Capture failed (${e.code || e.name}); no output published.`); process.exitCode=1;
});

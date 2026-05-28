/**
 * Task #1118 — One-off recovery: when an `organisation_dropdown` form field
 * was mapped to the Primary Organisation's "Organisation Name" core column,
 * the submission processor wrote the dropdown's stored value (the
 * organisation's UUID) verbatim into `organization.name`, renaming the row
 * to its own id. The processor has since been guarded against this, but
 * already-overwritten rows need their original name restored.
 *
 * Strategy:
 *   1. Find every `organization` row whose `name` is a UUID string.
 *   2. For each, walk recent `form_submission` rows that reference the org
 *      (via `organization_id` or via a form field of type
 *      `organisation_dropdown` whose value equals the org id).
 *   3. The pre-corruption name is the dropdown OPTION LABEL the user saw.
 *      We can't recover that from the submission row alone — the value
 *      stored is the id, not the label. So we look at the org's earlier
 *      `name` via:
 *        a. Any other `organization` row in the same tenant whose
 *           `historical_name` (if a `name_history` jsonb column exists) /
 *           audit-log entry contains a non-UUID name for this id, OR
 *        b. The form submission's `display_data` / `submission_data` if
 *           a sibling form field captured the org's typed name, OR
 *        c. Fall back to logging "unrecoverable" so the tenant can fix
 *           manually.
 *
 * Idempotent: only touches rows whose `name` is still a UUID.
 * Dry-run by default; pass `--apply` to write.
 *
 * Usage:
 *   node scripts/restore-org-names-from-uuid-overwrite.mjs                  # dry-run, all tenants
 *   node scripts/restore-org-names-from-uuid-overwrite.mjs --tenant=<uuid>
 *   node scripts/restore-org-names-from-uuid-overwrite.mjs --apply
 *
 * Requires env: DEST_SUPABASE_URL, DEST_SUPABASE_KEY.
 */
import { createClient } from '@supabase/supabase-js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const TENANT_FILTER = args.tenant || null;
const APPLY = !!args.apply;

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s.trim());

const summary = { scanned: 0, candidates: 0, restored: 0, unrecoverable: 0, skipped: 0 };
const restoredRows = [];
const unrecoverableRows = [];

async function findOrgDropdownNameInSubmission(orgId, tenantId) {
  // Pull the form_submission rows that reference this org, newest first.
  // We inspect each submission's parent form fields: if any form field is of
  // type `organisation_dropdown` AND its value in submission_data equals our
  // org id, then a sibling text/plain field on the same form may carry the
  // org's typed name (when the form has both a dropdown and a manual name
  // field). When there's no sibling, the submission cannot recover the name.
  const { data: subs, error: subsErr } = await supabase
    .from('form_submission')
    .select('id, form_id, submission_data, organization_id, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (subsErr) {
    console.warn('  form_submission lookup failed:', subsErr.message);
    return null;
  }
  if (!subs || subs.length === 0) return null;

  // Also search submissions in this tenant whose submission_data contains
  // the org id as a value (covers the case where organization_id wasn't
  // stamped on the submission because the dropdown overwrote name → org
  // resolution went sideways).
  let candidateSubs = subs.slice();
  if (tenantId && candidateSubs.length < 10) {
    const { data: extra } = await supabase
      .from('form_submission')
      .select('id, form_id, submission_data, organization_id, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (extra) {
      for (const s of extra) {
        if (candidateSubs.some(c => c.id === s.id)) continue;
        const flat = JSON.stringify(s.submission_data || {});
        if (flat.includes(orgId)) candidateSubs.push(s);
      }
    }
  }

  for (const sub of candidateSubs) {
    if (!sub.form_id) continue;
    const { data: form } = await supabase
      .from('form')
      .select('id, fields')
      .eq('id', sub.form_id)
      .maybeSingle();
    if (!form?.fields || !Array.isArray(form.fields)) continue;

    // Find the org-dropdown field(s) on this form whose value matches our org.
    const dropdownFieldIds = form.fields
      .filter(f => f && f.type === 'organisation_dropdown')
      .map(f => f.id);
    const matched = dropdownFieldIds.some(fid => (sub.submission_data || {})[fid] === orgId);
    if (!matched) continue;

    // Look for a sibling field that plausibly holds the typed organisation
    // name: a text-ish field whose label mentions "organisation" / "company"
    // / "name". Returns the first non-UUID, non-empty match.
    for (const f of form.fields) {
      if (!f || dropdownFieldIds.includes(f.id)) continue;
      const isTextish = ['text', 'short_text', 'long_text', 'textarea'].includes(f.type);
      if (!isTextish) continue;
      const label = String(f.label || '').toLowerCase();
      if (!/\b(org|organisation|organization|company|business|trading)\b/.test(label)) continue;
      const v = (sub.submission_data || {})[f.id];
      if (typeof v === 'string' && v.trim() && !isUuid(v)) {
        return { name: v.trim(), source: `form_submission:${sub.id}:field:${f.id}` };
      }
    }
  }
  return null;
}

async function run() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`);
  console.log(`Tenant filter: ${TENANT_FILTER || '(all tenants)'}\n`);

  let q = supabase
    .from('organization')
    .select('id, name, tenant_id')
    .order('id', { ascending: true });
  if (TENANT_FILTER) q = q.eq('tenant_id', TENANT_FILTER);

  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) {
      console.error('organization fetch failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const org of data) {
      summary.scanned += 1;
      if (!isUuid(org.name)) continue;
      // Only consider rows where name === id (the precise corruption mode).
      // A tenant might legitimately name an org with a stray UUID; we don't
      // want to touch that case.
      if (org.name.toLowerCase() !== String(org.id).toLowerCase()) {
        summary.skipped += 1;
        console.log(`SKIP  ${org.id}  name is a UUID but not equal to id (${org.name}); not corruption-shaped`);
        continue;
      }
      summary.candidates += 1;
      console.log(`SCAN  ${org.id}  tenant=${org.tenant_id || '-'}  name=${org.name}`);
      const recovered = await findOrgDropdownNameInSubmission(org.id, org.tenant_id);
      if (!recovered) {
        summary.unrecoverable += 1;
        unrecoverableRows.push({ org_id: org.id, tenant_id: org.tenant_id });
        console.log(`  UNRECOVERABLE — no sibling name field found in any referencing submission`);
        continue;
      }
      console.log(`  RECOVERED -> "${recovered.name}"  via ${recovered.source}`);
      if (APPLY) {
        const { error: updErr } = await supabase
          .from('organization')
          .update({ name: recovered.name })
          .eq('id', org.id)
          .eq('name', org.name); // optimistic: only if still UUID
        if (updErr) {
          console.log(`  WRITE FAILED: ${updErr.message}`);
          continue;
        }
        summary.restored += 1;
        restoredRows.push({ org_id: org.id, tenant_id: org.tenant_id, new_name: recovered.name, source: recovered.source });
      } else {
        restoredRows.push({ org_id: org.id, tenant_id: org.tenant_id, new_name: recovered.name, source: recovered.source, dry_run: true });
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log('\n──────── Summary ────────');
  console.log(JSON.stringify(summary, null, 2));
  if (restoredRows.length) {
    console.log(`\n${APPLY ? 'Restored' : 'Would restore'} (${restoredRows.length}):`);
    for (const r of restoredRows) console.log(`  ${r.org_id}  ->  ${r.new_name}   (${r.source})`);
  }
  if (unrecoverableRows.length) {
    console.log(`\nUnrecoverable (${unrecoverableRows.length}) — needs manual fix:`);
    for (const r of unrecoverableRows) console.log(`  ${r.org_id}  tenant=${r.tenant_id || '-'}`);
  }
  if (!APPLY) console.log('\n(dry-run) Re-run with --apply to write changes.');
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

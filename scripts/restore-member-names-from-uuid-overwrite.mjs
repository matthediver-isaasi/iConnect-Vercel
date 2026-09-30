/**
 * Task #1119 — One-off recovery: when a `member_dropdown` form field was
 * mapped to the Primary Member pipeline's "Email" / "Full Name" /
 * "First Name" / "Last Name" core column, the submission processor wrote
 * the dropdown's stored value (the member's UUID) verbatim into
 * `member.email` / `member.first_name` / `member.last_name`, renaming the
 * row to its own id. The processor has since been guarded against this,
 * but already-overwritten rows need their original values restored.
 *
 * Strategy:
 *   1. Find every `member` row where `email`, `first_name`, or `last_name`
 *      is a UUID string equal to the row's own id (the precise corruption
 *      shape — a tenant might legitimately have other UUID-looking text).
 *   2. For each, walk recent `form_submission` rows that reference the
 *      member id either via a `member_dropdown` form field whose value
 *      equals the member id, or via submission_data containing the id.
 *   3. Look for sibling text-ish form fields whose label mentions a
 *      relevant column (name / first / last / email) that hold a non-UUID
 *      typed value; use that as the recovered value.
 *   4. If nothing usable is found, log "unrecoverable" so the tenant can
 *      fix manually.
 *
 * Idempotent: only touches columns whose value is still a UUID equal to
 * the member id.
 * Dry-run by default; pass `--apply` to write.
 *
 * Usage:
 *   node scripts/restore-member-names-from-uuid-overwrite.mjs                  # dry-run, all tenants
 *   node scripts/restore-member-names-from-uuid-overwrite.mjs --tenant=<uuid>
 *   node scripts/restore-member-names-from-uuid-overwrite.mjs --apply
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

const summary = { scanned: 0, candidates: 0, restored: 0, partial: 0, unrecoverable: 0, skipped: 0 };
const restoredRows = [];
const unrecoverableRows = [];

// Label patterns identifying which submission text field plausibly carries
// the typed value for each member core column. Conservative — these only
// fire when both the dropdown and a sibling typed field exist on the form.
const FIELD_HINTS = {
  email: /\b(e[-\s]?mail)\b/,
  first_name: /\b(first[\s_-]?name|given[\s_-]?name|forename)\b/,
  last_name: /\b(last[\s_-]?name|surname|family[\s_-]?name)\b/,
  full_name:  /\b(full[\s_-]?name|name)\b/,
};

async function findMemberDropdownValuesInSubmission(memberId, tenantId) {
  // Pull form_submission rows that reference this member, newest first.
  // We can't rely on a member_id column on form_submission, so we widen
  // by scanning recent tenant submissions and matching by submission_data.
  let candidateSubs = [];
  if (tenantId) {
    const { data: extra } = await supabase
      .from('form_submission')
      .select('id, form_id, submission_data, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (extra) {
      for (const s of extra) {
        const flat = JSON.stringify(s.submission_data || {});
        if (flat.includes(memberId)) candidateSubs.push(s);
      }
    }
  }
  if (candidateSubs.length === 0) return null;

  const recovered = {}; // column -> { value, source }

  for (const sub of candidateSubs) {
    if (!sub.form_id) continue;
    const { data: form } = await supabase
      .from('form')
      .select('id, fields')
      .eq('id', sub.form_id)
      .maybeSingle();
    if (!form?.fields || !Array.isArray(form.fields)) continue;

    const dropdownFieldIds = form.fields
      .filter(f => f && f.type === 'member_dropdown')
      .map(f => f.id);
    const matched = dropdownFieldIds.some(fid => (sub.submission_data || {})[fid] === memberId);
    if (!matched) continue;

    for (const f of form.fields) {
      if (!f || dropdownFieldIds.includes(f.id)) continue;
      const isTextish = ['text', 'short_text', 'long_text', 'textarea', 'email'].includes(f.type);
      if (!isTextish) continue;
      const label = String(f.label || '').toLowerCase();
      const v = (sub.submission_data || {})[f.id];
      if (typeof v !== 'string' || !v.trim() || isUuid(v)) continue;

      if (!recovered.email && FIELD_HINTS.email.test(label)) {
        recovered.email = { value: v.trim(), source: `form_submission:${sub.id}:field:${f.id}` };
      }
      if (!recovered.first_name && FIELD_HINTS.first_name.test(label)) {
        recovered.first_name = { value: v.trim(), source: `form_submission:${sub.id}:field:${f.id}` };
      }
      if (!recovered.last_name && FIELD_HINTS.last_name.test(label)) {
        recovered.last_name = { value: v.trim(), source: `form_submission:${sub.id}:field:${f.id}` };
      }
      // Full name fallback splits into first / last only if those weren't
      // separately recovered already.
      if (!recovered.first_name && !recovered.last_name && FIELD_HINTS.full_name.test(label)) {
        const parts = v.trim().split(/\s+/);
        recovered.first_name = { value: parts[0] || '', source: `form_submission:${sub.id}:field:${f.id}:fullname_split` };
        if (parts.length > 1) {
          recovered.last_name = { value: parts.slice(1).join(' '), source: `form_submission:${sub.id}:field:${f.id}:fullname_split` };
        }
      }
    }
  }

  return Object.keys(recovered).length ? recovered : null;
}

async function run() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`);
  console.log(`Tenant filter: ${TENANT_FILTER || '(all tenants)'}\n`);

  let q = supabase
    .from('member')
    .select('id, email, first_name, last_name, tenant_id')
    .order('id', { ascending: true });
  if (TENANT_FILTER) q = q.eq('tenant_id', TENANT_FILTER);

  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) {
      console.error('member fetch failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const m of data) {
      summary.scanned += 1;

      const idLower = String(m.id).toLowerCase();
      const corrupted = {};
      for (const col of ['email', 'first_name', 'last_name']) {
        const v = m[col];
        if (typeof v === 'string' && isUuid(v) && v.toLowerCase() === idLower) {
          corrupted[col] = v;
        }
      }
      if (Object.keys(corrupted).length === 0) continue;

      summary.candidates += 1;
      console.log(`SCAN  ${m.id}  tenant=${m.tenant_id || '-'}  corrupted=[${Object.keys(corrupted).join(',')}]`);

      const recovered = await findMemberDropdownValuesInSubmission(m.id, m.tenant_id);
      if (!recovered) {
        summary.unrecoverable += 1;
        unrecoverableRows.push({ member_id: m.id, tenant_id: m.tenant_id, corrupted_cols: Object.keys(corrupted) });
        console.log(`  UNRECOVERABLE — no sibling typed fields found in any referencing submission`);
        continue;
      }

      const updatePatch = {};
      const sources = {};
      for (const col of Object.keys(corrupted)) {
        if (recovered[col]) {
          updatePatch[col] = recovered[col].value;
          sources[col] = recovered[col].source;
        }
      }

      if (Object.keys(updatePatch).length === 0) {
        summary.unrecoverable += 1;
        unrecoverableRows.push({ member_id: m.id, tenant_id: m.tenant_id, corrupted_cols: Object.keys(corrupted) });
        console.log(`  UNRECOVERABLE — sibling fields found but none for the corrupted columns`);
        continue;
      }

      const fullyRecovered = Object.keys(updatePatch).length === Object.keys(corrupted).length;
      console.log(`  ${fullyRecovered ? 'RECOVERED' : 'PARTIAL  '} -> ${JSON.stringify(updatePatch)}`);

      if (APPLY) {
        // Optimistic: build a query that only updates if each targeted
        // column still holds the corrupted UUID (so we don't clobber a
        // value a human already fixed by hand between scan and write).
        let updateQuery = supabase.from('member').update(updatePatch).eq('id', m.id);
        for (const col of Object.keys(updatePatch)) {
          updateQuery = updateQuery.eq(col, corrupted[col]);
        }
        const { error: updErr } = await updateQuery;
        if (updErr) {
          console.log(`  WRITE FAILED: ${updErr.message}`);
          continue;
        }
        if (fullyRecovered) summary.restored += 1; else summary.partial += 1;
        restoredRows.push({ member_id: m.id, tenant_id: m.tenant_id, patch: updatePatch, sources });
      } else {
        if (fullyRecovered) summary.restored += 1; else summary.partial += 1;
        restoredRows.push({ member_id: m.id, tenant_id: m.tenant_id, patch: updatePatch, sources, dry_run: true });
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log('\n──────── Summary ────────');
  console.log(JSON.stringify(summary, null, 2));
  if (restoredRows.length) {
    console.log(`\n${APPLY ? 'Restored' : 'Would restore'} (${restoredRows.length}):`);
    for (const r of restoredRows) {
      console.log(`  ${r.member_id}  ->  ${JSON.stringify(r.patch)}   sources=${JSON.stringify(r.sources)}`);
    }
  }
  if (unrecoverableRows.length) {
    console.log(`\nUnrecoverable (${unrecoverableRows.length}) — needs manual fix:`);
    for (const r of unrecoverableRows) console.log(`  ${r.member_id}  tenant=${r.tenant_id || '-'}  cols=[${r.corrupted_cols.join(',')}]`);
  }
  if (!APPLY) console.log('\n(dry-run) Re-run with --apply to write changes.');
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

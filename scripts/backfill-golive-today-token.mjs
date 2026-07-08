// Backfill literal "{today}" go_live values for the GSF tenant.
//
// Six GSF organisations have the literal string "{today}" stored in their
// go_live organisational custom field (organization_preference_value) instead
// of a date. The writes came from staff DD approvals served by a stale build
// that predated the {today} token resolver. This script:
//   1. Finds every organization_preference_value row for the pinned go_live
//      field whose value is the literal "{today}" token (trim/lowercase match).
//   2. Resolves the correct date from the linked DD application's history_log
//      (nearest `field_mapping_executed` entry for that organisation to the
//      pref row's created_at; fallback: the pref row's own created_at date).
//   3. Updates the value to the resolved UTC YYYY-MM-DD date.
//   4. Verifies the 3 other pre-existing (non-import) rows against their
//      approval history and reports any divergence beyond a day boundary
//      (report only — does not rewrite them).
//
// Idempotent: once no row contains "{today}", re-runs are a no-op.
// Dry-run by default; pass --apply to write.
//
// Usage:
//   node scripts/backfill-golive-today-token.mjs            # dry run
//   node scripts/backfill-golive-today-token.mjs --apply    # apply updates
//
// Hard-pinned scope: gsf tenant + go_live field id below. Other tenants and
// other fields are never touched.

import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501'; // gsf
const GO_LIVE_FIELD_ID = '7e4cb8fd-7d7a-4fa9-814a-67ebb054cd0e'; // go_live

// Pre-existing non-import rows to verify (report-only), org_id -> expected approval window.
const VERIFY_ONLY_ORG_IDS = [
  '073ac6e7-8218-4699-8b47-3d8b6313859d',
  '7a02c546-216a-4c2b-ba79-5da0eb11e977',
  'd8192738-59a3-4bac-8123-de9fd516dd8c',
];

const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

function toUtcDateString(dateLike) {
  const d = new Date(dateLike);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isLiteralTodayToken(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === '{today}';
}

// Fetch all field_mapping_executed history entries for an organisation,
// across every DD application linked to it via form_submission.organization_id.
async function fetchFieldMappingEvents(orgId) {
  const { data: subs, error: subErr } = await supabase
    .from('form_submission')
    .select('id')
    .eq('organization_id', orgId);
  if (subErr) throw new Error(`form_submission lookup failed for org ${orgId}: ${subErr.message}`);
  if (!subs || subs.length === 0) return [];

  const { data: dds, error: ddErr } = await supabase
    .from('form_submission_due_diligence')
    .select('id, form_submission_id, history_log')
    .in('form_submission_id', subs.map((s) => s.id));
  if (ddErr) throw new Error(`DD lookup failed for org ${orgId}: ${ddErr.message}`);

  const events = [];
  for (const dd of dds || []) {
    const log = Array.isArray(dd.history_log) ? dd.history_log : [];
    for (const entry of log) {
      if (
        entry?.event_type === 'field_mapping_executed' &&
        entry?.details?.organization_id === orgId &&
        entry?.timestamp
      ) {
        events.push(entry);
      }
    }
  }
  return events;
}

// Resolve the approval date for a pref row: nearest field_mapping_executed
// entry (by absolute time distance to the row's created_at), fallback to the
// row's own created_at date.
async function resolveApprovalDate(orgId, rowCreatedAt) {
  const events = await fetchFieldMappingEvents(orgId);
  const rowMs = new Date(rowCreatedAt).getTime();
  let best = null;
  let bestDelta = Infinity;
  for (const ev of events) {
    const delta = Math.abs(new Date(ev.timestamp).getTime() - rowMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = ev;
    }
  }
  if (best) {
    return { date: toUtcDateString(best.timestamp), source: 'history_log', deltaMs: bestDelta };
  }
  return { date: toUtcDateString(rowCreatedAt), source: 'row_created_at_fallback', deltaMs: null };
}

async function run() {
  console.log('=== Backfill literal {today} go_live values (gsf) ===');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Field:  ${GO_LIVE_FIELD_ID}\n`);

  // Sanity: the field belongs to the pinned tenant.
  const { data: field, error: fieldErr } = await supabase
    .from('preference_field')
    .select('id, tenant_id, name, label')
    .eq('id', GO_LIVE_FIELD_ID)
    .single();
  if (fieldErr || !field) {
    console.error('Could not load go_live preference_field:', fieldErr?.message);
    process.exit(1);
  }
  if (field.tenant_id !== TENANT_ID) {
    console.error(`Field tenant mismatch: expected ${TENANT_ID}, got ${field.tenant_id}. Aborting.`);
    process.exit(1);
  }
  console.log(`Field OK: "${field.label || field.name}" (tenant verified)\n`);

  const { data: rows, error: rowsErr } = await supabase
    .from('organization_preference_value')
    .select('id, organization_id, value, created_at')
    .eq('field_id', GO_LIVE_FIELD_ID);
  if (rowsErr) {
    console.error('Error fetching go_live rows:', rowsErr.message);
    process.exit(1);
  }
  console.log(`Total go_live rows: ${rows.length}`);

  const badRows = rows.filter((r) => isLiteralTodayToken(r.value));
  console.log(`Rows with literal {today}: ${badRows.length}\n`);

  // Org names for readable output.
  const orgIdsOfInterest = [...new Set([...badRows.map((r) => r.organization_id), ...VERIFY_ONLY_ORG_IDS])];
  const orgNames = {};
  if (orgIdsOfInterest.length > 0) {
    const { data: orgs } = await supabase
      .from('organization')
      .select('id, name, tenant_id')
      .in('id', orgIdsOfInterest);
    for (const o of orgs || []) {
      orgNames[o.id] = o.name;
      if (o.tenant_id !== TENANT_ID) {
        console.error(`Org ${o.id} (${o.name}) belongs to tenant ${o.tenant_id}, not ${TENANT_ID}. Aborting.`);
        process.exit(1);
      }
    }
  }

  // --- Fix the literal {today} rows ---
  let applied = 0;
  for (const row of badRows) {
    const orgLabel = orgNames[row.organization_id] || row.organization_id;
    const { date, source, deltaMs } = await resolveApprovalDate(row.organization_id, row.created_at);
    const deltaNote = deltaMs === null ? '' : ` (nearest history entry ${Math.round(deltaMs / 1000)}s from row created_at)`;
    console.log(`FIX  ${orgLabel}`);
    console.log(`     row ${row.id} | created_at ${row.created_at}`);
    console.log(`     "{today}" -> "${date}" [${source}]${deltaNote}`);

    if (APPLY) {
      const { error: updErr } = await supabase
        .from('organization_preference_value')
        .update({ value: date })
        .eq('id', row.id)
        .eq('field_id', GO_LIVE_FIELD_ID);
      if (updErr) {
        console.error(`     UPDATE FAILED: ${updErr.message}`);
        process.exit(1);
      }
      applied += 1;
      console.log('     updated.');
    }
    console.log('');
  }

  // --- Verify the 3 other pre-existing rows (report only) ---
  console.log('--- Verification of pre-existing non-import rows (report only) ---');
  for (const orgId of VERIFY_ONLY_ORG_IDS) {
    const orgLabel = orgNames[orgId] || orgId;
    const row = rows.find((r) => r.organization_id === orgId);
    if (!row) {
      console.log(`VERIFY ${orgLabel}: no go_live row found — nothing to check.`);
      continue;
    }
    if (isLiteralTodayToken(row.value)) {
      console.log(`VERIFY ${orgLabel}: row still holds {today} (handled in fix pass above).`);
      continue;
    }
    const events = await fetchFieldMappingEvents(orgId);
    if (events.length === 0) {
      const fallback = toUtcDateString(row.created_at);
      const storedDate = String(row.value).slice(0, 10);
      const deltaDays = Math.abs((new Date(storedDate).getTime() - new Date(fallback).getTime()) / 86400000);
      if (!Number.isNaN(deltaDays) && deltaDays <= 1) {
        console.log(`VERIFY ${orgLabel}: stored "${storedDate}", no field_mapping_executed history; matches row created_at (${fallback}) within day boundary. OK.`);
      } else {
        console.log(`VERIFY ${orgLabel}: stored "${row.value}", no field_mapping_executed history; row created_at ${fallback} — review manually.`);
      }
      continue;
    }
    // Compare against the nearest history entry to the row's created_at.
    const { date: expected } = await resolveApprovalDate(orgId, row.created_at);
    const stored = String(row.value).slice(0, 10);
    const divergenceDays = Math.abs((new Date(stored).getTime() - new Date(expected).getTime()) / 86400000);
    if (Number.isNaN(divergenceDays)) {
      console.log(`VERIFY ${orgLabel}: stored "${row.value}" is not a parseable date (expected ~${expected}) — DIVERGENT, review manually.`);
    } else if (divergenceDays <= 1) {
      console.log(`VERIFY ${orgLabel}: stored "${stored}" matches approval history (${expected}) within day boundary. OK.`);
    } else {
      console.log(`VERIFY ${orgLabel}: stored "${stored}" diverges from approval history (${expected}) by ${divergenceDays} day(s) — review manually.`);
    }
  }
  console.log('');

  // --- Final confirmation query ---
  const { data: recheck, error: recheckErr } = await supabase
    .from('organization_preference_value')
    .select('id, value')
    .eq('field_id', GO_LIVE_FIELD_ID);
  if (recheckErr) {
    console.error('Re-check query failed:', recheckErr.message);
    process.exit(1);
  }
  const remaining = (recheck || []).filter((r) => isLiteralTodayToken(r.value));
  console.log(`Summary: ${badRows.length} literal {today} row(s) found, ${applied} updated${APPLY ? '' : ' (dry run — no writes)'}.`);
  console.log(`Remaining rows with literal {today}: ${remaining.length}`);
  if (APPLY && remaining.length > 0) {
    console.error('ERROR: rows still contain {today} after apply.');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

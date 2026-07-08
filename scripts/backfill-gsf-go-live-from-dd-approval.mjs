#!/usr/bin/env node
/**
 * Backfill: GSF "Go live date" (go_live) from Due Diligence approval dates.
 *
 * Background (Task: Backfill GSF go_live from DD approval dates):
 * In the GSF tenant, 66 organisations have the custom field Status
 * (org_status) = "Active" but no "Go live date" (go_live). For those with a
 * due diligence record, the go-live date is recoverable as the EARLIEST
 * `history_log` event on `form_submission_due_diligence` whose
 * `details.new_status` matches "approved" (case-insensitive).
 *
 * What it does:
 *   1. Finds all GSF orgs with org_status = Active and NO existing go_live
 *      value (existing non-empty values are never touched).
 *   2. Joins their DD records via `form_submission.organization_id` ->
 *      `form_submission_due_diligence.form_submission_id`.
 *   3. Parses each `history_log` (JSONB array of
 *      { timestamp, event_type: 'status_changed', details: { new_status } })
 *      for the earliest transition to "approved", converted to YYYY-MM-DD.
 *   4. Inserts the date into `organization_preference_value`
 *      (organization_id, field_id, value).
 *
 * Idempotent: orgs that already have a non-empty go_live value are skipped,
 * so a re-run is a no-op. Orgs with no recoverable approval date are listed
 * in the summary and left untouched.
 *
 * Usage:
 *   node scripts/backfill-gsf-go-live-from-dd-approval.mjs           # dry-run (default)
 *   node scripts/backfill-gsf-go-live-from-dd-approval.mjs --apply   # write changes
 *
 * Environment Variables Required:
 *   DEST_SUPABASE_URL, DEST_SUPABASE_KEY (service-role) — the direct Postgres
 *   host is unreachable from this workspace; use supabase-js only.
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

// Hard-pinned to the GSF tenant and its field ids.
const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const STATUS_FIELD_ID = '077f1aa6-abdc-4bdc-a6ca-34b93c8726fd'; // org_status
const GO_LIVE_FIELD_ID = '7e4cb8fd-7d7a-4fa9-814a-67ebb054cd0e'; // go_live

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY environment variables.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const PAGE = 1000;

// Fetch every row of a query, paginating past PostgREST's 1000-row cap.
async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Unwrap a preference value that may be stored as a raw string or JSON-encoded.
function unwrapValue(raw) {
  let val = raw;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch { /* raw string, keep as-is */ }
  }
  if (val && typeof val === 'object' && 'value' in val) val = val.value;
  return val == null ? '' : String(val);
}

function isNonEmptyValue(raw) {
  const v = unwrapValue(raw).trim();
  return v !== '' && v.toLowerCase() !== 'null';
}

// Earliest history_log timestamp where the status changed to "approved"
// (case-insensitive). Returns a Date or null.
function earliestApprovalAt(historyLog) {
  if (!Array.isArray(historyLog)) return null;
  let earliest = null;
  for (const entry of historyLog) {
    if (!entry || !entry.timestamp) continue;
    const newStatus = entry.details?.new_status;
    if (typeof newStatus !== 'string') continue;
    if (newStatus.trim().toLowerCase() !== 'approved') continue;
    const t = new Date(entry.timestamp);
    if (Number.isNaN(t.getTime())) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest;
}

async function run() {
  console.log('=== Backfill GSF go_live from DD approval dates ===');
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no changes; pass --apply to write)'}\n`);

  // 1. All orgs in the tenant.
  const orgs = await fetchAll(() =>
    supabase
      .from('organization')
      .select('id, name')
      .eq('tenant_id', TENANT_ID)
      .order('id')
  );
  const orgNameById = new Map(orgs.map((o) => [o.id, o.name]));
  const orgIds = orgs.map((o) => o.id);
  console.log(`Organisations in tenant: ${orgs.length}`);

  // 2. org_status values -> Active orgs.
  const statusRows = [];
  for (const ids of chunk(orgIds, 200)) {
    const rows = await fetchAll(() =>
      supabase
        .from('organization_preference_value')
        .select('organization_id, value')
        .eq('field_id', STATUS_FIELD_ID)
        .in('organization_id', ids)
        .order('organization_id')
    );
    statusRows.push(...rows);
  }
  const activeOrgIds = statusRows
    .filter((r) => unwrapValue(r.value).trim().toLowerCase() === 'active')
    .map((r) => r.organization_id);
  console.log(`Orgs with org_status = Active: ${activeOrgIds.length}`);

  // 3. Existing go_live values among Active orgs.
  const goLiveRows = [];
  for (const ids of chunk(activeOrgIds, 200)) {
    const rows = await fetchAll(() =>
      supabase
        .from('organization_preference_value')
        .select('organization_id, value')
        .eq('field_id', GO_LIVE_FIELD_ID)
        .in('organization_id', ids)
        .order('organization_id')
    );
    goLiveRows.push(...rows);
  }
  const hasGoLive = new Set(
    goLiveRows.filter((r) => isNonEmptyValue(r.value)).map((r) => r.organization_id)
  );
  // Orgs that have a go_live ROW (even empty) need an update rather than insert.
  const hasGoLiveRow = new Set(goLiveRows.map((r) => r.organization_id));

  const candidateOrgIds = activeOrgIds.filter((id) => !hasGoLive.has(id));
  console.log(`Active orgs missing go_live: ${candidateOrgIds.length}`);

  // 4. DD records for candidate orgs via form_submission.
  const submissionRows = [];
  for (const ids of chunk(candidateOrgIds, 200)) {
    const rows = await fetchAll(() =>
      supabase
        .from('form_submission')
        .select('id, organization_id')
        .eq('tenant_id', TENANT_ID)
        .in('organization_id', ids)
        .order('id')
    );
    submissionRows.push(...rows);
  }
  const orgBySubmissionId = new Map(submissionRows.map((s) => [s.id, s.organization_id]));
  const submissionIds = submissionRows.map((s) => s.id);
  console.log(`Form submissions linked to candidate orgs: ${submissionIds.length}`);

  const ddRows = [];
  for (const ids of chunk(submissionIds, 100)) {
    const rows = await fetchAll(() =>
      supabase
        .from('form_submission_due_diligence')
        .select('id, form_submission_id, history_log')
        .eq('tenant_id', TENANT_ID)
        .in('form_submission_id', ids)
        .order('id')
    );
    ddRows.push(...rows);
  }
  console.log(`DD records found: ${ddRows.length}\n`);

  // 5. Earliest approval date per organisation.
  const approvalByOrg = new Map(); // orgId -> Date
  const orgsWithDd = new Set();
  for (const dd of ddRows) {
    const orgId = orgBySubmissionId.get(dd.form_submission_id);
    if (!orgId) continue;
    orgsWithDd.add(orgId);
    const at = earliestApprovalAt(dd.history_log);
    if (!at) continue;
    const existing = approvalByOrg.get(orgId);
    if (!existing || at < existing) approvalByOrg.set(orgId, at);
  }

  const recovered = [];
  const unrecoverableNoDd = [];
  const unrecoverableNoApproval = [];
  for (const orgId of candidateOrgIds) {
    const at = approvalByOrg.get(orgId);
    if (at) {
      recovered.push({ orgId, date: at.toISOString().slice(0, 10) });
    } else if (orgsWithDd.has(orgId)) {
      unrecoverableNoApproval.push(orgId);
    } else {
      unrecoverableNoDd.push(orgId);
    }
  }

  recovered.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`Recovered approval dates: ${recovered.length}`);
  recovered.forEach((r) => console.log(`  ${r.date}  ${orgNameById.get(r.orgId)} (${r.orgId})`));

  console.log(`\nUnrecoverable — no DD record: ${unrecoverableNoDd.length}`);
  unrecoverableNoDd.forEach((id) => console.log(`  - ${orgNameById.get(id)} (${id})`));
  console.log(`Unrecoverable — DD record but no approval event: ${unrecoverableNoApproval.length}`);
  unrecoverableNoApproval.forEach((id) => console.log(`  - ${orgNameById.get(id)} (${id})`));

  if (!APPLY) {
    console.log('\n[DRY RUN] No changes made. Re-run with --apply to write.');
    printSummary({ scanned: candidateOrgIds.length, recovered: recovered.length, inserted: 0, skipped: hasGoLive.size, unrecoverable: unrecoverableNoDd.length + unrecoverableNoApproval.length });
    return;
  }

  // 6. Write values.
  let inserted = 0;
  let failed = 0;
  for (const r of recovered) {
    const record = { organization_id: r.orgId, field_id: GO_LIVE_FIELD_ID, value: r.date };
    let error;
    if (hasGoLiveRow.has(r.orgId)) {
      // Existing row with an empty value — update it in place.
      ({ error } = await supabase
        .from('organization_preference_value')
        .update({ value: r.date })
        .eq('organization_id', r.orgId)
        .eq('field_id', GO_LIVE_FIELD_ID));
    } else {
      ({ error } = await supabase
        .from('organization_preference_value')
        .insert(record));
    }
    if (error) {
      console.error(`  FAIL: ${orgNameById.get(r.orgId)} (${r.orgId}) — ${error.message}`);
      failed++;
    } else {
      console.log(`  OK: ${orgNameById.get(r.orgId)} → go_live = ${r.date}`);
      inserted++;
    }
  }

  printSummary({ scanned: candidateOrgIds.length, recovered: recovered.length, inserted, skipped: hasGoLive.size, unrecoverable: unrecoverableNoDd.length + unrecoverableNoApproval.length });
  if (failed > 0) {
    console.error(`\n${failed} write(s) FAILED — review above and re-run (idempotent).`);
    process.exit(1);
  }
}

function printSummary({ scanned, recovered, inserted, skipped, unrecoverable }) {
  console.log('\n=== Summary ===');
  console.log(`Active orgs scanned (missing go_live): ${scanned}`);
  console.log(`Dates recovered from DD approvals:     ${recovered}`);
  console.log(`Values written:                        ${inserted}`);
  console.log(`Skipped (already had go_live):         ${skipped}`);
  console.log(`Unrecoverable (left untouched):        ${unrecoverable}`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

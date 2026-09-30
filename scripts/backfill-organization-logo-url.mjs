#!/usr/bin/env node
/**
 * Backfill: Repair organization.logo_url values that were written as
 * file-upload payloads instead of plain URL strings.
 *
 * Background: a public form mapping a file-upload field to the
 * Organisation → Logo core column wrote the entire file-upload payload
 * (`{ file_url, storage_path, bucket, file_name, ... }`) into
 * `organization.logo_url`. Some rows ended up holding a JS-toString'd
 * "[object Object]", and others a JSON-encoded string of the payload.
 * Either way, the Organisations list/detail views render
 * `<img src="{...json...}">` and show a broken image with internal
 * storage metadata leaked into the DOM.
 *
 * This script scans `organization.logo_url`, identifies rows whose value
 * is not a plain URL, extracts `file_url` from the embedded payload, and
 * updates the row in-place. It is idempotent and safe to re-run.
 *
 * Usage:
 *   node scripts/backfill-organization-logo-url.mjs --dry-run   # Preview
 *   node scripts/backfill-organization-logo-url.mjs             # Execute
 *
 * Environment Variables Required:
 *   SUPABASE_URL                 - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY    - Supabase service role key
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

console.log('='.repeat(60));
console.log('Backfill: organization.logo_url payload repair');
console.log('='.repeat(60));
console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE'}`);
console.log('');

// Returns { needsRepair, newValue, reason } for a given logo_url cell.
// - newValue is the extracted plain URL string when needsRepair is true.
// - reason describes which corruption shape was detected.
function inspect(logoUrl) {
  if (logoUrl === null || logoUrl === undefined || logoUrl === '') {
    return { needsRepair: false, reason: 'empty' };
  }
  if (typeof logoUrl !== 'string') {
    // Defensive: PG text columns return strings, but if a JSONB-ish object
    // somehow came through, handle it.
    if (typeof logoUrl === 'object' && typeof logoUrl.file_url === 'string') {
      return { needsRepair: true, newValue: logoUrl.file_url, reason: 'object-with-file_url' };
    }
    return { needsRepair: false, reason: 'non-string-non-object' };
  }
  const trimmed = logoUrl.trim();
  if (!trimmed) return { needsRepair: false, reason: 'whitespace-only' };

  // Case A: literal "[object Object]" — payload was coerced via String(value).
  // We cannot recover the URL from this; flag for manual review by clearing.
  if (trimmed === '[object Object]') {
    return { needsRepair: true, newValue: null, reason: 'object-tostring-unrecoverable' };
  }

  // Case B: JSON-encoded file payload string.
  if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('file_url')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.file_url === 'string') {
        return { needsRepair: true, newValue: parsed.file_url, reason: 'json-payload' };
      }
    } catch (_) {
      // Not parseable JSON — leave it.
    }
  }

  return { needsRepair: false, reason: 'plain-string' };
}

async function main() {
  console.log('Step 1: Scanning organization.logo_url ...');
  const { data: orgs, error } = await supabase
    .from('organization')
    .select('id, name, logo_url')
    .not('logo_url', 'is', null);

  if (error) {
    console.error('Failed to load organizations:', error.message);
    process.exit(1);
  }

  const total = orgs?.length || 0;
  let scanned = 0;
  let toRepair = [];
  let unrecoverable = [];

  for (const org of orgs || []) {
    scanned += 1;
    const result = inspect(org.logo_url);
    if (!result.needsRepair) continue;
    if (result.newValue === null) {
      unrecoverable.push({ org, result });
    } else {
      toRepair.push({ org, result });
    }
  }

  console.log(`Scanned: ${scanned} / ${total}`);
  console.log(`Repairable rows: ${toRepair.length}`);
  console.log(`Unrecoverable rows (will be cleared to null): ${unrecoverable.length}`);
  console.log('');

  if (toRepair.length === 0 && unrecoverable.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('Step 2: Applying updates ...');
  let updated = 0;
  let cleared = 0;
  let failed = 0;
  const errors = [];

  const apply = async (org, newValue, label) => {
    if (isDryRun) {
      console.log(`  [DRY RUN] ${label}: ${org.id} (${org.name || 'unnamed'}) -> ${newValue === null ? 'NULL' : newValue}`);
      return true;
    }
    const { error: updErr } = await supabase
      .from('organization')
      .update({ logo_url: newValue })
      .eq('id', org.id);
    if (updErr) {
      errors.push({ id: org.id, error: updErr.message });
      failed += 1;
      console.log(`  ERROR ${org.id}: ${updErr.message}`);
      return false;
    }
    console.log(`  ${label}: ${org.id} (${org.name || 'unnamed'}) -> ${newValue === null ? 'NULL' : newValue}`);
    return true;
  };

  for (const { org, result } of toRepair) {
    const ok = await apply(org, result.newValue, 'REPAIR');
    if (ok && !isDryRun) updated += 1;
  }
  for (const { org } of unrecoverable) {
    const ok = await apply(org, null, 'CLEAR');
    if (ok && !isDryRun) cleared += 1;
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Scanned: ${scanned}`);
  console.log(`Repaired (extracted file_url): ${isDryRun ? toRepair.length : updated} ${isDryRun ? '(dry run)' : ''}`);
  console.log(`Cleared (unrecoverable [object Object]): ${isDryRun ? unrecoverable.length : cleared} ${isDryRun ? '(dry run)' : ''}`);
  console.log(`Skipped (already plain URLs): ${scanned - toRepair.length - unrecoverable.length}`);
  console.log(`Failed: ${failed}`);
  if (errors.length > 0) {
    console.log('');
    console.log('Errors:');
    errors.forEach(e => console.log(`  ${e.id}: ${e.error}`));
  }
  if (isDryRun) {
    console.log('');
    console.log('This was a DRY RUN. Re-run without --dry-run to apply.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

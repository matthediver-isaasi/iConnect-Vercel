#!/usr/bin/env node
/**
 * Backfill: GSF organisation logos from approved Due Diligence submissions.
 *
 * Background: approved DD submissions for tenant GSF contain an uploaded
 * "Organisation Logo" file, but the stage field-mapping to `core.logo_url`
 * produced nothing at approval time: the file-upload payload stores a
 * RELATIVE `/api/storage/secure-url?bucket=private-uploads&path=…` URL and a
 * `storage_path` WITHOUT a `bucket` key, which the logo-resolution branch in
 * `executeFieldMappingActions` could not handle (fixed alongside this script).
 * Result: ~22 orgs with an approved submission have no logo.
 *
 * What it does, per approved DD submission whose linked org has no usable
 * logo_url:
 *   1. Discovers the logo field per-form by label match ("logo"), not a
 *      hardcoded field id.
 *   2. Resolves the submitted value mirroring resolveReviewedFieldValue
 *      (amended reviewer value wins even when cleared; otherwise the original
 *      submission value; reviewed value only as a last-resort fallback).
 *   3. Extracts bucket/storage path from the file payload (mirrors the fixed
 *      extractLogoFileMetadata logic, incl. relative secure-url parsing).
 *   4. Copies the file from `private-uploads` into the `public-assets` bucket
 *      (same path, upsert — matches scripts/migrate-logos-to-public.mjs) and
 *      writes the public URL to `organization.logo_url`.
 *
 * Orgs whose logo_url already starts with http(s) are never touched, so the
 * script is idempotent: a second run finds nothing to do. Submissions whose
 * logo value cannot be recovered are listed in the summary for manual chase.
 *
 * Usage:
 *   node scripts/backfill-gsf-org-logos-from-dd.mjs            # dry-run (default)
 *   node scripts/backfill-gsf-org-logos-from-dd.mjs --apply    # write changes
 *   node scripts/backfill-gsf-org-logos-from-dd.mjs --tenant=<uuid> [--apply]
 *
 * Environment Variables Required:
 *   DEST_SUPABASE_URL, DEST_SUPABASE_KEY (service-role) — the direct Postgres
 *   host is unreachable from this workspace; use supabase-js only.
 */

import { createClient } from '@supabase/supabase-js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) return [a, true];
    return [m[1], m[2] ?? true];
  })
);

const APPLY = args.apply === true || args.apply === 'true';
// Hard-pinned to GSF unless explicitly overridden.
const TENANT_ID = typeof args.tenant === 'string' && args.tenant ? args.tenant : '21296ad6-1350-483a-a90c-1b06ece70501';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY environment variables.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const PUBLIC_BUCKET = 'public-assets';

// ---------------------------------------------------------------------------
// Value resolution helpers (mirror api/due-diligence/_stageActions.js)
// ---------------------------------------------------------------------------

// A usable logo_url is a plain absolute URL string.
function hasUsableLogo(logoUrl) {
  return typeof logoUrl === 'string' && logoUrl.trim().startsWith('http');
}

// Mirrors resolveReviewedFieldValue: 'amended' review status wins (even when
// cleared); otherwise original submission value; reviewed value only when no
// original entry exists at all.
function resolveFieldValue({ fieldId, originalData, reviewedData, fieldReviewStatus }) {
  const status = fieldReviewStatus?.[fieldId];
  if (status === 'amended') {
    return { value: reviewedData?.[fieldId] ?? null, source: 'amended' };
  }
  if (originalData && Object.prototype.hasOwnProperty.call(originalData, fieldId)) {
    return { value: originalData[fieldId], source: 'original' };
  }
  if (reviewedData && Object.prototype.hasOwnProperty.call(reviewedData, fieldId)) {
    return { value: reviewedData[fieldId], source: 'reviewed_fallback' };
  }
  return { value: null, source: 'missing' };
}

// Parse a relative/absolute `/api/storage/secure-url?bucket=..&path=..` link.
function parseSecureStorageUrl(url) {
  if (typeof url !== 'string' || !url.includes('/api/storage/')) return null;
  const qs = url.split('?')[1];
  if (!qs) return null;
  try {
    const params = new URLSearchParams(qs);
    const bucket = params.get('bucket');
    const path = params.get('path') || params.get('storagePath');
    if (!bucket || !path) return null;
    return { bucket, storagePath: path };
  } catch {
    return null;
  }
}

// Mirrors the (fixed) extractLogoFileMetadata in _stageActions.js.
function extractLogoFileMetadata(value, depth = 0) {
  if (!value || depth > 3) return null;
  if (typeof value === 'string') {
    if (value.startsWith('{') || value.startsWith('[')) {
      try { return extractLogoFileMetadata(JSON.parse(value), depth + 1); } catch { return null; }
    }
    const secure = parseSecureStorageUrl(value);
    if (secure) return secure;
    if (value.startsWith('http')) return { directUrl: value };
    return null;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? extractLogoFileMetadata(value[0], depth + 1) : null;
  }
  if (typeof value === 'object') {
    if (value.storage_path && value.bucket) {
      return { bucket: value.bucket, storagePath: value.storage_path };
    }
    const directUrl = value.file_url || value.url || value.publicUrl || value.signedUrl || value.downloadUrl || value.src;
    if (directUrl && typeof directUrl === 'string') {
      const secure = parseSecureStorageUrl(directUrl);
      if (secure) return secure;
      if (directUrl.startsWith('http')) return { directUrl };
    }
    if (value.value) return extractLogoFileMetadata(value.value, depth + 1);
    if (value.data) return extractLogoFileMetadata(value.data, depth + 1);
    if (value.file) return extractLogoFileMetadata(value.file, depth + 1);
    if (value.files) return extractLogoFileMetadata(value.files, depth + 1);
    if (value.metadata?.url) return { directUrl: value.metadata.url };
    return null;
  }
  return null;
}

// Discover the logo field id on a form by label (not hardcoded).
function findLogoFieldId(formFields) {
  const candidates = (formFields || []).filter((f) => {
    const label = String(f?.label || f?.name || '');
    return /logo/i.test(label);
  });
  if (candidates.length === 0) return null;
  // Prefer an exact "Organisation Logo"-style label if several match.
  const exact = candidates.find((f) => /^organisation logo$/i.test(String(f.label || '').trim()));
  return (exact || candidates[0]).id;
}

// ---------------------------------------------------------------------------

async function copyToPublicBucket(sourceBucket, storagePath) {
  if (sourceBucket === PUBLIC_BUCKET) {
    const { data } = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(storagePath);
    if (!data?.publicUrl) return { ok: false, error: 'getPublicUrl returned nothing' };
    return { ok: true, publicUrl: data.publicUrl, copied: false };
  }
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(sourceBucket)
    .download(storagePath);
  if (downloadError) return { ok: false, error: `download failed: ${downloadError.message}` };

  const ext = storagePath.split('.').pop()?.toLowerCase();
  const contentType =
    ext === 'png' ? 'image/png'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : ext === 'svg' ? 'image/svg+xml'
    : 'application/octet-stream';

  const { error: uploadError } = await supabase.storage
    .from(PUBLIC_BUCKET)
    .upload(storagePath, fileData, { contentType, upsert: true });
  if (uploadError) return { ok: false, error: `upload failed: ${uploadError.message}` };

  const { data } = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(storagePath);
  if (!data?.publicUrl) return { ok: false, error: 'getPublicUrl returned nothing' };
  return { ok: true, publicUrl: data.publicUrl, copied: true };
}

async function main() {
  console.log('================================================================');
  console.log('  BACKFILL ORG LOGOS FROM APPROVED DD SUBMISSIONS' + (APPLY ? '  [APPLY]' : '  [DRY-RUN]'));
  console.log('================================================================');
  console.log(`Tenant: ${TENANT_ID}`);
  console.log('');

  // 1. Approved DD submissions for the tenant.
  const { data: ddRows, error: ddErr } = await supabase
    .from('form_submission_due_diligence')
    .select('id, form_submission_id, reviewed_form_values, field_review_status, workflow_status')
    .eq('tenant_id', TENANT_ID)
    .eq('workflow_status', 'approved');
  if (ddErr) { console.error('Error loading DD submissions:', ddErr.message); process.exit(2); }
  console.log(`Approved DD submissions: ${ddRows?.length || 0}`);

  if (!ddRows || ddRows.length === 0) { console.log('Nothing to do.'); return; }

  // 2. Linked form submissions (org linkage + original values).
  const fsIds = ddRows.map((r) => r.form_submission_id).filter(Boolean);
  const { data: fsRows, error: fsErr } = await supabase
    .from('form_submission')
    .select('id, form_id, organization_id, submission_data, created_date')
    .in('id', fsIds)
    .eq('tenant_id', TENANT_ID);
  if (fsErr) { console.error('Error loading form submissions:', fsErr.message); process.exit(2); }
  const fsMap = new Map((fsRows || []).map((f) => [f.id, f]));

  // 3. Forms → per-form logo field id, discovered by label.
  const formIds = [...new Set((fsRows || []).map((f) => f.form_id).filter(Boolean))];
  const { data: forms, error: formErr } = await supabase
    .from('form')
    .select('id, name, fields')
    .in('id', formIds)
    .eq('tenant_id', TENANT_ID);
  if (formErr) { console.error('Error loading forms:', formErr.message); process.exit(2); }
  const logoFieldByForm = new Map();
  for (const form of forms || []) {
    const fieldId = findLogoFieldId(form.fields);
    logoFieldByForm.set(form.id, { fieldId, formName: form.name });
  }

  // 4. Linked organizations.
  const orgIds = [...new Set((fsRows || []).map((f) => f.organization_id).filter(Boolean))];
  const { data: orgs, error: orgErr } = await supabase
    .from('organization')
    .select('id, name, logo_url')
    .in('id', orgIds)
    .eq('tenant_id', TENANT_ID);
  if (orgErr) { console.error('Error loading organizations:', orgErr.message); process.exit(2); }
  const orgMap = new Map((orgs || []).map((o) => [o.id, o]));

  // 5. Walk submissions; group by org (newest submission first per org).
  const sorted = [...ddRows].sort((a, b) => {
    const fa = fsMap.get(a.form_submission_id);
    const fb = fsMap.get(b.form_submission_id);
    return String(fb?.created_date || '').localeCompare(String(fa?.created_date || ''));
  });

  const seenOrgs = new Set();
  const actions = [];       // recoverable: { dd, fsr, org, metadata, source }
  const unrecoverable = []; // { dd, org, reason }
  let alreadyOk = 0;
  let noOrg = 0;

  for (const dd of sorted) {
    const fsr = fsMap.get(dd.form_submission_id);
    if (!fsr || !fsr.organization_id) { noOrg += 1; continue; }
    const org = orgMap.get(fsr.organization_id);
    if (!org) { noOrg += 1; continue; }
    if (seenOrgs.has(org.id)) continue; // newest submission per org wins
    seenOrgs.add(org.id);

    if (hasUsableLogo(org.logo_url)) { alreadyOk += 1; continue; }

    const formInfo = logoFieldByForm.get(fsr.form_id) || {};
    if (!formInfo.fieldId) {
      unrecoverable.push({ dd, org, reason: `no logo-labelled field on form "${formInfo.formName || fsr.form_id}"` });
      continue;
    }

    const { value, source } = resolveFieldValue({
      fieldId: formInfo.fieldId,
      originalData: fsr.submission_data || {},
      reviewedData: dd.reviewed_form_values || {},
      fieldReviewStatus: dd.field_review_status || {},
    });

    if (value === null || value === undefined || value === '') {
      unrecoverable.push({ dd, org, reason: `no logo value (source=${source})` });
      continue;
    }

    const metadata = extractLogoFileMetadata(value);
    if (!metadata) {
      unrecoverable.push({ dd, org, reason: `logo value not a file payload (source=${source}): ${JSON.stringify(value).slice(0, 80)}` });
      continue;
    }

    actions.push({ dd, fsr, org, metadata, source });
  }

  console.log(`Orgs already with usable logo: ${alreadyOk}`);
  console.log(`Submissions without linked org: ${noOrg}`);
  console.log(`Recoverable orgs: ${actions.length}`);
  console.log(`Unrecoverable: ${unrecoverable.length}`);
  console.log('');

  let updated = 0;
  let failed = 0;

  for (const { dd, org, metadata, source } of actions) {
    const desc = metadata.directUrl
      ? `direct URL ${metadata.directUrl.slice(0, 90)}`
      : `${metadata.bucket}/${metadata.storagePath}`;
    console.log(`ORG "${org.name}" (${org.id})`);
    console.log(`  dd=${dd.id} valueSource=${source}`);
    console.log(`  logo file: ${desc}`);

    if (!APPLY) {
      console.log(metadata.directUrl
        ? `  [DRY-RUN] would set logo_url to the direct URL`
        : `  [DRY-RUN] would copy to ${PUBLIC_BUCKET}/${metadata.storagePath} and set logo_url to its public URL`);
      console.log('');
      continue;
    }

    let finalUrl = null;
    if (metadata.directUrl) {
      finalUrl = metadata.directUrl;
    } else {
      const copy = await copyToPublicBucket(metadata.bucket, metadata.storagePath);
      if (!copy.ok) {
        console.log(`  ERROR: ${copy.error}`);
        failed += 1;
        console.log('');
        continue;
      }
      finalUrl = copy.publicUrl;
      console.log(`  copied${copy.copied ? '' : ' (already public)'}: ${finalUrl}`);
    }

    const { error: updErr } = await supabase
      .from('organization')
      .update({ logo_url: finalUrl })
      .eq('id', org.id)
      .eq('tenant_id', TENANT_ID)
      .or('logo_url.is.null,logo_url.not.ilike.http%'); // never clobber a usable URL
    if (updErr) {
      console.log(`  ERROR updating org: ${updErr.message}`);
      failed += 1;
    } else {
      console.log(`  ✓ logo_url set`);
      updated += 1;
    }
    console.log('');
  }

  console.log('================================================================');
  console.log('Summary');
  console.log('================================================================');
  console.log(`Recoverable orgs ${APPLY ? 'updated' : 'that would be updated'}: ${APPLY ? updated : actions.length}`);
  if (APPLY) console.log(`Failed: ${failed}`);
  console.log(`Already had a usable logo (untouched): ${alreadyOk}`);
  console.log(`Unrecoverable (chase manually):`);
  if (unrecoverable.length === 0) console.log('  none');
  unrecoverable.forEach(({ org, dd, reason }) => {
    console.log(`  - ${org.name} (org=${org.id}, dd=${dd.id}): ${reason}`);
  });
  if (!APPLY) console.log('\nDRY-RUN — no changes written. Re-run with --apply to persist.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

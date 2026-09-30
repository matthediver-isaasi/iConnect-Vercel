/**
 * Replay form submission organisation core-field update
 *
 * Reconstructs the org core-field update that should have happened when a form
 * submission was originally processed, but was silently skipped due to the
 * pre-fix bugs in api/forms/process-application.js (missing core-field map
 * entries, narrow existing-org resolution, raw object values for address-typed
 * columns).
 *
 * Resolution order for the target organisation (first match wins):
 *   1. --org-id=<uuid> override
 *   2. The form_submission row's organization_id
 *   3. The submission's created_member_id -> member.organization_id
 *   4. Case-insensitive match against the org name resolved from the form values
 *
 * Address-typed values that look like objects are normalised to a newline
 * string using the same rules as the runtime helper in process-application.js.
 *
 * Usage:
 *   node scripts/replay-form-submission-org-update.mjs --submission-id=<uuid>          # Dry run (default)
 *   node scripts/replay-form-submission-org-update.mjs --submission-id=<uuid> --apply  # Apply
 *   node scripts/replay-form-submission-org-update.mjs --submission-id=<uuid> --org-id=<uuid> --apply
 *
 * Requires the destination Supabase service role key in DEST_SUPABASE_KEY (or
 * SUPABASE_SERVICE_KEY as a fallback). The destination URL defaults to the
 * project URL but can be overridden with --supabase-url=<url>.
 */

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const argMap = Object.fromEntries(
  args
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
);

const DRY_RUN = !argMap.apply;
const SUBMISSION_ID = argMap['submission-id'];
const ORG_ID_OVERRIDE = argMap['org-id'] || null;
const SUPABASE_URL = argMap['supabase-url'] || process.env.DEST_SUPABASE_URL || 'https://lvmzliemqnieeoruhkik.supabase.co';
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUBMISSION_ID) {
  console.error('Missing --submission-id=<uuid>');
  process.exit(2);
}
if (!SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_KEY (or SUPABASE_SERVICE_KEY) env var.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ADDRESS_LIKE_TARGETS = new Set(['invoicing_address', 'address']);

const normalizeAddressValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter(p => p !== undefined && p !== null && String(p).trim() !== '')
      .map(p => String(p))
      .join('\n');
  }
  if (typeof value === 'object') {
    const candidates = [
      value.line1, value.address_line_1, value.line_1, value.street, value.address1,
      value.line2, value.address_line_2, value.line_2, value.address2,
      value.line3, value.address_line_3, value.line_3,
      value.city, value.town,
      value.state, value.region, value.county,
      value.postcode, value.postal_code, value.zip,
      value.country,
    ];
    let parts = candidates.filter(p => p !== undefined && p !== null && String(p).trim() !== '');
    if (parts.length === 0) {
      parts = Object.values(value)
        .filter(p => p !== undefined && p !== null)
        .filter(p => typeof p !== 'object')
        .filter(p => String(p).trim() !== '');
    }
    return parts.map(p => String(p)).join('\n');
  }
  return String(value);
};

const coerceAddressIfNeeded = (targetField, value) =>
  ADDRESS_LIKE_TARGETS.has(targetField) ? normalizeAddressValue(value) : value;

const orgCoreFieldMappings = {
  name: 'name',
  logo_url: 'logo_url',
  phone: 'phone',
  invoicing_email: 'invoicing_email',
  invoicing_address: 'invoicing_address',
  website_url: 'website_url',
  email: 'email',
  address: 'address',
  website: 'website_url',
};

const ALLOWED_ORG_COLUMNS = ['name', 'logo_url', 'invoicing_email', 'phone', 'website_url', 'invoicing_address', 'email', 'address'];

const isEmpty = (v) => v === undefined || v === null || v === '';

const extractOrgDataFromForm = (form, formValues) => {
  const orgData = {};
  const orgPipelines = form?.entity_pipelines?.organisations || [];
  const primary = orgPipelines.find(p => p.isPrimary || p.is_primary) || orgPipelines[0];

  // New mappings array format
  if (primary?.mappings && Array.isArray(primary.mappings)) {
    for (const m of primary.mappings) {
      if (m.target_type !== 'core' || !m.target_field) continue;
      let value;
      if (m.source_type === 'static') value = m.static_value;
      else if (m.source_field_id) value = formValues[m.source_field_id];
      if (isEmpty(value)) continue;
      const dbKey = orgCoreFieldMappings[m.target_field] || m.target_field;
      orgData[dbKey] = coerceAddressIfNeeded(dbKey, value);
    }
  } else if (primary?.field_mappings) {
    // Legacy field_mappings object format
    for (const [configKey, dbKey] of Object.entries(orgCoreFieldMappings)) {
      const fieldId = primary.field_mappings[configKey];
      if (!fieldId) continue;
      const val = formValues[fieldId];
      if (isEmpty(val)) continue;
      orgData[dbKey] = coerceAddressIfNeeded(dbKey, val);
    }
  }

  // Also process top-level field_mappings array if present (legacy "form-level" mappings)
  if (Array.isArray(form?.field_mappings)) {
    for (const fm of form.field_mappings) {
      if (fm.target_type === 'core' && fm.target_entity === 'organization' && fm.target_field) {
        const val = fm.source_field_id ? formValues[fm.source_field_id] : fm.static_value;
        if (isEmpty(val)) continue;
        orgData[fm.target_field] = coerceAddressIfNeeded(fm.target_field, val);
      }
    }
  }

  return orgData;
};

async function resolveOrgId(submission) {
  if (ORG_ID_OVERRIDE) return { orgId: ORG_ID_OVERRIDE, via: '--org-id' };
  if (submission.organization_id) return { orgId: submission.organization_id, via: 'form_submission.organization_id' };
  if (submission.created_member_id) {
    const { data: m } = await supabase
      .from('member')
      .select('organization_id')
      .eq('id', submission.created_member_id)
      .maybeSingle();
    if (m?.organization_id) return { orgId: m.organization_id, via: 'created_member.organization_id' };
  }
  return { orgId: null, via: null };
}

async function resolveOrgIdByName(name) {
  if (!name) return null;
  const { data } = await supabase
    .from('organization')
    .select('id')
    .ilike('name', name)
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}

async function main() {
  console.log('='.repeat(72));
  console.log('Replay form submission org core-field update');
  console.log('='.repeat(72));
  console.log(`Mode:          ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'APPLY (writes will be performed)'}`);
  console.log(`Submission ID: ${SUBMISSION_ID}`);
  if (ORG_ID_OVERRIDE) console.log(`Org override:  ${ORG_ID_OVERRIDE}`);
  console.log(`Supabase URL:  ${SUPABASE_URL}`);
  console.log('');

  // Step 1: Load the submission
  const { data: submission, error: subErr } = await supabase
    .from('form_submission')
    .select('id, form_id, submission_data, organization_id, created_member_id, tenant_id')
    .eq('id', SUBMISSION_ID)
    .maybeSingle();

  if (subErr || !submission) {
    console.error('Failed to load submission:', subErr?.message || 'not found');
    process.exit(1);
  }
  console.log('Loaded submission:', { form_id: submission.form_id, organization_id: submission.organization_id, created_member_id: submission.created_member_id });

  // Step 2: Load the form
  const { data: form, error: formErr } = await supabase
    .from('form')
    .select('id, name, entity_pipelines, field_mappings')
    .eq('id', submission.form_id)
    .maybeSingle();

  if (formErr || !form) {
    console.error('Failed to load form:', formErr?.message || 'not found');
    process.exit(1);
  }
  console.log('Loaded form:', form.name);

  // Step 3: Extract org data from submission_data using the same mapping rules
  const formValues = submission.submission_data?.values || submission.submission_data || {};
  const orgData = extractOrgDataFromForm(form, formValues);
  console.log('\nExtracted orgData from submission:', JSON.stringify(orgData, null, 2));

  // Step 4: Resolve target organisation
  let { orgId, via } = await resolveOrgId(submission);
  if (!orgId && orgData.name) {
    orgId = await resolveOrgIdByName(orgData.name);
    if (orgId) via = 'org_name_match';
  }
  if (!orgId) {
    console.error('\nUnable to resolve target organisation. Aborting.');
    process.exit(1);
  }
  console.log(`\nResolved organisation: ${orgId} (via ${via})`);

  // Step 5: Build update payload
  const orgUpdateData = {};
  for (const [key, value] of Object.entries(orgData)) {
    if (!ALLOWED_ORG_COLUMNS.includes(key)) continue;
    if (value === null) {
      orgUpdateData[key] = null;
    } else if (value !== undefined && value !== '') {
      orgUpdateData[key] = coerceAddressIfNeeded(key, value);
    }
  }

  if (Object.keys(orgUpdateData).length === 0) {
    console.log('\nNo org core fields to update — nothing to do.');
    return;
  }

  console.log('\nUpdate payload:');
  console.log(JSON.stringify(orgUpdateData, null, 2));

  // Step 6: Show before/after diff
  const { data: orgBefore } = await supabase
    .from('organization')
    .select(ALLOWED_ORG_COLUMNS.join(','))
    .eq('id', orgId)
    .maybeSingle();
  console.log('\nCurrent organisation values:');
  console.log(JSON.stringify(orgBefore, null, 2));

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes written. Re-run with --apply to commit.');
    return;
  }

  // Step 7: Apply
  const { error: updateErr } = await supabase
    .from('organization')
    .update(orgUpdateData)
    .eq('id', orgId);

  if (updateErr) {
    console.error('\nUpdate failed:', updateErr.message);
    process.exit(1);
  }

  const { data: orgAfter } = await supabase
    .from('organization')
    .select(ALLOWED_ORG_COLUMNS.join(','))
    .eq('id', orgId)
    .maybeSingle();
  console.log('\nUpdated organisation values:');
  console.log(JSON.stringify(orgAfter, null, 2));
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

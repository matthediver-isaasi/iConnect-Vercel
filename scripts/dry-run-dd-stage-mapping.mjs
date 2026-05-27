#!/usr/bin/env node
// READ-ONLY: This script never writes to any DB table. It prints a per-mapping
// trace of what stage_field_mapping_action and stage_member_action would do
// for a given DD submission + stage, without invoking the live executor.
//
// Usage:
//   node scripts/dry-run-dd-stage-mapping.mjs --submission=<dd_submission_id> --stage="<name>"
//   node scripts/dry-run-dd-stage-mapping.mjs --form-submission=<form_submission_id> --stage="<name>"

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) return [a, true];
    return [m[1], m[2] ?? true];
  })
);

const ddSubmissionArg = args.submission;
const formSubmissionArg = args['form-submission'];
const stageArg = args.stage;

if ((!ddSubmissionArg && !formSubmissionArg) || !stageArg) {
  console.error('Usage: node scripts/dry-run-dd-stage-mapping.mjs --submission=<id>|--form-submission=<id> --stage="<name>"');
  process.exit(2);
}

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL || process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY (or SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Helpers — mirror live executor exactly (api/due-diligence/_stageActions.js).
// ---------------------------------------------------------------------------
function buildFieldKeyCandidates(sourceKey, sourceFormFields = []) {
  if (!sourceKey) return [];
  const candidates = new Set();
  candidates.add(String(sourceKey));
  candidates.add(`field_${sourceKey}`);
  const field = (sourceFormFields || []).find(
    (f) => f && (f.id === sourceKey || f.name === sourceKey || f.key === sourceKey)
  );
  if (field) {
    if (field.id) {
      candidates.add(String(field.id));
      candidates.add(`field_${field.id}`);
    }
    if (field.name) candidates.add(String(field.name));
    if (field.key) candidates.add(String(field.key));
  }
  return Array.from(candidates);
}

function lookupValueByCandidates(data, candidates) {
  if (!data) return { found: false, value: undefined, key: null };
  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) {
      return { found: true, value: data[k], key: k };
    }
  }
  return { found: false, value: undefined, key: null };
}

function resolveReviewedFieldValue({
  sourceFieldId,
  originalData = {},
  reviewedData = {},
  fieldReviewStatus = {},
  sourceFormFields = [],
}) {
  const candidates = buildFieldKeyCandidates(sourceFieldId, sourceFormFields);
  if (candidates.length === 0) return { value: null, source: 'missing', key: null };
  let status = null;
  for (const k of candidates) {
    const s = fieldReviewStatus?.[k];
    if (s) { status = s; break; }
  }
  if (status === 'amended') {
    const r = lookupValueByCandidates(reviewedData, candidates);
    return { value: r.found ? r.value : null, source: 'amended', key: r.key || candidates[0] };
  }
  const o = lookupValueByCandidates(originalData, candidates);
  if (o.found) return { value: o.value, source: 'original', key: o.key };
  const r = lookupValueByCandidates(reviewedData, candidates);
  if (r.found) return { value: r.value, source: 'reviewed_fallback', key: r.key };
  return { value: null, source: 'missing', key: candidates[0] };
}

function unwrapPrimitiveValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.length > 0 ? unwrapPrimitiveValue(value[0]) : null;
  const candidateKeys = ['url', 'href', 'value', 'text', 'label', 'name'];
  for (const k of candidateKeys) {
    if (value[k] !== undefined && value[k] !== null && typeof value[k] !== 'object') {
      return value[k];
    }
  }
  return value;
}

function extractLogoFileMetadata(value, depth = 0) {
  if (!value || depth > 3) return null;
  if (typeof value === 'string') {
    if (value.startsWith('{') || value.startsWith('[')) {
      try { return extractLogoFileMetadata(JSON.parse(value), depth + 1); } catch { return null; }
    }
    if (value.startsWith('http')) return { directUrl: value };
    return null;
  }
  if (Array.isArray(value)) return value.length > 0 ? extractLogoFileMetadata(value[0], depth + 1) : null;
  if (typeof value === 'object') {
    if (value.storage_path && value.bucket) return { bucket: value.bucket, storagePath: value.storage_path };
    const directUrl = value.file_url || value.url || value.publicUrl || value.signedUrl || value.downloadUrl || value.src;
    if (directUrl && typeof directUrl === 'string' && directUrl.startsWith('http')) return { directUrl };
    if (value.value) return extractLogoFileMetadata(value.value, depth + 1);
    if (value.data) return extractLogoFileMetadata(value.data, depth + 1);
    if (value.file) return extractLogoFileMetadata(value.file, depth + 1);
    if (value.files) return extractLogoFileMetadata(value.files, depth + 1);
    if (value.metadata?.url) return { directUrl: value.metadata.url };
    return null;
  }
  return null;
}

async function resolveFileUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api/storage/secure-url') || url.startsWith('/api/storage/')) {
    try {
      const qs = url.split('?')[1];
      if (!qs) return null;
      const params = new URLSearchParams(qs);
      const bucket = params.get('bucket');
      const path = params.get('path') || params.get('storagePath');
      if (!bucket || !path) return null;
      const decodedPath = decodeURIComponent(path);
      const isPrivate = bucket.toLowerCase().includes('private');
      if (!isPrivate) {
        const { data: pubData } = supabase.storage.from(bucket).getPublicUrl(decodedPath);
        if (pubData?.publicUrl) return pubData.publicUrl;
      }
      const { data: signedData, error: signedErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(decodedPath, 60 * 60 * 24 * 365);
      if (!signedErr && signedData?.signedUrl) return signedData.signedUrl;
    } catch {}
  }
  return null;
}

function coerceBooleanPreferenceValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (value === 1) return 'true';
    if (value === 0) return 'false';
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return coerceBooleanPreferenceValue(value[0]);
    return null;
  }
  if (typeof value === 'object') {
    if ('value' in value) return coerceBooleanPreferenceValue(value.value);
    if ('checked' in value) return coerceBooleanPreferenceValue(value.checked);
    return null;
  }
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', 'on', '1'].includes(s)) return 'true';
  if (['false', 'no', 'n', 'off', '0'].includes(s)) return 'false';
  return null;
}

function previewValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') {
    try { const s = JSON.stringify(v); return s.length > 200 ? `${s.slice(0, 200)}…` : s; }
    catch { return '[object]'; }
  }
  const s = String(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const wouldMap = []; // [{ section, entry }]
const wouldFail = []; // [{ section, entry, reason }]

function fail(msg) { console.error(`ERROR: ${msg}`); process.exit(2); }

async function loadSubmission() {
  if (ddSubmissionArg) {
    const { data, error } = await supabase
      .from('form_submission_due_diligence')
      .select('*, form_submission:form_submission_id(id, form_id, submission_data, organization_id, tenant_id)')
      .eq('id', ddSubmissionArg)
      .single();
    if (error || !data) fail(`DD submission not found: ${ddSubmissionArg} (${error?.message || 'no row'})`);
    return data;
  }
  // Resolve via form_submission id
  const { data, error } = await supabase
    .from('form_submission_due_diligence')
    .select('*, form_submission:form_submission_id(id, form_id, submission_data, organization_id, tenant_id)')
    .eq('form_submission_id', formSubmissionArg)
    .single();
  if (error || !data) fail(`DD submission not found for form_submission ${formSubmissionArg} (${error?.message || 'no row'})`);
  return data;
}

async function run() {
  console.log('================================================================');
  console.log('  DD STAGE INTERNAL-CRM MAPPING — DRY RUN (READ-ONLY)');
  console.log('================================================================');

  const ddSubmission = await loadSubmission();
  const formSubmission = ddSubmission.form_submission;
  if (!formSubmission) fail('DD submission has no linked form_submission');

  const tenantId = ddSubmission.tenant_id || formSubmission.tenant_id;
  const formId = formSubmission.form_id;
  const organizationId = formSubmission.organization_id;
  const formSubmissionId = formSubmission.id;

  // Load DD config for stage resolution
  const { data: ddConfig, error: cfgErr } = await supabase
    .from('form_due_diligence_config')
    .select('id, workflow_stages')
    .eq('form_id', formId)
    .eq('tenant_id', tenantId)
    .single();
  if (cfgErr || !ddConfig) fail(`form_due_diligence_config not found for form ${formId} / tenant ${tenantId}: ${cfgErr?.message || 'no row'}`);

  const stages = ddConfig.workflow_stages || [];
  const needle = String(stageArg).trim().toLowerCase();
  let stage = stages.find((s) => String(s.label || '').trim().toLowerCase() === needle);
  if (!stage) stage = stages.find((s) => String(s.id || '').trim().toLowerCase() === needle);
  if (!stage) {
    console.error(`ERROR: stage "${stageArg}" not found. Available:`);
    for (const s of stages) console.error(`  - label="${s.label}"  id="${s.id}"`);
    process.exit(2);
  }

  // Form info for header
  const { data: form } = await supabase.from('form').select('id, name, fields').eq('id', formId).single();

  console.log(`DD submission id:    ${ddSubmission.id}`);
  console.log(`Form submission id:  ${formSubmissionId}`);
  console.log(`Tenant id:           ${tenantId}`);
  console.log(`Form id / name:      ${formId}  /  ${form?.name || '(unknown)'}`);
  console.log(`Organization id:     ${organizationId || '(none)'}`);
  console.log(`Stage label / id:    "${stage.label}"  /  ${stage.id}`);
  console.log(`DD config id:        ${ddConfig.id}`);
  console.log('');

  if (!organizationId) {
    wouldFail.push({ section: 'preflight', entry: 'organization_id', reason: 'form_submission has no organization_id — live executor short-circuits both field_mapping and member_creation actions' });
  }

  const sourceFormFields = form?.fields || [];
  const originalData = formSubmission.submission_data || {};
  const reviewedData = ddSubmission.reviewed_form_values || {};
  const fieldReviewStatus = ddSubmission.field_review_status || {};

  // Load current org row (for composite merge + no-op detection)
  let currentOrg = null;
  if (organizationId) {
    const { data: orgRow } = await supabase
      .from('organization')
      .select('*')
      .eq('id', organizationId)
      .eq('tenant_id', tenantId)
      .single();
    currentOrg = orgRow || null;
  }

  // -------------------------------------------------------------------------
  // FIELD MAPPING ACTIONS (organization)
  // -------------------------------------------------------------------------
  console.log('================================================================');
  console.log('  FIELD MAPPING ACTIONS  → /organisations  (stage_field_mapping_action)');
  console.log('================================================================');

  // Mirror live executor: scope to this submission's own form_id so other
  // forms' "<stage>"-stage field-mapping rows on the same tenant don't get
  // dragged into the trace.
  const { data: fmaList } = await supabase
    .from('stage_field_mapping_action')
    .select('*')
    .eq('due_diligence_stage_id', stage.id)
    .eq('tenant_id', tenantId)
    .eq('form_id', formId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  // org preference catalogue (mirrors live: entity_scope=organization, is_active=true, no tenant filter)
  const { data: orgPrefFields } = await supabase
    .from('preference_field')
    .select('id, label, field_type, entity_scope')
    .eq('entity_scope', 'organization')
    .eq('is_active', true);
  const orgPrefMap = new Map((orgPrefFields || []).map((p) => [p.id, p]));

  const VALID_CORE_FIELDS = ['name', 'email', 'phone', 'website', 'description', 'logo_url', 'invoicing_address'];
  const COMPOSITE_CORE_FIELDS = { address: ['line1', 'line2', 'city', 'region', 'postcode', 'country'] };

  const wouldOrgPayload = {}; // accumulated would-be update

  // Live executor re-queries organization_preference_value per mapping, so
  // earlier writes within the same stage are visible to later mappings (last
  // writer wins when multiple FMAs target the same custom field). The dry-run
  // simulates that by caching the current value on first lookup and mutating
  // the cache after each predicted UPDATE/INSERT. Without this, every mapping
  // would compare against the unchanged initial DB value and silently hide
  // multi-writer collisions like two FMAs writing different statics to the
  // same custom org field.
  const currentPrefValues = new Map(); // field_id -> { id|null, value }
  async function loadPrefValue(fieldId) {
    if (currentPrefValues.has(fieldId)) return currentPrefValues.get(fieldId);
    const { data: existing } = await supabase
      .from('organization_preference_value')
      .select('id, value')
      .eq('organization_id', organizationId)
      .eq('field_id', fieldId)
      .maybeSingle();
    const entry = existing ? { id: existing.id, value: existing.value } : { id: null, value: undefined };
    currentPrefValues.set(fieldId, entry);
    return entry;
  }

  if (!fmaList || fmaList.length === 0) {
    console.log('(no active stage_field_mapping_action rows for this stage)\n');
  }

  for (const fma of fmaList || []) {
    console.log(`--- field-mapping action ${fma.id} (sort=${fma.sort_order ?? '-'}) ---`);
    const mappings = fma.field_mappings || [];
    for (const m of mappings) {
      const { source_type, source_field_id, target_type, target_field, static_value } = m;
      const effectiveSourceType = source_type === 'static' ? 'static' : 'form_field';
      const header = `  [${effectiveSourceType}] src=${source_field_id ?? '-'}  →  ${target_type}:${target_field}`;
      console.log(header);

      // Skip-without-org early
      if (!organizationId) {
        wouldFail.push({ section: 'field_mapping', entry: header, reason: 'form_submission has no organization_id' });
        console.log('    SKIP: no organization_id on form_submission');
        continue;
      }

      // Resolve source value
      let sourceValue;
      let valueSource;
      let resolvedKey = null;
      if (source_type === 'static') {
        sourceValue = static_value;
        valueSource = 'static';
        if (typeof sourceValue === 'string' && sourceValue.trim().toLowerCase() === '{today}') {
          const now = new Date();
          sourceValue = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
          console.log(`    static {today} → ${sourceValue}`);
        }
        if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
          wouldFail.push({ section: 'field_mapping', entry: header, reason: 'static value is empty' });
          console.log('    SKIP: static value empty');
          continue;
        }
      } else {
        const resolved = resolveReviewedFieldValue({ sourceFieldId: source_field_id, originalData, reviewedData, fieldReviewStatus, sourceFormFields });
        sourceValue = resolved.value;
        valueSource = resolved.source;
        resolvedKey = resolved.key;
        console.log(`    resolvedKey=${resolvedKey} source=${valueSource} raw=${previewValue(sourceValue)}`);
        if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
          wouldFail.push({ section: 'field_mapping', entry: header, reason: `form field value empty (source=${valueSource}, key=${resolvedKey})` });
          console.log('    SKIP: resolved value empty');
          continue;
        }
      }

      const isComposite = target_type === 'core' && target_field.includes('.');

      // Stored value coercion (mirror)
      let storedValue = sourceValue;
      if (isComposite) {
        storedValue = sourceValue;
      } else if (target_type === 'core' && target_field !== 'logo_url') {
        const unwrapped = unwrapPrimitiveValue(sourceValue);
        if (unwrapped === null || unwrapped === undefined) {
          wouldFail.push({ section: 'field_mapping', entry: header, reason: 'value unwrapped to null/undefined' });
          console.log('    SKIP: unwrapped to null');
          continue;
        }
        storedValue = typeof unwrapped === 'object' ? JSON.stringify(unwrapped) : String(unwrapped);
      } else if (typeof sourceValue === 'object') {
        storedValue = JSON.stringify(sourceValue);
      } else {
        storedValue = String(sourceValue);
      }

      if (target_type === 'core') {
        let parentField = null;
        let subField = null;
        if (isComposite) {
          [parentField, subField] = target_field.split('.');
          if (!COMPOSITE_CORE_FIELDS[parentField] || !COMPOSITE_CORE_FIELDS[parentField].includes(subField)) {
            wouldFail.push({ section: 'field_mapping', entry: header, reason: `invalid composite core field: ${target_field}` });
            console.log('    SKIP: invalid composite core field');
            continue;
          }
          const existingValue = (currentOrg && currentOrg[parentField]) || {};
          const existingSub = existingValue?.[subField];
          const merged = { ...existingValue, [subField]: storedValue };
          console.log(`    composite ${parentField}.${subField}: existing=${previewValue(existingSub)} incoming=${previewValue(storedValue)} merged=${previewValue(merged)}`);
          if (existingSub === storedValue || (existingSub == null && storedValue == null)) {
            console.log('    NO-OP (composite sub-field already equals incoming)');
            continue;
          }
          wouldOrgPayload[parentField] = merged;
          wouldMap.push({ section: 'field_mapping', entry: `${header} → organization.${parentField} = ${previewValue(merged)}` });
          console.log(`    WOULD UPDATE organization.${parentField} = ${previewValue(merged)}`);
          // mutate working copy for downstream merges
          if (currentOrg) currentOrg[parentField] = merged;
        } else if (target_field === 'logo_url') {
          let resolvedLogoUrl = null;
          let chosenFrom = null;

          if (typeof storedValue === 'string' && storedValue.startsWith('http')) {
            resolvedLogoUrl = storedValue;
            chosenFrom = 'storedValue:http-string';
          } else {
            const metadata = extractLogoFileMetadata(sourceValue);
            console.log(`    logo metadata: ${previewValue(metadata)}`);
            if (metadata) {
              if (metadata.directUrl) {
                resolvedLogoUrl = metadata.directUrl;
                chosenFrom = 'extractLogoFileMetadata.directUrl';
              } else if (metadata.bucket && metadata.storagePath) {
                const isPrivate = metadata.bucket.toLowerCase().includes('private');
                if (!isPrivate) {
                  const { data: pubData } = supabase.storage.from(metadata.bucket).getPublicUrl(metadata.storagePath);
                  if (pubData?.publicUrl) {
                    resolvedLogoUrl = pubData.publicUrl;
                    chosenFrom = 'storage.getPublicUrl';
                  }
                }
                if (!resolvedLogoUrl) {
                  const { data: signedData, error: signedErr } = await supabase.storage
                    .from(metadata.bucket)
                    .createSignedUrl(metadata.storagePath, 60 * 60 * 24 * 365);
                  if (!signedErr && signedData?.signedUrl) {
                    resolvedLogoUrl = signedData.signedUrl;
                    chosenFrom = 'storage.createSignedUrl';
                  }
                }
              }
            }
            if (!resolvedLogoUrl && source_field_id) {
              const { data: subDocs } = await supabase
                .from('submission_document')
                .select('file_url')
                .eq('form_submission_id', formSubmissionId)
                .eq('tenant_id', tenantId)
                .eq('field_name', source_field_id)
                .order('version', { ascending: false })
                .limit(1);
              const docUrl = subDocs?.[0]?.file_url;
              if (docUrl) {
                resolvedLogoUrl = await resolveFileUrl(docUrl);
                chosenFrom = `submission_document.file_url → resolveFileUrl (${docUrl})`;
              }
            }
          }

          if (!resolvedLogoUrl) {
            wouldFail.push({ section: 'field_mapping', entry: header, reason: 'logo_url: could not resolve a usable file URL (metadata + submission_document fallback both failed)' });
            console.log('    SKIP: logo_url could not be resolved');
            continue;
          }

          console.log(`    logo_url resolved via: ${chosenFrom}`);
          if (currentOrg && currentOrg.logo_url === resolvedLogoUrl) {
            console.log('    NO-OP (logo_url unchanged)');
            continue;
          }
          wouldOrgPayload.logo_url = resolvedLogoUrl;
          wouldMap.push({ section: 'field_mapping', entry: `${header} → organization.logo_url = ${previewValue(resolvedLogoUrl)}` });
          console.log(`    WOULD UPDATE organization.logo_url = ${previewValue(resolvedLogoUrl)}`);
          if (currentOrg) currentOrg.logo_url = resolvedLogoUrl;
        } else if (!VALID_CORE_FIELDS.includes(target_field)) {
          wouldFail.push({ section: 'field_mapping', entry: header, reason: `unknown core target field: ${target_field}` });
          console.log('    SKIP: unknown core field');
          continue;
        } else {
          // Simple core column — note website→website_url legacy rename
          const columnName = target_field === 'website' ? 'website_url' : target_field;
          if (target_field === 'website') {
            console.log(`    legacy-rename: 'website' → column 'website_url'`);
          }
          if (currentOrg && currentOrg[columnName] === storedValue) {
            console.log(`    NO-OP (${columnName} already equals incoming)`);
            continue;
          }
          wouldOrgPayload[columnName] = storedValue;
          wouldMap.push({ section: 'field_mapping', entry: `${header} → organization.${columnName} = ${previewValue(storedValue)}` });
          console.log(`    WOULD UPDATE organization.${columnName} = ${previewValue(storedValue)}`);
          if (currentOrg) currentOrg[columnName] = storedValue;
        }
      } else if (target_type === 'custom') {
        const customField = orgPrefMap.get(target_field);
        if (!customField) {
          wouldFail.push({ section: 'field_mapping', entry: header, reason: `custom field ${target_field} has no matching preference_field row (entity_scope=organization, is_active=true) — silently dropped by live executor` });
          console.log('    SKIP: prefFieldMap miss (preference_field not found / inactive / wrong scope)');
          continue;
        }
        // Use accumulated-state cache so multi-writer collisions inside the
        // same stage produce the same final value the live executor would
        // (last writer wins). loadPrefValue seeds from the DB once per field,
        // and we mutate the cache after each predicted write below.
        const cached = await loadPrefValue(target_field);
        if (cached.id !== null) {
          if (cached.value === storedValue) {
            console.log(`    NO-OP (custom "${customField.label}" already equals incoming)`);
            continue;
          }
          wouldMap.push({ section: 'field_mapping', entry: `${header} → organization_preference_value UPDATE (label="${customField.label}", ${previewValue(cached.value)} → ${previewValue(storedValue)})` });
          console.log(`    WOULD UPDATE organization_preference_value (label="${customField.label}", from=${previewValue(cached.value)} to=${previewValue(storedValue)})`);
          cached.value = storedValue;
        } else {
          wouldMap.push({ section: 'field_mapping', entry: `${header} → organization_preference_value INSERT (label="${customField.label}", value=${previewValue(storedValue)})` });
          console.log(`    WOULD INSERT organization_preference_value (label="${customField.label}", value=${previewValue(storedValue)})`);
          // Synthetic id marker so subsequent mappings to the same field see
          // it as "existing" (matching what live would observe after the insert).
          cached.id = '(simulated-insert)';
          cached.value = storedValue;
        }
      } else {
        wouldFail.push({ section: 'field_mapping', entry: header, reason: `unknown target_type: ${target_type}` });
        console.log(`    SKIP: unknown target_type ${target_type}`);
      }
    }
    console.log('');
  }

  console.log('Would-be organization UPDATE payload (core columns only):');
  console.log(JSON.stringify(wouldOrgPayload, null, 2));
  console.log('');

  // -------------------------------------------------------------------------
  // MEMBER CREATION ACTIONS
  // -------------------------------------------------------------------------
  console.log('================================================================');
  console.log('  MEMBER CREATION ACTIONS  → /members  (stage_member_action)');
  console.log('================================================================');

  if (!ddConfig.id) {
    wouldFail.push({ section: 'member_action', entry: 'config scoping', reason: 'no form_due_diligence_config_id — live executor refuses to run member actions without config scoping' });
    console.log('SKIP: live executor refuses without configId\n');
  }

  const { data: maList } = await supabase
    .from('stage_member_action')
    .select('*, role:role_id(id, name)')
    .eq('due_diligence_stage_id', stage.id)
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .eq('form_due_diligence_config_id', ddConfig.id)
    .order('sort_order', { ascending: true });

  if (!maList || maList.length === 0) {
    console.log('(no active stage_member_action rows for this stage + config)\n');
  }

  const wouldMemberPayloads = [];

  for (const ma of maList || []) {
    console.log(`--- member action ${ma.id} (sort=${ma.sort_order ?? '-'}) ---`);

    if (!organizationId) {
      wouldFail.push({ section: 'member_action', entry: `action ${ma.id}`, reason: 'form_submission has no organization_id — live executor short-circuits' });
      console.log('    SKIP: no organization_id on form_submission');
      continue;
    }

    const resolveMapped = (fieldKey, role) => {
      if (!fieldKey) return { value: null, source: 'missing', key: null };
      const r = resolveReviewedFieldValue({ sourceFieldId: fieldKey, originalData, reviewedData, fieldReviewStatus, sourceFormFields });
      console.log(`    [${role}] field=${fieldKey} resolvedKey=${r.key} source=${r.source} value=${previewValue(r.value)}`);
      return r;
    };

    let fn = resolveMapped(ma.first_name_field, 'first_name').value;
    let ln = resolveMapped(ma.last_name_field, 'last_name').value;
    let em = resolveMapped(ma.email_field, 'email').value;

    if (typeof em === 'object' && em !== null) {
      console.log('    email unwrap: contact-object .email');
      em = em.email;
    }
    if (typeof fn === 'object' && fn !== null) {
      console.log('    first_name unwrap: contact-object');
      fn = fn.first_name || fn.firstName || '';
    }
    if (typeof ln === 'object' && ln !== null) {
      console.log('    last_name unwrap: contact-object');
      ln = ln.last_name || ln.lastName || '';
    }

    if (!em) {
      wouldFail.push({ section: 'member_action', entry: `action ${ma.id}`, reason: `email_field "${ma.email_field}" resolved empty — live executor skips with "No email found in field"` });
      console.log('    SKIP: no email resolved');
      continue;
    }
    const normalizedEmail = String(em).toLowerCase().trim();

    // Duplicate precheck (read-only)
    const { data: existingMember } = await supabase
      .from('member')
      .select('id, email, organization_id')
      .eq('tenant_id', tenantId)
      .ilike('email', normalizedEmail)
      .maybeSingle();

    if (existingMember) {
      wouldFail.push({ section: 'member_action', entry: `action ${ma.id}`, reason: `member with email "${normalizedEmail}" already exists in tenant (id=${existingMember.id}) — live executor skips with "already exists in tenant"` });
      console.log(`    SKIP: tenant already has member ${existingMember.id} for ${normalizedEmail}`);
      continue;
    }

    // Role resolution
    let roleSource = null;
    let roleId = null;
    if (ma.role_id) {
      roleId = ma.role_id;
      roleSource = `configured role_id=${ma.role_id} (${ma.role?.name || '?'})`;
    } else {
      const { data: defaultRole } = await supabase
        .from('role')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .eq('is_default', true)
        .maybeSingle();
      if (defaultRole) {
        roleId = defaultRole.id;
        roleSource = `fallback tenant default role: ${defaultRole.id} (${defaultRole.name})`;
      } else {
        roleSource = 'no role configured and no tenant default — member would be created with no role';
      }
    }
    console.log(`    role resolution: ${roleSource}`);

    const memberData = {
      tenant_id: tenantId,
      organization_id: organizationId,
      first_name: fn || '',
      last_name: ln || '',
      email: normalizedEmail,
      login_enabled: ma.login_enabled === true,
      show_in_directory: true,
      ...(roleId ? { role_id: roleId } : {}),
    };

    // Core mappings
    const fieldMappings = ma.field_mappings || { core: {}, custom: {} };
    const coreMappings = fieldMappings.core || {};
    for (const [coreField, mapping] of Object.entries(coreMappings)) {
      if (!mapping || !mapping.source) continue;
      let value;
      let src = mapping.source;
      let key = null;
      if (mapping.source === 'form_field') {
        const r = resolveMapped(mapping.value, `core:${coreField}`);
        value = r.value; src = r.source; key = r.key;
      } else if (mapping.source === 'manual') {
        value = mapping.value;
        console.log(`    [core:${coreField}] source=manual value=${previewValue(value)}`);
      }
      if (value === undefined || value === null || value === '') {
        wouldFail.push({ section: 'member_action', entry: `action ${ma.id} core:${coreField}`, reason: `value empty (source=${src})` });
        continue;
      }
      if (['first_name', 'last_name', 'email'].includes(coreField)) {
        console.log(`    [core:${coreField}] SKIPPED by live code (already set by mandatory field)`);
        continue;
      }
      memberData[coreField] = value;
    }

    // Custom mappings — batch-fetch preference_field defs for type-driven coercion
    const customMappings = fieldMappings.custom || {};
    const customFieldIds = Object.keys(customMappings).filter(Boolean);
    const customPrefMap = new Map();
    if (customFieldIds.length > 0) {
      const { data: customPrefFields } = await supabase
        .from('preference_field')
        .select('id, field_type, label, entity_scope, is_active')
        .in('id', customFieldIds);
      for (const pf of customPrefFields || []) customPrefMap.set(pf.id, pf);
    }

    const wouldCustomTargets = [];
    for (const [prefFieldId, mapping] of Object.entries(customMappings)) {
      if (!mapping || !mapping.source) continue;
      let value;
      let src = mapping.source;
      if (mapping.source === 'form_field') {
        const r = resolveMapped(mapping.value, `custom:${prefFieldId}`);
        value = r.value; src = r.source;
      } else if (mapping.source === 'manual') {
        value = mapping.value;
        console.log(`    [custom:${prefFieldId}] source=manual value=${previewValue(value)}`);
      }
      if (value === undefined || value === null || value === '') {
        wouldFail.push({ section: 'member_action', entry: `action ${ma.id} custom:${prefFieldId}`, reason: `value empty (source=${src})` });
        continue;
      }
      const pref = customPrefMap.get(prefFieldId);
      if (!pref) {
        wouldFail.push({ section: 'member_action', entry: `action ${ma.id} custom:${prefFieldId}`, reason: 'no preference_field row found for id — live executor logs "Failed to load preference_field defs" / silently coerces as string' });
        // live executor would still try to insert as string in that case — call out the silent drop
        console.log(`    [custom:${prefFieldId}] no preference_field def — live code would default field_type to 'unknown' and store stringified value`);
      }
      const fieldType = pref?.field_type || 'unknown';
      let stored;
      if (fieldType === 'boolean') {
        const coerced = coerceBooleanPreferenceValue(value);
        if (coerced === null) {
          wouldFail.push({ section: 'member_action', entry: `action ${ma.id} custom:${prefFieldId}`, reason: `field_type=boolean but value "${previewValue(value)}" does not map to true/false — live executor skips this preference` });
          console.log(`    [custom:${prefFieldId}] SKIP: boolean coercion failed for ${previewValue(value)}`);
          continue;
        }
        stored = coerced;
      } else {
        stored = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
      wouldCustomTargets.push({ field_id: prefFieldId, label: pref?.label || '(unknown)', field_type: fieldType, value: stored });
      wouldMap.push({ section: 'member_action', entry: `action ${ma.id} custom:${prefFieldId} ("${pref?.label || '(unknown)'}", type=${fieldType}) = ${previewValue(stored)}` });
      console.log(`    [custom:${prefFieldId}] type=${fieldType} storedValue=${previewValue(stored)}`);
    }

    wouldMap.push({ section: 'member_action', entry: `action ${ma.id} INSERT member ${normalizedEmail} (${fn} ${ln})` });
    console.log(`    WOULD INSERT member ${normalizedEmail}`);
    wouldMemberPayloads.push({ action_id: ma.id, member: memberData, custom_preferences: wouldCustomTargets });
    console.log('');
  }

  console.log('Would-be member INSERT payloads:');
  console.log(JSON.stringify(wouldMemberPayloads, null, 2));
  console.log('');

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log('================================================================');
  console.log(`  WOULD MAP  (${wouldMap.length})`);
  console.log('================================================================');
  for (const w of wouldMap) console.log(`  [${w.section}] ${w.entry}`);
  if (wouldMap.length === 0) console.log('  (none)');
  console.log('');
  console.log('================================================================');
  console.log(`  WOULD FAIL / DROP  (${wouldFail.length})`);
  console.log('================================================================');
  for (const w of wouldFail) console.log(`  [${w.section}] ${w.entry}\n      reason: ${w.reason}`);
  if (wouldFail.length === 0) console.log('  (none)');
  console.log('');

  process.exit(0);
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});

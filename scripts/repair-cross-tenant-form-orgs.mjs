// Repair form submissions whose organization_id / created_organization_id
// points to an organisation in a DIFFERENT tenant than the submission.
//
// Root cause (fixed in api/forms/process-application.js): the processor's
// existing-org resolution chain included a completely unscoped case-insensitive
// name match, so a name collision with an org from another tenant was linked
// and — because the form's org action was 'create' — creation was skipped.
//
// For each affected submission on an org-creating form this script re-runs the
// org creation using the form's mapped submission fields (core + custom
// mappings, honouring transformations) in the submission's own tenant, then
// relinks organization_id / created_organization_id.
//
// Targets the DEST database (production). Default is a dry run; pass --apply
// to write.
//
// Usage:
//   node scripts/repair-cross-tenant-form-orgs.mjs           # report only
//   node scripts/repair-cross-tenant-form-orgs.mjs --apply   # repair

import { createClient } from '@supabase/supabase-js';

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('DEST_SUPABASE_URL / DEST_SUPABASE_KEY are required');
  process.exit(1);
}
const supabase = createClient(url, key);
const APPLY = process.argv.includes('--apply');

// Mirrors applyTransformation in api/forms/process-application.js.
const applyTransformation = (value, transformation, currentDate) => {
  if (value === null || value === undefined) return value;
  const strValue = String(value);
  switch (transformation) {
    case 'trim': return strValue.trim();
    case 'uppercase': return strValue.toUpperCase();
    case 'lowercase': return strValue.toLowerCase();
    case 'titlecase': return strValue.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
    case 'extract_domain': {
      let domain = strValue.trim();
      if (domain.includes('@')) domain = domain.split('@').pop() || domain;
      domain = domain.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
      domain = domain.replace(/^www\./i, '');
      domain = domain.split(/[/?#]/)[0];
      return domain.toLowerCase() || strValue;
    }
    case 'extract_username': return strValue.includes('@') ? (strValue.split('@')[0] || strValue) : strValue;
    case 'first_word': return strValue.trim().split(/\s+/)[0] || strValue;
    case 'last_word': { const w = strValue.trim().split(/\s+/); return w[w.length - 1] || strValue; }
    case 'remove_spaces': return strValue.replace(/\s+/g, '');
    case 'numbers_only': return strValue.replace(/[^0-9]/g, '');
    case 'current_date': return currentDate; // repair uses the submission date, not today
    default: return strValue;
  }
};

const ORG_CORE_COLUMNS = new Set(['name', 'logo_url', 'invoicing_email', 'invoicing_address', 'phone', 'website_url', 'email', 'address']);
const ORG_CORE_ALIASES = { website: 'website_url' };
const SUPPORTED_SOURCE_TYPES = new Set([undefined, null, '', 'field', 'static', 'current_date']);
const SUPPORTED_TRANSFORMATIONS = new Set([undefined, null, '', 'none', 'trim', 'uppercase', 'lowercase', 'titlecase', 'extract_domain', 'extract_username', 'first_word', 'last_word', 'remove_spaces', 'numbers_only', 'current_date']);
const SUPPORTED_TARGET_TYPES = new Set(['core', 'custom']);

// Build orgData (core columns) + custom-field map from the form's org mappings,
// mirroring processPipelineMappings for organisation targets. This is a
// conservative subset of the processor: any mapping with semantics we do not
// replicate here (category mappings, static date tokens, unknown source
// types/transformations, non-string values needing coercion) makes the whole
// build UNSUPPORTED so the caller skips the repair instead of writing wrong data.
function buildOrgDataFromMappings(mappings, submissionData, submissionDate) {
  const orgData = {};
  const custom = new Map(); // field_id -> value (later mappings win, like the processor's map writes)
  const unsupported = [];
  for (const mapping of mappings || []) {
    if (mapping.target_entity !== 'organization') continue;
    const { source_type, source_field_id, source_category_id, static_value, target_type, target_field, transformation } = mapping;
    if (source_category_id) { unsupported.push(`${mapping.id}: category mapping`); continue; }
    if (!SUPPORTED_SOURCE_TYPES.has(source_type)) { unsupported.push(`${mapping.id}: source_type=${source_type}`); continue; }
    if (!SUPPORTED_TRANSFORMATIONS.has(transformation)) { unsupported.push(`${mapping.id}: transformation=${transformation}`); continue; }
    if (!SUPPORTED_TARGET_TYPES.has(target_type)) { unsupported.push(`${mapping.id}: target_type=${target_type}`); continue; }
    let value;
    if (source_type === 'current_date' || transformation === 'current_date') {
      value = submissionDate;
    } else if (source_type === 'static') {
      if (typeof static_value === 'string' && static_value.includes('{{')) {
        unsupported.push(`${mapping.id}: static token value`); continue;
      }
      value = static_value;
    } else {
      value = source_field_id ? submissionData[source_field_id] : undefined;
      if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        unsupported.push(`${mapping.id}: non-scalar value needs processor coercion`); continue;
      }
      if (value !== undefined && value !== null && value !== '' && transformation && transformation !== 'none') {
        value = applyTransformation(value, transformation, submissionDate);
      }
    }
    if (value === undefined || value === null || value === '') continue;
    if (target_type === 'custom') {
      custom.set(target_field, value);
    } else {
      const col = ORG_CORE_ALIASES[target_field] || target_field;
      if (ORG_CORE_COLUMNS.has(col)) orgData[col] = value;
      else unsupported.push(`${mapping.id}: unknown core column ${target_field}`);
    }
  }
  return { orgData, customFields: [...custom.entries()].map(([field_id, value]) => ({ field_id, value })), unsupported };
}

async function findAffected() {
  const affected = [];
  let page = 0;
  const orgCache = new Map();
  const getOrg = async (id) => {
    if (!orgCache.has(id)) {
      const { data } = await supabase.from('organization').select('id, name, tenant_id').eq('id', id).maybeSingle();
      orgCache.set(id, data || null);
    }
    return orgCache.get(id);
  };
  while (true) {
    const { data: subs, error } = await supabase
      .from('form_submission')
      .select('id, tenant_id, form_id, organization_id, created_organization_id, submission_data, created_date')
      .or('organization_id.not.is.null,created_organization_id.not.is.null')
      .order('id', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const sub of subs) {
      if (!sub.tenant_id) continue;
      const bad = {};
      for (const k of ['organization_id', 'created_organization_id']) {
        if (!sub[k]) continue;
        const org = await getOrg(sub[k]);
        if (org && org.tenant_id && org.tenant_id !== sub.tenant_id) bad[k] = org;
      }
      if (Object.keys(bad).length) affected.push({ sub, bad });
    }
    if (subs.length < 1000) break;
    page++;
  }
  return affected;
}

async function repair({ sub, bad }) {
  const { data: form, error: formErr } = await supabase
    .from('form')
    .select('id, name, tenant_id, entity_action, create_entity_type, organization_entity_action, entity_pipelines, field_mappings')
    .eq('id', sub.form_id)
    .maybeSingle();
  if (formErr || !form) {
    console.log(`  !! form ${sub.form_id} not found — manual review needed`);
    return;
  }
  const pipelines = form.entity_pipelines?.organisations || [];
  const primary = pipelines.find((o) => o.isPrimary || o.is_primary);
  const mappings = primary?.mappings || (form.field_mappings || []).filter((m) => m.target_entity === 'organization');

  const orgAction = primary || pipelines.length
    ? (primary?.action || 'create')
    : (form.organization_entity_action || (form.create_entity_type === 'organization' ? form.entity_action : 'none'));

  // Only repair forms whose effective organisation action is create/upsert —
  // update-only / non-org forms must not have an organisation fabricated for
  // them; report those for manual review instead.
  if (orgAction !== 'create' && orgAction !== 'upsert') {
    console.log(`  !! form "${form.name}" org action is '${orgAction}' (not create/upsert) — skipping, manual review needed`);
    return;
  }

  const submissionDate = (sub.created_date || new Date().toISOString()).split('T')[0];
  const { orgData, customFields, unsupported } = buildOrgDataFromMappings(mappings, sub.submission_data || {}, submissionDate);
  if (unsupported.length) {
    console.log(`  !! unsupported mapping semantics — skipping, manual review needed:\n     ${unsupported.join('\n     ')}`);
    return;
  }

  console.log(`  form="${form.name}" orgAction=${orgAction} mapped core=${JSON.stringify(orgData)} custom=${customFields.length}`);

  if (!orgData.name) {
    console.log('  !! no mapped organisation name — cannot recreate, manual review needed');
    return;
  }

  // Is there already a correct in-tenant org with this name? Prefer relinking it.
  const { data: inTenant } = await supabase
    .from('organization')
    .select('id, name, tenant_id')
    .ilike('name', orgData.name)
    .eq('tenant_id', sub.tenant_id)
    .limit(1)
    .maybeSingle();

  let targetOrgId = inTenant?.id || null;
  if (targetOrgId) {
    console.log(`  found existing in-tenant org "${inTenant.name}" (${targetOrgId}) — will relink`);
  } else if (!APPLY) {
    console.log(`  DRY RUN: would create org "${orgData.name}" in tenant ${sub.tenant_id} with ${customFields.length} custom field values and relink submission`);
    return;
  } else {
    const insertData = {
      name: orgData.name,
      logo_url: orgData.logo_url || null,
      invoicing_email: orgData.invoicing_email || null,
      invoicing_address: orgData.invoicing_address || null,
      phone: orgData.phone || null,
      website_url: orgData.website_url || null,
      email: orgData.email || null,
      address: orgData.address || null,
      tenant_id: sub.tenant_id,
      created_at: new Date().toISOString(),
    };
    const { data: newOrg, error: insErr } = await supabase.from('organization').insert(insertData).select().single();
    if (insErr) {
      console.log('  !! org insert failed:', insErr.message);
      return;
    }
    targetOrgId = newOrg.id;
    console.log(`  created org ${targetOrgId} ("${newOrg.name}") in tenant ${sub.tenant_id}`);
    for (const cf of customFields) {
      const { error: cfErr } = await supabase
        .from('organization_preference_value')
        .insert({ organization_id: targetOrgId, field_id: cf.field_id, value: cf.value });
      if (cfErr) console.log(`  !! custom field ${cf.field_id} insert failed:`, cfErr.message);
      else console.log(`  custom field ${cf.field_id} = ${JSON.stringify(cf.value)}`);
    }
  }

  if (!APPLY) {
    console.log(`  DRY RUN: would relink submission ${sub.id} -> ${targetOrgId}`);
    return;
  }
  const update = {};
  if (bad.organization_id) update.organization_id = targetOrgId;
  if (bad.created_organization_id) update.created_organization_id = targetOrgId;
  const { error: updErr } = await supabase.from('form_submission').update(update).eq('id', sub.id);
  if (updErr) console.log('  !! submission relink failed:', updErr.message);
  else console.log(`  relinked submission ${sub.id} ${Object.keys(update).join('+')} -> ${targetOrgId}`);
}

const affected = await findAffected();
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`Affected submissions: ${affected.length}`);
for (const item of affected) {
  const { sub, bad } = item;
  console.log(`\nSubmission ${sub.id} (tenant ${sub.tenant_id}, form ${sub.form_id}, ${sub.created_date})`);
  for (const [k, org] of Object.entries(bad)) {
    console.log(`  ${k} -> org ${org.id} "${org.name}" in FOREIGN tenant ${org.tenant_id}`);
  }
  await repair(item);
}
console.log('\nDone.');

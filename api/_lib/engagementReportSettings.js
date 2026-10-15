import { createHash, randomUUID } from 'node:crypto';
import { normalizeOrganizationPreferenceValues } from './organizationEligibility.js';

export const ENGAGEMENT_SETTINGS_KEY = 'org_engagement_report_types';
const ALIASES = ['org_type', 'organisation_type', 'organization_type'];
const fail = (message, status = 503) => Object.assign(new Error(message), { status });

async function checked(query) {
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw fail('Unable to load organisation engagement configuration or values');
  return data;
}

async function pages(build) {
  const result = [];
  for (let offset = 0; ; offset += 500) {
    const batch = await checked(build().range(offset, offset + 499));
    result.push(...batch);
    if (batch.length < 500) return result;
  }
}

export function normalizeTypeOptions(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw fail('Organisation type options are malformed', 409); }
  }
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw fail('Organisation type options are malformed', 409);
  const options = new Map();
  for (const item of raw) {
    const value = item && typeof item === 'object' ? item.value : item;
    if (!['string', 'number', 'boolean'].includes(typeof value) || !String(value).trim()) {
      throw fail('Organisation type options are malformed', 409);
    }
    options.set(String(value), { value: String(value), label: String(item?.label ?? value) });
  }
  return [...options.values()];
}

async function readRow(db, tenantId) {
  const rows = await checked(db.from('system_settings').select('id, setting_value')
    .eq('tenant_id', tenantId).eq('setting_key', ENGAGEMENT_SETTINGS_KEY).limit(2));
  if (rows.length > 1) throw fail('Duplicate engagement settings require administrator repair', 409);
  return rows[0];
}

export async function loadEngagementSettings(db, tenantId) {
  const row = await readRow(db, tenantId);
  let saved = null;
  if (row) {
    try { saved = JSON.parse(row.setting_value); } catch { throw fail('Saved engagement settings are malformed', 409); }
    if (saved?.version !== 1 || typeof saved.fieldId !== 'string'
      || !Array.isArray(saved.values) || saved.values.some(v => typeof v !== 'string')) {
      throw fail('Saved engagement settings are malformed', 409);
    }
  }
  const fields = await pages(() => db.from('preference_field')
    .select('id, name, label, options').eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization').eq('is_active', true)
    .in('name', ALIASES).order('id'));
  // Once saved, identity is pinned: never silently substitute another alias.
  const field = saved ? fields.find(f => f.id === saved.fieldId)
    : ALIASES.map(name => fields.find(f => f.name === name)).find(Boolean);
  let options = [], warning = null;
  if (!field) warning = 'The organisation type field is missing or inactive.';
  else {
    try { options = normalizeTypeOptions(field.options); }
    catch (error) { warning = error.message; }
    if (!warning && !options.length) warning = 'The organisation type field has no options.';
  }
  const staleValues = (saved?.values || []).filter(v => !options.some(o => o.value === v));
  if (staleValues.length) warning = 'Saved organisation types are no longer available. Remove them explicitly and save to repair the report scope.';
  return {
    configured: !!row, field: field ? { id: field.id, label: field.label || field.name } : null,
    options, values: saved?.values || [], revision: saved?.revision || null,
    staleValues, warning, valid: !warning,
  };
}

export async function saveEngagementSettings(db, tenantId, input) {
  const current = await loadEngagementSettings(db, tenantId);
  if (!current.field || !current.options.length || input?.fieldId !== current.field.id
    || !Array.isArray(input.values) || input.values.some(v =>
      typeof v !== 'string' || !current.options.some(o => o.value === v))) {
    throw fail('Choose valid options from the current organisation type field', 400);
  }
  const row = await readRow(db, tenantId);
  const previous = row ? JSON.parse(row.setting_value) : null;
  if ((input.revision ?? null) !== (previous?.revision ?? null)) {
    throw fail('Settings changed in another session. Reload settings before saving.', 409);
  }
  const value = JSON.stringify({ version: 1, fieldId: current.field.id,
    values: [...new Set(input.values)], revision: randomUUID() });
  let result;
  if (!row) {
    const hex = createHash('sha256').update(`system_settings:${tenantId}:${ENGAGEMENT_SETTINGS_KEY}`).digest('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    result = await db.from('system_settings').insert({
      id, tenant_id: tenantId, setting_key: ENGAGEMENT_SETTINGS_KEY, setting_value: value,
    }).select('id');
  } else {
    result = await db.from('system_settings').update({ setting_value: value })
      .eq('id', row.id).eq('tenant_id', tenantId).eq('setting_key', ENGAGEMENT_SETTINGS_KEY)
      .eq('setting_value', row.setting_value).select('id');
  }
  if (result.error?.code === '23505' || (!result.error && !result.data?.length)) {
    throw fail('Settings changed in another session. Reload settings before saving.', 409);
  }
  if (result.error) throw fail('Unable to save engagement settings');
  return loadEngagementSettings(db, tenantId);
}

export async function engagementCohort(db, tenantId, ids, settings) {
  if (!settings.configured) return new Set(ids);
  if (!settings.valid) throw fail(settings.warning, 409);
  const matched = new Set();
  if (!settings.values.length) return matched;
  const selected = new Set(settings.values);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const rows = await pages(() => db.from('organization_preference_value')
      .select('id, organization_id, value').eq('field_id', settings.field.id)
      .in('organization_id', ids.slice(offset, offset + 100)).order('id'));
    for (const row of rows) {
      if ((normalizeOrganizationPreferenceValues(row.value) || []).some(v => selected.has(v))) {
        matched.add(row.organization_id);
      }
    }
  }
  return matched;
}

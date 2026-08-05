// Shared helpers for Training-event agenda item types (Task #3419).
//
// Agenda item types are a tenant setting stored in system_settings under the
// 'event_agenda_item_types' key: a JSON array of
//   { name: string, includeInClashChecks: boolean }
// The three seed defaults below apply whenever the setting is absent, so
// existing tenants get them without a backfill. "Self study" is excluded from
// clash checks by default (self-paced work can overlap other events).

import { supabase } from './database.js';

export const AGENDA_ITEM_TYPES_SETTING_KEY = 'event_agenda_item_types';

export const DEFAULT_AGENDA_ITEM_TYPES = [
  { name: 'In person', includeInClashChecks: true },
  { name: 'Online', includeInClashChecks: true },
  { name: 'Self study', includeInClashChecks: false },
];

export function parseAgendaItemTypes(settingValue) {
  if (!settingValue) return DEFAULT_AGENDA_ITEM_TYPES;
  try {
    const parsed = JSON.parse(settingValue);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_AGENDA_ITEM_TYPES;
    return parsed
      .filter((t) => t && typeof t.name === 'string' && t.name.trim())
      .map((t) => ({ name: t.name.trim(), includeInClashChecks: t.includeInClashChecks !== false }));
  } catch {
    return DEFAULT_AGENDA_ITEM_TYPES;
  }
}

/** Load a tenant's agenda item types (falls back to defaults). */
export async function loadAgendaItemTypes(tenantId, client = supabase) {
  if (!tenantId || !client) return DEFAULT_AGENDA_ITEM_TYPES;
  const { data, error } = await client
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', AGENDA_ITEM_TYPES_SETTING_KEY)
    .maybeSingle();
  if (error) {
    console.error('[agendaItemTypes] settings lookup error:', error.message);
    return DEFAULT_AGENDA_ITEM_TYPES;
  }
  return parseAgendaItemTypes(data?.setting_value);
}

/** Set of type names (lowercased) that count towards clash checks. */
export function clashIncludedTypeNames(types) {
  return new Set(
    (types || [])
      .filter((t) => t.includeInClashChecks !== false)
      .map((t) => String(t.name).trim().toLowerCase())
  );
}

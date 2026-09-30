// Shared helpers for Training-event agenda item types (Task #3419).
//
// Agenda item types are a tenant setting stored in system_settings under the
// 'event_agenda_item_types' key: a JSON array of
//   { name: string, includeInClashChecks: boolean, icon: string|null, behaviour: string }
// `icon` is an optional Lucide icon name (kebab-case) rendered on event
// cards' mini agenda lines; null/absent means "use the default calendar
// icon". Legacy saved arrays without the key parse to icon: null.
// `behaviour` (Task #3561) drives which conditional field the training agenda
// editor shows for lines of this type: 'location' | 'zoom' | 'lms' | 'none'.
// Legacy saved arrays without a behaviour get one inferred from the name via
// the historical name-matching rules, so renames performed BEFORE this field
// existed keep behaving exactly as they did.
// The three seed defaults below apply whenever the setting is absent, so
// existing tenants get them without a backfill. "Self study" is excluded from
// clash checks by default (self-paced work can overlap other events).

import { supabase } from './database.js';

export const AGENDA_ITEM_TYPES_SETTING_KEY = 'event_agenda_item_types';

export const AGENDA_TYPE_BEHAVIOURS = ['location', 'zoom', 'lms', 'none'];

// Historical name-based inference (pre-Task-#3561 rules): exact seed names
// first, then keyword heuristics; unknown names get 'none'. Used only as the
// fallback for legacy entries saved without an explicit behaviour.
export function inferAgendaTypeBehaviour(typeName) {
  const n = String(typeName || '').trim().toLowerCase();
  if (!n) return 'none';
  if (n === 'in person' || n === 'in-person') return 'location';
  if (n === 'online') return 'zoom';
  if (n === 'self study' || n === 'self-study') return 'lms';
  if (n.includes('person') || n.includes('venue')) return 'location';
  if (n.includes('online') || n.includes('virtual') || n.includes('webinar') || n.includes('zoom') || n.includes('teams')) return 'zoom';
  if (n.includes('self') || n.includes('study') || n.includes('lms')) return 'lms';
  return 'none';
}

export const DEFAULT_AGENDA_ITEM_TYPES = [
  { name: 'In person', includeInClashChecks: true, icon: 'map-pin', behaviour: 'location' },
  { name: 'Online', includeInClashChecks: true, icon: 'video', behaviour: 'zoom' },
  { name: 'Self study', includeInClashChecks: false, icon: 'book', behaviour: 'lms' },
];

export function parseAgendaItemTypes(settingValue) {
  if (!settingValue) return DEFAULT_AGENDA_ITEM_TYPES;
  try {
    const parsed = JSON.parse(settingValue);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_AGENDA_ITEM_TYPES;
    return parsed
      .filter((t) => t && typeof t.name === 'string' && t.name.trim())
      .map((t) => ({
        name: t.name.trim(),
        includeInClashChecks: t.includeInClashChecks !== false,
        icon: typeof t.icon === 'string' && t.icon.trim() ? t.icon.trim() : null,
        behaviour: AGENDA_TYPE_BEHAVIOURS.includes(t.behaviour)
          ? t.behaviour
          : inferAgendaTypeBehaviour(t.name),
      }));
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

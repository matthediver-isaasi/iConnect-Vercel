import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";

// Task #3419: Training-event agenda item types.
// Stored as a tenant SystemSettings JSON array under 'event_agenda_item_types':
//   [{ name, includeInClashChecks, icon, behaviour }]
// `icon` is an optional Lucide icon name (kebab-case) shown on event cards'
// mini agenda lines; null/absent falls back to the default calendar icon
// (legacy saved arrays without the key parse to icon: null).
// `behaviour` (Task #3561) drives which conditional field the training agenda
// editor shows: 'location' | 'zoom' | 'lms' | 'none'. Legacy saved arrays
// without it get one inferred from the name (historical matching rules), so
// nothing changes for existing tenants until an admin edits settings.
// Seed defaults apply whenever the setting is absent, so existing tenants get
// them without a backfill. Keep in sync with api/_lib/agendaItemTypes.js.
export const AGENDA_ITEM_TYPES_SETTING_KEY = 'event_agenda_item_types';

export const AGENDA_TYPE_BEHAVIOURS = ['location', 'zoom', 'lms', 'none'];

// Admin-facing labels/help for the behaviour selector on /eventsettings.
export const AGENDA_TYPE_BEHAVIOUR_OPTIONS = [
  { value: 'location', label: 'In-person location', description: 'Agenda lines ask for a required venue/location' },
  { value: 'zoom', label: 'Online session (Zoom/Teams)', description: 'Agenda lines ask for a required webinar or meeting and show a join link' },
  { value: 'lms', label: 'Self study (LMS link)', description: 'Agenda lines ask for a required learning-platform URL' },
  { value: 'none', label: 'None', description: 'No extra field required' },
];

// Historical name-based inference (pre-Task-#3561 rules): exact seed names
// first, then keyword heuristics; unknown names get 'none'. Used as the
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
  } catch (e) {
    console.error('Failed to parse agenda item types:', e);
    return DEFAULT_AGENDA_ITEM_TYPES;
  }
}

export function useAgendaItemTypes() {
  const { data: setting, isLoading } = useQuery({
    queryKey: ['public-agenda-item-types-setting'],
    queryFn: async () => {
      const allSettings = await publicClient.listSystemSettings();
      return allSettings.find((s) => s.setting_key === AGENDA_ITEM_TYPES_SETTING_KEY) || null;
    },
    staleTime: 30000,
  });

  const agendaItemTypes = useMemo(
    () => parseAgendaItemTypes(setting?.setting_value),
    [setting?.setting_value]
  );

  return { agendaItemTypes, isLoading };
}

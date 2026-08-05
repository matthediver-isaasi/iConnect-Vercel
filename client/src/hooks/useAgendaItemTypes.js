import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";

// Task #3419: Training-event agenda item types.
// Stored as a tenant SystemSettings JSON array under 'event_agenda_item_types':
//   [{ name, includeInClashChecks }]
// Seed defaults apply whenever the setting is absent, so existing tenants get
// them without a backfill. Keep in sync with api/_lib/agendaItemTypes.js.
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

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";

export function useEventTypes() {
  const { data: settings = [], isLoading } = useQuery({
    queryKey: ['public-event-types-settings'],
    queryFn: async () => {
      const allSettings = await publicClient.listSystemSettings();
      return allSettings.find(s => s.setting_key === 'event_types');
    },
    staleTime: 30000,
  });

  // Memoize so consumers get a referentially stable array (parsing produces a
  // fresh array every render otherwise, which destabilizes downstream effects).
  const eventTypes = useMemo(() => {
    if (!settings?.setting_value) return [];
    try {
      return JSON.parse(settings.setting_value);
    } catch (e) {
      console.error('Failed to parse event types:', e);
      return [];
    }
  }, [settings?.setting_value]);

  return {
    eventTypes,
    isLoading,
  };
}

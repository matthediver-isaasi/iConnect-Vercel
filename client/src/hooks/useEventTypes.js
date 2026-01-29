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

  let eventTypes = [];
  if (settings?.setting_value) {
    try {
      eventTypes = JSON.parse(settings.setting_value);
    } catch (e) {
      console.error('Failed to parse event types:', e);
    }
  }

  return {
    eventTypes,
    isLoading,
  };
}

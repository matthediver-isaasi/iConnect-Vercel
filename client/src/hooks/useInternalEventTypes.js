import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { INTERNAL_EVENT_TYPES_SETTING_KEY, parseInternalEventTypes } from "@/lib/internalEventTypes";

export function useInternalEventTypes() {
  const { data: settings = [], isLoading } = useQuery({
    queryKey: ["/api/entities/SystemSettings"],
    queryFn: () => base44.entities.SystemSettings.list(),
    staleTime: 30000,
  });

  const internalEventTypes = useMemo(() => {
    const setting = settings.find((item) => item.setting_key === INTERNAL_EVENT_TYPES_SETTING_KEY);
    return parseInternalEventTypes(setting?.setting_value);
  }, [settings]);

  return { internalEventTypes, isLoading };
}
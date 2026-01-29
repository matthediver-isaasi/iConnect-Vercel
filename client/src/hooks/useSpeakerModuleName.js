import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useLayoutContext } from "@/contexts/LayoutContext";

export function useSpeakerModuleName() {
  const { memberInfo, sessionValidated } = useLayoutContext();
  const isAuthenticated = !!memberInfo && !!sessionValidated;

  const { data: moduleNameSetting, isLoading } = useQuery({
    queryKey: ['speaker-module-name', isAuthenticated ? 'authenticated' : 'public'],
    queryFn: async () => {
      if (isAuthenticated) {
        const allSettings = await base44.entities.SystemSettings.list();
        return allSettings.find(s => s.setting_key === 'speaker_module_name');
      } else {
        const allSettings = await publicClient.listSystemSettings();
        return allSettings.find(s => s.setting_key === 'speaker_module_name');
      }
    },
    staleTime: 60000,
  });

  let singular = "Speaker";
  let plural = "Speakers";

  if (moduleNameSetting?.setting_value) {
    try {
      const names = JSON.parse(moduleNameSetting.setting_value);
      singular = names.singular || "Speaker";
      plural = names.plural || "Speakers";
    } catch {
      singular = moduleNameSetting.setting_value;
      plural = moduleNameSetting.setting_value + "s";
    }
  }

  return {
    singular,
    plural,
    isLoading
  };
}

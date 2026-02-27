import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
export { evaluateVisibilityRules, OPERATORS } from "@/hooks/useOrgFieldVisibilityRules";

const RULES_SETTING_KEY = 'member_field_visibility_rules';

const DEFAULT_RULES = {
  rules: []
};

export function useMemberFieldVisibilityRules() {
  const queryClient = useQueryClient();

  const { data: rulesData, isLoading } = useQuery({
    queryKey: ['member-field-visibility-rules'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === RULES_SETTING_KEY);
      
      let parsedConfig = DEFAULT_RULES;
      if (setting?.setting_value) {
        try {
          parsedConfig = JSON.parse(setting.setting_value);
        } catch {
          parsedConfig = DEFAULT_RULES;
        }
      }
      
      return {
        config: parsedConfig,
        record: setting || null
      };
    }
  });

  const saveRulesMutation = useMutation({
    mutationFn: async (newRules) => {
      const rulesJson = JSON.stringify(newRules);
      const settingRecord = rulesData?.record;
      
      if (settingRecord?.id) {
        return await base44.entities.SystemSettings.update(settingRecord.id, {
          setting_value: rulesJson
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: RULES_SETTING_KEY,
          setting_value: rulesJson,
          description: 'Member field visibility rules configuration'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-field-visibility-rules'] });
    }
  });

  return {
    rulesConfig: rulesData?.config || DEFAULT_RULES,
    isLoading,
    saveRules: saveRulesMutation.mutateAsync,
    isSaving: saveRulesMutation.isPending,
    DEFAULT_RULES
  };
}

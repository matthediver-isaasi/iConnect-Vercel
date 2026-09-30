import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

// Task #3601: visibility/lock rules for the organisation-group record.
// Rule evaluation is shared with organisations (core:/custom: prefixes are
// entity-agnostic) — re-export the evaluator + operators from the org hook.
export { evaluateVisibilityRules, OPERATORS } from "@/hooks/useOrgFieldVisibilityRules";

const RULES_SETTING_KEY = 'org_group_field_visibility_rules';

const DEFAULT_RULES = {
  rules: []
};

export function useGroupFieldVisibilityRules({ enabled = true } = {}) {
  const queryClient = useQueryClient();

  const { data: rulesData, isLoading } = useQuery({
    queryKey: ['org-group-field-visibility-rules'],
    enabled,
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
          description: 'Organisation group field visibility rules configuration'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-group-field-visibility-rules'] });
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

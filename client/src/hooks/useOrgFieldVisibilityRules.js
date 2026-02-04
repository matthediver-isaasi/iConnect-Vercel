import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

const RULES_SETTING_KEY = 'org_field_visibility_rules';

const DEFAULT_RULES = {
  rules: []
};

export function useOrgFieldVisibilityRules() {
  const queryClient = useQueryClient();

  const { data: rulesData, isLoading } = useQuery({
    queryKey: ['org-field-visibility-rules'],
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
          description: 'Organisation field visibility rules configuration'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-field-visibility-rules'] });
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

export function evaluateVisibilityRules(rules, formData, customFields) {
  const hiddenFields = new Set();
  const shownFields = new Set();
  const fieldsWithShowRules = new Set();
  
  if (!rules || !rules.rules || rules.rules.length === 0) {
    return hiddenFields;
  }
  
  for (const rule of rules.rules) {
    if (!rule.actions) continue;
    for (const action of rule.actions) {
      if (action.action_type === 'show' && action.target_field_id) {
        fieldsWithShowRules.add(action.target_field_id);
      }
    }
  }
  
  for (const rule of rules.rules) {
    if (!rule.conditions || rule.conditions.length === 0) continue;
    
    const logic = rule.logic || 'and';
    let conditionsMet = logic === 'and';
    
    for (const condition of rule.conditions) {
      const conditionResult = evaluateCondition(condition, formData, customFields);
      
      if (logic === 'and') {
        conditionsMet = conditionsMet && conditionResult;
      } else {
        conditionsMet = conditionsMet || conditionResult;
      }
    }
    
    if (conditionsMet && rule.actions) {
      for (const action of rule.actions) {
        if (action.action_type === 'hide') {
          hiddenFields.add(action.target_field_id);
        } else if (action.action_type === 'show') {
          shownFields.add(action.target_field_id);
        }
      }
    }
  }
  
  for (const fieldId of fieldsWithShowRules) {
    if (!shownFields.has(fieldId)) {
      hiddenFields.add(fieldId);
    }
  }
  
  return hiddenFields;
}

function evaluateCondition(condition, formData, customFields) {
  const { field_id, operator, value } = condition;
  
  let fieldValue;
  if (field_id.startsWith('core:')) {
    const fieldKey = field_id.replace('core:', '');
    fieldValue = formData[fieldKey];
  } else if (field_id.startsWith('custom:')) {
    const customFieldId = field_id.replace('custom:', '');
    const customField = customFields?.find(cf => cf.id === customFieldId);
    if (customField && formData.custom_field_values) {
      fieldValue = formData.custom_field_values[customFieldId];
    }
  }
  
  switch (operator) {
    case 'equals':
      return String(fieldValue || '') === String(value || '');
    case 'not_equals':
      return String(fieldValue || '') !== String(value || '');
    case 'contains':
      return String(fieldValue || '').toLowerCase().includes(String(value || '').toLowerCase());
    case 'not_contains':
      return !String(fieldValue || '').toLowerCase().includes(String(value || '').toLowerCase());
    case 'is_empty':
      return !fieldValue || (Array.isArray(fieldValue) && fieldValue.length === 0) || String(fieldValue).trim() === '';
    case 'not_empty':
      return fieldValue && (!Array.isArray(fieldValue) || fieldValue.length > 0) && String(fieldValue).trim() !== '';
    case 'greater_than':
      return Number(fieldValue) > Number(value);
    case 'less_than':
      return Number(fieldValue) < Number(value);
    default:
      return false;
  }
}

export const OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Does not contain' },
  { value: 'is_empty', label: 'Is empty' },
  { value: 'not_empty', label: 'Is not empty' },
  { value: 'greater_than', label: 'Greater than' },
  { value: 'less_than', label: 'Less than' }
];

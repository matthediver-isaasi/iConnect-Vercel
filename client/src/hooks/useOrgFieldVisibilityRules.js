import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

const RULES_SETTING_KEY = 'org_field_visibility_rules';

const DEFAULT_RULES = {
  rules: []
};

export function useOrgFieldVisibilityRules({ enabled = true } = {}) {
  const queryClient = useQueryClient();

  const { data: rulesData, isLoading } = useQuery({
    queryKey: ['org-field-visibility-rules'],
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
  const hiddenCards = new Set();
  const shownCards = new Set();
  const cardsWithShowRules = new Set();
  const lockedFields = new Set();
  const unlockedFields = new Set();
  const fieldsWithUnlockRules = new Set();
  const lockedCards = new Set();
  const unlockedCards = new Set();
  const cardsWithUnlockRules = new Set();
  
  if (!rules || !rules.rules || rules.rules.length === 0) {
    return { hiddenFields, hiddenCards, lockedFields, lockedCards };
  }
  
  for (const rule of rules.rules) {
    if (!rule.actions) continue;
    for (const action of rule.actions) {
      if (action.action_type === 'show') {
        if (action.target_type === 'card' && action.target_card_id) {
          cardsWithShowRules.add(action.target_card_id);
        } else if (action.target_field_id) {
          fieldsWithShowRules.add(action.target_field_id);
        }
      } else if (action.action_type === 'unlock') {
        if (action.target_type === 'card' && action.target_card_id) {
          cardsWithUnlockRules.add(action.target_card_id);
        } else if (action.target_field_id) {
          fieldsWithUnlockRules.add(action.target_field_id);
        }
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
        if (action.target_type === 'card' && action.target_card_id) {
          if (action.action_type === 'hide') {
            hiddenCards.add(action.target_card_id);
          } else if (action.action_type === 'show') {
            shownCards.add(action.target_card_id);
          } else if (action.action_type === 'lock') {
            lockedCards.add(action.target_card_id);
          } else if (action.action_type === 'unlock') {
            unlockedCards.add(action.target_card_id);
          }
        } else {
          if (action.action_type === 'hide') {
            hiddenFields.add(action.target_field_id);
          } else if (action.action_type === 'show') {
            shownFields.add(action.target_field_id);
          } else if (action.action_type === 'lock') {
            lockedFields.add(action.target_field_id);
          } else if (action.action_type === 'unlock') {
            unlockedFields.add(action.target_field_id);
          }
        }
      }
    }
  }
  
  for (const fieldId of fieldsWithShowRules) {
    if (!shownFields.has(fieldId)) {
      hiddenFields.add(fieldId);
    }
  }
  
  for (const cardId of cardsWithShowRules) {
    if (!shownCards.has(cardId)) {
      hiddenCards.add(cardId);
    }
  }
  
  for (const fieldId of fieldsWithUnlockRules) {
    if (!unlockedFields.has(fieldId)) {
      lockedFields.add(fieldId);
    }
  }
  
  for (const cardId of cardsWithUnlockRules) {
    if (!unlockedCards.has(cardId)) {
      lockedCards.add(cardId);
    }
  }
  
  return { hiddenFields, hiddenCards, lockedFields, lockedCards };
}

const BOOLEAN_TRUE_STRINGS = new Set(['true', 'yes', '1']);
const BOOLEAN_FALSE_STRINGS = new Set(['false', 'no', '0']);

function toBoolCanonical(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (BOOLEAN_TRUE_STRINGS.has(s)) return 'true';
  if (BOOLEAN_FALSE_STRINGS.has(s)) return 'false';
  return null;
}

function evaluateCondition(condition, formData, customFields) {
  const { field_id, operator, value } = condition;

  let fieldValue;
  let fieldDef;
  if (field_id.startsWith('org_core:')) {
    const fieldKey = field_id.replace('org_core:', '');
    fieldValue = formData.org_data?.[fieldKey];
  } else if (field_id.startsWith('org_custom:')) {
    const orgCustomFieldId = field_id.replace('org_custom:', '');
    fieldDef = formData.org_custom_fields?.find(cf => cf.id === orgCustomFieldId);
    if (formData.org_custom_field_values) {
      fieldValue = formData.org_custom_field_values[orgCustomFieldId];
    }
  } else if (field_id.startsWith('core:')) {
    const fieldKey = field_id.replace('core:', '');
    fieldValue = formData[fieldKey];
  } else if (field_id.startsWith('custom:')) {
    const customFieldId = field_id.replace('custom:', '');
    fieldDef = customFields?.find(cf => cf.id === customFieldId);
    if (fieldDef && formData.custom_field_values) {
      fieldValue = formData.custom_field_values[customFieldId];
    }
  }

  const isDeclaredBooleanField = fieldDef?.field_type === 'boolean';
  const isBooleanField = isDeclaredBooleanField || typeof fieldValue === 'boolean';

  const canonicalBoolFieldValue = () => {
    const canon = toBoolCanonical(fieldValue);
    if (canon !== null) return canon;
    if (isDeclaredBooleanField && (fieldValue === undefined || fieldValue === null || fieldValue === '')) {
      return 'false';
    }
    return null;
  };

  switch (operator) {
    case 'equals': {
      if (isBooleanField) {
        const a = canonicalBoolFieldValue();
        const b = toBoolCanonical(value);
        if (a !== null && b !== null) return a === b;
      }
      return String(fieldValue ?? '') === String(value ?? '');
    }
    case 'not_equals': {
      if (isBooleanField) {
        const a = canonicalBoolFieldValue();
        const b = toBoolCanonical(value);
        if (a !== null && b !== null) return a !== b;
      }
      return String(fieldValue ?? '') !== String(value ?? '');
    }
    case 'contains':
      return String(fieldValue ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'not_contains':
      return !String(fieldValue ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'is_empty':
      if (typeof fieldValue === 'boolean') return false;
      return !fieldValue || (Array.isArray(fieldValue) && fieldValue.length === 0) || String(fieldValue).trim() === '';
    case 'not_empty':
      if (typeof fieldValue === 'boolean') return true;
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

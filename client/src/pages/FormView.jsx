import React, { useState, useEffect, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loader2, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import FormRenderer from "../components/forms/FormRenderer";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function FormViewPage() {
  const { memberInfo, organizationInfo } = useMemberAccess();

  const [currentStep, setCurrentStep] = useState(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [formValues, setFormValues] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(window.location.search);
  const formSlug = urlParams.get('slug');
  const prefillMemberId = urlParams.get('member_id');
  const prefillOrgId = urlParams.get('organization_id');

  // Fetch full member record to get job_title
  const { data: memberRecord } = useQuery({
    queryKey: ['member-record', memberInfo?.email],
    queryFn: async () => {
      const allMembers = await base44.entities.Member.listAll();
      return allMembers.find(m => m.email === memberInfo?.email);
    },
    enabled: !!memberInfo?.email
  });

  const { data: form, isLoading } = useQuery({
    queryKey: ['form-by-slug', formSlug],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list();
      return allForms.find(f => f.slug === formSlug && f.is_active);
    },
    enabled: !!formSlug
  });

  // Prefill: Fetch member entity when form has prefill_source = 'member'
  const { data: prefillMember } = useQuery({
    queryKey: ['prefill-member', prefillMemberId],
    queryFn: async () => {
      const allMembers = await base44.entities.Member.listAll();
      return allMembers.find(m => m.id === prefillMemberId);
    },
    enabled: !!prefillMemberId && form?.prefill_source === 'member'
  });

  // Prefill: Fetch organization entity when form has prefill_source = 'organization'
  const { data: prefillOrg } = useQuery({
    queryKey: ['prefill-org', prefillOrgId],
    queryFn: async () => {
      const allOrgs = await base44.entities.Organization.listAll();
      return allOrgs.find(o => o.id === prefillOrgId);
    },
    enabled: !!prefillOrgId && form?.prefill_source === 'organization'
  });

  // Prefill: Fetch custom field values for prefill entity (using correct entity type)
  const { data: prefillCustomFieldValues = [] } = useQuery({
    queryKey: ['prefill-custom-values', form?.prefill_source, prefillMemberId, prefillOrgId],
    queryFn: async () => {
      if (form?.prefill_source === 'member' && prefillMemberId) {
        // Fetch member preference values filtered by member_id
        const values = await base44.entities.MemberPreferenceValue.list({
          filter: { member_id: prefillMemberId }
        });
        return values || [];
      } else if (form?.prefill_source === 'organization' && prefillOrgId) {
        // Fetch organization preference values filtered by organization_id
        const values = await base44.entities.OrganizationPreferenceValue.list({
          filter: { organization_id: prefillOrgId }
        });
        return values || [];
      }
      return [];
    },
    enabled: form?.prefill_source && form.prefill_source !== 'none' && 
      ((form.prefill_source === 'member' && !!prefillMemberId) || 
       (form.prefill_source === 'organization' && !!prefillOrgId))
  });

  // Track if prefill has been applied to prevent overwriting user edits
  const [prefillApplied, setPrefillApplied] = useState(false);

  // Prefill: Populate form values when prefill entity loads (one-time only)
  useEffect(() => {
    if (!form || !form.prefill_source || form.prefill_source === 'none') return;
    if (prefillApplied) return; // Already applied prefill, don't overwrite user edits
    
    const entity = form.prefill_source === 'member' ? prefillMember : prefillOrg;
    if (!entity) return;
    
    const newValues = {};
    for (const field of (form.fields || [])) {
      if (field.prefill_field) {
        // Check if custom field (prefixed with 'custom:')
        if (field.prefill_field.startsWith('custom:')) {
          const customFieldId = field.prefill_field.replace('custom:', '');
          // Find custom field value by field_id (member_id/organization_id already filtered in query)
          const cfv = prefillCustomFieldValues.find(v => v.field_id === customFieldId);
          if (cfv && cfv.value !== undefined && cfv.value !== null) {
            let parsedValue = cfv.value;
            // For list fields, custom field values are stored as JSON strings - parse them
            if (field.type === 'list') {
              try {
                const parsed = JSON.parse(cfv.value);
                parsedValue = Array.isArray(parsed) ? parsed : [cfv.value];
              } catch {
                // If parsing fails, wrap single value in array
                parsedValue = cfv.value ? [cfv.value] : [];
              }
            }
            newValues[field.id] = parsedValue;
          }
        } else {
          // Core field - get value from entity
          if (entity[field.prefill_field] !== undefined) {
            newValues[field.id] = entity[field.prefill_field];
          }
        }
      }
    }
    
    if (Object.keys(newValues).length > 0) {
      // Prefill values take precedence on initial load, but only fill empty fields
      setFormValues(prev => {
        const merged = { ...prev };
        for (const [key, value] of Object.entries(newValues)) {
          // Only prefill if the field is empty/null/undefined
          if (!prev[key] || prev[key] === '' || prev[key] === null) {
            merged[key] = value;
          }
        }
        return merged;
      });
      setPrefillApplied(true);
    }
  }, [form, prefillMember, prefillOrg, prefillCustomFieldValues, prefillApplied]);

  const submitFormMutation = useMutation({
    mutationFn: async (submissionData) => {
      return await base44.entities.FormSubmission.create(submissionData);
    },
    onSuccess: async (submissionResult) => {
      // Increment form submission count
      if (form) {
        await base44.entities.Form.update(form.id, {
          submission_count: (form.submission_count || 0) + 1
        });
      }
      
      // For application forms with auto_create_entity, create member/org entities
      if (form?.is_application_form && form?.auto_create_entity) {
        try {
          console.log('[FormView] Processing application - roleActionTriggered:', roleActionTriggeredRef.current, 'triggeredRoleId:', triggeredRoleIdRef.current);
          const response = await fetch('/api/forms/process-application', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              form_id: form.id,
              form_values: formValues,
              fields: form.fields,
              field_mappings: form.field_mappings || [],
              application_level: form.application_level || 'member',
              member_entity_action: form.member_entity_action || 'none',
              organization_entity_action: form.organization_entity_action || 'none',
              submission_id: submissionResult?.id,
              prefill_organization_id: form.prefill_source === 'organization' ? prefillOrgId : null,
              // Only pass role_id if a set_role/clear_role action was explicitly triggered
              ...(roleActionTriggeredRef.current ? { role_id: triggeredRoleIdRef.current } : {})
            })
          });
          if (response.ok) {
            const result = await response.json();
            console.log('[FormView] Application processed:', result);
          } else {
            const error = await response.json();
            console.error('[FormView] Application processing failed:', error);
          }
        } catch (error) {
          console.error('[FormView] Error processing application:', error);
        }
      }
      // For authenticated users with custom field mappings (non-application forms)
      else if (memberInfo) {
        const hasMappings = form?.fields?.some(f => f.custom_field_id);
        if (hasMappings) {
          try {
            const response = await fetch('/api/forms/process-field-mappings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                form_values: formValues,
                fields: form.fields
              })
            });
            if (response.ok) {
              console.log('[FormView] CRM field mappings processed');
            } else if (response.status === 401) {
              console.log('[FormView] Field mappings skipped - user not authenticated');
            }
          } catch (error) {
            console.error('[FormView] Error processing field mappings:', error);
          }
        }
      }
      
      queryClient.invalidateQueries({ queryKey: ['form-by-slug'] });
      setSubmitted(true);
      
      if (form?.redirect_url) {
        setTimeout(() => {
          window.location.href = form.redirect_url;
        }, 2000);
      }
    },
    onError: (error) => {
      toast.error('Failed to submit form');
    }
  });

  // Reset page navigation state when form changes
  useEffect(() => {
    setCurrentPageIndex(0);
    setCurrentStep(0);
    setFormValues({});
    setSubmitted(false);
    setPrefillApplied(false);
  }, [form?.id]);

  // Helper to evaluate a rule condition
  const evaluateCondition = (triggerValue, operator, value) => {
    switch (operator) {
      case 'equals':
        if (Array.isArray(triggerValue)) {
          return triggerValue.includes(value);
        }
        return triggerValue === value;
      case 'not_equals':
        if (Array.isArray(triggerValue)) {
          return !triggerValue.includes(value);
        }
        return triggerValue !== value;
      case 'contains':
        if (Array.isArray(triggerValue)) {
          return triggerValue.includes(value);
        } else if (typeof triggerValue === 'string') {
          return triggerValue.includes(value);
        }
        return false;
      case 'not_empty':
        return triggerValue !== undefined && triggerValue !== null && triggerValue !== '' && 
          (Array.isArray(triggerValue) ? triggerValue.length > 0 : true);
      case 'is_empty':
        return triggerValue === undefined || triggerValue === null || triggerValue === '' ||
          (Array.isArray(triggerValue) && triggerValue.length === 0);
      default:
        return false;
    }
  };

  // Compute initial hidden fields from field.starts_hidden property
  // This property is set by FormBuilder when a 'show' rule targets the field
  // Fallback: Also check visibility_rules for legacy forms without starts_hidden
  const initialHiddenFieldIds = useMemo(() => {
    const hidden = new Set();
    
    // First, check field.starts_hidden (newer forms)
    for (const field of (form?.fields || [])) {
      if (field.starts_hidden) {
        hidden.add(field.id);
      }
    }
    
    // Fallback: For legacy forms, compute from visibility_rules
    if (hidden.size === 0 && form?.visibility_rules?.length > 0) {
      for (const rule of form.visibility_rules) {
        // Handle new multi-action format
        if (rule.actions && Array.isArray(rule.actions)) {
          for (const action of rule.actions) {
            if (action.action_type === 'show' && action.target_field_ids?.length) {
              action.target_field_ids.forEach(id => hidden.add(id));
            }
          }
        }
        // Handle legacy format
        else if (rule.action === 'show' && rule.target_field_ids?.length) {
          rule.target_field_ids.forEach(id => hidden.add(id));
        }
      }
    }
    
    return hidden;
  }, [form?.fields, form?.visibility_rules]);

  // Evaluate visibility rules to determine which fields should be hidden
  // Key principle: Fields with "show" rules START HIDDEN and only become visible when condition is met
  const hiddenFieldIds = useMemo(() => {
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      return new Set();
    }

    // Start with all "show" rule targets as hidden (explicit default state)
    const hidden = new Set(initialHiddenFieldIds);
    
    // Track which fields should be shown/hidden based on rule evaluation
    const fieldVisibility = {};
    
    for (const rule of form.visibility_rules) {
      if (!rule.trigger_field_id) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      const conditionMet = evaluateCondition(triggerValue, rule.operator, rule.value);

      // Handle new multi-action format
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'show' || action.action_type === 'hide') {
            const targetIds = action.target_field_ids || [];
            targetIds.forEach(fieldId => {
              if (!fieldVisibility[fieldId]) {
                fieldVisibility[fieldId] = { showRules: [], hideRules: [] };
              }
              if (action.action_type === 'show') {
                fieldVisibility[fieldId].showRules.push(conditionMet);
              } else if (action.action_type === 'hide') {
                fieldVisibility[fieldId].hideRules.push(conditionMet);
              }
            });
          }
        }
      }
      // Handle legacy format
      else if (rule.target_field_ids?.length) {
        rule.target_field_ids.forEach(fieldId => {
          if (!fieldVisibility[fieldId]) {
            fieldVisibility[fieldId] = { showRules: [], hideRules: [] };
          }
          if (rule.action === 'show') {
            fieldVisibility[fieldId].showRules.push(conditionMet);
          } else if (rule.action === 'hide') {
            fieldVisibility[fieldId].hideRules.push(conditionMet);
          }
        });
      }
    }
    
    // Update hidden set based on evaluated rules
    for (const [fieldId, { showRules, hideRules }] of Object.entries(fieldVisibility)) {
      // For show rules: if ANY show rule is satisfied, remove from hidden set
      const anyShowConditionMet = showRules.some(result => result === true);
      if (anyShowConditionMet) {
        hidden.delete(fieldId);
      }
      
      // For hide rules: if ANY hide rule is satisfied, add to hidden set
      const anyHideConditionMet = hideRules.some(result => result === true);
      if (anyHideConditionMet) {
        hidden.add(fieldId);
      }
    }
    
    return hidden;
  }, [form?.visibility_rules, formValues, initialHiddenFieldIds]);

  // Helper to filter visible fields
  // hiddenFieldIds already includes fields with "show" rules as hidden by default
  const filterVisibleFields = (fields) => {
    return fields.filter(field => !hiddenFieldIds.has(field.id));
  };

  // Compute initial disabled fields from field.starts_disabled property
  // Only fields with explicit starts_disabled = true start disabled
  const initialDisabledFieldIds = useMemo(() => {
    const disabled = new Set();
    
    // Only check field.starts_disabled - this is the sole source of truth
    for (const field of (form?.fields || [])) {
      if (field.starts_disabled) {
        disabled.add(field.id);
      }
    }
    
    return disabled;
  }, [form?.fields]);

  // Evaluate disable/enable rules to determine which fields should be disabled
  // Key principle: Fields start enabled by default. Disable rules add to disabled set, enable rules remove from it.
  const disabledFieldIds = useMemo(() => {
    // Start with fields that have starts_disabled = true
    const disabled = new Set(initialDisabledFieldIds);
    
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      return disabled;
    }
    
    // Track which fields should be enabled/disabled based on rule evaluation
    const fieldDisability = {};
    
    for (const rule of form.visibility_rules) {
      if (!rule.trigger_field_id) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      const conditionMet = evaluateCondition(triggerValue, rule.operator, rule.value);

      // Handle new multi-action format
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'enable' || action.action_type === 'disable') {
            const targetIds = action.target_field_ids || [];
            targetIds.forEach(fieldId => {
              if (!fieldDisability[fieldId]) {
                fieldDisability[fieldId] = { enableRules: [], disableRules: [] };
              }
              if (action.action_type === 'enable') {
                fieldDisability[fieldId].enableRules.push(conditionMet);
              } else if (action.action_type === 'disable') {
                fieldDisability[fieldId].disableRules.push(conditionMet);
              }
            });
          }
        }
      }
    }
    
    // Update disabled set based on evaluated rules
    for (const [fieldId, { enableRules, disableRules }] of Object.entries(fieldDisability)) {
      // For enable rules: if ANY enable rule is satisfied, remove from disabled set
      const anyEnableConditionMet = enableRules.some(result => result === true);
      if (anyEnableConditionMet) {
        disabled.delete(fieldId);
      }
      
      // For disable rules: if ANY disable rule is satisfied, add to disabled set
      const anyDisableConditionMet = disableRules.some(result => result === true);
      if (anyDisableConditionMet) {
        disabled.add(fieldId);
      }
    }
    
    return disabled;
  }, [form?.visibility_rules, formValues, initialDisabledFieldIds]);

  // Process Set Value rules - when conditions are met, update target field values
  // When conditions become false, revert to original values (undo the action)
  
  // Track original values BEFORE set_value rules modified them
  const originalValuesRef = useRef({});
  // Track which set_value actions are currently active (condition is true)
  const activeSetValueActionsRef = useRef(new Set());
  // Track the triggered role_id from set_role/clear_role actions
  const triggeredRoleIdRef = useRef(null);
  // Track whether a role action was explicitly triggered (to differentiate from initial null)
  const roleActionTriggeredRef = useRef(false);
  // Track which role actions were previously active (for transition detection)
  const previousRoleActionsRef = useRef(new Set());
  
  // Reset set_value and role tracking when form changes
  useEffect(() => {
    originalValuesRef.current = {};
    activeSetValueActionsRef.current = new Set();
    triggeredRoleIdRef.current = null;
    roleActionTriggeredRef.current = false;
    previousRoleActionsRef.current = new Set();
  }, [form?.id]);
  
  // Helper to compute the value for a set_value action
  const computeSetValue = (action, prefillEntity) => {
    const sourceType = action.set_value_source || 'static';
    
    if (sourceType === 'static') {
      return action.set_value;
    } else if (sourceType === 'field') {
      return formValues[action.set_value_field_id];
    } else if (sourceType === 'prefill' && prefillEntity) {
      const prefillField = action.set_value_prefill_field || '';
      if (prefillField.startsWith('core.')) {
        const coreFieldName = prefillField.replace('core.', '');
        return prefillEntity[coreFieldName];
      } else if (prefillField.startsWith('custom.')) {
        const customFieldId = prefillField.replace('custom.', '');
        const cfv = prefillCustomFieldValues.find(v => v.field_id === customFieldId);
        return cfv?.value;
      }
    }
    return null;
  };
  
  // Helper to compute the value for a legacy set_value rule
  const computeLegacySetValue = (rule, prefillEntity) => {
    const sourceType = rule.set_value_source || 'static';
    
    if (sourceType === 'static') {
      return rule.set_value;
    } else if (sourceType === 'field') {
      return formValues[rule.set_value_field_id];
    } else if (sourceType === 'prefill' && prefillEntity) {
      const prefillField = rule.set_value_prefill_field || '';
      if (prefillField.startsWith('core.')) {
        const coreFieldName = prefillField.replace('core.', '');
        return prefillEntity[coreFieldName];
      } else if (prefillField.startsWith('custom.')) {
        const customFieldId = prefillField.replace('custom.', '');
        const cfv = prefillCustomFieldValues.find(v => v.field_id === customFieldId);
        return cfv?.value;
      }
    }
    return null;
  };
  
  useEffect(() => {
    if (!form?.visibility_rules || form.visibility_rules.length === 0) return;
    
    const prefillEntity = form.prefill_source === 'member' ? prefillMember : prefillOrg;
    const updates = {};
    
    // Track which actions are now active and which fields they target
    const nowActiveActions = new Set();
    const activeFieldTargets = new Map(); // fieldId -> Set of actionKeys targeting it
    
    // First pass: identify all active actions and build field->action mapping
    for (const rule of form.visibility_rules) {
      if (!rule.trigger_field_id) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      const conditionMet = evaluateCondition(triggerValue, rule.operator, rule.value);
      
      // Handle new multi-action format
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'set_value' && action.target_field_id) {
            const actionKey = action.id;
            
            if (conditionMet) {
              nowActiveActions.add(actionKey);
              
              // Track which actions target this field
              if (!activeFieldTargets.has(action.target_field_id)) {
                activeFieldTargets.set(action.target_field_id, new Set());
              }
              activeFieldTargets.get(action.target_field_id).add(actionKey);
              
              // If this action wasn't active before, save original value and apply
              if (!activeSetValueActionsRef.current.has(actionKey)) {
                // Save original value if we haven't already
                if (!(action.target_field_id in originalValuesRef.current)) {
                  originalValuesRef.current[action.target_field_id] = formValues[action.target_field_id] ?? '';
                }
                
                const valueToSet = computeSetValue(action, prefillEntity);
                if (valueToSet !== null && valueToSet !== undefined) {
                  updates[action.target_field_id] = valueToSet;
                }
              }
            }
          }
        }
      }
      // Handle legacy format (rule_type === 'set_value')
      else if (rule.rule_type === 'set_value' && rule.target_field_id) {
        const ruleKey = `legacy_${rule.id}`;
        
        if (conditionMet) {
          nowActiveActions.add(ruleKey);
          
          // Track which actions target this field
          if (!activeFieldTargets.has(rule.target_field_id)) {
            activeFieldTargets.set(rule.target_field_id, new Set());
          }
          activeFieldTargets.get(rule.target_field_id).add(ruleKey);
          
          // If this rule wasn't active before, save original value and apply
          if (!activeSetValueActionsRef.current.has(ruleKey)) {
            // Save original value if we haven't already
            if (!(rule.target_field_id in originalValuesRef.current)) {
              originalValuesRef.current[rule.target_field_id] = formValues[rule.target_field_id] ?? '';
            }
            
            const valueToSet = computeLegacySetValue(rule, prefillEntity);
            if (valueToSet !== null && valueToSet !== undefined) {
              updates[rule.target_field_id] = valueToSet;
            }
          }
        }
      }
    }
    
    // Find actions that were active but are now inactive - need to revert
    // But only revert if NO other active action targets the same field
    for (const actionKey of activeSetValueActionsRef.current) {
      if (!nowActiveActions.has(actionKey)) {
        // Find the target field for this action
        for (const rule of form.visibility_rules) {
          // Check new multi-action format
          if (rule.actions && Array.isArray(rule.actions)) {
            for (const action of rule.actions) {
              if (action.id === actionKey && action.target_field_id) {
                const targetFieldId = action.target_field_id;
                // Only revert if no other active action targets this field
                const activeActionsForField = activeFieldTargets.get(targetFieldId);
                if (!activeActionsForField || activeActionsForField.size === 0) {
                  // No active actions target this field, safe to revert
                  if (targetFieldId in originalValuesRef.current) {
                    updates[targetFieldId] = originalValuesRef.current[targetFieldId];
                    delete originalValuesRef.current[targetFieldId];
                  }
                }
              }
            }
          }
          // Check legacy format
          else if (`legacy_${rule.id}` === actionKey && rule.target_field_id) {
            const targetFieldId = rule.target_field_id;
            // Only revert if no other active action targets this field
            const activeActionsForField = activeFieldTargets.get(targetFieldId);
            if (!activeActionsForField || activeActionsForField.size === 0) {
              // No active actions target this field, safe to revert
              if (targetFieldId in originalValuesRef.current) {
                updates[targetFieldId] = originalValuesRef.current[targetFieldId];
                delete originalValuesRef.current[targetFieldId];
              }
            }
          }
        }
      }
    }
    
    // Update the active actions set
    activeSetValueActionsRef.current = nowActiveActions;
    
    // Apply all updates at once to avoid multiple re-renders
    if (Object.keys(updates).length > 0) {
      setFormValues(prev => ({ ...prev, ...updates }));
    }
    
    // Process set_role and clear_role actions with transition detection
    // Only update role when an action transitions from inactive to active
    const nowActiveRoleActions = new Set();
    
    for (const rule of form.visibility_rules) {
      if (!rule.trigger_field_id) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      const conditionMet = evaluateCondition(triggerValue, rule.operator, rule.value);
      
      if (conditionMet && rule.actions && Array.isArray(rule.actions)) {
        rule.actions.forEach((action, actionIndex) => {
          if (action.action_type === 'set_role' || action.action_type === 'clear_role') {
            // Use action.id if available, otherwise fallback to composite key
            const actionKey = action.id || `${rule.id}:role:${actionIndex}`;
            nowActiveRoleActions.add(actionKey);
            
            // Only apply if this action just became active (transition detection)
            if (!previousRoleActionsRef.current.has(actionKey)) {
              if (action.action_type === 'set_role' && action.role_id) {
                triggeredRoleIdRef.current = action.role_id;
                roleActionTriggeredRef.current = true;
                console.log('[FormView] set_role action triggered, role_id:', action.role_id);
              } else if (action.action_type === 'clear_role') {
                triggeredRoleIdRef.current = null;
                roleActionTriggeredRef.current = true;
                console.log('[FormView] clear_role action triggered');
              }
            }
          }
        });
      }
    }
    
    // Update previous state for next render
    previousRoleActionsRef.current = nowActiveRoleActions;
  }, [form?.visibility_rules, formValues, prefillMember, prefillOrg, prefillCustomFieldValues, form?.prefill_source]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-slate-600">Form not found or is not active.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (form.require_authentication && !memberInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-slate-600">Please log in to access this form.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSubmit = async () => {
    // For paginated forms, validate all pages before submission
    const pages = form.pages || [];
    const hasPages = pages.length > 0 && form.layout_type === 'standard';
    
    // Get visible fields only (skip hidden fields from validation)
    const visibleFields = filterVisibleFields(form.fields);
    
    if (hasPages) {
      // Check each page's required fields (only visible ones)
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const pageFields = visibleFields.filter(f => f.page_id === page.id);
        const missingFields = pageFields.filter(field => 
          field.required && (!formValues[field.id] || formValues[field.id].length === 0)
        );
        
        if (missingFields.length > 0) {
          toast.error(`Please fill in required fields on "${page.title}": ${missingFields.map(f => f.label).join(', ')}`);
          return;
        }
      }
      
      // Also check unassigned fields (page_id is null) - only visible ones
      const unassignedFields = visibleFields.filter(f => !f.page_id);
      const missingUnassigned = unassignedFields.filter(field => 
        field.required && (!formValues[field.id] || formValues[field.id].length === 0)
      );
      
      if (missingUnassigned.length > 0) {
        toast.error(`Please fill in required fields: ${missingUnassigned.map(f => f.label).join(', ')}`);
        return;
      }
    } else {
      // Standard validation for non-paginated forms (only visible fields)
      const missingFields = visibleFields.filter(field => 
        field.required && (!formValues[field.id] || formValues[field.id].length === 0)
      );

      if (missingFields.length > 0) {
        toast.error(`Please fill in all required fields: ${missingFields.map(f => f.label).join(', ')}`);
        return;
      }
    }

    // Application form uniqueness validation
    if (form.is_application_form && form.uniqueness_checks && form.uniqueness_checks.length > 0) {
      try {
        const response = await fetch('/api/forms/validate-uniqueness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            application_level: form.application_level || 'member',
            uniqueness_checks: form.uniqueness_checks,
            form_values: formValues,
            fields: form.fields,
            form_id: form.id
          })
        });

        const result = await response.json();
        
        if (!result.valid && result.conflicts && result.conflicts.length > 0) {
          const conflictMessages = result.conflicts.map(c => `${c.field_label}: ${c.message}`);
          toast.error(`Validation failed:\n${conflictMessages.join('\n')}`);
          return;
        }
      } catch (error) {
        console.error('[FormView] Uniqueness validation error:', error);
        toast.error('Unable to validate form. Please try again.');
        return;
      }
    }

    const submissionData = {
      form_id: form.id,
      form_name: form.name,
      submitted_by_email: memberInfo?.email || null,
      submitted_by_name: memberInfo ? `${memberInfo.first_name} ${memberInfo.last_name}` : null,
      submission_data: formValues,
      created_date: new Date().toISOString()
    };

    submitFormMutation.mutate(submissionData);
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md border-green-200">
          <CardContent className="p-12 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            </div>
            <h3 className="text-xl font-semibold text-slate-900 mb-2">Success!</h3>
            <p className="text-slate-600">{form.success_message}</p>
            {form.redirect_url && (
              <p className="text-sm text-slate-500 mt-4">Redirecting...</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Use memberRecord (full data) if available, otherwise fallback to memberInfo
  const memberData = memberRecord || memberInfo;

  if (form.layout_type === 'card_swipe') {
    // Filter visible fields for card swipe layout
    const visibleCardFields = filterVisibleFields(form.fields);
    const currentField = visibleCardFields[currentStep];
    const isLastStep = currentStep === visibleCardFields.length - 1;
    const canProceed = !currentField?.required || formValues[currentField?.id];

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-2xl w-full border-slate-200">
          <CardHeader>
            <CardTitle>{form.name}</CardTitle>
            {form.description && <CardDescription className="whitespace-pre-line">{form.description}</CardDescription>}
            <div className="flex gap-1 mt-4">
              {visibleCardFields.map((_, index) => (
                <div
                  key={index}
                  className={`h-1 flex-1 rounded ${
                    index <= currentStep ? 'bg-blue-600' : 'bg-slate-200'
                  }`}
                />
              ))}
            </div>
          </CardHeader>
          <CardContent className="min-h-[300px]">
            {currentField && (
              <FormRenderer
                field={currentField}
                value={formValues[currentField.id]}
                onChange={(value) => setFormValues({ ...formValues, [currentField.id]: value })}
                memberInfo={memberData}
                organizationInfo={organizationInfo}
                disabled={disabledFieldIds.has(currentField.id)}
              />
            )}
          </CardContent>
          <div className="p-6 pt-0 flex flex-col gap-2">
            {!canProceed && currentField?.required && (
              <p className="text-sm text-amber-600 text-center">
                Please complete the required field above to continue
              </p>
            )}
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setCurrentStep(currentStep - 1)}
                disabled={currentStep === 0}
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                Previous
              </Button>
              {isLastStep ? (
                <Button
                  onClick={handleSubmit}
                  disabled={!canProceed || submitFormMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  {submitFormMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    form.submit_button_text
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => setCurrentStep(currentStep + 1)}
                  disabled={!canProceed}
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // Standard layout with optional pages
  const pages = form.pages || [];
  const hasPages = pages.length > 0;
  
  // Get fields for current page (or all fields if no pages)
  // Unassigned fields (page_id === null) are shown on the first page for backwards compatibility
  const getCurrentPageFields = () => {
    if (!hasPages) {
      return form.fields;
    }
    const currentPage = pages[currentPageIndex];
    if (currentPageIndex === 0) {
      // Include unassigned fields on the first page
      return form.fields.filter(f => f.page_id === currentPage?.id || !f.page_id);
    }
    return form.fields.filter(f => f.page_id === currentPage?.id);
  };
  
  // Validate current page fields before proceeding (only visible fields)
  const validateCurrentPage = () => {
    const pageFields = filterVisibleFields(getCurrentPageFields());
    const missingFields = pageFields.filter(field => 
      field.required && (!formValues[field.id] || formValues[field.id].length === 0)
    );
    
    if (missingFields.length > 0) {
      toast.error(`Please fill in required fields: ${missingFields.map(f => f.label).join(', ')}`);
      return false;
    }
    return true;
  };
  
  const goToNextPage = () => {
    if (validateCurrentPage()) {
      setCurrentPageIndex(prev => Math.min(prev + 1, pages.length - 1));
    }
  };
  
  const goToPreviousPage = () => {
    setCurrentPageIndex(prev => Math.max(prev - 1, 0));
  };
  
  const isFirstPage = currentPageIndex === 0;
  const isLastPage = !hasPages || currentPageIndex === pages.length - 1;
  const currentPage = hasPages ? pages[currentPageIndex] : null;
  const displayFields = filterVisibleFields(getCurrentPageFields());

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle>{form.name}</CardTitle>
            {form.description && <CardDescription className="whitespace-pre-line">{form.description}</CardDescription>}
            {/* Page progress indicator */}
            {hasPages && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-slate-600">
                    {currentPage?.title || `Page ${currentPageIndex + 1}`}
                  </span>
                  <span className="text-sm text-slate-500">
                    {currentPageIndex + 1} of {pages.length}
                  </span>
                </div>
                <div className="flex gap-1">
                  {pages.map((_, index) => (
                    <div
                      key={index}
                      className={`h-1.5 flex-1 rounded-full transition-colors ${
                        index <= currentPageIndex ? 'bg-blue-600' : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Render fields in columns if page has column_count > 1 */}
            {(() => {
              const columnCount = currentPage?.column_count || 1;
              
              // Separate unassigned fields (shown on first page for backwards compatibility)
              const unassignedFields = currentPageIndex === 0 
                ? displayFields.filter(f => !f.page_id) 
                : [];
              const pageAssignedFields = displayFields.filter(f => 
                f.page_id === currentPage?.id
              );
              
              if (columnCount === 1) {
                // Single column - render all fields in order
                return displayFields.map(field => (
                  <FormRenderer
                    key={field.id}
                    field={field}
                    value={formValues[field.id]}
                    onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                    memberInfo={memberData}
                    organizationInfo={organizationInfo}
                    disabled={disabledFieldIds.has(field.id)}
                  />
                ));
              }
              
              // Multi-column layout
              const gridClass = columnCount === 2 
                ? 'grid grid-cols-1 md:grid-cols-2 gap-4' 
                : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4';
              
              return (
                <>
                  {/* Render unassigned fields in full-width first (backwards compat) */}
                  {unassignedFields.length > 0 && (
                    <div className="space-y-4 mb-4">
                      {unassignedFields.map(field => (
                        <FormRenderer
                          key={field.id}
                          field={field}
                          value={formValues[field.id]}
                          onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                          memberInfo={memberData}
                          organizationInfo={organizationInfo}
                          disabled={disabledFieldIds.has(field.id)}
                        />
                      ))}
                    </div>
                  )}
                  {/* Render page-assigned fields in columns */}
                  <div className={gridClass}>
                    {Array.from({ length: columnCount }).map((_, colIndex) => {
                      const columnFields = pageAssignedFields.filter(f => 
                        (f.column_index || 0) === colIndex
                      );
                      
                      return (
                        <div key={colIndex} className="space-y-4">
                          {columnFields.map(field => (
                            <FormRenderer
                              key={field.id}
                              field={field}
                              value={formValues[field.id]}
                              onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                              memberInfo={memberData}
                              organizationInfo={organizationInfo}
                              disabled={disabledFieldIds.has(field.id)}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
            <div className="flex justify-between pt-4">
              {/* Previous button (only show if we have pages and not on first page) */}
              {hasPages && !isFirstPage ? (
                <Button
                  variant="outline"
                  onClick={goToPreviousPage}
                >
                  <ChevronLeft className="w-4 h-4 mr-2" />
                  Previous
                </Button>
              ) : (
                <div />
              )}
              
              {/* Next/Submit button */}
              {hasPages && !isLastPage ? (
                <Button
                  onClick={goToNextPage}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-2" />
                </Button>
              ) : (
                <Button
                  onClick={handleSubmit}
                  disabled={submitFormMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  {submitFormMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    form.submit_button_text
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, GripVertical, Save, ArrowLeft, FileText, ChevronDown, ChevronUp, Edit2, X, Eye, EyeOff, Lock, Unlock, UserCheck, UserMinus } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { Columns2, Columns3, ArrowRight, Settings2, Wand2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const STANDARD_FIELD_TYPES = [
  { value: 'text', label: 'Text Input' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'Website URL' },
  { value: 'number', label: 'Number' },
  { value: 'tel', label: 'Phone' },
  { value: 'textarea', label: 'Text Area' },
  { value: 'select', label: 'Dropdown' },
  { value: 'radio', label: 'Radio Buttons' },
  { value: 'checkbox', label: 'Checkboxes' },
  { value: 'boolean', label: 'Boolean (Toggle)' },
  { value: 'list', label: 'List (User-Defined Values)' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'file', label: 'File Upload' },
];

const PREPOPULATE_FIELD_TYPES = [
  { value: 'organisation_dropdown', label: 'Organisation Dropdown' },
  { value: 'category_multiselect', label: 'Category Multi-Select' },
  { value: 'category_dropdown', label: 'Category Dropdown' },
];

const AUTO_FIELD_TYPES = [
  { value: 'user_name', label: 'User Name (Auto)' },
  { value: 'user_email', label: 'User Email (Auto)' },
  { value: 'user_organization', label: 'User Organisation (Auto)' },
  { value: 'user_job_title', label: 'User Job Title (Auto)' },
];

const FIELD_TYPES = [...STANDARD_FIELD_TYPES, ...PREPOPULATE_FIELD_TYPES, ...AUTO_FIELD_TYPES];

const getFieldTypeCategory = (fieldType) => {
  if (STANDARD_FIELD_TYPES.find(f => f.value === fieldType)) return 'standard';
  if (PREPOPULATE_FIELD_TYPES.find(f => f.value === fieldType)) return 'prepopulate';
  if (AUTO_FIELD_TYPES.find(f => f.value === fieldType)) return 'auto';
  return 'standard';
};

const TRANSFORMATIONS = [
  { value: 'none', label: 'No transformation', description: 'Use value as-is' },
  { value: 'trim', label: 'Trim whitespace', description: 'Remove leading/trailing spaces' },
  { value: 'uppercase', label: 'UPPERCASE', description: 'Convert to uppercase' },
  { value: 'lowercase', label: 'lowercase', description: 'Convert to lowercase' },
  { value: 'titlecase', label: 'Title Case', description: 'Capitalize first letter of each word' },
  { value: 'extract_domain', label: 'Extract domain', description: 'Get domain from email (after @)' },
  { value: 'extract_username', label: 'Extract username', description: 'Get username from email (before @)' },
  { value: 'first_word', label: 'First word', description: 'Extract first word only' },
  { value: 'last_word', label: 'Last word', description: 'Extract last word only' },
  { value: 'remove_spaces', label: 'Remove spaces', description: 'Strip all spaces' },
  { value: 'numbers_only', label: 'Numbers only', description: 'Keep only numeric characters' },
  { value: 'current_date', label: 'Current date', description: 'Use current date (ignores source field)' },
];

const MEMBER_CORE_FIELDS = [
  { value: 'email', label: 'Email' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'full_name', label: 'Full Name' },
  { value: 'phone', label: 'Phone' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'landline', label: 'Landline' },
  { value: 'job_title', label: 'Job Title' },
  { value: 'organization_id', label: 'Organisation' },
];

const ORG_CORE_FIELDS = [
  { value: 'name', label: 'Organisation Name' },
  { value: 'invoicing_email', label: 'Invoicing Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'website_url', label: 'Website URL' },
];

const COMPARISON_MODES = [
  { value: 'equals', label: 'Equals (exact match)', forEmail: true, forText: true },
  { value: 'equals_lowercase', label: 'Equals (case insensitive)', forEmail: true, forText: true },
  { value: 'contains', label: 'Contains', forEmail: false, forText: true },
  { value: 'starts_with', label: 'Starts with', forEmail: false, forText: true },
  { value: 'ends_with', label: 'Ends with', forEmail: false, forText: true },
  { value: 'domain_equals', label: 'Domain equals (email or URL)', forEmail: true, forText: true },
];

const UNIQUENESS_TARGET_FIELDS = {
  member: [
    { value: 'member.email', label: 'Member Email', isEmail: true },
    { value: 'member.full_name', label: 'Member Full Name', isEmail: false },
    { value: 'member.phone', label: 'Member Phone', isEmail: false },
    { value: 'member.mobile', label: 'Member Mobile', isEmail: false },
    { value: 'member.landline', label: 'Member Landline', isEmail: false },
  ],
  organization: [
    { value: 'organization.name', label: 'Organisation Name', isEmail: false },
    { value: 'organization.invoicing_email', label: 'Invoicing Email', isEmail: true },
    { value: 'organization.phone', label: 'Organisation Phone', isEmail: false },
    { value: 'organization.website_url', label: 'Website URL', isEmail: false },
  ]
};

function FieldMappingSection({ 
  fields, 
  fieldMappings = [], 
  onMappingsChange,
  applicationLevel = "member",
  customFields = []
}) {
  const addMapping = () => {
    const newMapping = {
      id: `mapping_${Date.now()}`,
      source_type: 'field', // 'field' or 'static'
      source_field_id: '',
      static_value: '',
      target_type: 'core', // 'core' or 'custom'
      target_entity: applicationLevel === 'member' ? 'member' : 'organization',
      target_field: '',
      transformation: 'none'
    };
    onMappingsChange([...fieldMappings, newMapping]);
  };

  const updateMapping = (mappingId, updates) => {
    console.log('[FieldMapping] updateMapping called:', mappingId, updates);
    try {
      const newMappings = fieldMappings.map(m => 
        m.id === mappingId ? { ...m, ...updates } : m
      );
      console.log('[FieldMapping] New mappings:', newMappings);
      onMappingsChange(newMappings);
    } catch (error) {
      console.error('[FieldMapping] Error updating mapping:', error);
      toast.error(`Failed to update mapping: ${error.message}`);
    }
  };

  const removeMapping = (mappingId) => {
    onMappingsChange(fieldMappings.filter(m => m.id !== mappingId));
  };

  const getAvailableCoreFields = (targetEntity) => {
    return targetEntity === 'member' ? MEMBER_CORE_FIELDS : ORG_CORE_FIELDS;
  };

  const getAvailableCustomFields = (targetEntity) => {
    return customFields.filter(cf => cf.entity_scope === targetEntity);
  };

  const getCustomFieldById = (fieldId) => {
    return customFields.find(cf => cf.id === fieldId);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Settings2 className="w-4 h-4" />
            Field Mappings
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Map form fields or set fixed values for member/organisation records
          </p>
        </div>
        <Button 
          onClick={addMapping} 
          size="sm" 
          variant="outline"
          data-testid="button-add-mapping"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Mapping
        </Button>
      </div>

      {fieldMappings.length === 0 ? (
        <div className="text-center py-8 text-slate-400 border border-dashed border-slate-200 rounded-lg">
          <Wand2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No field mappings defined</p>
          <p className="text-xs mt-1">Add mappings to save form data to member/organisation profiles</p>
        </div>
      ) : (
        <div className="space-y-3">
          {fieldMappings.map((mapping, index) => {
            const sourceType = mapping.source_type || 'field';
            const targetCustomField = mapping.target_type === 'custom' ? getCustomFieldById(mapping.target_field) : null;
            const hasOptions = targetCustomField && targetCustomField.options && targetCustomField.options.length > 0;
            
            return (
              <div 
                key={mapping.id} 
                className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3"
                data-testid={`mapping-row-${index}`}
              >
                {/* First row: Source Type Selection + Source Value */}
                <div className="flex flex-wrap items-end gap-3">
                  {/* Source Type */}
                  <div className="space-y-1 min-w-[100px]">
                    <Label className="text-xs">Source</Label>
                    <Select
                      value={sourceType}
                      onValueChange={(value) => updateMapping(mapping.id, { 
                        source_type: value, 
                        source_field_id: '',
                        static_value: ''
                      })}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-source-type-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="field">Form Field</SelectItem>
                        <SelectItem value="static">Fixed Value</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Source Field or Static Value */}
                  {sourceType === 'field' ? (
                    <div className="space-y-1 min-w-[160px] flex-1">
                      <Label className="text-xs">Form Field</Label>
                      <Select
                        value={mapping.source_field_id || undefined}
                        onValueChange={(value) => {
                          console.log('[FieldMapping] Source field changed to:', value);
                          if (value) {
                            updateMapping(mapping.id, { source_field_id: value });
                          }
                        }}
                      >
                        <SelectTrigger className="h-9" data-testid={`select-source-${index}`}>
                          <SelectValue placeholder="Select field..." />
                        </SelectTrigger>
                        <SelectContent>
                          {fields.map(field => (
                            <SelectItem key={field.id} value={field.id}>
                              {field.label || field.type}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="space-y-1 min-w-[160px] flex-1">
                      <Label className="text-xs">Fixed Value</Label>
                      {hasOptions ? (
                        <Select
                          value={mapping.static_value || ''}
                          onValueChange={(value) => updateMapping(mapping.id, { static_value: value })}
                        >
                          <SelectTrigger className="h-9" data-testid={`select-static-value-${index}`}>
                            <SelectValue placeholder="Select value..." />
                          </SelectTrigger>
                          <SelectContent>
                            {targetCustomField.options.map((opt, optIdx) => (
                              <SelectItem key={optIdx} value={opt.value}>
                                {opt.label || opt.value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={mapping.static_value || ''}
                          onChange={(e) => updateMapping(mapping.id, { static_value: e.target.value })}
                          placeholder="Enter value..."
                          className="h-9"
                          data-testid={`input-static-value-${index}`}
                        />
                      )}
                    </div>
                  )}

                  {/* Arrow */}
                  <div className="hidden sm:flex items-center justify-center pb-2">
                    <ArrowRight className="w-4 h-4 text-slate-400" />
                  </div>

                  {/* Target Type */}
                  <div className="space-y-1 min-w-[100px]">
                    <Label className="text-xs">Type</Label>
                    <Select
                      value={mapping.target_type}
                      onValueChange={(value) => updateMapping(mapping.id, { 
                        target_type: value, 
                        target_field: '',
                        static_value: ''
                      })}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-target-type-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="core">Core</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Target Entity */}
                  <div className="space-y-1 min-w-[110px]">
                    <Label className="text-xs">Entity</Label>
                    <Select
                      value={mapping.target_entity}
                      onValueChange={(value) => updateMapping(mapping.id, { 
                        target_entity: value, 
                        target_field: '',
                        static_value: ''
                      })}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-target-entity-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="organization">Organisation</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Target Field */}
                  <div className="space-y-1 min-w-[140px] flex-1">
                    <Label className="text-xs">Target Field</Label>
                    <Select
                      value={mapping.target_field || undefined}
                      onValueChange={(value) => {
                        console.log('[FieldMapping] Target field changed to:', value);
                        if (value && value !== '__none') {
                          updateMapping(mapping.id, { target_field: value, static_value: '' });
                        }
                      }}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-target-field-${index}`}>
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {mapping.target_type === 'core' ? (
                          getAvailableCoreFields(mapping.target_entity).map(f => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))
                        ) : (
                          getAvailableCustomFields(mapping.target_entity).length === 0 ? (
                            <SelectItem value="__none" disabled>No custom fields available</SelectItem>
                          ) : (
                            getAvailableCustomFields(mapping.target_entity).map(f => (
                              <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
                            ))
                          )
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Delete */}
                  <div className="flex items-end pb-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeMapping(mapping.id)}
                      className="h-9 w-9 text-red-600 hover:text-red-700 hover:bg-red-50"
                      data-testid={`button-delete-mapping-${index}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Transformation row - only show for field mappings */}
                {sourceType === 'field' && (
                  <div className="flex items-center gap-3 pt-2 border-t border-slate-200">
                    <Wand2 className="w-4 h-4 text-slate-400" />
                    <Label className="text-xs text-slate-600 whitespace-nowrap">Transform:</Label>
                    <Select
                      value={mapping.transformation}
                      onValueChange={(value) => updateMapping(mapping.id, { transformation: value })}
                    >
                      <SelectTrigger className="h-8 flex-1 max-w-xs" data-testid={`select-transformation-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRANSFORMATIONS.map(t => (
                          <SelectItem key={t.value} value={t.value}>
                            <span>{t.label}</span>
                            <span className="text-xs text-slate-400 ml-2">- {t.description}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const VISIBILITY_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_empty', label: 'Is not empty' },
  { value: 'is_empty', label: 'Is empty' },
];

const RULE_TYPES = [
  { value: 'visibility', label: 'Show/Hide Fields', icon: Eye, description: 'Control field visibility' },
  { value: 'set_value', label: 'Set Field Value', icon: Edit2, description: 'Set a field value' },
];

function LogicRulesSection({ 
  fields, 
  visibilityRules = [], 
  onRulesChange,
  prefillSource = 'none',
  customFields = [],
  roles = []
}) {
  // Normalize rules to new multi-action format (for backward compatibility)
  const normalizeRule = (rule) => {
    // If rule already has actions array, it's in new format
    if (rule.actions && Array.isArray(rule.actions)) {
      return rule;
    }
    // Convert old format to new format
    const actions = [];
    if (rule.rule_type === 'set_value' || rule.action === 'set_value') {
      actions.push({
        id: `action_${Date.now()}_1`,
        action_type: 'set_value',
        target_field_id: rule.target_field_id || '',
        set_value_source: rule.set_value_source || 'static',
        set_value: rule.set_value || '',
        set_value_field_id: rule.set_value_field_id || '',
        set_value_prefill_field: rule.set_value_prefill_field || ''
      });
    } else {
      // Visibility rule
      actions.push({
        id: `action_${Date.now()}_1`,
        action_type: rule.action || 'show',
        target_field_ids: rule.target_field_ids || []
      });
    }
    return {
      id: rule.id,
      trigger_field_id: rule.trigger_field_id,
      operator: rule.operator,
      value: rule.value,
      actions
    };
  };

  const addRule = () => {
    const newRule = {
      id: `rule_${Date.now()}`,
      trigger_field_id: '',
      operator: 'equals',
      value: '',
      actions: [] // Start with empty actions, user adds them
    };
    onRulesChange([...visibilityRules, newRule]);
  };

  const addAction = (ruleId, actionType = 'show') => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    let newAction;
    
    if (actionType === 'set_value') {
      newAction = {
        id: `action_${Date.now()}`,
        action_type: 'set_value',
        target_field_id: '',
        set_value_source: 'static',
        set_value: '',
        set_value_field_id: '',
        set_value_prefill_field: ''
      };
    } else if (actionType === 'set_role') {
      newAction = {
        id: `action_${Date.now()}`,
        action_type: 'set_role',
        role_id: ''
      };
    } else if (actionType === 'clear_role') {
      newAction = {
        id: `action_${Date.now()}`,
        action_type: 'clear_role'
      };
    } else {
      newAction = {
        id: `action_${Date.now()}`,
        action_type: actionType, // 'show', 'hide', 'disable', 'enable'
        target_field_ids: []
      };
    }
    
    const updatedActions = [...(normalizedRule.actions || []), newAction];
    updateRule(ruleId, { actions: updatedActions });
  };

  const updateAction = (ruleId, actionId, updates) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    const updatedActions = (normalizedRule.actions || []).map(a => 
      a.id === actionId ? { ...a, ...updates } : a
    );
    updateRule(ruleId, { actions: updatedActions });
  };

  const removeAction = (ruleId, actionId) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    const updatedActions = (normalizedRule.actions || []).filter(a => a.id !== actionId);
    updateRule(ruleId, { actions: updatedActions });
  };

  const toggleTargetFieldInAction = (ruleId, actionId, fieldId) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    const action = (normalizedRule.actions || []).find(a => a.id === actionId);
    if (!action) return;
    
    const currentTargets = action.target_field_ids || [];
    const newTargets = currentTargets.includes(fieldId)
      ? currentTargets.filter(id => id !== fieldId)
      : [...currentTargets, fieldId];
    
    updateAction(ruleId, actionId, { target_field_ids: newTargets });
  };
  
  const getPrefillFields = () => {
    if (prefillSource === 'none') return [];
    
    const coreFields = prefillSource === 'member' ? MEMBER_CORE_FIELDS : ORG_CORE_FIELDS;
    const entityCustomFields = customFields.filter(cf => cf.entity_scope === (prefillSource === 'member' ? 'member' : 'organization'));
    
    return [
      ...coreFields.map(f => ({ value: `core.${f.value}`, label: f.label, group: 'Core Fields' })),
      ...entityCustomFields.map(f => ({ value: `custom.${f.id}`, label: f.label, group: 'Custom Fields' }))
    ];
  };

  const updateRule = (ruleId, updates) => {
    const newRules = visibilityRules.map(r => 
      r.id === ruleId ? { ...r, ...updates } : r
    );
    onRulesChange(newRules);
  };

  const removeRule = (ruleId) => {
    onRulesChange(visibilityRules.filter(r => r.id !== ruleId));
  };

  // Legacy function - kept for potential backward compatibility but no longer used
  const toggleTargetField = (ruleId, fieldId) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const currentTargets = rule.target_field_ids || [];
    const newTargets = currentTargets.includes(fieldId)
      ? currentTargets.filter(id => id !== fieldId)
      : [...currentTargets, fieldId];
    
    updateRule(ruleId, { target_field_ids: newTargets });
  };

  const getTriggerFieldOptions = (triggerFieldId) => {
    const field = fields.find(f => f.id === triggerFieldId);
    if (!field) return [];
    
    if (field.type === 'select' || field.type === 'radio') {
      return field.options || [];
    }
    if (field.type === 'checkbox') {
      return field.options || [];
    }
    return [];
  };

  const getTargetFieldOptions = (targetFieldId) => {
    const field = fields.find(f => f.id === targetFieldId);
    if (!field) return { type: 'text', options: [] };
    
    const hasOptions = ['select', 'radio', 'checkbox'].includes(field.type);
    return {
      type: field.type,
      options: hasOptions ? (field.options || []) : []
    };
  };

  const renderSetValueInput = (ruleId, action, actionIndex) => {
    const targetInfo = getTargetFieldOptions(action.target_field_id);
    const sourceType = action.set_value_source || 'static';
    const availableSourceFields = fields.filter(f => f.id !== action.target_field_id);
    const prefillFields = getPrefillFields();
    const hasPrefill = prefillSource !== 'none';
    
    if (!action.target_field_id) {
      return <p className="text-xs text-slate-400">Select a target field first</p>;
    }

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Label className="text-xs text-slate-600 whitespace-nowrap">Value from:</Label>
          <div className="flex gap-1 flex-wrap">
            <Button
              variant={sourceType === 'static' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => updateAction(ruleId, action.id, { set_value_source: 'static', set_value_field_id: '', set_value_prefill_field: '' })}
              data-testid={`button-source-static-${actionIndex}`}
            >
              Enter Text
            </Button>
            <Button
              variant={sourceType === 'field' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => updateAction(ruleId, action.id, { set_value_source: 'field', set_value: '', set_value_prefill_field: '' })}
              data-testid={`button-source-field-${actionIndex}`}
            >
              From Field
            </Button>
            {hasPrefill && (
              <Button
                variant={sourceType === 'prefill' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => updateAction(ruleId, action.id, { set_value_source: 'prefill', set_value: '', set_value_field_id: '' })}
                data-testid={`button-source-prefill-${actionIndex}`}
              >
                From Pre-fill Data
              </Button>
            )}
          </div>
        </div>

        {sourceType === 'prefill' ? (
          <Select
            value={action.set_value_prefill_field || undefined}
            onValueChange={(value) => updateAction(ruleId, action.id, { set_value_prefill_field: value })}
          >
            <SelectTrigger className="h-9" data-testid={`select-prefill-field-${actionIndex}`}>
              <SelectValue placeholder={`Select ${prefillSource} field...`} />
            </SelectTrigger>
            <SelectContent>
              {prefillFields.map(field => (
                <SelectItem key={field.value} value={field.value}>
                  {field.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : sourceType === 'field' ? (
          <Select
            value={action.set_value_field_id || undefined}
            onValueChange={(value) => updateAction(ruleId, action.id, { set_value_field_id: value })}
          >
            <SelectTrigger className="h-9" data-testid={`select-source-field-${actionIndex}`}>
              <SelectValue placeholder="Select field to copy value from..." />
            </SelectTrigger>
            <SelectContent>
              {availableSourceFields.map(field => (
                <SelectItem key={field.id} value={field.id}>
                  {field.label || field.type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <>
            {targetInfo.options.length > 0 ? (
              targetInfo.type === 'checkbox' ? (
                <div className="space-y-2">
                  <Label className="text-xs text-slate-600">Select values to set:</Label>
                  <div className="flex flex-wrap gap-2">
                    {targetInfo.options.map((opt, optIdx) => {
                      const optValue = typeof opt === 'string' ? opt : (opt.value || opt);
                      const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || opt);
                      const currentValues = Array.isArray(action.set_value) ? action.set_value : [];
                      const isSelected = currentValues.includes(optValue);
                      return (
                        <Button
                          key={optIdx}
                          variant={isSelected ? "default" : "outline"}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            const newValues = isSelected
                              ? currentValues.filter(v => v !== optValue)
                              : [...currentValues, optValue];
                            updateAction(ruleId, action.id, { set_value: newValues });
                          }}
                          data-testid={`button-set-value-option-${actionIndex}-${optIdx}`}
                        >
                          {optLabel}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <Select
                  value={action.set_value || undefined}
                  onValueChange={(value) => updateAction(ruleId, action.id, { set_value: value })}
                >
                  <SelectTrigger className="h-9" data-testid={`select-set-value-${actionIndex}`}>
                    <SelectValue placeholder="Select value to set..." />
                  </SelectTrigger>
                  <SelectContent>
                    {targetInfo.options.map((opt, optIdx) => (
                      <SelectItem 
                        key={optIdx} 
                        value={typeof opt === 'string' ? opt : (opt.value || opt)}
                      >
                        {typeof opt === 'string' ? opt : (opt.label || opt.value || opt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            ) : targetInfo.type === 'date' ? (
              <Input
                type="date"
                value={action.set_value || ''}
                onChange={(e) => updateAction(ruleId, action.id, { set_value: e.target.value })}
                className="h-9"
                data-testid={`input-set-value-date-${actionIndex}`}
              />
            ) : targetInfo.type === 'number' ? (
              <Input
                type="number"
                value={action.set_value || ''}
                onChange={(e) => updateAction(ruleId, action.id, { set_value: e.target.value })}
                placeholder="Enter number..."
                className="h-9"
                data-testid={`input-set-value-number-${actionIndex}`}
              />
            ) : (
              <Input
                value={action.set_value || ''}
                onChange={(e) => updateAction(ruleId, action.id, { set_value: e.target.value })}
                placeholder="Enter value to set..."
                className="h-9"
                data-testid={`input-set-value-${actionIndex}`}
              />
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Settings2 className="w-4 h-4" />
            Conditional Logic Rules
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Define conditions that trigger one or more actions (show/hide fields or set values)
          </p>
        </div>
        <Button 
          onClick={addRule} 
          size="sm" 
          variant="outline"
          data-testid="button-add-rule"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Rule
        </Button>
      </div>

      {visibilityRules.length === 0 ? (
        <div className="text-center py-8 text-slate-400 border border-dashed border-slate-200 rounded-lg">
          <Settings2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No conditional logic rules defined</p>
          <p className="text-xs mt-1">Add rules to show/hide fields or set values based on user responses</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibilityRules.map((rule, index) => {
            const normalizedRule = normalizeRule(rule);
            const triggerField = fields.find(f => f.id === normalizedRule.trigger_field_id);
            const triggerOptions = getTriggerFieldOptions(normalizedRule.trigger_field_id);
            const needsValueInput = normalizedRule.operator !== 'is_empty' && normalizedRule.operator !== 'not_empty';
            const availableTargetFields = fields.filter(f => f.id !== normalizedRule.trigger_field_id);
            const actions = normalizedRule.actions || [];
            
            return (
              <div 
                key={rule.id} 
                className="p-4 border rounded-lg space-y-3 bg-slate-50 border-slate-200"
                data-testid={`rule-row-${index}`}
              >
                {/* Trigger Condition Header */}
                <div className="flex items-center gap-2 mb-2">
                  <Settings2 className="w-4 h-4 text-slate-600" />
                  <span className="text-xs font-medium text-slate-600">
                    Rule #{index + 1} ({actions.length} action{actions.length !== 1 ? 's' : ''})
                  </span>
                </div>

                {/* Trigger Condition Row */}
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1 min-w-[80px]">
                    <Label className="text-xs">When</Label>
                    <Select
                      value={normalizedRule.trigger_field_id || undefined}
                      onValueChange={(value) => {
                        if (value) {
                          updateRule(rule.id, { trigger_field_id: value, value: '' });
                        }
                      }}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-trigger-field-${index}`}>
                        <SelectValue placeholder="Select field..." />
                      </SelectTrigger>
                      <SelectContent>
                        {fields.map(field => (
                          <SelectItem key={field.id} value={field.id}>
                            {field.label || field.type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1 min-w-[120px]">
                    <Label className="text-xs">Condition</Label>
                    <Select
                      value={normalizedRule.operator}
                      onValueChange={(value) => updateRule(rule.id, { operator: value })}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-operator-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VISIBILITY_OPERATORS.map(op => (
                          <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {needsValueInput && (
                    <div className="space-y-1 min-w-[140px] flex-1">
                      <Label className="text-xs">Value</Label>
                      {triggerOptions.length > 0 ? (
                        <Select
                          value={normalizedRule.value || undefined}
                          onValueChange={(value) => updateRule(rule.id, { value })}
                        >
                          <SelectTrigger className="h-9" data-testid={`select-value-${index}`}>
                            <SelectValue placeholder="Select value..." />
                          </SelectTrigger>
                          <SelectContent>
                            {triggerOptions.map((opt, optIdx) => (
                              <SelectItem key={optIdx} value={typeof opt === 'string' ? opt : opt.value || opt}>
                                {typeof opt === 'string' ? opt : opt.label || opt.value || opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={normalizedRule.value || ''}
                          onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                          placeholder="Enter value..."
                          className="h-9"
                          data-testid={`input-value-${index}`}
                        />
                      )}
                    </div>
                  )}

                  <div className="flex items-end pb-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeRule(rule.id)}
                      className="h-9 w-9 text-red-600 hover:text-red-700 hover:bg-red-50"
                      data-testid={`button-delete-rule-${index}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Actions Section */}
                <div className="pt-3 border-t border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-slate-600">Actions</Label>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'show')}
                        data-testid={`button-add-show-action-${index}`}
                      >
                        <Eye className="w-3 h-3 mr-1" /> Show
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'hide')}
                        data-testid={`button-add-hide-action-${index}`}
                      >
                        <EyeOff className="w-3 h-3 mr-1" /> Hide
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'set_value')}
                        data-testid={`button-add-setvalue-action-${index}`}
                      >
                        <Edit2 className="w-3 h-3 mr-1" /> Set Value
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'disable')}
                        data-testid={`button-add-disable-action-${index}`}
                      >
                        <Lock className="w-3 h-3 mr-1" /> Disable
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'enable')}
                        data-testid={`button-add-enable-action-${index}`}
                      >
                        <Unlock className="w-3 h-3 mr-1" /> Enable
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'set_role')}
                        data-testid={`button-add-setrole-action-${index}`}
                      >
                        <UserCheck className="w-3 h-3 mr-1" /> Set Role
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'clear_role')}
                        data-testid={`button-add-clearrole-action-${index}`}
                      >
                        <UserMinus className="w-3 h-3 mr-1" /> Clear Role
                      </Button>
                    </div>
                  </div>

                  {actions.length === 0 ? (
                    <div className="text-center py-4 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                      <p className="text-xs">No actions defined. Add an action above.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {actions.map((action, actionIndex) => {
                        const isVisibilityAction = action.action_type === 'show' || action.action_type === 'hide';
                        const isDisabilityAction = action.action_type === 'disable' || action.action_type === 'enable';
                        const isFieldTargetAction = isVisibilityAction || isDisabilityAction;
                        const isRoleAction = action.action_type === 'set_role' || action.action_type === 'clear_role';
                        
                        return (
                          <div 
                            key={action.id} 
                            className={`p-3 rounded-lg border ${isVisibilityAction ? 'bg-white border-slate-200' : isDisabilityAction ? 'bg-orange-50 border-orange-200' : isRoleAction ? 'bg-purple-50 border-purple-200' : 'bg-blue-50 border-blue-200'}`}
                            data-testid={`action-row-${index}-${actionIndex}`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                {action.action_type === 'show' && <Eye className="w-3 h-3 text-green-600" />}
                                {action.action_type === 'hide' && <EyeOff className="w-3 h-3 text-slate-600" />}
                                {action.action_type === 'set_value' && <Edit2 className="w-3 h-3 text-blue-600" />}
                                {action.action_type === 'disable' && <Lock className="w-3 h-3 text-orange-600" />}
                                {action.action_type === 'enable' && <Unlock className="w-3 h-3 text-teal-600" />}
                                {action.action_type === 'set_role' && <UserCheck className="w-3 h-3 text-purple-600" />}
                                {action.action_type === 'clear_role' && <UserMinus className="w-3 h-3 text-gray-600" />}
                                <span className="text-xs font-medium">
                                  {action.action_type === 'show' && 'Show Fields'}
                                  {action.action_type === 'hide' && 'Hide Fields'}
                                  {action.action_type === 'set_value' && 'Set Field Value'}
                                  {action.action_type === 'disable' && 'Disable Fields'}
                                  {action.action_type === 'enable' && 'Enable Fields'}
                                  {action.action_type === 'set_role' && 'Set Member Role'}
                                  {action.action_type === 'clear_role' && 'Clear Member Role'}
                                </span>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => removeAction(rule.id, action.id)}
                                className="h-6 w-6 text-red-500 hover:text-red-600 hover:bg-red-50"
                                data-testid={`button-delete-action-${index}-${actionIndex}`}
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>

                            {isFieldTargetAction ? (
                              <div>
                                <Label className="text-xs text-slate-600 mb-2 block">
                                  Target Fields ({(action.target_field_ids || []).length} selected)
                                </Label>
                                {availableTargetFields.length === 0 ? (
                                  <p className="text-xs text-slate-400">Add more fields to select targets</p>
                                ) : (
                                  <div className="flex flex-wrap gap-2">
                                    {availableTargetFields.map(field => {
                                      const isSelected = (action.target_field_ids || []).includes(field.id);
                                      const ActionIcon = isDisabilityAction 
                                        ? (isSelected ? Lock : Unlock) 
                                        : (isSelected ? Eye : EyeOff);
                                      return (
                                        <Button
                                          key={field.id}
                                          variant={isSelected ? "default" : "outline"}
                                          size="sm"
                                          className="h-7 text-xs"
                                          onClick={() => toggleTargetFieldInAction(rule.id, action.id, field.id)}
                                          data-testid={`button-action-target-${index}-${actionIndex}-${field.id}`}
                                        >
                                          <ActionIcon className="w-3 h-3 mr-1" />
                                          {field.label || field.type}
                                        </Button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ) : action.action_type === 'set_role' ? (
                              <div className="space-y-2">
                                <Label className="text-xs text-slate-600">Select Role</Label>
                                {roles.length === 0 ? (
                                  <p className="text-xs text-slate-400">No roles available. Create roles first.</p>
                                ) : (
                                  <Select
                                    value={action.role_id || undefined}
                                    onValueChange={(value) => updateAction(rule.id, action.id, { role_id: value })}
                                  >
                                    <SelectTrigger className="h-9" data-testid={`select-role-${index}-${actionIndex}`}>
                                      <SelectValue placeholder="Select a role..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {roles.map(role => (
                                        <SelectItem key={role.id} value={role.id}>
                                          {role.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}
                              </div>
                            ) : action.action_type === 'clear_role' ? (
                              <div className="text-xs text-slate-500">
                                This action will remove any role assignment when the condition is met.
                              </div>
                            ) : (
                              <div className="space-y-3">
                                <div className="space-y-1">
                                  <Label className="text-xs text-slate-600">Target Field</Label>
                                  <Select
                                    value={action.target_field_id || undefined}
                                    onValueChange={(value) => {
                                      if (value) {
                                        updateAction(rule.id, action.id, { target_field_id: value, set_value: '' });
                                      }
                                    }}
                                  >
                                    <SelectTrigger className="h-9" data-testid={`select-action-target-${index}-${actionIndex}`}>
                                      <SelectValue placeholder="Select field to set..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {availableTargetFields.map(field => (
                                        <SelectItem key={field.id} value={field.id}>
                                          {field.label || field.type} ({field.type})
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs text-slate-600">Set To</Label>
                                  {renderSetValueInput(rule.id, action, actionIndex)}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Define prefill source fields
const MEMBER_PREFILL_FIELDS = [
  { value: 'email', label: 'Email' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'full_name', label: 'Full Name' },
  { value: 'phone', label: 'Phone' },
  { value: 'job_title', label: 'Job Title' },
];

const ORG_PREFILL_FIELDS = [
  { value: 'name', label: 'Organisation Name' },
  { value: 'invoicing_email', label: 'Invoicing Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'invoicing_address', label: 'Invoicing Address' },
  { value: 'website_url', label: 'Website URL' },
];

function FieldCard({ 
  field, 
  index, 
  originalIndex, 
  updateField, 
  removeField, 
  FIELD_TYPES, 
  categories = [],
  customFields = [],
  isApplicationForm = false,
  applicationLevel = "member",
  uniquenessChecks = [],
  onUniquenessChange,
  prefillSource = "none"
}) {
  const isEmailType = field.type === 'email' || field.type === 'user_email';
  const isUrlType = field.type === 'url';
  const uniquenessCheck = uniquenessChecks.find(u => u.field_id === field.id);
  const isUniquenessEnabled = !!uniquenessCheck;
  const targetField = uniquenessCheck?.target_field || '';
  const comparisonMode = uniquenessCheck?.comparison_mode || 'equals_lowercase';

  // Get available target fields based on application level
  const availableTargets = [
    ...UNIQUENESS_TARGET_FIELDS.member,
    ...UNIQUENESS_TARGET_FIELDS.organization
  ];
  
  // Determine if current target field is email type
  const currentTargetConfig = availableTargets.find(t => t.value === targetField);
  const isTargetEmail = currentTargetConfig?.isEmail || false;
  
  // Filter comparison modes based on target field type
  const availableComparisonModes = COMPARISON_MODES.filter(mode => 
    isTargetEmail ? mode.forEmail : mode.forText
  );

  const handleUniquenessToggle = (enabled) => {
    if (onUniquenessChange) {
      // Smart defaults based on field type and application level
      let defaultTarget;
      let defaultComparison;
      
      if (isEmailType) {
        defaultTarget = applicationLevel === 'member' ? 'member.email' : 'organization.invoicing_email';
        defaultComparison = 'equals_lowercase';
      } else if (isUrlType) {
        // URL fields default to domain comparison against email
        defaultTarget = applicationLevel === 'member' ? 'member.email' : 'organization.invoicing_email';
        defaultComparison = 'domain_equals';
      } else {
        defaultTarget = applicationLevel === 'member' ? 'member.full_name' : 'organization.name';
        defaultComparison = 'equals_lowercase';
      }
      
      onUniquenessChange(field.id, enabled, { target_field: defaultTarget, comparison_mode: defaultComparison });
    }
  };

  const handleUniquenessUpdate = (updates) => {
    if (onUniquenessChange) {
      let newTargetField = updates.target_field ?? targetField;
      let newComparisonMode = updates.comparison_mode ?? comparisonMode;
      
      // If target field changed, validate comparison mode is still valid
      if (updates.target_field) {
        const newTargetConfig = availableTargets.find(t => t.value === updates.target_field);
        const isNewTargetEmail = newTargetConfig?.isEmail || false;
        const validModes = COMPARISON_MODES.filter(m => isNewTargetEmail ? m.forEmail : m.forText);
        
        // Reset to default if current mode is invalid for new target
        if (!validModes.find(m => m.value === newComparisonMode)) {
          newComparisonMode = 'equals_lowercase';
        }
      }
      
      onUniquenessChange(field.id, true, { 
        target_field: newTargetField, 
        comparison_mode: newComparisonMode 
      });
    }
  };

  return (
    <Draggable draggableId={field.id} index={index}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className="bg-white rounded-lg p-4 border border-slate-200 shadow-sm"
        >
          <div className="flex items-start gap-3">
            <div {...provided.dragHandleProps} className="mt-2 cursor-move">
              <GripVertical className="w-5 h-5 text-slate-400" />
            </div>
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Standard Fields</Label>
                  <Select
                    value={getFieldTypeCategory(field.type) === 'standard' ? field.type : ''}
                    onValueChange={(value) => {
                      if (value) updateField(originalIndex, { type: value });
                    }}
                  >
                    <SelectTrigger className="h-9" data-testid={`select-standard-type-${field.id}`}>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60 overflow-y-auto">
                      {STANDARD_FIELD_TYPES.map(type => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Pre-populate Fields</Label>
                  <Select
                    value={
                      field.type === 'custom_field' 
                        ? `custom_field:${field.custom_field_id}` 
                        : (getFieldTypeCategory(field.type) === 'prepopulate' ? field.type : '')
                    }
                    onValueChange={(value) => {
                      if (value) {
                        if (value.startsWith('custom_field:')) {
                          const customFieldId = value.replace('custom_field:', '');
                          const cf = customFields.find(c => c.id === customFieldId);
                          updateField(originalIndex, { 
                            type: 'custom_field', 
                            custom_field_id: customFieldId,
                            label: cf?.label || field.label
                          });
                        } else {
                          updateField(originalIndex, { type: value, custom_field_id: null });
                        }
                      }
                    }}
                  >
                    <SelectTrigger className="h-9" data-testid={`select-prepopulate-type-${field.id}`}>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60 overflow-y-auto">
                      {PREPOPULATE_FIELD_TYPES.map(type => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                      {customFields.length > 0 && (
                        <>
                          <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50 border-t">
                            Custom Fields
                          </div>
                          {customFields.map(cf => (
                            <SelectItem key={`custom_field:${cf.id}`} value={`custom_field:${cf.id}`}>
                              {cf.label}
                            </SelectItem>
                          ))}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Auto-populate Fields</Label>
                  <Select
                    value={getFieldTypeCategory(field.type) === 'auto' ? field.type : ''}
                    onValueChange={(value) => {
                      if (value) updateField(originalIndex, { type: value });
                    }}
                  >
                    <SelectTrigger className="h-9" data-testid={`select-auto-type-${field.id}`}>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60 overflow-y-auto">
                      {AUTO_FIELD_TYPES.map(type => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label</Label>
                <Input
                  value={field.label}
                  onChange={(e) => updateField(originalIndex, { label: e.target.value })}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Placeholder</Label>
                <Input
                  value={field.placeholder}
                  onChange={(e) => updateField(originalIndex, { placeholder: e.target.value })}
                  className="h-9"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Description (Optional)</Label>
                <Textarea
                  value={field.description || ''}
                  onChange={(e) => updateField(originalIndex, { description: e.target.value })}
                  placeholder="Help text displayed below the field label"
                  className="text-sm min-h-[60px]"
                  rows={2}
                />
              </div>

              {/* Pre-fill Field Selection - When prefill is enabled */}
              {prefillSource !== "none" && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                  <Label className="text-xs font-medium text-blue-800">Pre-fill from {prefillSource === "member" ? "Member" : "Organisation"}</Label>
                  <Select
                    value={field.prefill_field || "_none"}
                    onValueChange={(value) => updateField(originalIndex, { prefill_field: value === "_none" ? null : value })}
                  >
                    <SelectTrigger className="h-8 text-xs" data-testid={`select-prefill-field-${field.id}`}>
                      <SelectValue placeholder="Select field to pre-fill from..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No pre-fill</SelectItem>
                      <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                        Core Fields
                      </div>
                      {(prefillSource === "member" ? MEMBER_PREFILL_FIELDS : ORG_PREFILL_FIELDS).map(f => (
                        <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                      ))}
                      {customFields.filter(cf => 
                        prefillSource === "member" 
                          ? (!cf.entity_scope || cf.entity_scope === 'member')
                          : cf.entity_scope === 'organization'
                      ).length > 0 && (
                        <>
                          <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                            Custom Fields
                          </div>
                          {customFields.filter(cf => 
                            prefillSource === "member" 
                              ? (!cf.entity_scope || cf.entity_scope === 'member')
                              : cf.entity_scope === 'organization'
                          ).map(cf => (
                            <SelectItem key={`custom:${cf.id}`} value={`custom:${cf.id}`}>{cf.label}</SelectItem>
                          ))}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Uniqueness Check - Only for Application Forms */}
              {isApplicationForm && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`uniqueness-${field.id}`}
                      checked={isUniquenessEnabled}
                      onCheckedChange={handleUniquenessToggle}
                      data-testid={`checkbox-uniqueness-${field.id}`}
                    />
                    <Label htmlFor={`uniqueness-${field.id}`} className="text-xs font-medium cursor-pointer">
                      Check for uniqueness
                    </Label>
                  </div>
                  
                  {isUniquenessEnabled && (
                    <div className="ml-6 space-y-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-slate-600">Compare against:</Label>
                        <Select
                          value={targetField}
                          onValueChange={(value) => handleUniquenessUpdate({ target_field: value })}
                        >
                          <SelectTrigger className="h-8 text-xs" data-testid={`select-uniqueness-target-${field.id}`}>
                            <SelectValue placeholder="Select target field..." />
                          </SelectTrigger>
                          <SelectContent>
                            <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                              Member Fields
                            </div>
                            {UNIQUENESS_TARGET_FIELDS.member.map(t => (
                              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                            ))}
                            <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                              Organisation Fields
                            </div>
                            {UNIQUENESS_TARGET_FIELDS.organization.map(t => (
                              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      
                      <div className="space-y-1">
                        <Label className="text-xs text-slate-600">Comparison logic:</Label>
                        <Select
                          value={comparisonMode}
                          onValueChange={(value) => handleUniquenessUpdate({ comparison_mode: value })}
                        >
                          <SelectTrigger className="h-8 text-xs" data-testid={`select-uniqueness-comparison-${field.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {availableComparisonModes.map(mode => (
                              <SelectItem key={mode.value} value={mode.value}>
                                {mode.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      
                      {targetField && (
                        <p className="text-xs text-amber-700">
                          Will check if submitted value already exists in {targetField.replace('.', ' → ')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {field.type === 'category_multiselect' && (
                <div className="space-y-2">
                  <Label className="text-xs">Select Categories to Include</Label>
                  {categories.length === 0 ? (
                    <div className="p-2 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
                      Loading categories...
                    </div>
                  ) : (
                    <>
                      <div className="p-2 bg-slate-50 border border-slate-200 rounded space-y-2 max-h-48 overflow-y-auto">
                        {categories.map((category) => {
                          const isSelected = (field.allowed_category_ids || []).includes(category.id);
                          return (
                            <div key={category.id} className="flex items-start gap-2">
                              <Checkbox
                                id={`cat-${field.id}-${category.id}`}
                                checked={isSelected}
                                onCheckedChange={(checked) => {
                                  const currentIds = field.allowed_category_ids || [];
                                  const newIds = checked
                                    ? [...currentIds, category.id]
                                    : currentIds.filter(id => id !== category.id);
                                  updateField(originalIndex, { allowed_category_ids: newIds });
                                }}
                              />
                              <div className="flex-1">
                                <Label 
                                  htmlFor={`cat-${field.id}-${category.id}`} 
                                  className="text-xs font-medium cursor-pointer"
                                >
                                  {category.name}
                                </Label>
                                {category.description && (
                                  <p className="text-xs text-slate-500">{category.description}</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-xs text-slate-500">
                        {(field.allowed_category_ids || []).length === 0 
                          ? "No categories selected - all categories will be shown"
                          : `${(field.allowed_category_ids || []).length} category(ies) selected`}
                      </p>
                      
                      <div className="pt-3 border-t border-slate-200 mt-3">
                        <Label className="text-xs font-medium text-slate-700">Selection Limits (Optional)</Label>
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          <div className="space-y-1">
                            <Label className="text-xs text-slate-500">Minimum</Label>
                            <Input
                              type="number"
                              min="0"
                              value={field.min_selections ?? ''}
                              onChange={(e) => updateField(originalIndex, { 
                                min_selections: e.target.value ? parseInt(e.target.value, 10) : null 
                              })}
                              placeholder="No min"
                              className="h-8 text-xs"
                              data-testid={`input-min-selections-${field.id}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs text-slate-500">Maximum</Label>
                            <Input
                              type="number"
                              min="0"
                              value={field.max_selections ?? ''}
                              onChange={(e) => updateField(originalIndex, { 
                                max_selections: e.target.value ? parseInt(e.target.value, 10) : null 
                              })}
                              placeholder="No max"
                              className="h-8 text-xs"
                              data-testid={`input-max-selections-${field.id}`}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          Leave blank for no limits
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}

              {field.type === 'category_dropdown' && (
                <div className="space-y-2">
                  <Label className="text-xs">Select Category</Label>
                  {categories.length === 0 ? (
                    <div className="p-2 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
                      Loading categories...
                    </div>
                  ) : (
                    <>
                      <Select
                        value={field.category_id || ''}
                        onValueChange={(value) => updateField(originalIndex, { category_id: value })}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-category-${field.id}`}>
                          <SelectValue placeholder="Choose a category..." />
                        </SelectTrigger>
                        <SelectContent>
                          {categories.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {field.category_id && (
                        <p className="text-xs text-slate-500">
                          The subcategories of "{categories.find(c => c.id === field.category_id)?.name}" will be shown as options.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {['select', 'radio', 'checkbox'].includes(field.type) && (
                <div className="space-y-2">
                  <Label className="text-xs">Options</Label>
                  <div className="space-y-1">
                    {(field.options || []).map((option, optIndex) => (
                      <div key={optIndex} className="flex items-center gap-1">
                        <Input
                          value={option}
                          onChange={(e) => {
                            const newOptions = [...(field.options || [])];
                            newOptions[optIndex] = e.target.value;
                            updateField(originalIndex, { options: newOptions });
                          }}
                          className="h-7 text-sm flex-1"
                          placeholder={`Option ${optIndex + 1}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            const newOptions = (field.options || []).filter((_, i) => i !== optIndex);
                            updateField(originalIndex, { options: newOptions });
                          }}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs w-full"
                    onClick={() => {
                      const newOptions = [...(field.options || []), ''];
                      updateField(originalIndex, { options: newOptions });
                    }}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add Option
                  </Button>
                </div>
              )}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`required-${field.id}`}
                      checked={field.required}
                      onCheckedChange={(checked) => updateField(originalIndex, { required: checked })}
                    />
                    <Label htmlFor={`required-${field.id}`} className="text-xs">Required</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`locked-${field.id}`}
                      checked={field.locked || false}
                      onCheckedChange={(checked) => updateField(originalIndex, { locked: checked })}
                    />
                    <Label htmlFor={`locked-${field.id}`} className="text-xs">Locked</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`starts-hidden-${field.id}`}
                      checked={field.starts_hidden || false}
                      onCheckedChange={(checked) => updateField(originalIndex, { starts_hidden: checked })}
                    />
                    <Label htmlFor={`starts-hidden-${field.id}`} className="text-xs">Hidden on load</Label>
                  </div>
                  {field.type === 'select' && (
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`allow-other-${field.id}`}
                        checked={field.allow_other || false}
                        onCheckedChange={(checked) => updateField(originalIndex, { allow_other: checked })}
                      />
                      <Label htmlFor={`allow-other-${field.id}`} className="text-xs">Allow "Other"</Label>
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeField(originalIndex)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}

export default function FormBuilderPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    slug: "",
    layout_type: "standard",
    fields: [],
    pages: [], // For standard layout pagination: [{id: 'page_xxx', title: 'Page 1'}]
    submit_button_text: "Submit",
    success_message: "Thank you for your submission!",
    redirect_url: "",
    require_authentication: false,
    is_active: true,
    is_application_form: false,
    application_level: "member",
    auto_create_entity: false,
    member_entity_action: "none", // "none", "create", "update", "upsert"
    organization_entity_action: "none", // "none", "create", "update", "upsert"
    uniqueness_checks: [],
    field_mappings: [], // Submission field mappings with transformations
    submission_email_template_id: null,
    submission_email_recipient: '',
    prefill_source: "none", // "none", "member", or "organization" - enables pre-populating form from entity data
    visibility_rules: [] // Conditional logic rules: [{id, rule_type, trigger_field_id, operator, value, action, target_field_ids, target_field_id, set_value_source, set_value, set_value_field_id, set_value_prefill_field}]
  });
  
  // Track which form pages are expanded (for collapsible UI) - true = expanded, false = collapsed
  // Use a ref to track "all collapsed" mode separately from individual toggles
  const [expandedPages, setExpandedPages] = useState({});
  const [allCollapsedMode, setAllCollapsedMode] = useState(false);
  
  const togglePageExpanded = (pageId) => {
    setExpandedPages(prev => {
      // Derive current state: if allCollapsedMode and not explicitly set, treat as collapsed
      let currentState;
      if (prev[pageId] !== undefined) {
        currentState = prev[pageId];
      } else if (allCollapsedMode) {
        currentState = false; // Collapsed by default when in allCollapsedMode
      } else {
        currentState = true; // Expanded by default otherwise
      }
      return {
        ...prev,
        [pageId]: !currentState
      };
    });
    setAllCollapsedMode(false); // Exit "all collapsed" mode after toggling
  };
  
  const isPageExpanded = (pageId) => {
    // If in "all collapsed" mode and not explicitly expanded, stay collapsed
    if (allCollapsedMode && expandedPages[pageId] !== true) {
      return false;
    }
    // Otherwise default to expanded unless explicitly collapsed
    return expandedPages[pageId] !== false;
  };
  
  const expandAllPages = () => {
    setAllCollapsedMode(false);
    const allExpanded = {};
    formData.pages.forEach(p => { allExpanded[p.id] = true; });
    setExpandedPages(allExpanded);
  };
  
  const collapseAllPages = () => {
    setAllCollapsedMode(true);
    setExpandedPages({});
  };

  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(window.location.search);
  const formId = urlParams.get('formId');

  const { data: existingForm, isLoading: formLoading } = useQuery({
    queryKey: ['form', formId],
    queryFn: async () => {
      if (!formId) return null;
      const allForms = await base44.entities.Form.list();
      return allForms.find(f => f.id === formId);
    },
    enabled: !!formId
  });

  // Fetch resource categories for category_multiselect field configuration (search categories)
  const { data: categories = [] } = useQuery({
    queryKey: ['resource-categories-for-forms'],
    queryFn: async () => {
      const response = await fetch('/api/public/resource-categories');
      if (!response.ok) throw new Error('Failed to fetch resource categories');
      return response.json();
    }
  });

  // Fetch custom fields (PreferenceField) for CRM mapping
  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['email-templates-active'],
    queryFn: async () => {
      try {
        const templates = await base44.entities.EmailTemplate.list();
        return (templates || []).filter(t => t.is_active !== false);
      } catch (err) {
        console.warn('Failed to fetch email templates:', err);
        return [];
      }
    },
  });

  const { data: customFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField', 'all-for-mapping'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true },
          sort: { display_order: 'asc' }
        });
        return fields || [];
      } catch {
        return [];
      }
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['/api/entities/Role', 'all-for-form-actions'],
    queryFn: async () => {
      try {
        const allRoles = await base44.entities.Role.list();
        return allRoles || [];
      } catch {
        return [];
      }
    }
  });

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_FormBuilder')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady]);

  useEffect(() => {
    if (existingForm) {
      setFormData({
        name: existingForm.name || "",
        description: existingForm.description || "",
        slug: existingForm.slug || "",
        layout_type: existingForm.layout_type || "standard",
        fields: existingForm.fields ? existingForm.fields.map(field => ({
          ...field,
          allow_other: field.allow_other ?? false,
          page_id: field.page_id || null,
          column_index: field.column_index ?? 0 // Default to first column
        })) : [],
        pages: existingForm.pages ? existingForm.pages.map(page => ({
          ...page,
          column_count: page.column_count ?? 1 // Default to single column
        })) : [],
        submit_button_text: existingForm.submit_button_text || "Submit",
        success_message: existingForm.success_message || "Thank you for your submission!",
        redirect_url: existingForm.redirect_url || "",
        require_authentication: existingForm.require_authentication || false,
        is_active: existingForm.is_active ?? true,
        is_application_form: existingForm.is_application_form || false,
        application_level: existingForm.application_level || "member",
        auto_create_entity: existingForm.auto_create_entity || false,
        member_entity_action: existingForm.member_entity_action || 
          (existingForm.create_entity_type === "member" || existingForm.create_entity_type === "both" 
            ? (existingForm.entity_action || "create") 
            : "none"),
        organization_entity_action: existingForm.organization_entity_action || 
          (existingForm.create_entity_type === "organization" || existingForm.create_entity_type === "both" 
            ? (existingForm.entity_action || "create") 
            : "none"),
        uniqueness_checks: existingForm.uniqueness_checks || [],
        field_mappings: existingForm.field_mappings || [],
        submission_email_template_id: existingForm.submission_email_template_id || null,
        submission_email_recipient: existingForm.submission_email_recipient || '',
        prefill_source: existingForm.prefill_source || "none",
        visibility_rules: (existingForm.visibility_rules || []).map(rule => ({
          ...rule,
          rule_type: rule.rule_type || 'visibility',
          target_field_id: rule.target_field_id || '',
          set_value_source: rule.set_value_source || 'static',
          set_value: rule.set_value ?? '',
          set_value_field_id: rule.set_value_field_id || '',
          set_value_prefill_field: rule.set_value_prefill_field || '',
          target_field_ids: rule.target_field_ids || []
        }))
      });
    }
  }, [existingForm]);

  const createFormMutation = useMutation({
    mutationFn: async (data) => {
      console.log('[FormBuilder] Creating form with data:', JSON.stringify(data, null, 2));
      return await base44.entities.Form.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form created successfully');
      window.location.href = createPageUrl('FormManagement');
    },
    onError: (error) => {
      console.error('[FormBuilder] Create form error:', error);
      const errorMessage = error?.message || error?.response?.data?.error || 'Unknown error';
      toast.error(`Failed to create form: ${errorMessage}`);
    }
  });

  const updateFormMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      console.log('[FormBuilder] Updating form', id, 'with data:', JSON.stringify(data, null, 2));
      return await base44.entities.Form.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form updated successfully');
    },
    onError: (error) => {
      console.error('[FormBuilder] Update form error:', error);
      const errorMessage = error?.message || error?.response?.data?.error || 'Unknown error';
      toast.error(`Failed to update form: ${errorMessage}`);
    }
  });

  const addField = (pageId = null, columnIndex = 0) => {
    const newField = {
      id: `field_${Date.now()}`,
      type: 'text',
      label: 'New Field',
      placeholder: '',
      required: false,
      options: [],
      allow_other: false,
      page_id: pageId,
      column_index: columnIndex // 0, 1, or 2 (for 1, 2, or 3 columns)
    };
    setFormData({ ...formData, fields: [...formData.fields, newField] });
  };

  // Page management functions (for standard layout only)
  const addPage = () => {
    const pageNumber = formData.pages.length + 1;
    const newPage = {
      id: `page_${Date.now()}`,
      title: `Page ${pageNumber}`,
      column_count: 1 // 1, 2, or 3 columns
    };
    setFormData({ ...formData, pages: [...formData.pages, newPage] });
  };

  const updatePage = (pageId, updates) => {
    const newPages = formData.pages.map(p => 
      p.id === pageId ? { ...p, ...updates } : p
    );
    
    // If reducing column count, reassign fields from removed columns
    let newFields = formData.fields;
    if (updates.column_count !== undefined) {
      const currentPage = formData.pages.find(p => p.id === pageId);
      const oldColumnCount = currentPage?.column_count || 1;
      const newColumnCount = updates.column_count;
      
      if (newColumnCount < oldColumnCount) {
        // Move fields from columns that no longer exist to the last column
        newFields = formData.fields.map(f => {
          if (f.page_id === pageId && (f.column_index || 0) >= newColumnCount) {
            return { ...f, column_index: newColumnCount - 1 };
          }
          return f;
        });
      }
    }
    
    setFormData({ ...formData, pages: newPages, fields: newFields });
  };

  const removePage = (pageId) => {
    // Move all fields from this page to no page (null)
    const newFields = formData.fields.map(f => 
      f.page_id === pageId ? { ...f, page_id: null } : f
    );
    const newPages = formData.pages.filter(p => p.id !== pageId);
    setFormData({ ...formData, pages: newPages, fields: newFields });
  };

  const movePageUp = (index) => {
    if (index === 0) return;
    const newPages = [...formData.pages];
    [newPages[index - 1], newPages[index]] = [newPages[index], newPages[index - 1]];
    setFormData({ ...formData, pages: newPages });
  };

  const movePageDown = (index) => {
    if (index === formData.pages.length - 1) return;
    const newPages = [...formData.pages];
    [newPages[index], newPages[index + 1]] = [newPages[index + 1], newPages[index]];
    setFormData({ ...formData, pages: newPages });
  };

  const updateField = (index, updates) => {
    const newFields = [...formData.fields];
    newFields[index] = { ...newFields[index], ...updates };
    setFormData({ ...formData, fields: newFields });
  };

  const removeField = (index) => {
    const removedField = formData.fields[index];
    const newFields = formData.fields.filter((_, i) => i !== index);
    
    // Clean up orphaned uniqueness checks when field is removed
    const newUniquenessChecks = (formData.uniqueness_checks || [])
      .filter(c => c.field_id !== removedField?.id);
    
    setFormData({ ...formData, fields: newFields, uniqueness_checks: newUniquenessChecks });
  };

  const handleUniquenessChange = (fieldId, enabled, options = {}) => {
    const existingChecks = formData.uniqueness_checks || [];
    
    if (enabled) {
      const existingIndex = existingChecks.findIndex(c => c.field_id === fieldId);
      const newCheck = { 
        field_id: fieldId, 
        target_field: options.target_field || (formData.application_level === 'member' ? 'member.email' : 'organization.name'),
        comparison_mode: options.comparison_mode || 'equals_lowercase'
      };
      
      if (existingIndex >= 0) {
        const newChecks = [...existingChecks];
        newChecks[existingIndex] = newCheck;
        setFormData({ ...formData, uniqueness_checks: newChecks });
      } else {
        setFormData({ ...formData, uniqueness_checks: [...existingChecks, newCheck] });
      }
    } else {
      setFormData({ ...formData, uniqueness_checks: existingChecks.filter(c => c.field_id !== fieldId) });
    }
  };

  // Parse droppable ID to extract page ID and column index
  // Format: "fields-unassigned" or "pageId::columnIndex"
  const parseDroppableId = (droppableId) => {
    if (droppableId === 'fields-unassigned') {
      return { pageId: null, columnIndex: 0 };
    }
    const parts = droppableId.split('::');
    return {
      pageId: parts[0],
      columnIndex: parseInt(parts[1] || '0', 10)
    };
  };

  const handleDragEnd = (result) => {
    if (!result.destination) return;

    const { source, destination } = result;
    
    // For standard layout with pages, handle cross-page and cross-column drops
    if (formData.layout_type === 'standard' && formData.pages.length > 0) {
      const sourceParsed = parseDroppableId(source.droppableId);
      const destParsed = parseDroppableId(destination.droppableId);
      
      // Get fields for source page+column to find the moved field
      const sourceFields = formData.fields.filter(f => 
        f.page_id === sourceParsed.pageId && 
        (f.column_index || 0) === sourceParsed.columnIndex
      );
      const movedField = sourceFields[source.index];
      if (!movedField) return;
      
      // Get the absolute index of the moved field in the full array
      const movedFieldAbsoluteIndex = formData.fields.findIndex(f => f.id === movedField.id);
      
      // Create a copy of fields array
      const newFields = [...formData.fields];
      
      // Remove from original position
      newFields.splice(movedFieldAbsoluteIndex, 1);
      
      // Update the field's page_id and column_index
      const updatedField = { 
        ...movedField, 
        page_id: destParsed.pageId,
        column_index: destParsed.columnIndex
      };
      
      // Find where to insert in the new array
      // Get destination page+column fields (after removal)
      const destFieldsAfterRemoval = newFields.filter(f => 
        f.page_id === destParsed.pageId && 
        (f.column_index || 0) === destParsed.columnIndex
      );
      
      if (destFieldsAfterRemoval.length === 0) {
        // No fields in destination - find the correct position
        const destPageIndex = destParsed.pageId === null 
          ? -1 
          : formData.pages.findIndex(p => p.id === destParsed.pageId);
        
        let insertIndex = -1;
        
        if (destParsed.pageId === null) {
          // Unassigned fields
          const firstPageFieldIndex = newFields.findIndex(f => f.page_id !== null);
          insertIndex = firstPageFieldIndex === -1 ? 0 : firstPageFieldIndex;
        } else {
          // Find position based on page order
          for (let i = destPageIndex + 1; i < formData.pages.length; i++) {
            const laterPageId = formData.pages[i].id;
            const firstFieldOfLaterPage = newFields.findIndex(f => f.page_id === laterPageId);
            if (firstFieldOfLaterPage !== -1) {
              insertIndex = firstFieldOfLaterPage;
              break;
            }
          }
          
          if (insertIndex === -1) {
            for (let i = destPageIndex - 1; i >= 0; i--) {
              const earlierPageId = formData.pages[i].id;
              const lastFieldOfEarlierPage = newFields.map((f, idx) => ({ f, idx }))
                .filter(({ f }) => f.page_id === earlierPageId)
                .pop();
              if (lastFieldOfEarlierPage) {
                insertIndex = lastFieldOfEarlierPage.idx + 1;
                break;
              }
            }
          }
          
          if (insertIndex === -1) {
            const unassignedFields = newFields.map((f, idx) => ({ f, idx }))
              .filter(({ f }) => f.page_id === null);
            if (unassignedFields.length > 0) {
              insertIndex = unassignedFields[unassignedFields.length - 1].idx + 1;
            } else {
              insertIndex = 0;
            }
          }
        }
        
        newFields.splice(insertIndex, 0, updatedField);
      } else if (destination.index >= destFieldsAfterRemoval.length) {
        const lastDestField = destFieldsAfterRemoval[destFieldsAfterRemoval.length - 1];
        const lastDestFieldAbsoluteIndex = newFields.findIndex(f => f.id === lastDestField.id);
        newFields.splice(lastDestFieldAbsoluteIndex + 1, 0, updatedField);
      } else {
        const targetField = destFieldsAfterRemoval[destination.index];
        const targetAbsoluteIndex = newFields.findIndex(f => f.id === targetField.id);
        newFields.splice(targetAbsoluteIndex, 0, updatedField);
      }
      
      setFormData({ ...formData, fields: newFields });
    } else {
      // Simple reorder for card_swipe or standard without pages
      const items = Array.from(formData.fields);
      const [reorderedItem] = items.splice(source.index, 1);
      items.splice(destination.index, 0, reorderedItem);
      setFormData({ ...formData, fields: items });
    }
  };

  const handleSubmit = () => {
    console.log('[FormBuilder] handleSubmit called');
    console.log('[FormBuilder] formData:', JSON.stringify(formData, null, 2));
    
    if (!formData.name || !formData.slug) {
      console.log('[FormBuilder] Validation failed: missing name or slug');
      toast.error('Please fill in name and slug');
      return;
    }

    if (formData.fields.length === 0) {
      console.log('[FormBuilder] Validation failed: no fields');
      toast.error('Please add at least one field');
      return;
    }

    // Validate field mappings - check for incomplete mappings
    const mappings = formData.field_mappings || [];
    console.log('[FormBuilder] Validating', mappings.length, 'field mappings');
    for (let i = 0; i < mappings.length; i++) {
      const m = mappings[i];
      console.log(`[FormBuilder] Mapping #${i + 1}:`, m);
      
      // All mappings must have a target field
      if (!m.target_field) {
        console.log(`[FormBuilder] Validation failed: mapping #${i + 1} missing target_field`);
        toast.error(`Field mapping #${i + 1} is missing a target field. Please select a target field or remove the mapping.`);
        return;
      }
      
      // Non-current_date mappings need a source field (unless static)
      if (m.transformation !== 'current_date' && m.source_type !== 'static') {
        if (!m.source_field_id) {
          console.log(`[FormBuilder] Validation failed: mapping #${i + 1} missing source_field_id`);
          toast.error(`Field mapping #${i + 1} is missing a source field. Please select a source field or use "Current date" transformation.`);
          return;
        }
      }
    }
    console.log('[FormBuilder] All mappings validated successfully');

    // Validate organization name mapping when org creation is enabled
    if (formData.is_application_form && formData.auto_create_entity) {
      const createType = formData.create_entity_type || 'member';
      console.log('[FormBuilder] Entity creation validation - createType:', createType);
      const needsOrgName = createType === 'organization' || createType === 'both';
      
      if (needsOrgName) {
        const hasOrgNameMapping = (formData.field_mappings || []).some(
          m => m.target_entity === 'organization' && m.target_field === 'name'
        );
        console.log('[FormBuilder] Needs org name mapping:', needsOrgName, '| Has it:', hasOrgNameMapping);
        
        if (!hasOrgNameMapping) {
          console.log('[FormBuilder] VALIDATION FAILED: Missing org name mapping');
          toast.error('Organisation creation requires a field mapped to "Organisation Name". Please add this mapping in Field Mappings.');
          return;
        }
      }
      
      const needsMemberEmail = createType === 'member' || createType === 'both';
      if (needsMemberEmail) {
        const hasMemberEmailMapping = (formData.field_mappings || []).some(
          m => m.target_entity === 'member' && m.target_field === 'email'
        );
        console.log('[FormBuilder] Needs member email mapping:', needsMemberEmail, '| Has it:', hasMemberEmailMapping);
        
        if (!hasMemberEmailMapping) {
          console.log('[FormBuilder] VALIDATION FAILED: Missing member email mapping');
          toast.error('Member creation requires a field mapped to "Member Email". Please add this mapping in Field Mappings.');
          return;
        }
      }
    }

    console.log('[FormBuilder] All validation passed, submitting form');
    if (formId) {
      console.log('[FormBuilder] Updating form:', formId);
      updateFormMutation.mutate({ id: formId, data: formData });
    } else {
      console.log('[FormBuilder] Creating new form');
      createFormMutation.mutate(formData);
    }
  };

  if (!accessChecked || formLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <Link to={createPageUrl('FormManagement')}>
              <Button variant="ghost" size="sm" className="mb-2">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Forms
              </Button>
            </Link>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              {formId ? 'Edit Form' : 'Create Form'}
            </h1>
          </div>
          <Button
            onClick={handleSubmit}
            disabled={createFormMutation.isPending || updateFormMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {(createFormMutation.isPending || updateFormMutation.isPending) ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Form
              </>
            )}
          </Button>
        </div>

        {/* Tabs for organizing form sections */}
        <Tabs defaultValue="builder" className="w-full">
          <TabsList className="grid w-full grid-cols-4 mb-6" data-testid="formbuilder-tabs">
            <TabsTrigger value="builder" data-testid="tab-builder">Builder</TabsTrigger>
            <TabsTrigger value="settings" data-testid="tab-settings">Form Settings</TabsTrigger>
            <TabsTrigger value="submission" data-testid="tab-submission">Submission Settings</TabsTrigger>
            <TabsTrigger value="logic" data-testid="tab-logic">Conditional Logic</TabsTrigger>
          </TabsList>

          {/* Form Settings Tab */}
          <TabsContent value="settings">
            <Card className="border-slate-200">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Form Settings</CardTitle>
              </CardHeader>
              <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Row 1: Core Settings */}
              <div className="space-y-2">
                <Label htmlFor="name">Form Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Contact Form"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="slug">Slug *</Label>
                <Input
                  id="slug"
                  value={formData.slug}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                  placeholder="contact-form"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="layout_type">Layout Type *</Label>
                <Select
                  value={formData.layout_type}
                  onValueChange={(value) => setFormData({ ...formData, layout_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard (All Fields)</SelectItem>
                    <SelectItem value="card_swipe">Card Swipe (One at a Time)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="submit_button_text">Submit Button Text</Label>
                <Input
                  id="submit_button_text"
                  value={formData.submit_button_text}
                  onChange={(e) => setFormData({ ...formData, submit_button_text: e.target.value })}
                />
              </div>

              {/* Row 2: Description and Messages */}
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Form description..."
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="success_message">Success Message</Label>
                <Textarea
                  id="success_message"
                  value={formData.success_message}
                  onChange={(e) => setFormData({ ...formData, success_message: e.target.value })}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="redirect_url">Redirect URL</Label>
                <Input
                  id="redirect_url"
                  type="url"
                  value={formData.redirect_url}
                  onChange={(e) => setFormData({ ...formData, redirect_url: e.target.value })}
                  placeholder="https://example.com/thanks"
                />
              </div>
            </div>

            {/* Email on Submission */}
            <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
              <Label className="text-sm font-medium">Email on Submission</Label>
              <p className="text-xs text-slate-500">Optionally send an email when the form is submitted</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-slate-600 mb-1">Email Template</Label>
                  <Select
                    value={formData.submission_email_template_id || '_none'}
                    onValueChange={(val) => setFormData({ 
                      ...formData, 
                      submission_email_template_id: val === '_none' ? null : val 
                    })}
                  >
                    <SelectTrigger data-testid="select-submission-email-template">
                      <SelectValue placeholder="Select email template" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No email</SelectItem>
                      {emailTemplates.map(t => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {formData.submission_email_template_id && (
                  <div>
                    <Label className="text-xs text-slate-600 mb-1">Send To (Field or Address)</Label>
                    <Input
                      value={formData.submission_email_recipient || ''}
                      onChange={(e) => setFormData({ ...formData, submission_email_recipient: e.target.value })}
                      placeholder="{{email}} or admin@example.com"
                      data-testid="input-submission-email-recipient"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Use {'{{field_id}}'} for a form field value, or enter a fixed email address
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Toggles Row */}
            <div className="flex items-center gap-6 mt-4 pt-4 border-t border-slate-100 flex-wrap">
              <div className="flex items-center gap-2">
                <Switch
                  id="require_authentication"
                  checked={formData.require_authentication}
                  onCheckedChange={(checked) => setFormData({ ...formData, require_authentication: checked })}
                />
                <Label htmlFor="require_authentication" className="text-sm">Require Login</Label>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
                <Label htmlFor="is_active" className="text-sm">Active</Label>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="is_application_form"
                  checked={formData.is_application_form}
                  onCheckedChange={(checked) => setFormData({ 
                    ...formData, 
                    is_application_form: checked,
                    uniqueness_checks: checked ? formData.uniqueness_checks : []
                  })}
                  data-testid="switch-application-form"
                />
                <Label htmlFor="is_application_form" className="text-sm">Application Form</Label>
              </div>

              <div className="text-xs text-slate-500 ml-auto">
                URL: /FormView?slug={formData.slug || 'your-slug'}
              </div>
            </div>

            {/* Pre-fill Settings */}
            <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">Pre-fill Form From</Label>
                  <Select
                    value={formData.prefill_source || "none"}
                    onValueChange={(value) => setFormData({ ...formData, prefill_source: value })}
                  >
                    <SelectTrigger className="w-[200px]" data-testid="select-prefill-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (No Pre-fill)</SelectItem>
                      <SelectItem value="member">Member Data</SelectItem>
                      <SelectItem value="organization">Organisation Data</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.prefill_source !== "none" && (
                  <p className="text-xs text-slate-500 self-end pb-2">
                    Form URL will accept ?{formData.prefill_source === "member" ? "member_id" : "organization_id"}=xxx to pre-populate fields
                  </p>
                )}
              </div>
            </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Submission Settings Tab */}
          <TabsContent value="submission">
            {/* Application Form Settings - moved here */}
            {formData.is_application_form && (
              <Card className="border-slate-200 mb-6">
                <CardHeader className="pb-4">
                  <CardTitle className="text-lg">Application Settings</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <Label className="text-sm font-medium">Application Level:</Label>
                      <div className="flex gap-3">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="level-member-tab"
                            name="application_level_tab"
                            value="member"
                            checked={formData.application_level === "member"}
                            onChange={() => setFormData({ ...formData, application_level: "member" })}
                            className="w-4 h-4 text-blue-600"
                            data-testid="radio-level-member"
                          />
                          <Label htmlFor="level-member-tab" className="text-sm cursor-pointer">Member Level</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="level-organization-tab"
                            name="application_level_tab"
                            value="organization"
                            checked={formData.application_level === "organization"}
                            onChange={() => setFormData({ ...formData, application_level: "organization" })}
                            className="w-4 h-4 text-blue-600"
                            data-testid="radio-level-organization"
                          />
                          <Label htmlFor="level-organization-tab" className="text-sm cursor-pointer">Organisation Level</Label>
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-slate-500">
                      {formData.application_level === "member" 
                        ? "Uniqueness will be checked against the Member table" 
                        : "Uniqueness will be checked against the Organisation table (email fields use domain-only matching)"}
                    </p>
                    
                    <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="auto_create_entity_tab"
                          checked={formData.auto_create_entity || false}
                          onCheckedChange={(checked) => setFormData({ ...formData, auto_create_entity: checked })}
                          data-testid="switch-auto-create-entity"
                        />
                        <Label htmlFor="auto_create_entity_tab" className="text-sm">Auto-create records on submission</Label>
                      </div>
                      
                      {formData.auto_create_entity && (
                        <div className="ml-6 space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <Label className="text-sm font-medium">Member Record Action</Label>
                              <Select
                                value={formData.member_entity_action || "none"}
                                onValueChange={(value) => setFormData({ ...formData, member_entity_action: value })}
                              >
                                <SelectTrigger data-testid="select-member-entity-action">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">Don't create/update</SelectItem>
                                  <SelectItem value="create">Create new only</SelectItem>
                                  <SelectItem value="update">Update existing only</SelectItem>
                                  <SelectItem value="upsert">Upsert (create or update)</SelectItem>
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-slate-500">
                                {formData.member_entity_action === "none" && "No member record will be created"}
                                {formData.member_entity_action === "create" && "Create a new member (fail if exists)"}
                                {formData.member_entity_action === "update" && "Update existing member (match by email)"}
                                {formData.member_entity_action === "upsert" && "Create if not found, update if exists"}
                              </p>
                            </div>
                            
                            <div className="space-y-2">
                              <Label className="text-sm font-medium">Organisation Record Action</Label>
                              <Select
                                value={formData.organization_entity_action || "none"}
                                onValueChange={(value) => setFormData({ ...formData, organization_entity_action: value })}
                              >
                                <SelectTrigger data-testid="select-organization-entity-action">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">Don't create/update</SelectItem>
                                  <SelectItem value="create">Create new only</SelectItem>
                                  <SelectItem value="update">Update existing only</SelectItem>
                                  <SelectItem value="upsert">Upsert (create or update)</SelectItem>
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-slate-500">
                                {formData.organization_entity_action === "none" && "No organisation record will be created"}
                                {formData.organization_entity_action === "create" && "Create a new organisation (fail if exists)"}
                                {formData.organization_entity_action === "update" && "Update existing org (match by name/domain)"}
                                {formData.organization_entity_action === "upsert" && "Create if not found, update if exists"}
                              </p>
                            </div>
                          </div>
                          
                          <p className="text-xs text-slate-500 bg-slate-50 p-3 rounded-lg">
                            Use Field Mappings below to specify which form fields populate each entity type.
                          </p>
                        </div>
                      )}
                      
                      {!formData.auto_create_entity && (
                        <p className="text-xs text-slate-500 ml-6">
                          Submissions will require admin approval before creating records
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Field Mappings Card */}
            <Card className="border-slate-200 mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Settings2 className="w-5 h-5" />
                  Field Mappings
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Accordion type="single" collapsible defaultValue="mappings">
                  <AccordionItem value="mappings" className="border-none">
                    <AccordionTrigger className="py-2 hover:no-underline" data-testid="accordion-field-mappings">
                      <span className="text-sm font-medium">Field Mappings &amp; Transformations</span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="pt-2">
                        <FieldMappingSection
                          fields={formData.fields}
                          fieldMappings={formData.field_mappings}
                          onMappingsChange={(mappings) => {
                            console.log('[FormBuilder] onMappingsChange called with:', mappings);
                            try {
                              setFormData(prev => ({ ...prev, field_mappings: mappings }));
                            } catch (error) {
                              console.error('[FormBuilder] Error setting field_mappings:', error);
                              toast.error(`Failed to update mappings: ${error.message}`);
                            }
                          }}
                          applicationLevel={formData.application_level}
                          customFields={customFields}
                        />
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Conditional Logic Tab */}
          <TabsContent value="logic">
            <Card className="border-slate-200">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Eye className="w-5 h-5" />
                  Visibility Rules
                </CardTitle>
              </CardHeader>
              <CardContent>
                <LogicRulesSection
                  fields={formData.fields}
                  visibilityRules={formData.visibility_rules}
                  prefillSource={formData.prefill_source || 'none'}
                  customFields={customFields}
                  roles={roles}
                  onRulesChange={(rules) => {
                    const fieldsWithShowRules = new Set();
                    rules.forEach(rule => {
                      if (rule.action === 'show' && rule.target_field_ids?.length) {
                        rule.target_field_ids.forEach(id => fieldsWithShowRules.add(id));
                      }
                    });
                    setFormData(prev => {
                      const updatedFields = prev.fields.map(field => ({
                        ...field,
                        starts_hidden: fieldsWithShowRules.has(field.id)
                      }));
                      return { 
                        ...prev, 
                        visibility_rules: rules,
                        fields: updatedFields
                      };
                    });
                  }}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Builder Tab - Form Pages and Fields */}
          <TabsContent value="builder">
            <div className="space-y-6">
            {/* Pages Management - Only for Standard layout */}
            {formData.layout_type === 'standard' && (
              <Card className="border-slate-200">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <FileText className="w-5 h-5" />
                      Form Pages
                    </CardTitle>
                    <Button onClick={addPage} size="sm" variant="outline">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Page
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {formData.pages.length === 0 ? (
                    <div className="text-center py-6 text-slate-500 text-sm">
                      <p className="mb-2">No pages defined - all fields will show on one page</p>
                      <p className="text-xs text-slate-400">Add pages to break your form into multiple steps</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {formData.pages.map((page, index) => (
                        <div key={page.id} className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200">
                          <div className="flex flex-col">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5"
                              onClick={() => movePageUp(index)}
                              disabled={index === 0}
                            >
                              <ChevronUp className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5"
                              onClick={() => movePageDown(index)}
                              disabled={index === formData.pages.length - 1}
                            >
                              <ChevronDown className="w-3 h-3" />
                            </Button>
                          </div>
                          <div className="flex-1">
                            <Input
                              value={page.title}
                              onChange={(e) => updatePage(page.id, { title: e.target.value })}
                              className="h-8 text-sm"
                              placeholder="Page title..."
                            />
                          </div>
                          {/* Column count selector */}
                          <div className="flex items-center gap-1 border border-slate-200 rounded bg-white p-0.5">
                            <Button
                              variant={page.column_count === 1 ? "default" : "ghost"}
                              size="sm"
                              className="h-6 w-6 p-0 text-xs"
                              onClick={() => updatePage(page.id, { column_count: 1 })}
                              title="1 Column"
                            >
                              1
                            </Button>
                            <Button
                              variant={page.column_count === 2 ? "default" : "ghost"}
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => updatePage(page.id, { column_count: 2 })}
                              title="2 Columns"
                            >
                              <Columns2 className="w-3 h-3" />
                            </Button>
                            <Button
                              variant={page.column_count === 3 ? "default" : "ghost"}
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => updatePage(page.id, { column_count: 3 })}
                              title="3 Columns"
                            >
                              <Columns3 className="w-3 h-3" />
                            </Button>
                          </div>
                          <span className="text-xs text-slate-400 px-2">
                            {formData.fields.filter(f => f.page_id === page.id).length} fields
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removePage(page.id)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50 h-8 w-8 p-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Form Fields Card */}
            <Card className="border-slate-200">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Form Fields</CardTitle>
                  <Button onClick={() => addField(null)} size="sm" variant="outline">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Field
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {formData.fields.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <p className="mb-4">No fields added yet</p>
                    <Button onClick={() => addField(null)} variant="outline">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Your First Field
                    </Button>
                  </div>
                ) : formData.layout_type === 'standard' && formData.pages.length > 0 ? (
                  /* Paginated view with fields grouped by page */
                  <DragDropContext onDragEnd={handleDragEnd}>
                    <div className="space-y-6">
                      {/* Unassigned fields */}
                      {formData.fields.some(f => !f.page_id) && (
                        <div className="border border-dashed border-slate-300 rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-sm font-medium text-slate-600">Unassigned Fields</h4>
                            <span className="text-xs text-slate-400">Drag to a page below</span>
                          </div>
                          <Droppable droppableId="fields-unassigned">
                            {(provided, snapshot) => (
                              <div 
                                {...provided.droppableProps} 
                                ref={provided.innerRef} 
                                className={`space-y-3 min-h-[60px] ${snapshot.isDraggingOver ? 'bg-blue-50 rounded' : ''}`}
                              >
                                {formData.fields
                                  .map((field, originalIndex) => ({ field, originalIndex }))
                                  .filter(({ field }) => !field.page_id)
                                  .map(({ field, originalIndex }, index) => (
                                    <FieldCard
                                      key={field.id}
                                      field={field}
                                      index={index}
                                      originalIndex={originalIndex}
                                      updateField={updateField}
                                      removeField={removeField}
                                      FIELD_TYPES={FIELD_TYPES}
                                      categories={categories}
                                      customFields={customFields}
                                      isApplicationForm={formData.is_application_form}
                                      applicationLevel={formData.application_level}
                                      uniquenessChecks={formData.uniqueness_checks}
                                      onUniquenessChange={handleUniquenessChange}
                                      prefillSource={formData.prefill_source || "none"}
                                    />
                                  ))}
                                {provided.placeholder}
                              </div>
                            )}
                          </Droppable>
                        </div>
                      )}

                      {/* Expand/Collapse All buttons */}
                      {formData.pages.length > 1 && (
                        <div className="flex items-center justify-end gap-2 mb-2">
                          <Button 
                            onClick={expandAllPages} 
                            size="sm" 
                            variant="ghost"
                            className="h-7 text-xs"
                            data-testid="button-expand-all-pages"
                          >
                            <ChevronDown className="w-3 h-3 mr-1" />
                            Expand All
                          </Button>
                          <Button 
                            onClick={collapseAllPages} 
                            size="sm" 
                            variant="ghost"
                            className="h-7 text-xs"
                            data-testid="button-collapse-all-pages"
                          >
                            <ChevronUp className="w-3 h-3 mr-1" />
                            Collapse All
                          </Button>
                        </div>
                      )}

                      {/* Fields grouped by page with columns */}
                      {formData.pages.map((page, pageIndex) => {
                        const columnCount = page.column_count || 1;
                        const isExpanded = isPageExpanded(page.id);
                        const pageFieldCount = formData.fields.filter(f => f.page_id === page.id).length;
                        
                        return (
                          <div key={page.id} className="border border-slate-200 rounded-lg overflow-hidden">
                            <div 
                              className="bg-slate-100 px-4 py-2 flex items-center justify-between cursor-pointer hover:bg-slate-150"
                              onClick={() => togglePageExpanded(page.id)}
                              data-testid={`page-header-${page.id}`}
                            >
                              <h4 className="font-medium text-slate-700 flex items-center gap-2">
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4 text-slate-500" />
                                ) : (
                                  <ChevronUp className="w-4 h-4 text-slate-500" />
                                )}
                                <span className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded">
                                  Page {pageIndex + 1}
                                </span>
                                {page.title}
                                {columnCount > 1 && (
                                  <span className="text-xs text-slate-500">
                                    ({columnCount} columns)
                                  </span>
                                )}
                                <span className="text-xs text-slate-400">
                                  {pageFieldCount} field{pageFieldCount !== 1 ? 's' : ''}
                                </span>
                              </h4>
                              <Button 
                                onClick={(e) => { e.stopPropagation(); addField(page.id, 0); }} 
                                size="sm" 
                                variant="ghost"
                                className="h-7 text-xs"
                                data-testid={`button-add-field-top-${page.id}`}
                              >
                                <Plus className="w-3 h-3 mr-1" />
                                Add Field
                              </Button>
                            </div>
                            
                            {/* Collapsible content */}
                            {isExpanded && (
                              <>
                                {/* Column grid */}
                                <div className={`grid gap-2 p-4 ${
                                  columnCount === 1 ? 'grid-cols-1' : 
                                  columnCount === 2 ? 'grid-cols-2' : 
                                  'grid-cols-3'
                                }`}>
                                  {Array.from({ length: columnCount }).map((_, colIndex) => {
                                    const columnFields = formData.fields
                                      .map((field, originalIndex) => ({ field, originalIndex }))
                                      .filter(({ field }) => 
                                        field.page_id === page.id && 
                                        (field.column_index || 0) === colIndex
                                      );
                                    
                                    return (
                                      <Droppable 
                                        key={`${page.id}::${colIndex}`} 
                                        droppableId={`${page.id}::${colIndex}`}
                                      >
                                        {(provided, snapshot) => (
                                          <div 
                                            {...provided.droppableProps} 
                                            ref={provided.innerRef} 
                                            className={`space-y-3 min-h-[80px] p-2 rounded border-2 border-dashed ${
                                              snapshot.isDraggingOver 
                                                ? 'bg-blue-50 border-blue-300' 
                                                : 'border-slate-200 bg-slate-50/50'
                                            }`}
                                          >
                                            {columnCount > 1 && (
                                              <div className="text-xs text-slate-400 text-center mb-2">
                                                Column {colIndex + 1}
                                              </div>
                                            )}
                                            {columnFields.length === 0 ? (
                                              <div className="text-center py-4 text-slate-400 text-xs">
                                                Drag fields here
                                              </div>
                                            ) : (
                                              columnFields.map(({ field, originalIndex }, index) => (
                                                <FieldCard
                                                  key={field.id}
                                                  field={field}
                                                  index={index}
                                                  originalIndex={originalIndex}
                                                  updateField={updateField}
                                                  removeField={removeField}
                                                  FIELD_TYPES={FIELD_TYPES}
                                                  categories={categories}
                                                  customFields={customFields}
                                                  isApplicationForm={formData.is_application_form}
                                                  applicationLevel={formData.application_level}
                                                  uniquenessChecks={formData.uniqueness_checks}
                                                  onUniquenessChange={handleUniquenessChange}
                                                  prefillSource={formData.prefill_source || "none"}
                                                />
                                              ))
                                            )}
                                            {provided.placeholder}
                                          </div>
                                        )}
                                      </Droppable>
                                    );
                                  })}
                                </div>
                                
                                {/* Bottom Add Field button */}
                                <div className="px-4 pb-3 flex justify-center">
                                  <Button 
                                    onClick={() => addField(page.id)} 
                                    size="sm" 
                                    variant="outline"
                                    className="h-8 text-xs"
                                    data-testid={`button-add-field-bottom-${page.id}`}
                                  >
                                    <Plus className="w-3 h-3 mr-1" />
                                    Add Field to Page
                                  </Button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </DragDropContext>
                ) : (
                  /* Simple flat list for card_swipe or standard without pages */
                  <DragDropContext onDragEnd={handleDragEnd}>
                    <Droppable droppableId="fields">
                      {(provided) => (
                        <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-4">
                          {formData.fields.map((field, index) => (
                            <FieldCard
                              key={field.id}
                              field={field}
                              index={index}
                              originalIndex={index}
                              updateField={updateField}
                              removeField={removeField}
                              FIELD_TYPES={FIELD_TYPES}
                              categories={categories}
                              customFields={customFields}
                              isApplicationForm={formData.is_application_form}
                              applicationLevel={formData.application_level}
                              uniquenessChecks={formData.uniqueness_checks}
                              onUniquenessChange={handleUniquenessChange}
                              prefillSource={formData.prefill_source || "none"}
                            />
                          ))}
                          {provided.placeholder}
                          
                          {/* Bottom Add Field button for flat list */}
                          {formData.fields.length > 0 && (
                            <div className="pt-2 flex justify-center">
                              <Button 
                                onClick={() => addField(null)} 
                                size="sm" 
                                variant="outline"
                                className="h-8"
                                data-testid="button-add-field-bottom"
                              >
                                <Plus className="w-4 h-4 mr-2" />
                                Add Field
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </Droppable>
                  </DragDropContext>
                )}
              </CardContent>
            </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

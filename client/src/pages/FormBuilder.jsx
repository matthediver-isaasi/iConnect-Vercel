
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, GripVertical, Save, ArrowLeft, FileText, ChevronDown, ChevronUp, Edit2, X, Eye, EyeOff, Lock, Unlock, UserCheck, UserMinus, Users, UserPlus, Mail, Copy, Code, ExternalLink, Filter } from "lucide-react";
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
import { Columns2, Columns3, ArrowRight, Settings2, Wand2, Building2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { COUNTRIES } from '@/data/countries';

const STANDARD_FIELD_TYPES = [
  { value: 'text', label: 'Text (Single Line)' },
  { value: 'textarea', label: 'Multi-line Text' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'Website URL' },
  { value: 'number', label: 'Number' },
  { value: 'tel', label: 'Phone' },
  { value: 'select', label: 'Dropdown' },
  { value: 'radio', label: 'Radio Buttons' },
  { value: 'checkbox', label: 'Checkboxes' },
  { value: 'boolean', label: 'Boolean (Toggle)' },
  { value: 'terms_conditions', label: 'Terms & Conditions' },
  { value: 'list', label: 'List (User-Defined Values)' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'file', label: 'File Upload' },
  { value: 'country', label: 'Country' },
  { value: 'countries', label: 'Countries (Multi-Select)' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'contact', label: 'Contact (Composite)' },
  { value: 'instructions', label: 'Instructions (Display Only)' },
];

const PREPOPULATE_FIELD_TYPES = [
  { value: 'organisation_dropdown', label: 'Organisation Dropdown' },
  { value: 'category_multiselect', label: 'Category Multi-Select' },
  { value: 'category_dropdown', label: 'Category Dropdown' },
  { value: 'communication_preferences', label: 'Communication Preferences' },
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
  { value: 'show_in_directory', label: 'Show in Member Directory' },
];

const ORG_CORE_FIELDS = [
  { value: 'name', label: 'Organisation Name' },
  { value: 'invoicing_email', label: 'Invoicing Email' },
  { value: 'invoicing_address', label: 'Invoicing Address' },
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
    { value: 'organization.invoicing_address', label: 'Invoicing Address', isEmail: false },
    { value: 'organization.phone', label: 'Organisation Phone', isEmail: false },
    { value: 'organization.website_url', label: 'Website URL', isEmail: false },
  ]
};

function FieldMappingSection({ 
  fields, 
  fieldMappings = [], 
  onMappingsChange,
  applicationLevel = "member",
  customFields = [],
  communicationCategories = [],  // Communication categories for marketing preferences
  // New props for entity pipeline use
  fixedTargetEntity = null,  // 'member' or 'organization' - locks entity selection
  showHeader = true,         // Whether to show the header with title and add button
  compact = false            // Compact mode for inline use
}) {
  const effectiveEntity = fixedTargetEntity || (applicationLevel === 'member' ? 'member' : 'organization');
  
  const addMapping = () => {
    const newMapping = {
      id: `mapping_${Date.now()}`,
      source_type: 'field', // 'field' or 'static'
      source_field_id: '',
      static_value: '',
      target_type: 'core', // 'core' or 'custom'
      target_entity: effectiveEntity,
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

  const getAvailableCommunicationCategories = () => {
    return communicationCategories || [];
  };

  const getCustomFieldById = (fieldId) => {
    return customFields.find(cf => cf.id === fieldId);
  };

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {showHeader && (
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
      )}

      {fieldMappings.length === 0 ? (
        <div className={`text-center ${compact ? 'py-4' : 'py-8'} text-slate-400 border border-dashed border-slate-200 rounded-lg`}>
          <Wand2 className={`${compact ? 'w-6 h-6' : 'w-8 h-8'} mx-auto mb-2 opacity-50`} />
          <p className="text-sm">No field mappings defined</p>
          <p className="text-xs mt-1">
            {fixedTargetEntity 
              ? `Add mappings to save form data to ${fixedTargetEntity === 'member' ? 'member' : 'organisation'} profile`
              : 'Add mappings to save form data to member/organisation profiles'
            }
          </p>
          {!showHeader && (
            <Button 
              onClick={addMapping} 
              size="sm" 
              variant="outline"
              className="mt-3"
              data-testid="button-add-first-mapping"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Mapping
            </Button>
          )}
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
                        static_value: value === 'clear' ? '__clear__' : ''
                      })}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-source-type-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="field">Form Field</SelectItem>
                        <SelectItem value="static">Fixed Value</SelectItem>
                        <SelectItem value="clear">Clear Field</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Source Field or Static Value or Clear indicator */}
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
                  ) : sourceType === 'clear' ? (
                    <div className="space-y-1 min-w-[160px] flex-1">
                      <Label className="text-xs">Action</Label>
                      <div className="h-9 px-3 flex items-center text-sm text-muted-foreground bg-slate-100 border rounded-md">
                        Will clear/remove existing value
                      </div>
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
                      onValueChange={(value) => {
                        const updates = { 
                          target_type: value, 
                          target_field: '',
                          static_value: ''
                        };
                        if (value === 'communication') {
                          updates.target_entity = 'member';
                        }
                        updateMapping(mapping.id, updates);
                      }}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-target-type-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="core">Core</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                        {(mapping.target_entity === 'member' || effectiveEntity === 'member') && communicationCategories.length > 0 && (
                          <SelectItem value="communication">Communication</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Target Entity - hidden when fixedTargetEntity is set */}
                  {!fixedTargetEntity && (
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
                  )}

                  {/* Target Field */}
                  <div className="space-y-1 min-w-[140px] flex-1">
                    <Label className="text-xs">{mapping.target_type === 'communication' ? 'Category' : 'Target Field'}</Label>
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
                        ) : mapping.target_type === 'communication' ? (
                          getAvailableCommunicationCategories().length === 0 ? (
                            <SelectItem value="__none" disabled>No communication categories available</SelectItem>
                          ) : (
                            getAvailableCommunicationCategories().map(cat => (
                              <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                            ))
                          )
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
          
          {/* Add Mapping button at bottom when header is hidden */}
          {!showHeader && (
            <Button 
              onClick={addMapping} 
              size="sm" 
              variant="outline"
              className="w-full"
              data-testid="button-add-more-mappings"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Mapping
            </Button>
          )}
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
  // Track the last rules JSON we migrated to detect new data
  const lastMigratedJsonRef = React.useRef(null);

  // Migrate and consolidate visibility actions (legacy + duplicates)
  const consolidateVisibilityActions = (actions, ruleId) => {
    if (!actions || !Array.isArray(actions)) return { actions: actions || [], migrated: false };
    
    // Check if there are any legacy or multiple visibility actions to consolidate
    const legacyActions = actions.filter(a => 
      ['show', 'hide', 'enable', 'disable'].includes(a.action_type)
    );
    const visibilityActions = actions.filter(a => a.action_type === 'visibility');
    
    // No consolidation needed if no legacy actions and at most one visibility action
    if (legacyActions.length === 0 && visibilityActions.length <= 1) {
      return { actions, migrated: false };
    }
    
    // Find the first visibility action to use as base (preserve all its properties)
    const baseVisibilityAction = visibilityActions[0];
    const field_states = baseVisibilityAction?.field_states ? { ...baseVisibilityAction.field_states } : {};
    
    // Merge additional visibility actions' field_states (if duplicates exist)
    for (let i = 1; i < visibilityActions.length; i++) {
      const extraAction = visibilityActions[i];
      if (extraAction.field_states) {
        for (const [fieldId, state] of Object.entries(extraAction.field_states)) {
          if (!field_states[fieldId]) {
            field_states[fieldId] = { visible: null, enabled: null };
          }
          // Later actions override earlier ones
          if (state.visible !== null && state.visible !== undefined) {
            field_states[fieldId].visible = state.visible;
          }
          if (state.enabled !== null && state.enabled !== undefined) {
            field_states[fieldId].enabled = state.enabled;
          }
        }
      }
    }
    
    // Merge legacy actions into field_states
    for (const action of legacyActions) {
      const fieldIds = action.target_field_ids || [];
      for (const fieldId of fieldIds) {
        if (!field_states[fieldId]) {
          field_states[fieldId] = { visible: null, enabled: null };
        }
        
        if (action.action_type === 'show') {
          field_states[fieldId].visible = true;
        } else if (action.action_type === 'hide') {
          field_states[fieldId].visible = false;
        } else if (action.action_type === 'enable') {
          field_states[fieldId].enabled = true;
        } else if (action.action_type === 'disable') {
          field_states[fieldId].enabled = false;
        }
      }
    }
    
    // Filter out all legacy and visibility actions
    const otherActions = actions.filter(a => 
      !['show', 'hide', 'enable', 'disable', 'visibility'].includes(a.action_type)
    );
    
    // Add the consolidated visibility action, preserving base action properties
    if (Object.keys(field_states).length > 0 || baseVisibilityAction) {
      otherActions.unshift({
        ...(baseVisibilityAction || {}),
        id: baseVisibilityAction?.id || `action_vis_${ruleId}`,
        action_type: 'visibility',
        field_states
      });
    }
    
    return { actions: otherActions, migrated: true };
  };

  // Normalize and migrate rules on initial load or when rules change
  useEffect(() => {
    if (!visibilityRules || visibilityRules.length === 0) return;
    
    // Use JSON comparison to detect new data (handles cached array references)
    const currentJson = JSON.stringify(visibilityRules);
    if (lastMigratedJsonRef.current === currentJson) return;
    
    let needsUpdate = false;
    const migratedRules = visibilityRules.map(rule => {
      // Preserve all existing rule properties
      let normalizedRule = { ...rule };
      
      // First normalize to actions array format if needed
      if (!rule.actions || !Array.isArray(rule.actions)) {
        needsUpdate = true;
        const actions = [];
        if (rule.rule_type === 'set_value' || rule.action === 'set_value') {
          actions.push({
            id: `action_${rule.id}_1`,
            action_type: 'set_value',
            target_field_id: rule.target_field_id || '',
            set_value_source: rule.set_value_source || 'static',
            set_value: rule.set_value || '',
            set_value_field_id: rule.set_value_field_id || '',
            set_value_prefill_field: rule.set_value_prefill_field || ''
          });
        } else if (rule.target_field_ids && rule.target_field_ids.length > 0) {
          // Has old visibility format - convert directly to new visibility action
          const field_states = {};
          for (const fieldId of rule.target_field_ids) {
            field_states[fieldId] = { visible: null, enabled: null };
            if (rule.action === 'show') {
              field_states[fieldId].visible = true;
            } else if (rule.action === 'hide') {
              field_states[fieldId].visible = false;
            } else if (rule.action === 'enable') {
              field_states[fieldId].enabled = true;
            } else if (rule.action === 'disable') {
              field_states[fieldId].enabled = false;
            }
          }
          actions.push({
            id: `action_vis_${rule.id}`,
            action_type: 'visibility',
            field_states
          });
        }
        normalizedRule = { ...normalizedRule, actions };
      }
      
      // Consolidate any legacy or duplicate visibility actions
      const { actions: consolidatedActions, migrated } = consolidateVisibilityActions(
        normalizedRule.actions, 
        normalizedRule.id
      );
      if (migrated) {
        needsUpdate = true;
        normalizedRule = { ...normalizedRule, actions: consolidatedActions };
      }
      
      // Migrate legacy trigger_field_id/operator/value to conditions array format
      if (!normalizedRule.conditions || !Array.isArray(normalizedRule.conditions)) {
        needsUpdate = true;
        const conditions = normalizedRule.trigger_field_id ? [{
          id: `cond_${normalizedRule.id}_0`,
          field_id: normalizedRule.trigger_field_id,
          operator: normalizedRule.operator || 'equals',
          value: normalizedRule.value || ''
        }] : [{
          id: `cond_${normalizedRule.id}_0`,
          field_id: '',
          operator: 'equals',
          value: ''
        }];
        
        normalizedRule = {
          ...normalizedRule,
          logic: normalizedRule.logic || 'and',
          conditions
        };
      }
      
      return normalizedRule;
    });
    
    // Mark as migrated before calling onRulesChange to prevent re-entry
    lastMigratedJsonRef.current = currentJson;
    
    if (needsUpdate) {
      console.log('[FormBuilder] Migrating legacy visibility rules to new format');
      // Update the ref to the new JSON so we don't re-trigger
      lastMigratedJsonRef.current = JSON.stringify(migratedRules);
      onRulesChange(migratedRules);
    }
  }, [visibilityRules, onRulesChange]);

  // Simple normalize for rendering - ensures default values exist
  // The actual migration is done in the useEffect above which persists the changes
  const normalizeRule = (rule) => {
    return {
      ...rule,
      actions: rule.actions || [],
      conditions: rule.conditions || [],
      logic: rule.logic || 'and'
    };
  };

  const addRule = () => {
    const newRule = {
      id: `rule_${Date.now()}`,
      logic: 'and', // Default to AND logic
      conditions: [{
        id: `cond_${Date.now()}`,
        field_id: '',
        operator: 'equals',
        value: ''
      }],
      actions: [] // Start with empty actions, user adds them
    };
    onRulesChange([...visibilityRules, newRule]);
  };

  const addCondition = (ruleId) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    const newCondition = {
      id: `cond_${Date.now()}`,
      field_id: '',
      operator: 'equals',
      value: ''
    };
    
    const updatedConditions = [...(normalizedRule.conditions || []), newCondition];
    updateRule(ruleId, { conditions: updatedConditions });
  };

  const updateCondition = (ruleId, conditionId, updates) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    const updatedConditions = (normalizedRule.conditions || []).map(c =>
      c.id === conditionId ? { ...c, ...updates } : c
    );
    updateRule(ruleId, { conditions: updatedConditions });
  };

  const removeCondition = (ruleId, conditionId) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    const updatedConditions = (normalizedRule.conditions || []).filter(c => c.id !== conditionId);
    
    // Ensure at least one condition remains
    if (updatedConditions.length === 0) {
      toast.info('At least one condition is required per rule');
      return;
    }
    
    updateRule(ruleId, { conditions: updatedConditions });
  };

  const getConditionFieldOptions = (fieldId) => {
    const field = fields.find(f => f.id === fieldId);
    if (!field) return [];
    
    if (field.type === 'select' || field.type === 'radio') {
      return field.options || [];
    }
    if (field.type === 'checkbox') {
      return field.options || [];
    }
    return [];
  };

  const addAction = (ruleId, actionType = 'visibility') => {
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
        set_value_prefill_field: '',
        formula_operand_a_mode: 'field',
        formula_operand_a_field_id: '',
        formula_operand_a_value: '',
        formula_operator: 'add',
        formula_operand_b_mode: 'field',
        formula_operand_b_field_id: '',
        formula_operand_b_value: ''
      };
    } else if (actionType === 'visibility') {
      // Consolidated visibility action - check if one already exists
      const existingVisibilityAction = (normalizedRule.actions || []).find(a => a.action_type === 'visibility');
      if (existingVisibilityAction) {
        toast.info('A visibility action already exists for this rule');
        return;
      }
      newAction = {
        id: `action_vis_${Date.now()}`,
        action_type: 'visibility',
        // field_states maps fieldId -> { visible: true/false/null, enabled: true/false/null }
        // null means inherit (no change)
        field_states: {}
      };
    } else {
      // Unknown action type
      toast.error('Unknown action type');
      return;
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

  // Update visibility state for a field in the consolidated visibility action
  const updateFieldVisibilityState = (ruleId, actionId, fieldId, property, value) => {
    const rule = visibilityRules.find(r => r.id === ruleId);
    if (!rule) return;
    
    const normalizedRule = normalizeRule(rule);
    const action = (normalizedRule.actions || []).find(a => a.id === actionId);
    if (!action || action.action_type !== 'visibility') return;
    
    const currentStates = action.field_states || {};
    const fieldState = currentStates[fieldId] || { visible: null, enabled: null };
    
    const newFieldState = { ...fieldState, [property]: value };
    
    // If both are null, remove the field entirely to keep payload clean
    const newStates = { ...currentStates };
    if (newFieldState.visible === null && newFieldState.enabled === null) {
      delete newStates[fieldId];
    } else {
      newStates[fieldId] = newFieldState;
    }
    
    updateAction(ruleId, actionId, { field_states: newStates });
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
            <Button
              variant={sourceType === 'formula' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => updateAction(ruleId, action.id, { 
                set_value_source: 'formula', 
                set_value: '', 
                set_value_field_id: '',
                set_value_prefill_field: '',
                formula_operand_a_mode: 'field',
                formula_operand_a_field_id: '',
                formula_operand_a_value: '',
                formula_operator: 'add',
                formula_operand_b_mode: 'field',
                formula_operand_b_field_id: '',
                formula_operand_b_value: ''
              })}
              data-testid={`button-source-formula-${actionIndex}`}
            >
              Formula
            </Button>
          </div>
        </div>

        {sourceType === 'formula' ? (
          <div className="space-y-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <Label className="text-xs font-medium text-blue-800">Calculate: Operand A {'{operator}'} Operand B</Label>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Operand A */}
              <div className="flex items-center gap-1">
                <div className="flex gap-0.5">
                  <Button
                    variant={(action.formula_operand_a_mode || 'field') === 'field' ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2 rounded-r-none"
                    onClick={() => updateAction(ruleId, action.id, { formula_operand_a_mode: 'field', formula_operand_a_value: '' })}
                    data-testid={`button-operand-a-field-${actionIndex}`}
                  >
                    Field
                  </Button>
                  <Button
                    variant={(action.formula_operand_a_mode || 'field') === 'value' ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2 rounded-l-none"
                    onClick={() => updateAction(ruleId, action.id, { formula_operand_a_mode: 'value', formula_operand_a_field_id: '' })}
                    data-testid={`button-operand-a-value-${actionIndex}`}
                  >
                    Value
                  </Button>
                </div>
                {(action.formula_operand_a_mode || 'field') === 'field' ? (
                  <Select
                    value={action.formula_operand_a_field_id || action.formula_field_a || undefined}
                    onValueChange={(value) => updateAction(ruleId, action.id, { formula_operand_a_field_id: value })}
                  >
                    <SelectTrigger className="h-9 w-32" data-testid={`select-formula-field-a-${actionIndex}`}>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableSourceFields.filter(f => ['number', 'percentage'].includes(f.type)).map(field => (
                        <SelectItem key={field.id} value={field.id}>
                          {field.label || field.type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type="number"
                    step="any"
                    value={action.formula_operand_a_value || ''}
                    onChange={(e) => updateAction(ruleId, action.id, { formula_operand_a_value: e.target.value })}
                    placeholder="0"
                    className="h-9 w-24"
                    data-testid={`input-formula-value-a-${actionIndex}`}
                  />
                )}
              </div>
              
              <Select
                value={action.formula_operator || 'add'}
                onValueChange={(value) => updateAction(ruleId, action.id, { formula_operator: value })}
              >
                <SelectTrigger className="h-9 w-24" data-testid={`select-formula-operator-${actionIndex}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">+ Add</SelectItem>
                  <SelectItem value="subtract">− Subtract</SelectItem>
                  <SelectItem value="multiply">× Multiply</SelectItem>
                  <SelectItem value="divide">÷ Divide</SelectItem>
                </SelectContent>
              </Select>
              
              {/* Operand B */}
              <div className="flex items-center gap-1">
                <div className="flex gap-0.5">
                  <Button
                    variant={(action.formula_operand_b_mode || 'field') === 'field' ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2 rounded-r-none"
                    onClick={() => updateAction(ruleId, action.id, { formula_operand_b_mode: 'field', formula_operand_b_value: '' })}
                    data-testid={`button-operand-b-field-${actionIndex}`}
                  >
                    Field
                  </Button>
                  <Button
                    variant={(action.formula_operand_b_mode || 'field') === 'value' ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2 rounded-l-none"
                    onClick={() => updateAction(ruleId, action.id, { formula_operand_b_mode: 'value', formula_operand_b_field_id: '' })}
                    data-testid={`button-operand-b-value-${actionIndex}`}
                  >
                    Value
                  </Button>
                </div>
                {(action.formula_operand_b_mode || 'field') === 'field' ? (
                  <Select
                    value={action.formula_operand_b_field_id || action.formula_field_b || undefined}
                    onValueChange={(value) => updateAction(ruleId, action.id, { formula_operand_b_field_id: value })}
                  >
                    <SelectTrigger className="h-9 w-32" data-testid={`select-formula-field-b-${actionIndex}`}>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableSourceFields.filter(f => ['number', 'percentage'].includes(f.type)).map(field => (
                        <SelectItem key={field.id} value={field.id}>
                          {field.label || field.type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type="number"
                    step="any"
                    value={action.formula_operand_b_value || ''}
                    onChange={(e) => updateAction(ruleId, action.id, { formula_operand_b_value: e.target.value })}
                    placeholder="0"
                    className="h-9 w-24"
                    data-testid={`input-formula-value-b-${actionIndex}`}
                  />
                )}
              </div>
            </div>
            <p className="text-xs text-blue-600">
              Result will be calculated when conditions are met. Use Field to reference form values or Value for fixed numbers.
            </p>
          </div>
        ) : sourceType === 'prefill' ? (
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
            const conditions = normalizedRule.conditions || [];
            const conditionFieldIds = conditions.map(c => c.field_id).filter(Boolean);
            // For visibility actions, exclude condition fields
            const availableTargetFields = fields.filter(f => !conditionFieldIds.includes(f.id));
            // For set_value actions, include ALL fields (including locked ones) - locked fields are prime targets for conditional value setting
            const availableSetValueTargetFields = fields;
            const actions = normalizedRule.actions || [];
            
            return (
              <div 
                key={rule.id} 
                className="p-4 border rounded-lg space-y-3 bg-slate-50 border-slate-200"
                data-testid={`rule-row-${index}`}
              >
                {/* Rule Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Settings2 className="w-4 h-4 text-slate-600" />
                    <span className="text-xs font-medium text-slate-600">
                      Rule #{index + 1} ({conditions.length} condition{conditions.length !== 1 ? 's' : ''}, {actions.length} action{actions.length !== 1 ? 's' : ''})
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRule(rule.id)}
                    className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                    data-testid={`button-delete-rule-${index}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>

                {/* AND/OR Logic Toggle - shown when multiple conditions */}
                {conditions.length > 1 && (
                  <div className="flex items-center gap-2 pb-2">
                    <Label className="text-xs text-slate-600">Match:</Label>
                    <div className="flex gap-1">
                      <Button
                        variant={normalizedRule.logic === 'and' ? 'default' : 'outline'}
                        size="sm"
                        className="h-7 text-xs px-3"
                        onClick={() => updateRule(rule.id, { logic: 'and' })}
                        data-testid={`button-logic-and-${index}`}
                      >
                        ALL conditions (AND)
                      </Button>
                      <Button
                        variant={normalizedRule.logic === 'or' ? 'default' : 'outline'}
                        size="sm"
                        className="h-7 text-xs px-3"
                        onClick={() => updateRule(rule.id, { logic: 'or' })}
                        data-testid={`button-logic-or-${index}`}
                      >
                        ANY condition (OR)
                      </Button>
                    </div>
                  </div>
                )}

                {/* Conditions */}
                <div className="space-y-2">
                  {conditions.map((condition, condIndex) => {
                    const conditionOptions = getConditionFieldOptions(condition.field_id);
                    const needsValueInput = condition.operator !== 'is_empty' && condition.operator !== 'not_empty';
                    
                    return (
                      <div key={condition.id} className="flex flex-wrap items-end gap-2 p-2 bg-white rounded border border-slate-200">
                        {/* Condition prefix label */}
                        <div className="flex items-center h-9 min-w-[50px]">
                          <span className="text-xs font-medium text-slate-500">
                            {condIndex === 0 ? 'When' : (normalizedRule.logic === 'and' ? 'AND' : 'OR')}
                          </span>
                        </div>
                        
                        {/* Field selector - exclude instructions type (display-only, not a data source) */}
                        <div className="space-y-1 min-w-[120px] flex-1">
                          <Select
                            value={condition.field_id || undefined}
                            onValueChange={(value) => {
                              if (value) {
                                updateCondition(rule.id, condition.id, { field_id: value, value: '' });
                              }
                            }}
                          >
                            <SelectTrigger className="h-9" data-testid={`select-condition-field-${index}-${condIndex}`}>
                              <SelectValue placeholder="Select field..." />
                            </SelectTrigger>
                            <SelectContent>
                              {fields.filter(f => f.type !== 'instructions').map(field => (
                                <SelectItem key={field.id} value={field.id}>
                                  {field.label || field.type}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Operator selector */}
                        <div className="space-y-1 min-w-[100px]">
                          <Select
                            value={condition.operator}
                            onValueChange={(value) => updateCondition(rule.id, condition.id, { operator: value })}
                          >
                            <SelectTrigger className="h-9" data-testid={`select-condition-operator-${index}-${condIndex}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {VISIBILITY_OPERATORS.map(op => (
                                <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Value input */}
                        {needsValueInput && (
                          <div className="space-y-1 min-w-[120px] flex-1">
                            {conditionOptions.length > 0 ? (
                              <Select
                                value={condition.value || undefined}
                                onValueChange={(value) => updateCondition(rule.id, condition.id, { value })}
                              >
                                <SelectTrigger className="h-9" data-testid={`select-condition-value-${index}-${condIndex}`}>
                                  <SelectValue placeholder="Select value..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {conditionOptions.map((opt, optIdx) => (
                                    <SelectItem key={optIdx} value={typeof opt === 'string' ? opt : opt.value || opt}>
                                      {typeof opt === 'string' ? opt : opt.label || opt.value || opt}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Input
                                value={condition.value || ''}
                                onChange={(e) => updateCondition(rule.id, condition.id, { value: e.target.value })}
                                placeholder="Enter value..."
                                className="h-9"
                                data-testid={`input-condition-value-${index}-${condIndex}`}
                              />
                            )}
                          </div>
                        )}

                        {/* Remove condition button - only if more than 1 condition */}
                        {conditions.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeCondition(rule.id, condition.id)}
                            className="h-9 w-9 text-slate-400 hover:text-red-600 hover:bg-red-50"
                            data-testid={`button-remove-condition-${index}-${condIndex}`}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  
                  {/* Add condition button */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => addCondition(rule.id)}
                    data-testid={`button-add-condition-${index}`}
                  >
                    <Plus className="w-3 h-3 mr-1" /> Add Condition
                  </Button>
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
                        onClick={() => addAction(rule.id, 'visibility')}
                        data-testid={`button-add-visibility-action-${index}`}
                      >
                        <Eye className="w-3 h-3 mr-1" /> Visibility
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
                    </div>
                  </div>

                  {actions.length === 0 ? (
                    <div className="text-center py-4 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                      <p className="text-xs">No actions defined. Add an action above.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {actions.map((action, actionIndex) => {
                        const isLegacyVisibilityAction = action.action_type === 'show' || action.action_type === 'hide';
                        const isLegacyDisabilityAction = action.action_type === 'disable' || action.action_type === 'enable';
                        const isLegacyFieldTargetAction = isLegacyVisibilityAction || isLegacyDisabilityAction;
                        const isConsolidatedVisibility = action.action_type === 'visibility';
                        // Determine card styling
                        let cardClass = 'p-3 rounded-lg border ';
                        if (isConsolidatedVisibility) {
                          cardClass += 'bg-slate-50 border-slate-300';
                        } else if (isLegacyVisibilityAction) {
                          cardClass += 'bg-white border-slate-200';
                        } else if (isLegacyDisabilityAction) {
                          cardClass += 'bg-orange-50 border-orange-200';
                        } else {
                          cardClass += 'bg-blue-50 border-blue-200';
                        }
                        
                        return (
                          <div 
                            key={action.id} 
                            className={cardClass}
                            data-testid={`action-row-${index}-${actionIndex}`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                {action.action_type === 'visibility' && <Eye className="w-3 h-3 text-slate-600" />}
                                {action.action_type === 'show' && <Eye className="w-3 h-3 text-green-600" />}
                                {action.action_type === 'hide' && <EyeOff className="w-3 h-3 text-slate-600" />}
                                {action.action_type === 'set_value' && <Edit2 className="w-3 h-3 text-blue-600" />}
                                {action.action_type === 'disable' && <Lock className="w-3 h-3 text-orange-600" />}
                                {action.action_type === 'enable' && <Unlock className="w-3 h-3 text-teal-600" />}
                                <span className="text-xs font-medium">
                                  {action.action_type === 'visibility' && 'Field Visibility & State'}
                                  {action.action_type === 'show' && 'Show Fields (Legacy)'}
                                  {action.action_type === 'hide' && 'Hide Fields (Legacy)'}
                                  {action.action_type === 'set_value' && 'Set Field Value'}
                                  {action.action_type === 'disable' && 'Disable Fields (Legacy)'}
                                  {action.action_type === 'enable' && 'Enable Fields (Legacy)'}
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

                            {isConsolidatedVisibility ? (
                              <div>
                                <p className="text-xs text-slate-500 mb-3">
                                  Configure visibility and enabled state for each field. Leave as "Inherit" for no change.
                                </p>
                                {availableTargetFields.length === 0 ? (
                                  <p className="text-xs text-slate-400">Add more fields to configure visibility</p>
                                ) : (
                                  <div className="border rounded-lg overflow-hidden">
                                    <div className="grid grid-cols-[1fr,120px,120px] gap-2 bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600 border-b">
                                      <div>Field</div>
                                      <div className="text-center">Visibility</div>
                                      <div className="text-center">State</div>
                                    </div>
                                    <div className="max-h-64 overflow-y-auto">
                                      {availableTargetFields.map((field, fieldIdx) => {
                                        const fieldState = (action.field_states || {})[field.id] || { visible: null, enabled: null };
                                        return (
                                          <div 
                                            key={field.id} 
                                            className={`grid grid-cols-[1fr,120px,120px] gap-2 px-3 py-2 text-xs items-center ${fieldIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}`}
                                            data-testid={`visibility-row-${index}-${actionIndex}-${field.id}`}
                                          >
                                            <div className="font-medium truncate" title={field.label || field.type}>
                                              {field.label || field.type}
                                            </div>
                                            <div className="flex justify-center">
                                              <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
                                                <button
                                                  type="button"
                                                  onClick={() => updateFieldVisibilityState(rule.id, action.id, field.id, 'visible', true)}
                                                  className={`px-2 py-1 text-xs ${fieldState.visible === true ? 'bg-green-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                                  title="Show"
                                                  data-testid={`btn-show-${index}-${actionIndex}-${field.id}`}
                                                >
                                                  <Eye className="w-3 h-3" />
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => updateFieldVisibilityState(rule.id, action.id, field.id, 'visible', null)}
                                                  className={`px-2 py-1 text-xs border-l border-r border-slate-200 ${fieldState.visible === null ? 'bg-slate-200 text-slate-700' : 'bg-white text-slate-400 hover:bg-slate-50'}`}
                                                  title="Inherit (no change)"
                                                  data-testid={`btn-inherit-vis-${index}-${actionIndex}-${field.id}`}
                                                >
                                                  —
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => updateFieldVisibilityState(rule.id, action.id, field.id, 'visible', false)}
                                                  className={`px-2 py-1 text-xs ${fieldState.visible === false ? 'bg-red-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                                  title="Hide"
                                                  data-testid={`btn-hide-${index}-${actionIndex}-${field.id}`}
                                                >
                                                  <EyeOff className="w-3 h-3" />
                                                </button>
                                              </div>
                                            </div>
                                            <div className="flex justify-center">
                                              <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
                                                <button
                                                  type="button"
                                                  onClick={() => updateFieldVisibilityState(rule.id, action.id, field.id, 'enabled', true)}
                                                  className={`px-2 py-1 text-xs ${fieldState.enabled === true ? 'bg-green-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                                  title="Enable"
                                                  data-testid={`btn-enable-${index}-${actionIndex}-${field.id}`}
                                                >
                                                  <Unlock className="w-3 h-3" />
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => updateFieldVisibilityState(rule.id, action.id, field.id, 'enabled', null)}
                                                  className={`px-2 py-1 text-xs border-l border-r border-slate-200 ${fieldState.enabled === null ? 'bg-slate-200 text-slate-700' : 'bg-white text-slate-400 hover:bg-slate-50'}`}
                                                  title="Inherit (no change)"
                                                  data-testid={`btn-inherit-state-${index}-${actionIndex}-${field.id}`}
                                                >
                                                  —
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => updateFieldVisibilityState(rule.id, action.id, field.id, 'enabled', false)}
                                                  className={`px-2 py-1 text-xs ${fieldState.enabled === false ? 'bg-orange-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                                  title="Disable"
                                                  data-testid={`btn-disable-${index}-${actionIndex}-${field.id}`}
                                                >
                                                  <Lock className="w-3 h-3" />
                                                </button>
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : isLegacyFieldTargetAction ? (
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
                                      // Determine background color based on action type and selection
                                      let buttonClass = "h-7 text-xs ";
                                      if (isSelected) {
                                        if (action.action_type === 'show' || action.action_type === 'enable') {
                                          // Green for show/enable actions
                                          buttonClass += "bg-green-600 hover:bg-green-700 text-white border-green-600";
                                        } else if (action.action_type === 'hide' || action.action_type === 'disable') {
                                          // Red for hide/disable actions
                                          buttonClass += "bg-red-600 hover:bg-red-700 text-white border-red-600";
                                        }
                                      }
                                      return (
                                        <Button
                                          key={field.id}
                                          variant={isSelected ? "default" : "outline"}
                                          size="sm"
                                          className={buttonClass}
                                          onClick={() => toggleTargetFieldInAction(rule.id, action.id, field.id)}
                                          data-testid={`button-action-target-${index}-${actionIndex}-${field.id}`}
                                        >
                                          {field.label || field.type}
                                        </Button>
                                      );
                                    })}
                                  </div>
                                )}
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
                                      {availableSetValueTargetFields.map(field => (
                                        <SelectItem key={field.id} value={field.id}>
                                          {field.label || field.type} ({field.type}){field.locked ? ' [Locked]' : ''}
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

// EmailCard component for configuring individual email notifications
function EmailCard({
  email,
  index,
  emailTemplates,
  formFields,
  onUpdate,
  onRemove
}) {
  const selectedTemplate = emailTemplates.find(t => t.id === email.template_id);
  
  // Extract placeholders from template
  const extractPlaceholders = (text) => {
    if (!text) return [];
    const regex = /\{\{([^}]+)\}\}/g;
    const placeholders = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const placeholder = match[1].trim();
      if (!placeholders.includes(placeholder)) {
        placeholders.push(placeholder);
      }
    }
    return placeholders;
  };
  
  const SYSTEM_PREFIXES = ['member.', 'organization.', 'form.', 'submission.'];
  const isSystemPlaceholder = (p) => SYSTEM_PREFIXES.some(prefix => p.startsWith(prefix));
  
  const allPlaceholders = selectedTemplate ? [...new Set([
    ...extractPlaceholders(selectedTemplate.subject),
    ...extractPlaceholders(selectedTemplate.body)
  ])] : [];
  
  const customPlaceholders = allPlaceholders.filter(p => !isSystemPlaceholder(p));
  
  // Get email fields from form
  const emailFields = formFields.filter(f => f.type === 'email' || f.type === 'user_email');
  
  // Helper to parse recipient field value
  const parseRecipientValue = (value) => {
    if (!value) return { type: '_custom', fieldId: null };
    if (value.startsWith('{{') && value.endsWith('}}')) {
      return { type: 'field', fieldId: value.slice(2, -2) };
    }
    return { type: '_custom', fieldId: null };
  };
  
  const recipientInfo = parseRecipientValue(email.recipient);
  const ccInfo = parseRecipientValue(email.cc);
  const bccInfo = parseRecipientValue(email.bcc);
  
  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-medium">Email {index + 1}</span>
            {selectedTemplate && (
              <Badge variant="outline" className="text-xs">
                {selectedTemplate.name}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            className="h-7 w-7 text-red-600 hover:text-red-700 hover:bg-red-50"
            data-testid={`button-remove-email-${email.id}`}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Template Selection */}
        <div className="space-y-1">
          <Label className="text-xs text-slate-600">Email Template</Label>
          <Select
            value={email.template_id || '_none'}
            onValueChange={(val) => onUpdate({ 
              template_id: val === '_none' ? null : val,
              field_mapping: {} // Reset mappings when template changes
            })}
          >
            <SelectTrigger data-testid={`select-email-template-${email.id}`}>
              <SelectValue placeholder="Select template" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">Select template...</SelectItem>
              {emailTemplates.map(t => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        {email.template_id && (
          <>
            {/* Recipient (To) */}
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">Send To</Label>
              <div className="space-y-2">
                <Select
                  value={recipientInfo.type === 'field' ? recipientInfo.fieldId : '_custom'}
                  onValueChange={(val) => {
                    if (val === '_custom') {
                      onUpdate({ recipient: '' });
                    } else {
                      onUpdate({ recipient: `{{${val}}}` });
                    }
                  }}
                >
                  <SelectTrigger data-testid={`select-email-recipient-${email.id}`}>
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {emailFields.length > 0 && emailFields.map(field => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.label || field.id}
                      </SelectItem>
                    ))}
                    <SelectItem value="_custom">Custom email address</SelectItem>
                  </SelectContent>
                </Select>
                {recipientInfo.type === '_custom' && (
                  <Input
                    value={email.recipient || ''}
                    onChange={(e) => onUpdate({ recipient: e.target.value })}
                    placeholder="recipient@example.com"
                    data-testid={`input-email-recipient-${email.id}`}
                  />
                )}
              </div>
            </div>
            
            {/* CC */}
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">CC (Optional)</Label>
              <div className="space-y-2">
                <Select
                  value={ccInfo.type === 'field' ? ccInfo.fieldId : (email.cc ? '_custom' : '_none')}
                  onValueChange={(val) => {
                    if (val === '_none') {
                      onUpdate({ cc: '' });
                    } else if (val === '_custom') {
                      onUpdate({ cc: '' });
                    } else {
                      onUpdate({ cc: `{{${val}}}` });
                    }
                  }}
                >
                  <SelectTrigger data-testid={`select-email-cc-${email.id}`}>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {emailFields.map(field => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.label || field.id}
                      </SelectItem>
                    ))}
                    <SelectItem value="_custom">Custom email address</SelectItem>
                  </SelectContent>
                </Select>
                {(ccInfo.type === '_custom' || (email.cc && !email.cc.startsWith('{{'))) && (
                  <Input
                    value={email.cc || ''}
                    onChange={(e) => onUpdate({ cc: e.target.value })}
                    placeholder="cc@example.com"
                    data-testid={`input-email-cc-${email.id}`}
                  />
                )}
              </div>
            </div>
            
            {/* BCC */}
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">BCC (Optional)</Label>
              <div className="space-y-2">
                <Select
                  value={bccInfo.type === 'field' ? bccInfo.fieldId : (email.bcc ? '_custom' : '_none')}
                  onValueChange={(val) => {
                    if (val === '_none') {
                      onUpdate({ bcc: '' });
                    } else if (val === '_custom') {
                      onUpdate({ bcc: '' });
                    } else {
                      onUpdate({ bcc: `{{${val}}}` });
                    }
                  }}
                >
                  <SelectTrigger data-testid={`select-email-bcc-${email.id}`}>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {emailFields.map(field => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.label || field.id}
                      </SelectItem>
                    ))}
                    <SelectItem value="_custom">Custom email address</SelectItem>
                  </SelectContent>
                </Select>
                {(bccInfo.type === '_custom' || (email.bcc && !email.bcc.startsWith('{{'))) && (
                  <Input
                    value={email.bcc || ''}
                    onChange={(e) => onUpdate({ bcc: e.target.value })}
                    placeholder="bcc@example.com"
                    data-testid={`input-email-bcc-${email.id}`}
                  />
                )}
              </div>
            </div>
            
            {/* Placeholder Field Mappings */}
            {customPlaceholders.length > 0 && (
              <div className="p-3 bg-slate-50 rounded-lg space-y-3">
                <div>
                  <Label className="text-xs font-medium">Map Placeholders</Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Map template placeholders to form fields
                  </p>
                </div>
                <div className="space-y-2">
                  {customPlaceholders.map(placeholder => {
                    const currentMapping = email.field_mapping?.[placeholder] || '';
                    return (
                      <div key={placeholder} className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-xs shrink-0">
                          {`{{${placeholder}}}`}
                        </Badge>
                        <Select
                          value={currentMapping || '_none'}
                          onValueChange={(val) => {
                            onUpdate({
                              field_mapping: {
                                ...email.field_mapping,
                                [placeholder]: val === '_none' ? '' : val
                              }
                            });
                          }}
                        >
                          <SelectTrigger className="flex-1" data-testid={`select-placeholder-${email.id}-${placeholder}`}>
                            <SelectValue placeholder="Select field" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_none">Not mapped</SelectItem>
                            {formFields.map(field => (
                              <SelectItem key={field.id} value={field.id}>
                                {field.label || field.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            
            {/* Send Condition */}
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <Filter className="w-3 h-3" />
                    Send Condition
                  </Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Only send this email when a field value matches
                  </p>
                </div>
                <Switch
                  checked={!!email.condition}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      onUpdate({ 
                        condition: { 
                          field_id: '', 
                          operator: 'equals', 
                          value: '' 
                        } 
                      });
                    } else {
                      onUpdate({ condition: null });
                    }
                  }}
                  data-testid={`switch-email-condition-${email.id}`}
                />
              </div>
              
              {email.condition && (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <Select
                      value={email.condition.field_id || '_none'}
                      onValueChange={(val) => {
                        onUpdate({
                          condition: {
                            ...email.condition,
                            field_id: val === '_none' ? '' : val
                          }
                        });
                      }}
                    >
                      <SelectTrigger data-testid={`select-condition-field-${email.id}`}>
                        <SelectValue placeholder="Select field" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">Select field...</SelectItem>
                        {formFields.filter(f => 
                          ['text', 'email', 'select', 'radio', 'checkbox', 'number', 'phone', 'url'].includes(f.type)
                        ).map(field => (
                          <SelectItem key={field.id} value={field.id}>
                            {field.label || field.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    
                    <Select
                      value={email.condition.operator || 'equals'}
                      onValueChange={(val) => {
                        onUpdate({
                          condition: {
                            ...email.condition,
                            operator: val
                          }
                        });
                      }}
                    >
                      <SelectTrigger data-testid={`select-condition-operator-${email.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="equals">Equals</SelectItem>
                        <SelectItem value="not_equals">Does not equal</SelectItem>
                        <SelectItem value="contains">Contains</SelectItem>
                        <SelectItem value="not_contains">Does not contain</SelectItem>
                        <SelectItem value="is_empty">Is empty</SelectItem>
                        <SelectItem value="is_not_empty">Is not empty</SelectItem>
                      </SelectContent>
                    </Select>
                    
                    {!['is_empty', 'is_not_empty'].includes(email.condition.operator) && (
                      <Input
                        value={email.condition.value || ''}
                        onChange={(e) => {
                          onUpdate({
                            condition: {
                              ...email.condition,
                              value: e.target.value
                            }
                          });
                        }}
                        placeholder="Value to match"
                        data-testid={`input-condition-value-${email.id}`}
                      />
                    )}
                  </div>
                  
                  {email.condition.field_id && (
                    <p className="text-xs text-amber-700">
                      Email will only send when{' '}
                      <span className="font-medium">
                        {formFields.find(f => f.id === email.condition.field_id)?.label || email.condition.field_id}
                      </span>
                      {' '}
                      {email.condition.operator === 'equals' && `equals "${email.condition.value}"`}
                      {email.condition.operator === 'not_equals' && `does not equal "${email.condition.value}"`}
                      {email.condition.operator === 'contains' && `contains "${email.condition.value}"`}
                      {email.condition.operator === 'not_contains' && `does not contain "${email.condition.value}"`}
                      {email.condition.operator === 'is_empty' && 'is empty'}
                      {email.condition.operator === 'is_not_empty' && 'is not empty'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FieldCard({ 
  field, 
  index, 
  originalIndex, 
  updateField, 
  removeField, 
  FIELD_TYPES, 
  categories = [],
  customFields = [],
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
      let newErrorMessage = updates.error_message !== undefined ? updates.error_message : (uniquenessCheck?.error_message || '');
      
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
        comparison_mode: newComparisonMode,
        error_message: newErrorMessage
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
                  <Label className="text-xs font-medium text-blue-800">Pre-fill from Member or Organisation data</Label>
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
                        Member Core Fields
                      </div>
                      {MEMBER_PREFILL_FIELDS.map(f => (
                        <SelectItem key={`member:${f.value}`} value={`member:${f.value}`}>{f.label}</SelectItem>
                      ))}
                      {customFields.filter(cf => !cf.entity_scope || cf.entity_scope === 'member').length > 0 && (
                        <>
                          <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                            Member Custom Fields
                          </div>
                          {customFields.filter(cf => !cf.entity_scope || cf.entity_scope === 'member').map(cf => (
                            <SelectItem key={`member_custom:${cf.id}`} value={`member_custom:${cf.id}`}>{cf.label}</SelectItem>
                          ))}
                        </>
                      )}
                      <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                        Organisation Core Fields
                      </div>
                      {ORG_PREFILL_FIELDS.map(f => (
                        <SelectItem key={`org:${f.value}`} value={`org:${f.value}`}>{f.label}</SelectItem>
                      ))}
                      {customFields.filter(cf => cf.entity_scope === 'organization').length > 0 && (
                        <>
                          <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                            Organisation Custom Fields
                          </div>
                          {customFields.filter(cf => cf.entity_scope === 'organization').map(cf => (
                            <SelectItem key={`org_custom:${cf.id}`} value={`org_custom:${cf.id}`}>{cf.label}</SelectItem>
                          ))}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Uniqueness Check */}
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
                      
                      <div className="space-y-1">
                        <Label className="text-xs text-slate-600">Custom error message (optional):</Label>
                        <Input
                          type="text"
                          value={uniquenessCheck?.error_message || ''}
                          onChange={(e) => handleUniquenessUpdate({ error_message: e.target.value })}
                          placeholder="e.g., An organisation with this name already exists"
                          className="h-8 text-xs"
                          data-testid={`input-uniqueness-error-message-${field.id}`}
                        />
                        <p className="text-xs text-slate-500">Leave blank to use the default message</p>
                      </div>
                      
                      {targetField && (
                        <p className="text-xs text-amber-700">
                          Will check if submitted value already exists in {targetField.replace('.', ' → ')}
                        </p>
                      )}
                    </div>
                  )}
              </div>

              {field.type === 'boolean' && (
                <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div>
                    <Label className="text-xs font-medium">Default Value</Label>
                    <p className="text-xs text-slate-500 mt-0.5">Initial state when form loads</p>
                  </div>
                  <Switch
                    checked={field.default_value === true}
                    onCheckedChange={(checked) => updateField(originalIndex, { default_value: checked })}
                    data-testid={`switch-default-value-${field.id}`}
                  />
                </div>
              )}

              {field.type === 'terms_conditions' && (
                <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Terms & Conditions URL</Label>
                    <Input
                      type="url"
                      value={field.terms_url || ''}
                      onChange={(e) => updateField(originalIndex, { terms_url: e.target.value })}
                      placeholder="https://example.com/terms"
                      className="h-8 text-xs"
                      data-testid={`input-terms-url-${field.id}`}
                    />
                    <p className="text-xs text-slate-500">Link to your terms & conditions page</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Link Display Text</Label>
                    <Input
                      type="text"
                      value={field.terms_link_text || ''}
                      onChange={(e) => updateField(originalIndex, { terms_link_text: e.target.value })}
                      placeholder="View Terms & Conditions"
                      className="h-8 text-xs"
                      data-testid={`input-terms-link-text-${field.id}`}
                    />
                    <p className="text-xs text-slate-500">Text shown for the link (default: "View Terms & Conditions")</p>
                  </div>
                </div>
              )}

              {field.type === 'email' && (
                <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div>
                    <Label className="text-xs font-medium">Restrict to Organisation Domain</Label>
                    <p className="text-xs text-slate-500 mt-0.5">Email must match organisation's verified domains</p>
                  </div>
                  <Switch
                    checked={field.validate_org_domain === true}
                    onCheckedChange={(checked) => updateField(originalIndex, { validate_org_domain: checked })}
                    data-testid={`switch-validate-org-domain-${field.id}`}
                  />
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

                      <div className="pt-3 border-t border-slate-200 mt-3">
                        <div className="flex items-start gap-2 p-2 bg-blue-50 border border-blue-200 rounded-md">
                          <div className="text-blue-600 mt-0.5">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </div>
                          <div>
                            <p className="text-xs font-medium text-blue-800">Auto-saved to Member Preferences</p>
                            <p className="text-xs text-blue-600 mt-0.5">
                              Category selections are automatically saved to the member's preferences. No manual mapping required.
                            </p>
                          </div>
                        </div>
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

              {/* Country Field Configuration */}
              {field.type === 'country' && (
                <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <Label className="text-xs font-medium">Country Options</Label>
                  
                  {/* All Countries Toggle */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`all-countries-${field.id}`}
                      checked={field.all_countries !== false}
                      onCheckedChange={(checked) => {
                        updateField(originalIndex, { 
                          all_countries: checked,
                          selected_countries: checked ? [] : (field.selected_countries || [])
                        });
                      }}
                    />
                    <Label htmlFor={`all-countries-${field.id}`} className="text-xs">
                      Include all countries
                    </Label>
                  </div>
                  
                  {/* Country Selection (when not all) */}
                  {field.all_countries === false && (
                    <div className="space-y-2">
                      <Label className="text-xs text-slate-500">Select countries to include:</Label>
                      <div className="max-h-48 overflow-y-auto border border-slate-200 rounded bg-white p-2 space-y-1">
                        {COUNTRIES.map((country) => (
                          <div key={country.code} className="flex items-center gap-2">
                            <Checkbox
                              id={`country-${field.id}-${country.code}`}
                              checked={(field.selected_countries || []).includes(country.code)}
                              onCheckedChange={(checked) => {
                                const current = field.selected_countries || [];
                                const updated = checked 
                                  ? [...current, country.code]
                                  : current.filter(c => c !== country.code);
                                updateField(originalIndex, { selected_countries: updated });
                              }}
                            />
                            <Label htmlFor={`country-${field.id}-${country.code}`} className="text-xs">
                              {country.name}
                            </Label>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-slate-500">
                        {(field.selected_countries || []).length} countries selected
                      </p>
                    </div>
                  )}
                  
                  {/* Default Country */}
                  <div className="space-y-1">
                    <Label className="text-xs">Default Country</Label>
                    <Select
                      value={field.default_country || '__none__'}
                      onValueChange={(value) => updateField(originalIndex, { default_country: value === '__none__' ? '' : value })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="No default" />
                      </SelectTrigger>
                      <SelectContent className="max-h-60 overflow-y-auto">
                        <SelectItem value="__none__">No default</SelectItem>
                        {(field.all_countries !== false ? COUNTRIES : COUNTRIES.filter(c => (field.selected_countries || []).includes(c.code))).map((country) => (
                          <SelectItem key={country.code} value={country.code}>
                            {country.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* Countries (Multi-Select) Field Configuration */}
              {field.type === 'countries' && (
                <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <Label className="text-xs font-medium">Countries Options (Multi-Select)</Label>
                  
                  {/* All Countries Toggle */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`all-countries-multi-${field.id}`}
                      checked={field.all_countries !== false}
                      onCheckedChange={(checked) => {
                        updateField(originalIndex, { 
                          all_countries: checked,
                          selected_countries: checked ? [] : (field.selected_countries || [])
                        });
                      }}
                    />
                    <Label htmlFor={`all-countries-multi-${field.id}`} className="text-xs">
                      Include all countries
                    </Label>
                  </div>
                  
                  {/* Country Selection (when not all) */}
                  {field.all_countries === false && (
                    <div className="space-y-2">
                      <Label className="text-xs text-slate-500">Select countries to include:</Label>
                      <div className="max-h-48 overflow-y-auto border border-slate-200 rounded bg-white p-2 space-y-1">
                        {COUNTRIES.map((country) => (
                          <div key={country.code} className="flex items-center gap-2">
                            <Checkbox
                              id={`countries-${field.id}-${country.code}`}
                              checked={(field.selected_countries || []).includes(country.code)}
                              onCheckedChange={(checked) => {
                                const current = field.selected_countries || [];
                                const updated = checked 
                                  ? [...current, country.code]
                                  : current.filter(c => c !== country.code);
                                updateField(originalIndex, { selected_countries: updated });
                              }}
                            />
                            <Label htmlFor={`countries-${field.id}-${country.code}`} className="text-xs">
                              {country.name}
                            </Label>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-slate-500">
                        {(field.selected_countries || []).length} countries selected
                      </p>
                    </div>
                  )}
                  
                  {/* Default Countries */}
                  <div className="space-y-1">
                    <Label className="text-xs">Default Countries</Label>
                    <div className="max-h-32 overflow-y-auto border border-slate-200 rounded bg-white p-2 space-y-1">
                      {(field.all_countries !== false ? COUNTRIES : COUNTRIES.filter(c => (field.selected_countries || []).includes(c.code))).map((country) => (
                        <div key={country.code} className="flex items-center gap-2">
                          <Checkbox
                            id={`default-countries-${field.id}-${country.code}`}
                            checked={(field.default_countries || []).includes(country.code)}
                            onCheckedChange={(checked) => {
                              const current = field.default_countries || [];
                              const updated = checked 
                                ? [...current, country.code]
                                : current.filter(c => c !== country.code);
                              updateField(originalIndex, { default_countries: updated });
                            }}
                          />
                          <Label htmlFor={`default-countries-${field.id}-${country.code}`} className="text-xs">
                            {country.name}
                          </Label>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-slate-500">
                      {(field.default_countries || []).length} default countries selected
                    </p>
                  </div>
                </div>
              )}

              {/* Instructions Content - Rich text editor for display-only content */}
              {field.type === 'instructions' && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Instructions Content</Label>
                  <p className="text-xs text-slate-500 mb-2">This content will be displayed to users (not editable by them)</p>
                  <div className="bg-white rounded border border-slate-200">
                    <ReactQuill
                      theme="snow"
                      value={field.content || ''}
                      onChange={(value) => updateField(originalIndex, { content: value })}
                      placeholder="Enter instructions, guidance, or informational text..."
                      modules={{
                        toolbar: [
                          [{ 'header': [1, 2, 3, false] }],
                          ['bold', 'italic', 'underline'],
                          [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                          ['link'],
                          ['clean']
                        ]
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Default Value Section - for non-boolean fields */}
              {!['boolean', 'terms_conditions', 'file', 'list', 'instructions', 'country', 'countries', 'user_name', 'user_email', 'user_organization', 'user_job_title', 'organisation_dropdown', 'category_multiselect', 'category_dropdown', 'communication_preferences'].includes(field.type) && (
                <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <Label className="text-xs font-medium">Default Value</Label>
                  <p className="text-xs text-slate-500 mb-2">Pre-filled value when form loads</p>
                  
                  {/* Text-based fields */}
                  {['text', 'textarea', 'email', 'url', 'tel'].includes(field.type) && (
                    <Input
                      type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : field.type === 'tel' ? 'tel' : 'text'}
                      value={field.default_value || ''}
                      onChange={(e) => updateField(originalIndex, { default_value: e.target.value })}
                      placeholder="Enter default value..."
                      className="h-8 text-xs"
                      data-testid={`input-default-value-${field.id}`}
                    />
                  )}
                  
                  {/* Number field */}
                  {field.type === 'number' && (
                    <Input
                      type="number"
                      value={field.default_value ?? ''}
                      onChange={(e) => updateField(originalIndex, { default_value: e.target.value ? Number(e.target.value) : '' })}
                      placeholder="Enter default number..."
                      className="h-8 text-xs"
                      data-testid={`input-default-value-${field.id}`}
                    />
                  )}
                  
                  {/* Date field */}
                  {field.type === 'date' && (
                    <Input
                      type="date"
                      value={field.default_value || ''}
                      onChange={(e) => updateField(originalIndex, { default_value: e.target.value })}
                      className="h-8 text-xs"
                      data-testid={`input-default-value-${field.id}`}
                    />
                  )}
                  
                  {/* Time field */}
                  {field.type === 'time' && (
                    <Input
                      type="time"
                      value={field.default_value || ''}
                      onChange={(e) => updateField(originalIndex, { default_value: e.target.value })}
                      className="h-8 text-xs"
                      data-testid={`input-default-value-${field.id}`}
                    />
                  )}
                  
                  {/* Single-select fields (select, radio) - dropdown to pick from options */}
                  {['select', 'radio'].includes(field.type) && (
                    <>
                      {(field.options || []).length === 0 ? (
                        <p className="text-xs text-amber-600">Add options above first to set a default value</p>
                      ) : (
                        <Select
                          value={field.default_value || '__none__'}
                          onValueChange={(value) => updateField(originalIndex, { default_value: value === '__none__' ? null : value })}
                        >
                          <SelectTrigger className="h-8 text-xs" data-testid={`select-default-value-${field.id}`}>
                            <SelectValue placeholder="Select a default option..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">No default</SelectItem>
                            {(field.options || []).filter(opt => opt && opt.trim()).map((option, idx) => (
                              <SelectItem key={idx} value={option}>{option}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </>
                  )}
                  
                  {/* Multi-select field (checkbox) - checkboxes to pick defaults */}
                  {field.type === 'checkbox' && (
                    <>
                      {(field.options || []).length === 0 ? (
                        <p className="text-xs text-amber-600">Add options above first to set default values</p>
                      ) : (
                        <div className="space-y-1 max-h-32 overflow-y-auto">
                          {(field.options || []).filter(opt => opt && opt.trim()).map((option, idx) => {
                            const currentDefaults = Array.isArray(field.default_value) ? field.default_value : [];
                            const isChecked = currentDefaults.includes(option);
                            return (
                              <div key={idx} className="flex items-center gap-2">
                                <Checkbox
                                  id={`default-${field.id}-${idx}`}
                                  checked={isChecked}
                                  onCheckedChange={(checked) => {
                                    const newDefaults = checked
                                      ? [...currentDefaults, option]
                                      : currentDefaults.filter(v => v !== option);
                                    updateField(originalIndex, { default_value: newDefaults.length > 0 ? newDefaults : null });
                                  }}
                                />
                                <Label htmlFor={`default-${field.id}-${idx}`} className="text-xs cursor-pointer">
                                  {option}
                                </Label>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                  
                  {field.default_value && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-slate-500 hover:text-red-600"
                      onClick={() => updateField(originalIndex, { default_value: null })}
                    >
                      <X className="w-3 h-3 mr-1" />
                      Clear default
                    </Button>
                  )}
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
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
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
    due_diligence_required: false,
    is_application_form: false,
    application_level: "member",
    uniqueness_checks: [],
    field_mappings: [], // Submission field mappings with transformations
    submission_email_template_id: null,
    submission_email_recipient: '',
    submission_email_cc: '',
    submission_email_bcc: '',
    submission_email_field_mapping: {}, // Maps template placeholders to form field IDs: { "customer_name": "field_123" }
    // New multi-email structure
    submission_emails: [], // [{id, template_id, recipient, cc, bcc, field_mapping}]
    prefill_source: "none", // "none", "member", or "organization" - enables pre-populating form from entity data
    visibility_rules: [], // Conditional logic rules
    // Unified entity pipelines - replaces old member_entity_action, organization_entity_action, additional_member_creations
    entity_pipelines: {
      members: [], // [{id, label, isPrimary, role_id, uniqueness_key, field_mappings}]
      organisations: [] // [{id, label, isPrimary, uniqueness_key, field_mappings}]
    }
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
    queryFn: () => publicClient.listResourceCategories()
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

  // Fetch communication categories for marketing preference mapping
  const { data: communicationCategories = [] } = useQuery({
    queryKey: ['communication-categories-for-forms'],
    queryFn: async () => {
      try {
        const categories = await base44.entities.CommunicationCategory.list({ 
          sort: { display_order: 'asc' } 
        });
        return categories || [];
      } catch {
        return [];
      }
    }
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FormBuilder')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Migration function: Convert legacy format to unified entity_pipelines
  const migrateToEntityPipelines = (form) => {
    // If form already has entity_pipelines with the new mappings array format, use it
    if (form.entity_pipelines && (form.entity_pipelines.members?.length > 0 || form.entity_pipelines.organisations?.length > 0)) {
      // Check if entries use the new mappings array format or old field_mappings object
      const needsMigration = [...(form.entity_pipelines.members || []), ...(form.entity_pipelines.organisations || [])]
        .some(entry => entry.field_mappings && !entry.mappings);
      
      if (!needsMigration) {
        return form.entity_pipelines;
      }
      
      // Migrate existing entity_pipelines from field_mappings object to mappings array
      const migratedPipelines = {
        members: (form.entity_pipelines.members || []).map(member => {
          if (member.mappings) return member; // Already in new format
          
          // Convert field_mappings object to mappings array
          const mappings = [];
          if (member.field_mappings) {
            for (const [key, value] of Object.entries(member.field_mappings)) {
              if (value && value !== '__clear__') {
                const isCustom = key.startsWith('custom_');
                mappings.push({
                  id: `mapping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  source_type: 'field',
                  source_field_id: value,
                  static_value: '',
                  target_type: isCustom ? 'custom' : 'core',
                  target_entity: 'member',
                  target_field: isCustom ? key.replace('custom_', '') : key,
                  transformation: 'none'
                });
              }
            }
          }
          return { ...member, mappings, field_mappings: undefined };
        }),
        organisations: (form.entity_pipelines.organisations || []).map(org => {
          if (org.mappings) return org; // Already in new format
          
          // Convert field_mappings object to mappings array
          const mappings = [];
          if (org.field_mappings) {
            for (const [key, value] of Object.entries(org.field_mappings)) {
              if (value && value !== '__clear__') {
                const isCustom = key.startsWith('custom_');
                mappings.push({
                  id: `mapping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  source_type: 'field',
                  source_field_id: value,
                  static_value: '',
                  target_type: isCustom ? 'custom' : 'core',
                  target_entity: 'organization',
                  target_field: isCustom ? key.replace('custom_', '') : key,
                  transformation: 'none'
                });
              }
            }
          }
          return { ...org, mappings, field_mappings: undefined };
        })
      };
      
      return migratedPipelines;
    }
    
    const pipelines = { members: [], organisations: [] };
    
    // Migrate legacy member settings
    const memberAction = form.member_entity_action || 
      (form.create_entity_type === "member" || form.create_entity_type === "both" 
        ? (form.entity_action || "create") 
        : "none");
    
    if (memberAction !== 'none' && form.auto_create_entity) {
      // Create primary member entry from field_mappings
      const primaryMember = {
        id: `member_primary_${Date.now()}`,
        label: 'Primary Member',
        isPrimary: true,
        role_id: form.default_member_role_id || null,
        uniqueness_key: 'email',
        mappings: [],
        login_enabled: false
      };
      
      // Extract member mappings from field_mappings array
      if (form.field_mappings && Array.isArray(form.field_mappings)) {
        for (const mapping of form.field_mappings) {
          if (mapping.target_entity === 'member' && mapping.source_field_id) {
            primaryMember.mappings.push({
              ...mapping,
              id: mapping.id || `mapping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            });
          }
        }
      }
      
      pipelines.members.push(primaryMember);
      
      // Add additional members from legacy additional_member_creations
      if (form.additional_member_creations && Array.isArray(form.additional_member_creations)) {
        form.additional_member_creations.forEach((am, idx) => {
          // Convert field_mappings object to mappings array
          const mappings = [];
          if (am.field_mappings) {
            for (const [key, value] of Object.entries(am.field_mappings)) {
              if (value && value !== '__clear__') {
                const isCustom = key.startsWith('custom_');
                mappings.push({
                  id: `mapping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  source_type: 'field',
                  source_field_id: value,
                  static_value: '',
                  target_type: isCustom ? 'custom' : 'core',
                  target_entity: 'member',
                  target_field: isCustom ? key.replace('custom_', '') : key,
                  transformation: 'none'
                });
              }
            }
          }
          
          pipelines.members.push({
            id: am.id || `member_${Date.now()}_${idx}`,
            label: am.label || `Additional Member ${idx + 1}`,
            isPrimary: false,
            role_id: am.role_id || null,
            uniqueness_key: 'email',
            mappings
          });
        });
      }
    }
    
    // Migrate legacy organization settings
    const orgAction = form.organization_entity_action || 
      (form.create_entity_type === "organization" || form.create_entity_type === "both" 
        ? (form.entity_action || "create") 
        : "none");
    
    if (orgAction !== 'none' && form.auto_create_entity) {
      // Create primary organisation entry from field_mappings
      const primaryOrg = {
        id: `org_primary_${Date.now()}`,
        label: 'Primary Organisation',
        isPrimary: true,
        uniqueness_key: 'name',
        mappings: []
      };
      
      // Extract organisation mappings from field_mappings array
      if (form.field_mappings && Array.isArray(form.field_mappings)) {
        for (const mapping of form.field_mappings) {
          if (mapping.target_entity === 'organization' && mapping.source_field_id) {
            primaryOrg.mappings.push({
              ...mapping,
              id: mapping.id || `mapping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            });
          }
        }
      }
      
      pipelines.organisations.push(primaryOrg);
    }
    
    return pipelines;
  };

  useEffect(() => {
    if (existingForm) {
      // Migrate to new entity_pipelines format
      const entityPipelines = migrateToEntityPipelines(existingForm);
      
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
        due_diligence_required: existingForm.due_diligence_required ?? false,
        is_application_form: existingForm.is_application_form || false,
        application_level: existingForm.application_level || "member",
        uniqueness_checks: existingForm.uniqueness_checks || [],
        field_mappings: existingForm.field_mappings || [],
        submission_email_template_id: existingForm.submission_email_template_id || null,
        submission_email_recipient: existingForm.submission_email_recipient || '',
        submission_email_cc: existingForm.submission_email_cc || '',
        submission_email_bcc: existingForm.submission_email_bcc || '',
        submission_email_field_mapping: existingForm.submission_email_field_mapping || {},
        // Load submission_emails array or migrate from legacy single email
        submission_emails: existingForm.submission_emails?.length > 0 
          ? existingForm.submission_emails 
          : (existingForm.submission_email_template_id 
            ? [{
                id: `email_${Date.now()}`,
                template_id: existingForm.submission_email_template_id,
                recipient: existingForm.submission_email_recipient || '',
                cc: existingForm.submission_email_cc || '',
                bcc: existingForm.submission_email_bcc || '',
                field_mapping: existingForm.submission_email_field_mapping || {}
              }] 
            : []),
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
        })),
        entity_pipelines: entityPipelines
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
      const existingCheck = existingIndex >= 0 ? existingChecks[existingIndex] : {};
      const newCheck = { 
        field_id: fieldId, 
        target_field: options.target_field || existingCheck.target_field || (formData.application_level === 'member' ? 'member.email' : 'organization.name'),
        comparison_mode: options.comparison_mode || existingCheck.comparison_mode || 'equals_lowercase',
        error_message: options.error_message !== undefined ? options.error_message : (existingCheck.error_message || '')
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
      
      // Non-current_date mappings need a source field (unless static or clear)
      if (m.transformation !== 'current_date' && m.source_type !== 'static' && m.source_type !== 'clear') {
        if (!m.source_field_id) {
          console.log(`[FormBuilder] Validation failed: mapping #${i + 1} missing source_field_id`);
          toast.error(`Field mapping #${i + 1} is missing a source field. Please select a source field or use "Current date" transformation.`);
          return;
        }
      }
    }
    console.log('[FormBuilder] All mappings validated successfully');

    // Validate entity_pipelines when configured
    const pipelines = formData.entity_pipelines || { members: [], organisations: [] };
    
    // Validate member entries - each must have email mapped (uniqueness key)
    for (const member of (pipelines.members || [])) {
      const memberMappings = member.mappings || [];
      const hasEmailMapping = memberMappings.some(m => 
        m.target_field === 'email' && m.target_type === 'core' && 
        (m.source_field_id || m.static_value)
      );
      if (!hasEmailMapping) {
        console.log('[FormBuilder] VALIDATION FAILED: Member entry missing email mapping:', member.label);
        toast.error(`Member "${member.label}" requires an email field mapping.`);
        return;
      }
    }
    
    // Validate organisation entries - each must have name mapped (uniqueness key)
    for (const org of (pipelines.organisations || [])) {
      const orgMappings = org.mappings || [];
      const hasNameMapping = orgMappings.some(m => 
        m.target_field === 'name' && m.target_type === 'core' && 
        (m.source_field_id || m.static_value)
      );
      if (!hasNameMapping) {
        console.log('[FormBuilder] VALIDATION FAILED: Organisation entry missing name mapping:', org.label);
        toast.error(`Organisation "${org.label}" requires a name field mapping.`);
        return;
      }
    }

    console.log('[FormBuilder] All validation passed, submitting form');
    
    // Remove temporary UI-only flags before saving
    const { _ccCustomMode, _bccCustomMode, ...dataToSave } = formData;
    
    if (formId) {
      console.log('[FormBuilder] Updating form:', formId);
      updateFormMutation.mutate({ id: formId, data: dataToSave });
    } else {
      console.log('[FormBuilder] Creating new form');
      createFormMutation.mutate(dataToSave);
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
              {formId ? (formData.name || 'Edit Form') : 'Create Form'}
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
          <TabsList className="grid w-full grid-cols-5 mb-6" data-testid="formbuilder-tabs">
            <TabsTrigger value="builder" data-testid="tab-builder">Builder</TabsTrigger>
            <TabsTrigger value="settings" data-testid="tab-settings">Form Settings</TabsTrigger>
            <TabsTrigger value="submission" data-testid="tab-submission">Submission Settings</TabsTrigger>
            <TabsTrigger value="emails" data-testid="tab-emails">Emails</TabsTrigger>
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
                  id="due_diligence_required"
                  checked={formData.due_diligence_required}
                  onCheckedChange={(checked) => setFormData({ ...formData, due_diligence_required: checked })}
                  data-testid="switch-due-diligence-required"
                />
                <Label htmlFor="due_diligence_required" className="text-sm">Due Diligence Required</Label>
              </div>

              <div className="text-xs text-slate-500 ml-auto">
                URL: /FormView?slug={formData.slug || 'your-slug'}
              </div>
            </div>

            {/* Embed Code Section */}
            {formData.slug && formData.is_active && !formData.require_authentication && (() => {
              // Extract tenant subdomain from current host for embed URL
              const tenantSubdomain = window.location.hostname.split('.')[0];
              const embedUrl = `${window.location.origin}/embed/form/${formData.slug}?tenant=${tenantSubdomain}`;
              return (
              <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
                <div className="flex items-center gap-2">
                  <Code className="w-4 h-4 text-slate-500" />
                  <Label className="text-sm font-medium">Embed on External Websites</Label>
                </div>
                <div className="bg-slate-50 rounded-md p-3 space-y-3">
                  <div className="space-y-2">
                    <Label className="text-xs text-slate-600">iFrame Embed Code</Label>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={`<iframe src="${embedUrl}" width="100%" height="600" frameborder="0" style="border: none; max-width: 100%;"></iframe>`}
                        className="text-xs font-mono bg-white"
                        data-testid="input-embed-code"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => {
                          navigator.clipboard.writeText(`<iframe src="${embedUrl}" width="100%" height="600" frameborder="0" style="border: none; max-width: 100%;"></iframe>`);
                          toast.success('Embed code copied to clipboard');
                        }}
                        data-testid="button-copy-embed-code"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => window.open(`/embed/form/${formData.slug}?tenant=${tenantSubdomain}`, '_blank')}
                        data-testid="button-preview-embed"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2 pt-2 border-t border-slate-200">
                    <Label className="text-xs text-slate-600">Auto-Resize Script (Optional)</Label>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={`<script>window.addEventListener('message',e=>{if(e.origin==='${window.location.origin}'&&e.data.type==='iconn-form-resize'){document.querySelector('iframe[src*="${formData.slug}"]').style.height=e.data.height+'px'}});</script>`}
                        className="text-xs font-mono bg-white"
                        data-testid="input-resize-script"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => {
                          navigator.clipboard.writeText(`<script>window.addEventListener('message',e=>{if(e.origin==='${window.location.origin}'&&e.data.type==='iconn-form-resize'){document.querySelector('iframe[src*="${formData.slug}"]').style.height=e.data.height+'px'}});</script>`);
                          toast.success('Resize script copied to clipboard');
                        }}
                        data-testid="button-copy-resize-script"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-slate-500">
                      Add this script to enable automatic height adjustment as the form content changes.
                    </p>
                  </div>
                </div>
              </div>
              );
            })()}

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
            {/* Record Creation - Unified Member and Organisation Pipelines */}
            <Card className="border-slate-200 mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Record Creation
                </CardTitle>
                <p className="text-xs text-slate-500 mt-1">
                  Configure which member and organisation records to create or update on form submission. Records are processed sequentially using UPSERT logic.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Members Section */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-semibold flex items-center gap-2">
                      <UserPlus className="w-4 h-4" />
                      Members
                    </Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const members = formData.entity_pipelines?.members || [];
                        const isPrimary = members.length === 0;
                        const newMember = {
                          id: `member_${Date.now()}`,
                          label: isPrimary ? 'Primary Member' : `Additional Member ${members.length}`,
                          isPrimary,
                          role_id: null,
                          uniqueness_key: 'email',
                          mappings: [],
                          login_enabled: false
                        };
                        setFormData(prev => ({
                          ...prev,
                          entity_pipelines: {
                            ...prev.entity_pipelines,
                            members: [...(prev.entity_pipelines?.members || []), newMember]
                          }
                        }));
                      }}
                      data-testid="button-add-member-pipeline"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add Member
                    </Button>
                  </div>
                  
                  {(!formData.entity_pipelines?.members || formData.entity_pipelines.members.length === 0) ? (
                    <div className="text-center py-4 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                      <Users className="w-6 h-6 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No member records configured</p>
                      <p className="text-xs mt-1">Click "Add Member" to create member records from this form</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {formData.entity_pipelines.members.map((memberConfig, memberIdx) => {
                        const memberMappings = memberConfig.mappings || [];
                        const hasEmailMapping = memberMappings.some(m => 
                          m.target_field === 'email' && m.target_type === 'core' && 
                          (m.source_field_id || m.static_value)
                        );
                        
                        return (
                          <div 
                            key={memberConfig.id} 
                            className={`p-4 rounded-lg border ${hasEmailMapping ? 'border-slate-200 bg-slate-50' : 'border-amber-300 bg-amber-50'}`}
                            data-testid={`member-pipeline-${memberIdx}`}
                          >
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                {memberConfig.isPrimary && (
                                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium">Primary</span>
                                )}
                                <Input
                                  value={memberConfig.label}
                                  onChange={(e) => {
                                    const updated = [...formData.entity_pipelines.members];
                                    updated[memberIdx] = { ...updated[memberIdx], label: e.target.value };
                                    setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, members: updated } }));
                                  }}
                                  className="h-8 w-48 text-sm font-medium"
                                  placeholder="Member label"
                                  data-testid={`input-member-label-${memberIdx}`}
                                />
                                <Select
                                  value={memberConfig.role_id === "__clear__" ? "clear" : (memberConfig.role_id || "none")}
                                  onValueChange={(value) => {
                                    const updated = [...formData.entity_pipelines.members];
                                    updated[memberIdx] = {
                                      ...updated[memberIdx],
                                      role_id: value === "none" ? null : (value === "clear" ? "__clear__" : value)
                                    };
                                    setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, members: updated } }));
                                  }}
                                >
                                  <SelectTrigger className="h-8 w-48 text-xs" data-testid={`select-member-role-${memberIdx}`}>
                                    <SelectValue placeholder="Select role..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">-- No role --</SelectItem>
                                    <SelectItem value="clear" className="text-amber-600">Clear role</SelectItem>
                                    {roles.map(role => (
                                      <SelectItem key={role.id} value={role.id}>
                                        {role.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <div className="flex items-center gap-1.5">
                                  <Switch
                                    checked={memberConfig.login_enabled !== false}
                                    onCheckedChange={(checked) => {
                                      const updated = [...formData.entity_pipelines.members];
                                      updated[memberIdx] = { ...updated[memberIdx], login_enabled: checked };
                                      setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, members: updated } }));
                                    }}
                                    data-testid={`switch-member-login-${memberIdx}`}
                                  />
                                  <Label className="text-xs text-slate-600">Login</Label>
                                </div>
                                {!hasEmailMapping && (
                                  <span className="text-xs text-amber-600 font-medium">Email mapping required</span>
                                )}
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  const updated = formData.entity_pipelines.members.filter((_, i) => i !== memberIdx);
                                  if (memberConfig.isPrimary && updated.length > 0) {
                                    updated[0] = { ...updated[0], isPrimary: true };
                                  }
                                  setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, members: updated } }));
                                }}
                                className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                                data-testid={`button-delete-member-${memberIdx}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                            
                            <FieldMappingSection
                              fields={formData.fields}
                              fieldMappings={memberMappings}
                              onMappingsChange={(mappings) => {
                                const updated = [...formData.entity_pipelines.members];
                                updated[memberIdx] = { ...updated[memberIdx], mappings };
                                setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, members: updated } }));
                              }}
                              applicationLevel="member"
                              customFields={customFields}
                              communicationCategories={communicationCategories}
                              fixedTargetEntity="member"
                              showHeader={false}
                              compact={true}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Organisations Section */}
                <div className="space-y-3 pt-4 border-t border-slate-200">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-semibold flex items-center gap-2">
                      <Building2 className="w-4 h-4" />
                      Organisations
                    </Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const orgs = formData.entity_pipelines?.organisations || [];
                        const isPrimary = orgs.length === 0;
                        const newOrg = {
                          id: `org_${Date.now()}`,
                          label: isPrimary ? 'Primary Organisation' : `Additional Organisation ${orgs.length}`,
                          isPrimary,
                          uniqueness_key: 'name',
                          mappings: []
                        };
                        setFormData(prev => ({
                          ...prev,
                          entity_pipelines: {
                            ...prev.entity_pipelines,
                            organisations: [...(prev.entity_pipelines?.organisations || []), newOrg]
                          }
                        }));
                      }}
                      data-testid="button-add-org-pipeline"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add Organisation
                    </Button>
                  </div>
                  
                  {(!formData.entity_pipelines?.organisations || formData.entity_pipelines.organisations.length === 0) ? (
                    <div className="text-center py-4 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                      <Building2 className="w-6 h-6 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No organisation records configured</p>
                      <p className="text-xs mt-1">Click "Add Organisation" to create organisation records from this form</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {formData.entity_pipelines.organisations.map((orgConfig, orgIdx) => {
                        const orgMappings = orgConfig.mappings || [];
                        const hasNameMapping = orgMappings.some(m => 
                          m.target_field === 'name' && m.target_type === 'core' && 
                          (m.source_field_id || m.static_value)
                        );
                        
                        return (
                          <div 
                            key={orgConfig.id} 
                            className={`p-4 rounded-lg border ${hasNameMapping ? 'border-slate-200 bg-slate-50' : 'border-amber-300 bg-amber-50'}`}
                            data-testid={`org-pipeline-${orgIdx}`}
                          >
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                {orgConfig.isPrimary && (
                                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium">Primary</span>
                                )}
                                <Input
                                  value={orgConfig.label}
                                  onChange={(e) => {
                                    const updated = [...formData.entity_pipelines.organisations];
                                    updated[orgIdx] = { ...updated[orgIdx], label: e.target.value };
                                    setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, organisations: updated } }));
                                  }}
                                  className="h-8 w-48 text-sm font-medium"
                                  placeholder="Organisation label"
                                  data-testid={`input-org-label-${orgIdx}`}
                                />
                                {!hasNameMapping && (
                                  <span className="text-xs text-amber-600 font-medium">Name mapping required</span>
                                )}
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  const updated = formData.entity_pipelines.organisations.filter((_, i) => i !== orgIdx);
                                  if (orgConfig.isPrimary && updated.length > 0) {
                                    updated[0] = { ...updated[0], isPrimary: true };
                                  }
                                  setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, organisations: updated } }));
                                }}
                                className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                                data-testid={`button-delete-org-${orgIdx}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                            
                            <FieldMappingSection
                              fields={formData.fields}
                              fieldMappings={orgMappings}
                              onMappingsChange={(mappings) => {
                                const updated = [...formData.entity_pipelines.organisations];
                                updated[orgIdx] = { ...updated[orgIdx], mappings };
                                setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, organisations: updated } }));
                              }}
                              applicationLevel="organization"
                              customFields={customFields}
                              communicationCategories={communicationCategories}
                              fixedTargetEntity="organization"
                              showHeader={false}
                              compact={true}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Emails Tab */}
          <TabsContent value="emails">
            <Card className="border-slate-200">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Mail className="w-5 h-5" />
                  Email Notifications
                </CardTitle>
                <p className="text-sm text-slate-500">
                  Configure emails to send when this form is submitted
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Email Cards */}
                {formData.submission_emails.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    <Mail className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p className="text-sm">No emails configured</p>
                    <p className="text-xs text-slate-400 mt-1">Click "Add Email" to send emails on form submission</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {formData.submission_emails.map((email, idx) => (
                      <EmailCard
                        key={email.id}
                        email={email}
                        index={idx}
                        emailTemplates={emailTemplates}
                        formFields={formData.fields}
                        onUpdate={(updates) => {
                          const updatedEmails = [...formData.submission_emails];
                          updatedEmails[idx] = { ...updatedEmails[idx], ...updates };
                          setFormData({ ...formData, submission_emails: updatedEmails });
                        }}
                        onRemove={() => {
                          const updatedEmails = formData.submission_emails.filter((_, i) => i !== idx);
                          setFormData({ ...formData, submission_emails: updatedEmails });
                        }}
                      />
                    ))}
                  </div>
                )}
                
                {/* Add Email Button */}
                <Button
                  variant="outline"
                  onClick={() => {
                    const newEmail = {
                      id: `email_${Date.now()}`,
                      template_id: null,
                      recipient: '',
                      cc: '',
                      bcc: '',
                      field_mapping: {},
                      condition: null
                    };
                    setFormData({ 
                      ...formData, 
                      submission_emails: [...formData.submission_emails, newEmail] 
                    });
                  }}
                  className="w-full"
                  data-testid="button-add-email"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Email
                </Button>
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
                      // Handle new multi-action format
                      if (rule.actions && Array.isArray(rule.actions)) {
                        for (const action of rule.actions) {
                          if (action.action_type === 'show' && action.target_field_ids?.length) {
                            action.target_field_ids.forEach(id => fieldsWithShowRules.add(id));
                          }
                        }
                      }
                      // Handle legacy format
                      else if (rule.action === 'show' && rule.target_field_ids?.length) {
                        rule.target_field_ids.forEach(id => fieldsWithShowRules.add(id));
                      }
                    });
                    setFormData(prev => {
                      const updatedFields = prev.fields.map(field => ({
                        ...field,
                        // If field is targeted by a show rule, mark it as starts_hidden
                        // Otherwise preserve the existing starts_hidden value (manual toggle)
                        starts_hidden: fieldsWithShowRules.has(field.id) || field.starts_hidden
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

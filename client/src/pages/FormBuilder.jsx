
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, GripVertical, Save, ArrowLeft, FileText, ChevronDown, ChevronUp, Edit2, X } from "lucide-react";
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

const FIELD_TYPES = [
  { value: 'text', label: 'Text Input' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: 'Number' },
  { value: 'tel', label: 'Phone' },
  { value: 'textarea', label: 'Text Area' },
  { value: 'select', label: 'Dropdown' },
  { value: 'organisation_dropdown', label: 'Organisation Dropdown' },
  { value: 'category_multiselect', label: 'Category Multi-Select' },
  { value: 'radio', label: 'Radio Buttons' },
  { value: 'checkbox', label: 'Checkboxes' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'file', label: 'File Upload' },
  { value: 'user_name', label: 'User Name (Auto)' },
  { value: 'user_email', label: 'User Email (Auto)' },
  { value: 'user_organization', label: 'User Organisation (Auto)' },
  { value: 'user_job_title', label: 'User Job Title (Auto)' },
];

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
];

const MEMBER_CORE_FIELDS = [
  { value: 'email', label: 'Email' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'full_name', label: 'Full Name' },
  { value: 'phone', label: 'Phone' },
  { value: 'job_title', label: 'Job Title' },
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
      source_field_id: '',
      target_type: 'core', // 'core' or 'custom'
      target_entity: applicationLevel === 'member' ? 'member' : 'organization',
      target_field: '',
      transformation: 'none'
    };
    onMappingsChange([...fieldMappings, newMapping]);
  };

  const updateMapping = (mappingId, updates) => {
    const newMappings = fieldMappings.map(m => 
      m.id === mappingId ? { ...m, ...updates } : m
    );
    onMappingsChange(newMappings);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Settings2 className="w-4 h-4" />
            Field Mappings
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Define how form field values are saved to member or organisation records
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
          {fieldMappings.map((mapping, index) => (
            <div 
              key={mapping.id} 
              className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3"
              data-testid={`mapping-row-${index}`}
            >
              {/* First row: Source Field -> Target */}
              <div className="flex flex-wrap items-end gap-3">
                {/* Source Field */}
                <div className="space-y-1 min-w-[180px] flex-1">
                  <Label className="text-xs">Source (Form Field)</Label>
                  <Select
                    value={mapping.source_field_id}
                    onValueChange={(value) => updateMapping(mapping.id, { source_field_id: value })}
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

                {/* Arrow */}
                <div className="hidden sm:flex items-center justify-center pb-2">
                  <ArrowRight className="w-4 h-4 text-slate-400" />
                </div>

                {/* Target Type */}
                <div className="space-y-1 min-w-[120px]">
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={mapping.target_type}
                    onValueChange={(value) => updateMapping(mapping.id, { 
                      target_type: value, 
                      target_field: '' 
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
                <div className="space-y-1 min-w-[120px]">
                  <Label className="text-xs">Entity</Label>
                  <Select
                    value={mapping.target_entity}
                    onValueChange={(value) => updateMapping(mapping.id, { 
                      target_entity: value, 
                      target_field: '' 
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
                <div className="space-y-1 min-w-[160px] flex-1">
                  <Label className="text-xs">Target Field</Label>
                  <Select
                    value={mapping.target_field}
                    onValueChange={(value) => updateMapping(mapping.id, { target_field: value })}
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

              {/* Transformation row */}
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
            </div>
          ))}
        </div>
      )}
    </div>
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
  isApplicationForm = false,
  applicationLevel = "member",
  uniquenessChecks = [],
  onUniquenessChange
}) {
  const isEmailType = field.type === 'email' || field.type === 'user_email';
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Field Type</Label>
                  <Select
                    value={field.type}
                    onValueChange={(value) => updateField(originalIndex, { type: value })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map(type => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Label</Label>
                  <Input
                    value={field.label}
                    onChange={(e) => updateField(originalIndex, { label: e.target.value })}
                    className="h-9"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Placeholder</Label>
                <Input
                  value={field.placeholder}
                  onChange={(e) => updateField(originalIndex, { placeholder: e.target.value })}
                  className="h-9"
                />
              </div>

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
    uniqueness_checks: [],
    field_mappings: [] // Submission field mappings with transformations
  });

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
        uniqueness_checks: existingForm.uniqueness_checks || [],
        field_mappings: existingForm.field_mappings || []
      });
    }
  }, [existingForm]);

  const createFormMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.Form.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form created successfully');
      window.location.href = createPageUrl('FormManagement');
    },
    onError: (error) => {
      toast.error('Failed to create form');
    }
  });

  const updateFormMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.Form.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update form');
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
    if (!formData.name || !formData.slug) {
      toast.error('Please fill in name and slug');
      return;
    }

    if (formData.fields.length === 0) {
      toast.error('Please add at least one field');
      return;
    }

    if (formId) {
      updateFormMutation.mutate({ id: formId, data: formData });
    } else {
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

        {/* Form Settings - Full Width at Top */}
        <Card className="border-slate-200 mb-6">
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

            {/* Application Form Settings */}
            {formData.is_application_form && (
              <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
                <div className="flex items-center gap-4">
                  <Label className="text-sm font-medium">Application Level:</Label>
                  <div className="flex gap-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        id="level-member"
                        name="application_level"
                        value="member"
                        checked={formData.application_level === "member"}
                        onChange={() => setFormData({ ...formData, application_level: "member" })}
                        className="w-4 h-4 text-blue-600"
                        data-testid="radio-level-member"
                      />
                      <Label htmlFor="level-member" className="text-sm cursor-pointer">Member Level</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        id="level-organization"
                        name="application_level"
                        value="organization"
                        checked={formData.application_level === "organization"}
                        onChange={() => setFormData({ ...formData, application_level: "organization" })}
                        className="w-4 h-4 text-blue-600"
                        data-testid="radio-level-organization"
                      />
                      <Label htmlFor="level-organization" className="text-sm cursor-pointer">Organisation Level</Label>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  {formData.application_level === "member" 
                    ? "Uniqueness will be checked against the Member table" 
                    : "Uniqueness will be checked against the Organisation table (email fields use domain-only matching)"}
                </p>
                
                <div className="flex items-center gap-2 mt-4 pt-4 border-t border-slate-100">
                  <Switch
                    id="auto_create_entity"
                    checked={formData.auto_create_entity || false}
                    onCheckedChange={(checked) => setFormData({ ...formData, auto_create_entity: checked })}
                    data-testid="switch-auto-create-entity"
                  />
                  <div>
                    <Label htmlFor="auto_create_entity" className="text-sm">Auto-create {formData.application_level === "member" ? "Member" : "Organisation"} on submission</Label>
                    <p className="text-xs text-slate-500 mt-1">
                      {formData.auto_create_entity 
                        ? `New ${formData.application_level === "member" ? "member" : "organisation"} records will be created automatically when the form is submitted` 
                        : "Submissions will require admin approval before creating records"}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Submission Settings Card - Field Mappings */}
        <Card className="border-slate-200 mb-6">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings2 className="w-5 h-5" />
              Submission Settings
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
                      onMappingsChange={(mappings) => setFormData({ ...formData, field_mappings: mappings })}
                      applicationLevel={formData.application_level}
                      customFields={customFields}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>

        {/* Form Pages and Fields - Full Width Below */}
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
                                    />
                                  ))}
                                {provided.placeholder}
                              </div>
                            )}
                          </Droppable>
                        </div>
                      )}

                      {/* Fields grouped by page with columns */}
                      {formData.pages.map((page, pageIndex) => {
                        const columnCount = page.column_count || 1;
                        
                        return (
                          <div key={page.id} className="border border-slate-200 rounded-lg overflow-hidden">
                            <div className="bg-slate-100 px-4 py-2 flex items-center justify-between">
                              <h4 className="font-medium text-slate-700 flex items-center gap-2">
                                <span className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded">
                                  Page {pageIndex + 1}
                                </span>
                                {page.title}
                                {columnCount > 1 && (
                                  <span className="text-xs text-slate-500">
                                    ({columnCount} columns)
                                  </span>
                                )}
                              </h4>
                              <Button 
                                onClick={() => addField(page.id, 0)} 
                                size="sm" 
                                variant="ghost"
                                className="h-7 text-xs"
                              >
                                <Plus className="w-3 h-3 mr-1" />
                                Add Field
                              </Button>
                            </div>
                            
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
                            />
                          ))}
                          {provided.placeholder}
                        </div>
                      )}
                    </Droppable>
                  </DragDropContext>
                )}
              </CardContent>
            </Card>
        </div>
      </div>
    </div>
  );
}


import React, { useState, useEffect, useMemo, useRef } from "react";
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
import { Loader2, Plus, Trash2, GripVertical, Save, ArrowLeft, FileText, ChevronDown, ChevronUp, Edit2, X, Eye, EyeOff, Lock, Unlock, UserCheck, UserMinus, Users, UserPlus, Mail, Copy, Code, ExternalLink, Filter, FileSignature, AlertCircle, Paperclip, ImageIcon, Upload } from "lucide-react";
import { uploadFileWithProgress, UPLOAD_TYPES } from '@/lib/tenantUpload';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { FLAG_COLOR_OPTIONS, getFlagColorClasses } from "@/lib/flagColors";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { Columns2, Columns3, ArrowRight, Settings2, Wand2, Building2, CreditCard } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { COUNTRIES } from '@/data/countries';
import { TimezoneAwareDateTimeInput } from "@/components/events/TimezoneAwareDateTimeInput";
import TimezoneSelect from "@/components/TimezoneSelect";
import FormOwnersSelector from "@/components/forms/FormOwnersSelector";
import { SCORE_CONDITION_OPERATORS } from "@/lib/surveyConditions";
import { hasMembershipStructureAction, findUnrevealedHidden } from "@/lib/formHiddenReachability";
import ScoreField from "@/components/forms/ScoreField";
import { validateScoreFieldConfig, validateSurveyForPublish, getScoreRange, getScoreWeight } from "../../../api/_lib/surveyScoring.js";
import { listOrganizationsForAdmin } from '@/lib/adminOrgList';
import SurveyEventAssignmentsPanel from "@/components/surveys/SurveyEventAssignmentsPanel";
import { getEligibleRelationshipParents, normalizeEligibleRelationships, relationshipFieldConfig } from "@/lib/formRelationshipDropdown";
import {
  configuredOrganizationFilterOptions,
  mergeOrganizationFilterOptions,
} from "@/lib/formConditionalFilters";
import {
  prependFormNotListedOption,
  supportsFormNotListedChoice,
} from "../../../shared/formNotListedChoice.js";

const BADGE_STYLE_DEFAULTS = {
  background_color: '#ffffff',
  border_color: '#e2e8f0',
  accent_color: '#3b82f6',
  width: 400,
  height: 280,
};

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
  { value: 'currency', label: 'Currency' },
  { value: 'contact', label: 'Contact (Composite)' },
  { value: 'grouped_question', label: 'Grouped Question' },
  { value: 'instructions', label: 'Instructions (Display Only)' },
  { value: 'image', label: 'Image (Display Only)' },
  { value: 'image_buttons', label: 'Image Buttons' },
  { value: 'signature', label: 'Signature' },
];

const PREPOPULATE_FIELD_TYPES = [
  { value: 'organisation_dropdown', label: 'Organisation Dropdown' },
  { value: 'relationship_dropdown', label: 'Relationship Dropdown' },
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

const PAYMENT_FIELD_TYPES = [
  { value: 'membership_payment', label: 'Membership Payment' },
  { value: 'payment', label: 'Payment' },
];

// Searchable combobox for picking the form's linked event. Type-ahead filters
// events by title; the list arrives already alphabetised from the caller.
function LinkedEventCombobox({ eventOptions, value, onChange, includesPastEvents }) {
  const [open, setOpen] = useState(false);
  const selected = eventOptions.find(ev => ev.id === value) || null;
  const placeholder = includesPastEvents ? "Select an event..." : "Select an upcoming event...";
  const emptyLabel = includesPastEvents ? "No events found" : "No upcoming events found";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid="select-related-event"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected
              ? `${selected.title}${selected.start_date ? ` — ${new Date(selected.start_date).toLocaleDateString()}` : ''}`
              : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search events..." data-testid="input-related-event-search" />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {eventOptions.map(event => (
              <CommandItem
                key={event.id}
                value={`${event.title || ''} ${event.id}`}
                onSelect={() => {
                  onChange(event.id === value ? null : event.id);
                  setOpen(false);
                }}
                data-testid={`option-event-${event.id}`}
              >
                <Check className={cn("h-4 w-4", event.id === value ? "opacity-100" : "opacity-0")} />
                <span className="truncate">
                  {event.title}
                  {event.start_date ? ` — ${new Date(event.start_date).toLocaleDateString()}` : ''}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PolicyMultiSelect({ options, value = [], onChange, placeholder, testId }) {
  const selected = new Set(value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between font-normal" data-testid={testId}>
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0
              ? placeholder
              : value.length === 1
                ? options.find(option => option.value === value[0])?.label || "1 selected"
                : `${value.length} selected`}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No options found.</CommandEmpty>
            {value.length > 0 && (
              <CommandItem onSelect={() => onChange([])} data-testid={`${testId}-clear`}>
                <X className="mr-2 h-4 w-4" /> Clear selection
              </CommandItem>
            )}
            {options.map(option => (
              <CommandItem
                key={option.value}
                value={`${option.label} ${option.value}`}
                onSelect={() => onChange(selected.has(option.value)
                  ? value.filter(item => item !== option.value)
                  : [...value, option.value])}
              >
                <Check className={cn("mr-2 h-4 w-4", selected.has(option.value) ? "opacity-100" : "opacity-0")} />
                {option.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function FormAccessPolicyEditor({ policy, onChange, groups, roles }) {
  const rules = Array.isArray(policy?.group_rules) ? policy.group_rules : [];
  const selectedRoleIds = Array.isArray(policy?.rbac_role_ids) ? policy.rbac_role_ids : [];
  const groupOptions = groups.map(group => ({ value: group.id, label: group.name || "Unnamed group" }));
  const roleOptions = roles.map(role => ({ value: role.id, label: role.name || "Unnamed role" }));
  const usedGroups = new Set(rules.map(rule => rule.group_id));

  const nextPolicy = (updates) => ({
    version: 1,
    group_rules: rules,
    rbac_role_ids: selectedRoleIds,
    operator: policy?.operator || "or",
    ...updates,
  });
  const updateRule = (groupId, updates) => {
    onChange(nextPolicy({
      group_rules: rules.map(rule => rule.group_id === groupId ? { ...rule, ...updates } : rule)
    }));
  };
  const addRule = (groupId) => {
    if (!groupId || usedGroups.has(groupId)) return;
    onChange(nextPolicy({
      group_rules: [...rules, {
        group_id: groupId,
        role_names: [],
      }],
    }));
  };

  return (
    <div className="mt-6 space-y-4 border-t border-slate-100 pt-5" data-testid="form-access-policy-editor">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Label className="text-base font-medium">Form access policy</Label>
          <p className="mt-1 text-sm text-muted-foreground">
            Restrict this form to active member groups, optionally matching a group role, tenant role, or both.
            A viewer matches the group side when any configured group rule matches.
          </p>
        </div>
        {(rules.length > 0 || selectedRoleIds.length > 0) && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} data-testid="button-clear-form-access-policy">
            <X className="mr-1 h-4 w-4" /> Clear policy
          </Button>
        )}
      </div>

      {rules.map((rule, index) => {
        const group = groups.find(item => item.id === rule.group_id);
        const groupRoleOptions = (Array.isArray(group?.roles) ? group.roles : [])
          .filter(Boolean)
          .map(name => ({ value: name, label: name }));
        return (
          <div key={rule.group_id} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4" data-testid={`form-access-rule-${index}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-slate-800">{group?.name || "Unavailable group"}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  const remainingRules = rules.filter(item => item.group_id !== rule.group_id);
                  if (remainingRules.length === 0 && selectedRoleIds.length === 0) onChange(null);
                  else onChange(nextPolicy({ group_rules: remainingRules }));
                }}
                aria-label={`Remove ${group?.name || "group"} rule`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Group roles (optional)</Label>
                <PolicyMultiSelect
                  options={groupRoleOptions}
                  value={rule.role_names || []}
                  onChange={roleNames => updateRule(rule.group_id, { role_names: roleNames })}
                  placeholder={groupRoleOptions.length ? "Any role in this group" : "This group has no roles"}
                  testId={`select-access-group-roles-${index}`}
                />
              </div>
            </div>
          </div>
        );
      })}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Add member group rule</Label>
          <Select value="" onValueChange={addRule}>
            <SelectTrigger data-testid="select-add-form-access-group">
              <SelectValue placeholder="Add an active member group…" />
            </SelectTrigger>
            <SelectContent>
              {groupOptions.filter(group => !usedGroups.has(group.value)).map(group => (
                <SelectItem key={group.value} value={group.value}>{group.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {groups.length === 0 && <p className="text-sm text-muted-foreground">No active member groups are available.</p>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Tenant RBAC roles (optional)</Label>
          <PolicyMultiSelect
            options={roleOptions}
            value={selectedRoleIds}
            onChange={(roleIds) => {
              if (rules.length === 0 && roleIds.length === 0) onChange(null);
              else onChange(nextPolicy({ rbac_role_ids: roleIds }));
            }}
            placeholder="Select tenant roles…"
            testId="select-access-rbac-roles"
          />
        </div>
      </div>

      {rules.length > 0 && selectedRoleIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 p-3">
          <Label className="text-sm">Allow viewers who match</Label>
          <Select
            value={policy?.operator || "or"}
            onValueChange={operator => onChange(nextPolicy({ operator }))}
          >
            <SelectTrigger className="w-48" data-testid="select-access-operator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="and">Both group AND role</SelectItem>
              <SelectItem value="or">Either group OR role</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

// Survey-only field types (Task #3330). Only offered when form_type === 'survey'.
const SURVEY_FIELD_TYPES = [
  { value: 'score', label: 'Score / Rating' },
];

const SCORE_STYLE_OPTIONS = [
  { value: 'stars', label: 'Stars' },
  { value: 'smileys', label: 'Smiley faces' },
  { value: 'numbers', label: 'Numbered buttons' },
  { value: 'descriptive', label: 'Descriptive buttons' },
  { value: 'slider', label: 'Slider' },
  { value: 'nps', label: 'NPS preset (0–10)' },
];

const FIELD_TYPES = [...STANDARD_FIELD_TYPES, ...PREPOPULATE_FIELD_TYPES, ...AUTO_FIELD_TYPES, ...PAYMENT_FIELD_TYPES, ...SURVEY_FIELD_TYPES];

const getFieldTypeCategory = (fieldType) => {
  if (STANDARD_FIELD_TYPES.find(f => f.value === fieldType)) return 'standard';
  if (PREPOPULATE_FIELD_TYPES.find(f => f.value === fieldType)) return 'prepopulate';
  if (AUTO_FIELD_TYPES.find(f => f.value === fieldType)) return 'auto';
  if (PAYMENT_FIELD_TYPES.find(f => f.value === fieldType)) return 'payment';
  if (SURVEY_FIELD_TYPES.find(f => f.value === fieldType)) return 'survey';
  return 'standard';
};

const TRANSFORMATIONS = [
  { value: 'none', label: 'No transformation', description: 'Use value as-is' },
  { value: 'trim', label: 'Trim whitespace', description: 'Remove leading/trailing spaces' },
  { value: 'uppercase', label: 'UPPERCASE', description: 'Convert to uppercase' },
  { value: 'lowercase', label: 'lowercase', description: 'Convert to lowercase' },
  { value: 'titlecase', label: 'Title Case', description: 'Capitalize first letter of each word' },
  { value: 'extract_domain', label: 'Extract domain', description: 'Get domain from a website URL or email' },
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

// Canonical list of organisation core columns safe to expose for prefill.
// Cross-referenced with OrganisationDetailView.jsx editable formData, the
// WHITELISTED_ORG_FIELDS array in api/public/form/prefill-booking.js, and
// the organization-table migrations (e.g. 20260410_add_tags_to_member_and_organization.sql).
// Keep this list in sync with ORG_PREFILL_FIELDS below and WHITELISTED_ORG_FIELDS in the API.
const ORG_CORE_FIELDS = [
  { value: 'name', label: 'Organisation Name' },
  { value: 'description', label: 'Description' },
  { value: 'logo_url', label: 'Logo' },
  { value: 'invoicing_email', label: 'Invoicing Email' },
  { value: 'invoicing_address', label: 'Invoicing Address' },
  { value: 'phone', label: 'Phone' },
  { value: 'website_url', label: 'Website URL' },
  { value: 'tags', label: 'Tags' },
];

const BOOKING_CORE_FIELDS = [
  { value: 'attendee_first_name', label: 'Attendee First Name' },
  { value: 'attendee_last_name', label: 'Attendee Last Name' },
  { value: 'attendee_email', label: 'Attendee Email' },
  { value: 'attendee_phone', label: 'Attendee Phone' },
  { value: 'attendee_job_title', label: 'Attendee Job Title' },
  { value: 'guest_organisation_name', label: 'Guest Organisation Name' },
  { value: 'event_name', label: 'Event Name' },
  { value: 'ticket_class_name', label: 'Ticket Class' },
  { value: 'booking_reference', label: 'Booking Reference' },
];

const COMPARISON_MODES = [
  { value: 'equals', label: 'Equals (exact match)', forEmail: true, forText: true },
  { value: 'equals_lowercase', label: 'Equals (case insensitive)', forEmail: true, forText: true },
  { value: 'contains', label: 'Contains', forEmail: false, forText: true },
  { value: 'starts_with', label: 'Starts with', forEmail: false, forText: true },
  { value: 'ends_with', label: 'Ends with', forEmail: false, forText: true },
  { value: 'domain_equals', label: 'Domain equals (email or URL)', forEmail: true, forText: true },
  { value: 'url_equals', label: 'URL match (ignores http/www)', forEmail: false, forText: true },
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
                        source_category_id: '',
                        static_value: value === 'clear' ? '__clear__' : '',
                        transformation: value === 'current_date' ? 'current_date' : 'none'
                      })}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-source-type-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="field">Form Field</SelectItem>
                        <SelectItem value="static">Fixed Value</SelectItem>
                        <SelectItem value="current_date">Current Date</SelectItem>
                        <SelectItem value="clear">Clear Field</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Source Field or Static Value or Clear indicator */}
                  {sourceType === 'field' ? (
                    <>
                    <div className="space-y-1 min-w-[160px] flex-1">
                      <Label className="text-xs">Form Field</Label>
                      <Select
                        value={mapping.source_field_id || undefined}
                        onValueChange={(value) => {
                          console.log('[FieldMapping] Source field changed to:', value);
                          if (value) {
                            const selectedField = fields.find(f => f.id === value);
                            const updates = { source_field_id: value };
                            if (selectedField?.type !== 'communication_preferences') {
                              updates.source_category_id = '';
                            }
                            updateMapping(mapping.id, updates);
                          }
                        }}
                      >
                        <SelectTrigger className="h-9" data-testid={`select-source-${index}`}>
                          <SelectValue placeholder="Select field..." />
                        </SelectTrigger>
                        <SelectContent>
                          {fields.filter(f => f.type !== 'instructions' && f.type !== 'image' && f.type !== 'image_buttons').map(field => (
                            <SelectItem key={field.id} value={field.id}>
                              <span className="inline-flex items-center gap-2">
                                <span>{field.label || field.type}</span>
                                {field.starts_hidden && (
                                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 py-0.5">hidden</span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {(() => {
                      const selectedSourceField = fields.find(f => f.id === mapping.source_field_id);
                      if (selectedSourceField?.type === 'communication_preferences' && communicationCategories.length > 0) {
                        return (
                          <div className="space-y-1 min-w-[140px]">
                            <Label className="text-xs">Source Category</Label>
                            <Select
                              value={mapping.source_category_id || undefined}
                              onValueChange={(value) => {
                                if (value) {
                                  updateMapping(mapping.id, { source_category_id: value });
                                }
                              }}
                            >
                              <SelectTrigger className="h-9" data-testid={`select-source-category-${index}`}>
                                <SelectValue placeholder="Select category..." />
                              </SelectTrigger>
                              <SelectContent>
                                {communicationCategories.map(cat => (
                                  <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    </>
                  ) : sourceType === 'current_date' ? (
                    <div className="space-y-1 min-w-[160px] flex-1">
                      <Label className="text-xs">Value</Label>
                      <div className="h-9 px-3 flex items-center text-sm text-muted-foreground bg-slate-100 border rounded-md">
                        Will use current date when form is submitted
                      </div>
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
                      {targetCustomField?.field_type === 'boolean' ? (
                        <div className="flex items-center h-9 gap-3">
                          <Switch
                            checked={mapping.static_value === 'true' || mapping.static_value === true}
                            onCheckedChange={(checked) => updateMapping(mapping.id, { static_value: checked ? 'true' : 'false' })}
                            data-testid={`switch-static-value-${index}`}
                          />
                          <span className="text-sm text-slate-600">
                            {mapping.static_value === 'true' || mapping.static_value === true ? 'Yes' : 'No'}
                          </span>
                        </div>
                      ) : hasOptions ? (
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

// LMIC operators (Task #3477): offered only for country-shaped fields
// (`country` / `countries`). Compared against the tenant's saved LMIC list
// at view time; no value input needed.
const LMIC_CONDITION_OPERATOR_OPTIONS = [
  { value: 'is_lmic', label: 'Is an LMIC country' },
  { value: 'is_not_lmic', label: 'Is not an LMIC country' },
];

const isLmicConditionOperator = (operator) =>
  operator === 'is_lmic' || operator === 'is_not_lmic';

const BOOLEAN_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
];

const BOOLEAN_VALUE_OPTIONS = [
  { value: 'true', label: 'True' },
  { value: 'false', label: 'False' },
];

const isBooleanOperatorAllowed = (operator) =>
  BOOLEAN_OPERATORS.some(op => op.value === operator);

const isBooleanValueAllowed = (value) =>
  BOOLEAN_VALUE_OPTIONS.some(opt => opt.value === value);

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
  roles = [],
  pages = [],
  entityPipelines = null
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

  // Build a compact signature of which fields are booleans so we re-run the
  // boolean auto-correction step when a field's type changes.
  const booleanFieldsSignature = (fields || [])
    .filter(f => f && f.type === 'boolean')
    .map(f => f.id)
    .join('|');

  // Normalize and migrate rules on initial load or when rules change
  useEffect(() => {
    if (!visibilityRules || visibilityRules.length === 0) return;
    
    // Use JSON comparison to detect new data (handles cached array references).
    // Include the boolean-fields signature so changing a field's type to/from
    // boolean re-triggers the auto-correction below.
    const currentJson = `${booleanFieldsSignature}::${JSON.stringify(visibilityRules)}`;
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

      // Auto-correct conditions whose reference field is boolean but the saved
      // operator/value is no longer valid for booleans. This keeps already-saved
      // rules in a valid state when they're loaded into the editor.
      if (normalizedRule.conditions && Array.isArray(normalizedRule.conditions)) {
        let conditionsChanged = false;
        const correctedConditions = normalizedRule.conditions.map(cond => {
          if (!cond.field_id) return cond;
          const refField = fields.find(f => f.id === cond.field_id);
          if (!refField || refField.type !== 'boolean') return cond;
          let updated = cond;
          if (!isBooleanOperatorAllowed(cond.operator)) {
            updated = { ...updated, operator: 'equals' };
            conditionsChanged = true;
          }
          if (!isBooleanValueAllowed(updated.value)) {
            updated = { ...updated, value: 'true' };
            conditionsChanged = true;
          }
          return updated;
        });
        if (conditionsChanged) {
          needsUpdate = true;
          normalizedRule = { ...normalizedRule, conditions: correctedConditions };
        }
      }

      return normalizedRule;
    });
    
    // Mark as migrated before calling onRulesChange to prevent re-entry
    lastMigratedJsonRef.current = currentJson;
    
    if (needsUpdate) {
      console.log('[FormBuilder] Migrating legacy visibility rules to new format');
      // Update the ref to the new JSON so we don't re-trigger
      lastMigratedJsonRef.current = `${booleanFieldsSignature}::${JSON.stringify(migratedRules)}`;
      onRulesChange(migratedRules);
    }
  }, [visibilityRules, onRulesChange, booleanFieldsSignature]);

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
    if (field.type === 'image_buttons') {
      return (field.image_options || []).map(opt => ({ value: opt.value, label: opt.label || opt.value }));
    }
    if (field.type === 'boolean') {
      return BOOLEAN_VALUE_OPTIONS;
    }
    return [];
  };

  const isBooleanReferenceField = (fieldId) => {
    const field = fields.find(f => f.id === fieldId);
    return field?.type === 'boolean';
  };

  // Country-shaped fields get the extra LMIC operators (Task #3477).
  const isCountryReferenceField = (fieldId) => {
    const field = fields.find(f => f.id === fieldId);
    return field?.type === 'country' || field?.type === 'countries';
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
    } else if (actionType === 'submit_control') {
      // One submit-control action per rule keeps semantics obvious
      const existingSubmitAction = (normalizedRule.actions || []).find(a => a.action_type === 'submit_control');
      if (existingSubmitAction) {
        toast.info('A submit button action already exists for this rule');
        return;
      }
      newAction = {
        id: `action_submit_${Date.now()}`,
        action_type: 'submit_control',
        // 'disable' blocks submission while the rule's conditions match;
        // 'enable' re-enables submit even if another matched rule disables it.
        submit_state: 'disable',
        message: ''
      };
    } else if (actionType === 'membership_structure') {
      // One membership action per rule; the FIRST matched rule wins at
      // payment time, so a single action per rule keeps precedence obvious.
      const existingMembershipAction = (normalizedRule.actions || []).find(a => a.action_type === 'membership_structure');
      if (existingMembershipAction) {
        toast.info('A membership action already exists for this rule');
        return;
      }
      newAction = {
        id: `action_membership_${Date.now()}`,
        action_type: 'membership_structure',
        config_id: '',
        // Maps membership calculation inputs (preference field ids or
        // core:<name> keys) to form field ids.
        field_mappings: {}
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
    
    if (prefillSource === 'booking') {
      const memberCustomFields = customFields.filter(cf => !cf.entity_scope || cf.entity_scope === 'member');
      const orgCustomFields = customFields.filter(cf => cf.entity_scope === 'organization');
      return [
        ...BOOKING_CORE_FIELDS.map(f => ({ value: `core.${f.value}`, label: f.label, group: 'Booking Fields' })),
        ...MEMBER_CORE_FIELDS.map(f => ({ value: `core.${f.value}`, label: f.label, group: 'Member Fields (if linked)' })),
        ...memberCustomFields.map(f => ({ value: `custom.${f.id}`, label: f.label, group: 'Member Custom Fields (if linked)' })),
        ...ORG_CORE_FIELDS.map(f => ({ value: `core.${f.value}`, label: f.label, group: 'Organisation Fields (if linked)' })),
        ...orgCustomFields.map(f => ({ value: `custom.${f.id}`, label: f.label, group: 'Organisation Custom Fields (if linked)' })),
      ];
    }
    
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

  // Reorder rules via drag-and-drop. Rules are evaluated in array order, so
  // this lets users control the evaluation sequence.
  const handleRuleDragEnd = (result) => {
    if (!result.destination) return;
    if (result.destination.index === result.source.index) return;
    const reordered = Array.from(visibilityRules);
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    onRulesChange(reordered);
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

    // Instructions-only targets: replace the displayed rich-text content. Only
    // static rich text is supported (no field/prefill/formula sources), so we
    // render the same rich-text editor used to author instructions content.
    if (targetInfo.type === 'instructions') {
      return (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Replace the instructions content shown to users when this rule's conditions are met.
          </p>
          <div className="bg-white rounded border border-slate-200">
            <ReactQuill
              theme="snow"
              value={typeof action.set_value === 'string' ? action.set_value : ''}
              onChange={(value) => updateAction(ruleId, action.id, { set_value: value })}
              placeholder="Enter the instructions content to display..."
              modules={{
                toolbar: [
                  [{ 'header': [1, 2, 3, false] }],
                  ['bold', 'italic', 'underline'],
                  [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                  ['link'],
                  ['clean']
                ]
              }}
              data-testid={`richtext-set-value-${actionIndex}`}
            />
          </div>
        </div>
      );
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
                      {availableSourceFields.filter(f => ['number', 'percentage', 'currency'].includes(f.type)).map(field => (
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
                      {availableSourceFields.filter(f => ['number', 'percentage', 'currency'].includes(f.type)).map(field => (
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
            ) : targetInfo.type === 'boolean' ? (
              <div className="flex gap-2">
                <Button
                  variant={action.set_value === true || action.set_value === 'true' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => updateAction(ruleId, action.id, { set_value: true })}
                  data-testid={`button-set-value-true-${actionIndex}`}
                >
                  True (Yes)
                </Button>
                <Button
                  variant={action.set_value === false || action.set_value === 'false' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => updateAction(ruleId, action.id, { set_value: false })}
                  data-testid={`button-set-value-false-${actionIndex}`}
                >
                  False (No)
                </Button>
              </div>
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
        <DragDropContext onDragEnd={handleRuleDragEnd}>
          <Droppable droppableId="logic-rules">
            {(dropProvided) => (
              <div
                className="space-y-3"
                ref={dropProvided.innerRef}
                {...dropProvided.droppableProps}
              >
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
                    <Draggable key={rule.id} draggableId={rule.id} index={index}>
                      {(dragProvided) => (
              <div 
                ref={dragProvided.innerRef}
                {...dragProvided.draggableProps}
                className="p-4 border rounded-lg space-y-3 bg-slate-50 border-slate-200"
                data-testid={`rule-row-${index}`}
              >
                {/* Rule Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div
                      {...dragProvided.dragHandleProps}
                      className="cursor-move flex-shrink-0"
                      data-testid={`drag-handle-rule-${index}`}
                    >
                      <GripVertical className="w-4 h-4 text-slate-400" />
                    </div>
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
                    const isBooleanRef = isBooleanReferenceField(condition.field_id);
                    const isScoreRef = fields.find(f => f.id === condition.field_id)?.type === 'score';
                    const isCountryRef = isCountryReferenceField(condition.field_id);
                    const conditionOptions = getConditionFieldOptions(condition.field_id);
                    const operatorOptions = isBooleanRef
                      ? BOOLEAN_OPERATORS
                      : (isScoreRef
                        ? SCORE_CONDITION_OPERATORS
                        : (isCountryRef
                          ? [...VISIBILITY_OPERATORS, ...LMIC_CONDITION_OPERATOR_OPTIONS]
                          : VISIBILITY_OPERATORS));
                    // For booleans, only equals/not_equals are allowed and both need a value.
                    const needsValueInput = isBooleanRef
                      ? true
                      : (condition.operator !== 'is_empty' && condition.operator !== 'not_empty' &&
                        !isLmicConditionOperator(condition.operator));
                    
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
                              if (!value) return;
                              const newField = fields.find(f => f.id === value);
                              if (newField?.type === 'boolean') {
                                // Auto-correct: booleans only support equals/not_equals
                                // and need a true/false value (default to "true").
                                updateCondition(rule.id, condition.id, {
                                  field_id: value,
                                  operator: isBooleanOperatorAllowed(condition.operator) ? condition.operator : 'equals',
                                  value: 'true',
                                });
                              } else if (
                                isLmicConditionOperator(condition.operator) &&
                                newField?.type !== 'country' && newField?.type !== 'countries'
                              ) {
                                // LMIC operators only apply to country fields —
                                // auto-correct when switching to another type.
                                updateCondition(rule.id, condition.id, { field_id: value, operator: 'equals', value: '' });
                              } else {
                                updateCondition(rule.id, condition.id, { field_id: value, value: '' });
                              }
                            }}
                          >
                            <SelectTrigger className="h-9" data-testid={`select-condition-field-${index}-${condIndex}`}>
                              <SelectValue placeholder="Select field..." />
                            </SelectTrigger>
                            <SelectContent>
                              {fields.filter(f => f.type !== 'instructions' && f.type !== 'image').map(field => (
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
                              {operatorOptions.map(op => (
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
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'submit_control')}
                        data-testid={`button-add-submit-action-${index}`}
                      >
                        <Lock className="w-3 h-3 mr-1" /> Submit Button
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => addAction(rule.id, 'membership_structure')}
                        data-testid={`button-add-membership-action-${index}`}
                      >
                        <CreditCard className="w-3 h-3 mr-1" /> Membership
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
                        const isSubmitControlAction = action.action_type === 'submit_control';
                        const isMembershipAction = action.action_type === 'membership_structure';
                        // Determine card styling
                        let cardClass = 'p-3 rounded-lg border ';
                        if (isConsolidatedVisibility) {
                          cardClass += 'bg-slate-50 border-slate-300';
                        } else if (isMembershipAction) {
                          cardClass += 'bg-emerald-50 border-emerald-200';
                        } else if (isSubmitControlAction) {
                          cardClass += 'bg-purple-50 border-purple-200';
                        } else if (isLegacyVisibilityAction) {
                          cardClass += 'bg-white border-slate-200';
                        } else if (isLegacyDisabilityAction) {
                          cardClass += 'bg-warning/10 border-warning/30';
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
                                {action.action_type === 'disable' && <Lock className="w-3 h-3 text-warning" />}
                                {action.action_type === 'enable' && <Unlock className="w-3 h-3 text-teal-600" />}
                                {action.action_type === 'submit_control' && (
                                  action.submit_state === 'enable'
                                    ? <Unlock className="w-3 h-3 text-purple-600" />
                                    : <Lock className="w-3 h-3 text-purple-600" />
                                )}
                                {action.action_type === 'membership_structure' && <CreditCard className="w-3 h-3 text-emerald-600" />}
                                <span className="text-xs font-medium">
                                  {action.action_type === 'membership_structure' && 'Membership'}
                                  {action.action_type === 'submit_control' && 'Submit Button'}
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

                            {isMembershipAction ? (
                              <MembershipStructureActionSettings
                                action={action}
                                ruleId={rule.id}
                                fields={fields}
                                updateAction={updateAction}
                                index={index}
                                actionIndex={actionIndex}
                                entityPipelines={entityPipelines}
                              />
                            ) : isSubmitControlAction ? (
                              <div className="space-y-2">
                                <p className="text-xs text-slate-500">
                                  Control the Submit button while this rule's conditions match. "Disable submit" blocks submission; "Enable submit" overrides a disable from another rule.
                                </p>
                                <div className="flex items-center gap-2">
                                  <Select
                                    value={action.submit_state || 'disable'}
                                    onValueChange={(value) => updateAction(rule.id, action.id, { submit_state: value })}
                                  >
                                    <SelectTrigger className="h-8 text-xs w-40" data-testid={`select-submit-state-${index}-${actionIndex}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="disable">Disable submit</SelectItem>
                                      <SelectItem value="enable">Enable submit</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                {(action.submit_state || 'disable') === 'disable' && (
                                  <div>
                                    <Label className="text-xs text-slate-600">Message shown near the Submit button (optional)</Label>
                                    <Input
                                      value={action.message || ''}
                                      onChange={(e) => updateAction(rule.id, action.id, { message: e.target.value })}
                                      placeholder="e.g. Please review your answers before submitting"
                                      className="h-8 text-xs mt-1"
                                      data-testid={`input-submit-message-${index}-${actionIndex}`}
                                    />
                                  </div>
                                )}
                              </div>
                            ) : isConsolidatedVisibility ? (
                              <div>
                                <p className="text-xs text-slate-500 mb-3">
                                  Configure visibility and enabled state for each field or page. Leave as "Inherit" for no change.
                                </p>
                                {availableTargetFields.length === 0 && pages.length === 0 ? (
                                  <p className="text-xs text-slate-400">Add more fields to configure visibility</p>
                                ) : (
                                  <div className="border rounded-lg overflow-hidden">
                                    <div className="grid grid-cols-[1fr,120px,120px] gap-2 bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600 border-b">
                                      <div>Target</div>
                                      <div className="text-center">Visibility</div>
                                      <div className="text-center">State</div>
                                    </div>
                                    <div className="max-h-80 overflow-y-auto">
                                      {pages.length > 0 && (
                                        <>
                                          <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-100">
                                            <span className="text-xs font-semibold text-blue-700 flex items-center gap-1">
                                              <FileText className="w-3 h-3" />
                                              Pages
                                            </span>
                                          </div>
                                          {pages.map((page, pageIdx) => {
                                            const pageState = (action.field_states || {})[page.id] || { visible: null };
                                            return (
                                              <div
                                                key={page.id}
                                                className={`grid grid-cols-[1fr,120px,120px] gap-2 px-3 py-2 text-xs items-center ${pageIdx % 2 === 0 ? 'bg-blue-50/30' : 'bg-white'}`}
                                                data-testid={`visibility-row-page-${index}-${actionIndex}-${page.id}`}
                                              >
                                                <div className="font-medium truncate flex items-center gap-1" title={page.title}>
                                                  <FileText className="w-3 h-3 text-blue-500 flex-shrink-0" />
                                                  {page.title || `Page ${pageIdx + 1}`}
                                                </div>
                                                <div className="flex justify-center">
                                                  <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
                                                    <button
                                                      type="button"
                                                      onClick={() => updateFieldVisibilityState(rule.id, action.id, page.id, 'visible', true)}
                                                      className={`px-2 py-1 text-xs ${pageState.visible === true ? 'bg-green-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                                      title="Show page when condition is met"
                                                      data-testid={`btn-show-page-${index}-${actionIndex}-${page.id}`}
                                                    >
                                                      <Eye className="w-3 h-3" />
                                                    </button>
                                                    <button
                                                      type="button"
                                                      onClick={() => updateFieldVisibilityState(rule.id, action.id, page.id, 'visible', null)}
                                                      className={`px-2 py-1 text-xs border-l border-r border-slate-200 ${pageState.visible === null ? 'bg-slate-200 text-slate-700' : 'bg-white text-slate-400 hover:bg-slate-50'}`}
                                                      title="Inherit (no change)"
                                                      data-testid={`btn-inherit-vis-page-${index}-${actionIndex}-${page.id}`}
                                                    >
                                                      —
                                                    </button>
                                                    <button
                                                      type="button"
                                                      onClick={() => updateFieldVisibilityState(rule.id, action.id, page.id, 'visible', false)}
                                                      className={`px-2 py-1 text-xs ${pageState.visible === false ? 'bg-red-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                                      title="Hide page when condition is met"
                                                      data-testid={`btn-hide-page-${index}-${actionIndex}-${page.id}`}
                                                    >
                                                      <EyeOff className="w-3 h-3" />
                                                    </button>
                                                  </div>
                                                </div>
                                                <div className="flex justify-center">
                                                  <span className="text-xs text-slate-400">—</span>
                                                </div>
                                              </div>
                                            );
                                          })}
                                          <div className="px-3 py-1.5 bg-slate-50 border-b border-t border-slate-100">
                                            <span className="text-xs font-semibold text-slate-600">Fields</span>
                                          </div>
                                        </>
                                      )}
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
                                                  className={`px-2 py-1 text-xs ${fieldState.enabled === false ? 'bg-warning text-warning-foreground' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
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
                                        const targetField = fields.find(f => f.id === value);
                                        const isInstructionsTarget = targetField?.type === 'instructions';
                                        updateAction(rule.id, action.id, {
                                          target_field_id: value,
                                          set_value: '',
                                          // Instructions targets only support static rich-text content
                                          ...(isInstructionsTarget ? {
                                            set_value_source: 'static',
                                            set_value_field_id: '',
                                            set_value_prefill_field: ''
                                          } : {})
                                        });
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
                      )}
                    </Draggable>
                  );
                })}
                {dropProvided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
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

// Keep in sync with the top-level ORG_CORE_FIELDS constant and the API's
// WHITELISTED_ORG_FIELDS — see comment above ORG_CORE_FIELDS.
const ORG_PREFILL_FIELDS = [
  { value: 'name', label: 'Organisation Name' },
  { value: 'description', label: 'Description' },
  { value: 'logo_url', label: 'Logo' },
  { value: 'invoicing_email', label: 'Invoicing Email' },
  { value: 'invoicing_address', label: 'Invoicing Address' },
  { value: 'phone', label: 'Phone' },
  { value: 'website_url', label: 'Website URL' },
  { value: 'tags', label: 'Tags' },
];

const BOOKING_PREFILL_FIELDS = [
  { value: 'attendee_first_name', label: 'Attendee First Name' },
  { value: 'attendee_last_name', label: 'Attendee Last Name' },
  { value: 'attendee_email', label: 'Attendee Email' },
  { value: 'attendee_phone', label: 'Attendee Phone' },
  { value: 'attendee_job_title', label: 'Attendee Job Title' },
  { value: 'guest_organisation_name', label: 'Guest Organisation Name' },
  { value: 'event_name', label: 'Event Name' },
  { value: 'ticket_class_name', label: 'Ticket Class' },
  { value: 'booking_reference', label: 'Booking Reference' },
];

// EmailCard component for configuring individual email notifications
function EmailCard({
  email,
  index,
  emailTemplates,
  formFields,
  onUpdate,
  onRemove,
  hasMembershipPaymentField
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
                            {formFields.filter(f => f.type !== 'instructions' && f.type !== 'image' && f.type !== 'image_buttons').map(field => (
                              <SelectItem key={field.id} value={field.id}>
                                <span className="inline-flex items-center gap-2">
                                  <span>{field.label || field.id}</span>
                                  {field.starts_hidden && (
                                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 py-0.5">hidden</span>
                                  )}
                                </span>
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
            <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg space-y-3">
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
                            <span className="inline-flex items-center gap-2">
                              <span>{field.label || field.id}</span>
                              {field.starts_hidden && (
                                <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 py-0.5">hidden</span>
                              )}
                            </span>
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
                    <p className="text-xs text-warning">
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

            {hasMembershipPaymentField && (
              <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <Label className="text-xs font-medium flex items-center gap-1">
                      <Paperclip className="w-3 h-3" />
                      Attach Invoice
                    </Label>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Attach the Xero invoice PDF to this email
                    </p>
                  </div>
                  <Switch
                    checked={!!email.attach_invoice}
                    onCheckedChange={(checked) => {
                      onUpdate({ attach_invoice: checked });
                    }}
                    data-testid={`switch-email-attach-invoice-${email.id}`}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Task #3483: inspector for the generic Payment field. Shows only the
// providers actually configured for the tenant (via the secrets-free
// detection endpoint); unconfigured providers appear disabled with a hint
// to set them up in Integrations. The amount always derives from another
// form field (number/currency-type) chosen here.
const PAYMENT_PRICE_SOURCE_TYPES = new Set(['number', 'currency', 'percentage', 'select', 'radio', 'custom_field']);

function PaymentFieldSettings({ field, originalIndex, allFields, updateField }) {
  const [providers, setProviders] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/form-payment-providers', { credentials: 'include' })
      .then(res => res.ok ? res.json() : { providers: [] })
      .then(json => { if (!cancelled) setProviders(json.providers || []); })
      .catch(() => { if (!cancelled) setProviders([]); });
    return () => { cancelled = true; };
  }, []);

  const enabled = Array.isArray(field.payment_providers) ? field.payment_providers : [];
  const toggleProvider = (id, checked) => {
    const next = checked ? [...new Set([...enabled, id])] : enabled.filter(p => p !== id);
    updateField(originalIndex, { payment_providers: next });
  };

  const priceSourceFields = allFields.filter(f =>
    f.id !== field.id && PAYMENT_PRICE_SOURCE_TYPES.has(f.type)
  );

  return (
    <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
      <Label className="text-xs font-medium">Payment Settings</Label>

      <div className="space-y-2">
        <Label className="text-xs">Payment methods</Label>
        {providers === null ? (
          <p className="text-xs text-slate-400">Checking configured providers…</p>
        ) : (
          providers.map(p => (
            <div key={p.id} className="flex items-start gap-2">
              <Checkbox
                id={`payment-provider-${p.id}-${field.id}`}
                checked={enabled.includes(p.id)}
                disabled={!p.configured}
                onCheckedChange={(checked) => toggleProvider(p.id, checked === true)}
                data-testid={`checkbox-payment-provider-${p.id}-${field.id}`}
              />
              <div>
                <Label htmlFor={`payment-provider-${p.id}-${field.id}`} className={`text-xs ${!p.configured ? 'text-slate-400' : ''}`}>
                  {p.name}
                </Label>
                {!p.configured && (
                  <p className="text-xs text-slate-400">Not configured — set this up in Integrations to enable it.</p>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`payment-price-field-${field.id}`} className="text-xs">Price source field</Label>
        <p className="text-xs text-slate-500">
          The amount charged is taken from this field's answer (validated on the server).
        </p>
        <Select
          value={field.price_field_id || '_none'}
          onValueChange={(val) => updateField(originalIndex, { price_field_id: val === '_none' ? null : val })}
        >
          <SelectTrigger id={`payment-price-field-${field.id}`} data-testid={`select-payment-price-field-${field.id}`}>
            <SelectValue placeholder="Select a field" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none">— Select a field —</SelectItem>
            {priceSourceFields.map(f => (
              <SelectItem key={f.id} value={f.id}>{f.label || f.id} ({f.type})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {priceSourceFields.length === 0 && (
          <p className="text-xs text-warning">Add a number or currency field to this form to use as the price source.</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`payment-currency-${field.id}`} className="text-xs">Currency</Label>
        <Select
          value={field.payment_currency || 'GBP'}
          onValueChange={(val) => updateField(originalIndex, { payment_currency: val })}
        >
          <SelectTrigger id={`payment-currency-${field.id}`} data-testid={`select-payment-currency-${field.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['GBP', 'USD', 'EUR', 'AUD', 'NZD'].map(c => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`payment-label-${field.id}`} className="text-xs">Payment label (optional)</Label>
        <Input
          id={`payment-label-${field.id}`}
          value={field.payment_label || ''}
          onChange={(e) => updateField(originalIndex, { payment_label: e.target.value })}
          placeholder="e.g. Registration fee"
          data-testid={`input-payment-label-${field.id}`}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`payment-description-${field.id}`} className="text-xs">Payment description (optional)</Label>
        <Input
          id={`payment-description-${field.id}`}
          value={field.payment_description || ''}
          onChange={(e) => updateField(originalIndex, { payment_description: e.target.value })}
          placeholder="Shown to the person paying"
          data-testid={`input-payment-description-${field.id}`}
        />
      </div>
    </div>
  );
}

// Task #3497: non-blocking, dismissible builder warning for starts-hidden
// pages/fields that no visibility rule ever reveals — they can never appear
// on the public form.
function UnreachableHiddenWarning({ fields, pages, visibilityRules }) {
  // Dismissal is keyed to the current finding set: if new unreachable
  // pages/fields appear after dismissing, the warning comes back.
  const [dismissedKey, setDismissedKey] = useState(null);
  const unreachable = findUnrevealedHidden(fields, pages, visibilityRules);
  const findingKey = [...unreachable.pages.map(p => p.id), ...unreachable.fields.map(f => f.id)].sort().join('|');
  if (dismissedKey === findingKey || (unreachable.pages.length === 0 && unreachable.fields.length === 0)) return null;
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 flex items-start gap-2" data-testid="unreachable-hidden-warning">
      <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
      <div className="text-xs text-amber-800 space-y-1 flex-1">
        <p className="font-medium">Some hidden pages or fields can never be shown</p>
        <p>They start hidden, but no conditional-logic rule ever makes them visible, so they will never appear on the public form:</p>
        <ul className="list-disc pl-4">
          {unreachable.pages.map(p => (
            <li key={p.id}>Page "{p.title}"</li>
          ))}
          {unreachable.fields.map(f => (
            <li key={f.id}>Field "{f.label}"</li>
          ))}
        </ul>
        <p>Add a visibility rule that shows them, or untick "starts hidden".</p>
      </div>
      <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={() => setDismissedKey(findingKey)} data-testid="dismiss-unreachable-hidden-warning">
        <X className="w-3 h-3" />
      </Button>
    </div>
  );
}

// Conditional-logic "Membership" action (Task #3489): selects a membership
// structure; when the rule matches at payment time, the server derives the
// membership fee for that structure, charges it, and creates the paid
// membership record after successful payment.
function MembershipStructureActionSettings({ action, ruleId, fields, updateAction, index, actionIndex, entityPipelines }) {
  const [tierConfigs, setTierConfigs] = useState([]);
  const [requiredFields, setRequiredFields] = useState([]);
  const [autoConfigs, setAutoConfigs] = useState(null); // null = loading
  const [loadingFields, setLoadingFields] = useState(false);

  // Auto-resolve mode (Task #3659): instead of pinning one structure, the
  // server matches the mapped answer against each active member-scoped
  // structure's match value at quote/charge time.
  const isAutoMode = action.resolve_mode === 'auto';

  useEffect(() => {
    fetch('/api/membership/tiers', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.activeConfigs) setTierConfigs(data.activeConfigs);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isAutoMode) {
      setLoadingFields(true);
      fetch('/api/membership/tier-required-fields?auto=1&scope=member', { credentials: 'include' })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          setRequiredFields(data?.requiredFields || []);
          setAutoConfigs(data?.configs || []);
        })
        .catch(() => { setRequiredFields([]); setAutoConfigs([]); })
        .finally(() => setLoadingFields(false));
      return;
    }
    setAutoConfigs(null);
    const configId = action.config_id;
    if (!configId) {
      setRequiredFields([]);
      return;
    }
    setLoadingFields(true);
    fetch(`/api/membership/tier-required-fields?configId=${encodeURIComponent(configId)}`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => setRequiredFields(data?.requiredFields || []))
      .catch(() => setRequiredFields([]))
      .finally(() => setLoadingFields(false));
  }, [action.config_id, isAutoMode]);

  const fieldMappings = action.field_mappings || {};
  const selectedConfig = tierConfigs.find(c => c.id === action.config_id);
  const hasPaymentField = fields.some(f => f.type === 'payment');
  // Scope-to-pipeline check: the membership attaches to the entity the
  // form's processing pipelines resolve, so the scopes must match. The
  // server enforces the same rule before creating any charge.
  const hasMemberPipeline = (entityPipelines?.members?.length || 0) > 0;
  const hasOrgPipeline = (entityPipelines?.organisations?.length || 0) > 0;
  const selectedScope = isAutoMode
    ? 'member'
    : selectedConfig ? (selectedConfig.structure_scope_type === 'member' ? 'member' : 'organization') : null;
  const scopeMismatch = selectedScope === 'member'
    ? !hasMemberPipeline
    : selectedScope === 'organization'
      ? !hasOrgPipeline
      : false;

  // Auto-mode validation: the structure-scoping field(s) MUST be mapped —
  // without the mapped answer the server can never resolve a structure.
  const structureFields = requiredFields.filter(rf => rf.usage === 'structure');
  const unmappedStructureFields = isAutoMode
    ? structureFields.filter(rf => !fieldMappings[rf.field_id])
    : [];

  const updateMapping = (dbFieldId, formFieldId) => {
    const newMappings = { ...fieldMappings };
    if (formFieldId === '_none') {
      delete newMappings[dbFieldId];
    } else {
      newMappings[dbFieldId] = formFieldId;
    }
    updateAction(ruleId, action.id, { field_mappings: newMappings });
  };

  const mappableFormFields = fields.filter(f => f.type !== 'payment' && f.type !== 'membership_payment' && f.type !== 'instructions' && f.type !== 'image' && f.type !== 'image_buttons');

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        When this rule matches, the payment amount is the membership fee for the selected structure, and a paid membership record (with its invoice) is created automatically once the payment succeeds.
      </p>
      {!hasPaymentField && (
        <p className="text-xs text-amber-600" data-testid="membership-action-no-payment-warning">
          {fields.some(f => f.type === 'membership_payment') ? (
            <>
              This form has a <strong>Membership Payment</strong> field, but that is a separate mechanism for charging <em>existing members</em>. This action charges new applicants through the generic <strong>Payment</strong> field — add one (its price source can stay empty; the fee comes from the selected structure).
            </>
          ) : (
            <>This form has no Payment field. Add one — the membership fee is charged through it.</>
          )}
        </p>
      )}
      <div className="space-y-2">
        <Label className="text-xs">Structure selection</Label>
        <Select
          value={isAutoMode ? '_auto_resolve' : '_specific'}
          onValueChange={(val) => {
            if (val === '_auto_resolve') {
              updateAction(ruleId, action.id, { resolve_mode: 'auto', config_id: '', field_mappings: {} });
            } else {
              updateAction(ruleId, action.id, { resolve_mode: null, config_id: '', field_mappings: {} });
            }
          }}
        >
          <SelectTrigger className="h-8 text-xs" data-testid={`select-membership-mode-${index}-${actionIndex}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_specific">Specific structure</SelectItem>
            <SelectItem value="_auto_resolve">Auto-resolve from mapped field</SelectItem>
          </SelectContent>
        </Select>
        {isAutoMode && (
          <p className="text-xs text-slate-500">
            The structure is chosen at payment time by matching the applicant's mapped answer against each active member-scoped structure's match value (case-insensitive). Newly added structures work automatically.
          </p>
        )}
        {!isAutoMode && (
          <Select
            value={action.config_id || ''}
            onValueChange={(val) => updateAction(ruleId, action.id, { config_id: val, field_mappings: {} })}
          >
            <SelectTrigger className="h-8 text-xs" data-testid={`select-membership-config-${index}-${actionIndex}`}>
              <SelectValue placeholder="Select a membership structure…" />
            </SelectTrigger>
            <SelectContent>
              {tierConfigs.map(cfg => (
                <SelectItem key={cfg.id} value={cfg.id}>
                  {cfg.name || 'Unnamed'} ({cfg.structure_scope_type === 'member' ? 'member' : 'organisation'})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {isAutoMode && autoConfigs !== null && (
          autoConfigs.length === 0 ? (
            <p className="text-xs text-red-600" data-testid={`warning-membership-auto-none-${index}-${actionIndex}`}>
              No member-scoped membership structures are currently in effect, so nothing can be auto-resolved. Create structures with a match value first.
            </p>
          ) : (
            <div className="space-y-1" data-testid={`membership-auto-preview-${index}-${actionIndex}`}>
              <p className="text-xs text-slate-500">Structures this rule can currently resolve to:</p>
              <ul className="text-xs text-slate-500 list-disc pl-4 space-y-0.5">
                {autoConfigs.map(cfg => (
                  <li key={cfg.id}>
                    {cfg.name}{cfg.structure_match_value ? <> — matches "<span className="font-medium">{cfg.structure_match_value}</span>"</> : <> — fallback (no match value)</>}
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
        {isAutoMode && unmappedStructureFields.length > 0 && (
          <p className="text-xs text-red-600" data-testid={`warning-membership-auto-unmapped-${index}-${actionIndex}`}>
            Auto-resolve requires the {unmappedStructureFields.map(rf => `"${rf.field_label}"`).join(', ')} answer to be mapped to a form field below — payments will fail until it is mapped.
          </p>
        )}
        {selectedConfig && (
          <p className="text-xs text-slate-400">
            Membership will be created for the {selectedScope === 'member' ? 'member' : 'organisation'} resolved by this form's processing pipelines.
          </p>
        )}
        {scopeMismatch && (
          <p className="text-xs text-red-600" data-testid={`warning-membership-scope-${index}-${actionIndex}`}>
            {selectedScope === 'member'
              ? 'This structure creates a member membership, but the form has no member-creating processing pipeline (Form Processing tab). Payments will be blocked until one is added.'
              : 'This structure creates an organisation membership, but the form has no organisation-creating processing pipeline (Form Processing tab). Payments will be blocked unless the form is opened with an organisation prefill link.'}
          </p>
        )}
      </div>

      {(action.config_id || isAutoMode) && (
        <div className="space-y-2">
          <Label className="text-xs font-medium">Fee calculation mappings</Label>
          <p className="text-xs text-slate-500">
            {isAutoMode
              ? 'Map the answers used to pick the structure and calculate its fee. The structure-selection mapping is required in auto-resolve mode.'
              : 'Map the values used in the fee calculation to form fields, so the fee can be worked out from the applicant\'s answers before their record exists.'}
          </p>
          {loadingFields ? (
            <p className="text-xs text-slate-400">Loading required fields…</p>
          ) : requiredFields.length === 0 ? (
            <p className="text-xs text-slate-400">{isAutoMode ? 'No active member-scoped structures need mapped answers yet.' : 'This structure needs no mapped answers (flat rate).'}</p>
          ) : (
            <div className="space-y-2">
              {requiredFields.map(rf => (
                <div key={`${rf.field_id}-${rf.usage}`} className="space-y-1">
                  <div className="flex items-center gap-1 flex-wrap">
                    <Label className="text-xs">{rf.field_label}</Label>
                    <span className="text-xs text-slate-400">
                      ({rf.usage === 'structure' ? 'tier selection' : rf.usage === 'band' ? 'pricing band' : 'discount'})
                    </span>
                  </div>
                  <Select
                    value={fieldMappings[rf.field_id] || '_none'}
                    onValueChange={(val) => updateMapping(rf.field_id, val)}
                  >
                    <SelectTrigger className="h-8 text-xs" data-testid={`select-membership-mapping-${index}-${actionIndex}-${rf.field_id}`}>
                      <SelectValue placeholder="Not mapped" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">Not mapped</SelectItem>
                      {mappableFormFields.map(f => (
                        <SelectItem key={f.id} value={f.id}>{f.label || f.type}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MembershipPaymentSettings({ field, originalIndex, allFields, updateField }) {
  const [tierConfigs, setTierConfigs] = useState([]);
  const [requiredFields, setRequiredFields] = useState([]);
  const [loadingFields, setLoadingFields] = useState(false);

  useEffect(() => {
    fetch('/api/membership/tiers', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.activeConfigs) {
          setTierConfigs(data.activeConfigs);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const configId = field.membership_config_id;
    if (!configId) {
      setRequiredFields([]);
      return;
    }
    setLoadingFields(true);
    fetch(`/api/membership/tier-required-fields?configId=${encodeURIComponent(configId)}`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.requiredFields) {
          setRequiredFields(data.requiredFields);
        } else {
          setRequiredFields([]);
        }
      })
      .catch(() => setRequiredFields([]))
      .finally(() => setLoadingFields(false));
  }, [field.membership_config_id]);

  const fieldMappings = field.field_mappings || {};

  const updateMapping = (dbFieldId, formFieldId) => {
    const newMappings = { ...fieldMappings };
    if (formFieldId === '_none') {
      delete newMappings[dbFieldId];
    } else {
      newMappings[dbFieldId] = formFieldId;
    }
    updateField(originalIndex, { field_mappings: newMappings });
  };

  const mappableFormFields = allFields.filter(f => f.id !== field.id && f.type !== 'membership_payment' && f.type !== 'instructions' && f.type !== 'image' && f.type !== 'image_buttons');

  return (
    <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
      <Label className="text-xs font-medium">Membership Payment Settings</Label>

      <div className="space-y-2">
        <Label htmlFor={`membership-schedule-${field.id}`} className="text-xs">Membership Schedule</Label>
        <p className="text-xs text-slate-500">
          Select which membership schedule to use for fee calculation. Required to enable field mapping.
        </p>
        <Select
          value={field.membership_config_id || '_auto'}
          onValueChange={(val) => {
            const newConfigId = val === '_auto' ? null : val;
            const updates = { membership_config_id: newConfigId };
            if (!newConfigId) updates.field_mappings = {};
            updateField(originalIndex, updates);
          }}
        >
          <SelectTrigger id={`membership-schedule-${field.id}`} data-testid={`select-membership-schedule-${field.id}`}>
            <SelectValue placeholder="Auto-detect" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_auto">Auto-detect (from member/org data)</SelectItem>
            {tierConfigs.map(cfg => (
              <SelectItem key={cfg.id} value={cfg.id}>
                {cfg.name || 'Unnamed'} ({cfg.structure_scope_type || 'organization'})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {field.membership_config_id && requiredFields.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs font-medium">Field Mappings</Label>
          <p className="text-xs text-slate-500">
            Map database fields used in fee calculation to form fields. This ensures the fee is calculated correctly using values from this form before they are saved to the database.
          </p>
          {loadingFields ? (
            <p className="text-xs text-slate-400">Loading required fields...</p>
          ) : (
            <div className="space-y-2">
              {requiredFields.map(rf => (
                <div key={`${rf.field_id}-${rf.usage}`} className="space-y-1">
                  <div className="flex items-center gap-1 flex-wrap">
                    <Label className="text-xs">{rf.field_label}</Label>
                    <span className="text-xs text-slate-400">
                      ({rf.usage === 'structure' ? 'tier selection' : rf.usage === 'band' ? 'pricing band' : 'discount'})
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">{rf.usage_detail}</p>
                  <Select
                    value={fieldMappings[rf.field_id] || '_none'}
                    onValueChange={(val) => updateMapping(rf.field_id, val)}
                  >
                    <SelectTrigger data-testid={`select-field-mapping-${rf.field_id}-${field.id}`}>
                      <SelectValue placeholder="Not mapped (use database value)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">Not mapped (use database value)</SelectItem>
                      {mappableFormFields.map(f => (
                        <SelectItem key={f.id} value={f.id}>{f.label || 'Untitled Field'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {field.membership_config_id && !loadingFields && requiredFields.length === 0 && (
        <p className="text-xs text-slate-400">
          This schedule uses flat-rate pricing with no field-driven configuration. No mappings needed.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor={`invoice-address-field-${field.id}`} className="text-xs">Invoice Address Field</Label>
        <p className="text-xs text-slate-500">
          Select a form field to use as the invoice address. This is needed when the address is collected on the same form as the payment, since the form hasn't been submitted yet when the invoice is created.
        </p>
        <Select
          value={field.invoice_address_field_id || '_none'}
          onValueChange={(val) => updateField(originalIndex, { invoice_address_field_id: val === '_none' ? null : val })}
        >
          <SelectTrigger id={`invoice-address-field-${field.id}`} data-testid={`select-invoice-address-field-${field.id}`}>
            <SelectValue placeholder="None (use membership schedule setting)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none">None (use membership schedule setting)</SelectItem>
            {allFields
              .filter(f => f.id !== field.id && ['text', 'textarea', 'address'].includes(f.type))
              .map(f => (
                <SelectItem key={f.id} value={f.id}>{f.label || 'Untitled Field'}</SelectItem>
              ))
            }
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function OrgFieldValueSelector({ fieldType, fieldName, selectedValues, onChange, fieldId }) {
  const { data: distinctValues = [], isLoading, isError } = useQuery({
    queryKey: ['org-field-values', fieldType, fieldName],
    queryFn: async () => await publicClient.listOrganizationFieldValues(fieldType, fieldName) || [],
    enabled: !!fieldType && !!fieldName,
    staleTime: 2 * 60 * 1000
  });

  if (isLoading) {
    return (
      <div className="p-2 text-xs text-slate-500 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading values...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
        Failed to load values. Please try again.
      </div>
    );
  }

  if (distinctValues.length === 0) {
    return (
      <div className="p-2 bg-warning/10 border border-warning/30 rounded text-xs text-warning">
        No values found for this field in the database.
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-48 overflow-y-auto">
      {distinctValues.map((val) => {
        const isSelected = selectedValues.includes(val);
        return (
          <div
            key={val}
            className="flex items-center gap-2 p-2 bg-white rounded border border-slate-200 hover:bg-slate-50 transition-colors"
          >
            <Checkbox
              id={`org-fv-${fieldId}-${val}`}
              checked={isSelected}
              onCheckedChange={(checked) => {
                const newVals = checked
                  ? [...selectedValues, val]
                  : selectedValues.filter(s => s !== val);
                onChange(newVals);
              }}
              data-testid={`checkbox-org-fv-${fieldId}-${String(val).toLowerCase().replace(/\s+/g, '-')}`}
            />
            <Label
              htmlFor={`org-fv-${fieldId}-${val}`}
              className="text-xs font-medium cursor-pointer flex-1"
            >
              {val}
            </Label>
          </div>
        );
      })}
    </div>
  );
}

// Interactive live preview for the Score field config (Task #3330)
function ScoreFieldPreview({ field }) {
  const [previewValue, setPreviewValue] = useState(null);
  return (
    <ScoreField
      field={{ ...field, label: '' }}
      value={previewValue}
      onChange={setPreviewValue}
    />
  );
}

const CONDITIONAL_FILTER_TARGET_TYPES = new Set([
  'select',
  'radio',
  'checkbox',
  'image_buttons',
  'country',
  'countries',
  'category_multiselect',
  'category_dropdown',
  'communication_preferences',
  'organisation_dropdown',
  'relationship_dropdown',
  'custom_field',
]);

const CONDITIONAL_FILTER_OPERATORS = {
  text: [
    ['equals', 'Equals'],
    ['not_equals', 'Does not equal'],
    ['includes', 'Includes'],
    ['not_includes', 'Does not include'],
    ['in', 'Is one of'],
    ['not_in', 'Is not one of'],
    ['is_empty', 'Is empty'],
    ['is_not_empty', 'Is not empty'],
  ],
  multi: [
    ['includes', 'Includes'],
    ['not_includes', 'Does not include'],
    ['in', 'Contains any of'],
    ['not_in', 'Contains none of'],
    ['is_empty', 'Is empty'],
    ['is_not_empty', 'Is not empty'],
  ],
  number: [
    ['equals', 'Equals'],
    ['not_equals', 'Does not equal'],
    ['in', 'Is one of'],
    ['not_in', 'Is not one of'],
    ['greater_than', 'Greater than'],
    ['greater_or_equal', 'Greater than or equal'],
    ['less_than', 'Less than'],
    ['less_or_equal', 'Less than or equal'],
    ['is_empty', 'Is empty'],
    ['is_not_empty', 'Is not empty'],
  ],
};

const conditionalOption = (option) => {
  if (option && typeof option === 'object') {
    const value = option.value ?? option.id ?? '';
    return { value, label: option.label || option.name || String(value) };
  }
  return { value: option, label: String(option ?? '') };
};

function getConditionalFieldOptions(field, categories, communicationCategories, customFields = []) {
  if (!field) return [];
  let options;
  if (['select', 'radio', 'checkbox'].includes(field.type)) {
    return (field.options || []).filter(option => option !== '').map(conditionalOption);
  }
  if (field.type === 'image_buttons') {
    return (field.image_options || []).filter(option => option?.value !== '').map(conditionalOption);
  }
  if (['country', 'countries'].includes(field.type)) {
    const allowed = field.all_countries === false ? new Set(field.selected_countries || []) : null;
    options = COUNTRIES
      .filter(country => !allowed || allowed.has(country.code))
      .map(country => ({ value: country.name, label: country.name }));
    return prependFormNotListedOption(field, options);
  }
  if (field.type === 'category_multiselect') {
    const allowed = new Set(field.allowed_category_ids || []);
    options = categories
      .filter(category => allowed.size === 0 || allowed.has(category.id))
      .flatMap(category => (category.subcategories || category.children || category.options || [])
        .map(subcategory => conditionalOption(subcategory)));
    return prependFormNotListedOption(field, options);
  }
  if (field.type === 'category_dropdown') {
    const category = categories.find(item => item.id === field.category_id);
    const children = category?.subcategories || category?.children || category?.options || [];
    return prependFormNotListedOption(field, children.map(conditionalOption));
  }
  if (field.type === 'communication_preferences') {
    const allowed = new Set(field.allowed_category_ids || []);
    return communicationCategories
      .filter(category => allowed.size === 0 || allowed.has(category.id))
      .map(category => ({ value: category.id, label: category.name }));
  }
  if (field.type === 'custom_field') {
    const customField = customFields.find(item => item.id === field.custom_field_id);
    if (['country', 'countries'].includes(customField?.field_type)) {
      const allowed = customField.all_countries === false
        ? new Set(customField.selected_countries || [])
        : null;
      return COUNTRIES
        .filter(country => !allowed || allowed.has(country.code))
        .map(country => ({ value: country.name, label: country.name }));
    }
    return (customField?.options || field.options || []).map(conditionalOption);
  }
  options = (field.options || []).map(conditionalOption);
  return prependFormNotListedOption(field, options);
}

function getConditionalOperatorGroup(field) {
  if (['number', 'percentage', 'currency', 'score', 'date', 'time'].includes(field?.type)) return 'number';
  if (['checkbox', 'countries', 'category_multiselect', 'communication_preferences', 'list'].includes(field?.type)) return 'multi';
  return 'text';
}

function ConditionalOrgFilterValues({ type, fieldName, values, onChange, customFields, ruleId }) {
  const configuredOptions = useMemo(
    () => configuredOrganizationFilterOptions(type, fieldName, customFields),
    [type, fieldName, customFields],
  );
  const usesConfiguredOptions = configuredOptions.length > 0;
  const { data: distinctValues = [], isLoading, isError } = useQuery({
    queryKey: ['org-field-values', type, fieldName],
    queryFn: async () => await publicClient.listOrganizationFieldValues(type, fieldName) || [],
    enabled: !!type && !!fieldName && !usesConfiguredOptions,
    staleTime: 2 * 60 * 1000,
  });
  const options = useMemo(
    () => mergeOrganizationFilterOptions(
      usesConfiguredOptions ? configuredOptions : distinctValues,
      values,
    ),
    [configuredOptions, distinctValues, usesConfiguredOptions, values],
  );

  if (!usesConfiguredOptions && isLoading) {
    return (
      <div className="flex items-center gap-2 rounded border border-slate-200 p-2 text-xs text-slate-500">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading values…
      </div>
    );
  }
  if (!usesConfiguredOptions && isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
        Failed to load values. Existing selections have not been changed.
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
        No values are available for this field.
      </div>
    );
  }
  return (
    <PolicyMultiSelect
      options={options}
      value={values.map(item => String(item))}
      onChange={onChange}
      placeholder="Choose allowed values…"
      testId={`select-conditional-org-filter-values-${ruleId}`}
    />
  );
}

function ConditionalOrgFilterEditor({ value, onChange, customFields, ruleId }) {
  const coreFields = [
    ['name', 'Name'],
    ['slug', 'Slug'],
    ['description', 'Description'],
    ['website_url', 'Website URL'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['address', 'Address'],
    ['city', 'City'],
    ['country', 'Country'],
    ['postcode', 'Postcode'],
    ['status', 'Status'],
    ['external_id', 'External ID'],
    ['is_active', 'Is Active'],
  ];
  const orgCustomFields = customFields.filter(customField => customField.entity_scope === 'organization');
  const type = value?.type || 'none';
  const fieldName = value?.field || '';
  const values = Array.isArray(value?.values) ? value.values : [];
  const setFilter = (updates) => {
    if (updates.type === 'none') {
      onChange(null);
      return;
    }
    onChange({ type, field: fieldName, values, ...updates });
  };

  return (
    <div className="space-y-2 rounded border border-slate-200 bg-white p-2">
      <Label className="text-xs">Organisation result filter</Label>
      <Select value={type} onValueChange={nextType => setFilter({
        type: nextType,
        field: '',
        values: [],
      })}>
        <SelectTrigger className="h-8 text-xs" data-testid={`select-conditional-org-filter-type-${ruleId}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No organisation filter</SelectItem>
          <SelectItem value="core">Core organisation field</SelectItem>
          <SelectItem value="custom">Custom organisation field</SelectItem>
        </SelectContent>
      </Select>
      {type !== 'none' && (
        <>
          <Select value={fieldName} onValueChange={field => setFilter({ field, values: [] })}>
            <SelectTrigger className="h-8 text-xs" data-testid={`select-conditional-org-filter-field-${ruleId}`}>
              <SelectValue placeholder="Choose a field…" />
            </SelectTrigger>
            <SelectContent>
              {(type === 'core' ? coreFields : orgCustomFields.map(customField => [
                customField.name,
                customField.label || customField.name,
              ])).map(([field, label]) => (
                <SelectItem key={field} value={field}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldName && (
            <ConditionalOrgFilterValues
              type={type}
              fieldName={fieldName}
              values={values}
              onChange={nextValues => setFilter({ values: nextValues })}
              customFields={customFields}
              ruleId={ruleId}
            />
          )}
        </>
      )}
    </div>
  );
}

function ConditionalFilterRuleEditor({
  field,
  originalIndex,
  allFields,
  categories,
  communicationCategories,
  customFields,
  updateField,
}) {
  if (!CONDITIONAL_FILTER_TARGET_TYPES.has(field.type)) return null;

  const rules = Array.isArray(field.conditional_filters?.rules) ? field.conditional_filters.rules : [];
  const sourceFields = allFields.slice(0, originalIndex).filter(source =>
    source.id && !['instructions', 'image', 'signature', 'file', 'payment', 'membership_payment'].includes(source.type)
  );
  const allowedOptions = getConditionalFieldOptions(field, categories, communicationCategories, customFields);
  const persistRules = (nextRules) => updateField(originalIndex, {
    conditional_filters: { version: 1, rules: nextRules.map(rule => ({
      id: rule.id,
      source_field_id: rule.source_field_id || '',
      source_field_type: rule.source_field_type || null,
      operator: rule.operator || 'equals',
      value: rule.value ?? '',
      is_fallback: rule.is_fallback === true,
      allowed_values: Array.isArray(rule.allowed_values) ? rule.allowed_values : [],
      org_filter: rule.org_filter || null,
    })) },
  });
  const addRule = (isFallback = false) => persistRules([...rules, {
    id: `conditional_filter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source_field_id: '',
    operator: 'equals',
    value: '',
    is_fallback: isFallback,
    allowed_values: [],
    org_filter: null,
  }]);
  const updateRule = (index, updates) => persistRules(rules.map((rule, ruleIndex) =>
    ruleIndex === index ? { ...rule, ...updates } : rule
  ));
  const moveRule = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    persistRules(next);
  };

  return (
    <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-3" data-testid={`conditional-filter-editor-${field.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Label className="text-sm font-medium">Conditional option filters</Label>
          <p className="mt-1 text-xs text-slate-500">
            Rules run top to bottom. The first match wins; otherwise the first fallback is used. With rules but no match or fallback, no options are shown.
          </p>
        </div>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => addRule(false)} disabled={sourceFields.length === 0}>
            <Plus className="mr-1 h-3 w-3" /> Rule
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => addRule(true)}>
            <Plus className="mr-1 h-3 w-3" /> Fallback
          </Button>
        </div>
      </div>
      {sourceFields.length === 0 && rules.length === 0 && (
        <p className="text-xs text-amber-700">Add an answer field earlier in the form to create a matching rule. You can still add a fallback.</p>
      )}
      {rules.map((rule, ruleIndex) => {
        const source = sourceFields.find(sourceField => sourceField.id === rule.source_field_id);
        const operatorGroup = getConditionalOperatorGroup(source);
        const numericSource = ['number', 'percentage', 'currency', 'score'].includes(source?.type);
        const operators = CONDITIONAL_FILTER_OPERATORS[operatorGroup];
        const sourceOptions = getConditionalFieldOptions(source, categories, communicationCategories, customFields);
        const hasValue = !['is_empty', 'is_not_empty'].includes(rule.operator);
        const multiValue = ['in', 'not_in'].includes(rule.operator);
        return (
          <div key={rule.id} className="space-y-3 rounded-md border border-slate-200 bg-white p-3" data-testid={`conditional-filter-rule-${field.id}-${ruleIndex}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={rule.is_fallback ? 'secondary' : 'outline'}>
                  {rule.is_fallback ? 'Fallback' : `Rule ${ruleIndex + 1}`}
                </Badge>
                <div className="flex">
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={ruleIndex === 0} onClick={() => moveRule(ruleIndex, -1)} aria-label="Move rule up">
                    <ChevronUp className="h-3 w-3" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={ruleIndex === rules.length - 1} onClick={() => moveRule(ruleIndex, 1)} aria-label="Move rule down">
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => persistRules(rules.filter((_, index) => index !== ruleIndex))} aria-label="Remove rule">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id={`conditional-fallback-${rule.id}`}
                checked={rule.is_fallback === true}
                onCheckedChange={checked => updateRule(ruleIndex, { is_fallback: checked === true })}
              />
              <Label htmlFor={`conditional-fallback-${rule.id}`} className="text-xs">Use as fallback (does not evaluate a source value)</Label>
            </div>

            {!rule.is_fallback && (
              <div className="grid gap-2 md:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs">Earlier source field</Label>
                  <Select value={rule.source_field_id || ''} onValueChange={source_field_id => {
                    const selectedSource = sourceFields.find(item => item.id === source_field_id);
                    const selectedCustomField = selectedSource?.type === 'custom_field'
                      ? customFields.find(item => item.id === selectedSource.custom_field_id)
                      : null;
                    updateRule(ruleIndex, {
                      source_field_id,
                      source_field_type: selectedCustomField?.field_type || selectedSource?.type || null,
                      operator: 'equals',
                      value: '',
                    });
                  }}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose source…" /></SelectTrigger>
                    <SelectContent>
                      {sourceFields.map(sourceField => (
                        <SelectItem key={sourceField.id} value={sourceField.id}>{sourceField.label || 'Untitled field'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Operator</Label>
                  <Select value={rule.operator || 'equals'} onValueChange={operator => updateRule(ruleIndex, {
                    operator,
                    value: ['is_empty', 'is_not_empty'].includes(operator) ? null : '',
                  })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {operators.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {hasValue && (
                  <div className="space-y-1">
                    <Label className="text-xs">Value</Label>
                    {source?.type === 'boolean' ? (
                      <Select value={String(rule.value)} onValueChange={value => updateRule(ruleIndex, { value: value === 'true' })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose value…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Yes</SelectItem>
                          <SelectItem value="false">No</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : sourceOptions.length > 0 && multiValue ? (
                      <PolicyMultiSelect
                        options={sourceOptions}
                        value={Array.isArray(rule.value) ? rule.value : []}
                        onChange={value => updateRule(ruleIndex, { value })}
                        placeholder="Choose values…"
                        testId={`select-conditional-source-values-${rule.id}`}
                      />
                    ) : sourceOptions.length > 0 ? (
                      <Select value={rule.value === '' ? undefined : String(rule.value)} onValueChange={value => {
                        const option = sourceOptions.find(item => String(item.value) === value);
                        updateRule(ruleIndex, { value: option?.value ?? value });
                      }}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose value…" /></SelectTrigger>
                        <SelectContent>
                          {sourceOptions.map(option => <SelectItem key={String(option.value)} value={String(option.value)}>{option.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        type={!multiValue && numericSource
                          ? 'number'
                          : !multiValue && source?.type === 'date'
                            ? 'date'
                            : !multiValue && source?.type === 'time'
                              ? 'time'
                              : 'text'}
                        className="h-8 text-xs"
                        value={Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value ?? '')}
                        onChange={event => updateRule(ruleIndex, {
                          value: multiValue
                            ? event.target.value.split(',').map(item => item.trim()).filter(Boolean)
                            : numericSource && event.target.value !== ''
                              ? Number(event.target.value)
                              : event.target.value,
                        })}
                        placeholder={multiValue ? 'Values, separated by commas' : 'Comparison value'}
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {allowedOptions.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Allowed target values</Label>
                <PolicyMultiSelect
                  options={allowedOptions}
                  value={rule.allowed_values || []}
                  onChange={allowed_values => updateRule(ruleIndex, { allowed_values })}
                  placeholder="No additional restriction"
                  testId={`select-conditional-allowed-values-${rule.id}`}
                />
                <p className="text-xs text-slate-500">These values are intersected with the field's existing choices.</p>
              </div>
            )}

            {field.type === 'organisation_dropdown' && (
              <ConditionalOrgFilterEditor
                value={rule.org_filter}
                onChange={org_filter => updateRule(ruleIndex, { org_filter })}
                customFields={customFields}
                ruleId={rule.id}
              />
            )}
          </div>
        );
      })}
      {rules.length > 0 && (
        <Button type="button" variant="ghost" size="sm" className="text-slate-500" onClick={() => updateField(originalIndex, { conditional_filters: undefined })}>
          <X className="mr-1 h-3 w-3" /> Remove conditional filtering
        </Button>
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
  communicationCategories = [],
  customFields = [],
  applicationLevel = "member",
  uniquenessChecks = [],
  onUniquenessChange,
  prefillSource = "none",
  isDrawerOpen = false,
  onOpenDrawer,
  onCloseDrawer,
  contractForms = [],
  allFields = [],
  formType = 'standard',
  scoringLocked = false,
  formId = null
}) {
  const isEmailType = field.type === 'email' || field.type === 'user_email';
  const isSurveyForm = formType === 'survey';
  const isUrlType = field.type === 'url';
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportText, setBulkImportText] = useState('');
  const uniquenessCheck = uniquenessChecks.find(u => u.field_id === field.id);
  const isUniquenessEnabled = !!uniquenessCheck;
  const targetField = uniquenessCheck?.target_field || '';
  const comparisonMode = uniquenessCheck?.comparison_mode || 'equals_lowercase';
  const relationshipParents = getEligibleRelationshipParents(allFields, field.id);
  const {
    data: relationshipDiscovery,
    isLoading: relationshipsLoading,
    isError: relationshipsError,
  } = useQuery({
    queryKey: ['eligible-form-relationships'],
    queryFn: () => publicClient.listEligibleFormRelationships(formId),
    enabled: field.type === 'relationship_dropdown' && !!formId,
    staleTime: 5 * 60 * 1000,
  });
  const eligibleRelationships = normalizeEligibleRelationships(relationshipDiscovery);

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
        // URL fields default to URL match against website_url
        defaultTarget = applicationLevel === 'organization' ? 'organization.website_url' : 'member.email';
        defaultComparison = applicationLevel === 'organization' ? 'url_equals' : 'domain_equals';
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

  const fieldTypeLabel = FIELD_TYPES.find(t => t.value === field.type)?.label || field.type;

  return (
    <Draggable draggableId={field.id} index={index}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className="bg-white rounded-lg px-3 py-2 border border-slate-200 shadow-sm"
        >
          {/* Collapsed row - always visible */}
          <div className="flex items-center gap-2">
            <div {...provided.dragHandleProps} className="cursor-move flex-shrink-0">
              <GripVertical className="w-4 h-4 text-slate-400" />
            </div>
            <div className="flex-1 min-w-0 flex items-center gap-2">
              {field.type === 'image' && field.image_url ? (
                <img src={field.image_url} alt={field.image_alt || ''} className="w-8 h-8 object-cover rounded flex-shrink-0" />
              ) : field.type === 'image' ? (
                <ImageIcon className="w-4 h-4 text-slate-400 flex-shrink-0" />
              ) : field.type === 'image_buttons' ? (
                <ImageIcon className="w-4 h-4 text-blue-400 flex-shrink-0" />
              ) : null}
              <span className="text-sm font-medium text-slate-700 truncate">
                {field.label || 'Untitled Field'}
              </span>
              <Badge variant="outline" className="text-xs flex-shrink-0">
                {fieldTypeLabel}
              </Badge>
              {field.required && (
                <Badge variant="secondary" className="text-xs flex-shrink-0">
                  Required
                </Badge>
              )}
              {field.starts_hidden && (
                <EyeOff className="w-3 h-3 text-slate-400 flex-shrink-0" />
              )}
              {field.locked && (
                <Lock className="w-3 h-3 text-slate-400 flex-shrink-0" />
              )}
              {field.due_diligence && (
                <Badge variant="outline" className="text-xs flex-shrink-0 border-warning/30 text-warning bg-warning/10">
                  DD
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenDrawer}
              className="h-8 w-8 text-slate-500 hover:text-slate-700"
              data-testid={`button-configure-field-${field.id}`}
            >
              <Settings2 className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeField(originalIndex)}
              className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
              data-testid={`button-delete-field-${field.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>

          {/* Field Configuration Drawer */}
          <Sheet open={isDrawerOpen} onOpenChange={(open) => { if (!open) onCloseDrawer?.(); }}>
            <SheetContent side="right" className="w-[70vw] sm:max-w-[70vw] overflow-y-auto">
              <SheetHeader className="mb-6">
                <SheetTitle className="flex items-center gap-2">
                  <Settings2 className="w-5 h-5" />
                  Configure Field
                </SheetTitle>
                <SheetDescription>
                  {field.label || 'Untitled Field'} - {fieldTypeLabel}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4">
                {/* Field Type Selection */}
                <div className={`grid ${isSurveyForm ? 'grid-cols-5' : 'grid-cols-4'} gap-3`}>
                  {isSurveyForm && (
                    <div className="space-y-1">
                      <Label className="text-xs">Survey Fields</Label>
                      <Select
                        value={getFieldTypeCategory(field.type) === 'survey' ? field.type : ''}
                        onValueChange={(value) => {
                          if (value === 'score' && field.type !== 'score') {
                            updateField(originalIndex, {
                              type: 'score',
                              score_style: 'stars',
                              score_min: 1,
                              score_max: 5,
                              weight: 1,
                              include_in_overall: true,
                              reverse_scoring: false,
                              allow_na: false
                            });
                          } else if (value) {
                            updateField(originalIndex, { type: value });
                          }
                        }}
                        disabled={scoringLocked}
                      >
                        <SelectTrigger className="h-9" data-testid={`select-survey-type-${field.id}`}>
                          <SelectValue placeholder="Select..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-60 overflow-y-auto">
                          {SURVEY_FIELD_TYPES.map(type => (
                            <SelectItem key={type.value} value={type.value}>
                              {type.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Standard Fields</Label>
                    <Select
                      value={getFieldTypeCategory(field.type) === 'standard' ? field.type : ''}
                      onValueChange={(value) => {
                        if (value) {
                          const updates = { type: value };
                          if (value === 'image_buttons' && (!field.image_options || field.image_options.length < 2)) {
                            updates.image_options = [
                              { image_url: null, label: '', value: 'option_1' },
                              { image_url: null, label: '', value: 'option_2' }
                            ];
                            updates.auto_advance = true;
                            updates.hide_next_button = false;
                          }
                          updateField(originalIndex, updates);
                        }
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
                <div className="space-y-1">
                  <Label className="text-xs">Payment Fields</Label>
                  <Select
                    value={getFieldTypeCategory(field.type) === 'payment' ? field.type : ''}
                    onValueChange={(value) => {
                      if (value) updateField(originalIndex, { type: value });
                    }}
                  >
                    <SelectTrigger className="h-9" data-testid={`select-payment-type-${field.id}`}>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60 overflow-y-auto">
                      {PAYMENT_FIELD_TYPES.map(type => (
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

              {supportsFormNotListedChoice(field) && (
                <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid={`not-listed-config-${field.id}`}>
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`not-listed-enabled-${field.id}`}
                      checked={field.not_listed_choice?.enabled === true}
                      onCheckedChange={(enabled) => updateField(originalIndex, {
                        not_listed_choice: {
                          ...(field.not_listed_choice || {}),
                          enabled,
                          label: field.not_listed_choice?.label || 'Not listed',
                        },
                      })}
                      data-testid={`switch-not-listed-${field.id}`}
                    />
                    <Label htmlFor={`not-listed-enabled-${field.id}`} className="text-xs font-medium">
                      Add a “not listed” choice
                    </Label>
                  </div>
                  {field.not_listed_choice?.enabled === true && (
                    <div className="space-y-1">
                      <Label htmlFor={`not-listed-label-${field.id}`} className="text-xs">Choice label</Label>
                      <Input
                        id={`not-listed-label-${field.id}`}
                        value={field.not_listed_choice?.label || ''}
                        onChange={(event) => updateField(originalIndex, {
                          not_listed_choice: {
                            ...(field.not_listed_choice || {}),
                            enabled: true,
                            label: event.target.value,
                          },
                        })}
                        placeholder="e.g. My organisation isn’t in the list"
                        className="h-9"
                        data-testid={`input-not-listed-label-${field.id}`}
                      />
                    </div>
                  )}
                </div>
              )}

              <ConditionalFilterRuleEditor
                field={field}
                originalIndex={originalIndex}
                allFields={allFields}
                categories={categories}
                communicationCategories={communicationCategories}
                customFields={customFields}
                updateField={updateField}
              />

              {/* Currency configuration (Task #3480) */}
              {field.type === 'currency' && (() => {
                const PRESET_SYMBOLS = ['£', '$', '€'];
                const currentSymbol = field.currency_symbol || '£';
                const isPreset = PRESET_SYMBOLS.includes(currentSymbol);
                return (
                  <div className="border rounded-lg p-4 space-y-3 bg-slate-50/50" data-testid={`currency-config-${field.id}`}>
                    <h4 className="text-sm font-semibold text-slate-700">Currency settings</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Currency Symbol</Label>
                        <Select
                          value={isPreset ? currentSymbol : '__custom__'}
                          onValueChange={(value) => {
                            if (value === '__custom__') {
                              updateField(originalIndex, { currency_symbol: isPreset ? '' : currentSymbol });
                            } else {
                              updateField(originalIndex, { currency_symbol: value });
                            }
                          }}
                        >
                          <SelectTrigger className="h-9" data-testid={`select-currency-symbol-${field.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="£">£ (Pound)</SelectItem>
                            <SelectItem value="$">$ (Dollar)</SelectItem>
                            <SelectItem value="€">€ (Euro)</SelectItem>
                            <SelectItem value="__custom__">Custom...</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {!isPreset && (
                        <div className="space-y-1">
                          <Label className="text-xs">Custom Symbol</Label>
                          <Input
                            value={field.currency_symbol || ''}
                            onChange={(e) => updateField(originalIndex, { currency_symbol: e.target.value })}
                            placeholder="e.g. CHF"
                            maxLength={5}
                            className="h-9"
                            data-testid={`input-currency-custom-symbol-${field.id}`}
                          />
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-slate-500">
                      Shown beside the input. Values accept up to 2 decimal places (e.g. 1234.56).
                    </p>
                  </div>
                );
              })()}

              {/* Score / Rating configuration (survey forms, Task #3330) */}
              {field.type === 'score' && (() => {
                const { errors: scoreErrors, warnings: scoreWarnings } = validateScoreFieldConfig(field);
                const isNps = (field.score_style || 'stars') === 'nps';
                const { min: scoreMin, max: scoreMax } = getScoreRange(field);
                const rangeCount = scoreMax - scoreMin + 1;
                const perValueEditable = rangeCount > 1 && rangeCount <= 11;
                const existingCategories = [...new Set(
                  allFields
                    .filter(f => f.type === 'score' && f.id !== field.id && f.reporting_category)
                    .map(f => f.reporting_category)
                )];
                const setLabels = (updates) => updateField(originalIndex, {
                  score_labels: { ...(field.score_labels || {}), ...updates }
                });
                return (
                  <div className="border rounded-lg p-4 space-y-4 bg-slate-50/50" data-testid={`score-config-${field.id}`}>
                    <h4 className="text-sm font-semibold text-slate-700">Score / Rating settings</h4>
                    {scoringLocked && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                        This survey already has responses — scoring settings are locked. Use "Duplicate as New Version" to make scoring changes.
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Reporting Name</Label>
                        <Input
                          value={field.reporting_name || ''}
                          onChange={(e) => updateField(originalIndex, { reporting_name: e.target.value })}
                          placeholder="Short name used in reports"
                          className="h-9"
                          data-testid={`input-reporting-name-${field.id}`}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Reporting Category</Label>
                        <Input
                          value={field.reporting_category || ''}
                          onChange={(e) => updateField(originalIndex, { reporting_category: e.target.value })}
                          placeholder="Pick existing or type new"
                          className="h-9"
                          list={`score-categories-${field.id}`}
                          data-testid={`input-reporting-category-${field.id}`}
                        />
                        <datalist id={`score-categories-${field.id}`}>
                          {existingCategories.map(cat => <option key={cat} value={cat} />)}
                        </datalist>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Rendering Style</Label>
                        <Select
                          value={field.score_style || 'stars'}
                          onValueChange={(value) => updateField(originalIndex, { score_style: value })}
                          disabled={scoringLocked}
                        >
                          <SelectTrigger className="h-9" data-testid={`select-score-style-${field.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SCORE_STYLE_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Minimum</Label>
                          <Input
                            type="number"
                            step="1"
                            value={isNps ? 0 : (field.score_min ?? 1)}
                            onChange={(e) => updateField(originalIndex, { score_min: e.target.value === '' ? '' : Number(e.target.value) })}
                            disabled={isNps || scoringLocked}
                            className="h-9"
                            data-testid={`input-score-min-${field.id}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Maximum</Label>
                          <Input
                            type="number"
                            step="1"
                            value={isNps ? 10 : (field.score_max ?? 5)}
                            onChange={(e) => updateField(originalIndex, { score_max: e.target.value === '' ? '' : Number(e.target.value) })}
                            disabled={isNps || scoringLocked}
                            className="h-9"
                            data-testid={`input-score-max-${field.id}`}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Low-end Label</Label>
                        <Input
                          value={field.score_labels?.low || ''}
                          onChange={(e) => setLabels({ low: e.target.value })}
                          placeholder="e.g. Poor"
                          className="h-9"
                          data-testid={`input-score-label-low-${field.id}`}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">High-end Label</Label>
                        <Input
                          value={field.score_labels?.high || ''}
                          onChange={(e) => setLabels({ high: e.target.value })}
                          placeholder="e.g. Excellent"
                          className="h-9"
                          data-testid={`input-score-label-high-${field.id}`}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Weighting</Label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0.1"
                          value={field.weight ?? 1}
                          onChange={(e) => updateField(originalIndex, { weight: e.target.value === '' ? '' : Number(e.target.value) })}
                          disabled={scoringLocked}
                          className="h-9"
                          data-testid={`input-score-weight-${field.id}`}
                        />
                      </div>
                      {field.allow_na === true && (
                        <div className="space-y-1">
                          <Label className="text-xs">"Not Applicable" Label</Label>
                          <Input
                            value={field.na_label || ''}
                            onChange={(e) => updateField(originalIndex, { na_label: e.target.value })}
                            placeholder="Not applicable"
                            className="h-9"
                            data-testid={`input-score-na-label-${field.id}`}
                          />
                        </div>
                      )}
                    </div>

                    {perValueEditable && ['numbers', 'descriptive', 'nps'].includes(field.score_style || 'stars') && (
                      <div className="space-y-1">
                        <Label className="text-xs">Per-value Labels (optional)</Label>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                          {Array.from({ length: rangeCount }, (_, i) => scoreMin + i).map(v => (
                            <div key={v} className="flex items-center gap-1.5">
                              <span className="text-xs text-slate-500 w-6 text-right">{v}</span>
                              <Input
                                value={field.score_labels?.values?.[String(v)] || ''}
                                onChange={(e) => setLabels({
                                  values: { ...(field.score_labels?.values || {}), [String(v)]: e.target.value }
                                })}
                                className="h-8 text-xs"
                                data-testid={`input-score-value-label-${field.id}-${v}`}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={field.include_in_overall !== false}
                          onCheckedChange={(checked) => updateField(originalIndex, { include_in_overall: checked })}
                          disabled={scoringLocked}
                          data-testid={`switch-include-overall-${field.id}`}
                        />
                        <Label className="text-xs">Include in overall score</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={field.reverse_scoring === true}
                          onCheckedChange={(checked) => updateField(originalIndex, { reverse_scoring: checked })}
                          disabled={scoringLocked}
                          data-testid={`switch-reverse-scoring-${field.id}`}
                        />
                        <Label className="text-xs">Reverse scoring</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={field.allow_na === true}
                          onCheckedChange={(checked) => updateField(originalIndex, { allow_na: checked })}
                          data-testid={`switch-allow-na-${field.id}`}
                        />
                        <Label className="text-xs">Offer "Not Applicable"</Label>
                      </div>
                    </div>

                    {scoreErrors.length > 0 && (
                      <div className="space-y-1" data-testid={`score-errors-${field.id}`}>
                        {scoreErrors.map((msg, i) => (
                          <p key={i} className="text-xs text-red-600">• {msg}</p>
                        ))}
                      </div>
                    )}
                    {scoreWarnings.length > 0 && (
                      <div className="space-y-1" data-testid={`score-warnings-${field.id}`}>
                        {scoreWarnings.map((msg, i) => (
                          <p key={i} className="text-xs text-amber-600">• {msg}</p>
                        ))}
                      </div>
                    )}

                    {scoreErrors.length === 0 && (
                      <div className="space-y-1">
                        <Label className="text-xs">Live Preview</Label>
                        <div className="bg-white border rounded-md p-3">
                          <p className="text-sm font-medium text-slate-700 mb-2">{field.label || 'Untitled question'}</p>
                          {field.description && <p className="text-xs text-slate-500 mb-2">{field.description}</p>}
                          <ScoreFieldPreview field={field} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Pre-fill Field Selection - When prefill is enabled */}
              {prefillSource !== "none" && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                  <Label className="text-xs font-medium text-blue-800">Pre-fill from {prefillSource === 'booking' ? 'Booking, Member or Organisation' : 'Member or Organisation'} data</Label>
                  <Select
                    value={field.prefill_field || "_none"}
                    onValueChange={(value) => updateField(originalIndex, { prefill_field: value === "_none" ? null : value })}
                  >
                    <SelectTrigger className="h-8 text-xs" data-testid={`select-prefill-field-${field.id}`}>
                      <SelectValue placeholder="Select field to pre-fill from..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No pre-fill</SelectItem>
                      {prefillSource === 'booking' && (
                        <>
                          <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                            Booking Fields
                          </div>
                          {BOOKING_PREFILL_FIELDS.map(f => (
                            <SelectItem key={`booking:${f.value}`} value={`booking:${f.value}`}>{f.label}</SelectItem>
                          ))}
                        </>
                      )}
                      <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                        {prefillSource === 'booking' ? 'Member Core Fields (if linked)' : 'Member Core Fields'}
                      </div>
                      {MEMBER_PREFILL_FIELDS.map(f => (
                        <SelectItem key={`member:${f.value}`} value={`member:${f.value}`}>{f.label}</SelectItem>
                      ))}
                      {customFields.filter(cf => !cf.entity_scope || cf.entity_scope === 'member').length > 0 && (
                        <>
                          <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                            {prefillSource === 'booking' ? 'Member Custom Fields (if linked)' : 'Member Custom Fields'}
                          </div>
                          {customFields.filter(cf => !cf.entity_scope || cf.entity_scope === 'member').map(cf => (
                            <SelectItem key={`member_custom:${cf.id}`} value={`member_custom:${cf.id}`}>{cf.label}</SelectItem>
                          ))}
                        </>
                      )}
                      <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                        {prefillSource === 'booking' ? 'Organisation Core Fields (if linked)' : 'Organisation Core Fields'}
                      </div>
                      {ORG_PREFILL_FIELDS.map(f => (
                        <SelectItem key={`org:${f.value}`} value={`org:${f.value}`}>{f.label}</SelectItem>
                      ))}
                      {customFields.filter(cf => cf.entity_scope === 'organization').length > 0 && (
                        <>
                          <div className="px-2 py-1 text-xs font-medium text-slate-500 bg-slate-50">
                            {prefillSource === 'booking' ? 'Organisation Custom Fields (if linked)' : 'Organisation Custom Fields'}
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
              <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg space-y-3">
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
                        <p className="text-xs text-warning">
                          Will check if submitted value already exists in {targetField.replace('.', ' → ')}
                        </p>
                      )}
                    </div>
                  )}
              </div>

              {field.type === 'boolean' && (
                <div className="space-y-3">
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
                  <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <Label className="text-xs font-medium">Flag on check-in</Label>
                        <p className="text-xs text-slate-500 mt-0.5">Warn check-in staff when an event attendee answers Yes</p>
                      </div>
                      <Switch
                        checked={field.flag_on_checkin === true}
                        onCheckedChange={(checked) => updateField(originalIndex, { flag_on_checkin: checked })}
                        data-testid={`switch-flag-on-checkin-${field.id}`}
                      />
                    </div>
                    {field.flag_on_checkin && (
                      <div className="space-y-1">
                        <Label className="text-xs font-medium">Flag label</Label>
                        <Input
                          type="text"
                          value={field.flag_label || ''}
                          onChange={(e) => updateField(originalIndex, { flag_label: e.target.value })}
                          placeholder={`e.g. Attendee has ${field.label || 'special requirements'}`}
                          className="h-8 text-xs"
                          data-testid={`input-flag-label-${field.id}`}
                        />
                        <p className="text-xs text-slate-500">Shown to check-in staff. Defaults to the field label when left blank.</p>
                      </div>
                    )}
                    {field.flag_on_checkin && (
                      <div className="space-y-1">
                        <Label className="text-xs font-medium">Flag colour</Label>
                        <Select
                          value={field.flag_color || 'default'}
                          onValueChange={(value) => updateField(originalIndex, { flag_color: value })}
                        >
                          <SelectTrigger className="h-8 text-xs" data-testid={`select-flag-color-${field.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FLAG_COLOR_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value} data-testid={`option-flag-color-${field.id}-${opt.value}`}>
                                <span className="flex items-center gap-2">
                                  <span className={`inline-block h-3 w-3 rounded-full ${getFlagColorClasses(opt.value).swatch}`} />
                                  {opt.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-slate-500">Helps check-in staff spot this flag quickly on the scanner.</p>
                      </div>
                    )}
                  </div>
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

              {field.type === 'organisation_dropdown' && (() => {
                const ORG_CORE_FIELDS = [
                  { key: 'name', label: 'Name' },
                  { key: 'slug', label: 'Slug' },
                  { key: 'description', label: 'Description' },
                  { key: 'website_url', label: 'Website URL' },
                  { key: 'email', label: 'Email' },
                  { key: 'phone', label: 'Phone' },
                  { key: 'address', label: 'Address' },
                  { key: 'city', label: 'City' },
                  { key: 'country', label: 'Country' },
                  { key: 'postcode', label: 'Postcode' },
                  { key: 'status', label: 'Status' },
                  { key: 'external_id', label: 'External ID' },
                  { key: 'is_active', label: 'Is Active' },
                  { key: 'twitter_url', label: 'Twitter URL' },
                  { key: 'linkedin_url', label: 'LinkedIn URL' },
                  { key: 'facebook_url', label: 'Facebook URL' },
                  { key: 'instagram_url', label: 'Instagram URL' },
                ];
                const orgCustomFields = customFields.filter(cf => cf.entity_scope === 'organization');

                let orgFilter = field.org_filter || null;
                if (!orgFilter && field.allowed_org_statuses?.length > 0) {
                  orgFilter = { type: 'custom', field: 'application_status', values: field.allowed_org_statuses };
                }
                const filterType = orgFilter?.type || 'none';
                const filterField = orgFilter?.field || '';
                const filterValues = orgFilter?.values || [];

                const setOrgFilter = (update) => {
                  const current = orgFilter || { type: 'none', field: '', values: [] };
                  const newFilter = { ...current, ...update };
                  if (newFilter.type === 'none') {
                    updateField(originalIndex, { org_filter: null, allowed_org_statuses: [] });
                  } else {
                    updateField(originalIndex, { org_filter: newFilter, allowed_org_statuses: [] });
                  }
                };

                const selectedCustomField = filterType === 'custom'
                  ? orgCustomFields.find(cf => cf.name === filterField)
                  : null;
                const hasPicklistOptions = selectedCustomField &&
                  (selectedCustomField.field_type === 'picklist' || selectedCustomField.field_type === 'dropdown') &&
                  selectedCustomField.options?.length > 0;
                const picklistOptions = hasPicklistOptions
                  ? selectedCustomField.options.map(opt =>
                      typeof opt === 'string' ? { value: opt, label: opt } : { value: opt.value || opt, label: opt.label || opt.value || opt }
                    )
                  : [];

                return (
                  <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <Label className="text-xs font-medium">Filter Organisations</Label>
                    <p className="text-xs text-slate-500">
                      Restrict which organisations appear in this dropdown. If set to "No filter", all organisations will appear.
                    </p>
                    <Select
                      value={filterType}
                      onValueChange={(v) => setOrgFilter({ type: v, field: '', values: [] })}
                    >
                      <SelectTrigger data-testid={`select-org-filter-type-${field.id}`}>
                        <SelectValue placeholder="Select filter type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No filter</SelectItem>
                        <SelectItem value="core">Core organisation field</SelectItem>
                        <SelectItem value="custom">Custom organisation field</SelectItem>
                      </SelectContent>
                    </Select>

                    {filterType === 'core' && (
                      <div className="space-y-2">
                        <Label className="text-xs">Select field</Label>
                        <Select
                          value={filterField}
                          onValueChange={(v) => setOrgFilter({ field: v, values: [] })}
                        >
                          <SelectTrigger data-testid={`select-org-filter-core-field-${field.id}`}>
                            <SelectValue placeholder="Choose a field..." />
                          </SelectTrigger>
                          <SelectContent>
                            {ORG_CORE_FIELDS.map(cf => (
                              <SelectItem key={cf.key} value={cf.key}>{cf.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {filterField && filterField === 'is_active' && (
                          <Select
                            value={filterValues[0] || ''}
                            onValueChange={(v) => setOrgFilter({ values: [v] })}
                          >
                            <SelectTrigger data-testid={`select-org-filter-bool-${field.id}`}>
                              <SelectValue placeholder="Select value" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="true">Yes (Active)</SelectItem>
                              <SelectItem value="false">No (Inactive)</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                        {filterField && filterField !== 'is_active' && (
                          <OrgFieldValueSelector
                            fieldType="core"
                            fieldName={filterField}
                            selectedValues={filterValues}
                            onChange={(vals) => setOrgFilter({ values: vals })}
                            fieldId={field.id}
                          />
                        )}
                      </div>
                    )}

                    {filterType === 'custom' && (
                      <div className="space-y-2">
                        <Label className="text-xs">Select custom field</Label>
                        {orgCustomFields.length === 0 ? (
                          <div className="p-2 bg-warning/10 border border-warning/30 rounded text-xs text-warning">
                            No custom fields found for organisations. Create one in Preference Settings to enable filtering.
                          </div>
                        ) : (
                          <>
                            <Select
                              value={filterField}
                              onValueChange={(v) => setOrgFilter({ field: v, values: [] })}
                            >
                              <SelectTrigger data-testid={`select-org-filter-custom-field-${field.id}`}>
                                <SelectValue placeholder="Choose a custom field..." />
                              </SelectTrigger>
                              <SelectContent>
                                {orgCustomFields.map(cf => (
                                  <SelectItem key={cf.id} value={cf.name}>{cf.label || cf.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {filterField && hasPicklistOptions && (
                              <div className="space-y-2 max-h-48 overflow-y-auto">
                                {picklistOptions.map((opt) => {
                                  const isSelected = filterValues.includes(opt.value);
                                  return (
                                    <div
                                      key={opt.value}
                                      className="flex items-center gap-2 p-2 bg-white rounded border border-slate-200 hover:bg-slate-50 transition-colors"
                                    >
                                      <Checkbox
                                        id={`org-cf-${field.id}-${opt.value}`}
                                        checked={isSelected}
                                        onCheckedChange={(checked) => {
                                          const newVals = checked
                                            ? [...filterValues, opt.value]
                                            : filterValues.filter(s => s !== opt.value);
                                          setOrgFilter({ values: newVals });
                                        }}
                                        data-testid={`checkbox-org-cf-${field.id}-${String(opt.value).toLowerCase().replace(/\s+/g, '-')}`}
                                      />
                                      <Label
                                        htmlFor={`org-cf-${field.id}-${opt.value}`}
                                        className="text-xs font-medium cursor-pointer flex-1"
                                      >
                                        {opt.label}
                                      </Label>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {filterField && !hasPicklistOptions && (
                              <OrgFieldValueSelector
                                fieldType="custom"
                                fieldName={filterField}
                                selectedValues={filterValues}
                                onChange={(vals) => setOrgFilter({ values: vals })}
                                fieldId={field.id}
                              />
                            )}
                          </>
                        )}
                      </div>
                    )}

                    <p className="text-xs text-slate-500 mt-1">
                      {filterType === 'none'
                        ? "No filter applied — all organisations will be shown"
                        : filterValues.length === 0
                          ? "Select filter values to apply the filter"
                          : `Filtering by ${filterType === 'core' ? 'core' : 'custom'} field "${filterField}": ${filterValues.join(', ')}`}
                    </p>
                  </div>
                );
              })()}

              {field.type === 'relationship_dropdown' && (
                <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid={`relationship-dropdown-config-${field.id}`}>
                  <div>
                    <Label className="text-xs font-medium">Organisation field</Label>
                    <p className="mt-1 text-xs text-slate-500">Only organisation dropdowns earlier in the form can drive this field.</p>
                    <Select
                      value={field.parent_field_id || ''}
                      onValueChange={(parent_field_id) => updateField(originalIndex, { parent_field_id })}
                    >
                      <SelectTrigger className="mt-2" data-testid={`select-relationship-parent-${field.id}`}>
                        <SelectValue placeholder="Choose an earlier organisation field…" />
                      </SelectTrigger>
                      <SelectContent>
                        {relationshipParents.map((parent) => (
                          <SelectItem key={parent.id} value={parent.id}>{parent.label || 'Organisation'}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {relationshipParents.length === 0 && (
                      <p className="mt-2 text-xs text-amber-700">Add an organisation dropdown before this field first.</p>
                    )}
                  </div>

                  <div>
                    <Label className="text-xs font-medium">Relationship</Label>
                    <Select
                      value={field.relationship_definition_id || ''}
                      disabled={!formId || relationshipsLoading || relationshipsError}
                      onValueChange={(id) => {
                        const relationship = eligibleRelationships.find((item) => item.id === id);
                        if (relationship) updateField(originalIndex, relationshipFieldConfig(relationship));
                      }}
                    >
                      <SelectTrigger className="mt-2" data-testid={`select-relationship-definition-${field.id}`}>
                        <SelectValue placeholder={relationshipsLoading ? 'Loading relationships…' : 'Choose an active relationship…'} />
                      </SelectTrigger>
                      <SelectContent>
                        {eligibleRelationships.map((relationship) => (
                          <SelectItem key={relationship.id} value={relationship.id}>
                            {relationship.label || relationship.name || relationship.related_custom_object_name || relationship.relationship_key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {relationshipsError && <p className="mt-2 text-xs text-red-600">Relationships could not be loaded. Please try again.</p>}
                    {!relationshipsLoading && !relationshipsError && eligibleRelationships.length === 0 && (
                      <p className="mt-2 text-xs text-slate-500">
                        {formId ? 'No eligible active Organisation relationships are available.' : 'Save the form before choosing a relationship.'}
                      </p>
                    )}
                  </div>
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

              {field.type === 'communication_preferences' && (
                <div className="space-y-2">
                  <Label className="text-xs">Select Categories to Include</Label>
                  {communicationCategories.length === 0 ? (
                    <div className="p-2 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
                      No communication categories defined yet.
                    </div>
                  ) : (
                    <>
                      <div className="p-2 bg-slate-50 border border-slate-200 rounded space-y-2 max-h-48 overflow-y-auto">
                        {communicationCategories.map((category) => {
                          const isSelected = (field.allowed_category_ids || []).includes(category.id);
                          return (
                            <div key={category.id} className="flex items-start gap-2">
                              <Checkbox
                                id={`commpref-${field.id}-${category.id}`}
                                checked={isSelected}
                                onCheckedChange={(checked) => {
                                  const currentIds = field.allowed_category_ids || [];
                                  const newIds = checked
                                    ? [...currentIds, category.id]
                                    : currentIds.filter(id => id !== category.id);
                                  updateField(originalIndex, { allowed_category_ids: newIds });
                                }}
                                data-testid={`checkbox-commpref-allowed-${field.id}-${category.id}`}
                              />
                              <div className="flex-1">
                                <Label
                                  htmlFor={`commpref-${field.id}-${category.id}`}
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
                        <div className="flex flex-col">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 text-slate-400"
                            disabled={optIndex === 0}
                            onClick={() => {
                              const newOptions = [...(field.options || [])];
                              const target = optIndex - 1;
                              [newOptions[optIndex], newOptions[target]] = [newOptions[target], newOptions[optIndex]];
                              updateField(originalIndex, { options: newOptions });
                            }}
                            data-testid={`button-move-up-option-${field.id}-${optIndex}`}
                          >
                            <ChevronUp className="w-3 h-3" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 text-slate-400"
                            disabled={optIndex === (field.options || []).length - 1}
                            onClick={() => {
                              const newOptions = [...(field.options || [])];
                              const target = optIndex + 1;
                              [newOptions[optIndex], newOptions[target]] = [newOptions[target], newOptions[optIndex]];
                              updateField(originalIndex, { options: newOptions });
                            }}
                            data-testid={`button-move-down-option-${field.id}-${optIndex}`}
                          >
                            <ChevronDown className="w-3 h-3" />
                          </Button>
                        </div>
                        <Input
                          value={option}
                          onChange={(e) => {
                            const newOptions = [...(field.options || [])];
                            newOptions[optIndex] = e.target.value;
                            updateField(originalIndex, { options: newOptions });
                          }}
                          className="h-7 text-sm flex-1"
                          placeholder={`Option ${optIndex + 1}`}
                          data-testid={`input-option-${field.id}-${optIndex}`}
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
                          data-testid={`button-remove-option-${field.id}-${optIndex}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs flex-1"
                      onClick={() => {
                        const newOptions = [...(field.options || []), ''];
                        updateField(originalIndex, { options: newOptions });
                      }}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Option
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs flex-1"
                      onClick={() => {
                        setBulkImportText('');
                        setBulkImportOpen(true);
                      }}
                      data-testid={`button-bulk-import-${field.id}`}
                    >
                      <Upload className="w-3 h-3 mr-1" />
                      Bulk import
                    </Button>
                  </div>
                  <Dialog open={bulkImportOpen} onOpenChange={setBulkImportOpen}>
                    <DialogContent className="sm:max-w-md">
                      <DialogHeader>
                        <DialogTitle>Bulk import options</DialogTitle>
                        <DialogDescription>
                          Paste one option per line (commas also accepted). Empty lines and duplicates of existing or repeated values will be skipped.
                        </DialogDescription>
                      </DialogHeader>
                      {(() => {
                        const existing = field.options || [];
                        const existingSet = new Set(existing.map(o => (o || '').trim()).filter(Boolean));
                        const seen = new Set();
                        const parsed = [];
                        bulkImportText
                          .split(/[\n,]/)
                          .map(s => s.trim())
                          .filter(Boolean)
                          .forEach(v => {
                            if (existingSet.has(v) || seen.has(v)) return;
                            seen.add(v);
                            parsed.push(v);
                          });
                        return (
                          <>
                            <Textarea
                              value={bulkImportText}
                              onChange={(e) => setBulkImportText(e.target.value)}
                              placeholder={'Option 1\nOption 2\nOption 3'}
                              rows={10}
                              className="font-mono text-sm"
                              data-testid={`textarea-bulk-import-${field.id}`}
                            />
                            <p className="text-xs text-muted-foreground">
                              {parsed.length} option{parsed.length === 1 ? '' : 's'} will be added.
                            </p>
                            <DialogFooter>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setBulkImportOpen(false);
                                  setBulkImportText('');
                                }}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                disabled={parsed.length === 0}
                                onClick={() => {
                                  updateField(originalIndex, { options: [...existing, ...parsed] });
                                  setBulkImportOpen(false);
                                  setBulkImportText('');
                                }}
                                data-testid={`button-bulk-import-confirm-${field.id}`}
                              >
                                Add {parsed.length} option{parsed.length === 1 ? '' : 's'}
                              </Button>
                            </DialogFooter>
                          </>
                        );
                      })()}
                    </DialogContent>
                  </Dialog>
                </div>
              )}

              {/* File Upload Field Configuration */}
              {field.type === 'file' && (
                <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <Label className="text-xs font-medium">File Upload Options</Label>
                  
                  {/* Public Access Toggle */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`public-access-${field.id}`}
                      checked={field.public_access === true}
                      onCheckedChange={(checked) => {
                        updateField(originalIndex, { public_access: checked });
                      }}
                      data-testid={`checkbox-public-access-${field.id}`}
                    />
                    <div>
                      <Label htmlFor={`public-access-${field.id}`} className="text-xs">
                        Public access
                      </Label>
                      <p className="text-xs text-slate-500">
                        Enable for files that need to be publicly accessible (e.g., logos for external websites)
                      </p>
                    </div>
                  </div>
                  
                  {/* Allowed File Types */}
                  <div className="space-y-2">
                    <Label className="text-xs">Allowed File Types</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { value: 'images', label: 'Images' },
                        { value: 'pdf', label: 'PDF' },
                        { value: 'word', label: 'Word' },
                        { value: 'excel', label: 'Excel' },
                        { value: 'powerpoint', label: 'PowerPoint' },
                        { value: 'text', label: 'Text' },
                        { value: 'zip', label: 'Archives' },
                        { value: 'video', label: 'Video' },
                        { value: 'audio', label: 'Audio' }
                      ].map((fileType) => (
                        <div key={fileType.value} className="flex items-center gap-1">
                          <Checkbox
                            id={`file-type-${field.id}-${fileType.value}`}
                            checked={(field.allowed_file_types || []).includes(fileType.value)}
                            onCheckedChange={(checked) => {
                              const current = field.allowed_file_types || [];
                              const updated = checked 
                                ? [...current, fileType.value]
                                : current.filter(t => t !== fileType.value);
                              updateField(originalIndex, { allowed_file_types: updated });
                            }}
                            data-testid={`checkbox-file-type-${field.id}-${fileType.value}`}
                          />
                          <Label htmlFor={`file-type-${field.id}-${fileType.value}`} className="text-xs">
                            {fileType.label}
                          </Label>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-slate-500">
                      {(field.allowed_file_types || []).length === 0 
                        ? 'All file types allowed' 
                        : `${(field.allowed_file_types || []).length} type(s) selected`}
                    </p>
                  </div>
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
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-slate-500">Select countries to include:</Label>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          data-testid={`toggle-all-selected-countries-${field.id}`}
                          onClick={() => {
                            const allCodes = COUNTRIES.map(c => c.code);
                            const allSelected = allCodes.every(code => (field.selected_countries || []).includes(code));
                            updateField(originalIndex, { selected_countries: allSelected ? [] : allCodes });
                          }}
                        >
                          {COUNTRIES.every(c => (field.selected_countries || []).includes(c.code)) ? 'Deselect All' : 'Select All'}
                        </button>
                      </div>
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
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-slate-500">Select countries to include:</Label>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          data-testid={`toggle-all-selected-countries-multi-${field.id}`}
                          onClick={() => {
                            const allCodes = COUNTRIES.map(c => c.code);
                            const allSelected = allCodes.every(code => (field.selected_countries || []).includes(code));
                            updateField(originalIndex, { selected_countries: allSelected ? [] : allCodes });
                          }}
                        >
                          {COUNTRIES.every(c => (field.selected_countries || []).includes(c.code)) ? 'Deselect All' : 'Select All'}
                        </button>
                      </div>
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
                    {(() => {
                      const availableDefaults = field.all_countries !== false ? COUNTRIES : COUNTRIES.filter(c => (field.selected_countries || []).includes(c.code));
                      const allDefaultsSelected = availableDefaults.length > 0 && availableDefaults.every(c => (field.default_countries || []).includes(c.code));
                      return (
                        <>
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Default Countries</Label>
                            <button
                              type="button"
                              className="text-xs text-primary hover:underline"
                              data-testid={`toggle-all-default-countries-${field.id}`}
                              onClick={() => {
                                const allCodes = availableDefaults.map(c => c.code);
                                updateField(originalIndex, { default_countries: allDefaultsSelected ? [] : allCodes });
                              }}
                            >
                              {allDefaultsSelected ? 'Deselect All' : 'Select All'}
                            </button>
                          </div>
                          <div className="max-h-32 overflow-y-auto border border-slate-200 rounded bg-white p-2 space-y-1">
                            {availableDefaults.map((country) => (
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
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}

              {field.type === 'membership_payment' && (
                <MembershipPaymentSettings
                  field={field}
                  originalIndex={originalIndex}
                  allFields={allFields}
                  updateField={updateField}
                />
              )}

              {field.type === 'payment' && (
                <PaymentFieldSettings
                  field={field}
                  originalIndex={originalIndex}
                  allFields={allFields}
                  updateField={updateField}
                />
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

              {/* Image Display - Upload and settings for display-only image */}
              {field.type === 'image' && (
                <div className="space-y-3">
                  <Label className="text-xs font-medium">Image Settings</Label>
                  <p className="text-xs text-slate-500 mb-2">Upload an image to display on the form (not editable by users)</p>
                  
                  {field.image_url ? (
                    <div className="space-y-2">
                      <div className="relative rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
                        <img 
                          src={field.image_url} 
                          alt={field.image_alt || 'Form image'} 
                          className="w-full max-h-48 object-contain"
                          data-testid={`img-preview-${field.id}`}
                        />
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateField(originalIndex, { image_url: null })}
                        data-testid={`button-remove-image-${field.id}`}
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Remove Image
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label 
                        className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-slate-400 hover:bg-slate-50 transition-colors"
                        data-testid={`label-upload-image-${field.id}`}
                      >
                        <Upload className="w-6 h-6 text-slate-400" />
                        <span className="text-sm text-slate-500">Click to upload an image</span>
                        <span className="text-xs text-slate-400">PNG, JPG, GIF, SVG, WebP</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          data-testid={`input-upload-image-${field.id}`}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            try {
                              const result = await uploadFileWithProgress(file, {
                                type: UPLOAD_TYPES.PAGE,
                                onProgress: null
                              });
                              updateField(originalIndex, { image_url: result.file_url });
                              toast.success('Image uploaded successfully');
                            } catch (err) {
                              showUploadErrorToast(err, 'Failed to upload image');
                            }
                          }}
                        />
                      </label>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Alt Text</Label>
                    <Input
                      value={field.image_alt || ''}
                      onChange={(e) => updateField(originalIndex, { image_alt: e.target.value })}
                      placeholder="Describe the image for accessibility..."
                      data-testid={`input-image-alt-${field.id}`}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Image Fit</Label>
                    <Select
                      value={field.image_fit || 'cover'}
                      onValueChange={(value) => updateField(originalIndex, { image_fit: value })}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-image-fit-${field.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cover">Cover (fill area, crop if needed)</SelectItem>
                        <SelectItem value="contain">Contain (fit entire image)</SelectItem>
                        <SelectItem value="fill">Fill (stretch to fit)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Max Height (px)</Label>
                    <Input
                      type="number"
                      value={field.image_max_height || 300}
                      onChange={(e) => updateField(originalIndex, { image_max_height: parseInt(e.target.value) || 300 })}
                      min={50}
                      max={800}
                      placeholder="300"
                      data-testid={`input-image-max-height-${field.id}`}
                    />
                  </div>
                </div>
              )}


              {/* Image Buttons Field Configuration */}
              {field.type === 'image_buttons' && (
                <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <Label className="text-xs font-medium">Image Button Options</Label>
                  <p className="text-xs text-slate-500 mb-2">Configure 2-5 clickable image options. Each records a value like a radio button.</p>
                  
                  {(field.image_options || []).map((option, optIndex) => (
                    <div key={optIndex} className="space-y-2 p-3 bg-white border border-slate-200 rounded-lg">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-slate-600">Option {optIndex + 1}</span>
                        {(field.image_options || []).length > 2 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              const newOptions = [...(field.image_options || [])];
                              newOptions.splice(optIndex, 1);
                              updateField(originalIndex, { image_options: newOptions });
                            }}
                            data-testid={`button-remove-image-option-${field.id}-${optIndex}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>

                      {option.image_url ? (
                        <div className="space-y-2">
                          <div className="relative rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
                            <img 
                              src={option.image_url} 
                              alt={option.label || `Option ${optIndex + 1}`} 
                              className="w-full max-h-32 object-contain"
                              data-testid={`img-option-preview-${field.id}-${optIndex}`}
                            />
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const newOptions = [...(field.image_options || [])];
                              newOptions[optIndex] = { ...newOptions[optIndex], image_url: null };
                              updateField(originalIndex, { image_options: newOptions });
                            }}
                            data-testid={`button-remove-option-image-${field.id}-${optIndex}`}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Remove Image
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <label 
                            className="flex flex-col items-center justify-center gap-1 p-4 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-slate-400 hover:bg-slate-50 transition-colors"
                            data-testid={`label-upload-option-image-${field.id}-${optIndex}`}
                          >
                            <Upload className="w-5 h-5 text-slate-400" />
                            <span className="text-xs text-slate-500">Upload image</span>
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              data-testid={`input-upload-option-image-${field.id}-${optIndex}`}
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                try {
                                  const result = await uploadFileWithProgress(file, {
                                    type: UPLOAD_TYPES.PAGE,
                                    onProgress: null
                                  });
                                  const newOptions = [...(field.image_options || [])];
                                  newOptions[optIndex] = { ...newOptions[optIndex], image_url: result.file_url };
                                  updateField(originalIndex, { image_options: newOptions });
                                  toast.success('Image uploaded successfully');
                                } catch (err) {
                                  showUploadErrorToast(err, 'Failed to upload image');
                                }
                              }}
                            />
                          </label>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400">or</span>
                            <Input
                              placeholder="Paste image URL and press Enter..."
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  const url = e.target.value.trim();
                                  if (url) {
                                    const newOptions = [...(field.image_options || [])];
                                    newOptions[optIndex] = { ...newOptions[optIndex], image_url: url };
                                    updateField(originalIndex, { image_options: newOptions });
                                  }
                                }
                              }}
                              onBlur={(e) => {
                                const url = e.target.value.trim();
                                if (url) {
                                  const newOptions = [...(field.image_options || [])];
                                  newOptions[optIndex] = { ...newOptions[optIndex], image_url: url };
                                  updateField(originalIndex, { image_options: newOptions });
                                }
                              }}
                              data-testid={`input-option-image-url-${field.id}-${optIndex}`}
                            />
                          </div>
                        </div>
                      )}

                      <div className="space-y-1">
                        <Label className="text-xs">Label (caption)</Label>
                        <Input
                          value={option.label || ''}
                          onChange={(e) => {
                            const newOptions = [...(field.image_options || [])];
                            newOptions[optIndex] = { ...newOptions[optIndex], label: e.target.value };
                            updateField(originalIndex, { image_options: newOptions });
                          }}
                          placeholder="Optional caption..."
                          data-testid={`input-option-label-${field.id}-${optIndex}`}
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">Value (for logic)</Label>
                        <Input
                          value={option.value || ''}
                          onChange={(e) => {
                            const newOptions = [...(field.image_options || [])];
                            newOptions[optIndex] = { ...newOptions[optIndex], value: e.target.value };
                            updateField(originalIndex, { image_options: newOptions });
                          }}
                          placeholder="Value recorded on selection..."
                          data-testid={`input-option-value-${field.id}-${optIndex}`}
                        />
                      </div>
                    </div>
                  ))}

                  {(field.image_options || []).length < 5 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const current = field.image_options || [];
                        if (current.length >= 5) return;
                        const newOptions = [...current, { image_url: null, label: '', value: `option_${current.length + 1}` }];
                        updateField(originalIndex, { image_options: newOptions });
                      }}
                      data-testid={`button-add-image-option-${field.id}`}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Option
                    </Button>
                  )}

                  {(!field.image_options || field.image_options.length < 2) && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const defaultOptions = [
                            { image_url: null, label: '', value: 'option_1' },
                            { image_url: null, label: '', value: 'option_2' }
                          ];
                          updateField(originalIndex, { image_options: defaultOptions });
                        }}
                        data-testid={`button-init-image-options-${field.id}`}
                      >
                        <Plus className="w-3 h-3 mr-1" />
                        Initialize Options (min 2)
                      </Button>
                    </div>
                  )}

                  <div className="space-y-2 pt-2 border-t border-slate-200">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <Label className="text-xs font-medium">Auto-advance on click</Label>
                        <p className="text-xs text-slate-500">Automatically go to the next page when an image is clicked</p>
                      </div>
                      <Switch
                        checked={field.auto_advance !== false}
                        onCheckedChange={(checked) => updateField(originalIndex, { auto_advance: checked })}
                        data-testid={`switch-auto-advance-${field.id}`}
                      />
                    </div>

                    {field.auto_advance !== false && (
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <Label className="text-xs font-medium">Hide Next button</Label>
                          <p className="text-xs text-slate-500">Hide the Next button when auto-advance is enabled</p>
                        </div>
                        <Switch
                          checked={field.hide_next_button === true}
                          onCheckedChange={(checked) => updateField(originalIndex, { hide_next_button: checked })}
                          data-testid={`switch-hide-next-${field.id}`}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Contact Field - Contract Template Selection */}
              {field.type === 'contact' && (
                <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-blue-600" />
                    <Label className="text-xs font-medium">Sub-Field Configuration</Label>
                  </div>
                  <p className="text-xs text-slate-500">
                    Choose which sub-fields are visible and which are required
                  </p>
                  <div className="space-y-2">
                    {[
                      { key: 'firstName', label: 'First name', defaultVisible: true, defaultRequired: true },
                      { key: 'lastName', label: 'Last name', defaultVisible: true, defaultRequired: true },
                      { key: 'jobTitle', label: 'Job title', defaultVisible: true, defaultRequired: false },
                      { key: 'organisation', label: 'Organisation', defaultVisible: true, defaultRequired: false },
                      { key: 'email', label: 'Email', defaultVisible: true, defaultRequired: true },
                    ].map((sf) => {
                      const subConfig = field.contact_sub_fields?.[sf.key] || { visible: sf.defaultVisible, required: sf.defaultRequired };
                      const isVisible = subConfig.visible !== false;
                      const isRequired = subConfig.required === true;
                      return (
                        <div key={sf.key} className="flex items-center justify-between gap-2 py-1.5 px-2 bg-white border border-slate-100 rounded-md" data-testid={`contact-subfield-config-${sf.key}-${field.id}`}>
                          <span className="text-xs font-medium text-slate-700 min-w-[80px]">{sf.label}</span>
                          <div className="flex items-center gap-4">
                            <div className="flex items-center gap-1.5">
                              <Eye className="w-3 h-3 text-slate-400" />
                              <Label className="text-xs text-slate-500">Visible</Label>
                              <Switch
                                checked={isVisible}
                                onCheckedChange={(checked) => {
                                  const current = field.contact_sub_fields || {
                                    firstName: { visible: true, required: true },
                                    lastName: { visible: true, required: true },
                                    jobTitle: { visible: true, required: false },
                                    organisation: { visible: true, required: false },
                                    email: { visible: true, required: true },
                                  };
                                  updateField(originalIndex, {
                                    contact_sub_fields: {
                                      ...current,
                                      [sf.key]: { ...current[sf.key], visible: checked }
                                    }
                                  });
                                }}
                                data-testid={`switch-contact-visible-${sf.key}-${field.id}`}
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Lock className="w-3 h-3 text-slate-400" />
                              <Label className="text-xs text-slate-500">Required</Label>
                              <Switch
                                checked={isRequired}
                                disabled={!isVisible}
                                onCheckedChange={(checked) => {
                                  const current = field.contact_sub_fields || {
                                    firstName: { visible: true, required: true },
                                    lastName: { visible: true, required: true },
                                    jobTitle: { visible: true, required: false },
                                    organisation: { visible: true, required: false },
                                    email: { visible: true, required: true },
                                  };
                                  updateField(originalIndex, {
                                    contact_sub_fields: {
                                      ...current,
                                      [sf.key]: { ...current[sf.key], required: checked }
                                    }
                                  });
                                }}
                                data-testid={`switch-contact-required-${sf.key}-${field.id}`}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {field.type === 'contact' && (
                <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="flex items-center gap-2">
                    <FileSignature className="w-4 h-4 text-blue-600" />
                    <Label className="text-xs font-medium">Contract Template (Optional)</Label>
                  </div>
                  <p className="text-xs text-slate-500">
                    Select a contract to send to this contact after form submission
                  </p>
                  <Select
                    value={field.contract_form_id || '__none__'}
                    onValueChange={(value) => updateField(originalIndex, { 
                      contract_form_id: value === '__none__' ? null : value 
                    })}
                  >
                    <SelectTrigger className="text-xs" data-testid={`select-contract-template-${field.id}`}>
                      <SelectValue placeholder="No contract template" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" data-testid={`option-contract-none-${field.id}`}>No contract template</SelectItem>
                      {contractForms.map((form) => (
                        <SelectItem key={form.id} value={form.id} data-testid={`option-contract-${form.id}`}>
                          <div className="flex items-center gap-2">
                            <FileSignature className="w-3 h-3 text-blue-500" />
                            <span>{form.name}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {field.contract_form_id && (
                    <div className="flex items-start gap-2 p-2 bg-blue-50 border border-blue-200 rounded-md">
                      <div className="text-blue-600 mt-0.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-blue-800">Contract will be sent to contact</p>
                        <p className="text-xs text-blue-600 mt-0.5">
                          When the form is submitted, the selected contract can be sent to the contact details (name and email) captured in this field.
                        </p>
                      </div>
                    </div>
                  )}
                  {contractForms.length === 0 && (
                    <p className="text-xs text-warning">
                      No contract templates available. Create a form with "Contract Mode" enabled to use this feature.
                    </p>
                  )}
                </div>
              )}

              {/* Grouped Question Field - Sub-Question Configuration */}
              {field.type === 'grouped_question' && (() => {
                const subQuestions = Array.isArray(field.sub_questions) ? field.sub_questions : [];
                const rawMin = Number(field.min_completed);
                const minRequired = Number.isFinite(rawMin)
                  ? Math.max(0, Math.min(rawMin, subQuestions.length))
                  : subQuestions.length;
                const rawMax = Number(field.max_completed);
                const maxAllowed = Number.isFinite(rawMax)
                  ? Math.max(minRequired, Math.min(rawMax, subQuestions.length))
                  : subQuestions.length;

                const updateSubQuestions = (nextSubs) => {
                  const boundedMin = Math.max(0, Math.min(minRequired, nextSubs.length));
                  const boundedMax = Math.max(boundedMin, Math.min(maxAllowed, nextSubs.length));
                  updateField(originalIndex, {
                    sub_questions: nextSubs,
                    min_completed: boundedMin,
                    max_completed: boundedMax,
                  });
                };

                const addSubQuestion = () => {
                  const newSub = {
                    id: `sq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    label: '',
                  };
                  updateSubQuestions([...subQuestions, newSub]);
                };

                const removeSubQuestion = (index) => {
                  updateSubQuestions(subQuestions.filter((_, i) => i !== index));
                };

                const updateSubQuestionLabel = (index, label) => {
                  const next = subQuestions.map((sq, i) => i === index ? { ...sq, label } : sq);
                  updateField(originalIndex, { sub_questions: next });
                };

                const moveSubQuestion = (index, direction) => {
                  const target = index + direction;
                  if (target < 0 || target >= subQuestions.length) return;
                  const next = [...subQuestions];
                  [next[index], next[target]] = [next[target], next[index]];
                  updateField(originalIndex, { sub_questions: next });
                };

                return (
                  <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-blue-600" />
                      <Label className="text-xs font-medium">Sub-Questions</Label>
                    </div>
                    <p className="text-xs text-slate-500">
                      Each sub-question renders as a multi-line text input. Set how many must be answered for this field to be complete.
                    </p>
                    <div className="space-y-2">
                      {subQuestions.length === 0 && (
                        <p className="text-xs text-slate-400 italic">No sub-questions yet. Add one to get started.</p>
                      )}
                      {subQuestions.map((sq, index) => (
                        <div
                          key={sq.id}
                          className="flex items-center gap-2 py-1.5 px-2 bg-white border border-slate-100 rounded-md"
                          data-testid={`grouped-subquestion-config-${field.id}-${index}`}
                        >
                          <div className="flex flex-col">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 text-slate-400"
                              disabled={index === 0}
                              onClick={() => moveSubQuestion(index, -1)}
                              data-testid={`button-move-up-subquestion-${field.id}-${index}`}
                            >
                              <ChevronUp className="w-3 h-3" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 text-slate-400"
                              disabled={index === subQuestions.length - 1}
                              onClick={() => moveSubQuestion(index, 1)}
                              data-testid={`button-move-down-subquestion-${field.id}-${index}`}
                            >
                              <ChevronDown className="w-3 h-3" />
                            </Button>
                          </div>
                          <Input
                            value={sq.label || ''}
                            onChange={(e) => updateSubQuestionLabel(index, e.target.value)}
                            placeholder={`Sub-question ${index + 1} label`}
                            className="h-8 text-xs flex-1"
                            data-testid={`input-subquestion-label-${field.id}-${index}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => removeSubQuestion(index)}
                            data-testid={`button-delete-subquestion-${field.id}-${index}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addSubQuestion}
                      className="text-xs"
                      data-testid={`button-add-subquestion-${field.id}`}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Sub-Question
                    </Button>
                    <div className="pt-3 border-t border-slate-200 space-y-1.5">
                      <Label className="text-xs font-medium">Minimum answers required</Label>
                      <p className="text-xs text-slate-500">
                        How many sub-questions must be answered for this field to count as complete.
                      </p>
                      <Input
                        type="number"
                        min={0}
                        max={subQuestions.length}
                        value={minRequired}
                        onChange={(e) => {
                          const parsed = parseInt(e.target.value, 10);
                          const safe = Number.isFinite(parsed) ? parsed : 0;
                          const bounded = Math.max(0, Math.min(safe, subQuestions.length));
                          const nextMax = Math.max(bounded, maxAllowed);
                          updateField(originalIndex, { min_completed: bounded, max_completed: nextMax });
                        }}
                        className="h-8 text-xs w-24"
                        disabled={subQuestions.length === 0}
                        data-testid={`input-min-completed-${field.id}`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Maximum answers allowed</Label>
                      <p className="text-xs text-slate-500">
                        Once this many sub-questions are answered, the remaining ones are disabled.
                      </p>
                      <Input
                        type="number"
                        min={minRequired}
                        max={subQuestions.length}
                        value={maxAllowed}
                        onChange={(e) => {
                          const parsed = parseInt(e.target.value, 10);
                          const safe = Number.isFinite(parsed) ? parsed : subQuestions.length;
                          const bounded = Math.max(0, Math.min(safe, subQuestions.length));
                          const nextMin = Math.min(minRequired, bounded);
                          updateField(originalIndex, { max_completed: bounded, min_completed: nextMin });
                        }}
                        className="h-8 text-xs w-24"
                        disabled={subQuestions.length === 0}
                        data-testid={`input-max-completed-${field.id}`}
                      />
                      {subQuestions.length > 0 && (
                        <p className="text-xs text-slate-400">
                          {minRequired === 0 && maxAllowed >= subQuestions.length
                            ? 'No answers required (optional).'
                            : minRequired === maxAllowed
                              ? `Answer exactly ${minRequired} of ${subQuestions.length}`
                              : maxAllowed >= subQuestions.length
                                ? `Answer at least ${minRequired} of ${subQuestions.length}`
                                : `Answer between ${minRequired} and ${maxAllowed} of ${subQuestions.length}`}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Default Value Section - for non-boolean fields */}
              {!['boolean', 'terms_conditions', 'file', 'list', 'instructions', 'image', 'country', 'countries', 'user_name', 'user_email', 'user_organization', 'user_job_title', 'organisation_dropdown', 'category_multiselect', 'category_dropdown', 'communication_preferences', 'contact', 'grouped_question', 'signature'].includes(field.type) && (
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
                  
                  {field.type === 'textarea' && (
                    <div className="pt-3 border-t border-slate-200 mt-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Label className="text-xs font-medium text-slate-700">
                          Maximum {(field.limit_type === 'words') ? 'Words' : 'Characters'} (Optional)
                        </Label>
                        <div className="flex rounded-md border border-slate-200 overflow-visible text-xs ml-auto">
                          <button
                            type="button"
                            className={`px-2 py-0.5 ${(!field.limit_type || field.limit_type === 'characters') ? 'bg-slate-800 text-white' : 'bg-white text-slate-600'}`}
                            onClick={() => updateField(originalIndex, { limit_type: 'characters' })}
                            data-testid={`btn-limit-chars-${field.id}`}
                          >
                            Characters
                          </button>
                          <button
                            type="button"
                            className={`px-2 py-0.5 ${field.limit_type === 'words' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600'}`}
                            onClick={() => updateField(originalIndex, { limit_type: 'words' })}
                            data-testid={`btn-limit-words-${field.id}`}
                          >
                            Words
                          </button>
                        </div>
                      </div>
                      <Input
                        type="number"
                        min="1"
                        value={field.max_characters ?? ''}
                        onChange={(e) => updateField(originalIndex, { 
                          max_characters: e.target.value ? parseInt(e.target.value, 10) : null 
                        })}
                        placeholder="No limit"
                        className="h-8 text-xs"
                        data-testid={`input-max-characters-${field.id}`}
                      />
                      <p className="text-xs text-slate-500 mt-1">Leave blank for no limit</p>
                    </div>
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
                  
                  {/* Currency field - decimal default, sanitized to 2 dp */}
                  {field.type === 'currency' && (
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={field.default_value ?? ''}
                      onChange={(e) => {
                        let val = e.target.value.replace(/[^0-9.]/g, '');
                        const parts = val.split('.');
                        if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
                        const [intPart, decPart] = val.split('.');
                        if (decPart !== undefined) val = intPart + '.' + decPart.slice(0, 2);
                        updateField(originalIndex, { default_value: val });
                      }}
                      placeholder="Enter default amount..."
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
                        <p className="text-xs text-warning">Add options above first to set a default value</p>
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
                        <p className="text-xs text-warning">Add options above first to set default values</p>
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

              {/* Field Settings Section */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
                  <Label className="text-sm font-medium">Field Settings</Label>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`required-${field.id}`}
                        checked={field.required}
                        onCheckedChange={(checked) => updateField(originalIndex, { required: checked })}
                      />
                      <Label htmlFor={`required-${field.id}`} className="text-sm">Required</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`locked-${field.id}`}
                        checked={field.locked || false}
                        onCheckedChange={(checked) => updateField(originalIndex, { locked: checked })}
                      />
                      <Label htmlFor={`locked-${field.id}`} className="text-sm">Locked</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`starts-hidden-${field.id}`}
                        checked={field.starts_hidden || false}
                        onCheckedChange={(checked) => updateField(originalIndex, { starts_hidden: checked })}
                      />
                      <Label htmlFor={`starts-hidden-${field.id}`} className="text-sm">Hidden on load</Label>
                    </div>
                    {field.type === 'select' && (
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`allow-other-${field.id}`}
                          checked={field.allow_other || false}
                          onCheckedChange={(checked) => updateField(originalIndex, { allow_other: checked })}
                        />
                        <Label htmlFor={`allow-other-${field.id}`} className="text-sm">Allow "Other"</Label>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`due-diligence-${field.id}`}
                        checked={field.due_diligence || false}
                        onCheckedChange={(checked) => updateField(originalIndex, { due_diligence: checked })}
                      />
                      <Label htmlFor={`due-diligence-${field.id}`} className="text-sm">Due Diligence</Label>
                    </div>
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      )}
    </Draggable>
  );
}

export default function FormBuilderPage() {
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
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
    access_policy: null,
    is_active: true,
    deactivate_at: null,
    deactivate_timezone: "Europe/London",
    is_event_related: false,
    related_event_id: null,
    due_diligence_required: false,
    allow_submitter_email_copy: false,
    allow_save_continue_later: true,
    prevent_duplicate_email_submission: false,
    owners: [], // Member IDs who own this form (see Owners card / "My Forms" tab)
    is_application_form: false,
    is_job_posting: false, // Flags this form for the member-group vacancy form picker
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
    },
    // Contract signing mode
    is_contract: false,
    blank_layout: false,
    contract_settings: {
      timeout_days: 30, // Days before contract expires
      organization_id: null, // Linked organisation
      reminders: [], // [{id, days_before_timeout, email_template_id}]
      require_signature: true,
      signers: [], // [{id, name, email, type: 'external'|'member', member_id}]
      // Timeout notification settings (for alternative signer feature)
      timeout_email_template_id: null, // Email to send when contract times out
      source_dd_form_id: null, // Source DD form for applicant field mapping
      applicant_name_field: null, // Field ID from DD form for applicant's name
      applicant_email_field: null, // Field ID from DD form for applicant's email
      alternative_signer_form_id: null // Form where applicant provides new signer details
    },
    communication_category_id: null, // Link form to a communication category for newsletter signups
    // Survey forms (Task #3330)
    form_type: 'standard', // 'standard' | 'survey'
    survey_settings: {}, // status, intro/thank-you, identity mode, display options
    survey_audit_log: [] // append-only lifecycle audit entries
  });
  
  // Track which form pages are expanded (for collapsible UI) - true = expanded, false = collapsed
  // Use a ref to track "all collapsed" mode separately from individual toggles
  const [expandedPages, setExpandedPages] = useState({});
  const [allCollapsedMode, setAllCollapsedMode] = useState(false);
  
  // Track which field's configuration drawer is open
  const [editingFieldId, setEditingFieldId] = useState(null);

  // Controlled tab state (survey validation links jump back to the builder)
  const [activeTab, setActiveTab] = useState('builder');
  
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
    queryFn: async () => await publicClient.listResourceCategories() || []
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

  // Fetch all forms for alternative signer form selection
  const { data: allForms = [] } = useQuery({
    queryKey: ['all-forms-for-selection'],
    queryFn: async () => {
      try {
        const forms = await base44.entities.Form.list();
        return (forms || []).filter(f => f.is_active !== false && !f.is_contract);
      } catch (err) {
        console.warn('Failed to fetch forms:', err);
        return [];
      }
    },
  });

  // Survey lock (Task #3330): once a form has ANY responses, form type and
  // scoring settings are locked and "Duplicate as New Version" is offered.
  const { data: hasResponses = false } = useQuery({
    queryKey: ['form-has-responses', formId],
    queryFn: async () => {
      try {
        const rows = await base44.entities.FormSubmission.filter({ form_id: formId }, '-created_date', 1);
        return (rows || []).length > 0;
      } catch (err) {
        console.warn('Failed to check for existing submissions:', err);
        return false;
      }
    },
    enabled: !!formId,
  });

  // Fetch DD forms for applicant field mapping in timeout notifications
  const { data: ddForms = [] } = useQuery({
    queryKey: ['dd-forms-for-mapping'],
    queryFn: async () => {
      try {
        const forms = await base44.entities.Form.list();
        return (forms || []).filter(f => f.is_active !== false && f.due_diligence_required === true);
      } catch (err) {
        console.warn('Failed to fetch DD forms:', err);
        return [];
      }
    },
  });

  // Get fields from selected source DD form for applicant mapping
  const selectedSourceDDFormId = formData?.contract_settings?.source_dd_form_id;
  const selectedSourceDDForm = ddForms.find(f => f.id === selectedSourceDDFormId);
  const sourceFormFields = selectedSourceDDForm?.fields || [];

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

  const { data: activeMemberGroups = [] } = useQuery({
    queryKey: ['/api/entities/MemberGroup', 'active-for-form-access'],
    queryFn: async () => {
      try {
        const groups = await base44.entities.MemberGroup.list({
          filter: { is_active: true },
          sort: { name: 'asc' }
        });
        return (groups || []).filter(group => group.is_active !== false);
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

  // Fetch events for the "related to an event" form setting. We pull all
  // events ordered by start date and filter to upcoming ones in the dropdown
  // (keeping any already-linked past event visible so editing round-trips).
  const { data: allEvents = [] } = useQuery({
    queryKey: ['/api/entities/Event', 'all-for-form-event-link'],
    queryFn: async () => {
      try {
        const events = await base44.entities.Event.list({ sort: { start_date: 'asc' } });
        return events || [];
      } catch {
        return [];
      }
    }
  });

  // Events for the linked-event dropdown, alphabetical by title. Survey forms
  // include past events (surveys usually follow an event that already ran);
  // standard forms keep the upcoming-only filter. Any event already linked to
  // this form is always included even if it is now in the past, so editing an
  // existing form restores its selection cleanly.
  const isSurveyForm = formData.form_type === 'survey';
  const eventOptions = useMemo(() => {
    const now = Date.now();
    const selectedId = formData.related_event_id || null;
    const list = (allEvents || []).filter(ev => {
      if (!ev || !ev.id) return false;
      if (isSurveyForm) return true;
      if (selectedId && ev.id === selectedId) return true;
      const start = ev.start_date ? new Date(ev.start_date).getTime() : NaN;
      return Number.isFinite(start) ? start >= now : false;
    });
    return list.sort((a, b) =>
      String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' })
    );
  }, [allEvents, formData.related_event_id, isSurveyForm]);

  // Fetch organisations for contract linking
  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-contracts'],
    queryFn: async () => {
      try {
        const orgs = await listOrganizationsForAdmin('name');
        return orgs || [];
      } catch {
        return [];
      }
    }
  });

  // Fetch members for contract signer selection
  const { data: members = [] } = useQuery({
    queryKey: ['members-for-contract-signers'],
    queryFn: async () => {
      try {
        const memberList = await base44.entities.Member.list('first_name, last_name, email');
        return memberList || [];
      } catch {
        return [];
      }
    }
  });

  // Fetch contract forms (forms with is_contract: true) for Contact field contract template selection
  const { data: contractForms = [] } = useQuery({
    queryKey: ['contract-forms-for-contact-field'],
    queryFn: async () => {
      try {
        const allForms = await base44.entities.Form.list();
        return (allForms || []).filter(f => f.is_contract === true);
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
        login_enabled: null
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
            mappings,
            login_enabled: typeof am.login_enabled === 'boolean' ? am.login_enabled : null
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
          column_index: field.column_index ?? 0, // Default to first column
          ...(field.conditional_filters ? {
            conditional_filters: {
              version: 1,
              rules: (Array.isArray(field.conditional_filters.rules) ? field.conditional_filters.rules : []).map((rule, ruleIndex) => ({
                id: rule.id || `conditional_filter_${field.id}_${ruleIndex}`,
                source_field_id: rule.source_field_id || '',
                source_field_type: rule.source_field_type || null,
                operator: rule.operator || 'equals',
                value: rule.value ?? '',
                is_fallback: rule.is_fallback === true,
                allowed_values: Array.isArray(rule.allowed_values) ? rule.allowed_values : [],
                org_filter: rule.org_filter || null,
              })),
            },
          } : {}),
        })) : [],
        pages: existingForm.pages ? existingForm.pages.map(page => ({
          ...page,
          column_count: page.column_count ?? 1 // Default to single column
        })) : [],
        submit_button_text: existingForm.submit_button_text || "Submit",
        success_message: existingForm.success_message || "Thank you for your submission!",
        redirect_url: existingForm.redirect_url || "",
        require_authentication: existingForm.require_authentication || false,
        access_policy: (
          existingForm.access_policy?.group_rules?.length ||
          existingForm.access_policy?.rbac_role_ids?.length
        ) ? existingForm.access_policy : null,
        is_active: existingForm.is_active ?? true,
        deactivate_at: existingForm.deactivate_at || null,
        deactivate_timezone: existingForm.deactivate_timezone || "Europe/London",
        is_event_related: existingForm.is_event_related ?? false,
        related_event_id: existingForm.related_event_id || null,
        due_diligence_required: existingForm.due_diligence_required ?? false,
        allow_submitter_email_copy: existingForm.allow_submitter_email_copy ?? false,
        allow_save_continue_later: existingForm.allow_save_continue_later !== false,
        prevent_duplicate_email_submission: existingForm.prevent_duplicate_email_submission ?? false,
        owners: Array.isArray(existingForm.owners) ? existingForm.owners : [],
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
        is_job_posting: existingForm.is_job_posting || false,
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
        entity_pipelines: entityPipelines,
        is_contract: existingForm.is_contract || false,
        blank_layout: existingForm.blank_layout || false,
        contract_settings: existingForm.contract_settings || {
          timeout_days: 30,
          organization_id: null,
          reminders: [],
          require_signature: true,
          signers: []
        },
        communication_category_id: existingForm.communication_category_id || null,
        form_type: existingForm.form_type || 'standard',
        survey_settings: existingForm.survey_settings || {},
        survey_audit_log: Array.isArray(existingForm.survey_audit_log) ? existingForm.survey_audit_log : []
      });
    }
  }, [existingForm]);

  // Redirect URL can either be a static URL (current behaviour) or be driven by
  // the value the respondent submits for one of the form's own fields. The
  // field-based option is encoded into the existing `redirect_url` column with a
  // `field:` prefix so no schema change is required.
  const REDIRECT_FIELD_PREFIX = 'field:';
  const lastStaticRedirectRef = useRef('');
  const redirectIsField = (formData.redirect_url || '').startsWith(REDIRECT_FIELD_PREFIX);
  const redirectMode = redirectIsField ? 'field' : 'static';
  const selectedRedirectFieldId = redirectIsField
    ? formData.redirect_url.slice(REDIRECT_FIELD_PREFIX.length)
    : '';
  if (!redirectIsField) {
    // Remember the last static URL so toggling to "field" and back doesn't lose it.
    lastStaticRedirectRef.current = formData.redirect_url || '';
  }
  const handleRedirectModeChange = (mode) => {
    if (mode === 'field') {
      setFormData({ ...formData, redirect_url: REDIRECT_FIELD_PREFIX });
    } else {
      setFormData({ ...formData, redirect_url: lastStaticRedirectRef.current || '' });
    }
  };
  const handleRedirectFieldChange = (fieldId) => {
    setFormData({ ...formData, redirect_url: `${REDIRECT_FIELD_PREFIX}${fieldId}` });
  };

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
      column_index: columnIndex
    };
    setFormData({ ...formData, fields: [...formData.fields, newField] });
  };

  // Page management functions (for standard layout only)
  const addPage = () => {
    const pageNumber = formData.pages.length + 1;
    const newPage = {
      id: `page_${Date.now()}`,
      title: `Page ${pageNumber}`,
      column_count: 1,
      page_style: 'standard'
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

  // --- Survey publish / duplicate (Task #3330) --------------------------
  const updateSurveySetting = (key, value) => {
    setFormData((prev) => {
      const nextSettings = { ...(prev.survey_settings || {}), [key]: value };
      // Audit entries (incl. archive) are appended server-side.
      return { ...prev, survey_settings: nextSettings };
    });
  };

  const surveyValidation = useMemo(() => {
    if (formData.form_type !== 'survey') return null;
    return validateSurveyForPublish(formData.fields || [], formData.survey_settings || {});
  }, [formData.form_type, formData.fields, formData.survey_settings]);

  const publishSurveyMutation = useMutation({
    mutationFn: async () => {
      // Save the current builder state first so the server snapshots exactly
      // what the admin sees, then publish server-side (the publish endpoint
      // is the only writer of survey_version snapshots).
      await base44.entities.Form.update(formId, {
        fields: formData.fields || [],
        pages: formData.pages || [],
        visibility_rules: formData.visibility_rules || [],
        survey_settings: formData.survey_settings || {}
      });
      const response = await fetch('/api/forms/publish-survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ form_id: formId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to publish survey');
      }
      return payload;
    },
    onSuccess: (payload) => {
      setFormData((prev) => ({
        ...prev,
        survey_settings: payload.survey_settings || prev.survey_settings,
        survey_audit_log: payload.survey_audit_log || prev.survey_audit_log
      }));
      queryClient.invalidateQueries({ queryKey: ['form', formId] });
      toast.success(`Survey published (version ${payload.version_number})`);
    },
    onError: (err) => {
      console.error('Publish survey failed:', err);
      toast.error(err?.message || 'Failed to publish survey');
    }
  });

  const handlePublishSurvey = () => {
    if (!formId) {
      toast.error('Save the survey first, then publish.');
      return;
    }
    if (surveyValidation?.errors?.length) {
      toast.error('Fix the validation issues before publishing.');
      return;
    }
    const invalidNotListedField = formData.fields.find(field =>
      supportsFormNotListedChoice(field)
      && field.not_listed_choice?.enabled === true
      && !field.not_listed_choice?.label?.trim()
    );
    if (invalidNotListedField) {
      toast.error(`“${invalidNotListedField.label || 'Untitled field'}” needs a label for its not-listed choice.`);
      return;
    }
    publishSurveyMutation.mutate();
  };

  const duplicateSurveyMutation = useMutation({
    mutationFn: async () => {
      const { _ccCustomMode, _bccCustomMode, ...copy } = formData;
      const newForm = await base44.entities.Form.create({
        ...copy,
        name: `${formData.name} (new version)`,
        slug: `${formData.slug}-v${Date.now().toString(36)}`,
        is_active: false,
        survey_settings: {
          ...(formData.survey_settings || {}),
          status: 'draft',
          current_version: 0,
          parent_form_id: formId
        },
        // Audit entry appended server-side on create.
      });
      return newForm;
    },
    onSuccess: (newForm) => {
      toast.success('New draft version created');
      window.location.href = `${createPageUrl('FormBuilder')}?formId=${newForm.id}`;
    },
    onError: (err) => {
      console.error('Duplicate survey failed:', err);
      toast.error('Failed to duplicate survey');
    }
  });

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

    const invalidNotListedField = formData.fields.find(field =>
      supportsFormNotListedChoice(field)
      && field.not_listed_choice?.enabled === true
      && !field.not_listed_choice?.label?.trim()
    );
    if (invalidNotListedField) {
      toast.error(`“${invalidNotListedField.label || 'Untitled field'}” needs a label for its not-listed choice.`);
      return;
    }

    // Task #3483: generic Payment fields need at least one enabled provider
    // and a price-source field before the form can be saved.
    const paymentFields = formData.fields.filter(f => f.type === 'payment');
    if (paymentFields.length > 1) {
      toast.error('A form can only contain one Payment field.');
      return;
    }
    for (const pf of paymentFields) {
      const enabledProviders = Array.isArray(pf.payment_providers) ? pf.payment_providers : [];
      if (enabledProviders.length === 0) {
        toast.error(`Payment field "${pf.label || 'Payment'}" needs at least one payment method enabled.`);
        return;
      }
      // Task #3497: when a membership-structure conditional action exists,
      // the fee is server-derived and the price source is legitimately
      // empty. A set-but-dangling price_field_id is still an error.
      const membershipDerived = hasMembershipStructureAction(formData.visibility_rules);
      if (!pf.price_field_id) {
        if (!membershipDerived) {
          toast.error(`Payment field "${pf.label || 'Payment'}" needs a price source field.`);
          return;
        }
      } else if (!formData.fields.some(f => f.id === pf.price_field_id)) {
        toast.error(`Payment field "${pf.label || 'Payment'}" points at a price source field that no longer exists.`);
        return;
      }
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
      if (m.transformation !== 'current_date' && m.source_type !== 'static' && m.source_type !== 'clear' && m.source_type !== 'current_date') {
        if (!m.source_field_id) {
          console.log(`[FormBuilder] Validation failed: mapping #${i + 1} missing source_field_id`);
          toast.error(`Field mapping #${i + 1} is missing a source field. Please select a source field or use "Current Date" source.`);
          return;
        }
        const sourceField = formData.fields.find(f => f.id === m.source_field_id);
        if (sourceField?.type === 'communication_preferences' && !m.source_category_id) {
          console.log(`[FormBuilder] Validation failed: mapping #${i + 1} missing source_category_id for communication_preferences field`);
          toast.error(`Field mapping #${i + 1} uses a Communication Preferences field — please select which category to map.`);
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

    // Survey audit trail is SERVER-authored: the entity API strips any
    // client-supplied survey_audit_log and appends create/edit/archive
    // entries itself, so never send it from the builder.
    delete dataToSave.survey_audit_log;

    // Strip blank/whitespace-only option rows so empty "Add Option" rows are
    // never persisted (image_options fields keep their own structure).
    dataToSave.fields = (dataToSave.fields || []).map((f) => {
      if (!Array.isArray(f.options) || f.type === 'image_options') return f;
      const cleaned = f.options.filter(
        (opt) => typeof opt !== 'string' || opt.trim() !== ''
      );
      return cleaned.length === f.options.length ? f : { ...f, options: cleaned };
    });
    
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
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
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
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className={`grid w-full ${formData.form_type === 'survey' ? 'grid-cols-7' : 'grid-cols-5'} mb-6`} data-testid="formbuilder-tabs">
            <TabsTrigger value="builder" data-testid="tab-builder">Builder</TabsTrigger>
            <TabsTrigger value="settings" data-testid="tab-settings">Form Settings</TabsTrigger>
            <TabsTrigger value="submission" data-testid="tab-submission">Submission Settings</TabsTrigger>
            <TabsTrigger value="emails" data-testid="tab-emails">Emails</TabsTrigger>
            <TabsTrigger value="logic" data-testid="tab-logic">Conditional Logic</TabsTrigger>
            {formData.form_type === 'survey' && (
              <TabsTrigger value="survey" data-testid="tab-survey">Survey Settings</TabsTrigger>
            )}
            {formData.form_type === 'survey' && (
              <TabsTrigger value="events" data-testid="tab-events">Events</TabsTrigger>
            )}
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
                <Label htmlFor="form_type">Form Type</Label>
                <Select
                  value={formData.form_type || 'standard'}
                  onValueChange={(value) => {
                    setFormData({
                      ...formData,
                      form_type: value,
                      survey_settings: value === 'survey'
                        ? { status: 'draft', anonymity_threshold: 3, response_identity: 'identified', ...(formData.survey_settings || {}) }
                        : (formData.survey_settings || {})
                    });
                  }}
                  disabled={hasResponses}
                >
                  <SelectTrigger data-testid="select-form-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard Form</SelectItem>
                    <SelectItem value="survey">Survey Form</SelectItem>
                  </SelectContent>
                </Select>
                {hasResponses && (
                  <p className="text-xs text-slate-500">Form type is locked because this form already has responses.</p>
                )}
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
                <Select value={redirectMode} onValueChange={handleRedirectModeChange}>
                  <SelectTrigger data-testid="select-redirect-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="static">Static URL</SelectItem>
                    <SelectItem value="field">Use a form field</SelectItem>
                  </SelectContent>
                </Select>
                {redirectMode === 'static' ? (
                  <Input
                    id="redirect_url"
                    type="url"
                    value={formData.redirect_url}
                    onChange={(e) => {
                      lastStaticRedirectRef.current = e.target.value;
                      setFormData({ ...formData, redirect_url: e.target.value });
                    }}
                    placeholder="https://example.com/thanks"
                    data-testid="input-redirect-url"
                  />
                ) : (
                  <>
                    <Select
                      value={selectedRedirectFieldId || undefined}
                      onValueChange={handleRedirectFieldChange}
                    >
                      <SelectTrigger data-testid="select-redirect-field">
                        <SelectValue placeholder="Select a field" />
                      </SelectTrigger>
                      <SelectContent>
                        {formData.fields.map((field) => (
                          <SelectItem key={field.id} value={field.id}>
                            {field.label || field.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      After submitting, the user is sent to the URL they entered in this field.
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Toggles Column */}
            <div className="flex flex-col gap-4 mt-4 pt-4 border-t border-slate-100">
              <div className="flex items-center gap-3">
                <Switch
                  id="require_authentication"
                  checked={formData.require_authentication}
                  onCheckedChange={(checked) => setFormData({ ...formData, require_authentication: checked })}
                />
                <Label htmlFor="require_authentication" className="text-sm">Require Login</Label>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
                <Label htmlFor="is_active" className="text-sm">Active</Label>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="due_diligence_required"
                  checked={formData.due_diligence_required}
                  onCheckedChange={(checked) => setFormData({ ...formData, due_diligence_required: checked })}
                  data-testid="switch-due-diligence-required"
                />
                <Label htmlFor="due_diligence_required" className="text-sm">Due Diligence Required</Label>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="is_contract"
                  checked={formData.is_contract}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_contract: checked })}
                  data-testid="switch-is-contract"
                />
                <Label htmlFor="is_contract" className="text-sm">Contract Mode</Label>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="blank_layout"
                  checked={formData.blank_layout}
                  onCheckedChange={(checked) => setFormData({ ...formData, blank_layout: checked })}
                  data-testid="switch-blank-layout"
                />
                <Label htmlFor="blank_layout" className="text-sm">Blank Layout</Label>
              </div>

              <div className="flex items-center gap-3" title="When enabled, the public form shows an email input and a 'Email me a copy' checkbox at the bottom. Submitters who tick it receive a Word (DOCX) copy of their submission by email.">
                <Switch
                  id="allow_submitter_email_copy"
                  checked={formData.allow_submitter_email_copy}
                  onCheckedChange={(checked) => setFormData({ ...formData, allow_submitter_email_copy: checked })}
                  data-testid="switch-allow-submitter-email-copy"
                />
                <Label htmlFor="allow_submitter_email_copy" className="text-sm">Allow submitter to email themselves a copy</Label>
              </div>

              <div className="flex items-center gap-3" title="When enabled, the public form shows a 'Save & Continue Later' button so submitters can save their progress and return via a resume link. Turn off to hide that button; normal submission still works.">
                <Switch
                  id="allow_save_continue_later"
                  checked={formData.allow_save_continue_later !== false}
                  onCheckedChange={(checked) => setFormData({ ...formData, allow_save_continue_later: checked })}
                  data-testid="switch-allow-save-continue-later"
                />
                <Label htmlFor="allow_save_continue_later" className="text-sm">Allow save &amp; continue later</Label>
              </div>

              <div className="flex items-center gap-3" title="When enabled, this form appears in the member-group vacancy form picker so a vacancy can collect applications through it. For the applicant's details to pre-fill, set Prefill Source to 'member' on the Submission Settings tab.">
                <Switch
                  id="is_job_posting"
                  checked={formData.is_job_posting}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_job_posting: checked })}
                  data-testid="switch-is-job-posting"
                />
                <Label htmlFor="is_job_posting" className="text-sm">Job posting application form</Label>
              </div>

              <div className="flex items-center gap-3" title="When enabled, pick a single upcoming event. Every submission to this form will be linked to that event so you can review submissions per event.">
                <Switch
                  id="is_event_related"
                  checked={formData.is_event_related}
                  onCheckedChange={(checked) => setFormData({
                    ...formData,
                    is_event_related: checked,
                    related_event_id: checked ? formData.related_event_id : null
                  })}
                  data-testid="switch-is-event-related"
                />
                <Label htmlFor="is_event_related" className="text-sm">This form is related to an event</Label>
              </div>

              <div className="flex flex-col gap-2 min-w-[260px] pt-2 border-t border-slate-100" title="Optionally schedule the form to stop accepting submissions at a specific date and time. Leave empty to keep the form active until you turn off the Active toggle.">
                <Label htmlFor="deactivate_at" className="text-sm">Deactivate at (optional)</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <TimezoneAwareDateTimeInput
                    id="deactivate_at"
                    tz={formData.deactivate_timezone || "Europe/London"}
                    value={formData.deactivate_at || ""}
                    onChange={(iso) => setFormData({ ...formData, deactivate_at: iso || null })}
                    className="sm:w-[220px]"
                    data-testid="input-deactivate-at"
                  />
                  {formData.deactivate_at && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setFormData({ ...formData, deactivate_at: null })}
                      data-testid="button-clear-deactivate-at"
                    >
                      <X className="h-4 w-4 mr-1" />
                      Clear
                    </Button>
                  )}
                </div>
                <div className="w-full sm:w-[260px]">
                  <TimezoneSelect
                    id="deactivate_timezone"
                    value={formData.deactivate_timezone || "Europe/London"}
                    onChange={(tz) => setFormData({ ...formData, deactivate_timezone: tz })}
                  />
                </div>
              </div>

              <div className="text-xs text-slate-500 pt-2 border-t border-slate-100">
                URL: /FormView?slug={formData.slug || 'your-slug'}
              </div>
            </div>

            <FormAccessPolicyEditor
              policy={formData.access_policy}
              onChange={(accessPolicy) => setFormData(prev => ({ ...prev, access_policy: accessPolicy }))}
              groups={activeMemberGroups}
              roles={roles}
            />

            {/* Event link selector - shown only when the form is related to an event */}
            {formData.is_event_related && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <div className="space-y-2 max-w-md">
                  <Label htmlFor="related_event_id" className="text-sm">Linked Event *</Label>
                  <LinkedEventCombobox
                    eventOptions={eventOptions}
                    value={formData.related_event_id || null}
                    onChange={(value) => setFormData({ ...formData, related_event_id: value || null })}
                    includesPastEvents={isSurveyForm}
                  />
                  <p className="text-xs text-slate-500">
                    Submissions to this form will be associated with the selected event.
                  </p>
                </div>
              </div>
            )}

            {/* Contract Settings Section - Only shown when Contract Mode is enabled */}
            {formData.is_contract && (
              <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <Label className="text-sm font-medium">Contract Settings</Label>
                </div>
                <div className="bg-blue-50/50 rounded-lg p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="timeout_days">Timeout (Days)</Label>
                      <Input
                        id="timeout_days"
                        type="number"
                        min="1"
                        max="365"
                        value={formData.contract_settings?.timeout_days || 30}
                        onChange={(e) => setFormData({
                          ...formData,
                          contract_settings: {
                            ...formData.contract_settings,
                            timeout_days: parseInt(e.target.value) || 30
                          }
                        })}
                        data-testid="input-timeout-days"
                      />
                    </div>

                    <div className="flex items-center gap-2 pt-6">
                      <Switch
                        id="require_signature"
                        checked={formData.contract_settings?.require_signature ?? true}
                        onCheckedChange={(checked) => setFormData({
                          ...formData,
                          contract_settings: {
                            ...formData.contract_settings,
                            require_signature: checked
                          }
                        })}
                        data-testid="switch-require-signature"
                      />
                      <Label htmlFor="require_signature" className="text-sm">Require Signature</Label>
                    </div>
                  </div>

                  {/* Initial Email Template */}
                  <div className="space-y-3 pt-2 border-t border-blue-100">
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-slate-500" />
                      <Label className="text-sm font-medium">Initial Email Template</Label>
                    </div>
                    <p className="text-xs text-slate-500">
                      Select the email template to send when the contract is sent for signing.
                    </p>
                    <Select
                      value={formData.contract_settings?.initial_email_template_id || "_none"}
                      onValueChange={(value) => setFormData({
                        ...formData,
                        contract_settings: {
                          ...formData.contract_settings,
                          initial_email_template_id: value === "_none" ? null : value
                        }
                      })}
                    >
                      <SelectTrigger data-testid="select-initial-email-template">
                        <SelectValue placeholder="Select email template..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">No template (don't send email)</SelectItem>
                        {emailTemplates.map(template => (
                          <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Reminder Schedule */}
                  <div className="space-y-3 pt-4 border-t border-slate-100">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Reminder Schedule</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const reminders = formData.contract_settings?.reminders || [];
                          setFormData({
                            ...formData,
                            contract_settings: {
                              ...formData.contract_settings,
                              reminders: [...reminders, {
                                id: `reminder_${Date.now()}`,
                                days: 7,
                                timing_type: 'before_timeout',
                                email_template_id: null
                              }]
                            }
                          });
                        }}
                        data-testid="button-add-reminder"
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        Add Reminder
                      </Button>
                    </div>
                    
                    {(formData.contract_settings?.reminders || []).length === 0 ? (
                      <div className="text-center py-4 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                        <Mail className="w-6 h-6 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">No reminders configured</p>
                        <p className="text-xs mt-1">Add reminders to notify signers</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {(formData.contract_settings?.reminders || []).map((reminder, idx) => (
                          <div key={reminder.id} className="flex flex-wrap items-center gap-3 bg-white p-3 rounded-md border border-slate-200" data-testid={`reminder-row-${idx}`}>
                            <div className="flex items-center gap-2">
                              <Label className="text-sm whitespace-nowrap">Send</Label>
                              <Input
                                type="number"
                                min="1"
                                max={formData.contract_settings?.timeout_days || 30}
                                value={reminder.days || reminder.days_before_timeout || 7}
                                onChange={(e) => {
                                  const reminders = [...(formData.contract_settings?.reminders || [])];
                                  reminders[idx] = { ...reminder, days: parseInt(e.target.value) || 7 };
                                  delete reminders[idx].days_before_timeout;
                                  setFormData({
                                    ...formData,
                                    contract_settings: { ...formData.contract_settings, reminders }
                                  });
                                }}
                                className="w-20"
                                data-testid={`input-reminder-days-${idx}`}
                              />
                              <Label className="text-sm whitespace-nowrap">days</Label>
                            </div>
                            <div className="w-40">
                              <Select
                                value={reminder.timing_type || 'before_timeout'}
                                onValueChange={(value) => {
                                  const reminders = [...(formData.contract_settings?.reminders || [])];
                                  reminders[idx] = { ...reminder, timing_type: value };
                                  setFormData({
                                    ...formData,
                                    contract_settings: { ...formData.contract_settings, reminders }
                                  });
                                }}
                              >
                                <SelectTrigger data-testid={`select-reminder-timing-${idx}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="before_timeout">before timeout</SelectItem>
                                  <SelectItem value="after_first_send">after first send</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex-1 min-w-[180px]">
                              <Select
                                value={reminder.email_template_id || "_none"}
                                onValueChange={(value) => {
                                  const reminders = [...(formData.contract_settings?.reminders || [])];
                                  reminders[idx] = { ...reminder, email_template_id: value === "_none" ? null : value };
                                  setFormData({
                                    ...formData,
                                    contract_settings: { ...formData.contract_settings, reminders }
                                  });
                                }}
                              >
                                <SelectTrigger data-testid={`select-reminder-template-${idx}`}>
                                  <SelectValue placeholder="Select email template..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="_none">No template</SelectItem>
                                  {emailTemplates.map(template => (
                                    <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                const reminders = (formData.contract_settings?.reminders || []).filter(r => r.id !== reminder.id);
                                setFormData({
                                  ...formData,
                                  contract_settings: { ...formData.contract_settings, reminders }
                                });
                              }}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              data-testid={`button-delete-reminder-${idx}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Timeout Notification Settings - Alternative Signer Feature */}
                <div className="pt-3 border-t border-slate-100">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="w-4 h-4 text-warning" />
                    <Label className="text-sm font-medium">Timeout Notification</Label>
                  </div>
                  <p className="text-xs text-slate-500 mb-3">
                    When the contract expires without a signature, notify the original applicant to provide an alternative signer.
                  </p>
                  
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-slate-600">Timeout Email Template</Label>
                      <Select
                        value={formData.contract_settings?.timeout_email_template_id || "_none"}
                        onValueChange={(value) => setFormData({
                          ...formData,
                          contract_settings: {
                            ...formData.contract_settings,
                            timeout_email_template_id: value === "_none" ? null : value
                          }
                        })}
                      >
                        <SelectTrigger data-testid="select-timeout-email-template">
                          <SelectValue placeholder="Select email template..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">No template (disabled)</SelectItem>
                          {emailTemplates.map(template => (
                            <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {formData.contract_settings?.timeout_email_template_id && (
                      <>
                        <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg space-y-3 mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-blue-700 dark:text-blue-300">Applicant Field Mapping</span>
                          </div>
                          <p className="text-xs text-blue-600 dark:text-blue-400">
                            Select a Due Diligence form and choose which fields contain the applicant's name and email. Fields are matched by label, so this works across multiple DD forms with the same field names. These populate placeholders like {'{{first_name}}'}, {'{{applicant_name}}'}.
                          </p>
                          
                          <div className="space-y-2">
                            <div className="space-y-1">
                              <Label className="text-xs text-slate-600">Source DD Form</Label>
                              <Select
                                value={formData.contract_settings?.source_dd_form_id || "_none"}
                                onValueChange={(value) => setFormData({
                                  ...formData,
                                  contract_settings: {
                                    ...formData.contract_settings,
                                    source_dd_form_id: value === "_none" ? null : value,
                                    applicant_name_field: null,
                                    applicant_email_field: null
                                  }
                                })}
                              >
                                <SelectTrigger className="text-xs" data-testid="select-source-dd-form">
                                  <SelectValue placeholder="Select DD form..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="_none">-- None --</SelectItem>
                                  {ddForms.map(form => (
                                    <SelectItem key={form.id} value={form.id}>
                                      {form.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            
                            {formData.contract_settings?.source_dd_form_id && sourceFormFields.length > 0 && (
                              <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1">
                                  <Label className="text-xs text-slate-600">Applicant Name Field</Label>
                                  <Select
                                    value={formData.contract_settings?.applicant_name_field || "_none"}
                                    onValueChange={(value) => setFormData({
                                      ...formData,
                                      contract_settings: {
                                        ...formData.contract_settings,
                                        applicant_name_field: value === "_none" ? null : value
                                      }
                                    })}
                                  >
                                    <SelectTrigger className="text-xs" data-testid="select-applicant-name-field">
                                      <SelectValue placeholder="Select field..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="_none">-- None --</SelectItem>
                                      {sourceFormFields.filter(f => f.type !== 'instructions' && f.type !== 'image' && f.type !== 'image_buttons').map(field => (
                                        <SelectItem key={field.id} value={field.id}>
                                          {field.label || field.id}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs text-slate-600">Applicant Email Field</Label>
                                  <Select
                                    value={formData.contract_settings?.applicant_email_field || "_none"}
                                    onValueChange={(value) => setFormData({
                                      ...formData,
                                      contract_settings: {
                                        ...formData.contract_settings,
                                        applicant_email_field: value === "_none" ? null : value
                                      }
                                    })}
                                  >
                                    <SelectTrigger className="text-xs" data-testid="select-applicant-email-field">
                                      <SelectValue placeholder="Select field..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="_none">-- None --</SelectItem>
                                      {sourceFormFields.filter(f => f.type !== 'instructions' && f.type !== 'image' && f.type !== 'image_buttons').map(field => (
                                        <SelectItem key={field.id} value={field.id}>
                                          {field.label || field.id}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                            )}
                            
                            {formData.contract_settings?.source_dd_form_id && sourceFormFields.length === 0 && (
                              <p className="text-xs text-warning dark:text-warning">
                                Selected form has no fields. Please add fields to the DD form first.
                              </p>
                            )}
                          </div>
                        </div>
                        
                        <div className="space-y-1">
                          <Label className="text-xs text-slate-600">Form Title</Label>
                          <Input
                            value={formData.contract_settings?.alternative_signer_title || ""}
                            onChange={(e) => setFormData({
                              ...formData,
                              contract_settings: {
                                ...formData.contract_settings,
                                alternative_signer_title: e.target.value || null
                              }
                            })}
                            placeholder="Provide Alternative Signer"
                            data-testid="input-alternative-signer-title"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs text-slate-600">Header Message</Label>
                          <Input
                            value={formData.contract_settings?.alternative_signer_message || ""}
                            onChange={(e) => setFormData({
                              ...formData,
                              contract_settings: {
                                ...formData.contract_settings,
                                alternative_signer_message: e.target.value || null
                              }
                            })}
                            placeholder="e.g., Please provide an alternative signer for this contract"
                            data-testid="input-alternative-signer-message"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs text-slate-600">Button Label</Label>
                          <Input
                            value={formData.contract_settings?.alternative_signer_button_label || ""}
                            onChange={(e) => setFormData({
                              ...formData,
                              contract_settings: {
                                ...formData.contract_settings,
                                alternative_signer_button_label: e.target.value || null
                              }
                            })}
                            placeholder="Add Signer & Send Contract"
                            data-testid="input-alternative-signer-button-label"
                          />
                        </div>

                        <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 mt-3">
                          <div className="flex items-center gap-2 mb-3">
                            <UserPlus className="w-4 h-4 text-blue-600" />
                            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Alternative Signer Form Preview</span>
                          </div>
                          <div className="bg-white dark:bg-slate-900 rounded-md border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                            <div className="text-center pb-3 border-b border-slate-100 dark:border-slate-700">
                              <UserPlus className="w-8 h-8 text-blue-600 mx-auto mb-2" />
                              <p className="font-medium text-sm">{formData.contract_settings?.alternative_signer_title || "Provide Alternative Signer"}</p>
                              {formData.contract_settings?.alternative_signer_message && (
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                  {formData.contract_settings.alternative_signer_message}
                                </p>
                              )}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <span className="text-xs text-slate-500">First Name *</span>
                                <div className="h-8 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-600" />
                              </div>
                              <div className="space-y-1">
                                <span className="text-xs text-slate-500">Last Name *</span>
                                <div className="h-8 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-600" />
                              </div>
                            </div>
                            <div className="space-y-1">
                              <span className="text-xs text-slate-500">Email Address *</span>
                              <div className="h-8 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-600" />
                            </div>
                            <div className="h-9 bg-blue-600 rounded flex items-center justify-center">
                              <span className="text-xs text-white font-medium">{formData.contract_settings?.alternative_signer_button_label || "Add Signer & Send Contract"}</span>
                            </div>
                          </div>
                          <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 text-center">
                            This is a fixed form - applicants will always provide First Name, Last Name, and Email
                          </p>
                        </div>

                        <div className="bg-warning/10 dark:bg-warning/20 p-2 rounded text-xs text-warning dark:text-warning">
                          <strong>Note:</strong> The timeout email should contain a link placeholder that will be replaced with the alternative signer form URL. Use <code className="bg-warning/10 dark:bg-warning/20 px-1 rounded">{'{{alternative_signer_link}}'}</code> in your email template.
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

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
                      <SelectItem value="booking">Event Attendee (Booking)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.prefill_source !== "none" && (
                  <p className="text-xs text-slate-500 self-end pb-2">
                    Form URL will accept ?{formData.prefill_source === "member" ? "member_id" : formData.prefill_source === "booking" ? "booking_id" : "organization_id"}=xxx to pre-populate fields
                  </p>
                )}
              </div>
            </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 mt-6" data-testid="card-form-owners">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-600" />
                Owners
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Assign members as owners of this form. Owners get a dedicated "My Forms" tab on the Form Submissions page that lists only the submissions for forms they own.
              </p>
            </CardHeader>
            <CardContent>
              <FormOwnersSelector
                owners={formData.owners || []}
                onChange={(owners) => setFormData({ ...formData, owners })}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Submission Settings Tab */}
          <TabsContent value="submission">
            {/* Submission Rules */}
            <Card className="border-slate-200 mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Submission Rules</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-3">
                  <Switch
                    id="prevent_duplicate_email_submission"
                    checked={formData.prevent_duplicate_email_submission}
                    onCheckedChange={(checked) => setFormData({ ...formData, prevent_duplicate_email_submission: checked })}
                    data-testid="switch-prevent-duplicate-email-submission"
                  />
                  <div className="space-y-1">
                    <Label htmlFor="prevent_duplicate_email_submission" className="text-sm">
                      Limit to one submission per email address
                    </Label>
                    <p className="text-xs text-slate-500">
                      Block repeat submissions when the same email address has already been used on this form. Case-insensitive; submissions without an email are unaffected.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

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
                          login_enabled: null
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
                      Add/Update
                    </Button>
                  </div>
                  
                  {(!formData.entity_pipelines?.members || formData.entity_pipelines.members.length === 0) ? (
                    <div className="text-center py-4 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                      <Users className="w-6 h-6 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No member records configured</p>
                      <p className="text-xs mt-1">Click "Add/Update" to create or update member records from this form</p>
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
                            className={`p-4 rounded-lg border ${hasEmailMapping ? 'border-slate-200 bg-slate-50' : 'border-warning/30 bg-warning/10'}`}
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
                                  value={
                                    memberConfig.role_id === "__clear__" ? "clear"
                                      : (memberConfig.role_id === "__keep__" || !memberConfig.role_id) ? "keep"
                                      : memberConfig.role_id
                                  }
                                  onValueChange={(value) => {
                                    const updated = [...formData.entity_pipelines.members];
                                    updated[memberIdx] = {
                                      ...updated[memberIdx],
                                      role_id: value === "keep" ? null : (value === "clear" ? "__clear__" : value)
                                    };
                                    setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, members: updated } }));
                                  }}
                                >
                                  <SelectTrigger className="h-8 w-48 text-xs" data-testid={`select-member-role-${memberIdx}`}>
                                    <SelectValue placeholder="Select role..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="keep">-- Don't change role --</SelectItem>
                                    <SelectItem value="clear" className="text-warning">Clear role (set to none)</SelectItem>
                                    {roles.map(role => (
                                      <SelectItem key={role.id} value={role.id}>
                                        {role.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Select
                                  value={
                                    memberConfig.login_enabled === true ? "enabled"
                                      : memberConfig.login_enabled === false ? "disabled"
                                      : "keep"
                                  }
                                  onValueChange={(value) => {
                                    const updated = [...formData.entity_pipelines.members];
                                    updated[memberIdx] = {
                                      ...updated[memberIdx],
                                      login_enabled: value === "enabled" ? true : (value === "disabled" ? false : null)
                                    };
                                    setFormData(prev => ({ ...prev, entity_pipelines: { ...prev.entity_pipelines, members: updated } }));
                                  }}
                                >
                                  <SelectTrigger className="h-8 w-44 text-xs" data-testid={`select-member-login-${memberIdx}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="keep">-- Don't change login --</SelectItem>
                                    <SelectItem value="enabled">Login enabled</SelectItem>
                                    <SelectItem value="disabled">Login disabled</SelectItem>
                                  </SelectContent>
                                </Select>
                                {!hasEmailMapping && (
                                  <span className="text-xs text-warning font-medium">Email mapping required</span>
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
                      Add/Update
                    </Button>
                  </div>
                  
                  {(!formData.entity_pipelines?.organisations || formData.entity_pipelines.organisations.length === 0) ? (
                    <div className="text-center py-4 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                      <Building2 className="w-6 h-6 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No organisation records configured</p>
                      <p className="text-xs mt-1">Click "Add/Update" to create or update organisation records from this form</p>
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
                            className={`p-4 rounded-lg border ${hasNameMapping ? 'border-slate-200 bg-slate-50' : 'border-warning/30 bg-warning/10'}`}
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
                                  <span className="text-xs text-warning font-medium">Name mapping required</span>
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

            {/* Newsletter / Communication Category Subscription */}
            <Card className="border-slate-200 mt-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Mail className="w-5 h-5" />
                  Newsletter Subscription
                </CardTitle>
                <p className="text-xs text-slate-500 mt-1">
                  Link this form to a communication category. When someone submits this form, they will be automatically subscribed to the selected category.
                </p>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <Label className="text-sm font-medium w-48">Communication Category</Label>
                    <Select
                      value={formData.communication_category_id || "none"}
                      onValueChange={(value) => {
                        setFormData(prev => ({
                          ...prev,
                          communication_category_id: value === "none" ? null : value
                        }));
                      }}
                    >
                      <SelectTrigger className="w-64" data-testid="select-communication-category">
                        <SelectValue placeholder="Select category..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">-- No category (disabled) --</SelectItem>
                        {communicationCategories.map(cat => (
                          <SelectItem key={cat.id} value={cat.id}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {formData.communication_category_id && (
                    <div className="text-xs text-slate-500 bg-blue-50 p-3 rounded-md border border-blue-100">
                      <strong>How it works:</strong> When a form is submitted:
                      <ul className="list-disc ml-4 mt-1 space-y-1">
                        <li>Members will have their communication preference updated to receive this category</li>
                        <li>Non-members will be added to the subscriber list for this category</li>
                        <li>Previously opted-out users will be re-subscribed (their latest action takes precedence)</li>
                      </ul>
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
                        hasMembershipPaymentField={formData.fields.some(f => f.type === 'membership_payment')}
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
                      condition: null,
                      attach_invoice: false
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
                  pages={formData.pages || []}
                  entityPipelines={formData.entity_pipelines}
                  onRulesChange={(rules) => {
                    const fieldsWithShowRules = new Set();
                    const pagesWithShowRules = new Set();
                    const pageIds = new Set((formData.pages || []).map(p => p.id));
                    rules.forEach(rule => {
                      if (rule.actions && Array.isArray(rule.actions)) {
                        for (const action of rule.actions) {
                          if (action.action_type === 'visibility' && action.field_states) {
                            for (const [id, state] of Object.entries(action.field_states)) {
                              if (state.visible === true) {
                                if (pageIds.has(id)) {
                                  pagesWithShowRules.add(id);
                                } else {
                                  fieldsWithShowRules.add(id);
                                }
                              }
                            }
                          }
                          if (action.action_type === 'show' && action.target_field_ids?.length) {
                            action.target_field_ids.forEach(id => fieldsWithShowRules.add(id));
                          }
                        }
                      }
                      else if (rule.action === 'show' && rule.target_field_ids?.length) {
                        rule.target_field_ids.forEach(id => fieldsWithShowRules.add(id));
                      }
                    });
                    setFormData(prev => {
                      const updatedFields = prev.fields.map(field => ({
                        ...field,
                        starts_hidden: fieldsWithShowRules.has(field.id) || field.starts_hidden
                      }));
                      const updatedPages = (prev.pages || []).map(page => ({
                        ...page,
                        starts_hidden: pagesWithShowRules.has(page.id) || page.starts_hidden
                      }));
                      return { 
                        ...prev, 
                        visibility_rules: rules,
                        fields: updatedFields,
                        pages: updatedPages
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
            <UnreachableHiddenWarning
              fields={formData.fields}
              pages={formData.pages || []}
              visibilityRules={formData.visibility_rules || []}
            />
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
                        <React.Fragment key={page.id}>
                        <div className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200">
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
                          <div className="flex items-center gap-1 border border-slate-200 rounded bg-white p-0.5">
                            <Button
                              variant={(page.page_style || 'standard') === 'standard' ? "default" : "ghost"}
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => updatePage(page.id, { page_style: 'standard' })}
                              title="Standard Layout"
                            >
                              Standard
                            </Button>
                            <Button
                              variant={page.page_style === 'name_badge' ? "default" : "ghost"}
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => updatePage(page.id, { 
                                page_style: 'name_badge',
                                badge_style: page.badge_style || { ...BADGE_STYLE_DEFAULTS }
                              })}
                              title="Name Badge Layout"
                            >
                              Badge
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
                        {page.page_style === 'name_badge' && (() => {
                          const bs = page.badge_style || BADGE_STYLE_DEFAULTS;
                          const updateBadgeStyle = (updates) => {
                            updatePage(page.id, { badge_style: { ...bs, ...updates } });
                          };
                          return (
                            <div className="ml-8 mt-2 p-3 bg-white border border-slate-200 rounded-lg space-y-3">
                              <Label className="text-xs font-semibold">Badge Style</Label>
                              <div className="grid grid-cols-3 gap-3">
                                <div className="space-y-1">
                                  <Label className="text-xs">Accent Colour</Label>
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="color"
                                      value={bs.accent_color}
                                      onChange={(e) => updateBadgeStyle({ accent_color: e.target.value })}
                                      className="w-8 h-8 rounded cursor-pointer border border-slate-200"
                                      data-testid={`input-badge-accent-${page.id}`}
                                    />
                                    <span className="text-xs text-slate-500">{bs.accent_color}</span>
                                  </div>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Background</Label>
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="color"
                                      value={bs.background_color}
                                      onChange={(e) => updateBadgeStyle({ background_color: e.target.value })}
                                      className="w-8 h-8 rounded cursor-pointer border border-slate-200"
                                      data-testid={`input-badge-bg-${page.id}`}
                                    />
                                    <span className="text-xs text-slate-500">{bs.background_color}</span>
                                  </div>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Border</Label>
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="color"
                                      value={bs.border_color}
                                      onChange={(e) => updateBadgeStyle({ border_color: e.target.value })}
                                      className="w-8 h-8 rounded cursor-pointer border border-slate-200"
                                      data-testid={`input-badge-border-${page.id}`}
                                    />
                                    <span className="text-xs text-slate-500">{bs.border_color}</span>
                                  </div>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                  <Label className="text-xs">Width (px)</Label>
                                  <Input
                                    type="number"
                                    value={bs.width}
                                    onChange={(e) => updateBadgeStyle({ width: parseInt(e.target.value) || 400 })}
                                    min={200}
                                    max={600}
                                    className="h-8 text-xs"
                                    data-testid={`input-badge-width-${page.id}`}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Height (px)</Label>
                                  <Input
                                    type="number"
                                    value={bs.height}
                                    onChange={(e) => updateBadgeStyle({ height: parseInt(e.target.value) || 280 })}
                                    min={150}
                                    max={500}
                                    className="h-8 text-xs"
                                    data-testid={`input-badge-height-${page.id}`}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                        </React.Fragment>
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
                                      communicationCategories={communicationCategories}
                                      customFields={customFields}
                                      applicationLevel={formData.application_level}
                                      uniquenessChecks={formData.uniqueness_checks}
                                      onUniquenessChange={handleUniquenessChange}
                                      prefillSource={formData.prefill_source || "none"}
                                      isDrawerOpen={editingFieldId === field.id}
                                      onOpenDrawer={() => setEditingFieldId(field.id)}
                                      onCloseDrawer={() => setEditingFieldId(null)}
                                      contractForms={contractForms}
                                      allFields={formData.fields}
                                      formType={formData.form_type}
                                      scoringLocked={hasResponses && formData.form_type === 'survey'}
                                      formId={formId}
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
                                                  communicationCategories={communicationCategories}
                                                  customFields={customFields}
                                                  applicationLevel={formData.application_level}
                                                  uniquenessChecks={formData.uniqueness_checks}
                                                  onUniquenessChange={handleUniquenessChange}
                                                  prefillSource={formData.prefill_source || "none"}
                                                  isDrawerOpen={editingFieldId === field.id}
                                                  onOpenDrawer={() => setEditingFieldId(field.id)}
                                                  onCloseDrawer={() => setEditingFieldId(null)}
                                                  contractForms={contractForms}
                                                  allFields={formData.fields}
                                      formType={formData.form_type}
                                      scoringLocked={hasResponses && formData.form_type === 'survey'}
                                      formId={formId}
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
                              communicationCategories={communicationCategories}
                              customFields={customFields}
                              isApplicationForm={formData.is_application_form}
                              applicationLevel={formData.application_level}
                              uniquenessChecks={formData.uniqueness_checks}
                              onUniquenessChange={handleUniquenessChange}
                              prefillSource={formData.prefill_source || "none"}
                              isDrawerOpen={editingFieldId === field.id}
                              onOpenDrawer={() => setEditingFieldId(field.id)}
                              onCloseDrawer={() => setEditingFieldId(null)}
                              contractForms={contractForms}
                              allFields={formData.fields}
                                      formType={formData.form_type}
                                      scoringLocked={hasResponses && formData.form_type === 'survey'}
                                      formId={formId}
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

          {/* Survey Settings (Task #3330) */}
          {formData.form_type === 'survey' && (
            <TabsContent value="survey">
              <div className="space-y-6">
                <Card className="border-slate-200">
                  <CardHeader className="pb-4">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-lg">Survey Settings</CardTitle>
                      {formId && (
                        <Button type="button" variant="outline" size="sm" asChild data-testid="link-survey-report-builder">
                          <a href={`/SurveyReports?formId=${formId}`}>View Report</a>
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2 md:col-span-2">
                      <Label>Respondent Introduction</Label>
                      <Textarea
                        value={formData.survey_settings?.intro_text || ''}
                        onChange={(e) => updateSurveySetting('intro_text', e.target.value)}
                        placeholder="Shown to respondents above the survey..."
                        rows={2}
                        data-testid="input-survey-intro"
                      />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label>Thank-you Message</Label>
                      <Textarea
                        value={formData.survey_settings?.thank_you_message || ''}
                        onChange={(e) => updateSurveySetting('thank_you_message', e.target.value)}
                        placeholder="Shown after submitting (overrides the standard success message)"
                        rows={2}
                        data-testid="input-survey-thankyou"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Survey Status</Label>
                      <Select
                        value={formData.survey_settings?.status || 'draft'}
                        onValueChange={(value) => updateSurveySetting('status', value)}
                      >
                        <SelectTrigger data-testid="select-survey-status"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="draft">Draft</SelectItem>
                          {(formData.survey_settings?.status === 'published') && (
                            <SelectItem value="published">Published</SelectItem>
                          )}
                          <SelectItem value="archived">Archived</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">Separate from the form's Active flag. Publishing happens only via the Publish button (creates a version snapshot); editing a published survey reverts it to draft until re-published.</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Response Identity</Label>
                      <Select
                        value={formData.survey_settings?.response_identity || 'identified'}
                        onValueChange={(value) => updateSurveySetting('response_identity', value)}
                        disabled={hasResponses}
                      >
                        <SelectTrigger data-testid="select-survey-identity"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="identified">Identified</SelectItem>
                          <SelectItem value="anonymous">Anonymous</SelectItem>
                          <SelectItem value="anonymous_dedupe">Anonymous (prevent duplicates)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Score Display</Label>
                      <Select
                        value={formData.survey_settings?.score_display || 'weighted'}
                        onValueChange={(value) => updateSurveySetting('score_display', value)}
                      >
                        <SelectTrigger data-testid="select-survey-score-display"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="weighted">Weighted</SelectItem>
                          <SelectItem value="unweighted">Unweighted</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Reporting Scale</Label>
                      <Select
                        value={String(formData.survey_settings?.reporting_scale || 100)}
                        onValueChange={(value) => updateSurveySetting('reporting_scale', Number(value))}
                      >
                        <SelectTrigger data-testid="select-survey-reporting-scale"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="100">0–100</SelectItem>
                          <SelectItem value="10">0–10</SelectItem>
                          <SelectItem value="5">0–5</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Anonymity Threshold</Label>
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={formData.survey_settings?.anonymity_threshold ?? 3}
                        onChange={(e) => updateSurveySetting('anonymity_threshold', e.target.value === '' ? '' : Number(e.target.value))}
                        data-testid="input-survey-anonymity-threshold"
                      />
                      <p className="text-xs text-slate-500">Minimum responses before results are shown in reporting.</p>
                    </div>
                    <div className="flex flex-col gap-3 md:col-span-2">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={formData.survey_settings?.one_submission_per_respondent === true}
                          onCheckedChange={(checked) => updateSurveySetting('one_submission_per_respondent', checked)}
                          data-testid="switch-survey-one-submission"
                        />
                        <Label>One submission per respondent</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={formData.survey_settings?.show_progress === true}
                          onCheckedChange={(checked) => updateSurveySetting('show_progress', checked)}
                          data-testid="switch-survey-progress"
                        />
                        <Label>Show progress indicator</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={formData.survey_settings?.show_question_numbers === true}
                          onCheckedChange={(checked) => updateSurveySetting('show_question_numbers', checked)}
                          data-testid="switch-survey-question-numbers"
                        />
                        <Label>Show question numbers</Label>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-slate-200">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-lg">Survey Summary</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {surveyValidation && (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                          <div className="border rounded p-3">
                            <p className="text-2xl font-semibold" data-testid="summary-scored-count">{surveyValidation.summary.scoredCount}</p>
                            <p className="text-xs text-slate-500">Scored questions</p>
                          </div>
                          <div className="border rounded p-3">
                            <p className="text-2xl font-semibold" data-testid="summary-nonscored-count">{surveyValidation.summary.nonScoredCount}</p>
                            <p className="text-xs text-slate-500">Non-scored questions</p>
                          </div>
                          <div className="border rounded p-3">
                            <p className="text-2xl font-semibold" data-testid="summary-total-weight">{surveyValidation.summary.totalWeight}</p>
                            <p className="text-xs text-slate-500">Total weighting</p>
                          </div>
                          <div className="border rounded p-3">
                            <p className="text-2xl font-semibold" data-testid="summary-excluded-count">{surveyValidation.summary.excludedFromOverall.length}</p>
                            <p className="text-xs text-slate-500">Excluded from overall</p>
                          </div>
                        </div>
                        {surveyValidation.summary.missingCategory.length > 0 && (
                          <p className="text-xs text-amber-600">
                            {surveyValidation.summary.missingCategory.length} score question(s) have no reporting category.
                          </p>
                        )}
                        {(surveyValidation.errors.length > 0 || surveyValidation.warnings.length > 0) && (
                          <div className="space-y-1" data-testid="survey-validation-issues">
                            {surveyValidation.errors.map((issue, i) => (
                              <p key={`e${i}`} className="text-xs text-red-600">
                                •{' '}
                                {issue.field_id ? (
                                  <button
                                    type="button"
                                    className="underline"
                                    onClick={() => {
                                      setActiveTab('builder');
                                      setEditingFieldId(issue.field_id);
                                    }}
                                  >
                                    {(formData.fields || []).find(f => f.id === issue.field_id)?.label || 'Question'}
                                  </button>
                                ) : null}{issue.field_id ? ': ' : ''}{issue.message}
                              </p>
                            ))}
                            {surveyValidation.warnings.map((issue, i) => (
                              <p key={`w${i}`} className="text-xs text-amber-600">
                                •{' '}
                                {issue.field_id ? (
                                  <button
                                    type="button"
                                    className="underline"
                                    onClick={() => {
                                      setActiveTab('builder');
                                      setEditingFieldId(issue.field_id);
                                    }}
                                  >
                                    {(formData.fields || []).find(f => f.id === issue.field_id)?.label || 'Question'}
                                  </button>
                                ) : null}{issue.field_id ? ': ' : ''}{issue.message}
                              </p>
                            ))}
                          </div>
                        )}
                        {surveyValidation.errors.length === 0 && (
                          <p className="text-xs text-green-600">Validation passed — ready to publish.</p>
                        )}
                      </>
                    )}
                    <div className="flex flex-wrap gap-3 pt-2">
                      <Button
                        onClick={handlePublishSurvey}
                        disabled={!formId || publishSurveyMutation.isPending || (surveyValidation?.errors?.length > 0)}
                        data-testid="button-publish-survey"
                      >
                        {publishSurveyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Publish Survey (version {(Number(formData.survey_settings?.current_version) || 0) + 1})
                      </Button>
                      {hasResponses && (
                        <Button
                          variant="outline"
                          onClick={() => duplicateSurveyMutation.mutate()}
                          disabled={duplicateSurveyMutation.isPending}
                          data-testid="button-duplicate-survey-version"
                        >
                          {duplicateSurveyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          Duplicate as New Version
                        </Button>
                      )}
                    </div>
                    {!formId && <p className="text-xs text-slate-500">Save the survey first, then publish.</p>}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          )}

          {/* Events Tab (Task #3331) */}
          {formData.form_type === 'survey' && (
            <TabsContent value="events">
              {formId ? (
                <SurveyEventAssignmentsPanel formId={formId} />
              ) : (
                <Card className="border-slate-200">
                  <CardContent className="py-12 text-center text-slate-500">
                    Save the survey first to assign it to events.
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}

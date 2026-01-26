import { useState, useMemo, useEffect, useRef } from "react";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import FormRenderer from "../../forms/FormRenderer";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Upload, X, Image as ImageIcon, FolderOpen, Folder, Home, Search, FileText, CheckCircle2, Save, Copy, Check, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import { AlignLeft, AlignCenter, AlignRight } from "lucide-react";

const formQuillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    ['link'],
    ['clean']
  ]
};

const fontFamilies = [
  'Poppins',
  'Degular Medium', 
  'Degular Bold',
  'Degular Semibold',
  'Inter',
  'Arial',
  'Georgia',
  'Times New Roman'
];

const fontWeights = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' }
];

// Helper to check if a field value is considered "filled" for validation purposes
const isFieldValueFilled = (field, value) => {
  if (!value) return false;
  
  // Handle Contact composite field type - check required sub-fields
  if (field.type === 'contact') {
    if (typeof value !== 'object') return false;
    // Contact requires firstName, lastName, and email when the field is required
    return !!(value.firstName?.trim() && value.lastName?.trim() && value.email?.trim());
  }
  
  // For arrays (checkbox, list, etc.)
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  
  // For strings
  if (typeof value === 'string') {
    return value.length > 0;
  }
  
  // For booleans (boolean, terms_conditions) - consider any value as "filled"
  if (typeof value === 'boolean') {
    return true;
  }
  
  // For other objects
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  
  return true;
};

const safeHexColor = (color, fallback = '#000000') => {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  return fallback;
};

export default function IEditFormElement({ element, memberInfo, organizationInfo }) {
  const isMobile = useIsMobile();
  const content = element.content || {};
  const formSlug = content.form_slug;
  const [formValues, setFormValues] = useState({});
  const [currentStep, setCurrentStep] = useState(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationErrors, setValidationErrors] = useState([]);
  const [fieldValidity, setFieldValidity] = useState({}); // Track format validity for each field
  
  // Get URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const prefillMemberId = urlParams.get('member_id');
  const prefillOrgId = urlParams.get('organization_id');
  const draftToken = urlParams.get('draft');
  
  // Draft save state
  const [resumeToken, setResumeToken] = useState(draftToken || null);
  const [showResumeLink, setShowResumeLink] = useState(false);
  const [resumeLinkCopied, setResumeLinkCopied] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [schemaChanged, setSchemaChanged] = useState(false);
  const [schemaChangeMessage, setSchemaChangeMessage] = useState(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);

  // Fetch default consent message from public endpoint (works without auth)
  const { data: defaultConsentMessage } = useQuery({
    queryKey: ['formDefaultConsentMessage'],
    queryFn: async () => {
      const data = await publicClient.getFormConsentMessage();
      return data.message || '';
    },
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });
  
  // Track if prefill has been applied and defaults initialized
  const [prefillApplied, setPrefillApplied] = useState(false);
  const [defaultsInitialized, setDefaultsInitialized] = useState(false);
  
  // Track original values BEFORE set_value rules modified them
  const originalValuesRef = useRef({});
  // Track which set_value actions are currently active (condition is true)
  const activeSetValueActionsRef = useRef(new Set());
  // Track the triggered role_id from set_role/clear_role actions
  const triggeredRoleIdRef = useRef(null);
  // Track whether a role action was explicitly triggered
  const roleActionTriggeredRef = useRef(false);
  // Track which role actions were previously active (for transition detection)
  const previousRoleActionsRef = useRef(new Set());

  // Handler for field validity changes from FormRenderer
  const handleValidityChange = (fieldId, isValid) => {
    setFieldValidity(prev => ({ ...prev, [fieldId]: isValid }));
  };

  const {
    anchor,
    heading,
    subheading,
    text_content,
    show_form_title = true,
    show_form_description = true,
    vertical_padding = 48,
    content_max_width = 800,
    background_type = 'color',
    background_color = 'transparent',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    image_url,
    image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    text_color = '#1e293b',
    text_align = 'center'
  } = content;

  const getTextStyle = (prefix) => {
    const fontSize = content[`${prefix}_font_size`] || 16;
    const mobileFontSize = content[`${prefix}_font_size_mobile`];
    
    return {
      fontFamily: content[`${prefix}_font_family`] || 'Poppins',
      fontWeight: content[`${prefix}_font_weight`] || 400,
      fontSize: `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      color: content[`${prefix}_color`] || text_color,
      letterSpacing: `${content[`${prefix}_letter_spacing`] || 0}px`,
      lineHeight: content[`${prefix}_line_height`] || 1.5,
      textAlign: content[`${prefix}_align`] || text_align
    };
  };

  const getFormLabelStyle = () => {
    const fontSize = content.form_label_font_size || 14;
    const mobileFontSize = content.form_label_font_size_mobile;
    
    return {
      '--form-label-font-family': content.form_label_font_family || 'Poppins',
      '--form-label-font-weight': content.form_label_font_weight || 500,
      '--form-label-font-size': `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      '--form-label-color': content.form_label_color || '#334155',
      '--form-label-letter-spacing': `${content.form_label_letter_spacing || 0}px`,
      '--form-label-line-height': content.form_label_line_height || 1.4
    };
  };

  const getFormInputStyle = () => {
    const fontSize = content.form_input_font_size || 14;
    const mobileFontSize = content.form_input_font_size_mobile;
    
    return {
      '--form-input-font-family': content.form_input_font_family || 'Poppins',
      '--form-input-font-weight': content.form_input_font_weight || 400,
      '--form-input-font-size': `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      '--form-input-color': content.form_input_color || '#1e293b',
      '--form-input-letter-spacing': `${content.form_input_letter_spacing || 0}px`,
      '--form-input-line-height': content.form_input_line_height || 1.5
    };
  };

  const formFieldStyles = {
    ...getFormLabelStyle(),
    ...getFormInputStyle()
  };

  const getCardStyle = () => {
    const borderRadius = content.card_border_radius ?? 8;
    const borderEnabled = content.card_border_enabled ?? true;
    const borderWidth = content.card_border_width || 1;
    const borderColor = content.card_border_color || '#e2e8f0';
    const shadowEnabled = content.card_shadow_enabled || false;
    const shadowStyle = content.card_shadow_style || 'medium';
    const shadowColor = content.card_shadow_color || '#000000';
    const shadowOpacity = (content.card_shadow_opacity ?? 10) / 100;
    const backgroundColor = content.card_background_color || '#ffffff';

    const hexToRgba = (hex, alpha) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const shadowPresets = {
      subtle: `0 1px 2px 0 ${hexToRgba(shadowColor, shadowOpacity)}`,
      medium: `0 4px 6px -1px ${hexToRgba(shadowColor, shadowOpacity)}, 0 2px 4px -2px ${hexToRgba(shadowColor, shadowOpacity * 0.5)}`,
      strong: `0 10px 15px -3px ${hexToRgba(shadowColor, shadowOpacity)}, 0 4px 6px -4px ${hexToRgba(shadowColor, shadowOpacity * 0.5)}`,
      xl: `0 20px 25px -5px ${hexToRgba(shadowColor, shadowOpacity)}, 0 8px 10px -6px ${hexToRgba(shadowColor, shadowOpacity * 0.5)}`
    };

    return {
      borderRadius: `${borderRadius}px`,
      border: borderEnabled ? `${borderWidth}px solid ${borderColor}` : 'none',
      boxShadow: shadowEnabled ? shadowPresets[shadowStyle] : 'none',
      backgroundColor: backgroundColor,
      overflow: 'hidden'
    };
  };

  const getBackgroundStyle = () => {
    if (background_type === 'gradient') {
      return {
        background: `linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color})`
      };
    }
    if (background_type === 'image' && image_url) {
      return {
        backgroundImage: `url(${image_url})`,
        backgroundSize: image_fit,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
      };
    }
    return {
      backgroundColor: background_color || 'transparent'
    };
  };

  const { data: form, isLoading } = useQuery({
    queryKey: ['form-embed', formSlug],
    queryFn: async () => {
      if (!formSlug) return null;
      const allForms = await base44.entities.Form.list() || [];
      return allForms.find(f => f.slug === formSlug && f.is_active);
    },
    enabled: !!formSlug
  });

  // Load draft if resume token is in URL
  const { data: draftData } = useQuery({
    queryKey: ['form-draft-embed', draftToken],
    queryFn: async () => {
      const host = window.location.hostname;
      const tenantSlug = host.split('.')[0];
      const response = await fetch(`/api/public/form-draft?token=${encodeURIComponent(draftToken)}&tenant=${tenantSlug}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to load draft');
      }
      return response.json();
    },
    enabled: !!draftToken && !draftLoaded,
    retry: false
  });

  // Apply draft data when loaded
  useEffect(() => {
    if (draftData?.success && !draftLoaded) {
      console.log('[IEditFormElement] Loading draft data:', draftData);
      setFormValues(prev => ({ ...prev, ...draftData.draft.draft_data }));
      if (draftData.draft.current_page_index) {
        setCurrentPageIndex(draftData.draft.current_page_index);
      }
      setDraftLoaded(true);
      if (draftData.schema_changed) {
        setSchemaChanged(true);
        setSchemaChangeMessage(draftData.message);
      }
      toast.success('Your saved progress has been restored');
    }
  }, [draftData, draftLoaded]);

  // Save draft handler
  const handleSaveDraft = async () => {
    if (!form || isSavingDraft) return;
    
    setIsSavingDraft(true);
    try {
      const host = window.location.hostname;
      const tenantSlug = host.split('.')[0];
      
      // Try to find an email field value for contact
      const emailField = form?.fields?.find(f => f.type === 'email');
      const contactEmail = emailField ? formValues[emailField.id] : null;
      
      const payload = {
        form_slug: formSlug,
        form_id: form?.id,
        draft_data: formValues,
        current_page_index: currentPageIndex,
        contact_email: contactEmail,
        resume_token: resumeToken,
        tenant: tenantSlug,
        form_updated_at: form?.updated_at
      };
      
      const response = await fetch('/api/public/form-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save draft');
      }
      
      const result = await response.json();
      console.log('[IEditFormElement] Draft saved:', result);
      setResumeToken(result.resume_token);
      setShowResumeLink(true);
      toast.success('Your progress has been saved!');
    } catch (error) {
      console.error('[IEditFormElement] Draft save error:', error);
      toast.error(error.message || 'Failed to save your progress');
    } finally {
      setIsSavingDraft(false);
    }
  };

  // Generate resume URL - preserve existing query params and add/update draft token
  const getResumeUrl = () => {
    if (!resumeToken) return '';
    const baseUrl = window.location.origin;
    const path = window.location.pathname;
    // Preserve existing query params (like tenant, etc.) and add draft token
    const existingParams = new URLSearchParams(window.location.search);
    existingParams.set('draft', resumeToken);
    return `${baseUrl}${path}?${existingParams.toString()}`;
  };

  // Copy resume link to clipboard
  const copyResumeLink = async () => {
    try {
      await navigator.clipboard.writeText(getResumeUrl());
      setResumeLinkCopied(true);
      setTimeout(() => setResumeLinkCopied(false), 2000);
      toast.success('Link copied to clipboard!');
    } catch (err) {
      toast.error('Failed to copy link');
    }
  };

  // Check if save draft is enabled for this form
  // Save & Continue Later is always enabled for all forms

  // Extract role_id from primary member entity_pipeline for capacity checking
  const primaryMemberRoleId = useMemo(() => {
    const members = form?.entity_pipelines?.members;
    // Try finding by isPrimary (camelCase) or is_primary (snake_case)
    let primaryMember = members?.find(m => m.isPrimary === true || m.is_primary === true);
    if (!primaryMember && members?.length === 1) {
      primaryMember = members[0];
    }
    return primaryMember?.role_id || null;
  }, [form?.entity_pipelines?.members]);

  // Check role capacity before allowing form submission
  const { data: roleCapacity, isLoading: isCheckingCapacity } = useQuery({
    queryKey: ['role-capacity-check-embed', primaryMemberRoleId],
    queryFn: async () => {
      try {
        return await publicClient.getRoleCapacity(primaryMemberRoleId);
      } catch (error) {
        console.error('[IEditFormElement] Failed to check role capacity');
        return { hasCapacity: true }; // Allow form on error (fail open)
      }
    },
    enabled: !!primaryMemberRoleId,
    staleTime: 30 * 1000 // Re-check every 30 seconds
  });

  // Prefill: Fetch member entity when form has prefill_source = 'member'
  const { data: prefillMember } = useQuery({
    queryKey: ['prefill-member-embed', prefillMemberId],
    queryFn: async () => {
      const allMembers = await base44.entities.Member.listAll();
      return allMembers.find(m => m.id === prefillMemberId);
    },
    enabled: !!prefillMemberId && form?.prefill_source === 'member'
  });

  // Prefill: Fetch organization entity when form has prefill_source = 'organization'
  const { data: prefillOrg } = useQuery({
    queryKey: ['prefill-org-embed', prefillOrgId],
    queryFn: async () => {
      const allOrgs = await base44.entities.Organization.listAll();
      return allOrgs.find(o => o.id === prefillOrgId);
    },
    enabled: !!prefillOrgId && form?.prefill_source === 'organization'
  });

  // Prefill: Fetch custom field values for prefill entity
  const { data: prefillCustomFieldValues = [] } = useQuery({
    queryKey: ['prefill-custom-values-embed', form?.prefill_source, prefillMemberId, prefillOrgId],
    queryFn: async () => {
      if (form?.prefill_source === 'member' && prefillMemberId) {
        const values = await base44.entities.MemberPreferenceValue.list({
          filter: { member_id: prefillMemberId }
        });
        return values || [];
      } else if (form?.prefill_source === 'organization' && prefillOrgId) {
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

  // Find the organisation_dropdown field (if any) to determine selected org for domain validation
  const orgDropdownField = useMemo(() => {
    return (form?.fields || []).find(f => f.type === 'organisation_dropdown');
  }, [form?.fields]);

  // Get the selected org ID from either URL prefill or form dropdown selection
  const selectedOrgId = useMemo(() => {
    // First priority: org selected in the organisation_dropdown field
    if (orgDropdownField && formValues[orgDropdownField.id]) {
      return formValues[orgDropdownField.id];
    }
    // Second priority: prefilled org from URL (for organization prefill source)
    if (prefillOrgId) {
      return prefillOrgId;
    }
    return null;
  }, [orgDropdownField, formValues, prefillOrgId]);

  // Fetch the selected organization for domain validation (uses public endpoint for unauthenticated access)
  const { data: selectedOrg } = useQuery({
    queryKey: ['selected-org-for-validation', selectedOrgId],
    queryFn: () => publicClient.getOrganizationDomains(selectedOrgId),
    enabled: !!selectedOrgId,
    staleTime: 5 * 60 * 1000
  });

  // Compute effective organization for email domain validation
  // Priority: selected org from form dropdown > prefill org > passed organizationInfo
  const effectiveOrganizationInfo = useMemo(() => {
    return selectedOrg || prefillOrg || organizationInfo;
  }, [selectedOrg, prefillOrg, organizationInfo]);

  // Reset prefill state and set_value tracking when form changes
  useEffect(() => {
    setCurrentPageIndex(0);
    setCurrentStep(0);
    setSubmitted(false);
    setPrefillApplied(false);
    setDefaultsInitialized(false);
    setFormValues({});
    // Reset set_value and role tracking refs
    originalValuesRef.current = {};
    activeSetValueActionsRef.current = new Set();
    triggeredRoleIdRef.current = null;
    roleActionTriggeredRef.current = false;
    previousRoleActionsRef.current = new Set();
  }, [form?.id]);

  // Initialize boolean fields and hidden fields with their default values when form loads
  // This ensures untouched boolean fields and hidden fields are included in the submission
  useEffect(() => {
    if (!form?.fields || defaultsInitialized) return;
    
    const fieldDefaults = {};
    for (const field of form.fields) {
      if (field.type === 'boolean') {
        fieldDefaults[field.id] = field.default_value === true ? true : false;
      }
      if (field.type === 'terms_conditions') {
        fieldDefaults[field.id] = false;
      }
      // Initialize hidden fields so they're included in form submission
      // This ensures hidden fields mapped to entity_pipelines have their values available
      // Fields with starts_hidden need to be initialized even without default_value
      // so that set_value rules can populate them
      // Skip boolean fields as they're already handled above with proper false default
      if ((field.starts_hidden === true || field.starts_hidden === 'true') && field.type !== 'boolean') {
        // Only initialize if not already set (preserve earlier defaults)
        if (fieldDefaults[field.id] === undefined) {
          if (field.default_value !== undefined && field.default_value !== null && field.default_value !== '') {
            fieldDefaults[field.id] = field.default_value;
            console.log(`[IEditFormElement Init] Hidden field "${field.label}" (${field.id}) initialized with default_value:`, field.default_value);
          } else {
            // Initialize with empty string so set_value rules can populate it
            fieldDefaults[field.id] = '';
            console.log(`[IEditFormElement Init] Hidden field "${field.label}" (${field.id}) initialized with empty string (no default_value)`);
          }
        }
      }
    }
    
    if (Object.keys(fieldDefaults).length > 0) {
      setFormValues(prev => ({ ...prev, ...fieldDefaults }));
    }
    setDefaultsInitialized(true);
  }, [form?.fields, defaultsInitialized]);

  // Prefill: Populate form values when prefill entity loads (one-time only)
  useEffect(() => {
    if (!form || !form.prefill_source || form.prefill_source === 'none') return;
    if (!defaultsInitialized) return; // Wait for boolean defaults to be set first
    if (prefillApplied) return; // Already applied prefill, don't overwrite user edits
    
    const entity = form.prefill_source === 'member' ? prefillMember : prefillOrg;
    if (!entity) return;
    
    const newValues = {};
    for (const field of (form.fields || [])) {
      // Special handling for organisation_dropdown: always use the entity's ID
      if (field.type === 'organisation_dropdown') {
        if (form.prefill_source === 'organization' && prefillOrgId) {
          newValues[field.id] = prefillOrgId;
        } else if (form.prefill_source === 'member' && entity.organization_id) {
          newValues[field.id] = entity.organization_id;
        }
        continue;
      }
      
      if (field.prefill_field) {
        // Check if custom field (prefixed with 'custom:')
        if (field.prefill_field.startsWith('custom:')) {
          const customFieldId = field.prefill_field.replace('custom:', '');
          const cfv = prefillCustomFieldValues.find(v => v.field_id === customFieldId);
          if (cfv && cfv.value !== undefined && cfv.value !== null) {
            let parsedValue = cfv.value;
            // For list fields, custom field values are stored as JSON strings
            if (field.type === 'list') {
              try {
                const parsed = JSON.parse(cfv.value);
                parsedValue = Array.isArray(parsed) ? parsed : [cfv.value];
              } catch {
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
      setFormValues(prev => {
        const merged = { ...prev };
        for (const [key, value] of Object.entries(newValues)) {
          const field = form.fields?.find(f => f.id === key);
          // For boolean fields, always allow prefill to override defaults
          if (field?.type === 'boolean') {
            merged[key] = value;
          }
          // For non-boolean fields, only prefill if empty/null/undefined
          else if (prev[key] === undefined || prev[key] === '' || prev[key] === null) {
            merged[key] = value;
          }
        }
        return merged;
      });
      setPrefillApplied(true);
    }
  }, [form, prefillMember, prefillOrg, prefillCustomFieldValues, prefillApplied, defaultsInitialized, prefillOrgId]);

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
  // Also check visibility_rules for legacy forms without starts_hidden
  const initialHiddenFieldIds = useMemo(() => {
    const hidden = new Set();
    
    // First, check field.starts_hidden (newer forms)
    for (const field of (form?.fields || [])) {
      if (field.starts_hidden) {
        hidden.add(field.id);
      }
    }
    
    // Also check legacy visibility_rules (always, not just as fallback)
    if (form?.visibility_rules?.length > 0) {
      for (const rule of form.visibility_rules) {
        // Handle new multi-action format
        if (rule.actions && Array.isArray(rule.actions)) {
          for (const action of rule.actions) {
            // Handle consolidated visibility action format
            if (action.action_type === 'visibility' && action.field_states) {
              for (const [fieldId, state] of Object.entries(action.field_states)) {
                // If visible is explicitly true, field starts hidden (needs condition to show)
                if (state.visible === true) {
                  hidden.add(fieldId);
                }
              }
            }
            // Handle legacy show action format
            else if (action.action_type === 'show' && action.target_field_ids?.length) {
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
  const hiddenFieldIds = useMemo(() => {
    const hidden = new Set(initialHiddenFieldIds);
    
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      return hidden;
    }
    
    const fieldVisibility = {};
    
    for (const rule of form.visibility_rules) {
      if (!rule.trigger_field_id) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      const conditionMet = evaluateCondition(triggerValue, rule.operator, rule.value);

      // Handle new multi-action format
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          // Handle consolidated visibility action format
          if (action.action_type === 'visibility' && action.field_states) {
            for (const [fieldId, state] of Object.entries(action.field_states)) {
              if (!fieldVisibility[fieldId]) {
                fieldVisibility[fieldId] = { showRules: [], hideRules: [] };
              }
              // visible: true means "show when condition met" (starts hidden)
              // visible: false means "hide when condition met" (starts visible)
              if (state.visible === true) {
                fieldVisibility[fieldId].showRules.push(conditionMet);
              } else if (state.visible === false) {
                fieldVisibility[fieldId].hideRules.push(conditionMet);
              }
            }
          }
          // Handle legacy show/hide action format
          else if (action.action_type === 'show' || action.action_type === 'hide') {
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
      const anyShowConditionMet = showRules.some(result => result === true);
      if (anyShowConditionMet) {
        hidden.delete(fieldId);
      }
      
      const anyHideConditionMet = hideRules.some(result => result === true);
      if (anyHideConditionMet) {
        hidden.add(fieldId);
      }
    }
    
    return hidden;
  }, [form?.visibility_rules, formValues, initialHiddenFieldIds]);

  // Helper to filter visible fields
  // Also excludes due_diligence fields which should not be shown to end users
  const filterVisibleFields = (fields) => {
    return fields.filter(field => !hiddenFieldIds.has(field.id) && !field.due_diligence);
  };

  // Compute initial disabled fields from field.starts_disabled property
  const initialDisabledFieldIds = useMemo(() => {
    const disabled = new Set();
    
    for (const field of (form?.fields || [])) {
      if (field.starts_disabled) {
        disabled.add(field.id);
      }
    }
    
    return disabled;
  }, [form?.fields]);

  // Evaluate disable/enable rules to determine which fields should be disabled
  const disabledFieldIds = useMemo(() => {
    const disabled = new Set(initialDisabledFieldIds);
    
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      return disabled;
    }
    
    const fieldDisability = {};
    
    for (const rule of form.visibility_rules) {
      if (!rule.trigger_field_id) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      const conditionMet = evaluateCondition(triggerValue, rule.operator, rule.value);

      // Handle new multi-action format
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          // Handle consolidated visibility action format
          if (action.action_type === 'visibility' && action.field_states) {
            for (const [fieldId, state] of Object.entries(action.field_states)) {
              if (!fieldDisability[fieldId]) {
                fieldDisability[fieldId] = { enableRules: [], disableRules: [] };
              }
              // enabled: true means "enable when condition met" (starts disabled)
              // enabled: false means "disable when condition met" (starts enabled)
              if (state.enabled === true) {
                fieldDisability[fieldId].enableRules.push(conditionMet);
              } else if (state.enabled === false) {
                fieldDisability[fieldId].disableRules.push(conditionMet);
              }
            }
          }
          // Handle legacy enable/disable action format
          else if (action.action_type === 'enable' || action.action_type === 'disable') {
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
      const anyEnableConditionMet = enableRules.some(result => result === true);
      if (anyEnableConditionMet) {
        disabled.delete(fieldId);
      }
      
      const anyDisableConditionMet = disableRules.some(result => result === true);
      if (anyDisableConditionMet) {
        disabled.add(fieldId);
      }
    }
    
    return disabled;
  }, [form?.visibility_rules, formValues, initialDisabledFieldIds]);

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

  // Process Set Value rules - when conditions are met, update target field values
  // When conditions become false, revert to original values (undo the action)
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
                  console.log(`[IEditFormElement] set_value: ${action.target_field_id} = "${valueToSet}"`);
                }
              }
              // For field-source actions that are already active, continuously sync with source field
              else if ((action.set_value_source || 'static') === 'field' && action.set_value_field_id) {
                const sourceValue = formValues[action.set_value_field_id];
                const currentTargetValue = formValues[action.target_field_id];
                // Only update if source changed and target doesn't match
                if (sourceValue !== currentTargetValue && sourceValue !== null && sourceValue !== undefined) {
                  updates[action.target_field_id] = sourceValue;
                  console.log(`[IEditFormElement] set_value sync: ${action.target_field_id} = "${sourceValue}"`);
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
              console.log(`[IEditFormElement] legacy set_value: ${rule.target_field_id} = "${valueToSet}"`);
            }
          }
          // For field-source rules that are already active, continuously sync with source field
          else if ((rule.set_value_source || 'static') === 'field' && rule.set_value_field_id) {
            const sourceValue = formValues[rule.set_value_field_id];
            const currentTargetValue = formValues[rule.target_field_id];
            // Only update if source changed and target doesn't match
            if (sourceValue !== currentTargetValue && sourceValue !== null && sourceValue !== undefined) {
              updates[rule.target_field_id] = sourceValue;
              console.log(`[IEditFormElement] legacy set_value sync: ${rule.target_field_id} = "${sourceValue}"`);
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
      console.log('[IEditFormElement] Applying set_value updates:', updates);
      setFormValues(prev => ({ ...prev, ...updates }));
    }
    
    // Process set_role and clear_role actions with transition detection
    const nowActiveRoleActions = new Set();
    
    for (const rule of form.visibility_rules) {
      if (!rule.trigger_field_id) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      const conditionMet = evaluateCondition(triggerValue, rule.operator, rule.value);
      
      if (conditionMet && rule.actions && Array.isArray(rule.actions)) {
        rule.actions.forEach((action, actionIndex) => {
          if (action.action_type === 'set_role' || action.action_type === 'clear_role') {
            const actionKey = action.id || `${rule.id}:role:${actionIndex}`;
            nowActiveRoleActions.add(actionKey);
            
            // Only apply if this action just became active (transition detection)
            if (!previousRoleActionsRef.current.has(actionKey)) {
              if (action.action_type === 'set_role' && action.role_id) {
                triggeredRoleIdRef.current = action.role_id;
                roleActionTriggeredRef.current = true;
                console.log('[IEditFormElement] set_role action triggered, role_id:', action.role_id);
              } else if (action.action_type === 'clear_role') {
                triggeredRoleIdRef.current = null;
                roleActionTriggeredRef.current = true;
                console.log('[IEditFormElement] clear_role action triggered');
              }
            }
          }
        });
      }
    }
    
    // Update previous state for next render
    previousRoleActionsRef.current = nowActiveRoleActions;
  }, [form?.visibility_rules, formValues, prefillMember, prefillOrg, prefillCustomFieldValues, form?.prefill_source]);

  // Page navigation helpers for standard layout with pages
  const pages = form?.pages || [];
  const hasPages = pages.length > 0 && form?.layout_type === 'standard';

  const getCurrentPageFields = () => {
    if (!hasPages) {
      return form?.fields || [];
    }
    const currentPage = pages[currentPageIndex];
    if (currentPageIndex === 0) {
      return (form?.fields || []).filter(f => f.page_id === currentPage?.id || !f.page_id);
    }
    return (form?.fields || []).filter(f => f.page_id === currentPage?.id);
  };

  const validateCurrentPage = () => {
    const pageFields = filterVisibleFields(getCurrentPageFields());
    const missingFields = pageFields.filter(field => 
      field.required && !isFieldValueFilled(field, formValues[field.id])
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

  const submitFormMutation = useMutation({
    mutationFn: async (data) => {
      return base44.entities.FormSubmission.create(data);
    },
    onSuccess: async (submissionResult) => {
      // Track created member/org IDs from process-application for email placeholders
      let createdMemberId = null;
      let createdOrganizationId = null;
      
      // Process entity pipelines if configured (create/update member/org entities)
      const hasEntityPipelines = (form?.entity_pipelines?.members?.length > 0) || (form?.entity_pipelines?.organisations?.length > 0);
      if (hasEntityPipelines) {
        try {
          const response = await fetch('/api/forms/process-application', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              form_id: form.id,
              form_values: formValues,
              fields: form.fields,
              field_mappings: form.field_mappings || [],
              application_level: form.application_level || 'member',
              create_entity_type: form.create_entity_type || 'member',
              submission_id: submissionResult?.id,
              prefill_organization_id: effectiveOrganizationInfo?.id || null,
              role_id: form.default_member_role_id || null,
              // Pass entity pipelines configuration (unified structure)
              entity_pipelines: form.entity_pipelines || { members: [], organisations: [] },
              // Legacy fallback fields for backward compatibility
              member_entity_action: form.member_entity_action || 'none',
              organization_entity_action: form.organization_entity_action || 'none',
              additional_member_creations: form.additional_member_creations || []
            })
          });
          if (response.ok) {
            const result = await response.json();
            console.log('[IEditFormElement] Application processed:', result);
            // Capture created member/org IDs for email placeholders
            createdMemberId = result.created_member_id || null;
            createdOrganizationId = result.created_organization_id || null;
          } else {
            const error = await response.json();
            console.error('[IEditFormElement] Application processing failed:', error);
          }
        } catch (error) {
          console.error('[IEditFormElement] Error processing application:', error);
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
              console.log('[IEditFormElement] CRM field mappings processed');
            } else if (response.status === 401) {
              console.log('[IEditFormElement] Field mappings skipped - user not authenticated');
            }
          } catch (error) {
            console.error('[IEditFormElement] Error processing field mappings:', error);
          }
        }
      }
      
      // Send submission email if configured
      // ALWAYS call the server endpoint for diagnostic logging (server decides if email is configured)
      try {
        console.log('[IEditFormElement] Calling email endpoint for form submission...');
        console.log('[IEditFormElement] Passing createdMemberId:', createdMemberId, 'createdOrganizationId:', createdOrganizationId);
        const emailPayload = {
          form_id: form.id,
          submission_id: submissionResult?.id,
          form_values: formValues,
          fields: form.fields,
          // Pass created member/org IDs for placeholder resolution
          created_member_id: createdMemberId,
          created_organization_id: createdOrganizationId,
          // Pass client-side form data for server-side diagnostic logging
          _debug_form_email_config: {
            hasSubmissionEmails: !!form?.submission_emails,
            submissionEmailsCount: form?.submission_emails?.length || 0,
            submissionEmailsValue: form?.submission_emails || null,
            legacyTemplateId: form?.submission_email_template_id || null,
            legacyRecipient: form?.submission_email_recipient || null
          }
        };
        console.log('[IEditFormElement] Email payload:', JSON.stringify(emailPayload, null, 2));
        
        const emailResponse = await fetch('/api/forms/send-submission-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload)
        });
        console.log('[IEditFormElement] Email response status:', emailResponse.status);
        const emailResult = await emailResponse.json();
        console.log('[IEditFormElement] Submission email result:', emailResult);
      } catch (error) {
        console.error('[IEditFormElement] Error sending submission email:', error);
        // Don't fail the submission if email fails
      }
      
      setSubmitted(true);
      if (form?.redirect_url) {
        setTimeout(() => {
          window.location.href = form.redirect_url;
        }, 2000);
      }
    },
    onError: (error) => {
      toast.error("Failed to submit form. Please try again.");
      console.error("Form submission error:", error);
    }
  });

  const handleSubmit = async () => {
    if (!form) return;
    
    // Clear any previous validation errors
    setValidationErrors([]);
    
    // Validate required fields - only check VISIBLE fields (skip hidden ones)
    const visibleFields = filterVisibleFields(form.fields);
    const missingFields = visibleFields.filter(field => 
      field.required && !isFieldValueFilled(field, formValues[field.id])
    );

    if (missingFields.length > 0) {
      const errors = missingFields.map(f => `Please fill in the required field: ${f.label}`);
      setValidationErrors(errors);
      toast.error(`Please fill in all required fields: ${missingFields.map(f => f.label).join(', ')}`);
      return;
    }

    // Validate terms_conditions fields - must be toggled to true before submission
    // Accept both boolean true and string "true" for compatibility
    const termsFields = visibleFields.filter(field => field.type === 'terms_conditions');
    const unacceptedTerms = termsFields.filter(field => {
      const val = formValues[field.id];
      return val !== true && val !== 'true';
    });
    if (unacceptedTerms.length > 0) {
      const errors = unacceptedTerms.map(f => `Please accept: ${f.label}`);
      setValidationErrors(errors);
      toast.error(`Please accept the terms and conditions: ${unacceptedTerms.map(f => f.label).join(', ')}`);
      return;
    }

    // Uniqueness validation (runs if uniqueness checks are configured)
    if (form.uniqueness_checks && form.uniqueness_checks.length > 0) {
      setIsValidating(true);
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
          const errors = result.conflicts.map(c => c.message);
          setValidationErrors(errors);
          toast.error(`Validation failed: ${errors.join(', ')}`);
          setIsValidating(false);
          return;
        }
      } catch (error) {
        console.error('[IEditFormElement] Uniqueness validation error:', error);
        setValidationErrors(['Unable to validate form. Please try again.']);
        toast.error('Unable to validate form. Please try again.');
        setIsValidating(false);
        return;
      }
      setIsValidating(false);
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" style={getBackgroundStyle()}>
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="flex items-center justify-center py-12" style={getBackgroundStyle()}>
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600">Form not found or inactive</p>
        </div>
      </div>
    );
  }

  // Check if still loading capacity
  if (primaryMemberRoleId && isCheckingCapacity) {
    return (
      <div className="flex items-center justify-center py-12" style={getBackgroundStyle()}>
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Check if role is at capacity - show message instead of form
  if (primaryMemberRoleId && roleCapacity && !roleCapacity.hasCapacity) {
    return (
      <div className="flex items-center justify-center py-12" style={getBackgroundStyle()}>
        <Card className="max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl text-slate-800">Registration Closed</CardTitle>
          </CardHeader>
          <CardContent className="p-6 text-center">
            <p className="text-slate-600">
              {roleCapacity.roleName 
                ? `The ${roleCapacity.roleName} role has reached its maximum capacity of ${roleCapacity.maxMembers} members.`
                : `This registration has reached its maximum capacity.`
              }
            </p>
            <p className="text-slate-500 text-sm mt-4">
              Please contact the administrator for more information.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isSubmitting = submitFormMutation.isPending || isValidating;

  const renderHeaderSection = () => {
    const hasHeaderContent = heading || subheading || text_content;
    if (!hasHeaderContent) return null;

    return (
      <div className="space-y-4 mb-8" style={{ textAlign: text_align }}>
        {heading && (
          <div 
            style={getTextStyle('heading')} 
            className="prose max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(heading) }}
          />
        )}
        {subheading && (
          <div 
            style={getTextStyle('subheading')} 
            className="prose max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading) }}
          />
        )}
        {text_content && (
          <div 
            className="prose max-w-none mx-auto" 
            style={getTextStyle('text_content')}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text_content) }}
          />
        )}
      </div>
    );
  };

  const containerStyle = {
    ...getBackgroundStyle(),
    paddingTop: `${vertical_padding}px`,
    paddingBottom: `${vertical_padding}px`,
    position: 'relative'
  };

  if (submitted) {
    return (
      <div id={anchor || undefined} style={containerStyle}>
        <div className="relative mx-auto px-4" style={{ maxWidth: `${content_max_width}px` }}>
          <Card style={getCardStyle()}>
            <CardContent className="p-12 text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Success!</h3>
              <p className="text-slate-600">{form.success_message || 'Your form has been submitted successfully.'}</p>
              {form.redirect_url && (
                <p className="text-sm text-slate-500 mt-4">Redirecting...</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (form.layout_type === 'card_swipe') {
    const visibleFields = filterVisibleFields(form.fields);
    const currentField = visibleFields[currentStep];
    const isLastStep = currentStep === visibleFields.length - 1;
    
    // Check if field has a value (for required check)
    const hasValue = formValues[currentField?.id];
    // Check if field passes format validation (default to true if not tracked)
    const isFormatValid = fieldValidity[currentField?.id] !== false;
    // Can proceed if: (not required OR has value) AND format is valid
    const canProceed = (!currentField?.required || hasValue) && isFormatValid;

    return (
      <div id={anchor || undefined} style={containerStyle}>
        {background_type === 'image' && overlay_enabled && (
          <div 
            className="absolute inset-0" 
            style={{ 
              backgroundColor: overlay_color, 
              opacity: overlay_opacity / 100 
            }} 
          />
        )}
        <div 
          className="relative mx-auto px-4"
          style={{ maxWidth: `${content_max_width}px` }}
        >
          {renderHeaderSection()}
          <Card className="iedit-form-styled !rounded-none" style={{ ...formFieldStyles, ...getCardStyle() }}>
            {(show_form_title || show_form_description) && (
              <CardHeader>
                {show_form_title && <CardTitle>{form.name}</CardTitle>}
                {show_form_description && form.description && (
                  <CardDescription className="whitespace-pre-line">{form.description}</CardDescription>
                )}
                <div className="flex gap-1 mt-4">
                  {visibleFields.map((_, index) => (
                    <div
                      key={index}
                      className={`h-1 flex-1 rounded ${
                        index <= currentStep ? 'bg-blue-600' : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
              </CardHeader>
            )}
            {!show_form_title && !show_form_description && (
              <div className="px-6 pt-6">
                <div className="flex gap-1">
                  {visibleFields.map((_, index) => (
                    <div
                      key={index}
                      className={`h-1 flex-1 rounded ${
                        index <= currentStep ? 'bg-blue-600' : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}
            <CardContent className="min-h-[300px] pt-8">
              {currentField && (
                <FormRenderer
                  key={currentStep}
                  field={currentField}
                  value={formValues[currentField.id]}
                  onChange={(value) => setFormValues({ ...formValues, [currentField.id]: value })}
                  memberInfo={memberInfo}
                  organizationInfo={effectiveOrganizationInfo}
                  disabled={disabledFieldIds.has(currentField.id)}
                  onValidityChange={handleValidityChange}
                  autoFocus={['text', 'email', 'url', 'number', 'tel', 'textarea'].includes(currentField.type)}
                />
              )}
              {!canProceed && !isFormatValid && (
                <p className="text-sm text-amber-600 text-center mt-4">
                  Please fix the format error above to continue
                </p>
              )}
              {validationErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mt-6">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-medium text-red-800 mb-1">Unable to submit application</h4>
                      <ul className="text-sm text-red-700 space-y-1">
                        {validationErrors.map((error, index) => (
                          <li key={index}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
            <div className="p-6 pt-0 flex flex-col gap-2">
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
                    disabled={!canProceed || isSubmitting}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      form.submit_button_text || 'Submit'
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
              {isLastStep && defaultConsentMessage && (
                <p className="text-xs text-slate-500 text-center mt-2" data-testid="text-consent-message">
                  {defaultConsentMessage}
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div id={anchor || undefined} style={containerStyle}>
      {background_type === 'image' && overlay_enabled && (
        <div 
          className="absolute inset-0" 
          style={{ 
            backgroundColor: overlay_color, 
            opacity: overlay_opacity / 100 
          }} 
        />
      )}
      <div 
        className="relative mx-auto px-4"
        style={{ maxWidth: `${content_max_width}px` }}
      >
        {renderHeaderSection()}
        <Card className="iedit-form-styled !rounded-none" style={{ ...formFieldStyles, ...getCardStyle() }}>
          <CardHeader>
            {show_form_title && <CardTitle>{form.name}</CardTitle>}
            {show_form_description && form.description && (
              <CardDescription className="whitespace-pre-line">{form.description}</CardDescription>
            )}
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
            {(() => {
              const columnCount = currentPage?.column_count || 1;
              
              const unassignedFields = currentPageIndex === 0 
                ? displayFields.filter(f => !f.page_id) 
                : [];
              const pageAssignedFields = displayFields.filter(f => 
                f.page_id === currentPage?.id
              );
              
              if (columnCount === 1 || !hasPages) {
                return displayFields.map(field => (
                  <FormRenderer
                    key={field.id}
                    field={field}
                    value={formValues[field.id]}
                    onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                    memberInfo={memberInfo}
                    organizationInfo={effectiveOrganizationInfo}
                    disabled={disabledFieldIds.has(field.id)}
                    onValidityChange={handleValidityChange}
                  />
                ));
              }
              
              const gridClass = columnCount === 2 
                ? 'grid grid-cols-1 md:grid-cols-2 gap-4' 
                : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4';
              
              return (
                <>
                  {unassignedFields.length > 0 && (
                    <div className="space-y-4 mb-4">
                      {unassignedFields.map(field => (
                        <FormRenderer
                          key={field.id}
                          field={field}
                          value={formValues[field.id]}
                          onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                          memberInfo={memberInfo}
                          organizationInfo={effectiveOrganizationInfo}
                          disabled={disabledFieldIds.has(field.id)}
                          onValidityChange={handleValidityChange}
                        />
                      ))}
                    </div>
                  )}
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
                              memberInfo={memberInfo}
                              organizationInfo={effectiveOrganizationInfo}
                              disabled={disabledFieldIds.has(field.id)}
                              onValidityChange={handleValidityChange}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
            {/* Schema change warning */}
            {schemaChanged && schemaChangeMessage && (
              <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-md mb-4">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium">Form has been updated</p>
                  <p className="text-amber-700">{schemaChangeMessage}</p>
                </div>
              </div>
            )}
            
            {/* Resume link display */}
            {showResumeLink && resumeToken && (
              <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md">
                <p className="text-sm font-medium text-green-800 mb-2">Your progress has been saved!</p>
                <p className="text-xs text-green-700 mb-3">
                  Copy this link to continue later. Your draft will be available for 30 days.
                </p>
                <div className="flex items-center gap-2">
                  <input 
                    type="text" 
                    readOnly 
                    value={getResumeUrl()} 
                    className="flex-1 text-xs bg-white border border-green-300 rounded px-2 py-1.5 text-slate-600"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={copyResumeLink}
                    className="shrink-0"
                  >
                    {resumeLinkCopied ? (
                      <Check className="w-4 h-4 text-green-600" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}
            
            {validationErrors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-medium text-red-800 mb-1">Unable to submit application</h4>
                    <ul className="text-sm text-red-700 space-y-1">
                      {validationErrors.map((error, index) => (
                        <li key={index}>{error}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
            <div className="flex justify-between pt-4 gap-2 flex-wrap">
              {hasPages && !isFirstPage ? (
                <Button
                  variant="outline"
                  onClick={goToPreviousPage}
                  data-testid="button-previous-page"
                >
                  <ChevronLeft className="w-4 h-4 mr-2" />
                  Previous
                </Button>
              ) : (
                <div />
              )}
              
              <div className="flex gap-2 flex-wrap">
                {/* Save & Continue Later button */}
                {(
                  <Button
                    variant="outline"
                    onClick={handleSaveDraft}
                    disabled={isSavingDraft}
                    data-testid="button-save-draft"
                  >
                    {isSavingDraft ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        Save & Continue Later
                      </>
                    )}
                  </Button>
                )}
                
                {isLastPage ? (
                  <Button 
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-submit-form"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      form.submit_button_text || 'Submit'
                    )}
                  </Button>
                ) : (
                  <Button
                    onClick={goToNextPage}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="w-4 h-4 ml-2" />
                  </Button>
                )}
              </div>
            </div>
            {(isLastPage || !hasPages) && defaultConsentMessage && (
              <p className="text-xs text-slate-500 text-center mt-2" data-testid="text-consent-message">
                {defaultConsentMessage}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function IEditFormElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [expandedSections, setExpandedSections] = useState({
    formSelection: true,
    background: false,
    headerContent: false,
    formFieldsTypography: false,
    appearance: false
  });
  const [isUploading, setIsUploading] = useState(false);
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [fileSelectorFolder, setFileSelectorFolder] = useState(null);
  const [fileSelectorExpandedFolders, setFileSelectorExpandedFolders] = useState({});
  const [fileSelectorPage, setFileSelectorPage] = useState(1);
  const [fileSelectorItemsPerPage] = useState(12);
  const [fileSelectorSearch, setFileSelectorSearch] = useState("");

  const backgroundType = content.background_type || 'color';
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  const { data: forms = [] } = useQuery({
    queryKey: ['forms-list-editor'],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list() || [];
      return allForms.filter(f => f.is_active);
    }
  });

  const { data: repositoryFiles = [] } = useQuery({
    queryKey: ['file-repository'],
    queryFn: () => base44.entities.FileRepository.list(),
    staleTime: 0,
  });

  const { data: fileRepositoryFolders = [] } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('display_order'),
    staleTime: 0,
  });

  const fileSelectorFolderHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return fileRepositoryFolders
        .filter(f => f.parent_folder_id === parentId)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(folder => ({
          ...folder,
          children: buildTree(folder.id)
        }));
    };
    return buildTree(null);
  }, [fileRepositoryFolders]);

  const getFileSelectorBreadcrumb = (folderId) => {
    if (!folderId) return [];
    const trail = [];
    let currentId = folderId;
    while (currentId) {
      const folder = fileRepositoryFolders.find(f => f.id === currentId);
      if (folder) {
        trail.unshift(folder);
        currentId = folder.parent_folder_id;
      } else {
        break;
      }
    }
    return trail;
  };

  const fileSelectorBreadcrumb = useMemo(() => getFileSelectorBreadcrumb(fileSelectorFolder), [fileSelectorFolder, fileRepositoryFolders]);

  const filteredRepositoryFiles = useMemo(() => {
    return repositoryFiles.filter(file => {
      const matchesFolder = fileSelectorFolder === null
        ? !file.folder_id
        : file.folder_id === fileSelectorFolder;
      const matchesSearch = !fileSelectorSearch || 
        file.file_name?.toLowerCase().includes(fileSelectorSearch.toLowerCase()) ||
        file.description?.toLowerCase().includes(fileSelectorSearch.toLowerCase());
      return matchesFolder && matchesSearch && file.file_type === 'image';
    });
  }, [repositoryFiles, fileSelectorFolder, fileSelectorSearch]);

  const fileSelectorTotalPages = Math.ceil(filteredRepositoryFiles.length / fileSelectorItemsPerPage);
  const fileSelectorStartIndex = (fileSelectorPage - 1) * fileSelectorItemsPerPage;
  const paginatedRepositoryFiles = filteredRepositoryFiles.slice(fileSelectorStartIndex, fileSelectorStartIndex + fileSelectorItemsPerPage);

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
  };

  const handleImageUpload = async (file) => {
    if (!file) return;
    setIsUploading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      updateContent('image_url', file_url);
    } catch (error) {
      console.error('Failed to upload image:', error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSelectFile = (fileUrl) => {
    updateContent('image_url', fileUrl);
    setShowFileSelector(false);
    setFileSelectorFolder(null);
    setFileSelectorSearch("");
    setFileSelectorPage(1);
  };

  const toggleFileSelectorFolder = (folderId) => {
    setFileSelectorExpandedFolders(prev => ({ ...prev, [folderId]: !prev[folderId] }));
  };

  const renderFileSelectorFolderTree = (folders, level = 0) => {
    return folders.map(folder => {
      const isExpanded = fileSelectorExpandedFolders[folder.id];
      const hasChildren = folder.children && folder.children.length > 0;
      const fileCount = repositoryFiles.filter(f => f.folder_id === folder.id && f.file_type === 'image').length;

      return (
        <div key={folder.id} style={{ marginLeft: `${level * 12}px` }}>
          <div
            className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
              fileSelectorFolder === folder.id ? 'bg-blue-100' : 'hover:bg-slate-100'
            }`}
            onClick={() => setFileSelectorFolder(folder.id)}
          >
            {hasChildren ? (
              <button
                onClick={(e) => { e.stopPropagation(); toggleFileSelectorFolder(folder.id); }}
                className="p-0.5 hover:bg-slate-200 rounded"
              >
                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
            ) : (
              <span className="w-4" />
            )}
            {isExpanded ? <FolderOpen className="w-4 h-4 text-slate-600" /> : <Folder className="w-4 h-4 text-slate-600" />}
            <span className="flex-1 text-sm">{folder.name}</span>
            <span className="text-xs text-slate-500">({fileCount})</span>
          </div>
          {hasChildren && isExpanded && renderFileSelectorFolderTree(folder.children, level + 1)}
        </div>
      );
    });
  };

  const AlignmentButtons = ({ value, onAlignChange, testIdPrefix = 'align' }) => (
    <div className="flex gap-1">
      {[
        { val: 'left', Icon: AlignLeft },
        { val: 'center', Icon: AlignCenter },
        { val: 'right', Icon: AlignRight }
      ].map(({ val, Icon }) => (
        <button
          key={val}
          type="button"
          onClick={() => onAlignChange(val)}
          data-testid={`button-${testIdPrefix}-${val}`}
          className={`p-2 rounded border ${
            value === val 
              ? 'bg-blue-600 text-white border-blue-600' 
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
          }`}
        >
          <Icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );

  const renderTypographyControls = (prefix, label) => (
    <div className="space-y-3 border-t pt-3 mt-3">
      <Label className="text-sm font-medium">{label} Typography</Label>
      
      <TypographyStyleSelector
        value={content[`${prefix}_typography_style_id`] || null}
        onChange={(styleId, style) => {
          const updates = { [`${prefix}_typography_style_id`]: styleId };
          if (style) {
            const mapped = applyTypographyStyle(style);
            if (mapped.font_family) updates[`${prefix}_font_family`] = mapped.font_family;
            if (mapped.font_size) updates[`${prefix}_font_size`] = mapped.font_size;
            if (mapped.font_size_mobile) updates[`${prefix}_font_size_mobile`] = mapped.font_size_mobile;
            if (mapped.font_weight) updates[`${prefix}_font_weight`] = mapped.font_weight;
            if (mapped.line_height) updates[`${prefix}_line_height`] = mapped.line_height;
            if (mapped.letter_spacing) updates[`${prefix}_letter_spacing`] = mapped.letter_spacing;
            if (mapped.color) updates[`${prefix}_color`] = mapped.color;
          }
          updateMultipleContent(updates);
        }}
      />

      <div className="flex items-center justify-between">
        <Label className="text-xs">Alignment</Label>
        <AlignmentButtons
          value={content[`${prefix}_align`] || 'center'}
          onAlignChange={(val) => updateContent(`${prefix}_align`, val)}
          testIdPrefix={`${prefix}-align`}
        />
      </div>

      <div>
        <Label className="text-xs mb-1 block">Text Color</Label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={safeHexColor(content[`${prefix}_color`], '#1e293b')}
            onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
            className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
          />
          <Input
            type="text"
            value={content[`${prefix}_color`] || '#1e293b'}
            onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
            className="flex-1 font-mono text-xs h-8"
            placeholder="#1e293b"
          />
        </div>
      </div>
      
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Manual Font Settings</summary>
        <div className="mt-2 space-y-2 pl-2 border-l-2 border-slate-200">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Font Family</Label>
              <select
                value={content[`${prefix}_font_family`] || 'Poppins'}
                onChange={(e) => updateContent(`${prefix}_font_family`, e.target.value)}
                className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
              >
                {fontFamilies.map(font => (
                  <option key={font} value={font}>{font}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Weight</Label>
              <select
                value={content[`${prefix}_font_weight`] || 400}
                onChange={(e) => updateContent(`${prefix}_font_weight`, parseInt(e.target.value))}
                className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
              >
                {fontWeights.map(w => (
                  <option key={w.value} value={w.value}>{w.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Size (px)</Label>
              <Input
                type="number"
                value={content[`${prefix}_font_size`] || 16}
                onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value))}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Mobile Size (px)</Label>
              <Input
                type="number"
                value={content[`${prefix}_font_size_mobile`] || ''}
                onChange={(e) => updateContent(`${prefix}_font_size_mobile`, e.target.value ? parseInt(e.target.value) : null)}
                placeholder="Same"
                className="h-8"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Line Height</Label>
              <Input
                type="number"
                step="0.1"
                value={content[`${prefix}_line_height`] || 1.5}
                onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value))}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Letter Spacing</Label>
              <Input
                type="number"
                step="0.5"
                value={content[`${prefix}_letter_spacing`] || 0}
                onChange={(e) => updateContent(`${prefix}_letter_spacing`, parseFloat(e.target.value))}
                className="h-8"
              />
            </div>
          </div>
        </div>
      </details>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., contact-form"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-form-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Form Selection Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('formSelection')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-selection"
        >
          <span className="font-semibold text-sm">Form Selection</span>
          {expandedSections.formSelection ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.formSelection && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Select Form</Label>
              <Select
                value={content.form_slug || ''}
                onValueChange={(value) => updateContent('form_slug', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a form..." />
                </SelectTrigger>
                <SelectContent>
                  {forms.length === 0 ? (
                    <div className="p-2 text-sm text-slate-500">No active forms available</div>
                  ) : (
                    forms.map((form) => (
                      <SelectItem key={form.id} value={form.slug}>
                        {form.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-form-title"
                checked={content.show_form_title !== false}
                onChange={(e) => updateContent('show_form_title', e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="show-form-title" className="text-sm cursor-pointer">Show form title</Label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-form-description"
                checked={content.show_form_description !== false}
                onChange={(e) => updateContent('show_form_description', e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="show-form-description" className="text-sm cursor-pointer">Show form description</Label>
            </div>
          </div>
        )}
      </div>

      {/* Background Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-background"
        >
          <span className="font-semibold text-sm">Background</span>
          {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm mb-1 block">Background Type</Label>
              <select
                value={backgroundType}
                onChange={(e) => updateContent('background_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="color">Solid Color</option>
                <option value="gradient">Gradient</option>
                <option value="image">Image</option>
              </select>
            </div>

            {backgroundType === 'color' && (
              <div>
                <Label className="text-sm mb-1 block">Background Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={safeHexColor(content.background_color, '#ffffff')}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    value={content.background_color || ''}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    placeholder="transparent"
                    className="flex-1 font-mono text-sm"
                  />
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => updateContent('background_color', 'transparent')}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            )}

            {backgroundType === 'gradient' && (
              <div className="space-y-3 p-3 bg-slate-50 rounded-md">
                <div 
                  className="w-full h-16 rounded-md border border-slate-300"
                  style={{ background: gradientPreview }}
                />
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs mb-1 block">Start Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <Input
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="flex-1 font-mono text-xs h-8"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs mb-1 block">End Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <Input
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="flex-1 font-mono text-xs h-8"
                      />
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Angle: {content.gradient_angle || 135}°</Label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={content.gradient_angle || 135}
                    onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-slate-500 mt-1">
                    <span>0° (Right)</span>
                    <span>90° (Down)</span>
                    <span>180° (Left)</span>
                    <span>270° (Up)</span>
                  </div>
                </div>
              </div>
            )}

            {backgroundType === 'image' && (
              <div className="space-y-4">
                <div>
                  <Label className="text-sm mb-2 block">Background Image</Label>
                  {content.image_url ? (
                    <div className="relative">
                      <img 
                        src={content.image_url} 
                        alt="Background" 
                        className="w-full h-32 object-cover rounded-lg"
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        className="absolute top-2 right-2"
                        onClick={() => updateContent('image_url', '')}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center">
                      <ImageIcon className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      <div className="flex gap-2 justify-center">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setShowFileSelector(true)}
                        >
                          <ImageIcon className="w-4 h-4 mr-2" />
                          Select from Repository
                        </Button>
                        <label className="cursor-pointer">
                          <div className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
                            isUploading 
                              ? 'bg-slate-300 cursor-not-allowed' 
                              : 'bg-blue-600 hover:bg-blue-700 text-white'
                          }`}>
                            {isUploading ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Upload className="w-4 h-4" />
                            )}
                            <span>Upload</span>
                          </div>
                          <input
                            type="file"
                            className="hidden"
                            accept="image/*"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleImageUpload(file);
                              e.target.value = '';
                            }}
                            disabled={isUploading}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                {content.image_url && (
                  <>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowFileSelector(true)}
                      >
                        <ImageIcon className="w-4 h-4 mr-2" />
                        Change Image
                      </Button>
                    </div>

                    <div>
                      <Label className="text-sm mb-1 block">Image Scaling</Label>
                      <select
                        value={content.image_fit || 'cover'}
                        onChange={(e) => updateContent('image_fit', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      >
                        <option value="cover">Fill container (may crop)</option>
                        <option value="contain">Fit entire image (may show gaps)</option>
                      </select>
                    </div>

                    <div className="p-3 bg-slate-50 rounded-md">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={content.overlay_enabled || false}
                          onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                          className="rounded border-slate-300"
                        />
                        <span className="text-sm font-medium">Enable Overlay</span>
                      </label>
                      
                      {content.overlay_enabled && (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs mb-1 block">Overlay Color</Label>
                            <input
                              type="color"
                              value={content.overlay_color || '#000000'}
                              onChange={(e) => updateContent('overlay_color', e.target.value)}
                              className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                            />
                          </div>
                          <div>
                            <Label className="text-xs mb-1 block">Opacity (%)</Label>
                            <Input
                              type="number"
                              value={content.overlay_opacity || 50}
                              onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value))}
                              min="0"
                              max="100"
                              className="h-10"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Header Content Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('headerContent')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-header"
        >
          <span className="font-semibold text-sm">Header Content</span>
          {expandedSections.headerContent ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.headerContent && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm mb-1 block">Heading</Label>
              <div className="form-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.heading || ''}
                  onChange={(value) => updateContent('heading', value)}
                  modules={formQuillModules}
                  placeholder="Enter heading..."
                  style={{ minHeight: '80px' }}
                />
              </div>
              {renderTypographyControls('heading', 'Heading')}
            </div>

            <div>
              <Label className="text-sm mb-1 block">Subheading</Label>
              <div className="form-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.subheading || ''}
                  onChange={(value) => updateContent('subheading', value)}
                  modules={formQuillModules}
                  placeholder="Enter subheading..."
                  style={{ minHeight: '80px' }}
                />
              </div>
              {renderTypographyControls('subheading', 'Subheading')}
            </div>

            <div>
              <Label className="text-sm mb-1 block">Content Text</Label>
              <div className="form-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.text_content || ''}
                  onChange={(value) => updateContent('text_content', value)}
                  modules={formQuillModules}
                  placeholder="Enter content text..."
                  style={{ minHeight: '120px' }}
                />
              </div>
              {renderTypographyControls('text_content', 'Content')}
            </div>
          </div>
        )}
      </div>

      {/* Form Fields Typography Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('formFieldsTypography')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-fields-typography"
        >
          <span className="font-semibold text-sm">Form Fields Typography</span>
          {expandedSections.formFieldsTypography ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.formFieldsTypography && (
          <div className="p-4 space-y-6">
            {/* Form Labels Typography */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-slate-700 border-b pb-2">Question Labels</h4>
              
              <TypographyStyleSelector
                value={content.form_label_typography_style_id || null}
                onChange={(styleId, style) => {
                  const updates = { form_label_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.form_label_font_family = mapped.font_family;
                    if (mapped.font_size) updates.form_label_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.form_label_font_size_mobile = mapped.font_size_mobile;
                    if (mapped.font_weight) updates.form_label_font_weight = mapped.font_weight;
                    if (mapped.line_height) updates.form_label_line_height = mapped.line_height;
                    if (mapped.letter_spacing) updates.form_label_letter_spacing = mapped.letter_spacing;
                    if (mapped.color) updates.form_label_color = mapped.color;
                  }
                  updateMultipleContent(updates);
                }}
              />

              <div>
                <Label className="text-xs mb-1 block">Label Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={safeHexColor(content.form_label_color, '#334155')}
                    onChange={(e) => updateContent('form_label_color', e.target.value)}
                    className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    type="text"
                    value={content.form_label_color || '#334155'}
                    onChange={(e) => updateContent('form_label_color', e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                    placeholder="#334155"
                  />
                </div>
              </div>
              
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Manual Font Settings</summary>
                <div className="mt-2 space-y-2 pl-2 border-l-2 border-slate-200">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Font Family</Label>
                      <select
                        value={content.form_label_font_family || 'Poppins'}
                        onChange={(e) => updateContent('form_label_font_family', e.target.value)}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontFamilies.map(font => (
                          <option key={font} value={font}>{font}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Weight</Label>
                      <select
                        value={content.form_label_font_weight || 500}
                        onChange={(e) => updateContent('form_label_font_weight', parseInt(e.target.value))}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontWeights.map(w => (
                          <option key={w.value} value={w.value}>{w.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_label_font_size || 14}
                        onChange={(e) => updateContent('form_label_font_size', parseInt(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Mobile Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_label_font_size_mobile || ''}
                        onChange={(e) => updateContent('form_label_font_size_mobile', e.target.value ? parseInt(e.target.value) : null)}
                        placeholder="Same"
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Line Height</Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={content.form_label_line_height || 1.4}
                        onChange={(e) => updateContent('form_label_line_height', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Letter Spacing</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={content.form_label_letter_spacing || 0}
                        onChange={(e) => updateContent('form_label_letter_spacing', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                  </div>
                </div>
              </details>
            </div>

            {/* Form Inputs Typography */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-slate-700 border-b pb-2">Input Fields</h4>
              
              <TypographyStyleSelector
                value={content.form_input_typography_style_id || null}
                onChange={(styleId, style) => {
                  const updates = { form_input_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.form_input_font_family = mapped.font_family;
                    if (mapped.font_size) updates.form_input_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.form_input_font_size_mobile = mapped.font_size_mobile;
                    if (mapped.font_weight) updates.form_input_font_weight = mapped.font_weight;
                    if (mapped.line_height) updates.form_input_line_height = mapped.line_height;
                    if (mapped.letter_spacing) updates.form_input_letter_spacing = mapped.letter_spacing;
                    if (mapped.color) updates.form_input_color = mapped.color;
                  }
                  updateMultipleContent(updates);
                }}
              />

              <div>
                <Label className="text-xs mb-1 block">Input Text Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={safeHexColor(content.form_input_color, '#1e293b')}
                    onChange={(e) => updateContent('form_input_color', e.target.value)}
                    className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    type="text"
                    value={content.form_input_color || '#1e293b'}
                    onChange={(e) => updateContent('form_input_color', e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                    placeholder="#1e293b"
                  />
                </div>
              </div>
              
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Manual Font Settings</summary>
                <div className="mt-2 space-y-2 pl-2 border-l-2 border-slate-200">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Font Family</Label>
                      <select
                        value={content.form_input_font_family || 'Poppins'}
                        onChange={(e) => updateContent('form_input_font_family', e.target.value)}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontFamilies.map(font => (
                          <option key={font} value={font}>{font}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Weight</Label>
                      <select
                        value={content.form_input_font_weight || 400}
                        onChange={(e) => updateContent('form_input_font_weight', parseInt(e.target.value))}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontWeights.map(w => (
                          <option key={w.value} value={w.value}>{w.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_input_font_size || 14}
                        onChange={(e) => updateContent('form_input_font_size', parseInt(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Mobile Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_input_font_size_mobile || ''}
                        onChange={(e) => updateContent('form_input_font_size_mobile', e.target.value ? parseInt(e.target.value) : null)}
                        placeholder="Same"
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Line Height</Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={content.form_input_line_height || 1.5}
                        onChange={(e) => updateContent('form_input_line_height', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Letter Spacing</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={content.form_input_letter_spacing || 0}
                        onChange={(e) => updateContent('form_input_letter_spacing', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}
      </div>

      {/* Appearance Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('appearance')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-appearance"
        >
          <span className="font-semibold text-sm">Layout & Spacing</span>
          {expandedSections.appearance ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.appearance && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Vertical Padding: {content.vertical_padding || 48}px</Label>
              <input
                type="range"
                min="0"
                max="120"
                value={content.vertical_padding || 48}
                onChange={(e) => updateContent('vertical_padding', parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <Label className="text-sm">Content Max Width: {content.content_max_width || 800}px</Label>
              <input
                type="range"
                min="400"
                max="1200"
                step="50"
                value={content.content_max_width || 800}
                onChange={(e) => updateContent('content_max_width', parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-sm">Default Text Alignment</Label>
              <AlignmentButtons
                value={content.text_align || 'center'}
                onAlignChange={(val) => updateContent('text_align', val)}
                testIdPrefix="form-default-align"
              />
            </div>

            {/* Card Styling */}
            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-3">Form Card Styling</h4>
              
              <div className="space-y-4">
                {/* Border Radius */}
                <div>
                  <Label className="text-sm">Border Radius: {content.card_border_radius ?? 8}px</Label>
                  <input
                    type="range"
                    min="0"
                    max="32"
                    value={content.card_border_radius ?? 8}
                    onChange={(e) => updateContent('card_border_radius', parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>

                {/* Border */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="card-border-enabled"
                      checked={content.card_border_enabled ?? true}
                      onChange={(e) => updateContent('card_border_enabled', e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="card-border-enabled" className="text-sm cursor-pointer">Enable Border</Label>
                  </div>
                  
                  {(content.card_border_enabled ?? true) && (
                    <div className="grid grid-cols-2 gap-3 pl-6">
                      <div>
                        <Label className="text-xs mb-1 block">Border Width</Label>
                        <select
                          value={content.card_border_width || 1}
                          onChange={(e) => updateContent('card_border_width', parseInt(e.target.value))}
                          className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                        >
                          <option value="1">1px</option>
                          <option value="2">2px</option>
                          <option value="3">3px</option>
                          <option value="4">4px</option>
                        </select>
                      </div>
                      <div>
                        <Label className="text-xs mb-1 block">Border Color</Label>
                        <div className="flex gap-1 items-center">
                          <input
                            type="color"
                            value={safeHexColor(content.card_border_color, '#e2e8f0')}
                            onChange={(e) => updateContent('card_border_color', e.target.value)}
                            className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                          />
                          <Input
                            value={content.card_border_color || '#e2e8f0'}
                            onChange={(e) => updateContent('card_border_color', e.target.value)}
                            className="flex-1 font-mono text-xs h-8"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Drop Shadow */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="card-shadow-enabled"
                      checked={content.card_shadow_enabled || false}
                      onChange={(e) => updateContent('card_shadow_enabled', e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="card-shadow-enabled" className="text-sm cursor-pointer">Enable Drop Shadow</Label>
                  </div>
                  
                  {content.card_shadow_enabled && (
                    <div className="pl-6 space-y-3">
                      <div>
                        <Label className="text-xs mb-1 block">Shadow Style</Label>
                        <select
                          value={content.card_shadow_style || 'medium'}
                          onChange={(e) => updateContent('card_shadow_style', e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                        >
                          <option value="subtle">Subtle</option>
                          <option value="medium">Medium</option>
                          <option value="strong">Strong</option>
                          <option value="xl">Extra Large</option>
                        </select>
                      </div>
                      <div>
                        <Label className="text-xs mb-1 block">Shadow Color</Label>
                        <div className="flex gap-1 items-center">
                          <input
                            type="color"
                            value={safeHexColor(content.card_shadow_color, '#000000')}
                            onChange={(e) => updateContent('card_shadow_color', e.target.value)}
                            className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                          />
                          <Input
                            value={content.card_shadow_color || '#000000'}
                            onChange={(e) => updateContent('card_shadow_color', e.target.value)}
                            className="flex-1 font-mono text-xs h-8"
                          />
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs mb-1 block">Shadow Opacity: {content.card_shadow_opacity ?? 10}%</Label>
                        <input
                          type="range"
                          min="5"
                          max="50"
                          value={content.card_shadow_opacity ?? 10}
                          onChange={(e) => updateContent('card_shadow_opacity', parseInt(e.target.value))}
                          className="w-full"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Card Background Color */}
                <div>
                  <Label className="text-xs mb-1 block">Card Background Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={safeHexColor(content.card_background_color, '#ffffff')}
                      onChange={(e) => updateContent('card_background_color', e.target.value)}
                      className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                    />
                    <Input
                      value={content.card_background_color || '#ffffff'}
                      onChange={(e) => updateContent('card_background_color', e.target.value)}
                      className="flex-1 font-mono text-xs h-8"
                      placeholder="#ffffff"
                    />
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => updateContent('card_background_color', '')}
                      className="h-8 text-xs"
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* File Selector Dialog */}
      <Dialog open={showFileSelector} onOpenChange={() => {
        setShowFileSelector(false);
        setFileSelectorFolder(null);
        setFileSelectorExpandedFolders({});
        setFileSelectorSearch("");
        setFileSelectorPage(1);
      }}>
        <DialogContent className="max-w-6xl max-h-[90vh] grid grid-rows-[auto_1fr_auto] gap-4">
          <DialogHeader>
            <DialogTitle>Select Image from Repository</DialogTitle>
            <div className="pt-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search images..."
                  value={fileSelectorSearch}
                  onChange={(e) => setFileSelectorSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </DialogHeader>

          <div className="grid md:grid-cols-4 gap-4 py-4 overflow-hidden min-h-0">
            <div className="md:col-span-1 border-r border-slate-200 pr-4 overflow-y-auto">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Folders</h3>
              <div className="mb-3 p-2 bg-slate-50 rounded-lg">
                <button
                  onClick={() => setFileSelectorFolder(null)}
                  className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
                >
                  <Home className="w-3 h-3" />
                  Root
                </button>
                {fileSelectorBreadcrumb.map((folder, idx) => (
                  <span key={folder.id}>
                    <ChevronRight className="w-3 h-3 text-slate-400 inline-block mx-1" />
                    <button
                      onClick={() => setFileSelectorFolder(folder.id)}
                      className={`text-xs ${idx === fileSelectorBreadcrumb.length - 1 ? 'text-blue-600 font-medium' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </div>
              <div className="border border-slate-200 rounded-lg p-2 max-h-96 overflow-y-auto">
                <div
                  className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${fileSelectorFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'}`}
                  onClick={() => setFileSelectorFolder(null)}
                >
                  <FolderOpen className="w-4 h-4 text-slate-600" />
                  <span className="flex-1 text-sm font-medium">Root</span>
                  <span className="text-xs text-slate-500">({repositoryFiles.filter(f => !f.folder_id && f.file_type === 'image').length})</span>
                </div>
                {renderFileSelectorFolderTree(fileSelectorFolderHierarchy)}
              </div>
            </div>

            <div className="md:col-span-3 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3 text-sm text-slate-600">
                <span>{filteredRepositoryFiles.length} image{filteredRepositoryFiles.length !== 1 ? 's' : ''}</span>
                {fileSelectorTotalPages > 1 && <span>Page {fileSelectorPage} of {fileSelectorTotalPages}</span>}
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {filteredRepositoryFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600">No images found</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {paginatedRepositoryFiles.map((file) => (
                      <button
                        key={file.id}
                        onClick={() => handleSelectFile(file.file_url)}
                        className="text-left border-2 border-slate-200 rounded-lg hover:border-blue-500 transition-colors p-2"
                      >
                        <img src={file.file_url} alt={file.file_name} className="w-full h-32 object-cover rounded mb-2" />
                        <p className="text-sm font-medium text-slate-900 truncate">{file.file_name}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {fileSelectorTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-slate-200">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFileSelectorPage(p => Math.max(1, p - 1))}
                    disabled={fileSelectorPage === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm">{fileSelectorPage} / {fileSelectorTotalPages}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFileSelectorPage(p => Math.min(fileSelectorTotalPages, p + 1))}
                    disabled={fileSelectorPage === fileSelectorTotalPages}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFileSelector(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

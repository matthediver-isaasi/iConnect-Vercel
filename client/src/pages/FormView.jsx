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
          const response = await fetch('/api/forms/process-application', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              form_id: form.id,
              form_values: formValues,
              fields: form.fields,
              application_level: form.application_level || 'member',
              submission_id: submissionResult?.id
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

  // Compute initial hidden fields (fields that have "show" rules should start hidden)
  const initialHiddenFieldIds = useMemo(() => {
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      return new Set();
    }
    
    const hidden = new Set();
    for (const rule of form.visibility_rules) {
      if (rule.action === 'show' && rule.target_field_ids?.length) {
        // Fields with "show" rules start hidden until condition is met
        rule.target_field_ids.forEach(id => hidden.add(id));
      }
    }
    return hidden;
  }, [form?.visibility_rules]);

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
      if (!rule.trigger_field_id || !rule.target_field_ids?.length) continue;
      
      const triggerValue = formValues[rule.trigger_field_id];
      let conditionMet = false;
      
      switch (rule.operator) {
        case 'equals':
          // Handle array values (checkbox/multi-select)
          if (Array.isArray(triggerValue)) {
            conditionMet = triggerValue.includes(rule.value);
          } else {
            conditionMet = triggerValue === rule.value;
          }
          break;
        case 'not_equals':
          if (Array.isArray(triggerValue)) {
            conditionMet = !triggerValue.includes(rule.value);
          } else {
            conditionMet = triggerValue !== rule.value;
          }
          break;
        case 'contains':
          // Handle both string and array values
          if (Array.isArray(triggerValue)) {
            conditionMet = triggerValue.includes(rule.value);
          } else if (typeof triggerValue === 'string') {
            conditionMet = triggerValue.includes(rule.value);
          } else {
            conditionMet = false;
          }
          break;
        case 'not_empty':
          conditionMet = triggerValue !== undefined && triggerValue !== null && triggerValue !== '' && 
            (Array.isArray(triggerValue) ? triggerValue.length > 0 : true);
          break;
        case 'is_empty':
          conditionMet = triggerValue === undefined || triggerValue === null || triggerValue === '' ||
            (Array.isArray(triggerValue) && triggerValue.length === 0);
          break;
        default:
          conditionMet = false;
      }

      // Track rule results per target field
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
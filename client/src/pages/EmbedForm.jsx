import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loader2, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import FormRenderer from "../components/forms/FormRenderer";
import { toast, Toaster } from "sonner";
import { publicClient } from "@/api/publicClient";

export default function EmbedFormPage() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  
  const [currentStep, setCurrentStep] = useState(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [formValues, setFormValues] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [fieldValidity, setFieldValidity] = useState({});

  const handleValidityChange = (fieldId, isValid) => {
    setFieldValidity(prev => ({ ...prev, [fieldId]: isValid }));
  };

  const prefillOrgId = searchParams.get('organization_id');
  const tenantParam = searchParams.get('tenant');

  const { data: form, isLoading, error } = useQuery({
    queryKey: ['embed-form', slug, tenantParam],
    queryFn: () => publicClient.getForm(slug),
    enabled: !!slug
  });

  const [defaultsInitialized, setDefaultsInitialized] = useState(false);

  useEffect(() => {
    setCurrentPageIndex(0);
    setCurrentStep(0);
    setSubmitted(false);
    setDefaultsInitialized(false);
    setFormValues({});
  }, [form?.id]);

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
      if ((field.starts_hidden === true || field.starts_hidden === 'true') && field.type !== 'boolean') {
        if (fieldDefaults[field.id] === undefined) {
          if (field.default_value !== undefined && field.default_value !== null && field.default_value !== '') {
            fieldDefaults[field.id] = field.default_value;
          } else {
            fieldDefaults[field.id] = '';
          }
        }
      }
    }
    
    if (Object.keys(fieldDefaults).length > 0) {
      setFormValues(prev => ({ ...prev, ...fieldDefaults }));
    }
    setDefaultsInitialized(true);
  }, [form?.fields, defaultsInitialized]);

  // Evaluate a single condition - matches FormView exactly
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

  // Calculate initial hidden field IDs (fields with starts_hidden = true)
  const initialHiddenFieldIds = useMemo(() => {
    const hidden = new Set();
    if (form?.fields) {
      for (const field of form.fields) {
        if (field.starts_hidden === true || field.starts_hidden === 'true') {
          hidden.add(field.id);
        }
      }
    }
    return hidden;
  }, [form?.fields]);

  // Visibility rules evaluation - matches FormView exactly
  const hiddenFieldIds = useMemo(() => {
    const hidden = new Set(initialHiddenFieldIds);
    
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      return hidden;
    }
    
    // Track which fields should be shown/hidden based on rule evaluation
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

  // Filter visible fields
  const filterVisibleFields = (fields) => {
    if (!fields) return [];
    return fields.filter(field => !hiddenFieldIds.has(field.id));
  };

  const submitFormMutation = useMutation({
    mutationFn: (submissionData) => publicClient.submitForm({
      ...submissionData,
      prefill_organization_id: prefillOrgId || null
    }),
    onSuccess: async () => {
      setSubmitted(true);
      notifyParentResize();
      
      // Handle redirect if configured
      if (form?.redirect_url) {
        setTimeout(() => {
          window.top.location.href = form.redirect_url;
        }, 2000);
      }
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to submit form');
    }
  });

  // For card swipe layout
  const visibleFields = useMemo(() => {
    return filterVisibleFields(form?.fields || []);
  }, [form?.fields, hiddenFieldIds]);

  // For standard layout with pages
  const pages = useMemo(() => {
    if (!form?.fields) return [];
    
    // If form has explicit pages array, use that
    if (form.pages && form.pages.length > 0) {
      return form.pages.map((page, pageIndex) => {
        // Include unassigned fields (no page_id) on the first page for backwards compatibility
        // This matches FormView behavior
        const pageFields = pageIndex === 0
          ? form.fields.filter(f => f.page_id === page.id || !f.page_id)
          : form.fields.filter(f => f.page_id === page.id);
        return {
          ...page,
          fields: filterVisibleFields(pageFields)
        };
      });
    }
    
    // Otherwise, look for page_break fields
    const result = [];
    let currentPage = { fields: [], title: null };
    
    for (const field of form.fields) {
      if (field.type === 'page_break') {
        if (currentPage.fields.length > 0) {
          result.push(currentPage);
        }
        currentPage = { fields: [], title: field.page_title || null };
      } else if (!hiddenFieldIds.has(field.id)) {
        currentPage.fields.push(field);
      }
    }
    
    if (currentPage.fields.length > 0) {
      result.push(currentPage);
    }
    
    return result;
  }, [form?.fields, form?.pages, hiddenFieldIds]);

  const isMultiPage = pages.length > 1;
  const currentPageFields = pages[currentPageIndex]?.fields || [];
  const currentPageTitle = pages[currentPageIndex]?.title;

  const validateCurrentPage = () => {
    const fieldsToValidate = form?.layout_type === 'card_swipe' 
      ? [visibleFields[currentStep]]
      : currentPageFields;
    
    for (const field of fieldsToValidate) {
      if (!field) continue;
      if ((field.is_required || field.required) && !formValues[field.id]) {
        return false;
      }
      if (fieldValidity[field.id] === false) {
        return false;
      }
    }
    return true;
  };

  const handleNext = () => {
    if (!validateCurrentPage()) {
      toast.error('Please fill in all required fields correctly');
      return;
    }
    
    if (form?.layout_type === 'card_swipe') {
      if (currentStep < visibleFields.length - 1) {
        setCurrentStep(prev => prev + 1);
        notifyParentResize();
      }
    } else {
      if (currentPageIndex < pages.length - 1) {
        setCurrentPageIndex(prev => prev + 1);
        notifyParentResize();
      }
    }
  };

  const handlePrevious = () => {
    if (form?.layout_type === 'card_swipe') {
      if (currentStep > 0) {
        setCurrentStep(prev => prev - 1);
        notifyParentResize();
      }
    } else {
      if (currentPageIndex > 0) {
        setCurrentPageIndex(prev => prev - 1);
        notifyParentResize();
      }
    }
  };

  const handleSubmit = async () => {
    if (!validateCurrentPage()) {
      toast.error('Please fill in all required fields correctly');
      return;
    }

    // Uniqueness validation (runs if uniqueness checks are configured)
    if (form.uniqueness_checks && form.uniqueness_checks.length > 0) {
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
        console.error('[EmbedForm] Uniqueness validation error:', error);
        toast.error('Unable to validate form. Please try again.');
        return;
      }
    }

    // Match FormView submission structure exactly
    submitFormMutation.mutate({
      form_id: form.id,
      form_name: form.name,
      submission_data: formValues
    });
  };

  const notifyParentResize = () => {
    setTimeout(() => {
      const height = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'iconn-form-resize', height }, '*');
    }, 100);
  };

  useEffect(() => {
    notifyParentResize();
  }, [form, currentPageIndex, currentStep, submitted, hiddenFieldIds]);

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      notifyParentResize();
    });
    resizeObserver.observe(document.body);
    return () => resizeObserver.disconnect();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !form) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-error">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">
              {error?.message || 'Form not found or no longer available'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-success">
        <Toaster />
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Thank You!</h3>
            <p className="text-muted-foreground">
              {form.success_message || 'Your submission has been received.'}
            </p>
            {form.redirect_url && (
              <p className="text-sm text-muted-foreground mt-2">Redirecting...</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Card Swipe Layout
  if (form.layout_type === 'card_swipe') {
    const currentField = visibleFields[currentStep];
    const isLastStep = currentStep === visibleFields.length - 1;
    const hasValue = formValues[currentField?.id];
    const isFormatValid = fieldValidity[currentField?.id] !== false;
    const canProceed = (!(currentField?.is_required || currentField?.required) || hasValue) && isFormatValid;

    return (
      <div className="p-4" data-testid="embed-form-container">
        <Toaster />
        <Card className="w-full">
          <CardHeader>
            <CardTitle data-testid="embed-form-title">{form.name}</CardTitle>
            {form.description && (
              <CardDescription data-testid="embed-form-description">{form.description}</CardDescription>
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
          <CardContent className="min-h-[200px]">
            {currentField && (
              <FormRenderer
                key={currentStep}
                field={currentField}
                value={formValues[currentField.id]}
                onChange={(value) => {
                  setFormValues(prev => ({ ...prev, [currentField.id]: value }));
                  notifyParentResize();
                }}
                onValidityChange={handleValidityChange}
                disabled={false}
                autoFocus={['text', 'email', 'url', 'number', 'tel', 'textarea'].includes(currentField.type)}
              />
            )}
          </CardContent>
          <div className="p-6 pt-0 flex flex-col gap-2">
            {!canProceed && currentField && (
              <p className="text-sm text-amber-600 text-center">
                {!isFormatValid 
                  ? 'Please fix the format error above to continue'
                  : 'Please complete the required field above to continue'}
              </p>
            )}
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={handlePrevious}
                disabled={currentStep === 0}
                data-testid="button-previous-step"
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                Previous
              </Button>
              {isLastStep ? (
                <Button
                  onClick={handleSubmit}
                  disabled={!canProceed || submitFormMutation.isPending}
                  data-testid="button-submit-form"
                >
                  {submitFormMutation.isPending ? (
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
                  onClick={handleNext}
                  disabled={!canProceed}
                  data-testid="button-next-step"
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

  // Standard Layout
  return (
    <div className="p-4" data-testid="embed-form-container">
      <Toaster />
      <Card className="w-full">
        <CardHeader>
          <CardTitle data-testid="embed-form-title">{form.name}</CardTitle>
          {form.description && (
            <CardDescription data-testid="embed-form-description">{form.description}</CardDescription>
          )}
          {isMultiPage && (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                <span>Page {currentPageIndex + 1} of {pages.length}</span>
                {currentPageTitle && <span className="font-medium">- {currentPageTitle}</span>}
              </div>
              <div className="flex gap-1 mt-2">
                {pages.map((_, index) => (
                  <div
                    key={index}
                    className={`h-1.5 flex-1 rounded-full ${
                      index <= currentPageIndex ? 'bg-blue-600' : 'bg-slate-200'
                    }`}
                  />
                ))}
              </div>
            </>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {currentPageFields.map(field => (
              <FormRenderer
                key={field.id}
                field={field}
                value={formValues[field.id]}
                onChange={(value) => {
                  setFormValues(prev => ({ ...prev, [field.id]: value }));
                  notifyParentResize();
                }}
                onValidityChange={handleValidityChange}
                disabled={false}
              />
            ))}
          </div>

          <div className="flex justify-between mt-6">
            {isMultiPage && currentPageIndex > 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={handlePrevious}
                data-testid="button-previous-page"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
            ) : (
              <div />
            )}

            {isMultiPage && currentPageIndex < pages.length - 1 ? (
              <Button
                type="button"
                onClick={handleNext}
                data-testid="button-next-page"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={submitFormMutation.isPending}
                data-testid="button-submit-form"
              >
                {submitFormMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  form.submit_button_text || 'Submit'
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

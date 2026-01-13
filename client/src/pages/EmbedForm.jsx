import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loader2, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import FormRenderer from "../components/forms/FormRenderer";
import { toast, Toaster } from "sonner";

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

  const prefillMemberId = searchParams.get('member_id');
  const prefillOrgId = searchParams.get('organization_id');
  const tenantParam = searchParams.get('tenant');

  const { data: form, isLoading, error } = useQuery({
    queryKey: ['embed-form', slug, tenantParam],
    queryFn: async () => {
      const url = tenantParam 
        ? `/api/public/form/${slug}?tenant=${encodeURIComponent(tenantParam)}`
        : `/api/public/form/${slug}`;
      const response = await fetch(url);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load form');
      }
      return response.json();
    },
    enabled: !!slug
  });

  const { data: defaultConsentMessage } = useQuery({
    queryKey: ['formDefaultConsentMessage'],
    queryFn: async () => {
      const response = await fetch('/api/public/form-consent-message');
      if (!response.ok) return '';
      const data = await response.json();
      return data.message || '';
    },
    staleTime: 5 * 60 * 1000
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

  const submitFormMutation = useMutation({
    mutationFn: async (submissionData) => {
      const response = await fetch('/api/entities/FormSubmission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submissionData)
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to submit form');
      }
      return response.json();
    },
    onSuccess: async (submissionResult) => {
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
              submission_id: submissionResult?.id,
              prefill_organization_id: prefillOrgId || null,
              role_id: null
            })
          });
          if (!response.ok) {
            console.warn('[EmbedForm] process-application failed:', await response.text());
          }
        } catch (err) {
          console.error('[EmbedForm] Error processing entity pipelines:', err);
        }
      }

      if (form?.send_email) {
        try {
          await fetch('/api/forms/send-submission-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              form_id: form.id,
              form_values: formValues,
              fields: form.fields,
              email_templates: form.email_templates || []
            })
          });
        } catch (err) {
          console.error('[EmbedForm] Error sending emails:', err);
        }
      }

      setSubmitted(true);
      notifyParentResize();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to submit form');
    }
  });

  const pages = useMemo(() => {
    if (!form?.fields) return [];
    const result = [];
    let currentPage = { fields: [], title: null };
    
    for (const field of form.fields) {
      if (field.type === 'page_break') {
        if (currentPage.fields.length > 0) {
          result.push(currentPage);
        }
        currentPage = { fields: [], title: field.page_title || null };
      } else {
        currentPage.fields.push(field);
      }
    }
    
    if (currentPage.fields.length > 0) {
      result.push(currentPage);
    }
    
    return result;
  }, [form?.fields]);

  const isMultiPage = pages.length > 1;
  const currentPageFields = pages[currentPageIndex]?.fields || [];
  const currentPageTitle = pages[currentPageIndex]?.title;

  const validateCurrentPage = () => {
    for (const field of currentPageFields) {
      if (field.is_required && !formValues[field.id]) {
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
    if (currentPageIndex < pages.length - 1) {
      setCurrentPageIndex(prev => prev + 1);
      notifyParentResize();
    }
  };

  const handlePrevious = () => {
    if (currentPageIndex > 0) {
      setCurrentPageIndex(prev => prev - 1);
      notifyParentResize();
    }
  };

  const handleSubmit = () => {
    if (!validateCurrentPage()) {
      toast.error('Please fill in all required fields correctly');
      return;
    }

    const fieldAnswers = (form?.fields || []).map(field => ({
      field_id: field.id,
      field_label: field.label,
      field_type: field.type,
      value: formValues[field.id] ?? null
    }));

    submitFormMutation.mutate({
      form_id: form.id,
      form_name: form.name,
      answers: fieldAnswers,
      source: 'embed'
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
  }, [form, currentPageIndex, submitted]);

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
          </CardContent>
        </Card>
      </div>
    );
  }

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
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
              <span>Page {currentPageIndex + 1} of {pages.length}</span>
              {currentPageTitle && <span className="font-medium">- {currentPageTitle}</span>}
            </div>
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

import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import FormRenderer from "../forms/FormRenderer";
import { Button } from "@/components/ui/button";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/api/supabaseClient";
import { publicClient, getTenantSlugFromLocation } from "@/api/publicClient";

export default function FloaterDisplay({ location = "portal", memberInfo, organizationInfo }) {
  // Get tenant_id for filtering - from memberInfo if authenticated, otherwise resolve from tenant slug
  const [tenantId, setTenantId] = useState(memberInfo?.tenant_id || null);
  
  // Resolve tenant_id from slug if not available from memberInfo (for public pages)
  useEffect(() => {
    if (memberInfo?.tenant_id) {
      setTenantId(memberInfo.tenant_id);
      return;
    }
    
    // Try to get tenant_id from localStorage
    const storedMember = localStorage.getItem('agcas_member');
    if (storedMember) {
      try {
        const parsed = JSON.parse(storedMember);
        if (parsed?.tenant_id) {
          setTenantId(parsed.tenant_id);
          return;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // For public pages, resolve tenant from slug
    const tenantSlug = getTenantSlugFromLocation();
    if (tenantSlug) {
      supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantSlug)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.id) {
            setTenantId(data.id);
          }
        });
    }
  }, [memberInfo?.tenant_id]);
  const queryClient = useQueryClient();
  const [selectedForm, setSelectedForm] = useState(null);
  const [formValues, setFormValues] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [submissionSuccess, setSubmissionSuccess] = useState(false);
  
  // Track viewport dimensions for responsive floater positioning
  const [viewportDimensions, setViewportDimensions] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  });
  
  // Update viewport dimensions on resize
  useEffect(() => {
    const handleResize = () => {
      setViewportDimensions({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Fetch default consent message from public endpoint (works without auth)
  const { data: defaultConsentMessage } = useQuery({
    queryKey: ['formDefaultConsentMessage'],
    queryFn: async () => {
      const data = await publicClient.getFormConsentMessage();
      return data.message || '';
    },
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Fetch full member record to get job_title (was base44.entities.Member.list)
  const { data: memberRecord } = useQuery({
    queryKey: ["member-record", memberInfo?.email, tenantId],
    enabled: !!memberInfo?.email && !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("member")
        .select("*")
        .eq("email", memberInfo.email)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (error) {
        console.error("Error loading member record:", error);
        return null;
      }

      return data || null;
    },
  });

  // Fetch floaters (was base44.entities.Floater.list)
  // SECURITY: Filter by tenant_id to ensure proper tenant isolation
  const { data: floaters = [] } = useQuery({
    queryKey: ["floaters", location, tenantId],
    queryFn: async () => {
      if (!tenantId) {
        console.warn("[FloaterDisplay] No tenant_id available, skipping floater fetch");
        return [];
      }
      
      const { data, error } = await supabase
        .from("floater")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .or(
          `display_location.eq.${location},display_location.eq.both`
        )
        .order("display_order", { ascending: true });

      if (error) {
        console.error("Error loading floaters:", error);
        return [];
      }

      return data || [];
    },
    enabled: !!tenantId, // Only fetch when tenant_id is available
  });

  // Fetch forms (was base44.entities.Form.list)
  // SECURITY: Filter by tenant_id for proper tenant isolation
  const { data: forms = [] } = useQuery({
    queryKey: ["forms", tenantId],
    queryFn: async () => {
      if (!tenantId) return [];
      
      const { data, error } = await supabase
        .from("form")
        .select("*")
        .eq("tenant_id", tenantId);

      if (error) {
        console.error("Error loading forms:", error);
        return [];
      }

      return data || [];
    },
    enabled: !!tenantId,
  });

  // Increment Floater click count (was base44.entities.Floater.update)
  const incrementClickMutation = useMutation({
    mutationFn: async ({ floaterId, currentCount }) => {
      const { error } = await supabase
        .from("floater")
        .update({ click_count: (currentCount || 0) + 1 })
        .eq("id", floaterId);

      if (error) {
        console.error("Error updating floater click_count:", error);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["floaters"] });
    },
  });

  // Submit form (was base44.entities.FormSubmission.create)
  const submitFormMutation = useMutation({
    mutationFn: async ({ formId, formName, data }) => {
      const submissionData = {
        form_id: formId,
        form_name: formName,
        submission_data: data,
        submitted_by_email: memberInfo?.email,
        submitted_by_name: memberInfo
          ? `${memberInfo.first_name} ${memberInfo.last_name}`
          : undefined,
        created_date: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("form_submission")
        .insert([submissionData]);

      if (error) {
        console.error("Error creating form submission:", error);
        throw error;
      }
    },
    onSuccess: () => {
      setSubmissionSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["forms"] });
    },
    onError: () => {
      toast.error("Failed to submit form");
    },
  });

  const handleFloaterClick = async (floater) => {
    try {
      incrementClickMutation.mutate({
        floaterId: floater.id,
        currentCount: floater.click_count,
      });

      if (floater.action_type === "webhook" && floater.webhook_url) {
        await fetch(floater.webhook_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            floater_id: floater.id,
            floater_name: floater.name,
            timestamp: new Date().toISOString(),
            location: location,
          }),
        });
      } else if (floater.action_type === "url" && floater.redirect_url) {
        const windowTarget = floater.window_target || "new_tab";

        switch (windowTarget) {
          case "current":
            window.location.href = floater.redirect_url;
            break;
          case "new_tab":
            window.open(floater.redirect_url, "_blank", "noopener,noreferrer");
            break;
          case "parent":
            window.parent.location.href = floater.redirect_url;
            break;
          case "popup": {
            const popupWidth = floater.popup_width || 800;
            const popupHeight = floater.popup_height || 600;
            const left = (window.screen.width - popupWidth) / 2;
            const top = (window.screen.height - popupHeight) / 2;
            window.open(
              floater.redirect_url,
              "_blank",
              `width=${popupWidth},height=${popupHeight},left=${left},top=${top},resizable=yes,scrollbars=yes`
            );
            break;
          }
          default:
            window.open(floater.redirect_url, "_blank", "noopener,noreferrer");
        }
      } else if (floater.action_type === "form" && floater.form_slug) {
        const form = forms.find((f) => f.slug === floater.form_slug);
        if (form) {
          if (form.require_authentication && !memberInfo) {
            toast.error("Please log in to access this form");
            return;
          }
          setSelectedForm(form);
          setFormValues({});
          setCurrentStep(0);
          setSubmissionSuccess(false);
        }
      }
    } catch (error) {
      console.error("Failed to process floater click:", error);
    }
  };

  // Initialize boolean fields with their default values when form is selected
  // This ensures untouched boolean fields are included in the submission
  useEffect(() => {
    if (!selectedForm?.fields) return;
    
    const booleanDefaults = {};
    for (const field of selectedForm.fields) {
      if (field.type === 'boolean') {
        booleanDefaults[field.id] = field.default_value === true ? true : false;
      }
    }
    
    if (Object.keys(booleanDefaults).length > 0) {
      setFormValues(prev => {
        const merged = { ...prev };
        for (const [fieldId, defaultVal] of Object.entries(booleanDefaults)) {
          if (merged[fieldId] === undefined) {
            merged[fieldId] = defaultVal;
          }
        }
        return merged;
      });
    }
  }, [selectedForm?.fields]);

  const handleFormSubmit = async (e) => {
    e.preventDefault();

    if (!selectedForm) return;

    const requiredFields = selectedForm.fields.filter((f) => f.required);
    const missingFields = requiredFields.filter((f) => !formValues[f.id]);

    if (missingFields.length > 0) {
      toast.error("Please fill in all required fields");
      return;
    }

    setIsSubmitting(true);
    try {
      await submitFormMutation.mutateAsync({
        formId: selectedForm.id,
        formName: selectedForm.name,
        data: formValues,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNextStep = () => {
    if (!selectedForm) return;

    const currentField = selectedForm.fields[currentStep];
    if (currentField.required && !formValues[currentField.id]) {
      toast.error("This field is required");
      return;
    }

    if (currentStep < selectedForm.fields.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handlePreviousStep = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const closeDialog = () => {
    setSelectedForm(null);
    setFormValues({});
    setCurrentStep(0);
    setSubmissionSuccess(false);
  };

  const getPositionStyles = (floater) => {
    // Parse all numeric values, ensuring they're valid numbers with fallbacks
    const parseNum = (val, fallback) => {
      const num = parseFloat(val);
      return Number.isFinite(num) ? num : fallback;
    };
    
    const floaterWidth = parseNum(floater.width, 80);
    const floaterHeight = parseNum(floater.height, 80);
    const offsetX = parseNum(floater.offset_x, 20);
    const offsetY = parseNum(floater.offset_y, 20);
    
    // Use a minimum safe offset to prevent floater from going off screen
    const minSafeOffset = 8;
    
    // Use tracked viewport dimensions (updates on resize)
    const viewportWidth = viewportDimensions.width;
    const viewportHeight = viewportDimensions.height;
    
    // Calculate maximum allowed offsets to keep floater fully visible
    // For right/left: offset + floaterWidth + minSafeOffset <= viewportWidth
    // So maxOffset = viewportWidth - floaterWidth - minSafeOffset
    const maxOffsetX = Math.max(minSafeOffset, viewportWidth - floaterWidth - minSafeOffset);
    const maxOffsetY = Math.max(minSafeOffset, viewportHeight - floaterHeight - minSafeOffset);
    
    // Clamp offsets using JavaScript Math functions
    const clampedOffsetX = Math.max(minSafeOffset, Math.min(offsetX, maxOffsetX));
    const clampedOffsetY = Math.max(minSafeOffset, Math.min(offsetY, maxOffsetY));
    
    const styles = {
      position: "fixed",
      zIndex: 1000,
      cursor: "pointer",
      width: `${floaterWidth}px`,
      height: `${floaterHeight}px`,
      transition: "transform 0.2s ease",
    };

    // Apply clamped positions based on floater corner
    switch (floater.position) {
      case "bottom-right":
        styles.bottom = `${clampedOffsetY}px`;
        styles.right = `${clampedOffsetX}px`;
        break;
      case "bottom-left":
        styles.bottom = `${clampedOffsetY}px`;
        styles.left = `${clampedOffsetX}px`;
        break;
      case "top-right":
        styles.top = `${clampedOffsetY}px`;
        styles.right = `${clampedOffsetX}px`;
        break;
      case "top-left":
        styles.top = `${clampedOffsetY}px`;
        styles.left = `${clampedOffsetX}px`;
        break;
      default:
        styles.bottom = `${clampedOffsetY}px`;
        styles.right = `${clampedOffsetX}px`;
    }

    return styles;
  };

  const getImageStyles = (floater) => {
    const showBackground = floater.show_background ?? true;

    return {
      width: "100%",
      height: "100%",
      objectFit: "contain",
      ...(showBackground && {
        borderRadius: "8px",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
      }),
    };
  };

  // Use memberRecord (full data) if available, otherwise fallback to memberInfo
  const memberData = memberRecord || memberInfo;

  if (floaters.length === 0) return null;

  return (
    <>
      {!selectedForm && floaters.map((floater) => (
        <div
          key={floater.id}
          style={getPositionStyles(floater)}
          onClick={() => handleFloaterClick(floater)}
          onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.05)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          title={floater.description || floater.name}
        >
          <img
            src={floater.image_url}
            alt={floater.name}
            style={getImageStyles(floater)}
          />
        </div>
      ))}

      <Dialog open={!!selectedForm} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedForm && (
            <>
              {submissionSuccess ? (
                <div className="text-center py-12">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-8 h-8 text-green-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <h3 className="text-2xl font-bold text-slate-900 mb-2">
                    {selectedForm.success_message || "Thank you for your submission!"}
                  </h3>
                  <Button onClick={closeDialog} className="mt-6">
                    Close
                  </Button>
                </div>
              ) : selectedForm.layout_type === "card_swipe" ? (
                <div className="py-6">
                  <div className="mb-6">
                    <h2 className="text-2xl font-bold text-slate-900 mb-2">
                      {selectedForm.name}
                    </h2>
                    {selectedForm.description && (
                      <p className="text-slate-600">{selectedForm.description}</p>
                    )}
                  </div>

                  <div className="mb-6">
                    <div className="flex items-center gap-2 mb-2">
                      {selectedForm.fields.map((_, index) => (
                        <div
                          key={index}
                          className={`h-2 flex-1 rounded-full transition-colors ${
                            index <= currentStep ? "bg-blue-600" : "bg-slate-200"
                          }`}
                        />
                      ))}
                    </div>
                    <p className="text-sm text-slate-600 text-center">
                      Question {currentStep + 1} of {selectedForm.fields.length}
                    </p>
                  </div>

                  <div className="min-h-[200px]">
                    <FormRenderer
                      field={selectedForm.fields[currentStep]}
                      value={formValues[selectedForm.fields[currentStep].id]}
                      onChange={(value) =>
                        setFormValues((prev) => ({
                          ...prev,
                          [selectedForm.fields[currentStep].id]: value,
                        }))
                      }
                      memberInfo={memberData}
                      organizationInfo={organizationInfo}
                    />
                  </div>

                  <div className="flex justify-between gap-3 pt-6 border-t mt-6">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handlePreviousStep}
                      disabled={currentStep === 0}
                    >
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      Previous
                    </Button>
                    {currentStep === selectedForm.fields.length - 1 ? (
                      <Button
                        onClick={handleFormSubmit}
                        disabled={isSubmitting}
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        {isSubmitting ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Submitting...
                          </>
                        ) : (
                          selectedForm.submit_button_text || "Submit"
                        )}
                      </Button>
                    ) : (
                      <Button onClick={handleNextStep}>
                        Next
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    )}
                  </div>
                  {currentStep === selectedForm.fields.length - 1 && defaultConsentMessage && (
                    <p className="text-xs text-slate-500 text-center mt-2" data-testid="text-consent-message">
                      {defaultConsentMessage}
                    </p>
                  )}
                </div>
              ) : (
                <form onSubmit={handleFormSubmit} className="space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold text-slate-900 mb-2">
                      {selectedForm.name}
                    </h2>
                    {selectedForm.description && (
                      <p className="text-slate-600">{selectedForm.description}</p>
                    )}
                  </div>

                  <div className="space-y-4">
                    {selectedForm.fields.map((field) => (
                      <FormRenderer
                        key={field.id}
                        field={field}
                        value={formValues[field.id]}
                        onChange={(value) =>
                          setFormValues((prev) => ({ ...prev, [field.id]: value }))
                        }
                        memberInfo={memberData}
                        organizationInfo={organizationInfo}
                      />
                    ))}
                  </div>

                  <div className="flex justify-end gap-3 pt-4 border-t">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={closeDialog}
                      disabled={isSubmitting}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={isSubmitting}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        selectedForm.submit_button_text || "Submit"
                      )}
                    </Button>
                  </div>
                  {defaultConsentMessage && (
                    <p className="text-xs text-slate-500 text-center mt-2" data-testid="text-consent-message">
                      {defaultConsentMessage}
                    </p>
                  )}
                </form>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

import { applySurveyPresentation, surveySuccessMessage, surveyIntroText, showSurveyProgress, surveyProgress } from '@/lib/surveyPresentation';
import { evaluateScoreCondition } from '@/lib/surveyConditions';
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loader2, ChevronLeft, ChevronRight, CheckCircle2, Save, Copy, Check, AlertTriangle, Printer } from "lucide-react";
import FormRenderer from "../components/forms/FormRenderer";
import FormPaymentSubmit from "../components/forms/FormPaymentSubmit";
import { useFormPaymentReturn, FormPaymentReturnScreen } from "../components/forms/FormPaymentReturn";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { isFieldValueFilled, parseCustomFieldValue, resolveEffectivePrefillIds, resolveMemberSourceOrgId, shouldFetchViewerBookingPrefill, shouldBlockForMissingViewerBooking, isViewerBookingResolutionPending, shouldWaitForPrefillCustomValues, shouldWaitForPrefillOrgEntity } from "@/lib/formFieldPrefill";
import { getFormPagination } from "@/lib/formPagination";
import { resolveSubmitControl } from "../../../api/_lib/formSubmitControl.js";
import { evaluateLmicCondition } from "../../../api/_lib/formLmicConditions.js";
import { useSubmissionIdempotencyKey } from "@/lib/useSubmissionIdempotencyKey";
import { useCardSwipeAutoFocus } from "@/lib/cardSwipeAutoFocus";
import { useMembershipFeeQuote } from "@/lib/useMembershipFeeQuote";
import { COUNTRIES } from "@/data/countries";
import FormAccessRestriction, { resolveFormAccess } from "@/components/forms/FormAccessRestriction";
import { evaluateFormLogicCondition } from "@/lib/formLogicConditions";
import { FORM_NO_RELATIONSHIP_VALUE } from "../../../shared/formNoRelationshipChoice.js";
import {
  pruneFormNotListedText,
  setFormNotListedText,
} from "../../../shared/formNotListedChoice.js";
import { useFormFieldPrefill } from "@/lib/useFormFieldPrefill";

// A `redirect_url` beginning with this prefix means the redirect target is driven
// by the value the respondent submitted for the field whose id follows the prefix.
const REDIRECT_FIELD_PREFIX = 'field:';

// Only allow http(s) absolute URLs or site-relative paths for the dynamic
// (field-driven) redirect, so a submitted value can't trigger javascript:/data:
// or other unsafe schemes.
function isSafeDynamicRedirect(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.startsWith('/')) return true;
  return false;
}

// Resolve the actual URL to redirect to after a successful submission.
// - Static redirect_url: returned unchanged (existing behaviour).
// - Field-driven redirect: resolves to the submitted value of the configured
//   field, guarding against missing/removed fields, empty or unsafe values.
// Returns null when there is nothing safe to redirect to.
function resolveRedirectTarget(form, formValues) {
  const raw = form?.redirect_url;
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith(REDIRECT_FIELD_PREFIX)) {
    const fieldId = raw.slice(REDIRECT_FIELD_PREFIX.length);
    if (!fieldId) return null;
    const field = form?.fields?.find((f) => f.id === fieldId);
    if (!field) return null;
    const value = formValues?.[fieldId];
    if (value == null) return null;
    const str = String(value).trim();
    return isSafeDynamicRedirect(str) ? str : null;
  }
  return raw;
}

// Task #2785: `slug` prop allows the top-level catch-all route (DynamicPage)
// to render a form at its pretty URL (/{form-slug}) without the ?slug= query
// param. All other query-driven behaviour (prefill, drafts, contract signing)
// still reads from the URL search string as before.
// Task #3331: `assignmentToken` renders a survey opened via its event
// assignment link (/survey/:token). The server resolves the survey version,
// event, access mode and open/close window from the token — the client never
// supplies an event id.
export default function FormViewPage({ slug: slugProp = null, assignmentToken = null }) {
  const { memberInfo, organizationInfo, authResolved } = useMemberAccess();
  const { setForceBlankLayout } = useLayoutContext();

  const [currentStep, setCurrentStep] = useState(0);
  // Task #3515: never autofocus the first card on initial mount (browsers
  // scroll a focused input into view, yanking embedding pages down to the
  // form); step transitions still focus as before.
  const cardSwipeAutoFocusFor = useCardSwipeAutoFocus(currentStep);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [formValues, setFormValues] = useState({});
  const [emptyRelationshipParentValues, setEmptyRelationshipParentValues] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [fieldValidity, setFieldValidity] = useState({}); // Track format validity for each field
  const [submissionError, setSubmissionError] = useState(null); // Inline error display for validation failures

  // Task #3501: page-level payment return-leg handling. Runs BEFORE any
  // wizard/step state matters — a GoCardless or Stripe 3DS redirect lands
  // back at step 0 with empty values, so the old in-component (last-step
  // only) handling never fired and the user saw a blank cleared form.
  // Clear submission error when form values change (user is correcting their input)
  useEffect(() => {
    if (submissionError) {
      setSubmissionError(null);
    }
  }, [formValues]);

  // Handler for field validity changes from FormRenderer
  const handleValidityChange = (fieldId, isValid) => {
    setFieldValidity(prev => ({ ...prev, [fieldId]: isValid }));
  };

  const handleRelationshipEmptyStateChange = useCallback((fieldId, parentValue) => {
    setEmptyRelationshipParentValues((previous) => {
      if (parentValue == null) {
        if (!(fieldId in previous)) return previous;
        const next = { ...previous };
        delete next[fieldId];
        return next;
      }
      if (previous[fieldId] === parentValue) return previous;
      return { ...previous, [fieldId]: parentValue };
    });
  }, []);

  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(window.location.search);
  const formSlug = slugProp || urlParams.get('slug');
  const urlPrefillMemberId = urlParams.get('member_id');
  const urlPrefillOrgId = urlParams.get('organization_id');
  const prefillBookingId = urlParams.get('booking_id');
  const draftToken = urlParams.get('draft');
  const contractInstanceId = urlParams.get('contract_instance');
  const signerEmail = urlParams.get('signer_email');
  const briefId = urlParams.get('brief_id');
  const vacancyId = urlParams.get('vacancy_id');
  
  // Draft save state
  const [resumeToken, setResumeToken] = useState(draftToken || null);
  const [showResumeLink, setShowResumeLink] = useState(false);
  const [resumeLinkCopied, setResumeLinkCopied] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [schemaChanged, setSchemaChanged] = useState(false);
  const [schemaChangeMessage, setSchemaChangeMessage] = useState(null);

  // Fetch full member record to get job_title (for logged-in user)
  const { data: memberRecord } = useQuery({
    queryKey: ['member-record', memberInfo?.id],
    queryFn: async () => {
      if (memberInfo?.id) {
        return base44.entities.Member.get(memberInfo.id);
      }
      return null;
    },
    enabled: !!memberInfo?.id
  });

  const { data: rawForm, isLoading, error: formError } = useQuery({
    queryKey: assignmentToken
      ? ['public-survey-assignment', assignmentToken, !!memberInfo]
      : ['public-form-by-slug', formSlug, !!memberInfo],
    queryFn: async () => {
      // Task #3331: assignment links resolve everything server-side from the
      // token. When the window is closed / auth is required the payload has
      // no form config — carry the metadata through so the guards below can
      // render the right message instead of "not found".
      if (assignmentToken) {
        const payload = await publicClient.getSurveyAssignment(assignmentToken);
        if (!payload) return null;
        if (payload.form) {
          return { ...payload.form, __assignment: payload };
        }
        return { __assignment: payload, __assignmentBlocked: true, fields: [] };
      }
      // Use publicClient which handles both subdomain and custom domain resolution.
      // Pass the authenticated flag (matching the embedded Canvas form block) so
      // auth-gated forms return their full shape — including pages / per-field
      // page_id — when the viewer has a valid session.
      return publicClient.getForm(formSlug, { authenticated: !!memberInfo });
    },
    enabled: !!formSlug || !!assignmentToken,
    retry: false
  });

  // Assignment metadata (event context + window state) when opened via an
  // assignment link; null for slug-based access.
  const assignmentMeta = rawForm?.__assignment || null;
  const accessPayload = rawForm || (formError?.errorData?.access
    ? { __access: formError.errorData.access }
    : null);
  const formAccess = resolveFormAccess(accessPayload, !!memberInfo);
  // A return-leg confirms only a server-created pending payment. The server
  // checks the live policy for legacy rows and accepts its own authorization
  // proof for already-started payments, so membership changes cannot strand
  // money after the provider redirect.
  const paymentReturn = useFormPaymentReturn();

  // Task #3364: anonymous visitor on an auth-required form (or an
  // auth-required survey assignment) — send them through login and back to
  // this exact URL (slug/params/assignment token preserved) instead of the
  // static "please log in" dead end. Wait for auth resolution so a valid
  // session is never bounced to /login while the authenticated refetch is
  // still in flight.
  const needsLoginRedirect = !memberInfo && !!(
    assignmentMeta?.require_authentication ||
    (!assignmentMeta && rawForm?.require_authentication) ||
    formAccess.anonymous
  );
  useEffect(() => {
    if (!authResolved || !needsLoginRedirect) return;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authResolved, needsLoginRedirect]);

  // Survey presentation (question numbering) — no-op for standard forms
  const form = useMemo(() => applySurveyPresentation(rawForm), [rawForm]);
  useEffect(() => {
    setEmptyRelationshipParentValues({});
  }, [form?.id]);
  const conditionFormValues = useMemo(() => {
    const next = { ...formValues };
    for (const [fieldId, parentValue] of Object.entries(emptyRelationshipParentValues)) {
      const field = form?.fields?.find(candidate => candidate.id === fieldId);
      if (field?.parent_field_id && formValues[field.parent_field_id] === parentValue) {
        next[fieldId] = FORM_NO_RELATIONSHIP_VALUE;
      }
    }
    return next;
  }, [emptyRelationshipParentValues, form?.fields, formValues]);

  // Task #3336: authenticated fallback — when the form uses member/organisation
  // prefill and no explicit URL param is supplied, prefill from the logged-in
  // member and their associated organisation. Explicit URL params always take
  // precedence; anonymous viewers get no fallback. Gated on the loaded form's
  // prefill_source so forms without prefill behave exactly as before.
  const { prefillMemberId, prefillOrgId } = resolveEffectivePrefillIds({
    urlMemberId: urlPrefillMemberId,
    urlOrgId: urlPrefillOrgId,
    prefillSource: form?.prefill_source,
    viewerMemberId: memberInfo?.id,
    viewerOrgId: memberInfo?.organization_id || organizationInfo?.id,
  });


  useEffect(() => {
    if (!isLoading && form) {
      setForceBlankLayout(!!form.blank_layout);
    }
  }, [isLoading, form, setForceBlankLayout]);

  useEffect(() => {
    return () => setForceBlankLayout(false);
  }, [setForceBlankLayout]);

  // Fetch default consent message from public endpoint (works without auth)
  const { data: defaultConsentMessage } = useQuery({
    queryKey: ['formDefaultConsentMessage'],
    queryFn: async () => {
      const data = await publicClient.getFormConsentMessage();
      return data.message || '';
    },
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Load draft if resume token is in URL
  const { data: draftData, isLoading: isDraftLoading } = useQuery({
    queryKey: ['form-draft', draftToken],
    queryFn: async () => {
      // Use publicClient which handles both subdomain and custom domain resolution
      return publicClient.getFormDraft(draftToken);
    },
    enabled: !!draftToken && !draftLoaded && !!rawForm && !formAccess.restricted,
    retry: false
  });

  // Save draft mutation
  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      // Try to find an email field value for contact
      const emailField = form?.fields?.find(f => f.type === 'email');
      const contactEmail = emailField ? formValues[emailField.id] : null;
      
      // Use publicClient which handles tenant resolution via Host header
      const payload = {
        form_slug: formSlug,
        form_id: form?.id,
        draft_data: formValues,
        current_page_index: currentPageIndex,
        contact_email: contactEmail,
        resume_token: resumeToken, // If we have one, update existing draft
        form_updated_at: form?.updated_at
      };
      
      // Note: tenant param not needed - backend resolves from Host header
      return publicClient.saveFormDraft(payload);
    },
    onSuccess: (result) => {
      console.log('[FormView] Draft saved:', result);
      setResumeToken(result.resume_token);
      setShowResumeLink(true);
      toast.success('Your progress has been saved!');
    },
    onError: (error) => {
      console.error('[FormView] Draft save error:', error);
      toast.error(error.message || 'Failed to save your progress');
    }
  });

  // Generate resume URL - preserve existing query params and add/update draft token
  const getResumeUrl = () => {
    if (!resumeToken) return '';
    const baseUrl = window.location.origin;
    const path = window.location.pathname;
    // Preserve existing query params (like slug, tenant, etc.) and add draft token
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

  // Save & Continue Later is enabled per-form via form.allow_save_continue_later
  // (defaults on; treated as on unless explicitly false). Gated at the button render sites.

  // Extract role_id from primary member entity_pipeline for capacity checking
  const primaryMemberRoleId = useMemo(() => {
    const members = form?.entity_pipelines?.members;
    console.log('[FormView] entity_pipelines.members:', members);
    console.log('[FormView] First member object (full):', members?.[0] ? JSON.stringify(members[0], null, 2) : 'none');
    // Try finding by isPrimary (camelCase) or is_primary (snake_case)
    let primaryMember = members?.find(m => m.isPrimary === true || m.is_primary === true);
    if (!primaryMember && members?.length === 1) {
      // Fallback: if only one member config, use it
      primaryMember = members[0];
      console.log('[FormView] No isPrimary/is_primary found, using first member as fallback');
    }
    console.log('[FormView] primaryMember:', primaryMember);
    const roleId = primaryMember?.role_id || null;
    console.log('[FormView] Extracted primaryMemberRoleId:', roleId);
    return roleId;
  }, [form?.entity_pipelines?.members]);

  // Extract organization config for per-org capacity checking
  const orgCapacityConfig = useMemo(() => {
    const orgs = form?.entity_pipelines?.organisations;
    if (!orgs || orgs.length === 0) return null;
    
    // Find primary org (or use first one as fallback)
    let primaryOrg = orgs.find(o => o.isPrimary === true || o.is_primary === true);
    if (!primaryOrg && orgs.length >= 1) {
      primaryOrg = orgs[0];
    }
    
    if (!primaryOrg) return null;
    
    // Get the uniqueness key (usually 'name')
    const uniquenessKey = primaryOrg.uniqueness_key || 'name';
    
    // Find which form field maps to the org name
    const nameMapping = primaryOrg.mappings?.find(m => 
      m.target_field === uniquenessKey && m.source_type === 'field'
    );
    
    if (!nameMapping) {
      console.log('[FormView] No org name mapping found for uniqueness_key:', uniquenessKey);
      return null;
    }
    
    console.log('[FormView] Org capacity config:', {
      uniquenessKey,
      sourceFieldId: nameMapping.source_field_id
    });
    
    return {
      uniquenessKey,
      sourceFieldId: nameMapping.source_field_id,
      hasOrgPipeline: true
    };
  }, [form?.entity_pipelines?.organisations]);

  const { data: prefillMemberData } = useQuery({
    queryKey: ['prefill-member', prefillMemberId, !!memberInfo],
    queryFn: async () => {
      if (memberInfo) {
        const member = await base44.entities.Member.get(prefillMemberId);
        return { member, customValues: null };
      }
      return publicClient.getPrefillMember(prefillMemberId, formSlug);
    },
    enabled: !!prefillMemberId && form?.prefill_source === 'member'
  });

  const prefillMember = prefillMemberData?.member || null;

  // Task #3357: effective org id for member-source forms — member entity's
  // own organization_id, else the authenticated fallback (prefillOrgId).
  const memberSourceOrgId = resolveMemberSourceOrgId({
    prefillSource: form?.prefill_source,
    memberEntity: prefillMember,
    fallbackOrgId: prefillOrgId,
  });

  // Prefill: Fetch member's organization when prefill_source = 'member'
  // This allows forms to prefill org fields even when primary source is member
  // Uses authenticated API when session exists, public endpoint for embedded/unauthenticated access
  const { data: prefillMemberOrg, isLoading: memberOrgLoading } = useQuery({
    queryKey: ['prefill-member-org', memberSourceOrgId, !!memberInfo],
    queryFn: async () => {
      // Use authenticated API if logged in (full data), public API otherwise (safe subset)
      if (memberInfo) {
        return base44.entities.Organization.get(memberSourceOrgId);
      }
      return publicClient.getOrganization(memberSourceOrgId);
    },
    enabled: !!memberSourceOrgId && form?.prefill_source === 'member'
  });

  // Prefill: Fetch organization entity whenever organization_id URL param is present
  // This is needed for per-org capacity checks regardless of prefill_source setting
  // Uses authenticated API when session exists, public endpoint for embedded/unauthenticated access
  const { data: prefillOrg, isLoading: prefillOrgLoading } = useQuery({
    queryKey: ['prefill-org', prefillOrgId, !!memberInfo],
    queryFn: async () => {
      // Use authenticated API if logged in (full data), public API otherwise (safe subset)
      if (memberInfo) {
        return base44.entities.Organization.get(prefillOrgId);
      }
      return publicClient.getOrganization(prefillOrgId);
    },
    enabled: !!prefillOrgId && !!rawForm && !formAccess.restricted
  });

  // Determine the organization name for display in error messages
  const prefillOrgName = useMemo(() => {
    if (prefillOrg?.name) return prefillOrg.name;
    if (prefillMemberOrg?.name) return prefillMemberOrg.name;
    return null;
  }, [prefillOrg, prefillMemberOrg]);

  const { data: explicitBookingData, isLoading: explicitBookingLoading } = useQuery({
    queryKey: ['prefill-booking', prefillBookingId, formSlug],
    queryFn: async () => {
      return publicClient.getPrefillBooking(prefillBookingId, formSlug);
    },
    enabled: !!prefillBookingId && form?.prefill_source === 'booking'
  });

  // Task #3399: authenticated fallback for event-linked booking-prefill forms.
  // With no booking_id on the URL, resolve the logged-in member's own booking
  // for the form's linked event server-side (session-derived member — never a
  // client-supplied id). Explicit booking_id always wins (this query is
  // disabled when the param is present); anonymous viewers and non-event-linked
  // forms get an empty payload and degrade to blank fields as before. Gated on
  // authResolved so it never races the session check.
  const { data: viewerBookingData, isLoading: viewerBookingLoading, error: viewerBookingError } = useQuery({
    queryKey: ['prefill-booking-viewer', formSlug, memberInfo?.id],
    queryFn: async () => {
      return publicClient.getPrefillBookingForViewer(formSlug);
    },
    enabled: shouldFetchViewerBookingPrefill({
      prefillSource: form?.prefill_source,
      urlBookingId: prefillBookingId,
      authResolved,
      viewerMemberId: memberInfo?.id,
      formSlug,
    }),
    retry: false
  });

  const prefillBookingData = prefillBookingId ? explicitBookingData : viewerBookingData;
  const bookingPrefillLoading = prefillBookingId ? explicitBookingLoading : viewerBookingLoading;

  const prefillBooking = prefillBookingData?.booking || null;
  const prefillBookingMember = prefillBookingData?.member || null;
  const prefillBookingMemberCustomValues = prefillBookingData?.memberCustomValues || [];
  const prefillBookingOrg = prefillBookingData?.organization || null;
  const prefillBookingOrgCustomValues = prefillBookingData?.orgCustomValues || [];

  const prefillData = useMemo(() => {
    const source = form?.prefill_source;
    if (source === 'booking') {
      return {
        booking: prefillBooking,
        member: prefillBookingMember,
        organization: prefillBookingOrg,
        memberCustomValues: prefillBookingMemberCustomValues,
        orgCustomValues: prefillBookingOrgCustomValues,
      };
    }
    if (source === 'member') {
      return {
        member: prefillMember,
        organization: prefillMemberOrg || prefillOrg,
      };
    }
    if (source === 'organization') {
      return {
        organization: prefillOrg,
      };
    }
    return null;
  }, [form?.prefill_source, prefillBooking, prefillBookingMember, prefillBookingOrg, prefillBookingMemberCustomValues, prefillBookingOrgCustomValues, prefillMember, prefillMemberOrg, prefillOrg]);

  // Effective org ID for capacity checking - works for both prefill cases:
  // 1. Direct org prefill via organization_id URL param
  // 2. Member prefill where org comes from member's organization_id
  const effectiveOrgIdForCapacity = useMemo(() => {
    if (prefillOrgId) {
      console.log('[FormView] Using prefillOrgId for capacity:', prefillOrgId);
      return prefillOrgId;
    }
    if (prefillMember?.organization_id) {
      console.log('[FormView] Using prefillMember.organization_id for capacity:', prefillMember.organization_id);
      return prefillMember.organization_id;
    }
    if (prefillBooking?.organization_id) {
      return prefillBooking.organization_id;
    }
    if (prefillBookingMember?.organization_id) {
      return prefillBookingMember.organization_id;
    }
    return null;
  }, [prefillOrgId, prefillMember?.organization_id, prefillBooking?.organization_id, prefillBookingMember?.organization_id]);

  // Check role capacity before allowing form submission
  // Role capacity is ALWAYS per-organization - no global fallback
  // Uses effectiveOrgIdForCapacity for lookup (handles both org prefill and member prefill)
  const { data: roleCapacity, isLoading: isCheckingCapacity } = useQuery({
    queryKey: ['role-capacity-check', primaryMemberRoleId, effectiveOrgIdForCapacity],
    queryFn: async () => {
      console.log('[FormView] Fetching capacity for role:', primaryMemberRoleId);
      
      // Role capacity is always per-organization - use orgId for direct lookup
      if (!effectiveOrgIdForCapacity) {
        console.error('[FormView] Cannot check capacity: organization ID is required');
        return { hasCapacity: false, error: 'Organization context required for capacity check', missingOrgContext: true };
      }
      
      // Use orgId for direct lookup (more reliable than name-based lookup)
      const url = `/api/public/role/${primaryMemberRoleId}/capacity?orgId=${encodeURIComponent(effectiveOrgIdForCapacity)}`;
      console.log('[FormView] Per-org capacity check using orgId:', { roleId: primaryMemberRoleId, orgId: effectiveOrgIdForCapacity });
      
      const response = await fetch(url);
      console.log('[FormView] Capacity API response status:', response.status);
      if (!response.ok) {
        console.error('[FormView] Failed to check role capacity');
        return { hasCapacity: true }; // Allow form on API error (fail open)
      }
      const data = await response.json();
      console.log('[FormView] Capacity API response data:', data);
      if (data.debug) {
        console.log('[FormView] Capacity DEBUG - activeMembersWithRoleInOrg:', data.debug.activeMembersWithRoleInOrg);
      }
      return data;
    },
    // Only run capacity check when we have role AND org ID (from any source)
    enabled: !!primaryMemberRoleId && !!effectiveOrgIdForCapacity,
    staleTime: 30 * 1000 // Re-check every 30 seconds
  });

  // Log capacity check state on every render
  console.log('[FormView] Capacity check state:', {
    primaryMemberRoleId,
    isCheckingCapacity,
    roleCapacity,
    prefillOrgName,
    effectiveOrgIdForCapacity,
    orgCapacityConfig,
    formSlug,
    formLoaded: !!form
  });

  // Find the organisation_dropdown field (if any) to determine selected org for domain validation
  const orgDropdownField = useMemo(() => {
    return (form?.fields || []).find(f => f.type === 'organisation_dropdown');
  }, [form?.fields]);

  // The organisation the SUBMISSION will carry (Task #3498): must mirror
  // buildSubmissionPayload's resolution exactly, because the membership fee
  // quote and the payment-create both key off prefill_organization_id —
  // priority: prefill org, then org-pipeline dropdown, then standalone
  // org dropdown.
  const resolvedOrgIdForSubmission = useMemo(() => {
    if (effectiveOrgIdForCapacity) return effectiveOrgIdForCapacity;
    if (orgCapacityConfig?.sourceFieldId) {
      const sourceField = form?.fields?.find(f => f.id === orgCapacityConfig.sourceFieldId);
      if (sourceField?.type === 'organisation_dropdown' && formValues[orgCapacityConfig.sourceFieldId]) {
        return formValues[orgCapacityConfig.sourceFieldId];
      }
    }
    if (orgDropdownField && formValues[orgDropdownField.id]) {
      return formValues[orgDropdownField.id];
    }
    return null;
  }, [effectiveOrgIdForCapacity, orgCapacityConfig?.sourceFieldId, orgDropdownField, formValues, form?.fields]);

  // Get the selected org ID from form dropdown, URL prefill, or the
  // logged-in user's own organisation. The third path matters so that a
  // logged-in member submitting a form with a domain-restricted email field
  // also sees the friendly "a guest account will be created…" message when
  // their org accepts guests, instead of an outright domain error.
  const selectedOrgId = useMemo(() => {
    // First priority: org selected in the organisation_dropdown field
    if (orgDropdownField && formValues[orgDropdownField.id]) {
      return formValues[orgDropdownField.id];
    }
    // Second priority: prefilled org from URL (for organization prefill source)
    if (prefillOrgId) {
      return prefillOrgId;
    }
    // Third priority: the logged-in user's own organisation
    if (organizationInfo?.id) {
      return organizationInfo.id;
    }
    return null;
  }, [orgDropdownField, formValues, prefillOrgId, organizationInfo?.id]);

  // Fetch the selected organization for domain validation (uses public endpoint for unauthenticated access)
  const { data: selectedOrg } = useQuery({
    queryKey: ['selected-org-for-validation', selectedOrgId],
    queryFn: async () => await publicClient.getOrganizationDomains(selectedOrgId) || null,
    enabled: !!selectedOrgId && !!rawForm && !formAccess.restricted,
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Compute effective organization for email domain validation
  // Priority: selected org from form > prefill org > logged-in user's org
  const effectiveOrganizationInfo = useMemo(() => {
    return selectedOrg || prefillOrg || organizationInfo;
  }, [selectedOrg, prefillOrg, organizationInfo]);

  // Effective guest-access info for the selected org (only set when an org is
  // actually selected via the form's org dropdown or URL prefill). Used by
  // FormRenderer to bypass the verified-domain check with a friendly message
  // when the org accepts guests. Normalised to a stable shape so FormRenderer
  // doesn't depend on the public endpoint's wire format.
  const selectedOrgGuestAccess = useMemo(() => {
    const ga = selectedOrg?.guest_access;
    if (!ga) return null;
    return {
      accepts_guests: !!ga.enabled,
      unlimited: !!ga.unlimited,
      default_period_days: ga.period_days ?? null,
    };
  }, [selectedOrg]);

  const { data: prefillMemberCustomValues = [], isLoading: memberCustomValuesLoading } = useQuery({
    queryKey: ['prefill-member-custom-values', prefillMemberId, !!memberInfo],
    queryFn: async () => {
      if (memberInfo) {
        const values = await base44.entities.MemberPreferenceValue.list({
          filter: { member_id: prefillMemberId }
        });
        return values || [];
      }
      return prefillMemberData?.customValues || [];
    },
    enabled: !!prefillMemberId && form?.prefill_source === 'member' && (!!memberInfo || !!prefillMemberData)
  });

  // Prefill: Fetch org custom field values (either from direct org prefill or from member's org)
  // Uses public endpoint to support unauthenticated form viewing
  const effectiveOrgIdForCustomFields = form?.prefill_source === 'organization' 
    ? prefillOrgId 
    : memberSourceOrgId;
  
  // DEBUG: Log the org custom field query setup
  console.log('[FormView DEBUG] Org Custom Fields Query Setup:', {
    formPrefillSource: form?.prefill_source,
    prefillOrgId,
    prefillMemberOrgId: prefillMember?.organization_id,
    effectiveOrgIdForCustomFields,
    queryEnabled: !!effectiveOrgIdForCustomFields && form?.prefill_source && form.prefill_source !== 'none'
  });
  
  const { data: prefillOrgCustomValues = [], isLoading: orgCustomValuesLoading, error: orgCustomValuesError } = useQuery({
    queryKey: ['prefill-org-custom-values', effectiveOrgIdForCustomFields],
    queryFn: async () => {
      console.log('[FormView DEBUG] Fetching org custom values for org:', effectiveOrgIdForCustomFields);
      const values = await publicClient.getOrganizationPreferenceValues(effectiveOrgIdForCustomFields);
      console.log('[FormView DEBUG] Org custom values API response:', values);
      return values;
    },
    enabled: !!effectiveOrgIdForCustomFields && form?.prefill_source && form.prefill_source !== 'none'
  });
  
  // DEBUG: Log org custom values state
  console.log('[FormView DEBUG] Org Custom Values State:', {
    prefillOrgCustomValues,
    orgCustomValuesLoading,
    orgCustomValuesError: orgCustomValuesError?.message
  });

  // Track if prefill has been applied to prevent overwriting user edits
  const [prefillApplied, setPrefillApplied] = useState(false);
  
  // Track if boolean defaults have been initialized for this form
  const [defaultsInitialized, setDefaultsInitialized] = useState(false);
  useFormFieldPrefill({
    form,
    formSlug,
    formValues,
    setFormValues,
    enabled: !!form && !formAccess.restricted && defaultsInitialized,
  });
  
  // Reset page navigation state when form changes
  useEffect(() => {
    setCurrentPageIndex(0);
    setCurrentStep(0);
    setSubmitted(false);
    setPrefillApplied(false);
    setDefaultsInitialized(false);
    setDraftLoaded(false); // Reset so draft can be re-applied after form loads
    setFormValues({});
  }, [form?.id]);
  
  // Initialize all fields with their default values
  // This runs after reset and sets the flag to allow prefill to proceed
  useEffect(() => {
    if (!form?.fields || defaultsInitialized) return;
    
    const fieldDefaults = {};
    for (const field of form.fields) {
      // Boolean fields - use default_value or false
      if (field.type === 'boolean') {
        fieldDefaults[field.id] = field.default_value === true ? true : false;
        continue;
      }
      
      // Terms conditions - always start unchecked
      if (field.type === 'terms_conditions') {
        fieldDefaults[field.id] = false;
        continue;
      }
      
      // Country fields - use default_country if set; resolve ISO code → display
      // name so that rule comparisons (which use the display name that the
      // combobox stores on user-selection) work correctly on untouched forms.
      if (field.type === 'country' && field.default_country) {
        const resolvedName = COUNTRIES.find(c => c.code === field.default_country)?.name || field.default_country;
        fieldDefaults[field.id] = resolvedName;
        console.log(`[FormView Init] Country field "${field.label}" (${field.id}) initialized with default_country:`, resolvedName);
        continue;
      }
      
      // Countries (multi-select) fields - use default_countries if set; resolve
      // each ISO code to its display name for rule-evaluation parity.
      if (field.type === 'countries' && field.default_countries?.length > 0) {
        const resolvedNames = field.default_countries.map(
          code => COUNTRIES.find(c => c.code === code)?.name || code
        );
        fieldDefaults[field.id] = resolvedNames;
        console.log(`[FormView Init] Countries field "${field.label}" (${field.id}) initialized with default_countries:`, resolvedNames);
        continue;
      }
      
      // All other field types - use default_value if set
      if (field.default_value !== undefined && field.default_value !== null && field.default_value !== '') {
        fieldDefaults[field.id] = field.default_value;
        console.log(`[FormView Init] Field "${field.label}" (${field.id}) initialized with default_value:`, field.default_value);
        continue;
      }
      
      // Hidden fields need to be initialized even without default_value
      // so that set_value rules can populate them
      if ((field.starts_hidden === true || field.starts_hidden === 'true')) {
        fieldDefaults[field.id] = '';
        console.log(`[FormView Init] Hidden field "${field.label}" (${field.id}) initialized with empty string (no default_value)`);
      }
    }
    
    if (Object.keys(fieldDefaults).length > 0) {
      setFormValues(prev => ({ ...prev, ...fieldDefaults }));
    }
    setDefaultsInitialized(true);
  }, [form?.fields, defaultsInitialized]);

  // Apply draft data when loaded - must wait for defaults to be initialized first
  // This ensures draft values override any defaults, not the other way around
  useEffect(() => {
    if (draftData?.success && !draftLoaded && defaultsInitialized) {
      console.log('[FormView] Loading draft data (after defaults initialized):', draftData);
      setFormValues(prev => ({ ...prev, ...draftData.draft.draft_data }));
      if (draftData.draft.current_page_index) {
        setCurrentPageIndex(draftData.draft.current_page_index);
      }
      setDraftLoaded(true);
      // Mark prefill as applied so it doesn't overwrite draft values
      setPrefillApplied(true);
      if (draftData.schema_changed) {
        setSchemaChanged(true);
        setSchemaChangeMessage(draftData.message);
      }
      toast.success('Your saved progress has been restored');
    }
  }, [draftData, draftLoaded, defaultsInitialized]);

  // Prefill: Populate form values when prefill entity loads (one-time only)
  // Must wait for defaultsInitialized to ensure boolean defaults are set first
  // Get the effective org entity (direct prefill org or member's org)
  const effectiveOrgEntity = form?.prefill_source === 'organization' ? prefillOrg : (prefillMemberOrg || prefillOrg);
  
  useEffect(() => {
    if (!form || !form.prefill_source || form.prefill_source === 'none') return;
    if (!defaultsInitialized) return;
    if (prefillApplied) return;
    
    if (draftToken && !draftLoaded) {
      console.log('[FormView Prefill] Waiting for draft to load before prefill...');
      return;
    }
    
    // Wait for BOTH member and organisation custom values before applying —
    // the entity can resolve first (e.g. member loads before the member-org
    // custom-values query settles), and applying then would latch
    // prefillApplied and permanently skip custom-field prefills.
    // authenticated:true because FormView's custom-value queries also run for
    // anonymous viewers via the public endpoints.
    if (shouldWaitForPrefillCustomValues({
      prefillSource: form.prefill_source,
      authenticated: true,
      memberId: prefillMemberId,
      orgIdForCustomFields: effectiveOrgIdForCustomFields,
      memberCustomValuesLoading,
      orgCustomValuesLoading,
    })) {
      console.log('[FormView Prefill] Waiting for custom values to load...');
      return;
    }

    // Task #3357: also wait while an org-entity fetch that will feed
    // `org:`-mapped fields is still in flight, so the effect can't latch
    // before the organisation resolves.
    if (shouldWaitForPrefillOrgEntity({
      prefillSource: form.prefill_source,
      form,
      effectiveOrgId: form.prefill_source === 'organization' ? prefillOrgId : memberSourceOrgId,
      orgEntityLoading: form.prefill_source === 'organization' ? prefillOrgLoading : memberOrgLoading,
    })) {
      console.log('[FormView Prefill] Waiting for org entity to load...');
      return;
    }
    
    if (form.prefill_source === 'booking' && bookingPrefillLoading) {
      console.log('[FormView Prefill] Waiting for booking prefill data to load...');
      return;
    }
    
    // Resolve entities based on prefill source
    let memberEntity, orgEntity, activeMemberCustomValues, activeOrgCustomValues;
    
    if (form.prefill_source === 'booking') {
      if (!prefillBooking) return;
      memberEntity = prefillBookingMember;
      orgEntity = prefillBookingOrg;
      activeMemberCustomValues = prefillBookingMemberCustomValues;
      activeOrgCustomValues = prefillBookingOrgCustomValues;
    } else {
      memberEntity = prefillMember;
      orgEntity = effectiveOrgEntity;
      activeMemberCustomValues = prefillMemberCustomValues;
      activeOrgCustomValues = prefillOrgCustomValues;
    }
    
    const primaryEntity = form.prefill_source === 'member' ? memberEntity 
      : form.prefill_source === 'organization' ? orgEntity 
      : prefillBooking;
    if (!primaryEntity) return;
    
    console.log('[FormView Prefill] ---------- PREFILL DEBUG START ----------');
    console.log('[FormView Prefill] Form prefill_source:', form.prefill_source);
    console.log('[FormView Prefill] Booking entity:', prefillBooking);
    console.log('[FormView Prefill] Member entity:', memberEntity);
    console.log('[FormView Prefill] Org entity:', orgEntity);
    console.log('[FormView Prefill] Fields with prefill_field configured:', 
      form.fields?.filter(f => f.prefill_field).map(f => ({id: f.id, label: f.label, prefill_field: f.prefill_field})));
    
    const newValues = {};
    for (const field of (form.fields || [])) {
      if (field.type === 'organisation_dropdown') {
        if (form.prefill_source === 'organization' && prefillOrgId) {
          newValues[field.id] = prefillOrgId;
        } else if (form.prefill_source === 'member' && (memberEntity?.organization_id || memberSourceOrgId)) {
          newValues[field.id] = memberEntity?.organization_id || memberSourceOrgId;
        } else if (form.prefill_source === 'booking') {
          const orgId = prefillBooking?.organization_id || prefillBookingMember?.organization_id;
          if (orgId) newValues[field.id] = orgId;
        }
        continue;
      }

      if (field.type === 'organisation_group_dropdown') {
        const groupId = prefillBookingData?.organizationGroupId
          || memberEntity?.organization_group_id
          || orgEntity?.organization_group_id;
        if (groupId) newValues[field.id] = groupId;
        continue;
      }
      
      if (!field.prefill_field) continue;
      
      const prefillField = field.prefill_field;
      let value = null;
      
      if (prefillField.startsWith('booking:')) {
        const fieldName = prefillField.replace('booking:', '');
        value = prefillBooking?.[fieldName];
        console.log(`[FormView Prefill] ${field.label}: booking:${fieldName} = "${value}"`);
      } else if (prefillField.startsWith('member:')) {
        const fieldName = prefillField.replace('member:', '');
        value = memberEntity?.[fieldName];
        console.log(`[FormView Prefill] ${field.label}: member:${fieldName} = "${value}"`);
      } else if (prefillField.startsWith('org:')) {
        const fieldName = prefillField.replace('org:', '');
        value = orgEntity?.[fieldName];
        console.log(`[FormView Prefill] ${field.label}: org:${fieldName} = "${value}"`);
      } else if (prefillField.startsWith('member_custom:')) {
        const customFieldId = prefillField.replace('member_custom:', '');
        const cfv = activeMemberCustomValues.find(v => v.field_id === customFieldId);
        value = parseCustomFieldValue(cfv, field.type);
        console.log(`[FormView Prefill] ${field.label}: member_custom:${customFieldId} = "${value}"`);
      } else if (prefillField.startsWith('org_custom:')) {
        const customFieldId = prefillField.replace('org_custom:', '');
        const cfv = activeOrgCustomValues.find(v => v.field_id === customFieldId);
        value = parseCustomFieldValue(cfv, field.type);
        console.log(`[FormView Prefill] ${field.label}: org_custom:${customFieldId} = "${value}"`);
      } else if (prefillField.startsWith('custom:')) {
        const customFieldId = prefillField.replace('custom:', '');
        const customValues = form.prefill_source === 'member' ? activeMemberCustomValues : activeOrgCustomValues;
        const cfv = customValues.find(v => v.field_id === customFieldId);
        value = parseCustomFieldValue(cfv, field.type);
        console.log(`[FormView Prefill] ${field.label}: custom:${customFieldId} (legacy) = "${value}"`);
      } else {
        value = primaryEntity?.[prefillField];
        console.log(`[FormView Prefill] ${field.label}: ${prefillField} (legacy) = "${value}"`);
      }
      
      if (value !== null && value !== undefined) {
        newValues[field.id] = value;
      }
    }
    
    console.log('[FormView Prefill] Total newValues to apply:', Object.keys(newValues).length, newValues);
    
    if (Object.keys(newValues).length > 0) {
      setFormValues(prev => {
        const merged = { ...prev };
        for (const [key, value] of Object.entries(newValues)) {
          const field = form.fields?.find(f => f.id === key);
          if (field?.type === 'boolean') {
            merged[key] = value;
          } else if (prev[key] === undefined || prev[key] === '' || prev[key] === null) {
            merged[key] = value;
          }
        }
        console.log('[FormView Prefill] Merged formValues:', merged);
        return merged;
      });
    } else {
      console.log('[FormView Prefill] No newValues to apply - check if fields have prefill_field configured');
    }
    // Latch even when nothing matched: the target entity and custom values
    // have settled, so an empty result is final. Without this, a later query
    // refetch could re-run prefill and overwrite values the user has since
    // edited.
    setPrefillApplied(true);
  }, [form, prefillMember, effectiveOrgEntity, prefillMemberCustomValues, prefillOrgCustomValues, prefillApplied, defaultsInitialized, prefillOrgId, prefillMemberId, memberSourceOrgId, memberOrgLoading, prefillOrgLoading, effectiveOrgIdForCustomFields, orgCustomValuesLoading, memberCustomValuesLoading, draftToken, draftLoaded, prefillBooking, prefillBookingMember, prefillBookingOrg, prefillBookingMemberCustomValues, prefillBookingOrgCustomValues, bookingPrefillLoading]);

  // Duplicate-submission guard: shared per-session idempotency key (sent on
  // every attempt, rotated only after a successful submit).
  const { getIdempotencyKey, rotateIdempotencyKey } = useSubmissionIdempotencyKey();

  // Per-submission side-effect runs (emails, field mappings), keyed by
  // submission id. When the server collapses a double submission and returns
  // the SAME row to both callbacks, only the first callback to claim the id
  // runs the side effects; the other awaits that run before showing the
  // success UI/redirect. Exactly-once: never twice (duplicate emails) and
  // never zero times (duplicate response arriving before the original one).
  const submissionSideEffectRunsRef = useRef(new Map());

  const submitFormMutation = useMutation({
    mutationFn: async (submissionData) => {
      // Use public API endpoint that doesn't require authentication
      const host = window.location.hostname;
      const tenantSlug = host.split('.')[0];
      
      const response = await fetch('/api/public/form-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send session cookies so require_authentication surveys accept a
        // logged-in member even when the form is served cross-origin.
        credentials: 'include',
        body: JSON.stringify({
          ...submissionData,
          // Task #3331: the assignment token lets the server stamp the
          // event/assignment/version — never a client-supplied event id.
          ...(assignmentToken && { assignment_token: assignmentToken }),
          idempotency_key: getIdempotencyKey(),
          tenant: tenantSlug
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to submit form');
      }
      
      return response.json();
    },
    onSuccess: async (submissionResult) => {
      const submissionId = submissionResult?.id || null;

      // Finalize the UI exactly once per callback: rotate the idempotency
      // key so a legitimate NEW submission from this page load isn't
      // collapsed into this one, then show success/redirect.
      const finalize = () => {
        queryClient.invalidateQueries({ queryKey: ['form-by-slug'] });
        rotateIdempotencyKey();
        setSubmitted(true);
        const redirectTarget = resolveRedirectTarget(form, formValues);
        if (redirectTarget) {
          setTimeout(() => {
            window.location.href = redirectTarget;
          }, 2000);
        }
      };

      // Exactly-once side effects: when the server collapses a double
      // submission, both callbacks receive the SAME submission id (the
      // second with a `duplicate: true` marker). Whichever callback claims
      // the id first runs the side effects; the other awaits that run so
      // the redirect can't fire while the email call is still in flight.
      const existingRun = submissionId
        ? submissionSideEffectRunsRef.current.get(submissionId)
        : null;
      if (existingRun) {
        console.log('[FormView] Duplicate submission collapsed — awaiting original side effects for', submissionId);
        try {
          await existingRun;
        } catch {
          // Side-effect failures never block the success UI.
        }
        finalize();
        return;
      }

      const runSideEffects = async () => {
      let createdMemberId = submissionResult?.created_member_id || null;
      let createdOrganizationId = submissionResult?.created_organization_id || null;
      
      if (memberInfo) {
        if (form) {
          try {
            await base44.entities.Form.update(form.id, {
              submission_count: (form.submission_count || 0) + 1
            });
          } catch (err) {
            console.log('[FormView] Could not update form count (may be unauthenticated)');
          }
        }
        
        const hasEntityPipelines = (form?.entity_pipelines?.members?.length > 0) || (form?.entity_pipelines?.organisations?.length > 0);
        if (!hasEntityPipelines) {
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
      }
      
      // Send submission email if configured
      // ALWAYS call the server endpoint for diagnostic logging (server decides if email is configured)
      try {
        console.log('[FormView] Calling email endpoint for form submission...');
        console.log('[FormView] Passing createdMemberId:', createdMemberId, 'createdOrganizationId:', createdOrganizationId);
        const emailPayload = {
          form_id: form.id,
          submission_id: submissionResult?.id,
          form_values: formValues,
          fields: form.fields,
          created_member_id: createdMemberId,
          created_organization_id: createdOrganizationId,
          _debug_form_email_config: {
            hasSubmissionEmails: !!form?.submission_emails,
            submissionEmailsCount: form?.submission_emails?.length || 0,
            submissionEmailsValue: form?.submission_emails || null,
            legacyTemplateId: form?.submission_email_template_id || null,
            legacyRecipient: form?.submission_email_recipient || null
          }
        };
        
        const emailResponse = await fetch('/api/forms/send-submission-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload)
        });
        console.log('[FormView] Email response status:', emailResponse.status);
        const emailResult = await emailResponse.json();
        console.log('[FormView] Submission email result:', emailResult);
      } catch (error) {
        console.error('[FormView] Error sending submission email:', error);
      }
      };

      // Claim the submission id BEFORE awaiting so a concurrently-arriving
      // duplicate callback finds the run and awaits it instead of re-running.
      const run = runSideEffects();
      if (submissionId) {
        submissionSideEffectRunsRef.current.set(submissionId, run);
      }
      try {
        await run;
      } catch (error) {
        console.error('[FormView] Post-submit side effects failed:', error);
      }
      finalize();
    },
    onError: (error) => {
      console.error('[FormView] Submit error:', error);
      setSubmissionError(error.message || 'Failed to submit form');
    }
  });

  // Helper to evaluate a single condition
  const evaluateSingleCondition = (triggerValue, operator, value, debugInfo = {}) => {
    // LMIC operators on country fields (Task #3477) — compared against the
    // tenant LMIC list delivered with the form payload.
    const lmicResult = evaluateLmicCondition(triggerValue, operator, form?.lmic_country_codes);
    if (lmicResult !== undefined) return lmicResult;
    // Defensive: if a country field value was seeded as an ISO-2 code (e.g.
    // from a legacy in-flight session or server-side code path), resolve it to
    // the display name so comparisons against names like "United Kingdom" work.
    if (typeof triggerValue === 'string' && /^[A-Z]{2}$/.test(triggerValue)) {
      const resolved = COUNTRIES.find(c => c.code === triggerValue)?.name;
      if (resolved) triggerValue = resolved;
    }
    // Survey Score answers ({score}/{na}) + numeric operators (Task #3330)
    const scoreResult = evaluateScoreCondition(triggerValue, operator, value);
    if (scoreResult !== undefined) return scoreResult;
    const conditionField = form?.fields?.find(field => field.id === debugInfo.fieldId);
    const parentFieldId = conditionField?.type === 'relationship_dropdown'
      ? conditionField.parent_field_id
      : null;
    const relationshipEmpty = !!parentFieldId
      && emptyRelationshipParentValues[conditionField.id] === formValues[parentFieldId];
    const result = evaluateFormLogicCondition(triggerValue, operator, value, { relationshipEmpty });
    console.log(`[SetValue Debug] Condition: triggerValue="${triggerValue}" (type: ${typeof triggerValue}) ${operator} "${value}" (type: ${typeof value}) => ${result}`, debugInfo);
    return result;
  };

  // Helper to evaluate all conditions in a rule with AND/OR logic
  const evaluateRuleConditions = (rule, formValues) => {
    console.log(`[SetValue Debug] Evaluating rule: ${rule.id}`, { rule, formValues });
    
    // Check for legacy format FIRST - single trigger_field_id takes precedence for backward compat
    // This handles forms saved before the conditions array was introduced
    if (rule.trigger_field_id && (!rule.conditions || !Array.isArray(rule.conditions) || rule.conditions.length === 0)) {
      const triggerValue = formValues[rule.trigger_field_id];
      const result = evaluateSingleCondition(triggerValue, rule.operator, rule.value, {
        ruleId: rule.id,
        fieldId: rule.trigger_field_id,
        format: 'legacy',
      });
      console.log(`[SetValue Debug] Rule ${rule.id} (legacy format) => ${result}`);
      return result;
    }
    
    // New format: rule has conditions array
    if (rule.conditions && Array.isArray(rule.conditions) && rule.conditions.length > 0) {
      const logic = rule.logic || 'and';
      console.log(`[SetValue Debug] Rule ${rule.id}: Evaluating ${rule.conditions.length} conditions with ${logic.toUpperCase()} logic`);
      
      const results = rule.conditions.map((condition, idx) => {
        if (!condition.field_id) {
          console.log(`[SetValue Debug] Rule ${rule.id}, Condition ${idx}: No field_id, returning false`);
          return false;
        }
        const triggerValue = formValues[condition.field_id];
        return evaluateSingleCondition(triggerValue, condition.operator, condition.value, { 
          ruleId: rule.id, 
          conditionIdx: idx, 
          fieldId: condition.field_id,
          format: 'new'
        });
      });
      
      // AND logic: all conditions must be true
      // OR logic: at least one condition must be true
      let finalResult;
      if (logic === 'and') {
        finalResult = results.every(r => r === true);
      } else {
        finalResult = results.some(r => r === true);
      }
      
      console.log(`[SetValue Debug] Rule ${rule.id}: ${logic.toUpperCase()} of [${results.join(', ')}] => ${finalResult}`);
      return finalResult;
    }
    
    console.log(`[SetValue Debug] Rule ${rule.id}: No conditions to evaluate, returning false`);
    return false;
  };

  // Backward-compatible wrapper for legacy code paths
  const evaluateCondition = (triggerValue, operator, value) => {
    return evaluateSingleCondition(triggerValue, operator, value);
  };

  const formPages = form?.pages || [];
  const pageIdSet = useMemo(() => {
    return new Set(formPages.map(p => p.id));
  }, [formPages]);

  // Compute initial hidden fields from field.starts_hidden property
  // This property is set by FormBuilder when a 'show' rule targets the field
  // Fallback: Also check visibility_rules for legacy forms without starts_hidden
  const initialHiddenFieldIds = useMemo(() => {
    const hidden = new Set();
    
    // First, check field.starts_hidden (newer forms)
    // Handle both boolean true and string "true" for robustness
    for (const field of (form?.fields || [])) {
      if (field.starts_hidden === true || field.starts_hidden === 'true') {
        console.log(`[FormView Init] Field "${field.label}" (${field.id}) has starts_hidden=${field.starts_hidden}, adding to initial hidden`);
        hidden.add(field.id);
      }
    }
    console.log('[FormView Init] Initial hidden fields from starts_hidden:', Array.from(hidden));
    
    // Fallback: For legacy forms, compute from visibility_rules
    if (hidden.size === 0 && form?.visibility_rules?.length > 0) {
      for (const rule of form.visibility_rules) {
        if (rule.actions && Array.isArray(rule.actions)) {
          for (const action of rule.actions) {
            if (action.action_type === 'visibility' && action.field_states) {
              for (const [fieldId, state] of Object.entries(action.field_states)) {
                if (state.visible === true && !pageIdSet.has(fieldId)) {
                  hidden.add(fieldId);
                }
              }
            }
            else if (action.action_type === 'show' && action.target_field_ids?.length) {
              action.target_field_ids.forEach(id => hidden.add(id));
            }
          }
        }
        else if (rule.action === 'show' && rule.target_field_ids?.length) {
          rule.target_field_ids.forEach(id => hidden.add(id));
        }
      }
    }
    
    return hidden;
  }, [form?.fields, form?.visibility_rules, pageIdSet]);

  const initialHiddenPageIds = useMemo(() => {
    const hidden = new Set();
    for (const page of formPages) {
      if (page.starts_hidden === true || page.starts_hidden === 'true') {
        hidden.add(page.id);
      }
    }
    if (form?.visibility_rules?.length > 0) {
      for (const rule of form.visibility_rules) {
        if (rule.actions && Array.isArray(rule.actions)) {
          for (const action of rule.actions) {
            if (action.action_type === 'visibility' && action.field_states) {
              for (const [id, state] of Object.entries(action.field_states)) {
                if (state.visible === true && pageIdSet.has(id)) {
                  hidden.add(id);
                }
              }
            }
          }
        }
      }
    }
    return hidden;
  }, [formPages, form?.visibility_rules, pageIdSet]);

  // Evaluate visibility rules to determine which fields and pages should be hidden
  // Key principle: Fields with "show" rules START HIDDEN and only become visible when condition is met
  const { hiddenFieldIds, hiddenPageIds } = useMemo(() => {
    const hiddenFields = new Set(initialHiddenFieldIds);
    const hiddenPages = new Set(initialHiddenPageIds);
    
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      if (hiddenPages.size > 0) {
        for (const field of (form?.fields || [])) {
          if (field.page_id && hiddenPages.has(field.page_id)) {
            hiddenFields.add(field.id);
          }
        }
      }
      return { hiddenFieldIds: hiddenFields, hiddenPageIds: hiddenPages };
    }
    
    const fieldVisibility = {};
    const pageVisibility = {};
    
    for (const rule of form.visibility_rules) {
      if (!rule.conditions?.length && !rule.trigger_field_id) continue;
      
      const conditionMet = evaluateRuleConditions(rule, formValues);

      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'visibility' && action.field_states) {
            for (const [targetId, state] of Object.entries(action.field_states)) {
              const isPage = pageIdSet.has(targetId);
              const visMap = isPage ? pageVisibility : fieldVisibility;
              if (!visMap[targetId]) {
                visMap[targetId] = { showRules: [], hideRules: [] };
              }
              if (state.visible === true) {
                visMap[targetId].showRules.push(conditionMet);
              } else if (state.visible === false) {
                visMap[targetId].hideRules.push(conditionMet);
              }
            }
          }
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
    
    for (const [fieldId, { showRules, hideRules }] of Object.entries(fieldVisibility)) {
      const anyShowConditionMet = showRules.some(result => result === true);
      if (anyShowConditionMet) {
        hiddenFields.delete(fieldId);
      }
      const anyHideConditionMet = hideRules.some(result => result === true);
      if (anyHideConditionMet) {
        hiddenFields.add(fieldId);
      }
    }

    for (const [pageId, { showRules, hideRules }] of Object.entries(pageVisibility)) {
      const anyShowConditionMet = showRules.some(result => result === true);
      if (anyShowConditionMet) {
        hiddenPages.delete(pageId);
      }
      const anyHideConditionMet = hideRules.some(result => result === true);
      if (anyHideConditionMet) {
        hiddenPages.add(pageId);
      }
    }

    if (hiddenPages.size > 0) {
      for (const field of (form?.fields || [])) {
        if (field.page_id && hiddenPages.has(field.page_id)) {
          hiddenFields.add(field.id);
        }
      }
    }
    
    return { hiddenFieldIds: hiddenFields, hiddenPageIds: hiddenPages };
  }, [form?.visibility_rules, form?.fields, formValues, emptyRelationshipParentValues, initialHiddenFieldIds, initialHiddenPageIds, pageIdSet]);

  const visiblePagesForClamp = useMemo(() => {
    return (form?.pages || []).filter(p => !hiddenPageIds.has(p.id));
  }, [form?.pages, hiddenPageIds]);

  useEffect(() => {
    if (visiblePagesForClamp.length > 0 && currentPageIndex >= visiblePagesForClamp.length) {
      setCurrentPageIndex(Math.max(0, visiblePagesForClamp.length - 1));
    }
  }, [visiblePagesForClamp, currentPageIndex]);

  // Build a dependency map: trigger field ID -> Set of target field IDs affected by that trigger
  const triggerDependencyMap = useMemo(() => {
    const dependencyMap = new Map(); // triggerId -> Set of targetIds
    if (!form?.visibility_rules) return dependencyMap;
    
    // Helper to get all trigger field IDs from a rule
    const getTriggerIds = (rule) => {
      const triggerIds = [];
      if (rule.conditions && Array.isArray(rule.conditions)) {
        for (const condition of rule.conditions) {
          if (condition.field_id) triggerIds.push(condition.field_id);
        }
      }
      if (rule.trigger_field_id) {
        triggerIds.push(rule.trigger_field_id);
      }
      return triggerIds;
    };
    
    // Helper to get all target field IDs from a rule
    const getTargetIds = (rule) => {
      const targetIds = [];
      // New format: actions array
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'visibility' && action.field_states) {
            targetIds.push(...Object.keys(action.field_states));
          }
          if (action.target_field_ids) {
            targetIds.push(...action.target_field_ids);
          }
        }
      }
      // Legacy format: direct target_field_ids
      if (rule.target_field_ids) {
        targetIds.push(...rule.target_field_ids);
      }
      return targetIds;
    };
    
    for (const rule of form.visibility_rules) {
      const triggerIds = getTriggerIds(rule);
      const targetIds = getTargetIds(rule);
      
      for (const triggerId of triggerIds) {
        if (!dependencyMap.has(triggerId)) {
          dependencyMap.set(triggerId, new Set());
        }
        for (const targetId of targetIds) {
          dependencyMap.get(triggerId).add(targetId);
        }
      }
    }
    
    return dependencyMap;
  }, [form?.visibility_rules]);

  // Get all fields affected by a trigger, including cascading dependencies
  const getAffectedFields = (triggerId, visited = new Set()) => {
    const affected = new Set();
    if (visited.has(triggerId)) return affected; // Prevent infinite loops
    visited.add(triggerId);
    
    const directTargets = triggerDependencyMap.get(triggerId);
    if (!directTargets) return affected;
    
    for (const targetId of directTargets) {
      affected.add(targetId);
      // If the target is also a trigger, cascade to its dependents
      if (triggerDependencyMap.has(targetId)) {
        const cascadeTargets = getAffectedFields(targetId, visited);
        for (const cascadeTarget of cascadeTargets) {
          affected.add(cascadeTarget);
        }
      }
    }
    
    return affected;
  };

  // Handler for field value changes that clears dependent fields when a trigger field changes
  // This ensures conditional logic paths are properly reset when navigating backwards
  const NON_INPUT_FIELD_TYPES = new Set(['instructions', 'image', 'section_header', 'heading', 'paragraph', 'divider', 'spacer', 'html']);

  const autoSubmitTimerRef = useRef(null);
  const lastPaymentFieldRef = useRef(null);
  const handleSubmitRef = useRef(null);

  // Task #944: Submitter "email me a copy" feature.
  // When form.allow_submitter_email_copy is true, the form renders an extra
  // block at the bottom with an email input + checkbox. If the checkbox is
  // ticked and the email is valid on submit, the server will email the
  // submitter a DOCX copy of their submission.
  const [submitterCopyEmail, setSubmitterCopyEmail] = useState("");
  const [submitterCopyRequested, setSubmitterCopyRequested] = useState(false);
  const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
  const submitterCopyEmailInvalid = submitterCopyRequested && submitterCopyEmail.trim() !== '' && !isValidEmail(submitterCopyEmail);

  useEffect(() => {
    return () => {
      if (autoSubmitTimerRef.current) clearTimeout(autoSubmitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!form || submitted || submitFormMutation.isPending) return;

    const allVisible = filterVisibleFields(form.fields);
    const paymentFields = allVisible.filter(f => f.type === 'membership_payment');
    if (paymentFields.length === 0) return;

    let sortedVisible = allVisible;
    const formPages = form.pages || [];
    if (formPages.length > 0 && form.layout_type === 'standard') {
      const pageOrder = {};
      formPages.forEach((p, i) => { pageOrder[p.id] = i; });
      sortedVisible = [...allVisible].sort((a, b) => {
        const aPage = a.page_id ? (pageOrder[a.page_id] ?? -1) : -1;
        const bPage = b.page_id ? (pageOrder[b.page_id] ?? -1) : -1;
        return aPage - bPage;
      });
    }

    const lastMeaningful = [...sortedVisible].reverse().find(f => !NON_INPUT_FIELD_TYPES.has(f.type));
    if (!lastMeaningful || lastMeaningful.type !== 'membership_payment') return;

    const val = formValues[lastMeaningful.id];
    if (!val || typeof val !== 'object') return;
    if (val.status !== 'paid' && val.status !== 'already_paid') return;

    const key = `${lastMeaningful.id}:${val.status}:${val.paymentIntentId || ''}`;
    if (lastPaymentFieldRef.current === key) return;
    lastPaymentFieldRef.current = key;

    if (autoSubmitTimerRef.current) clearTimeout(autoSubmitTimerRef.current);
    autoSubmitTimerRef.current = setTimeout(() => {
      if (handleSubmitRef.current) handleSubmitRef.current();
    }, 800);
  }, [formValues, form, submitted, submitFormMutation.isPending]);

  const handleFieldChange = (fieldId, newValue) => {
    // Check if this field is a trigger for any visibility rules
    const isTriggerField = triggerDependencyMap.has(fieldId);
    
    if (!isTriggerField) {
      // Not a trigger field - just update the value
      setFormValues(prev => pruneFormNotListedText(form?.fields, {
        ...prev,
        [fieldId]: newValue,
      }));
      return;
    }
    
    // For trigger fields, always clear dependent fields when value changes
    // This is safer than trying to detect exact value changes (handles File objects, complex types, etc.)
    // Get all fields affected by this trigger (including cascading dependencies)
    const affectedFieldIds = getAffectedFields(fieldId);
    const clearedValues = {};
    
    for (const affectedId of affectedFieldIds) {
      // Only clear if the field currently has a value
      if (formValues[affectedId] !== undefined) {
        clearedValues[affectedId] = undefined;
      }
    }
    
    // Set the new value and clear dependent fields in one update
    setFormValues(prev => pruneFormNotListedText(form?.fields, {
      ...prev,
      ...clearedValues,
      [fieldId]: newValue,
    }));
    
    if (Object.keys(clearedValues).length > 0) {
      console.log('[FormView] Trigger field changed, cleared dependent fields:', 
        Object.keys(clearedValues));
    }
  };

  const handleFormNotListedTextChange = (fieldId, text) => {
    setFormValues(prev => setFormNotListedText(prev, fieldId, text));
  };

  const handleImageButtonAutoAdvance = (field) => {
    if (field.type !== 'image_buttons' || field.auto_advance === false) return;
    setTimeout(() => {
      if (form.layout_type === 'card_swipe') {
        const visibleCardFields = filterVisibleFields(form.fields);
        const currentIdx = visibleCardFields.findIndex(f => f.id === field.id);
        if (currentIdx >= 0 && currentIdx < visibleCardFields.length - 1) {
          setCurrentStep(currentIdx + 1);
        }
      } else {
        const vPages = visiblePagesForClamp;
        if (vPages.length > 1 && currentPageIndex < vPages.length - 1) {
          goToNextPage();
        }
      }
    }, 350);
  };

  // Helper to filter visible fields
  // hiddenFieldIds already includes fields with "show" rules as hidden by default
  // Also excludes due_diligence fields which should not be shown to end users
  const filterVisibleFields = (fields) => {
    return fields.filter(field => !hiddenFieldIds.has(field.id) && !field.due_diligence);
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
  // Conditional-logic submit control (Task #3474): rules can disable/enable
  // the Submit button. Shared evaluator with the server-side enforcement in
  // process-application.js — keep using the shared module, never fork it.
  const submitControl = useMemo(
    () => resolveSubmitControl(form?.visibility_rules, conditionFormValues, { lmicCodes: form?.lmic_country_codes }),
    [form?.visibility_rules, conditionFormValues, form?.lmic_country_codes]
  );

  // Task #3483: generic Payment field. When a payment field is VISIBLE (not
  // hidden by visibility rules), the payment step replaces the plain Submit
  // button. Hidden payment field ⇒ normal submit path.
  const visiblePaymentField = useMemo(() => {
    const pf = (form?.fields || []).find((f) => f?.type === 'payment');
    if (!pf || hiddenFieldIds.has(pf.id)) return null;
    return pf;
  }, [form?.fields, hiddenFieldIds]);

  // Task #3498: server-derived membership fee when a conditional membership
  // rule matches — the payment card/button must show and charge THAT amount,
  // not the (usually absent) price-source answer.
  const membershipFeeQuote = useMembershipFeeQuote({
    form,
    formValues,
    prefillOrganizationId: resolvedOrgIdForSubmission,
    enabled: !!visiblePaymentField,
  });

  const disabledFieldIds = useMemo(() => {
    // Start with fields that have starts_disabled = true
    const disabled = new Set(initialDisabledFieldIds);
    
    if (!form?.visibility_rules || form.visibility_rules.length === 0) {
      return disabled;
    }
    
    // Track which fields should be enabled/disabled based on rule evaluation
    const fieldDisability = {};
    
    for (const rule of form.visibility_rules) {
      // Skip rules without conditions (new format) or trigger_field_id (legacy format)
      if (!rule.conditions?.length && !rule.trigger_field_id) continue;
      
      // Evaluate conditions using AND/OR logic for new format, or single condition for legacy
      const conditionMet = evaluateRuleConditions(rule, formValues);

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
  }, [form?.visibility_rules, formValues, emptyRelationshipParentValues, initialDisabledFieldIds]);

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
  const formContainerRef = useRef(null);
  
  // Reset set_value and role tracking when form changes
  useEffect(() => {
    originalValuesRef.current = {};
    activeSetValueActionsRef.current = new Set();
    triggeredRoleIdRef.current = null;
    roleActionTriggeredRef.current = false;
    previousRoleActionsRef.current = new Set();
  }, [form?.id]);
  
  // Helper to compute the value for a set_value action
  // Coerce a computed set_value to the correct type for the target field.
  // For boolean fields, tolerates "True", "TRUE", "yes", "1", etc.
  const coerceValueForField = (value, fieldId) => {
    if (value === null || value === undefined) return value;
    const field = form?.fields?.find(f => f.id === fieldId);
    if (field?.type === 'boolean') {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y', 'on', '1'].includes(s)) return true;
      if (['false', 'no', 'n', 'off', '0'].includes(s)) return false;
      return value;
    }
    return value;
  };

  const computeSetValue = (action, prefillEntity) => {
    const sourceType = action.set_value_source || 'static';
    
    if (sourceType === 'static') {
      return action.set_value;
    } else if (sourceType === 'field') {
      return formValues[action.set_value_field_id];
    } else if (sourceType === 'formula') {
      // Calculate formula: Operand A {operator} Operand B
      // Each operand can be either a field reference or a fixed value
      
      // Resolve Operand A
      const operandAMode = action.formula_operand_a_mode || 'field';
      let operandAValue;
      if (operandAMode === 'value') {
        operandAValue = parseFloat(action.formula_operand_a_value || 0);
      } else {
        // Field mode - support both new and legacy field references
        const fieldId = action.formula_operand_a_field_id || action.formula_field_a;
        operandAValue = parseFloat(formValues[fieldId] || 0);
      }
      
      // Resolve Operand B
      const operandBMode = action.formula_operand_b_mode || 'field';
      let operandBValue;
      if (operandBMode === 'value') {
        operandBValue = parseFloat(action.formula_operand_b_value || 0);
      } else {
        // Field mode - support both new and legacy field references
        const fieldId = action.formula_operand_b_field_id || action.formula_field_b;
        operandBValue = parseFloat(formValues[fieldId] || 0);
      }
      
      const operator = action.formula_operator || 'add';
      
      let result;
      switch (operator) {
        case 'add':
          result = operandAValue + operandBValue;
          break;
        case 'subtract':
          result = operandAValue - operandBValue;
          break;
        case 'multiply':
          result = operandAValue * operandBValue;
          break;
        case 'divide':
          // Skip update if dividing by zero
          if (operandBValue === 0) return null;
          result = operandAValue / operandBValue;
          break;
        default:
          result = 0;
      }
      
      // Handle floating point precision - round to 10 decimal places then clean up
      const rounded = Math.round(result * 1e10) / 1e10;
      // Convert to string, removing unnecessary trailing zeros
      return rounded.toString();
    } else if (sourceType === 'prefill' && prefillEntity) {
      const prefillField = action.set_value_prefill_field || '';
      if (prefillField.startsWith('core.')) {
        const coreFieldName = prefillField.replace('core.', '');
        if (form?.prefill_source === 'booking') {
          const val = prefillBooking?.[coreFieldName];
          if (val !== undefined && val !== null) return val;
          const memberVal = prefillBookingMember?.[coreFieldName];
          if (memberVal !== undefined && memberVal !== null) return memberVal;
          return prefillBookingOrg?.[coreFieldName];
        }
        return prefillEntity[coreFieldName];
      } else if (prefillField.startsWith('custom.')) {
        const customFieldId = prefillField.replace('custom.', '');
        const customValues = form?.prefill_source === 'booking' 
          ? [...prefillBookingMemberCustomValues, ...prefillBookingOrgCustomValues]
          : form?.prefill_source === 'member' ? prefillMemberCustomValues : prefillOrgCustomValues;
        const cfv = customValues.find(v => v.field_id === customFieldId);
        return cfv?.value;
      }
    }
    return null;
  };
  
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
        if (form?.prefill_source === 'booking') {
          const val = prefillBooking?.[coreFieldName];
          if (val !== undefined && val !== null) return val;
          const memberVal = prefillBookingMember?.[coreFieldName];
          if (memberVal !== undefined && memberVal !== null) return memberVal;
          return prefillBookingOrg?.[coreFieldName];
        }
        return prefillEntity[coreFieldName];
      } else if (prefillField.startsWith('custom.')) {
        const customFieldId = prefillField.replace('custom.', '');
        const customValues = form?.prefill_source === 'booking'
          ? [...prefillBookingMemberCustomValues, ...prefillBookingOrgCustomValues]
          : form?.prefill_source === 'member' ? prefillMemberCustomValues : prefillOrgCustomValues;
        const cfv = customValues.find(v => v.field_id === customFieldId);
        return cfv?.value;
      }
    }
    return null;
  };
  
  useEffect(() => {
    if (!form?.visibility_rules || form.visibility_rules.length === 0) return;
    
    console.log('[SetValue Debug] === Processing set_value rules ===');
    console.log('[SetValue Debug] Current formValues:', formValues);
    console.log('[SetValue Debug] Previously active actions:', Array.from(activeSetValueActionsRef.current));
    
    const prefillEntity = form.prefill_source === 'member' ? prefillMember 
      : form.prefill_source === 'booking' ? prefillBooking
      : prefillOrg;
    const updates = {};
    
    // Track which actions are now active and which fields they target
    const nowActiveActions = new Set();
    const activeFieldTargets = new Map(); // fieldId -> Set of actionKeys targeting it
    
    // First pass: identify all active actions and build field->action mapping
    for (const rule of form.visibility_rules) {
      // Skip rules without conditions (new format) or trigger_field_id (legacy format)
      if (!rule.conditions?.length && !rule.trigger_field_id) {
        console.log(`[SetValue Debug] Rule ${rule.id}: Skipped (no conditions or trigger_field_id)`);
        continue;
      }
      
      // Evaluate conditions using AND/OR logic for new format, or single condition for legacy
      const conditionMet = evaluateRuleConditions(rule, formValues);
      
      // Handle new multi-action format
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'set_value' && action.target_field_id) {
            const actionKey = action.id;
            console.log(`[SetValue Debug] Action ${actionKey}: type=set_value, target=${action.target_field_id}, conditionMet=${conditionMet}, set_value="${action.set_value}"`);
            
            if (conditionMet) {
              nowActiveActions.add(actionKey);
              
              // Track which actions target this field
              if (!activeFieldTargets.has(action.target_field_id)) {
                activeFieldTargets.set(action.target_field_id, new Set());
              }
              activeFieldTargets.get(action.target_field_id).add(actionKey);
              
              // If this action wasn't active before, save original value and apply
              if (!activeSetValueActionsRef.current.has(actionKey)) {
                console.log(`[SetValue Debug] Action ${actionKey}: NEW activation - will apply value`);
                // Save original value if we haven't already
                if (!(action.target_field_id in originalValuesRef.current)) {
                  originalValuesRef.current[action.target_field_id] = formValues[action.target_field_id] ?? '';
                  console.log(`[SetValue Debug] Action ${actionKey}: Saved original value "${originalValuesRef.current[action.target_field_id]}"`);
                }
                
                const valueToSet = coerceValueForField(computeSetValue(action, prefillEntity), action.target_field_id);
                console.log(`[SetValue Debug] Action ${actionKey}: computeSetValue returned "${valueToSet}" (type: ${typeof valueToSet})`);
                if (valueToSet !== null && valueToSet !== undefined) {
                  updates[action.target_field_id] = valueToSet;
                  console.log(`[SetValue Debug] Action ${actionKey}: Added to updates: ${action.target_field_id} = "${valueToSet}"`);
                } else {
                  console.log(`[SetValue Debug] Action ${actionKey}: Value is null/undefined, NOT adding to updates`);
                }
              } else {
                console.log(`[SetValue Debug] Action ${actionKey}: Already active, checking source type...`);
              }
              // For field-source actions that are already active, continuously sync with source field
              if ((action.set_value_source || 'static') === 'field' && action.set_value_field_id && activeSetValueActionsRef.current.has(actionKey)) {
                const sourceValue = coerceValueForField(formValues[action.set_value_field_id], action.target_field_id);
                const currentTargetValue = formValues[action.target_field_id];
                console.log(`[SetValue Debug] Action ${actionKey}: Field source sync - source="${sourceValue}", current="${currentTargetValue}"`);
                // Only update if source changed and target doesn't match
                if (sourceValue !== currentTargetValue && sourceValue !== null && sourceValue !== undefined) {
                  updates[action.target_field_id] = sourceValue;
                  console.log(`[SetValue Debug] Action ${actionKey}: Syncing field value to "${sourceValue}"`);
                }
              }
              // For formula-source actions that are already active, continuously recalculate
              else if ((action.set_value_source || 'static') === 'formula') {
                // Check if formula has at least one operand configured (field or value)
                const hasOperandA = (action.formula_operand_a_mode === 'value' && action.formula_operand_a_value !== '') ||
                                    (action.formula_operand_a_mode !== 'value' && (action.formula_operand_a_field_id || action.formula_field_a));
                const hasOperandB = (action.formula_operand_b_mode === 'value' && action.formula_operand_b_value !== '') ||
                                    (action.formula_operand_b_mode !== 'value' && (action.formula_operand_b_field_id || action.formula_field_b));
                
                if (hasOperandA || hasOperandB) {
                  const newValue = coerceValueForField(computeSetValue(action, prefillEntity), action.target_field_id);
                  const currentTargetValue = formValues[action.target_field_id];
                  // Only update if calculated value differs from current
                  if (newValue !== currentTargetValue && newValue !== null && newValue !== undefined) {
                    updates[action.target_field_id] = newValue;
                  }
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
            
            const valueToSet = coerceValueForField(computeLegacySetValue(rule, prefillEntity), rule.target_field_id);
            if (valueToSet !== null && valueToSet !== undefined) {
              updates[rule.target_field_id] = valueToSet;
            }
          }
          // For field-source rules that are already active, continuously sync with source field
          else if ((rule.set_value_source || 'static') === 'field' && rule.set_value_field_id) {
            const sourceValue = coerceValueForField(formValues[rule.set_value_field_id], rule.target_field_id);
            const currentTargetValue = formValues[rule.target_field_id];
            // Only update if source changed and target doesn't match
            if (sourceValue !== currentTargetValue && sourceValue !== null && sourceValue !== undefined) {
              updates[rule.target_field_id] = sourceValue;
            }
          }
        }
      }
    }
    
    // Find actions that were active but are now inactive - need to revert
    // But only revert if NO other active action targets the same field
    console.log('[SetValue Debug] Checking for actions to revert...');
    for (const actionKey of activeSetValueActionsRef.current) {
      if (!nowActiveActions.has(actionKey)) {
        console.log(`[SetValue Debug] Action ${actionKey}: Was active, now inactive - checking if should revert`);
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
                    console.log(`[SetValue Debug] Action ${actionKey}: REVERTING ${targetFieldId} to original "${originalValuesRef.current[targetFieldId]}"`);
                    updates[targetFieldId] = originalValuesRef.current[targetFieldId];
                    delete originalValuesRef.current[targetFieldId];
                  }
                } else {
                  console.log(`[SetValue Debug] Action ${actionKey}: NOT reverting, other active actions target this field:`, Array.from(activeActionsForField));
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
    console.log('[SetValue Debug] Now active actions:', Array.from(nowActiveActions));
    activeSetValueActionsRef.current = nowActiveActions;
    
    // Apply all updates at once to avoid multiple re-renders
    if (Object.keys(updates).length > 0) {
      console.log('[SetValue Debug] === APPLYING UPDATES ===', updates);
      setFormValues(prev => ({ ...prev, ...updates }));
    } else {
      console.log('[SetValue Debug] No updates to apply');
    }
    
    // Process set_role and clear_role actions with transition detection
    // Only update role when an action transitions from inactive to active
    const nowActiveRoleActions = new Set();
    
    for (const rule of form.visibility_rules) {
      // Skip rules without conditions (new format) or trigger_field_id (legacy format)
      if (!rule.conditions?.length && !rule.trigger_field_id) continue;
      
      // Evaluate conditions using AND/OR logic for new format, or single condition for legacy
      const conditionMet = evaluateRuleConditions(rule, formValues);
      
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
  }, [form?.visibility_rules, formValues, emptyRelationshipParentValues, prefillMember, prefillOrg, prefillMemberCustomValues, prefillOrgCustomValues, form?.prefill_source]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (formAccess.restricted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        <FormAccessRestriction
          form={accessPayload}
          isAuthenticated={!!memberInfo}
          standalone
          className="min-h-screen"
        />
      </div>
    );
  }

  // Task #3331: assignment link opened outside its window, or requiring
  // authentication — the server returned event context but no form config.
  if (assignmentMeta && (rawForm?.__assignmentBlocked || assignmentMeta.closed_message || assignmentMeta.require_authentication)) {
    const eventTitle = assignmentMeta.event?.title;
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center space-y-2">
            {eventTitle && <p className="font-medium text-slate-800">{eventTitle}</p>}
            {assignmentMeta.require_authentication && !memberInfo ? (
              <>
                <Loader2 className="w-6 h-6 animate-spin text-blue-600 mx-auto" />
                <p className="text-slate-600">Redirecting to login…</p>
              </>
            ) : (
              <p className="text-slate-600">
                {assignmentMeta.require_authentication
                  ? 'Please log in to access this survey.'
                  : (assignmentMeta.closed_message || 'This survey is not available.')}
              </p>
            )}
          </CardContent>
        </Card>
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
    // Task #3364: the redirect effect above sends the visitor to
    // /login?returnTo=<this form URL>. Render a transient redirect state
    // (never the old static dead end) while auth resolves / navigation runs.
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center space-y-2">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600 mx-auto" />
            <p className="text-slate-600">Redirecting to login…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Task #3400: booking-prefill form with no explicit booking_id — hold
  // rendering while auth / viewer-booking resolution is still settling so
  // neither the form nor the no-booking message flashes.
  if (isViewerBookingResolutionPending({
    prefillSource: form.prefill_source,
    urlBookingId: prefillBookingId,
    authResolved,
    viewerMemberId: memberInfo?.id,
    formSlug,
    viewerBookingLoading,
  })) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Task #3400: authenticated member on an event-linked booking-prefill form,
  // but no booking of theirs could be resolved for the event — block the form
  // with a helpful message instead of rendering blank fields. Explicit
  // booking_id URLs, anonymous viewers, non-event-linked forms and transient
  // errors never reach this state.
  if (shouldBlockForMissingViewerBooking({
    prefillSource: form.prefill_source,
    urlBookingId: prefillBookingId,
    authResolved,
    viewerMemberId: memberInfo?.id,
    formSlug,
    viewerBookingData,
    viewerBookingError,
  })) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex justify-center pt-8 md:pt-16">
        <Card className="max-w-md h-fit">
          <CardHeader className="text-center">
            <CardTitle className="text-xl text-slate-800">No Booking Found</CardTitle>
          </CardHeader>
          <CardContent className="p-6 pt-0 text-center">
            <p className="text-slate-600">
              We couldn't find a booking for you for this event. If you think this is a mistake, please contact support.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Check if still loading capacity
  // Only show loading if we actually expect to do a pre-load capacity check (i.e., we have effectiveOrgIdForCapacity)
  if (primaryMemberRoleId && effectiveOrgIdForCapacity && isCheckingCapacity) {
    console.log('[FormView] BLOCKING: Still loading capacity check', { isCheckingCapacity, effectiveOrgIdForCapacity });
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Role capacity is ALWAYS per-organization
  // Determine if we can check capacity now (prefilled org via URL or member org) or must defer to submit time (org collected via form)
  const canCheckCapacityNow = !!effectiveOrgIdForCapacity;
  const willCollectOrgViaForm = orgCapacityConfig?.hasOrgPipeline && !effectiveOrgIdForCapacity;
  
  // Block if we have prefilled org AND capacity is exceeded
  const shouldBlockForCapacity = primaryMemberRoleId && canCheckCapacityNow && roleCapacity && !roleCapacity.hasCapacity;
  
  console.log('[FormView] Capacity block decision:', {
    primaryMemberRoleId,
    roleCapacity,
    hasCapacity: roleCapacity?.hasCapacity,
    prefillOrgId,
    prefillOrgName,
    canCheckCapacityNow,
    willCollectOrgViaForm,
    shouldBlockForCapacity,
    note: willCollectOrgViaForm ? 'Will check capacity at submit time' : canCheckCapacityNow ? 'Checking capacity now' : 'No capacity check needed'
  });
  
  if (shouldBlockForCapacity) {
    console.log('[FormView] BLOCKING: Role is at capacity for this organization');
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex justify-center pt-8 md:pt-16">
        <Card className="max-w-md h-fit">
          <CardHeader className="text-center">
            <CardTitle className="text-xl text-slate-800">Registration Closed</CardTitle>
          </CardHeader>
          <CardContent className="p-6 text-center">
            <p className="text-slate-600">
              {roleCapacity.roleName && prefillOrgName
                ? `${prefillOrgName} already has ${roleCapacity.currentCount} ${roleCapacity.roleName}(s). Maximum allowed is ${roleCapacity.maxMembers}.`
                : roleCapacity.roleName 
                  ? `The ${roleCapacity.roleName} role has reached its maximum capacity of ${roleCapacity.maxMembers} members for this organization.`
                  : `This registration has reached its maximum capacity for this organization.`
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

  // Task #3483: all pre-submit validation + payload assembly, shared by the
  // normal submit path and the payment step. Returns the submission payload
  // or null (after toasting) when validation fails.
  const buildSubmissionPayload = async () => {
    // Conditional-logic submit control: guard here too so the payment
    // auto-submit path (handleSubmitRef) cannot bypass a matched disable rule.
    if (submitControl.disabled) {
      if (submitControl.message) toast.error(submitControl.message);
      return null;
    }
    // For paginated forms, validate all pages before submission
    const pages = form.pages || [];
    const hasPages = pages.length > 0 && form.layout_type === 'standard';
    
    // Debug: Log hidden fields at validation time
    console.log('[FormView Validation] hiddenFieldIds at submit:', Array.from(hiddenFieldIds));
    console.log('[FormView Validation] All fields:', form.fields?.map(f => ({id: f.id, label: f.label, required: f.required})));
    
    // Get visible fields only (skip hidden fields from validation)
    const visibleFields = filterVisibleFields(form.fields);
    console.log('[FormView Validation] Visible fields after filtering:', visibleFields.map(f => ({id: f.id, label: f.label, required: f.required})));
    
    if (hasPages) {
      // Check each page's required fields (only visible ones)
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const pageFields = visibleFields.filter(f => f.page_id === page.id);
        const missingFields = pageFields.filter(field => 
          field.required && !isFieldValueFilled(field, formValues[field.id])
        );
        
        if (missingFields.length > 0) {
          toast.error(`Please fill in required fields on "${page.title}": ${missingFields.map(f => f.label).join(', ')}`);
          return null;
        }
      }
      
      // Also check unassigned fields (page_id is null) - only visible ones
      const unassignedFields = visibleFields.filter(f => !f.page_id);
      const missingUnassigned = unassignedFields.filter(field => 
        field.required && !isFieldValueFilled(field, formValues[field.id])
      );
      
      if (missingUnassigned.length > 0) {
        toast.error(`Please fill in required fields: ${missingUnassigned.map(f => f.label).join(', ')}`);
        return null;
      }
    } else {
      // Standard validation for non-paginated forms (only visible fields)
      const missingFields = visibleFields.filter(field => 
        field.required && !isFieldValueFilled(field, formValues[field.id])
      );

      if (missingFields.length > 0) {
        console.log('[FormView Validation] Missing required fields (after filtering hidden):', missingFields.map(f => ({id: f.id, label: f.label, starts_hidden: f.starts_hidden})));
        toast.error(`Please fill in all required fields: ${missingFields.map(f => f.label).join(', ')}`);
        return null;
      }
    }

    const invalidFields = visibleFields.filter(field => fieldValidity[field.id] === false);
    if (invalidFields.length > 0) {
      toast.error(`Please fix validation errors: ${invalidFields.map(f => f.label).join(', ')}`);
      return null;
    }

    const overLimitFields = visibleFields.filter(field => {
      if (field.type !== 'textarea' || !field.max_characters) return false;
      const text = formValues[field.id] || '';
      if (field.limit_type === 'words') {
        const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
        return wordCount > field.max_characters;
      }
      return text.length > field.max_characters;
    });
    if (overLimitFields.length > 0) {
      toast.error(`${overLimitFields[0]?.limit_type === 'words' ? 'Word' : 'Character'} limit exceeded: ${overLimitFields.map(f => f.label).join(', ')}`);
      return null;
    }

    const paymentFields = visibleFields.filter(field => field.type === 'membership_payment');
    const unpaidPayments = paymentFields.filter(field => {
      const val = formValues[field.id];
      return !val || (typeof val === 'object' && val.status !== 'paid' && val.status !== 'already_paid');
    });
    if (unpaidPayments.length > 0) {
      toast.error('Please complete the membership payment before submitting');
      return null;
    }

    // Validate terms_conditions fields - must be toggled to true before submission
    // Accept both boolean true and string "true" for compatibility
    const termsFields = visibleFields.filter(field => field.type === 'terms_conditions');
    const unacceptedTerms = termsFields.filter(field => {
      const val = formValues[field.id];
      return val !== true && val !== 'true';
    });
    if (unacceptedTerms.length > 0) {
      toast.error(`Please accept the terms and conditions: ${unacceptedTerms.map(f => f.label).join(', ')}`);
      return null;
    }

    // Per-organization capacity check (runs if form assigns a role and no prefill check was done)
    // Skip if we already checked capacity on load with effectiveOrgIdForCapacity
    if (primaryMemberRoleId && !effectiveOrgIdForCapacity) {
      // Try to find org context from multiple sources:
      // 1. Org pipeline's source field (text field mapped to org name/id)
      // 2. Organisation dropdown field (contains org UUID directly)
      
      let orgIdForCheck = null;
      let isOrgDropdown = false;
      
      // Check org pipeline config first
      if (orgCapacityConfig?.sourceFieldId) {
        const sourceField = form?.fields?.find(f => f.id === orgCapacityConfig.sourceFieldId);
        isOrgDropdown = sourceField?.type === 'organisation_dropdown';
        orgIdForCheck = formValues[orgCapacityConfig.sourceFieldId];
      }
      
      // Also check for standalone org dropdown if no org pipeline
      if (!orgIdForCheck && orgDropdownField) {
        isOrgDropdown = true;
        orgIdForCheck = formValues[orgDropdownField.id];
      }
      
      console.log('[FormView] Per-org capacity check at submit:', {
        roleId: primaryMemberRoleId,
        orgIdForCheck,
        isOrgDropdown,
        orgCapacityConfig,
        orgDropdownFieldId: orgDropdownField?.id
      });
      
      if (orgIdForCheck) {
        try {
          let capacityUrl;
          if (isOrgDropdown) {
            // Organisation dropdown returns org UUID directly - use orgId param
            capacityUrl = `/api/public/role/${primaryMemberRoleId}/capacity?orgId=${encodeURIComponent(orgIdForCheck)}`;
            console.log('[FormView] Using orgId for dropdown:', orgIdForCheck);
          } else {
            // Text field returns uniqueness key value - use orgKey/orgValue params
            capacityUrl = `/api/public/role/${primaryMemberRoleId}/capacity?orgKey=${encodeURIComponent(orgCapacityConfig?.uniquenessKey || 'name')}&orgValue=${encodeURIComponent(orgIdForCheck)}`;
            console.log('[FormView] Using orgKey/orgValue:', { key: orgCapacityConfig?.uniquenessKey, value: orgIdForCheck });
          }
          console.log('[FormView] Fetching per-org capacity:', capacityUrl);
          
          const capacityResponse = await fetch(capacityUrl);
          if (capacityResponse.ok) {
            const capacityData = await capacityResponse.json();
            console.log('[FormView] Per-org capacity response:', capacityData);
            
            if (!capacityData.hasCapacity) {
              toast.error(`This organization already has ${capacityData.currentCount} ${capacityData.roleName}(s). Maximum allowed is ${capacityData.maxMembers}.`);
              return null;
            }
          }
        } catch (error) {
          console.error('[FormView] Per-org capacity check error:', error);
          // Continue on error (fail open)
        }
      }
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
          return null;
        }
      } catch (error) {
        console.error('[FormView] Uniqueness validation error:', error);
        toast.error('Unable to validate form. Please try again.');
        return null;
      }
    }

    // Debug: Log all form values at submission time to help diagnose hidden field issues
    console.log('[FormView] Form submission - all formValues:', JSON.stringify(formValues, null, 2));
    console.log('[FormView] Form submission - hiddenFieldIds:', Array.from(hiddenFieldIds));
    
    // Check Primary Member entity_pipelines field IDs
    const primaryMember = form?.entity_pipelines?.members?.find(m => m.is_primary);
    if (primaryMember?.mappings) {
      console.log('[FormView] Primary Member mappings check:');
      for (const mapping of primaryMember.mappings) {
        if (mapping.source_type === 'field') {
          const value = formValues[mapping.source_field_id];
          console.log(`  - ${mapping.target_field}: source=${mapping.source_field_id}, value=${JSON.stringify(value)}, isHidden=${hiddenFieldIds.has(mapping.source_field_id)}`);
        }
      }
    }

    const displayOnlyFieldIds = new Set(
      (form.fields || []).filter(f => f.type === 'instructions' || f.type === 'image').map(f => f.id)
    );
    const filteredFormValues = pruneFormNotListedText(form.fields, Object.fromEntries(
      Object.entries(formValues).filter(([key]) => !displayOnlyFieldIds.has(key))
    ));

    // Determine organization ID to include with submission.
    // Task #3498: shared memo — MUST stay identical to what the membership
    // fee quote hook uses, or the displayed fee and the charged fee diverge.
    const resolvedOrganizationId = resolvedOrgIdForSubmission;

    const effectiveRoleId = roleActionTriggeredRef.current 
      ? triggeredRoleIdRef.current 
      : (primaryMemberRoleId || form.default_member_role_id || null);

    // Task #944: Block submit if the submitter ticked "email me a copy" but
    // entered an invalid email. Empty + unticked is fine and submits as normal.
    if (form?.allow_submitter_email_copy && submitterCopyRequested) {
      if (!submitterCopyEmail.trim() || !isValidEmail(submitterCopyEmail)) {
        toast.error('Please enter a valid email address to receive a copy of your submission');
        return null;
      }
    }

    const wantsSubmitterCopy =
      !!form?.allow_submitter_email_copy &&
      submitterCopyRequested &&
      isValidEmail(submitterCopyEmail);

    const submissionData = {
      form_id: form.id,
      form_name: form.name,
      submitted_by_email: memberInfo?.email || null,
      submitted_by_name: memberInfo ? `${memberInfo.first_name} ${memberInfo.last_name}` : null,
      submission_data: {
        ...filteredFormValues,
        ...(signerEmail && { signer_email: signerEmail })
      },
      created_date: new Date().toISOString(),
      ...(contractInstanceId && { contract_instance_id: contractInstanceId }),
      ...(resolvedOrganizationId && { prefill_organization_id: resolvedOrganizationId }),
      ...(effectiveRoleId && { role_id: effectiveRoleId }),
      ...(briefId && { brief_id: briefId }),
      ...(vacancyId && { vacancy_id: vacancyId }),
      ...(wantsSubmitterCopy && {
        submitterCopyRequested: true,
        submitterCopyEmail: submitterCopyEmail.trim(),
      })
    };

    return submissionData;
  };

  const handleSubmit = async () => {
    const payload = await buildSubmissionPayload();
    if (payload) submitFormMutation.mutate(payload);
  };

  handleSubmitRef.current = handleSubmit;

  // Task #3501: a payment redirect return replaces the form with a status
  // screen (paid / DD-pending / cancelled). Rendered before the submitted
  // branch so an already-finalized submission still shows the paid outcome.
  if (paymentReturn.active) {
    return (
      <FormPaymentReturnScreen
        status={paymentReturn.status}
        error={paymentReturn.error}
        successMessage={form ? surveySuccessMessage(form) : null}
        onReturnToForm={paymentReturn.dismiss}
      />
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md border-green-200">
          <CardContent className="p-12 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            </div>
            <h3 className="text-xl font-semibold text-slate-900 mb-2">Success!</h3>
            <p className="text-slate-600">{surveySuccessMessage(form)}</p>
            {resolveRedirectTarget(form, formValues) && (
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
    
    // Check if field has a value (for required check)
    const hasValue = formValues[currentField?.id];
    // Check if field passes format validation (default to true if not tracked)
    const isFormatValid = fieldValidity[currentField?.id] !== false;
    // Can proceed if: (not required OR has value) AND format is valid
    const canProceed = (!currentField?.required || hasValue) && isFormatValid;

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
                key={currentStep}
                field={currentField}
                value={formValues[currentField.id]}
                onChange={(value) => {
                  handleFieldChange(currentField.id, value);
                  handleImageButtonAutoAdvance(currentField);
                }}
                onFormNotListedTextChange={(text) => handleFormNotListedTextChange(currentField.id, text)}
                memberInfo={memberData}
                organizationInfo={effectiveOrganizationInfo}
                selectedOrgGuestAccess={selectedOrgGuestAccess}
                disabled={disabledFieldIds.has(currentField.id)}
                onValidityChange={handleValidityChange}
                onRelationshipEmptyStateChange={handleRelationshipEmptyStateChange}
                autoFocus={cardSwipeAutoFocusFor(currentField.type)}
                formId={form?.id}
                formSlug={form?.slug}
                formMemberRoleId={prefillMember?.role_id || memberData?.role_id || null}
                allFormValues={formValues}
                prefillData={prefillData}
                allFields={form?.fields || []}
                membershipFeeQuote={membershipFeeQuote}
              />
            )}
          </CardContent>
          <div className="p-6 pt-0 flex flex-col gap-2">
            {/* Schema change warning */}
            {schemaChanged && schemaChangeMessage && (
              <div className="flex items-start gap-3 p-3 bg-warning/10 border border-warning/30 rounded-md mb-2">
                <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                <div className="text-sm text-warning">
                  <p className="font-medium">Form has been updated</p>
                  <p className="text-warning">{schemaChangeMessage}</p>
                </div>
              </div>
            )}
            
            {/* Resume link display */}
            {showResumeLink && resumeToken && (
              <div className="mb-2 p-4 bg-green-50 border border-green-200 rounded-md">
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
            
            {!canProceed && (
              <p className="text-sm text-warning text-center">
                {!isFormatValid 
                  ? 'Please fix the format error above to continue'
                  : 'Please complete the required field above to continue'}
              </p>
            )}
            {submissionError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md" data-testid="submission-error">
                <p className="text-sm text-red-700">{submissionError}</p>
              </div>
            )}
            {/* Task #944: Submitter "email me a copy" block (card_swipe layout) */}
            {form?.allow_submitter_email_copy && isLastStep && (
              <div className="p-3 border border-slate-200 rounded-md bg-slate-50 space-y-2" data-testid="block-submitter-copy">
                <label htmlFor="submitter-copy-email" className="block text-sm font-medium text-slate-700">Get a copy of your submission</label>
                <input
                  id="submitter-copy-email"
                  type="email"
                  value={submitterCopyEmail}
                  onChange={(e) => setSubmitterCopyEmail(e.target.value)}
                  placeholder="your.email@example.com"
                  className="w-full text-sm border border-slate-300 rounded px-2 py-1.5"
                  data-testid="input-submitter-copy-email"
                />
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={submitterCopyRequested}
                    onChange={(e) => setSubmitterCopyRequested(e.target.checked)}
                    className="mt-0.5"
                    data-testid="checkbox-submitter-copy-requested"
                  />
                  <span>Email me a Word copy of my submission</span>
                </label>
                {submitterCopyEmailInvalid && (
                  <p className="text-xs text-red-600" data-testid="text-submitter-copy-email-error">
                    Please enter a valid email address.
                  </p>
                )}
              </div>
            )}
            <div className="flex justify-between gap-2">
              <Button
                variant="outline"
                onClick={() => setCurrentStep(currentStep - 1)}
                disabled={currentStep === 0}
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                Previous
              </Button>
              
              <div className="flex gap-2">
                {/* Save & Continue Later button - only show when allowed (default on) */}
                {form?.allow_save_continue_later !== false && (
                  <Button
                    variant="outline"
                    onClick={() => saveDraftMutation.mutate()}
                    disabled={saveDraftMutation.isPending}
                  >
                    {saveDraftMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                  </Button>
                )}
                
                {isLastStep ? (
                  visiblePaymentField ? (
                    <FormPaymentSubmit
                      field={visiblePaymentField}
                      formValues={formValues}
                      buildPayload={buildSubmissionPayload}
                      idempotencyKey={getIdempotencyKey()}
                      disabled={!canProceed || submitControl.disabled}
                      disabledMessage={submitControl.message}
                      busy={submitFormMutation.isPending}
                      onPaid={() => { rotateIdempotencyKey(); setSubmitted(true); }}
                      onNormalSubmit={handleSubmit}
                      submitLabel={form.submit_button_text}
                      membershipQuote={membershipFeeQuote}
                    />
                  ) : (
                  <Button
                    onClick={handleSubmit}
                    disabled={!canProceed || submitControl.disabled || submitFormMutation.isPending}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-submit-form"
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
                  )
                ) : (
                  !(currentField?.type === 'image_buttons' && currentField?.auto_advance !== false && currentField?.hide_next_button === true && !disabledFieldIds.has(currentField?.id)) && (
                    <Button
                      onClick={() => setCurrentStep(currentStep + 1)}
                      disabled={!canProceed}
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-2" />
                    </Button>
                  )
                )}
              </div>
            </div>
            {isLastStep && submitControl.disabled && submitControl.message && (
              <p className="text-xs text-warning text-center mt-2" data-testid="text-submit-disabled-message">
                {submitControl.message}
              </p>
            )}
            {isLastStep && defaultConsentMessage && (
              <p className="text-xs text-slate-500 text-center mt-2" data-testid="text-consent-message">
                {defaultConsentMessage}
              </p>
            )}
          </div>
        </Card>
      </div>
    );
  }

  // Standard layout with optional pages.
  // Shared with the embedded Canvas form block (IEditFormElement) via
  // getFormPagination so navigation + per-page validation behave identically.
  const {
    visiblePages,
    hasPages,
    getCurrentPageFields,
    validateCurrentPage,
    scrollToForm,
    goToNextPage,
    goToPreviousPage,
    isFirstPage,
    isLastPage,
    currentPage,
    displayFields,
  } = getFormPagination({
    form,
    formValues,
    hiddenPageIds,
    currentPageIndex,
    setCurrentPageIndex,
    filterVisibleFields,
    formContainerRef,
    toast,
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8" ref={formContainerRef}>
      <div className="max-w-3xl mx-auto">
        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle>{form.name}</CardTitle>
            {form.description && <CardDescription className="whitespace-pre-line">{form.description}</CardDescription>}
            {surveyIntroText(form) && (
              <p className="text-sm text-slate-600 whitespace-pre-line mt-2" data-testid="survey-intro-text">{surveyIntroText(form)}</p>
            )}
            {showSurveyProgress(form) && (() => {
              const progress = surveyProgress(form, hiddenFieldIds, formValues);
              return (
                <div className="mt-4" data-testid="survey-progress" role="progressbar" aria-valuenow={progress.answered} aria-valuemin={0} aria-valuemax={progress.total} aria-label="Survey progress">
                  <div className="flex items-center justify-between mb-1 text-sm text-slate-600">
                    <span>Progress</span>
                    <span>{progress.answered} of {progress.total} answered</span>
                  </div>
                  <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
              );
            })()}
            {/* Page progress indicator */}
            {hasPages && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-slate-600">
                    {currentPage?.title || `Page ${currentPageIndex + 1}`}
                  </span>
                  <span className="text-sm text-slate-500">
                    {currentPageIndex + 1} of {visiblePages.length}
                  </span>
                </div>
                <div className="flex gap-1">
                  {visiblePages.map((_, index) => (
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
            {/* Render fields - badge page or standard layout */}
            {(() => {
              const isBadgePage = currentPage?.page_style === 'name_badge';
              const columnCount = currentPage?.column_count || 1;
              
              const unassignedFields = currentPageIndex === 0 
                ? displayFields.filter(f => !f.page_id) 
                : [];
              const pageAssignedFields = displayFields.filter(f => 
                f.page_id === currentPage?.id
              );

              const renderField = (field) => (
                <FormRenderer
                  key={field.id}
                  field={field}
                  value={formValues[field.id]}
                  onChange={(value) => {
                    handleFieldChange(field.id, value);
                    handleImageButtonAutoAdvance(field);
                  }}
                  onFormNotListedTextChange={(text) => handleFormNotListedTextChange(field.id, text)}
                  memberInfo={memberData}
                  organizationInfo={effectiveOrganizationInfo}
                  selectedOrgGuestAccess={selectedOrgGuestAccess}
                  disabled={disabledFieldIds.has(field.id)}
                  onValidityChange={handleValidityChange}
                  onRelationshipEmptyStateChange={handleRelationshipEmptyStateChange}
                  formId={form?.id}
                  formSlug={form?.slug}
                  formMemberRoleId={prefillMember?.role_id || memberData?.role_id || null}
                  allFormValues={formValues}
                  prefillData={prefillData}
                  allFields={form?.fields || []}
                  membershipFeeQuote={membershipFeeQuote}
                />
              );

              if (isBadgePage) {
                const bs = currentPage.badge_style || {};
                const badgeWidth = bs.width || 400;
                const badgeHeight = bs.height || 280;
                const accentColor = bs.accent_color || '#3b82f6';
                const bgColor = bs.background_color || '#ffffff';
                const borderColor = bs.border_color || '#e2e8f0';
                const badgeRef = `badge-page-${currentPage.id}`;

                const handlePrintBadge = () => {
                  const el = document.querySelector(`[data-badge-id="${badgeRef}"]`);
                  if (!el) return;
                  const clone = el.cloneNode(true);
                  clone.querySelectorAll('input, select, button, textarea').forEach(ctrl => {
                    const span = document.createElement('span');
                    span.textContent = ctrl.value || ctrl.textContent || '';
                    span.style.cssText = ctrl.style.cssText;
                    ctrl.parentNode.replaceChild(span, ctrl);
                  });
                  const printWindow = window.open('', '_blank', 'width=600,height=400');
                  if (!printWindow) return;
                  printWindow.document.write(`<!DOCTYPE html><html><head><title>Name Badge</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff}@media print{body{margin:0;padding:0}@page{size:auto;margin:10mm}}</style></head><body>${clone.outerHTML}</body></html>`);
                  printWindow.document.close();
                  setTimeout(() => { printWindow.print(); }, 250);
                };

                const badgeFields = pageAssignedFields;
                const gridClass = columnCount === 2
                  ? 'grid grid-cols-1 md:grid-cols-2 gap-4'
                  : columnCount === 3
                    ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
                    : null;

                return (
                  <div className="flex flex-col items-center gap-4" data-testid="badge-page-wrapper">
                    {unassignedFields.length > 0 && (
                      <div className="w-full space-y-4 mb-2">
                        {unassignedFields.map(renderField)}
                      </div>
                    )}
                    <div
                      data-badge-id={badgeRef}
                      data-testid="badge-page-container"
                      style={{
                        width: `${badgeWidth}px`,
                        minHeight: `${badgeHeight}px`,
                        backgroundColor: bgColor,
                        border: `2px solid ${borderColor}`,
                        borderRadius: '12px',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                      }}
                    >
                      <div style={{ height: '6px', backgroundColor: accentColor, flexShrink: 0 }} />
                      <div style={{ flex: 1, padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {gridClass ? (
                          <div className={gridClass}>
                            {Array.from({ length: columnCount }).map((_, colIndex) => {
                              const colFields = badgeFields.filter(f => (f.column_index || 0) === colIndex);
                              return (
                                <div key={colIndex} className="space-y-3">
                                  {colFields.map(renderField)}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {badgeFields.map(renderField)}
                          </div>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handlePrintBadge}
                      data-testid="button-print-badge"
                    >
                      <Printer className="w-4 h-4 mr-2" />
                      Print Badge
                    </Button>
                  </div>
                );
              }

              if (columnCount === 1) {
                return displayFields.map(renderField);
              }
              
              const gridClass = columnCount === 2 
                ? 'grid grid-cols-1 md:grid-cols-2 gap-4' 
                : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4';

              // Payment fields must render full-width regardless of column assignment.
              const isPaymentField = (f) => f.type === 'membership_payment' || f.type === 'payment';
              const unassignedNonPayment = unassignedFields.filter(f => !isPaymentField(f));
              const unassignedPayment = unassignedFields.filter(isPaymentField);
              const assignedPayment = pageAssignedFields.filter(isPaymentField);
              const fullWidthPaymentFields = [...unassignedPayment, ...assignedPayment];
              
              return (
                <>
                  {unassignedNonPayment.length > 0 && (
                    <div className="space-y-4 mb-4">
                      {unassignedNonPayment.map(renderField)}
                    </div>
                  )}
                  <div className={gridClass}>
                    {Array.from({ length: columnCount }).map((_, colIndex) => {
                      const columnFields = pageAssignedFields.filter(f => 
                        !isPaymentField(f) && (f.column_index || 0) === colIndex
                      );
                      return (
                        <div key={colIndex} className="space-y-4">
                          {columnFields.map(renderField)}
                        </div>
                      );
                    })}
                  </div>
                  {fullWidthPaymentFields.length > 0 && (
                    <div className="space-y-4 mt-4">
                      {fullWidthPaymentFields.map(renderField)}
                    </div>
                  )}
                </>
              );
            })()}
            {/* Schema change warning */}
            {schemaChanged && schemaChangeMessage && (
              <div className="flex items-start gap-3 p-3 bg-warning/10 border border-warning/30 rounded-md mb-4">
                <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                <div className="text-sm text-warning">
                  <p className="font-medium">Form has been updated</p>
                  <p className="text-warning">{schemaChangeMessage}</p>
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
                    data-testid="input-resume-link"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={copyResumeLink}
                    className="shrink-0"
                    data-testid="button-copy-resume-link"
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
            
            {/* Submission error display */}
            {submissionError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md" data-testid="submission-error">
                <p className="text-sm text-red-700">{submissionError}</p>
              </div>
            )}

            {/* Task #944: Submitter "email me a copy" block (standard layout, last page only) */}
            {form?.allow_submitter_email_copy && (!hasPages || isLastPage) && (
              <div className="mb-4 p-3 border border-slate-200 rounded-md bg-slate-50 space-y-2" data-testid="block-submitter-copy">
                <label htmlFor="submitter-copy-email" className="block text-sm font-medium text-slate-700">Get a copy of your submission</label>
                <input
                  id="submitter-copy-email"
                  type="email"
                  value={submitterCopyEmail}
                  onChange={(e) => setSubmitterCopyEmail(e.target.value)}
                  placeholder="your.email@example.com"
                  className="w-full text-sm border border-slate-300 rounded px-2 py-1.5"
                  data-testid="input-submitter-copy-email"
                />
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={submitterCopyRequested}
                    onChange={(e) => setSubmitterCopyRequested(e.target.checked)}
                    className="mt-0.5"
                    data-testid="checkbox-submitter-copy-requested"
                  />
                  <span>Email me a Word copy of my submission</span>
                </label>
                {submitterCopyEmailInvalid && (
                  <p className="text-xs text-red-600" data-testid="text-submitter-copy-email-error">
                    Please enter a valid email address.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-5 pt-4" data-testid="form-final-actions">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {/* Previous button (only show if we have pages and not on first page) */}
                {hasPages && !isFirstPage ? (
                  <Button
                    variant="outline"
                    onClick={goToPreviousPage}
                    className="w-full sm:w-auto"
                  >
                    <ChevronLeft className="w-4 h-4 mr-2" />
                    Previous
                  </Button>
                ) : (
                  <div />
                )}

                <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
                {/* Save & Continue Later button - only show when allowed (default on) */}
                {form?.allow_save_continue_later !== false && (
                  <Button
                    variant="outline"
                    onClick={() => saveDraftMutation.mutate()}
                    disabled={saveDraftMutation.isPending}
                    className="w-full sm:w-auto"
                    data-testid="button-save-draft"
                  >
                    {saveDraftMutation.isPending ? (
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
                
                {/* Next/Submit button */}
                {hasPages && !isLastPage ? (
                  !(displayFields.some(f => f.type === 'image_buttons' && f.auto_advance !== false && f.hide_next_button === true && !disabledFieldIds.has(f.id))) ? (
                    <Button
                      onClick={goToNextPage}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-2" />
                    </Button>
                  ) : null
                ) : !visiblePaymentField ? (
                  <Button
                    onClick={handleSubmit}
                    disabled={submitControl.disabled || submitFormMutation.isPending}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-submit-form"
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
                ) : null}
                </div>
              </div>
              {(isLastPage || !hasPages) && visiblePaymentField && (
                <div className="w-full border-t pt-5" data-testid="form-payment-area">
                  <FormPaymentSubmit
                    field={visiblePaymentField}
                    formValues={formValues}
                    buildPayload={buildSubmissionPayload}
                    idempotencyKey={getIdempotencyKey()}
                    disabled={submitControl.disabled}
                    disabledMessage={submitControl.message}
                    busy={submitFormMutation.isPending}
                    onPaid={() => { rotateIdempotencyKey(); setSubmitted(true); }}
                    onNormalSubmit={handleSubmit}
                    submitLabel={form.submit_button_text}
                    membershipQuote={membershipFeeQuote}
                  />
                </div>
              )}
            </div>
            {(isLastPage || !hasPages) && submitControl.disabled && submitControl.message && (
              <p className="text-xs text-warning text-center mt-2" data-testid="text-submit-disabled-message">
                {submitControl.message}
              </p>
            )}
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
import { applySurveyPresentation, surveySuccessMessage, surveyIntroText, showSurveyProgress, surveyProgress } from '@/lib/surveyPresentation';
import { evaluateScoreCondition } from '@/lib/surveyConditions';
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loader2, ChevronLeft, ChevronRight, CheckCircle2, Lock } from "lucide-react";
import FormRenderer, { RepeatableAvailabilityProbe } from "../components/forms/FormRenderer";
import { toast, Toaster } from "sonner";
import { publicClient } from "@/api/publicClient";
import { base44 } from "@/api/base44Client";
import { buildPrefillValues, resolveEffectivePrefillIds, resolveMemberSourceOrgId, shouldWaitForPrefillCustomValues, shouldWaitForPrefillOrgEntity, isFieldValueFilled } from "@/lib/formFieldPrefill";
import { useSubmissionIdempotencyKey } from "@/lib/useSubmissionIdempotencyKey";
import { useCardSwipeAutoFocus } from "@/lib/cardSwipeAutoFocus";
import { useMembershipFeeQuote } from "@/lib/useMembershipFeeQuote";
import { COUNTRIES } from "@/data/countries";
import { evaluateLmicCondition } from "../../../api/_lib/formLmicConditions.js";
import { resolveSubmitControl } from "../../../api/_lib/formSubmitControl.js";
import FormPaymentSubmit from "../components/forms/FormPaymentSubmit";
import { useFormPaymentReturn, FormPaymentReturnScreen } from "../components/forms/FormPaymentReturn";
import {
  getPaymentNavigationContext,
  navigateToPaymentProvider,
  sanitizePaymentContinuePath,
} from "@/lib/formPaymentReturn";
import FormAccessRestriction, { resolveFormAccess } from "@/components/forms/FormAccessRestriction";
import { evaluateFormLogicCondition } from "@/lib/formLogicConditions";
import { FORM_NO_RELATIONSHIP_VALUE } from "../../../shared/formNoRelationshipChoice.js";
import {
  pruneFormNotListedText,
  setFormNotListedText,
} from "../../../shared/formNotListedChoice.js";
import { useConditionalFormFieldPrefill, useFormFieldPrefill } from "@/lib/useFormFieldPrefill";
import { applyFormFieldValueChange } from "@/lib/formFieldValueChange";
import { getFormPagination } from "@/lib/formPagination";
import { observeFormEmbedContent } from "@/lib/formEmbedRuntime";
import { resolveFormPageVisibility } from "@/lib/formPageVisibility";
import { useFormOpenTransition } from "@/lib/useFormOpenTransition";
import FormTransitionOverlay from "@/components/forms/FormTransitionOverlay";
import { validateFutureDateFields } from "../../../shared/formFutureDates.js";
import { getFormMaxWidth } from "../../../shared/formWidth.js";
import { PAYMENT_RETURN_READY_MESSAGE } from "@/lib/formPaymentReturnScroll";
import {
  activeDisplayNameCopyIssues,
  resolveDisplayNameCopyValue,
} from "@/lib/formConditionalCopyMode";
import {
  currentSetSaveBlocked,
  currentSetCommitConfirmed,
  currentSetSubmissionMetadata,
  useDepartmentCurrentSet,
} from "@/lib/departmentCurrentSet";
import DepartmentCurrentSetNotice from "@/components/forms/DepartmentCurrentSetNotice";

// Stable empty array so disabled custom-value queries don't create a fresh
// default identity every render (which would re-trigger dependent effects).
const EMPTY_ARRAY = [];
const EMPTY_FORM_COLLECTION = Object.freeze([]);

// Mount beside the actual outcome, not the provider callback. The next frame
// also lets the outer embed runtime mount before an immediately-restored return.
function CommittedOutcomeNavigation({ enabled = true, onReady, messageType }) {
  useEffect(() => {
    if (!enabled) return;
    const frame = requestAnimationFrame(() => onReady(messageType));
    return () => cancelAnimationFrame(frame);
  }, [enabled, onReady, messageType]);
  return null;
}

export default function EmbedFormPage() {
  const contentRef = useRef(null);
  const runtimeRef = useRef(null);
  useEffect(() => {
    const runtime = observeFormEmbedContent(contentRef.current);
    runtimeRef.current = runtime;
    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, []);
  const notifyParentResize = useCallback(() => runtimeRef.current?.schedule(), []);
  const onPageNavigation = useCallback(() => runtimeRef.current?.navigated(), []);
  const onOutcomeNavigation = useCallback((messageType) => runtimeRef.current?.completed(messageType), []);
  return (
    <div ref={contentRef} style={{ display: 'flow-root' }} data-form-embed-content>
      <EmbedFormContent notifyParentResize={notifyParentResize} onPageNavigation={onPageNavigation} onOutcomeNavigation={onOutcomeNavigation} />
    </div>
  );
}

function EmbedFormContent({ notifyParentResize, onPageNavigation, onOutcomeNavigation }) {
  const { slug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const [currentStep, setCurrentStep] = useState(0);
  // Task #3515: never autofocus the first card on initial mount (browsers
  // scroll a focused input into view, yanking embedding pages down to the
  // form); step transitions still focus as before.
  const cardSwipeAutoFocusFor = useCardSwipeAutoFocus(currentStep);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const pendingPageNavigationRef = useRef(null);
  const [formValues, setFormValues] = useState({});
  const [recordSelectionOptionStates, setRecordSelectionOptionStates] = useState({});
  const [emptyRepeatableFieldIds, setEmptyRepeatableFieldIds] = useState(() => new Set());
  const lastChangedFieldRef = useRef({ formId: null, fieldId: null, revision: 0 });
  const [emptyRelationshipParentValues, setEmptyRelationshipParentValues] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const inlineCompletionRef = useRef(false);
  // The payment hook cleans history before later confirmation/poll renders.
  // Retain navigation context only; the parent still authorizes the relay.
  const returnedPaymentRef = useRef([
    'form_payment_submission', 'form_payment_provider', 'form_payment_cancelled',
    'payment_intent', 'redirect_status',
  ].some(key => searchParams.has(key)));

  // Task #3501: page-level payment return-leg handling (see FormView) —
  // the embed page must handle redirect returns identically.
  const [fieldValidity, setFieldValidity] = useState({});
  const [submissionError, setSubmissionError] = useState(null);
  const [defaultsInitialized, setDefaultsInitialized] = useState(false);
  const [defaultsInitializedFormId, setDefaultsInitializedFormId] = useState(null);

  // Clear submission error when form values change
  useEffect(() => {
    if (submissionError) {
      setSubmissionError(null);
    }
  }, [formValues]);

  const handleValidityChange = (fieldId, isValid) => {
    setFieldValidity(prev => ({ ...prev, [fieldId]: isValid }));
  };

  const handleFormNotListedTextChange = (fieldId, text) => {
    departmentCurrentSet?.markEdited?.();
    setFormValues(prev => setFormNotListedText(prev, fieldId, text));
    notifyParentResize();
  };

  const handleFieldChange = (fieldId, value) => {
    departmentCurrentSet?.markEdited?.();
    lastChangedFieldRef.current = {
      formId: form?.id,
      fieldId,
      revision: lastChangedFieldRef.current.revision + 1,
    };
    setFormValues(prev => applyFormFieldValueChange({
      fields: form?.fields,
      currentValues: prev,
      fieldId,
      value,
    }));
    notifyParentResize();
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
  const handleRecordSelectionOptionsChange = useCallback((fieldId, state) => {
    setRecordSelectionOptionStates(previous => {
      const next = {
        status: state?.status || 'unavailable',
        options: state?.options || [],
        scope: state?.scope || '',
      };
      const current = previous[fieldId];
      if (current?.status === next.status && current?.scope === next.scope
        && JSON.stringify(current.options) === JSON.stringify(next.options)) return previous;
      return { ...previous, [fieldId]: next };
    });
  }, []);
  const handleRepeatableVisibilityChange = useCallback((fieldId, hidden, status) => {
    setEmptyRepeatableFieldIds(previous => {
      const has = previous.has(fieldId);
      if (has === hidden) return previous;
      const next = new Set(previous);
      if (hidden) next.add(fieldId);
      else next.delete(fieldId);
      return next;
    });
  }, []);

  const urlPrefillMemberId = searchParams.get('member_id');
  const urlPrefillOrgId = searchParams.get('organization_id');
  const tenantParam = searchParams.get('tenant');
  const currentSetDepartmentParam = searchParams.get('department_id');
  const selectCurrentSetDepartment = useCallback((departmentId) => {
    if (!departmentId) return;
    const next = new URLSearchParams(searchParams);
    next.set('department_id', departmentId);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const fontFamilyParam = searchParams.get('font') || '';
  const fontSizeParam = searchParams.get('fontSize') || '';
  // Canvas supplies its resolved microsite (or tenant) home. It is limited to
  // a safe local non-form path before it can be used as a continuation.
  const embedContinuePath = useMemo(
    () => sanitizePaymentContinuePath(searchParams.get('payment_embed_continue') || '/'),
    [searchParams],
  );

  // Task #3336: resolve the authenticated member inside the embed iframe.
  // The Canvas Form Embed block uses a same-origin iframe, so the session
  // cookie flows with this request. Never throws — anonymous viewers (or any
  // failure) resolve to null and the form degrades gracefully to blank fields.
  const { data: authMember = null, isLoading: authMemberLoading } = useQuery({
    queryKey: ['embed-auth-member'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (!response.ok) return null;
        const member = await response.json();
        return member && member.id ? member : null;
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: false
  });

  // Task #3364: anonymous visitor on an auth-required form. The public
  // endpoint returns a limited preview shape in this case — instead of
  // rendering it, route the visitor through login and back.
  //  - Top window (direct /embed/form/<slug> visit, e.g. a Canvas form block
  //    in link mode): redirect to /login with returnTo back to this form.
  //  - Framed (Canvas inline/iframe embed): render a login prompt whose link
  //    opens in the TOP window and returns to the embedding page after login.
  const isFramed = (() => {
    try { return window.self !== window.top; } catch { return true; }
  })();
  const loginReturnTo = useMemo(() => {
    if (isFramed) {
      // Same-origin Canvas embeds: read the containing page's URL directly;
      // fall back to the referrer, then to this embed URL itself.
      try {
        const topLoc = window.top.location;
        return `${topLoc.pathname}${topLoc.search}`;
      } catch { /* cross-origin frame */ }
      try {
        if (document.referrer) {
          const u = new URL(document.referrer);
          if (u.origin === window.location.origin) return `${u.pathname}${u.search}`;
        }
      } catch { /* ignore */ }
    }
    return `${window.location.pathname}${window.location.search}`;
  }, [isFramed]);
  const loginHref = `/login?returnTo=${encodeURIComponent(loginReturnTo)}`;

  const { data: loadedForm, isLoading, error } = useQuery({
    queryKey: ['embed-form', slug, tenantParam, !!authMember],
    queryFn: async () => await publicClient.getForm(slug, { authenticated: !!authMember }) || null,
    // Do not race an anonymous schema against the member-aware request while
    // the iframe's session probe is unresolved. Guests still make the same
    // single request after the probe settles to 401/null.
    enabled: !!slug && !authMemberLoading
  });

  const {
    activeForm: rawForm,
    initialValues: transitionInitialValues,
    restoreNavigation: transitionRestoreNavigation,
    canReturnToPreviousForm,
    returnToPreviousForm,
    isTransitioning,
    transitionError,
  } = useFormOpenTransition({
    initialForm: loadedForm,
    formValues,
    conditionValues: {
      ...formValues,
      ...Object.fromEntries(
        Object.keys(emptyRelationshipParentValues).map(fieldId => [fieldId, FORM_NO_RELATIONSHIP_VALUE]),
      ),
    },
    authenticated: !!authMember,
    enabled: !!loadedForm && defaultsInitialized && !submitted,
    navigationPosition: { currentPageIndex, currentStep },
    lastChangedField: lastChangedFieldRef.current,
  });

  // Survey presentation (question numbering) — no-op for standard forms
  const form = useMemo(() => applySurveyPresentation(rawForm), [rawForm]);
  useEffect(() => {
    setRecordSelectionOptionStates({});
    setEmptyRepeatableFieldIds(new Set());
  }, [form?.id]);
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
  const accessPayload = rawForm || (error?.errorData?.access
    ? { __access: error.errorData.access }
    : null);
  const formAccess = resolveFormAccess(accessPayload, !!authMember);
  const departmentCurrentSet = useDepartmentCurrentSet({
    form,
    departmentId: currentSetDepartmentParam,
    principalId: authMember?.id,
    formValues,
    setFormValues,
    ready: !authMemberLoading && defaultsInitialized,
    onDepartmentSelect: selectCurrentSetDepartment,
  });
  const departmentCurrentSetBlocked = currentSetSaveBlocked({
    enabled: departmentCurrentSet.active,
    departmentId: departmentCurrentSet.departmentId,
    loading: departmentCurrentSet.loading,
    error: departmentCurrentSet.error,
    currentSet: departmentCurrentSet.currentSet,
    sectionIds: departmentCurrentSet.sectionIds,
    acknowledgements: departmentCurrentSet.acknowledgements,
    baselineReady: departmentCurrentSet.baselineReady,
  });
  // Return-leg confirmation is safe before the form body is released: it can
  // only finalize a server-created pending payment carrying prior access proof.
  const paymentReturn = useFormPaymentReturn();
  const paymentContinue = useMemo(() => {
    const navigation = getPaymentNavigationContext();
    return {
      destination: sanitizePaymentContinuePath(paymentReturn.continuePath || embedContinuePath),
      mayNavigateParent: navigation.target === 'top',
      navigation,
    };
  }, [embedContinuePath, paymentReturn.continuePath]);
  const continuePaymentReturn = useCallback(() => {
    if (!paymentContinue.mayNavigateParent) return;
    navigateToPaymentProvider(paymentContinue.destination, paymentContinue.navigation);
  }, [paymentContinue]);

  // Task #3364: auth-required form viewed anonymously. Wait for the auth
  // probe to settle so a logged-in visitor is never bounced to /login while
  // their authenticated refetch is still in flight.
  const authRequiredAnonymous = (!!form?.require_authentication || formAccess.anonymous) && !authMember && !authMemberLoading;
  useEffect(() => {
    if (!paymentReturn.active && authRequiredAnonymous && !isFramed) {
      window.location.replace(loginHref);
    }
  }, [authRequiredAnonymous, isFramed, loginHref, paymentReturn.active]);

  // Task #3336: authenticated fallback — when the form uses member/organisation
  // prefill and no explicit URL param is supplied, prefill from the logged-in
  // member and their associated organisation. Explicit URL params always take
  // precedence; anonymous viewers get no fallback.
  const { prefillMemberId, prefillOrgId } = resolveEffectivePrefillIds({
    urlMemberId: urlPrefillMemberId,
    urlOrgId: urlPrefillOrgId,
    prefillSource: form?.prefill_source,
    viewerMemberId: authMember?.id,
    viewerOrgId: authMember?.organization_id,
  });

  // Prefill: fetch the target entities and custom values. Mirrors FormView's
  // dual path — the authenticated entity API when a session exists (full
  // data), the public prefill endpoints otherwise (safe subset) so explicit
  // ?member_id/?organization_id URLs work for anonymous viewers too.
  const { data: prefillMemberData } = useQuery({
    queryKey: ['prefill-member-embedform', prefillMemberId, form?.slug || slug, !!authMember],
    queryFn: async () => {
      if (authMember) {
        const [member, resourceCategorySelections] = await Promise.all([
          base44.entities.Member.get(prefillMemberId),
          base44.entities.MemberResourceCategory.list({
            filter: { member_id: prefillMemberId }
          }).catch(error => {
            console.error('[EmbedForm Prefill] Failed to load member resource categories:', error);
            return [];
          })
        ]);
        return {
          member,
          customValues: null,
          resourceCategorySelections: resourceCategorySelections || []
        };
      }
      return publicClient.getPrefillMember(prefillMemberId, form?.slug || slug);
    },
    enabled: !!prefillMemberId && form?.prefill_source === 'member'
  });

  const prefillMember = prefillMemberData?.member || null;

  const { data: prefillOrg, isLoading: prefillOrgLoading } = useQuery({
    queryKey: ['prefill-org-embedform', prefillOrgId, !!authMember],
    queryFn: async () => {
      if (authMember) {
        return base44.entities.Organization.get(prefillOrgId);
      }
      return publicClient.getOrganization(prefillOrgId);
    },
    enabled: !!prefillOrgId && form?.prefill_source === 'organization'
  });

  // Task #3357: effective org id for member-source forms — member entity's
  // own organization_id, else the authenticated fallback (prefillOrgId).
  const memberSourceOrgId = resolveMemberSourceOrgId({
    prefillSource: form?.prefill_source,
    memberEntity: prefillMember,
    fallbackOrgId: prefillOrgId,
  });

  const { data: prefillMemberOrg, isLoading: memberOrgLoading } = useQuery({
    queryKey: ['prefill-member-org-embedform', memberSourceOrgId, !!authMember],
    queryFn: async () => {
      if (authMember) {
        return base44.entities.Organization.get(memberSourceOrgId);
      }
      return publicClient.getOrganization(memberSourceOrgId);
    },
    enabled: !!memberSourceOrgId && form?.prefill_source === 'member'
  });

  const { data: prefillMemberCustomValues = EMPTY_ARRAY, isLoading: memberCustomValuesLoading } = useQuery({
    queryKey: ['prefill-member-custom-values-embedform', prefillMemberId, !!authMember],
    queryFn: async () => {
      if (authMember) {
        const values = await base44.entities.MemberPreferenceValue.list({
          filter: { member_id: prefillMemberId }
        });
        return values || [];
      }
      return prefillMemberData?.customValues || [];
    },
    enabled: !!prefillMemberId && form?.prefill_source === 'member' && (!!authMember || !!prefillMemberData)
  });

  // Org custom values come from the direct org prefill target or, for member
  // prefill, the member's own organisation (so org custom-field prefill also
  // works from the authenticated fallback org).
  const effectiveOrgIdForCustomFields = form?.prefill_source === 'organization'
    ? prefillOrgId
    : memberSourceOrgId;

  const { data: prefillOrgCustomValues = EMPTY_ARRAY, isLoading: orgCustomValuesLoading } = useQuery({
    queryKey: ['prefill-org-custom-values-embedform', effectiveOrgIdForCustomFields],
    queryFn: async () => {
      // Public endpoint (as in FormView) so anonymous explicit-param prefill
      // also gets org custom values.
      const values = await publicClient.getOrganizationPreferenceValues(effectiveOrgIdForCustomFields);
      return values || [];
    },
    enabled: !!effectiveOrgIdForCustomFields && !!form?.prefill_source && form.prefill_source !== 'none'
  });
  useFormFieldPrefill({
    form,
    formSlug: form?.slug || slug,
    formValues,
    setFormValues,
    enabled: !!form && !formAccess.restricted && defaultsInitialized
      && String(defaultsInitializedFormId) === String(form?.id),
    protectedFieldIds: transitionRestoreNavigation
      ? (form?.fields || []).map(field => field.id)
      : Object.keys(transitionInitialValues || {}),
  });
  const conditionalPrefillValues = useConditionalFormFieldPrefill({
    form,
    formSlug: form?.slug || slug,
    formValues,
    enabled: !!form && !formAccess.restricted && defaultsInitialized,
  });
  const [prefillApplied, setPrefillApplied] = useState(false);

  useEffect(() => {
    setCurrentPageIndex(transitionRestoreNavigation?.currentPageIndex ?? 0);
    setCurrentStep(transitionRestoreNavigation?.currentStep ?? 0);
    setSubmitted(false);
    setDefaultsInitialized(false);
    setDefaultsInitializedFormId(null);
    setPrefillApplied(!!transitionRestoreNavigation);
    setFormValues(transitionInitialValues || {});
  }, [form?.id, transitionInitialValues, transitionRestoreNavigation]);

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
      // Country field — resolve ISO code to display name so rule comparisons
      // (which use the name the combobox stores on selection) work correctly.
      if (field.type === 'country' && field.default_country) {
        fieldDefaults[field.id] = COUNTRIES.find(c => c.code === field.default_country)?.name || field.default_country;
      }
      // Countries (multi-select) — resolve each ISO code to display name.
      if (field.type === 'countries' && field.default_countries?.length > 0) {
        fieldDefaults[field.id] = field.default_countries.map(
          code => COUNTRIES.find(c => c.code === code)?.name || code
        );
      }
      if (field.default_value !== undefined && field.default_value !== null && field.default_value !== '') {
        fieldDefaults[field.id] = field.default_value;
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
      setFormValues(prev => ({ ...fieldDefaults, ...prev }));
    }
    setDefaultsInitialized(true);
    setDefaultsInitializedFormId(String(form.id));
  }, [form?.id, form?.fields, defaultsInitialized]);

  // Prefill: populate form values when the prefill entity loads (one-time only).
  // Mirrors the FormView / IEditFormElement mapping for member/organisation
  // prefill sources. Waits for defaults so booleans aren't overwritten, and for
  // custom values so custom-field prefill isn't skipped by a race.
  useEffect(() => {
    if (!form || !form.prefill_source || form.prefill_source === 'none') return;
    if (!defaultsInitialized) return;
    if (prefillApplied) return;
    // Wait for BOTH member and organisation custom values before applying —
    // the entity can resolve first, and applying then would latch
    // prefillApplied and permanently skip custom-field prefills.
    if (shouldWaitForPrefillCustomValues({
      prefillSource: form.prefill_source,
      // The custom-value queries also run for anonymous viewers (public
      // endpoints), so the gate must apply regardless of auth state.
      authenticated: true,
      memberId: prefillMemberId,
      orgIdForCustomFields: effectiveOrgIdForCustomFields,
      memberCustomValuesLoading,
      orgCustomValuesLoading,
    })) return;

    // Task #3357: also wait while an org-entity fetch that will feed
    // `org:`-mapped fields is still in flight, so the effect can't latch
    // before the organisation resolves.
    if (shouldWaitForPrefillOrgEntity({
      prefillSource: form.prefill_source,
      form,
      effectiveOrgId: form.prefill_source === 'organization' ? prefillOrgId : memberSourceOrgId,
      orgEntityLoading: form.prefill_source === 'organization' ? prefillOrgLoading : memberOrgLoading,
    })) return;

    const memberEntity = prefillMember;
    const orgEntity = form.prefill_source === 'organization' ? prefillOrg : prefillMemberOrg;
    const primaryEntity = form.prefill_source === 'member' ? memberEntity : orgEntity;
    if (!primaryEntity) return;

    const newValues = buildPrefillValues({
      form,
      memberEntity,
      orgEntity,
      primaryEntity,
      memberCustomValues: prefillMemberCustomValues,
      orgCustomValues: prefillOrgCustomValues,
      memberResourceCategorySelections: prefillMemberData?.resourceCategorySelections || [],
      prefillOrgId,
    });

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
        return merged;
      });
    }
    // Latch even when nothing matched: the entity and custom values have
    // settled, so an empty result is final. Without this, a later query
    // refetch could re-run prefill and overwrite values the user has since
    // typed into (then cleared/edited) blank fields.
    setPrefillApplied(true);
  }, [form, prefillMember, prefillMemberData?.resourceCategorySelections, prefillOrg, prefillMemberOrg, prefillMemberCustomValues, prefillOrgCustomValues, prefillApplied, defaultsInitialized, prefillOrgId, prefillMemberId, memberSourceOrgId, memberOrgLoading, prefillOrgLoading, effectiveOrgIdForCustomFields, authMember, memberCustomValuesLoading, orgCustomValuesLoading]);

  const originalValuesRef = useRef({});
  const activeSetValueActionsRef = useRef(new Set());

  useEffect(() => {
    originalValuesRef.current = {};
    activeSetValueActionsRef.current = new Set();
  }, [form?.id]);

  const evaluateSingleCondition = (triggerValue, operator, value, fieldId = null) => {
    // LMIC operators on country fields (Task #3477) — compared against the
    // tenant LMIC list delivered with the form payload.
    const lmicResult = evaluateLmicCondition(triggerValue, operator, form?.lmic_country_codes);
    if (lmicResult !== undefined) return lmicResult;
    // Defensive: if a country field value was seeded as an ISO-2 code (e.g.
    // from a legacy in-flight session), resolve it to the display name so
    // comparisons against names like "United Kingdom" work correctly.
    if (typeof triggerValue === 'string' && /^[A-Z]{2}$/.test(triggerValue)) {
      const resolved = COUNTRIES.find(c => c.code === triggerValue)?.name;
      if (resolved) triggerValue = resolved;
    }
    // Survey Score answers ({score}/{na}) + numeric operators (Task #3330)
    const scoreResult = evaluateScoreCondition(triggerValue, operator, value);
    if (scoreResult !== undefined) return scoreResult;
    const conditionField = form?.fields?.find(field => field.id === fieldId);
    const parentFieldId = conditionField?.type === 'relationship_dropdown'
      ? conditionField.parent_field_id
      : null;
    const relationshipEmpty = !!parentFieldId
      && emptyRelationshipParentValues[conditionField.id] === formValues[parentFieldId];
    return evaluateFormLogicCondition(triggerValue, operator, value, { relationshipEmpty });
  };

  const evaluateRuleConditions = (rule, currentFormValues) => {
    if (rule.trigger_field_id && (!rule.conditions || !Array.isArray(rule.conditions) || rule.conditions.length === 0)) {
      const triggerValue = currentFormValues[rule.trigger_field_id];
      return evaluateSingleCondition(triggerValue, rule.operator, rule.value, rule.trigger_field_id);
    }

    if (rule.conditions && Array.isArray(rule.conditions) && rule.conditions.length > 0) {
      const logic = rule.logic || 'and';
      const results = rule.conditions.map((condition) => {
        if (!condition.field_id) return false;
        const triggerValue = currentFormValues[condition.field_id];
        return evaluateSingleCondition(triggerValue, condition.operator, condition.value, condition.field_id);
      });

      if (logic === 'and') {
        return results.every(r => r === true);
      } else {
        return results.some(r => r === true);
      }
    }

    return false;
  };

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

  const computeSetValue = (action) => {
    const sourceType = action.set_value_source || 'static';
    if (sourceType === 'static') {
      return action.set_value;
    } else if (sourceType === 'field') {
      const displayName = resolveDisplayNameCopyValue({
        action,
        fields: form?.fields,
        values: formValues,
        optionStates: recordSelectionOptionStates,
      });
      if (displayName) return displayName.value;
      return formValues[action.set_value_field_id];
    } else if (sourceType === 'formula') {
      const operandAMode = action.formula_operand_a_mode || 'field';
      let operandAValue;
      if (operandAMode === 'value') {
        operandAValue = parseFloat(action.formula_operand_a_value || 0);
      } else {
        const fieldId = action.formula_operand_a_field_id || action.formula_field_a;
        operandAValue = parseFloat(formValues[fieldId] || 0);
      }
      const operandBMode = action.formula_operand_b_mode || 'field';
      let operandBValue;
      if (operandBMode === 'value') {
        operandBValue = parseFloat(action.formula_operand_b_value || 0);
      } else {
        const fieldId = action.formula_operand_b_field_id || action.formula_field_b;
        operandBValue = parseFloat(formValues[fieldId] || 0);
      }
      const operator = action.formula_operator || 'add';
      let result;
      switch (operator) {
        case 'add': result = operandAValue + operandBValue; break;
        case 'subtract': result = operandAValue - operandBValue; break;
        case 'multiply': result = operandAValue * operandBValue; break;
        case 'divide':
          if (operandBValue === 0) return null;
          result = operandAValue / operandBValue;
          break;
        default: result = 0;
      }
      const rounded = Math.round(result * 1e10) / 1e10;
      return rounded.toString();
    } else if (sourceType === 'prefill' && form?.prefill_source === 'form_field') {
      return conditionalPrefillValues[action.id];
    }
    return null;
  };

  const computeLegacySetValue = (rule) => {
    const sourceType = rule.set_value_source || 'static';
    if (sourceType === 'static') {
      return rule.set_value;
    } else if (sourceType === 'field') {
      const displayName = resolveDisplayNameCopyValue({
        action: rule,
        fields: form?.fields,
        values: formValues,
        optionStates: recordSelectionOptionStates,
      });
      if (displayName) return displayName.value;
      return formValues[rule.set_value_field_id];
    } else if (sourceType === 'prefill' && form?.prefill_source === 'form_field') {
      return conditionalPrefillValues[`legacy_${rule.id}`];
    }
    return null;
  };
  const displayNameCopyIssues = useMemo(() => activeDisplayNameCopyIssues({
    rules: form?.visibility_rules,
    fields: form?.fields,
    values: formValues,
    optionStates: recordSelectionOptionStates,
    evaluateRule: evaluateRuleConditions,
  }), [form?.visibility_rules, form?.fields, formValues, recordSelectionOptionStates, emptyRelationshipParentValues]);

  const formPages = form?.pages || EMPTY_FORM_COLLECTION;
  const { hiddenFieldIds, hiddenPageIds } = useMemo(() => resolveFormPageVisibility({
    fields: form?.fields,
    pages: formPages,
    visibilityRules: form?.visibility_rules,
    formValues,
    evaluateRuleConditions,
  }), [
    form?.fields,
    formPages,
    form?.visibility_rules,
    formValues,
    emptyRelationshipParentValues,
  ]);

  // Filter visible fields
  const filterVisibleFields = (fields) => {
    if (!fields) return [];
    return fields.filter(field => (
      !hiddenFieldIds.has(field.id) && !emptyRepeatableFieldIds.has(field.id)
    ));
  };

  const hiddenRepeatableFields = useMemo(() => (
    (form?.fields || []).filter(field => (
      emptyRepeatableFieldIds.has(field.id) && !hiddenFieldIds.has(field.id)
    ))
  ), [emptyRepeatableFieldIds, form?.fields, hiddenFieldIds]);
  const effectiveHiddenFieldIds = useMemo(
    () => new Set([...hiddenFieldIds, ...emptyRepeatableFieldIds]),
    [emptyRepeatableFieldIds, hiddenFieldIds],
  );
  useEffect(() => {
    const count = filterVisibleFields(form?.fields || []).length;
    if (count > 0 && currentStep >= count) setCurrentStep(count - 1);
  }, [currentStep, emptyRepeatableFieldIds, form?.fields, hiddenFieldIds]);

  // Process set_value rules - when conditions are met, update target field values
  useEffect(() => {
    if (!form?.visibility_rules || form.visibility_rules.length === 0) return;
    
    const updates = {};
    const nowActiveActions = new Set();
    const activeFieldTargets = new Map();
    
    for (const rule of form.visibility_rules) {
      if (!rule.conditions?.length && !rule.trigger_field_id) continue;
      
      const conditionMet = evaluateRuleConditions(rule, formValues);
      
      if (rule.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action.action_type === 'set_value' && action.target_field_id) {
            const actionKey = action.id;
            
            if (conditionMet) {
              nowActiveActions.add(actionKey);
              
              if (!activeFieldTargets.has(action.target_field_id)) {
                activeFieldTargets.set(action.target_field_id, new Set());
              }
              activeFieldTargets.get(action.target_field_id).add(actionKey);
              
              if (!activeSetValueActionsRef.current.has(actionKey)) {
                if (!(action.target_field_id in originalValuesRef.current)) {
                  originalValuesRef.current[action.target_field_id] = formValues[action.target_field_id] ?? '';
                }
                
                const valueToSet = coerceValueForField(computeSetValue(action), action.target_field_id);
                if (valueToSet !== null && valueToSet !== undefined) {
                  updates[action.target_field_id] = valueToSet;
                }
              }
              if ((action.set_value_source || 'static') === 'field' && action.set_value_field_id && activeSetValueActionsRef.current.has(actionKey)) {
                const sourceValue = coerceValueForField(computeSetValue(action), action.target_field_id);
                const currentTargetValue = formValues[action.target_field_id];
                if (sourceValue !== currentTargetValue && sourceValue !== null && sourceValue !== undefined) {
                  updates[action.target_field_id] = sourceValue;
                }
              }
              else if ((action.set_value_source || 'static') === 'formula') {
                const hasOperandA = (action.formula_operand_a_mode === 'value' && action.formula_operand_a_value !== '') ||
                                    (action.formula_operand_a_mode !== 'value' && (action.formula_operand_a_field_id || action.formula_field_a));
                const hasOperandB = (action.formula_operand_b_mode === 'value' && action.formula_operand_b_value !== '') ||
                                    (action.formula_operand_b_mode !== 'value' && (action.formula_operand_b_field_id || action.formula_field_b));
                
                if (hasOperandA || hasOperandB) {
                  const newValue = coerceValueForField(computeSetValue(action), action.target_field_id);
                  const currentTargetValue = formValues[action.target_field_id];
                  if (newValue !== currentTargetValue && newValue !== null && newValue !== undefined) {
                    updates[action.target_field_id] = newValue;
                  }
                }
              }
              else if ((action.set_value_source || 'static') === 'prefill'
                  && activeSetValueActionsRef.current.has(actionKey)) {
                const newValue = coerceValueForField(
                  computeSetValue(action),
                  action.target_field_id,
                );
                if (newValue === null || newValue === undefined) {
                  if (action.target_field_id in originalValuesRef.current) {
                    updates[action.target_field_id] = originalValuesRef.current[action.target_field_id];
                  }
                } else if (newValue !== formValues[action.target_field_id]) {
                  updates[action.target_field_id] = newValue;
                }
              }
            }
          }
        }
      }
      else if ((rule.rule_type || rule.action) === 'set_value' && rule.target_field_id) {
        const ruleKey = `legacy_${rule.id}`;
        
        if (conditionMet) {
          nowActiveActions.add(ruleKey);
          
          if (!activeFieldTargets.has(rule.target_field_id)) {
            activeFieldTargets.set(rule.target_field_id, new Set());
          }
          activeFieldTargets.get(rule.target_field_id).add(ruleKey);
          
          if (!activeSetValueActionsRef.current.has(ruleKey)) {
            if (!(rule.target_field_id in originalValuesRef.current)) {
              originalValuesRef.current[rule.target_field_id] = formValues[rule.target_field_id] ?? '';
            }
            
            const valueToSet = coerceValueForField(computeLegacySetValue(rule), rule.target_field_id);
            if (valueToSet !== null && valueToSet !== undefined) {
              updates[rule.target_field_id] = valueToSet;
            }
          }
          else if ((rule.set_value_source || 'static') === 'field' && rule.set_value_field_id) {
            const displayName = resolveDisplayNameCopyValue({
              action: rule,
              fields: form?.fields,
              values: formValues,
              optionStates: recordSelectionOptionStates,
            });
            const sourceValue = coerceValueForField(
              displayName ? displayName.value : formValues[rule.set_value_field_id],
              rule.target_field_id,
            );
            const currentTargetValue = formValues[rule.target_field_id];
            if (sourceValue !== currentTargetValue && sourceValue !== null && sourceValue !== undefined) {
              updates[rule.target_field_id] = sourceValue;
            }
          }
          else if ((rule.set_value_source || 'static') === 'prefill') {
            const newValue = coerceValueForField(
              computeLegacySetValue(rule),
              rule.target_field_id,
            );
            if (newValue === null || newValue === undefined) {
              if (rule.target_field_id in originalValuesRef.current) {
                updates[rule.target_field_id] = originalValuesRef.current[rule.target_field_id];
              }
            } else if (newValue !== formValues[rule.target_field_id]) {
              updates[rule.target_field_id] = newValue;
            }
          }
        }
      }
    }
    
    for (const actionKey of activeSetValueActionsRef.current) {
      if (!nowActiveActions.has(actionKey)) {
        for (const rule of form.visibility_rules) {
          if (rule.actions && Array.isArray(rule.actions)) {
            for (const action of rule.actions) {
              if (action.id === actionKey && action.target_field_id) {
                const targetFieldId = action.target_field_id;
                const activeActionsForField = activeFieldTargets.get(targetFieldId);
                if (!activeActionsForField || activeActionsForField.size === 0) {
                  if (targetFieldId in originalValuesRef.current) {
                    updates[targetFieldId] = originalValuesRef.current[targetFieldId];
                    delete originalValuesRef.current[targetFieldId];
                  }
                }
              }
            }
          }
          else if (`legacy_${rule.id}` === actionKey && rule.target_field_id) {
            const targetFieldId = rule.target_field_id;
            const activeActionsForField = activeFieldTargets.get(targetFieldId);
            if (!activeActionsForField || activeActionsForField.size === 0) {
              if (targetFieldId in originalValuesRef.current) {
                updates[targetFieldId] = originalValuesRef.current[targetFieldId];
                delete originalValuesRef.current[targetFieldId];
              }
            }
          }
        }
      }
    }
    
    activeSetValueActionsRef.current = nowActiveActions;
    
    if (Object.keys(updates).length > 0) {
      setFormValues(prev => ({ ...prev, ...updates }));
    }
  }, [form?.visibility_rules, form?.prefill_source, formValues, recordSelectionOptionStates, emptyRelationshipParentValues, conditionalPrefillValues]);

  const { getIdempotencyKey, rotateIdempotencyKey } = useSubmissionIdempotencyKey();

  const submitFormMutation = useMutation({
    mutationFn: async (submissionData) => {
      const result = await publicClient.submitForm({
        ...submissionData,
        idempotency_key: getIdempotencyKey(),
        // Preserve the existing explicit-URL-only prefill mapping.
        prefill_organization_id: urlPrefillOrgId || null
      });
      if (departmentCurrentSet.active && !currentSetCommitConfirmed(result)) {
        throw new Error('Current Department data has not been confirmed as saved. Retry or reload and review it before continuing.');
      }
      return result;
    },
    onSuccess: async () => {
      rotateIdempotencyKey();
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
      let message = error?.message || 'Failed to submit form';
      const apiPrefix = message.match(/^Public API Error \(\d+\):\s*/);
      if (apiPrefix) {
        message = message.slice(apiPrefix[0].length);
      }
      setSubmissionError(message);
    }
  });

  // For card swipe layout
  const visibleFields = useMemo(() => {
    return filterVisibleFields(form?.fields || []);
  }, [form?.fields, hiddenFieldIds, emptyRepeatableFieldIds]);

  // Conditional-logic submit control (Task #3474/#3483): shared evaluator
  // with FormView and the server-side enforcement.
  const submitControl = useMemo(
    () => resolveSubmitControl(form?.visibility_rules, conditionFormValues, { lmicCodes: form?.lmic_country_codes }),
    [form?.visibility_rules, conditionFormValues, form?.lmic_country_codes]
  );

  // Task #3483: generic Payment field — when visible, the payment step
  // replaces the plain Submit button.
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
    prefillOrganizationId: urlPrefillOrgId || null,
    enabled: !!visiblePaymentField,
  });

  // Reuse the same page projection used by FormView/IEditFormElement. The
  // local `pages` projection below additionally supports legacy page_break
  // fields used by older embedded forms.
  const { visiblePages } = getFormPagination({
    form,
    formValues,
    hiddenPageIds,
    currentPageIndex,
    setCurrentPageIndex,
    filterVisibleFields,
    toast,
  });

  // For standard layout with pages
  const pages = useMemo(() => {
    if (!form?.fields) return [];
    
    // If form has explicit pages array, use that
    if (formPages.length > 0) {
      return visiblePages.map((page, pageIndex) => {
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
      } else if (!hiddenFieldIds.has(field.id) && !emptyRepeatableFieldIds.has(field.id)) {
        currentPage.fields.push(field);
      }
    }
    
    if (currentPage.fields.length > 0) {
      result.push(currentPage);
    }
    
    return result;
  }, [form?.fields, formPages, visiblePages, hiddenFieldIds, emptyRepeatableFieldIds]);

  const isMultiPage = pages.length > 1;
  const currentPageFields = pages[currentPageIndex]?.fields || [];
  const currentPageTitle = pages[currentPageIndex]?.title;

  // Only Next/Previous arm this signal, never initial load, conditional page
  // clamping, or a form-to-form transition. Send it after React commits the page.
  useEffect(() => {
    const pending = pendingPageNavigationRef.current;
    pendingPageNavigationRef.current = null;
    if (pending && pending.formId === form?.id && pending.index === currentPageIndex) {
      onPageNavigation();
    }
  }, [form?.id, currentPageIndex, onPageNavigation]);

  // A rule can hide/re-show a page while the respondent is on a later page.
  // Keep the index inside the projected visible page list without touching
  // any answers.
  useEffect(() => {
    if (pages.length > 0 && currentPageIndex >= pages.length) {
      setCurrentPageIndex(Math.max(0, pages.length - 1));
    }
  }, [pages.length, currentPageIndex]);

  const validateCurrentPage = () => {
    const fieldsToValidate = form?.layout_type === 'card_swipe' 
      ? [visibleFields[currentStep]]
      : currentPageFields;
    
    for (const field of fieldsToValidate) {
      if (!field) continue;
      const value = formValues[field.id];
      if ((field.is_required || field.required) && !isFieldValueFilled(field, value)) {
        return false;
      }
      if (validateFutureDateFields([field], formValues, {
        now: new Date(),
        hiddenFieldIds: effectiveHiddenFieldIds,
      }).length > 0) {
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
        pendingPageNavigationRef.current = { formId: form.id, index: currentPageIndex + 1 };
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
        pendingPageNavigationRef.current = { formId: form.id, index: currentPageIndex - 1 };
        setCurrentPageIndex(prev => prev - 1);
        notifyParentResize();
      }
    }
  };

  // Task #3483: all pre-submit validation + payload assembly, shared by the
  // normal submit path and the payment step. Returns the payload or null.
  const buildSubmissionPayload = async () => {
    if (departmentCurrentSetBlocked) {
      setSubmissionError(departmentCurrentSetBlocked);
      toast.error(departmentCurrentSetBlocked);
      return null;
    }
    if (displayNameCopyIssues.length) {
      toast.error('A selected record name is still loading or is no longer available. Please wait or choose another record.');
      return null;
    }
    if (submitControl.disabled) {
      if (submitControl.message) toast.error(submitControl.message);
      return null;
    }
    if (!validateCurrentPage()) {
      toast.error('Please fill in all required fields correctly');
      return null;
    }

    const futureDateErrors = validateFutureDateFields(
      form.fields || [],
      formValues,
      { now: new Date(), hiddenFieldIds: effectiveHiddenFieldIds },
    );
    if (futureDateErrors.length > 0) {
      const labelsById = new Map((form.fields || []).map(field => [field.id, field.label || 'Date field']));
      const messages = futureDateErrors.map(error => {
        const label = labelsById.get(error.field_id) || 'Date field';
        const childLabel = error.child_id
          ? (form.fields || [])
            .find(field => field.id === error.field_id)
            ?.children?.find(child => child.id === error.child_id)?.label
          : null;
        return `${childLabel ? `${label} — ${childLabel}` : label}: ${error.message}`;
      });
      setSubmissionError(messages.join('\n'));
      toast.error(`Please fix future-date errors: ${messages.join(', ')}`);
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
        console.error('[EmbedForm] Uniqueness validation error:', error);
        toast.error('Unable to validate form. Please try again.');
        return null;
      }
    }

    // Exclude display-only fields (instructions/image) from the submission.
    // Conditional logic can write rich-text HTML into an instructions field's
    // live value to override its displayed content; that must never be persisted
    // as an answer.
    const displayOnlyFieldIds = new Set(
      (form.fields || []).filter(f => f.type === 'instructions' || f.type === 'image').map(f => f.id)
    );
    const filteredFormValues = pruneFormNotListedText(form.fields, Object.fromEntries(
      Object.entries(formValues).filter(([key]) => (
        !displayOnlyFieldIds.has(key)
      ))
    ));
    const currentSetMetadata = currentSetSubmissionMetadata({
      form,
      departmentId: departmentCurrentSet.departmentId,
      currentSet: departmentCurrentSet.currentSet,
      acknowledgements: departmentCurrentSet.acknowledgements,
    });

    // Match FormView submission structure exactly
    return {
      form_id: form.id,
      form_name: form.name,
      submission_data: {
        ...filteredFormValues,
        ...(currentSetMetadata && {
          [departmentCurrentSet.sectionIds.workforce]: formValues[departmentCurrentSet.sectionIds.workforce],
          [departmentCurrentSet.sectionIds.equipment]: formValues[departmentCurrentSet.sectionIds.equipment],
        }),
        ...(currentSetMetadata && { __department_current_set: currentSetMetadata }),
      }
    };
  };

  const handleSubmit = async () => {
    const payload = await buildSubmissionPayload();
    if (payload) submitFormMutation.mutate(payload);
  };

  useEffect(() => {
    notifyParentResize();
  }, [form, currentPageIndex, currentStep, submitted, hiddenFieldIds, hiddenPageIds]);

  // Canvas Builder "Form embed" block lets authors choose one tenant font +
  // base text size for the whole embedded form. They arrive as `font` (a full
  // CSS font-family string) and `fontSize` (px) query params. This route renders
  // standalone (outside PublicLayout/Layout), so the global tenant font
  // injection never runs here — we must load the chosen font ourselves before
  // the font-family can take effect, otherwise it silently falls back.
  useEffect(() => {
    if (!fontFamilyParam) return;
    const primary = fontFamilyParam.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (!primary) return;
    const SYSTEM_FONTS = new Set([
      'arial', 'helvetica', 'georgia', 'times new roman', 'times', 'verdana',
      'courier new', 'courier', 'serif', 'sans-serif', 'monospace',
    ]);
    const lower = primary.toLowerCase();
    const injected = [];
    if (lower === 'degular medium') {
      // Tenant-hosted font (same source PublicLayout/BarePublicLayout use).
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-embed-font', 'degular-medium');
      styleEl.textContent = `@font-face { font-family: 'Degular Medium'; src: url('https://teeone.pythonanywhere.com/font-assets/Degular-Medium.woff') format('woff'); font-weight: 500; font-style: normal; font-display: swap; }`;
      document.head.appendChild(styleEl);
      injected.push(styleEl);
    } else if (!SYSTEM_FONTS.has(lower)) {
      // Assume a Google Font (Poppins, Urbanist, …). Request common weights so
      // the form's headings, labels, and body all render in the chosen family.
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-embed-font', 'google');
      link.href = `https://fonts.googleapis.com/css2?family=${primary.replace(/ /g, '+')}:wght@300;400;500;600;700&display=swap`;
      document.head.appendChild(link);
      injected.push(link);
    }
    // Apply the family to the whole document so every form element inherits it.
    const prevBodyFont = document.body.style.fontFamily;
    document.body.style.fontFamily = fontFamilyParam;
    notifyParentResize();
    return () => {
      injected.forEach((el) => el.remove());
      document.body.style.fontFamily = prevBodyFont;
    };
  }, [fontFamilyParam]);

  // Base text size: scale the root font-size so the form's rem-based
  // typography (Tailwind text-* utilities) scales coherently. Standalone
  // document, so this is isolated to the embed iframe.
  useEffect(() => {
    const size = Number(fontSizeParam);
    if (!Number.isFinite(size) || size <= 0) return;
    const prevRootSize = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = `${size}px`;
    notifyParentResize();
    return () => {
      document.documentElement.style.fontSize = prevRootSize;
    };
  }, [fontSizeParam]);

  // The return leg is scoped to an existing server-created submission, so it
  // must remain visible even if this public form is now missing or restricted.
  if (paymentReturn.active) {
    return (
      <>
      <CommittedOutcomeNavigation
        onReady={onOutcomeNavigation}
        messageType={!inlineCompletionRef.current && returnedPaymentRef.current ? PAYMENT_RETURN_READY_MESSAGE : undefined}
        enabled={(returnedPaymentRef.current || inlineCompletionRef.current) && (
          paymentReturn.status === 'paid' || paymentReturn.presentationAccepted
          || paymentReturn.setupAccepted || paymentReturn.directDebitCompleted
        )}
      />
      <FormPaymentReturnScreen
        embedded
        status={paymentReturn.status}
        provider={paymentReturn.provider}
         paymentProvider={paymentReturn.paymentProvider}
         setupAccepted={paymentReturn.setupAccepted}
         paymentCollected={paymentReturn.paymentCollected}
        presentationAccepted={paymentReturn.presentationAccepted}
        error={paymentReturn.error}
        successMessage={form ? surveySuccessMessage(form) : null}
        onReturnToForm={paymentReturn.dismiss}
        onRecheck={paymentReturn.recheck}
        canRecheck={paymentReturn.canRecheck}
        pollingPaused={paymentReturn.pollingPaused}
        // A same-origin Canvas parent is navigated only by this explicit user
        // click and only to its resolved tenant/microsite home. External
        // embeds open the tenant destination separately instead of replacing
        // the host page or nesting a full public shell in the iframe.
        continueHref={paymentContinue.destination}
        continueLabel="Continue to site"
        onContinue={paymentContinue.mayNavigateParent ? continuePaymentReturn : undefined}
        continueTarget={isFramed ? '_blank' : undefined}
        continueRel={isFramed ? 'noopener noreferrer' : undefined}
      />
      </>
    );
  }

  if (authMemberLoading || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (transitionError) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-transition-error">
        <Card className="w-full max-w-md border-red-200">
          <CardContent className="pt-6 text-center">
            <p className="font-medium text-slate-900">This form could not continue</p>
            <p className="mt-2 text-sm text-muted-foreground">{transitionError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (formAccess.restricted) {
    return (
      <FormAccessRestriction
        form={accessPayload}
        isAuthenticated={!!authMember}
        framed={isFramed}
        standalone={!isFramed}
      />
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

  // Task #3364: never render the preview-shape form for anonymous visitors —
  // top windows are redirected to login (effect above); framed embeds show a
  // login prompt whose link navigates the TOP window and returns to the
  // embedding page after login.
  if (form.require_authentication && !authMember) {
    if (authMemberLoading) {
      return (
        <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-loading">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (!isFramed) {
      // Redirecting to /login (effect above) — transient state.
      return (
        <div className="flex flex-col items-center justify-center gap-2 min-h-[200px] p-4" data-testid="embed-form-auth-redirect">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Redirecting to login…</p>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-auth-required">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-3">
            <Lock className="h-8 w-8 text-slate-400 mx-auto" aria-hidden="true" />
            <p className="font-medium text-slate-800">Log in to access this form</p>
            <p className="text-sm text-muted-foreground">
              {form.name ? `“${form.name}” requires you to be logged in.` : 'This form requires you to be logged in.'}
            </p>
            <Button asChild className="w-full" data-testid="button-embed-form-login">
              <a href={loginHref} target="_top">Log in to continue</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-form-success">
        <CommittedOutcomeNavigation onReady={onOutcomeNavigation} />
        <Toaster />
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Thank You!</h3>
            <p className="text-muted-foreground">
              {surveySuccessMessage(form) || 'Your submission has been received.'}
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
    const isLastStep = visibleFields.length === 0
      || currentStep === visibleFields.length - 1;
    const hasValue = formValues[currentField?.id];
    const isFormatValid = fieldValidity[currentField?.id] !== false;
    const canProceed = !currentField
      || ((!(currentField.is_required || currentField.required) || hasValue) && isFormatValid);

    return (
      <FormTransitionOverlay active={isTransitioning}>
      <div className="p-4" data-testid="embed-form-container">
        <Toaster />
        <Card className="w-full min-w-0 mx-auto" style={{ maxWidth: getFormMaxWidth(form.form_width) }} data-testid="form-width-container">
          <CardHeader>
            <CardTitle data-testid="embed-form-title">{form.name}</CardTitle>
            {form.description && (
              <CardDescription data-testid="embed-form-description">{form.description}</CardDescription>
            )}
            <div className="mt-3">
              <DepartmentCurrentSetNotice state={departmentCurrentSet} blockedReason={departmentCurrentSetBlocked} />
            </div>
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
            {hiddenRepeatableFields.map(hiddenField => (
              <RepeatableAvailabilityProbe
                key={`empty-probe-${hiddenField.id}`}
                field={hiddenField}
                value={formValues[hiddenField.id]}
                onChange={value => handleFieldChange(hiddenField.id, value)}
                onFormNotListedTextChange={text => handleFormNotListedTextChange(hiddenField.id, text)}
                onValidityChange={() => {}}
                onRelationshipEmptyStateChange={handleRelationshipEmptyStateChange}
                onRecordSelectionOptionsChange={handleRecordSelectionOptionsChange}
                onRepeatableVisibilityChange={handleRepeatableVisibilityChange}
                disabled={false}
                formId={form?.id}
                formSlug={form?.slug}
                allFormValues={formValues}
                currentSetOptionLabels={departmentCurrentSet.currentSet.optionLabels}
                currentSetExistingBlankFieldsByRow={hiddenField.id === departmentCurrentSet.sectionIds.equipment ? departmentCurrentSet.existingBlankRequiredFieldsByRow : null}
                allFields={form?.fields || []}
                rootAllFields={form?.fields || []}
                rootAllFormValues={formValues}
                hiddenFieldIds={effectiveHiddenFieldIds}
                membershipFeeQuote={membershipFeeQuote}
              />
            ))}
            {currentField && (
              <FormRenderer
                key={currentStep}
                field={currentField}
                value={formValues[currentField.id]}
                onChange={(value) => {
                  handleFieldChange(currentField.id, value);
                }}
                onFormNotListedTextChange={(text) => handleFormNotListedTextChange(currentField.id, text)}
                onValidityChange={handleValidityChange}
                onRelationshipEmptyStateChange={handleRelationshipEmptyStateChange}
                onRecordSelectionOptionsChange={handleRecordSelectionOptionsChange}
                 onRepeatableVisibilityChange={handleRepeatableVisibilityChange}
                disabled={false}
                autoFocus={cardSwipeAutoFocusFor(currentField.type)}
                formId={form?.id}
                formSlug={form?.slug}
                allFormValues={formValues}
                currentSetOptionLabels={departmentCurrentSet.currentSet.optionLabels}
                currentSetExistingBlankFieldsByRow={currentField.id === departmentCurrentSet.sectionIds.equipment ? departmentCurrentSet.existingBlankRequiredFieldsByRow : null}
                allFields={form?.fields || []}
                rootAllFields={form?.fields || []}
                rootAllFormValues={formValues}
                hiddenFieldIds={effectiveHiddenFieldIds}
                membershipFeeQuote={membershipFeeQuote}
              />
            )}
          </CardContent>
          <div className="p-6 pt-0 flex flex-col gap-2">
            {!canProceed && currentField && (
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
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={currentStep === 0 ? returnToPreviousForm : handlePrevious}
                disabled={currentStep === 0 && !canReturnToPreviousForm}
                data-testid={currentStep === 0 && canReturnToPreviousForm
                  ? 'button-return-to-source-form'
                  : 'button-previous-step'}
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                {currentStep === 0 && canReturnToPreviousForm ? 'Back to previous form' : 'Previous'}
              </Button>
              {isLastStep ? (
                visiblePaymentField ? (
                  <FormPaymentSubmit
                    field={visiblePaymentField}
                    formValues={formValues}
                    buildPayload={buildSubmissionPayload}
                    idempotencyKey={getIdempotencyKey()}
                    disabled={!canProceed || submitControl.disabled || !!departmentCurrentSetBlocked}
                    disabledMessage={departmentCurrentSetBlocked || submitControl.message}
                    busy={submitFormMutation.isPending}
                    onPaid={() => { rotateIdempotencyKey(); setSubmitted(true); notifyParentResize(); }}
                    onPaymentAccepted={({ submissionId, provider, status, paymentSucceeded }) => {
                      inlineCompletionRef.current = true;
                      rotateIdempotencyKey();
                      paymentReturn.adoptPaymentAcceptance({
                        submissionId, provider, status, paymentSucceeded,
                      });
                      notifyParentResize();
                    }}
                    onSetupComplete={(setup) => {
                      inlineCompletionRef.current = true;
                      rotateIdempotencyKey();
                      paymentReturn.adoptCompletion(
                        typeof setup === 'string'
                          ? { submissionId: setup, provider: 'gocardless' }
                          : setup,
                      );
                      notifyParentResize();
                    }}
                    onNormalSubmit={handleSubmit}
                    submitLabel={form.submit_button_text || 'Submit'}
                    membershipQuote={membershipFeeQuote}
                    continueHref={paymentContinue.destination}
                    continueLabel="Continue to site"
                    onContinue={paymentContinue.mayNavigateParent ? continuePaymentReturn : undefined}
                    continueTarget={isFramed ? '_blank' : undefined}
                    continueRel={isFramed ? 'noopener noreferrer' : undefined}
                  />
                ) : (
                <Button
                  onClick={handleSubmit}
                  disabled={!canProceed || submitControl.disabled || !!departmentCurrentSetBlocked || submitFormMutation.isPending}
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
                )
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
      </FormTransitionOverlay>
    );
  }

  // Standard Layout
  return (
    <FormTransitionOverlay active={isTransitioning}>
    <div className="p-4" data-testid="embed-form-container">
      <Toaster />
      <Card className="w-full min-w-0 mx-auto" style={{ maxWidth: getFormMaxWidth(form.form_width) }} data-testid="form-width-container">
        <CardHeader>
          <CardTitle data-testid="embed-form-title">{form.name}</CardTitle>
          {form.description && (
            <CardDescription data-testid="embed-form-description">{form.description}</CardDescription>
          )}
          <div className="mt-3">
            <DepartmentCurrentSetNotice state={departmentCurrentSet} blockedReason={departmentCurrentSetBlocked} />
          </div>
          {surveyIntroText(form) && (
            <p className="text-sm text-slate-600 whitespace-pre-line mt-2" data-testid="survey-intro-text">{surveyIntroText(form)}</p>
          )}
          {showSurveyProgress(form) && (() => {
            const progress = surveyProgress(form, effectiveHiddenFieldIds, formValues);
            return (
              <div className="mt-3" data-testid="survey-progress" role="progressbar" aria-valuenow={progress.answered} aria-valuemin={0} aria-valuemax={progress.total} aria-label="Survey progress">
                <div className="flex items-center justify-between mb-1 text-xs text-muted-foreground">
                  <span>Progress</span>
                  <span>{progress.answered} of {progress.total} answered</span>
                </div>
                <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${progress.pct}%` }} />
                </div>
              </div>
            );
          })()}
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
          {hiddenRepeatableFields.map(hiddenField => (
            <RepeatableAvailabilityProbe
              key={`empty-probe-${hiddenField.id}`}
              field={hiddenField}
              value={formValues[hiddenField.id]}
              onChange={value => handleFieldChange(hiddenField.id, value)}
              onFormNotListedTextChange={text => handleFormNotListedTextChange(hiddenField.id, text)}
              onValidityChange={() => {}}
              onRelationshipEmptyStateChange={handleRelationshipEmptyStateChange}
              onRecordSelectionOptionsChange={handleRecordSelectionOptionsChange}
              onRepeatableVisibilityChange={handleRepeatableVisibilityChange}
              disabled={false}
              formId={form?.id}
              formSlug={form?.slug}
              allFormValues={formValues}
              currentSetOptionLabels={departmentCurrentSet.currentSet.optionLabels}
              currentSetExistingBlankFieldsByRow={hiddenField.id === departmentCurrentSet.sectionIds.equipment ? departmentCurrentSet.existingBlankRequiredFieldsByRow : null}
              allFields={form?.fields || []}
              rootAllFields={form?.fields || []}
              rootAllFormValues={formValues}
              hiddenFieldIds={effectiveHiddenFieldIds}
              membershipFeeQuote={membershipFeeQuote}
            />
          ))}
          <div className="space-y-4">
            {currentPageFields.map(field => (
              <FormRenderer
                key={field.id}
                field={field}
                value={formValues[field.id]}
                onChange={(value) => handleFieldChange(field.id, value)}
                onFormNotListedTextChange={(text) => handleFormNotListedTextChange(field.id, text)}
                onValidityChange={handleValidityChange}
                onRelationshipEmptyStateChange={handleRelationshipEmptyStateChange}
                onRecordSelectionOptionsChange={handleRecordSelectionOptionsChange}
                onRepeatableVisibilityChange={handleRepeatableVisibilityChange}
                disabled={false}
                formId={form?.id}
                formSlug={form?.slug}
                allFormValues={formValues}
                currentSetOptionLabels={departmentCurrentSet.currentSet.optionLabels}
                currentSetExistingBlankFieldsByRow={field.id === departmentCurrentSet.sectionIds.equipment ? departmentCurrentSet.existingBlankRequiredFieldsByRow : null}
                allFields={form?.fields || []}
                rootAllFields={form?.fields || []}
                rootAllFormValues={formValues}
                hiddenFieldIds={effectiveHiddenFieldIds}
                membershipFeeQuote={membershipFeeQuote}
              />
            ))}
          </div>

          {/* Submission error display */}
          {submissionError && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md" data-testid="submission-error">
              <p className="text-sm text-red-700">{submissionError}</p>
            </div>
          )}

          <div className="mt-6 space-y-5" data-testid="embed-form-final-actions">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {isMultiPage && currentPageIndex > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePrevious}
                  className="w-full sm:w-auto"
                  data-testid="button-previous-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
              ) : canReturnToPreviousForm ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    returnToPreviousForm();
                    notifyParentResize();
                  }}
                  className="w-full sm:w-auto"
                  data-testid="button-return-to-source-form"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Back to previous form
                </Button>
              ) : (
                <div />
              )}

              {isMultiPage && currentPageIndex < pages.length - 1 ? (
                <Button
                  type="button"
                  onClick={handleNext}
                  className="w-full sm:w-auto"
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              ) : !visiblePaymentField ? (
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitControl.disabled || !!departmentCurrentSetBlocked || submitFormMutation.isPending}
                  className="w-full sm:w-auto"
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
              ) : null}
            </div>
            {currentPageIndex >= pages.length - 1 && visiblePaymentField && (
              <div className="w-full border-t pt-5" data-testid="embed-form-payment-area">
              <FormPaymentSubmit
                field={visiblePaymentField}
                formValues={formValues}
                buildPayload={buildSubmissionPayload}
                idempotencyKey={getIdempotencyKey()}
                disabled={submitControl.disabled || !!departmentCurrentSetBlocked}
                disabledMessage={departmentCurrentSetBlocked || submitControl.message}
                busy={submitFormMutation.isPending}
                onPaid={() => { rotateIdempotencyKey(); setSubmitted(true); notifyParentResize(); }}
                onPaymentAccepted={({ submissionId, provider, status, paymentSucceeded }) => {
                  inlineCompletionRef.current = true;
                  rotateIdempotencyKey();
                  paymentReturn.adoptPaymentAcceptance({
                    submissionId, provider, status, paymentSucceeded,
                  });
                  notifyParentResize();
                }}
                onSetupComplete={(setup) => {
                  inlineCompletionRef.current = true;
                  rotateIdempotencyKey();
                  paymentReturn.adoptCompletion(
                    typeof setup === 'string'
                      ? { submissionId: setup, provider: 'gocardless' }
                      : setup,
                  );
                  notifyParentResize();
                }}
                onNormalSubmit={handleSubmit}
                submitLabel={form.submit_button_text || 'Submit'}
                membershipQuote={membershipFeeQuote}
                continueHref={paymentContinue.destination}
                continueLabel="Continue to site"
                onContinue={paymentContinue.mayNavigateParent ? continuePaymentReturn : undefined}
                continueTarget={isFramed ? '_blank' : undefined}
                continueRel={isFramed ? 'noopener noreferrer' : undefined}
              />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
    </FormTransitionOverlay>
  );
}

import { useState, useEffect, useRef, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, CheckCircle2, CreditCard, AlertCircle, Info, Landmark } from "lucide-react";
import DirectDebitPlanCard from "@/components/membership/DirectDebitPlanCard";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";
import { directDebitFirstCollectionText, directDebitPolicyText, directDebitHasFixedTermTotal } from "@/lib/directDebitConsentSummary";
import MembershipCommitmentNotice, { membershipTermLabel } from "@/components/membership/MembershipCommitmentNotice";
import RenewalMethodChooser from "./RenewalMethodChooser";

function renewalOptions(data) {
  if (!data?.membershipYear || data.approvalPending || data.zeroDue) return [];
  return [
    data.stripeEnabled && !isBelowStripeMinimum(data.totalWithVat ?? data.finalCost, data.currency)
      && { id: 'upfront', label: 'Pay in full by card', price: formatCurrency(data.totalWithVat ?? data.finalCost, data.currency) },
    data.cardMonthly && { id: 'monthly_card', label: 'Pay monthly by card', price: `${formatCurrency(data.cardMonthly.monthlyAmount, data.cardMonthly.currency || data.currency)}/month` },
    data.directDebit && { id: 'direct_debit', label: 'Pay monthly by Direct Debit', price: `${formatCurrency(data.directDebit.monthlyAmount, data.directDebit.currency || data.currency)}/month` },
  ].filter(Boolean);
}

const CURRENCY_SYMBOLS = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

// Calendar dates must not shift with the viewer's timezone.
function formatMembershipDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : (value || 'not available');
}

function formatCurrency(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

function isBelowStripeMinimum(amount, currency) {
  const min = STRIPE_MINIMUMS[currency] || 0.50;
  return parseFloat(amount || 0) < min;
}

export default function MembershipPaymentField({ value, onChange, disabled, field, allFormValues = {}, resolvedMemberId = null, formId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [paymentMode, setPaymentMode] = useState(null);
  const [creatingPayment, setCreatingPayment] = useState(false);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [switchingPayment, setSwitchingPayment] = useState(false);
  const switchInFlight = useRef(false);
  const actionInFlight = useRef(false);
  const [chosenMethod, setChosenMethod] = useState(null);
  const [busyMethod, setBusyMethod] = useState(null);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [paymentYear, setPaymentYear] = useState(null);
  const [paymentTerm, setPaymentTerm] = useState(null);
  const [startingDd, setStartingDd] = useState(false);
  const [ddStarted, setDdStarted] = useState(false);
  const [hasDdPlan, setHasDdPlan] = useState(false);
  const [hasCardPlan, setHasCardPlan] = useState(false);
  const [startingCard, setStartingCard] = useState(false);
  const [ddPayerChoice, setDdPayerChoice] = useState('self');
  const [billingContactEmail, setBillingContactEmail] = useState('');
  const [billingContactName, setBillingContactName] = useState('');
  const [ddInviteSent, setDdInviteSent] = useState(false);
  // GoCardless Drop-in modal state: { flowId, environment, authorisationUrl }
  const [ddDropin, setDdDropin] = useState(null);
  const [ddModalDone, setDdModalDone] = useState(false);

  const cardRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const redirectHandled = useRef(false);
  const prevOverridesRef = useRef('');
  const quoteKeyRef = useRef(null);

  const memberId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    // An explicit (even empty/invalid) target must never fall back to self.
    return params.has('member_id') ? params.get('member_id') : resolvedMemberId;
  }, [resolvedMemberId]);

  const buildFieldOverrides = () => {
    const mappings = field.field_mappings;
    if (!mappings || typeof mappings !== 'object') return {};
    const overrides = {};
    for (const [dbFieldId, formFieldId] of Object.entries(mappings)) {
      if (formFieldId && allFormValues[formFieldId] !== undefined && allFormValues[formFieldId] !== null && allFormValues[formFieldId] !== '') {
        overrides[dbFieldId] = allFormValues[formFieldId];
      }
    }
    return overrides;
  };

  const buildOverrideParams = () => {
    const overrides = buildFieldOverrides();
    const params = [];
    if (formId && field.id) {
      params.push(`formId=${encodeURIComponent(formId)}`, `paymentFieldId=${encodeURIComponent(field.id)}`);
    }
    const answer = allFormValues[field.membership_schedule_mapping?.source_field_id];
    if (typeof answer === 'string') params.push(`renewalScheduleAnswer=${encodeURIComponent(answer)}`);
    if (Object.keys(overrides).length > 0) {
      params.push(`fieldOverrides=${encodeURIComponent(JSON.stringify(overrides))}`);
    }
    if (field.membership_config_id) {
      params.push(`configId=${encodeURIComponent(field.membership_config_id)}`);
    }
    return params.length > 0 ? '&' + params.join('&') : '';
  };

  const getOverrideBody = () => {
    const overrides = buildFieldOverrides();
    const body = {};
    if (formId && field.id) Object.assign(body, { formId, paymentFieldId: field.id });
    const answer = allFormValues[field.membership_schedule_mapping?.source_field_id];
    if (typeof answer === 'string') body.renewalScheduleAnswer = answer;
    if (Object.keys(overrides).length > 0) body.fieldOverrides = overrides;
    if (field.membership_config_id) body.configId = field.membership_config_id;
    return body;
  };

  const pendingRefetchRef = useRef(false);
  const fetchInProgressRef = useRef(false);
  const feeRequestRef = useRef(0);
  const latestFetchFeesRef = useRef(null);

  useEffect(() => {
    setPaymentComplete(false);
    setPaymentMode(null);
    setChosenMethod(null);
    setPaymentTerm(null);
    setPaymentYear(null);
    setHasDdPlan(false);
    setHasCardPlan(false);
    setDdStarted(false);
    quoteKeyRef.current = null;
    if (!memberId) {
      setLoading(false);
      return;
    }
    fetchFees();
    return () => { feeRequestRef.current += 1; };
  }, [memberId, field.membership_config_id]);

  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    fetch(`/api/membership/payment-plan?memberId=${encodeURIComponent(memberId)}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return;
        const plan = json?.currentPlan;
        if (plan && !['cancelled', 'completed'].includes(plan.status)) {
          if (plan.provider === 'stripe') setHasCardPlan(true);
          else setHasDdPlan(true);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [memberId, ddStarted]);

  useEffect(() => {
    if (!memberId || paymentComplete || paymentMode) return;
    const mappings = field.field_mappings;
    if ((!mappings || Object.keys(mappings).length === 0) && !field.membership_schedule_mapping) return;
    const overrides = buildFieldOverrides();
    const overridesKey = JSON.stringify([overrides, allFormValues[field.membership_schedule_mapping?.source_field_id]]);
    if (overridesKey === prevOverridesRef.current) return;
    prevOverridesRef.current = overridesKey;
    // Do not allow checkout against the previous class during the debounce.
    setLoading(true);
    if (fetchInProgressRef.current) {
      pendingRefetchRef.current = true;
      return;
    }
    const timer = setTimeout(() => fetchFees(), 500);
    return () => clearTimeout(timer);
  }, [allFormValues, field.field_mappings, field.membership_schedule_mapping, memberId, paymentComplete, paymentMode]);

  const fetchFees = () => {
    const requestId = ++feeRequestRef.current;
    setLoading(true);
    setError(null);
    fetchInProgressRef.current = true;
    pendingRefetchRef.current = false;
    const overrideStr = buildOverrideParams();
    prevOverridesRef.current = JSON.stringify([buildFieldOverrides(), allFormValues[field.membership_schedule_mapping?.source_field_id]]);
    return fetch(`/api/forms/membership-payment?memberId=${encodeURIComponent(memberId)}${overrideStr}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load fee details');
        }
        return res.json();
      })
      .then((result) => {
        if (requestId !== feeRequestRef.current) return;
        const quoteKey = result.renewal?.quoteKey || `${memberId}:${result.membershipYear}:${result.totalWithVat}:${result.existingRecord?.id || ''}`;
        if (quoteKeyRef.current && quoteKeyRef.current !== quoteKey) {
          setPaymentComplete(false);
          setPaymentMode(null);
          setPaymentTerm(null);
          setPaymentYear(null);
          setDdStarted(false);
          setPaymentError(null);
        }
        quoteKeyRef.current = quoteKey;
        setData(result);
        // Access/activation and settlement are independent: an active DD
        // membership can still have outstanding instalments or arrears.
        if (result.existingRecord?.paymentStatus === 'paid'
            && ['active', 'scheduled', 'paid'].includes(result.existingRecord.status)) {
          setPaymentComplete(true);
          if (onChange && !value) {
            onChange({
              status: 'already_paid',
              membershipYear: result.membershipYear,
              existingRecordId: result.existingRecord.id,
            });
          }
        }
        return result;
      })
      .catch((err) => {
        if (requestId === feeRequestRef.current) setError(err.message);
      })
      .finally(() => {
        if (requestId !== feeRequestRef.current) return;
        fetchInProgressRef.current = false;
        setLoading(false);
        if (pendingRefetchRef.current) {
          pendingRefetchRef.current = false;
          latestFetchFeesRef.current();
        }
      });
  };

  latestFetchFeesRef.current = fetchFees;

  useEffect(() => {
    if (redirectHandled.current || !memberId) return;

    const currentUrlParams = new URLSearchParams(window.location.search);
    const paymentIntentFromUrl = currentUrlParams.get('payment_intent');
    const redirectStatus = currentUrlParams.get('redirect_status');

    if (!paymentIntentFromUrl) return;

    redirectHandled.current = true;
    console.log('[MembershipPaymentField] Detected 3D Secure return:', { paymentIntentFromUrl, redirectStatus });

    const cleanParams = new URLSearchParams(currentUrlParams.toString());
    cleanParams.delete('payment_intent');
    cleanParams.delete('payment_intent_client_secret');
    cleanParams.delete('redirect_status');
    const cleanUrl = cleanParams.toString()
      ? `${window.location.pathname}?${cleanParams.toString()}`
      : window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    if (redirectStatus !== 'succeeded') {
      setPaymentError('Payment was not completed. Please try again.');
      return;
    }

    const savedYear = sessionStorage.getItem('pending_form_membership_payment_year');
    let savedOverrides = {};
    try {
      const raw = sessionStorage.getItem('pending_form_membership_field_overrides');
      if (raw) savedOverrides = JSON.parse(raw);
    } catch {}
    const completePayment = async () => {
      setProcessingPayment(true);
      try {
        const confirmRes = await fetch('/api/forms/membership-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action: 'confirm_payment',
            memberId,
            paymentIntentId: paymentIntentFromUrl,
            membershipYear: savedYear,
            ...savedOverrides,
          }),
        });
        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Your card payment was successful, but we could not finish updating your membership record. It will be reconciled automatically — please do NOT pay again.');
        }
        sessionStorage.removeItem('pending_form_membership_payment_year');
        sessionStorage.removeItem('pending_form_membership_field_overrides');
        setPaymentComplete(true);
        if (onChange) {
          onChange({
            status: 'paid',
            paymentIntentId: paymentIntentFromUrl,
            membershipYear: savedYear,
          });
        }
      } catch (err) {
        setPaymentError(err.message);
      } finally {
        setProcessingPayment(false);
      }
    };

    completePayment();
  }, [memberId]);

  useEffect(() => {
    if (paymentComplete && cardRef.current) {
      setTimeout(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [paymentComplete]);

  const initStripe = async () => {
    if (!data?.zeroDue && !data?.stripePublishableKey) return;
    if (!data?.zeroDue && isBelowStripeMinimum(data?.totalWithVat ?? data?.finalCost, data?.currency)) return;
    setCreatingPayment(true);
    setPaymentError(null);

    try {
      const overrideBody = getOverrideBody();
      const res = await fetch('/api/forms/membership-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'create_payment',
          memberId,
          ...overrideBody,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to initialise payment');
      }
      const prepared = await res.json();
      if (prepared.zeroDue) {
        setPaymentComplete(true);
        onChange?.({ status: 'paid', membershipYear: prepared.membershipYear, amount: 0 });
        return;
      }
      const { clientSecret, membershipYear: yr } = prepared;
      setPaymentTerm(prepared);
      if (prepared.renewalElectionId) {
        setData(current => ({ ...current, renewal: { ...current.renewal,
          state: 'renewal_pending', eligible: false, selectedMethod: 'upfront',
          electionId: prepared.renewalElectionId, switchState: 'idle' } }));
      }
      setPaymentYear(yr);
      if (yr) {
        sessionStorage.setItem('pending_form_membership_payment_year', yr);
      }
      if (Object.keys(overrideBody).length > 0) {
        sessionStorage.setItem('pending_form_membership_field_overrides', JSON.stringify(overrideBody));
      }

      if (!window.Stripe) {
        const script = document.createElement('script');
        script.src = 'https://js.stripe.com/v3/';
        script.async = true;
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load Stripe'));
          document.head.appendChild(script);
        });
      }

      const stripe = window.Stripe(data.stripePublishableKey);
      stripeRef.current = stripe;

      const elements = stripe.elements({ clientSecret });
      elementsRef.current = elements;

      const addressElement = elements.create('address', { mode: 'billing' });
      const cardElement = elements.create('payment', {
        fields: { billingDetails: { address: 'never' } },
      });

      setTimeout(() => {
        const addressContainer = document.getElementById(`form-stripe-address-element-${field.id}`);
        const paymentContainer = document.getElementById(`form-stripe-payment-element-${field.id}`);
        if (addressContainer) addressElement.mount(addressContainer);
        if (paymentContainer) cardElement.mount(paymentContainer);
      }, 100);

      setPaymentMode('stripe');
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setCreatingPayment(false);
    }
  };

  const handleStripePayment = async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setProcessingPayment(true);
    setPaymentError(null);

    try {
      const { error: submitError } = await elementsRef.current.submit();
      if (submitError) {
        throw new Error(submitError.message);
      }

      const { error: confirmError, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: {
          return_url: window.location.href,
        },
        redirect: 'if_required',
      });

      if (confirmError) {
        throw new Error(confirmError.message);
      }

      if (paymentIntent?.status === 'succeeded') {
        sessionStorage.removeItem('pending_form_membership_payment_year');
        sessionStorage.removeItem('pending_form_membership_field_overrides');

        const confirmOverrides = getOverrideBody();
        const confirmRes = await fetch('/api/forms/membership-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action: 'confirm_payment',
            memberId,
            paymentIntentId: paymentIntent.id,
            membershipYear: paymentYear || data?.membershipYear,
            ...confirmOverrides,
          }),
        });

        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Your card payment was successful, but we could not finish updating your membership record. It will be reconciled automatically — please do NOT pay again.');
        }

        setPaymentComplete(true);
        if (onChange) {
          onChange({
            status: 'paid',
            paymentIntentId: paymentIntent.id,
            membershipYear: paymentYear || data?.membershipYear,
            amount: data?.totalWithVat || data?.finalCost,
            currency: data?.currency,
          });
        }
      }
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setProcessingPayment(false);
    }
  };

  const releaseUnusedRenewal = async (nextMethod = null) => {
    if (switchInFlight.current || actionInFlight.current || loading || disabled || creatingPayment || processingPayment || startingDd || startingCard) return;
    switchInFlight.current = true;
    setPaymentError(null);
    setSwitchingPayment(true);
    setBusyMethod(nextMethod);
    try {
      const response = await fetch('/api/forms/membership-payment', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change_renewal_payment_method', memberId,
          electionId: data?.renewal?.electionId || paymentTerm?.renewalElectionId }),
      });
      const result = await response.json();
      if (!response.ok || result.released !== true) throw new Error(result.error || 'Cancellation has not been confirmed. Your renewal remains reserved.');
      elementsRef.current?.getElement?.('payment')?.destroy();
      elementsRef.current?.getElement?.('address')?.destroy();
      elementsRef.current = null;
      stripeRef.current = null;
      setPaymentMode(null);
      setChosenMethod(null);
      setPaymentTerm(null);
      setPaymentYear(null);
      setDdStarted(false);
      setHasDdPlan(false);
      setHasCardPlan(false);
      setDdDropin(null);
      setDdInviteSent(false);
      sessionStorage.removeItem('pending_form_membership_payment_year');
      sessionStorage.removeItem('pending_form_membership_field_overrides');
      const refreshed = await fetchFees();
      if (nextMethod) {
        if (refreshed?.renewal?.eligible && renewalOptions(refreshed).some(option => option.id === nextMethod)) {
          setChosenMethod(nextMethod);
        } else {
          setPaymentError('Your previous checkout was cancelled, but this payment option could not be confirmed. Check renewal status before choosing again.');
        }
      }
    } catch (error) {
      await fetchFees();
      setPaymentError(error.message);
    } finally {
      switchInFlight.current = false;
      setSwitchingPayment(false);
      setBusyMethod(null);
    }
  };

  // Ref guards also cover multiple clicks before React has rendered busy state.
  const runPaymentAction = async (action) => {
    if (actionInFlight.current || switchInFlight.current || loading || disabled) return;
    actionInFlight.current = true;
    try { await action(); } finally { actionInFlight.current = false; }
  };

  const chooseRenewalMethod = async (method) => {
    if (actionInFlight.current || switchInFlight.current || loading || disabled || ddDropin) return;
    if (!renewalOptions(data).some(option => option.id === method)) return;
    if (data.renewal?.state === 'renewal_pending' && data.renewal.selectedMethod !== method) {
      await releaseUnusedRenewal(method);
      return;
    }
    setChosenMethod(method);
    setPaymentError(null);
  };

  const startDirectDebit = async () => {
    const isOrgDd = data?.directDebit?.scope === 'organization';
    if (isOrgDd && ddPayerChoice === 'billing_contact' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingContactEmail.trim())) {
      setPaymentError('Please enter a valid billing contact email address.');
      return;
    }
    setStartingDd(true);
    setPaymentError(null);
    try {
      const endpoint = '/api/forms/membership-payment';
      const overrideBody = getOverrideBody();
      const body = isOrgDd
        ? {
            action: 'start_direct_debit',
            memberId,
            ...overrideBody,
            payerChoice: ddPayerChoice,
            ...(ddPayerChoice === 'billing_contact' ? {
              billingContactEmail: billingContactEmail.trim(),
              billingContactName: billingContactName.trim(),
            } : {}),
          }
        : { action: 'start_direct_debit', memberId, ...overrideBody };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to start Direct Debit set-up');
      if (result.authorisationUrl) {
        if (result.flowId) {
          // Open the GoCardless Drop-in modal on-page; the hosted redirect
          // stays as the automatic fallback if the widget fails to load.
          setDdDropin({
            flowId: result.flowId,
            environment: result.environment || 'sandbox',
            authorisationUrl: result.authorisationUrl,
            agreementId: result.agreementId || null,
          });
          return;
        }
        window.location.href = result.authorisationUrl;
        return;
      }
      if (isOrgDd && (result.invitationSent || result.warning)) {
        setDdInviteSent(true);
        setDdStarted(true);
        if (result.warning) setPaymentError(result.warning);
        if (onChange) {
          onChange({ status: 'direct_debit_invitation_sent', membershipYear: data?.membershipYear, agreementId: result.agreementId });
        }
        return;
      }
      setDdStarted(true);
      if (onChange) {
        onChange({ status: 'direct_debit_started', membershipYear: data?.membershipYear, agreementId: result.agreementId });
      }
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setStartingDd(false);
    }
  };

  // Task #3620 — start a monthly card (Stripe subscription) plan; redirects
  // to Stripe-hosted Checkout for card capture.
  const startMonthlyCard = async () => {
    setStartingCard(true);
    setPaymentError(null);
    try {
      const res = await fetch('/api/forms/membership-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'start_monthly_card', memberId, ...getOverrideBody() }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to start monthly card set-up');
      if (result.checkoutUrl) {
        window.top.location.href = result.checkoutUrl;
        return;
      }
      setHasCardPlan(true);
      if (onChange) {
        onChange({ status: 'monthly_card_started', membershipYear: data?.membershipYear, agreementId: result.agreementId });
      }
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setStartingCard(false);
    }
  };

  if (!memberId) {
    return (
      <Card data-testid={`membership-payment-no-member-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Info className="h-4 w-4 shrink-0" />
            <p className="text-sm">Member information is required to display membership fees. Please ensure the form link includes a member_id parameter.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <Card data-testid={`membership-payment-loading-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center gap-2 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading membership fees...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card data-testid={`membership-payment-error-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <p className="text-sm">{error}</p>
            <Button type="button" variant="outline" onClick={fetchFees} disabled={loading}>Check renewal status</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (paymentComplete) {
    return (
      <Card ref={cardRef} data-testid={`membership-payment-complete-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <div className="text-center">
              <p className="font-medium" data-testid="text-payment-success">Membership fee paid</p>
              {(data?.existingRecord?.status === 'scheduled' || data?.renewal?.successorStart) && (
                <p className="text-sm text-muted-foreground" data-testid="text-membership-scheduled">
                  Membership starts on {formatMembershipDate(data?.renewal?.successorStart || data?.existingRecord?.termStart)}.
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {membershipTermLabel(paymentYear || data?.membershipYear)} - {formatCurrency(paymentTerm?.amount ?? data?.totalWithVat ?? data?.finalCost, paymentTerm?.currency || data?.currency)}
              </p>
            </div>
          </div>
          {data?.renewal?.currentAgreementId && (
            <p className="text-sm mt-3">This pays the next term only. Remaining instalments and any arrears for the current term through {formatMembershipDate(data.renewal.currentEnd)} remain due under your existing payment plan.</p>
          )}
          {data?.renewal?.currentAgreementId && <DirectDebitPlanCard memberId={memberId} />}
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const renewal = data.renewal;
  const isRenewal = renewal && renewal.state !== 'joining';
  const resuming = renewal?.state === 'renewal_pending' && renewal?.selectedMethod && data.membershipYear;
  const busy = disabled || loading || switchingPayment || processingPayment || creatingPayment || startingDd || startingCard || !!ddDropin;
  const selectedMethod = renewal?.state === 'renewal_pending' ? renewal.selectedMethod : chosenMethod;
  const canPay = !switchingPayment && renewal?.switchState !== 'reconciling'
    && (!isRenewal || renewal.eligible || resuming);
  const renewalMessages = {
    renewal_not_open: `Renewal opens on ${formatMembershipDate(renewal?.opensOn)}.`,
    renewal_closed: `Online renewal closed on ${formatMembershipDate(renewal?.closesOn)}. Please contact the membership team for help renewing.`,
    renewal_pending: data.membershipYear
      ? 'Choose a payment card below to continue with that method. Choosing a different card safely checks your previous checkout first. If you have already paid, choose “Check renewal status” instead.'
      : 'Check renewal status to recover your payment details. To cancel an unfinished checkout safely, choose “Change payment method”. If you have already paid, do not pay again.',
    next_term_purchased: 'Your next membership term has already been paid for.',
    current_membership: 'We haven’t confirmed full payment for your current membership. Please contact the membership team if you need help.',
    continuing_arrangement: 'Your membership renews automatically with your existing monthly payments. You do not need to renew here.',
    paused: 'Your membership is paused. Please contact the membership team to restart it.',
    review_required: 'We need to check your membership details before you can renew. Please contact the membership team for help.',
  };
  if (isRenewal && !canPay && !data.membershipYear) {
    return (
      <Card>
        <CardContent className="pt-6 space-y-3" data-testid="membership-renewal-summary">
          <p className="font-medium">{renewalMessages[renewal.state] || 'Membership renewal is not currently available.'}</p>
          {renewal.currentEnd && <p className="text-sm">Current membership ends: {formatMembershipDate(renewal.currentEnd)}.</p>}
          {renewal.successorStart && <p className="text-sm">Your renewal covers: {formatMembershipDate(renewal.successorStart)}{renewal.successorEnd ? ` to ${formatMembershipDate(renewal.successorEnd)}` : ''}.</p>}
          {renewal.currentAgreementId && <>
            <p className="text-sm">Any remaining payments for your current membership are still due.</p>
            <DirectDebitPlanCard memberId={memberId} />
          </>}
          {renewal.state === 'renewal_pending' && <Button type="button" variant="outline" disabled={busy} onClick={fetchFees}>{loading ? 'Checking renewal status…' : 'Check renewal status'}</Button>}
          {renewal.state === 'renewal_pending' && <Button type="button" variant="outline" disabled={busy} onClick={() => releaseUnusedRenewal()}>{switchingPayment ? 'Confirming cancellation…' : 'Change payment method'}</Button>}
          {switchingPayment && <p role="status">Checking your payment so you can safely choose another method. Please keep this page open.</p>}
          {paymentError && <p role="alert" className="text-sm text-destructive">{paymentError}</p>}
        </CardContent>
      </Card>
    );
  }
  const payableAmount = data.totalWithVat ?? data.finalCost;
  const belowMinimum = isBelowStripeMinimum(payableAmount, data.currency);

  return (
    <Card data-testid={`membership-payment-${field.id}`}>
      <CardContent className="pt-6 space-y-4">
        {isRenewal && (
          <div className="rounded-md border p-3 space-y-2 text-sm" data-testid="membership-renewal-summary">
            <p className="font-medium">{renewalMessages[renewal.state] || 'Renew your membership for the next term.'}</p>
            {switchingPayment && <p role="status">Checking your payment so you can safely choose another method. Please keep this page open.</p>}
            {!switchingPayment && renewal.switchState === 'reconciling' && <p role="status">Your previous checkout still needs to be checked. Choose another payment card to retry the safe cancellation, or check renewal status. Do not make another payment until this check finishes.</p>}
            {renewal.currentEnd && <p>Current membership ends: {formatMembershipDate(renewal.currentEnd)}.</p>}
            {renewal.successorStart && <p>Your renewal covers: {formatMembershipDate(renewal.successorStart)}{renewal.successorEnd ? ` to ${formatMembershipDate(renewal.successorEnd)}` : ''}.</p>}
            {renewal.currentAgreementId && <p>Any remaining payments for your current membership are still due.</p>}
            {renewal.eligible && <p>Pay in full to pay for your renewal now. If you choose Direct Debit, you’ll set it up now and receive confirmation of your collection dates. No payment will be collected before your new membership period starts.</p>}
            {renewal.state === 'renewal_pending' && (
              <Button type="button" variant="outline" onClick={fetchFees} disabled={busy}>{loading ? 'Checking renewal status…' : 'Check renewal status'}</Button>
            )}
          </div>
        )}
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-medium" data-testid="text-membership-year">{membershipTermLabel(data.membershipYear)}</p>
              {(data.scheduleName || data.tierLabel) && (
                <p className="text-xs text-muted-foreground" data-testid="text-tier-label">{data.scheduleName || data.tierLabel}</p>
              )}
            </div>
            {data.entityName && (
              <p className="text-xs text-muted-foreground" data-testid="text-entity-name">{data.entityName}</p>
            )}
          </div>

          <Separator />

          <div className="space-y-1 text-sm">
            {data.costBreakdown?.annualCostBeforeDiscounts != null && data.costBreakdown.annualCostBeforeDiscounts !== data.costBreakdown.annualCost && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Annual cost (before discounts)</span>
                <span>{formatCurrency(data.costBreakdown.annualCostBeforeDiscounts, data.currency)}</span>
              </div>
            )}

            {data.costBreakdown?.customDiscountTotal > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Discount</span>
                <span className="text-green-600">-{formatCurrency(data.costBreakdown.customDiscountTotal, data.currency)}</span>
              </div>
            )}

            <div className="flex justify-between flex-wrap gap-1">
              <span className="text-muted-foreground">Annual cost</span>
              <span>{formatCurrency(data.costBreakdown?.annualCost ?? data.finalCost, data.currency)}</span>
            </div>

            {data.costBreakdown?.proRataEnabled && data.costBreakdown.prorataCost != null && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">
                  Pro-rata{data.costBreakdown.prorataDays != null ? ` (${data.costBreakdown.prorataDays} days)` : ''}
                </span>
                <span>{formatCurrency(data.costBreakdown.prorataCost, data.currency)}</span>
              </div>
            )}

            {data.costBreakdown?.freeDiscount > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Free period discount</span>
                <span className="text-green-600">-{formatCurrency(data.costBreakdown.freeDiscount, data.currency)}</span>
              </div>
            )}

            {data.costBreakdown?.rolloverDiscount > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Rollover discount</span>
                <span className="text-green-600">-{formatCurrency(data.costBreakdown.rolloverDiscount, data.currency)}</span>
              </div>
            )}

            <Separator />

            <div className="flex justify-between flex-wrap gap-1 font-medium">
              <span>Subtotal</span>
              <span>{formatCurrency(data.finalCost, data.currency)}</span>
            </div>

            {data.vatRatePercent > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">VAT ({data.vatRatePercent}%)</span>
                <span>{formatCurrency(data.vatAmount, data.currency)}</span>
              </div>
            )}

            <div className="flex justify-between flex-wrap gap-1 font-semibold text-base pt-1">
              <span>Total</span>
              <span data-testid="text-total-amount">{formatCurrency(payableAmount, data.currency)}</span>
            </div>
          </div>
        </div>

        {data.approvalPending && (
          <div className="flex items-start gap-2 p-3 bg-warning/10 dark:bg-warning/30 rounded-md border border-warning/30 dark:border-warning">
            <Info className="h-4 w-4 text-warning dark:text-warning shrink-0 mt-0.5" />
            <p className="text-sm text-warning dark:text-warning">{data.approvalMessage}</p>
          </div>
        )}

        {canPay && belowMinimum && !data.zeroDue && !data.approvalPending && (
          <div className="flex items-start gap-2 p-3 bg-muted rounded-md">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              The amount is below the minimum for online payment. Please contact your administrator.
            </p>
          </div>
        )}

        {paymentError && (
          <div role="alert" className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{paymentError}</p>
          </div>
        )}

        {isRenewal && (renewal.eligible || resuming) && (
          <RenewalMethodChooser options={renewalOptions(data)} selectedMethod={selectedMethod}
            busyMethod={busyMethod} disabled={busy}
            onSelect={chooseRenewalMethod} />
        )}

        {(() => {
          const hasAnyPlan = !isRenewal && (hasDdPlan || hasCardPlan);
          const showStripeOption = canPay && (!isRenewal || data.zeroDue || chosenMethod === 'upfront') && !data.approvalPending && (data.zeroDue || (!belowMinimum && data.stripeEnabled)) && !paymentMode && !hasAnyPlan;
          const showDdOption = canPay && (!isRenewal || chosenMethod === 'direct_debit') && !data.approvalPending && !ddStarted && !hasAnyPlan && data.directDebit && !paymentMode;
          const showCardMonthlyOption = canPay && (!isRenewal || chosenMethod === 'monthly_card') && !data.approvalPending && !ddStarted && !hasAnyPlan && data.cardMonthly && !paymentMode;
          if (!showStripeOption && !showDdOption && !showCardMonthlyOption) return null;
          const cardMonthly = data.cardMonthly;
          const cardCurrency = cardMonthly?.currency || data.currency;
          const dd = data.directDebit;
          const ddCurrency = dd?.currency || data.currency;
          const firstCollectionText = (() => {
            if (!dd) return null;
            const amount = formatCurrency(dd.monthlyAmount, ddCurrency);
            const count = Number(dd.instalmentCount || 0);
            const schedule = directDebitHasFixedTermTotal(dd)
              ? `${count} monthly Direct Debit ${count === 1 ? 'collection' : 'collections'} of ${amount} for this term`
              : `monthly Direct Debit collections at the active structure price (currently ${amount})`;
            const setup = `This page confirms ${schedule}. If a new bank setup is needed, GoCardless will securely set up the Direct Debit mandate before any collection is requested`;
            const reusable = `If an existing Direct Debit can be reused, the same schedule will be applied without asking you to set up your bank details again`;
            const firstCollection = directDebitFirstCollectionText(dd);
            return `${setup}. First collection: ${firstCollection.toLowerCase()}. ${reusable}. ${directDebitPolicyText(dd)}`;
          })();
          return (
            <div className="space-y-3">
              {[showStripeOption, showDdOption, showCardMonthlyOption].filter(Boolean).length > 1 && (
                <p className="text-sm font-medium">Choose how to pay</p>
              )}
              {showStripeOption && (
                <div className="border rounded-md p-3 space-y-2" data-testid={`option-pay-annual-${field.id}`}>
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <span className="text-sm font-medium">Pay in full</span>
                    <span className="text-sm font-semibold">{formatCurrency(payableAmount, data.currency)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">One card payment covering the full membership year.</p>
                  <Button
                    type="button"
                    onClick={() => runPaymentAction(initStripe)}
                    disabled={busy}
                    className="w-full"
                    data-testid={`button-pay-membership-${field.id}`}
                  >
                    {creatingPayment ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Preparing payment...
                      </>
                    ) : (
                      <>
                        <CreditCard className="mr-2 h-4 w-4" />
                        Pay {formatCurrency(payableAmount, data.currency)}
                      </>
                    )}
                  </Button>
                </div>
              )}
              {showCardMonthlyOption && (
                <div className="border rounded-md p-3 space-y-2" data-testid={`option-pay-monthly-card-${field.id}`}>
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <span className="text-sm font-medium">Pay monthly by card</span>
                    <span className="text-sm font-semibold">{formatCurrency(cardMonthly.monthlyAmount, cardCurrency)}/month</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your annual membership paid in {cardMonthly.instalmentCount} monthly card instalments of {formatCurrency(cardMonthly.monthlyAmount, cardCurrency)} — {formatCurrency(cardMonthly.planTotal, cardCurrency)} in total over {cardMonthly.instalmentCount} months.
                  </p>
                  {cardMonthly.firstChargeDate && (
                    <p className="text-xs font-medium">
                      Nothing due now. First charge scheduled for {cardMonthly.firstChargeDate.split('-').reverse().join('/')}.
                      {' '}Your current membership stays unchanged.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    You'll be taken to a secure Stripe page to enter your card details. Your card is charged automatically each month — card details never touch our servers.
                  </p>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => runPaymentAction(startMonthlyCard)}
                    disabled={busy}
                    className="w-full"
                    data-testid={`button-monthly-card-${field.id}`}
                  >
                    {startingCard ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Preparing secure checkout...
                      </>
                    ) : (
                      <>
                        <CreditCard className="mr-2 h-4 w-4" />
                        Set up monthly card payments
                      </>
                    )}
                  </Button>
                </div>
              )}
              {showDdOption && (
                <div className="border rounded-md p-3 space-y-2" data-testid={`option-pay-monthly-${field.id}`}>
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <span className="text-sm font-medium">Pay monthly by Direct Debit</span>
                    <span className="text-sm font-semibold">{formatCurrency(dd.monthlyAmount, ddCurrency)}/month</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {directDebitHasFixedTermTotal(dd)
                      ? <>This term has {dd.instalmentCount} monthly instalments of {formatCurrency(dd.monthlyAmount, ddCurrency)} — {formatCurrency(dd.planTotal, ddCurrency)} in total.</>
                      : <>Current monthly price: {formatCurrency(dd.monthlyAmount, ddCurrency)}. This can change during the term; no fixed total applies.</>}
                  </p>
                  {firstCollectionText && (
                    <p className="text-xs text-muted-foreground" data-testid={`text-dd-first-collection-${field.id}`}>
                      {firstCollectionText}
                    </p>
                  )}
                  {dd.scope === 'organization' && !field.membership_schedule_mapping && (
                    <div className="space-y-2 pt-1" data-testid={`dd-payer-choice-${field.id}`}>
                      <p className="text-xs font-medium">Who will set up the Direct Debit?</p>
                      <label className="flex items-start gap-2 text-sm cursor-pointer">
                        <input
                          type="radio"
                          name={`dd-payer-${field.id}`}
                          value="self"
                          checked={ddPayerChoice === 'self'}
                          onChange={() => setDdPayerChoice('self')}
                          className="mt-0.5"
                          disabled={disabled || startingDd}
                          data-testid={`radio-dd-payer-self-${field.id}`}
                        />
                        <span>
                          I will set it up now
                          <span className="block text-xs text-muted-foreground">You must be authorised to set up Direct Debits on the organisation's bank account.</span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2 text-sm cursor-pointer">
                        <input
                          type="radio"
                          name={`dd-payer-${field.id}`}
                          value="billing_contact"
                          checked={ddPayerChoice === 'billing_contact'}
                          onChange={() => setDdPayerChoice('billing_contact')}
                          className="mt-0.5"
                          disabled={disabled || startingDd}
                          data-testid={`radio-dd-payer-billing-${field.id}`}
                        />
                        <span>
                          Send a secure set-up link to our billing contact
                          <span className="block text-xs text-muted-foreground">They'll receive an email with the plan details and a link to complete the set-up.</span>
                        </span>
                      </label>
                      {ddPayerChoice === 'billing_contact' && (
                        <div className="space-y-2 pl-6">
                          <input
                            type="text"
                            value={billingContactName}
                            onChange={(e) => setBillingContactName(e.target.value)}
                            placeholder="Billing contact name (optional)"
                            className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                            disabled={disabled || startingDd}
                            data-testid={`input-billing-contact-name-${field.id}`}
                          />
                          <input
                            type="email"
                            value={billingContactEmail}
                            onChange={(e) => setBillingContactEmail(e.target.value)}
                            placeholder="Billing contact email"
                            className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                            disabled={disabled || startingDd}
                            data-testid={`input-billing-contact-email-${field.id}`}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => runPaymentAction(startDirectDebit)}
                    disabled={busy}
                    className="w-full"
                    data-testid={`button-direct-debit-${field.id}`}
                  >
                    {startingDd ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {dd.scope === 'organization' && ddPayerChoice === 'billing_contact' ? 'Sending set-up link...' : 'Setting up Direct Debit...'}
                      </>
                    ) : (
                      <>
                        <Landmark className="mr-2 h-4 w-4" />
                        {dd.scope === 'organization' && ddPayerChoice === 'billing_contact' ? 'Send Direct Debit set-up link' : 'Set up monthly Direct Debit'}
                      </>
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground" data-testid={`text-dd-total-${field.id}`}>
                    Payments are protected by the{' '}
                    <a
                      href="https://gocardless.com/direct-debit/guarantee/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                      data-testid={`link-dd-guarantee-${field.id}`}
                    >
                      Direct Debit Guarantee
                    </a>.
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        {ddDropin && (
          <GoCardlessDropinFlow
            flowId={ddDropin.flowId}
            environment={ddDropin.environment}
            onSuccess={() => {
              setDdDropin(null);
              setDdModalDone(true);
              setDdStarted(true);
              if (onChange) {
                onChange({ status: 'direct_debit_started', membershipYear: data?.membershipYear, agreementId: ddDropin.agreementId });
              }
            }}
            onExit={() => {
              setDdDropin(null);
              setPaymentError('No Direct Debit was set up — you exited before completing the bank authorisation. Nothing has been charged. You can try again below.');
            }}
            onLoadFailure={() => {
              // Fall back to the hosted redirect flow.
              window.location.href = ddDropin.authorisationUrl;
            }}
          />
        )}

        {ddStarted && (
          <div className="flex items-start gap-2 p-3 bg-muted rounded-md" data-testid={`dd-started-${field.id}`}>
            <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              {ddInviteSent
                ? `A secure Direct Debit set-up link has been emailed to ${billingContactEmail.trim() || 'your billing contact'}. Your membership will be confirmed once they complete the set-up.`
                : ddModalDone
                ? 'Thank you — your bank details have been submitted. Your mandate is being confirmed with your bank, and your membership will be activated automatically. You will receive an email confirmation shortly.'
                : 'Your monthly Direct Debit has been set up using your existing bank mandate. You will receive a confirmation email shortly.'}
            </p>
          </div>
        )}

        {(hasDdPlan || hasCardPlan) && <DirectDebitPlanCard memberId={memberId} />}

        {!data.stripeEnabled && !data.directDebit && !data.cardMonthly && !data.approvalPending && (
          <div className="flex items-start gap-2 p-3 bg-muted rounded-md">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              Online payment is not currently available. Please contact your administrator.
            </p>
          </div>
        )}

        {paymentMode === 'stripe' && (
          <div className="space-y-3">
            <MembershipCommitmentNotice startDate={paymentTerm?.membershipStartDate} renewalDate={paymentTerm?.membershipRenewalDate} />
            <div
              id={`form-stripe-address-element-${field.id}`}
              className="min-h-[100px] rounded-md border p-3"
              data-testid={`form-stripe-address-element-${field.id}`}
            />
            <div
              id={`form-stripe-payment-element-${field.id}`}
              className="min-h-[100px] border rounded-md p-3"
              data-testid={`stripe-element-${field.id}`}
            />
            <Button
              type="button"
              onClick={() => runPaymentAction(handleStripePayment)}
              disabled={busy || !canPay}
              className="w-full"
              data-testid={`button-confirm-payment-${field.id}`}
            >
              {processingPayment ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing payment...
                </>
              ) : (
                `Confirm payment of ${formatCurrency(paymentTerm?.amount ?? payableAmount, paymentTerm?.currency || data.currency)}`
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

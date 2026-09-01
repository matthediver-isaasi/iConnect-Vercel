import { useState, useEffect, useRef, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, CheckCircle2, CreditCard, AlertCircle, Info, Landmark } from "lucide-react";
import DirectDebitPlanCard from "@/components/membership/DirectDebitPlanCard";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";

const CURRENCY_SYMBOLS = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

function formatCurrency(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

function isBelowStripeMinimum(amount, currency) {
  const min = STRIPE_MINIMUMS[currency] || 0.50;
  return parseFloat(amount || 0) < min;
}

export default function MembershipPaymentField({ value, onChange, disabled, field, allFormValues = {} }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [paymentMode, setPaymentMode] = useState(null);
  const [creatingPayment, setCreatingPayment] = useState(false);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [paymentYear, setPaymentYear] = useState(null);
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

  const memberId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('member_id');
  }, []);

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
    if (Object.keys(overrides).length > 0) body.fieldOverrides = overrides;
    if (field.membership_config_id) body.configId = field.membership_config_id;
    return body;
  };

  const pendingRefetchRef = useRef(false);
  const fetchInProgressRef = useRef(false);

  useEffect(() => {
    if (!memberId) {
      setLoading(false);
      return;
    }
    fetchFees();
  }, [memberId]);

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
    if (!mappings || Object.keys(mappings).length === 0) return;
    const overrides = buildFieldOverrides();
    const overridesKey = JSON.stringify(overrides);
    if (overridesKey === prevOverridesRef.current) return;
    prevOverridesRef.current = overridesKey;
    if (fetchInProgressRef.current) {
      pendingRefetchRef.current = true;
      return;
    }
    const timer = setTimeout(() => fetchFees(), 500);
    return () => clearTimeout(timer);
  }, [allFormValues, field.field_mappings, memberId, paymentComplete, paymentMode]);

  const fetchFees = () => {
    setLoading(true);
    setError(null);
    fetchInProgressRef.current = true;
    pendingRefetchRef.current = false;
    const overrideStr = buildOverrideParams();
    prevOverridesRef.current = JSON.stringify(buildFieldOverrides());
    fetch(`/api/forms/membership-payment?memberId=${encodeURIComponent(memberId)}${overrideStr}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load fee details');
        }
        return res.json();
      })
      .then((result) => {
        setData(result);
        if (result.existingRecord?.status === 'active') {
          setPaymentComplete(true);
          if (onChange && !value) {
            onChange({
              status: 'already_paid',
              membershipYear: result.membershipYear,
              existingRecordId: result.existingRecord.id,
            });
          }
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        fetchInProgressRef.current = false;
        setLoading(false);
        if (pendingRefetchRef.current) {
          pendingRefetchRef.current = false;
          fetchFees();
        }
      });
  };

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
    if (!data?.stripePublishableKey) return;
    if (isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency)) return;
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
      const { clientSecret, membershipYear: yr } = await res.json();
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

  const startDirectDebit = async () => {
    const isOrgDd = data?.directDebit?.scope === 'organization';
    if (isOrgDd && ddPayerChoice === 'billing_contact' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingContactEmail.trim())) {
      setPaymentError('Please enter a valid billing contact email address.');
      return;
    }
    setStartingDd(true);
    setPaymentError(null);
    try {
      const endpoint = isOrgDd ? '/api/membership/org-direct-debit' : '/api/membership/direct-debit';
      const body = isOrgDd
        ? {
            action: 'start',
            memberId,
            payerChoice: ddPayerChoice,
            ...(ddPayerChoice === 'billing_contact' ? {
              billingContactEmail: billingContactEmail.trim(),
              billingContactName: billingContactName.trim(),
            } : {}),
          }
        : { action: 'start', memberId };
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
      const res = await fetch('/api/membership/monthly-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'start', memberId }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to start monthly card set-up');
      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
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

  if (loading) {
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
              <p className="text-sm text-muted-foreground">
                {data?.membershipYear} - {formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const payableAmount = data.totalWithVat || data.finalCost;
  const belowMinimum = isBelowStripeMinimum(payableAmount, data.currency);

  return (
    <Card data-testid={`membership-payment-${field.id}`}>
      <CardContent className="pt-6 space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-medium" data-testid="text-membership-year">{data.membershipYear}</p>
              {data.tierLabel && (
                <p className="text-xs text-muted-foreground" data-testid="text-tier-label">{data.tierLabel}</p>
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

        {belowMinimum && !data.approvalPending && (
          <div className="flex items-start gap-2 p-3 bg-muted rounded-md">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              The amount is below the minimum for online payment. Please contact your administrator.
            </p>
          </div>
        )}

        {paymentError && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{paymentError}</p>
          </div>
        )}

        {(() => {
          const hasAnyPlan = hasDdPlan || hasCardPlan;
          const showStripeOption = !data.approvalPending && !belowMinimum && data.stripeEnabled && !paymentMode && !hasAnyPlan;
          const showDdOption = !data.approvalPending && !ddStarted && !hasAnyPlan && data.directDebit && !paymentMode;
          const showCardMonthlyOption = !data.approvalPending && !ddStarted && !hasAnyPlan && data.cardMonthly && !paymentMode;
          if (!showStripeOption && !showDdOption && !showCardMonthlyOption) return null;
          const cardMonthly = data.cardMonthly;
          const cardCurrency = cardMonthly?.currency || data.currency;
          const dd = data.directDebit;
          const ddCurrency = dd?.currency || data.currency;
          const firstCollectionText = (() => {
            if (!dd) return null;
            if (dd.firstCollectionRule === 'nominated_day' && dd.collectionDay) {
              const day = dd.collectionDay;
              const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
              return `Your first payment will be collected on the next ${day}${suffix} of the month after your bank confirms the Direct Debit.`;
            }
            if (dd.firstCollectionRule === 'anniversary') {
              return 'Your first payment will be collected on your membership anniversary date once your bank confirms the Direct Debit.';
            }
            return 'Your first payment will be collected as soon as your bank confirms the Direct Debit (usually within a few working days).';
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
                    onClick={initStripe}
                    disabled={disabled || creatingPayment}
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
                  <p className="text-xs text-muted-foreground">
                    You'll be taken to a secure Stripe page to enter your card details. Your card is charged automatically each month — card details never touch our servers.
                  </p>
                  <Button
                    variant="outline"
                    onClick={startMonthlyCard}
                    disabled={disabled || startingCard}
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
                    Your annual membership paid in {dd.instalmentCount} monthly instalments of {formatCurrency(dd.monthlyAmount, ddCurrency)} — {formatCurrency(dd.planTotal, ddCurrency)} in total over {dd.instalmentCount} months.
                  </p>
                  {firstCollectionText && (
                    <p className="text-xs text-muted-foreground" data-testid={`text-dd-first-collection-${field.id}`}>
                      {firstCollectionText}
                    </p>
                  )}
                  {dd.scope === 'organization' && (
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
                    onClick={startDirectDebit}
                    disabled={disabled || startingDd}
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
              onClick={handleStripePayment}
              disabled={processingPayment}
              className="w-full"
              data-testid={`button-confirm-payment-${field.id}`}
            >
              {processingPayment ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing payment...
                </>
              ) : (
                `Confirm payment of ${formatCurrency(payableAmount, data.currency)}`
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

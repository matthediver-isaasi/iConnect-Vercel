import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, CreditCard, AlertCircle, Landmark, Info } from "lucide-react";
import { filterPaymentProvidersForMembership, resolveEffectivePayment } from "@/lib/formPaymentQuote";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";
import {
  confirmFormPayment,
  getPaymentNavigationContext,
  navigateToPaymentProvider,
  savePaymentSubmissionContext,
  loadPaymentSubmissionContext,
  MONTHLY_PAYMENT_PROVIDERS,
} from "@/lib/formPaymentReturn";
import { directDebitFirstCollectionText, directDebitPolicyText, directDebitHasFixedTermTotal } from "@/lib/directDebitConsentSummary";
import MembershipCommitmentNotice from "@/components/membership/MembershipCommitmentNotice";

const CURRENCY_SYMBOLS = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
const PAYMENT_METHOD_CARD_CLASS = "flex min-h-[9.35rem] w-full gap-3 rounded-[0.55rem] border border-border bg-background p-4 text-left text-foreground transition-[border-color,background-color] duration-150 hover:border-foreground/50 hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export function formatPaymentAmount(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || (currency ? currency + ' ' : '');
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

// Client-side mirror of the server's derivePaymentAmount — display only;
// the server ALWAYS re-derives the amount from the submitted answers.
export function derivePaymentAmountClient(paymentField, formValues) {
  const sourceId = paymentField?.price_field_id;
  if (!sourceId) return 0;
  let raw = (formValues || {})[sourceId];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = raw.amount ?? raw.value ?? null;
  }
  if (typeof raw === 'string') raw = raw.replace(/[^0-9.\-]/g, '');
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Task #3483: the payment step that replaces the plain Submit button when a
 * form carries a visible Payment field.
 *
 * Props:
 *  - field: the payment field config ({ payment_providers, price_field_id,
 *    payment_currency, payment_label, payment_description })
 *  - formValues: current answers (for the derived display amount)
 *  - buildPayload: async () => submission payload | null (runs ALL the form's
 *    validations; null aborts)
 *  - idempotencyKey: stable per-attempt key from useSubmissionIdempotencyKey
 *  - disabled / disabledMessage: submit-control rule state
 *  - busy: parent-side submitting state
 *  - onPaid(submissionId): payment verified server-side — show success
 *  - onSetupComplete(submissionId): GoCardless Direct Debit membership was
 *    verified and the application was finalized — show the dedicated
 *    application-submitted outcome (distinct from a paid card payment)
 *  - onNormalSubmit(): fall back to the plain submit path (zero amount /
 *    no configured provider)
 *  - continueHref / continueLabel: safe non-payment exit for an inline
 *    provider completion that is still awaiting finalisation
 *  - submitLabel: label used for the fallback submit button
 *  - membershipQuote: result of useMembershipFeeQuote (Task #3498). When a
 *    conditional membership rule matches, the payable amount is the
 *    server-derived membership fee — the price-source derivation is display
 *    fallback only, and the plain submit fallback is blocked while the
 *    quote is loading or failed (never silently unpaid).
 */
export default function FormPaymentSubmit({
  field,
  formValues,
  buildPayload,
  idempotencyKey,
  disabled = false,
  disabledMessage = null,
  busy = false,
  onPaid,
  onPaymentAccepted,
  onSetupComplete,
  onNormalSubmit,
  submitLabel = 'Submit',
  membershipQuote = null,
  continueHref = '/',
  continueLabel = 'Continue to site',
  continueTarget,
  continueRel,
  onContinue,
}) {
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [pendingMethod, setPendingMethod] = useState(null);
  const creating = pendingMethod !== null;
  const startupInFlightRef = useRef(false);
  const [processing, setProcessing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [stripeMounted, setStripeMounted] = useState(false);
  const [stripeAddressRequired, setStripeAddressRequired] = useState(false);
  const [preparedMembershipTerm, setPreparedMembershipTerm] = useState(null);
  const [paymentCaptured, setPaymentCaptured] = useState(false);
  const [paymentStage, setPaymentStage] = useState(null);
  const [externalCheckoutUrl, setExternalCheckoutUrl] = useState(null);
  // GoCardless Drop-in modal state: { flowId, environment, authorisationUrl }
  const [gcDropin, setGcDropin] = useState(null);

  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const submissionIdRef = useRef(null);
  const paymentProviderRef = useRef(null);
  const mountedRef = useRef(false);
  const confirmSequenceRef = useRef(0);
  const confirmInFlightRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      confirmSequenceRef.current += 1;
    };
  }, []);

  const fieldCurrency = (field?.payment_currency || 'GBP').toUpperCase();
  const derivedAmount = useMemo(() => derivePaymentAmountClient(field, formValues), [field, formValues]);
  const effective = useMemo(() => resolveEffectivePayment({
    membershipMatched: !!membershipQuote?.matched,
    quote: membershipQuote?.quote,
    quoteLoading: membershipQuote?.loading,
    quoteError: membershipQuote?.error,
    derivedAmount,
    derivedCurrency: fieldCurrency,
  }), [membershipQuote?.matched, membershipQuote?.quote, membershipQuote?.loading, membershipQuote?.error, derivedAmount, fieldCurrency]);
  const amount = effective.amount ?? 0;
  const currency = effective.currency || fieldCurrency;
  const directDebitOffer = effective.membership?.direct_debit
    || effective.membership?.direct_debit_offer
    || null;
  const paymentPurpose = membershipQuote?.matched ? 'membership' : 'forms';

  // Provider detection (public, secrets-free). Keep this query keyed only by
  // purpose: payment fields and membership quotes are recreated frequently as
  // the form renders, but provider availability is purpose-wide. The bounded
  // cache also means switching forms -> membership -> forms does not repeat
  // either discovery request while the cached result is still useful.
  const providerQuery = useQuery({
    queryKey: ['form-payment-providers', paymentPurpose],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/public/form-payment-providers?purpose=${encodeURIComponent(paymentPurpose)}`);
        if (!res.ok) return [];
        const json = await res.json().catch(() => ({}));
        return json.providers || [];
      } catch {
        return [];
      }
    },
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const providers = providerQuery.data ?? null;

  const enabledProviderIds = Array.isArray(field?.payment_providers) ? field.payment_providers : [];
  const usableProviders = useMemo(() => {
    if (!providers) return null;
    const configured = providers.filter((p) => p.configured && enabledProviderIds.includes(p.id));
    return filterPaymentProvidersForMembership(configured, effective.membership);
  }, [providers, enabledProviderIds, effective.membership]);

  const stripeProvider = usableProviders?.find((p) => p.id === 'stripe') || null;
  const unavailableStripe = providers?.find((p) => p.id === 'stripe' && !p.configured) || null;
  const stripeConfigurationError = enabledProviderIds.includes('stripe')
    ? unavailableStripe?.configurationError
    : null;

  // Task #3501: the redirect return legs (GoCardless redirect back, Stripe
  // 3DS redirect back) are handled at PAGE level via useFormPaymentReturn —
  // this component only mounts on the form's last step, so it can never see
  // a redirect return. This path only confirms the inline (non-redirect)
  // Stripe flow, through the same shared confirm helper.
  const confirmPayment = useCallback(async ({ submissionId, paymentIntentId = null }) => {
    if (confirmInFlightRef.current) return false;
    confirmInFlightRef.current = true;
    const sequence = ++confirmSequenceRef.current;
    const scope = { pathname: window.location.pathname, search: window.location.search };
    const isCurrent = () => mountedRef.current
      && sequence === confirmSequenceRef.current
      && submissionIdRef.current === submissionId;
    setConfirming(true);
    setPaymentError(null);
    try {
      const out = await confirmFormPayment({
        submissionId,
        paymentIntentId,
        provider: paymentProviderRef.current || selectedProvider,
      });
      if (!isCurrent()) return false;
      // Classify the authoritative response independently of optional receipt
      // storage. Monthly setup must never fall through to one-off collection.
      const monthlyPayment = MONTHLY_PAYMENT_PROVIDERS.has(out.paymentProvider);
      const setupAccepted = monthlyPayment
        && out.setupVerified === true
        && ((out.paymentProvider === 'stripe_monthly_card' && out.provider === 'stripe')
          || (out.paymentProvider === 'gocardless_monthly_dd' && out.provider === 'gocardless'));
      const status = monthlyPayment && !setupAccepted ? 'pending' : out.status;
      const paymentAccepted = !monthlyPayment
        && out.provider === 'stripe' && out.paymentSucceeded === true;
      setPaymentStage(status);
      // Inline Stripe and Drop-in completions need the same refresh receipt
      // as hosted returns. Persist only the server-confirmed outcome.
      try {
        const stored = loadPaymentSubmissionContext(scope);
        savePaymentSubmissionContext({
          ...scope,
          submissionId,
          provider: out.provider,
          paymentProvider: out.paymentProvider || null,
          setupVerified: setupAccepted,
          paymentCollected: setupAccepted ? out.paymentSucceeded === true : null,
          status,
          presentationAccepted: paymentAccepted,
          returnPath: stored?.submissionId === submissionId ? stored.returnPath : null,
          continuePath: continueHref,
        });
      } catch { /* Storage may be unavailable; keep the in-memory result. */ }
      if (setupAccepted) {
        onSetupComplete?.({
          submissionId,
          provider: out.provider,
          paymentProvider: out.paymentProvider,
          setupVerified: true,
          paymentCollected: out.paymentSucceeded === true,
        });
        return true;
      }
      if (paymentAccepted) {
        onPaymentAccepted?.({
          submissionId,
          provider: out.provider,
          status: out.status,
          paymentSucceeded: out.paymentSucceeded,
        });
        return true;
      }
      if (status !== 'paid') {
        if (status === 'setup_complete' && out.provider === 'gocardless') {
          // GoCardless setup_complete is a server-confirmed, finalized
          // membership application, not a captured one-off payment. Keep the
          // scoped setup receipt, but let the page-level handler adopt the
          // dedicated application-submitted screen.
          onSetupComplete?.(submissionId);
          return true;
        }
        setPaymentCaptured(true);
        setPaymentError(out.error || (
          monthlyPayment
            ? 'Your monthly payment setup is still being verified. Please do not set up another payment.'
            : status === 'setup_complete'
            ? 'Your recurring payment method is set up. Your first collection has not yet been confirmed and will be recorded separately.'
            : out.paymentSucceeded
              ? 'Payment received — we are finishing your submission automatically. Please do not pay again.'
            : 'Your payment is still being verified or finalized. You can safely close this page; do not pay again.'
        ));
        return false;
      }
      onPaid?.(submissionId);
      return true;
    } finally {
      confirmInFlightRef.current = false;
      if (isCurrent()) setConfirming(false);
    }
  }, [onPaid, onPaymentAccepted, onSetupComplete, selectedProvider, continueHref]);

  const leaveForProvider = (url, paymentNavigation) => {
    // Stripe Checkout and some hosted mandate pages refuse to render in a
    // third-party iframe. Do not replace that host page; require a deliberate
    // new-tab click instead. Same-origin Canvas frames have an approved top
    // route and continue through navigateToPaymentProvider.
    if (paymentNavigation.framed && paymentNavigation.target === 'self') {
      setExternalCheckoutUrl(url);
      return;
    }
    navigateToPaymentProvider(url, paymentNavigation);
  };

  const startPayment = async (providerId) => {
    if (startupInFlightRef.current || disabled || busy || processing || confirming) return;
    startupInFlightRef.current = true;
    setPendingMethod(providerId);
    setPaymentError(null);
    setPaymentCaptured(false);
    setPaymentStage(null);
    setExternalCheckoutUrl(null);
    try {
      const payload = await buildPayload();
      if (!payload) return;
      // A Canvas form is an iframe inside a same-origin tenant page. Keep the
      // provider return bound to that page and only let hosted flows leave via
      // the top window when the ancestor is readable/same-origin.
      const paymentNavigation = getPaymentNavigationContext();
      const paymentScope = { pathname: window.location.pathname, search: window.location.search };
      const res = await fetch('/api/public/form-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'create',
          form_id: payload.form_id,
          provider: providerId,
          submission_data: payload.submission_data,
          idempotency_key: idempotencyKey || undefined,
          prefill_organization_id: payload.prefill_organization_id || null,
          role_id: payload.role_id || null,
          return_path: paymentNavigation.returnPath,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.code === 'NO_PAYMENT_REQUIRED' || json.code === 'PAYMENT_NOT_REQUIRED') {
          onNormalSubmit?.();
          return;
        }
        throw new Error(json.error || 'Failed to start payment');
      }
      if (json.alreadyPaid) {
        if (!mountedRef.current) return;
        try {
          savePaymentSubmissionContext({
            ...paymentScope,
            submissionId: json.submissionId,
            provider: json.provider || null,
            status: 'paid',
            returnPath: paymentNavigation.returnPath,
            continuePath: continueHref,
          });
        } catch { /* Keep the verified result even without storage. */ }
        onPaid?.(json.submissionId);
        return;
      }
      submissionIdRef.current = json.submissionId;
      paymentProviderRef.current = providerId === 'gocardless' && directDebitOffer
        ? 'gocardless_monthly_dd'
        : providerId;
       try {
         savePaymentSubmissionContext({
           submissionId: json.submissionId,
            provider: paymentProviderRef.current,
            returnPath: paymentNavigation.returnPath,
            continuePath: continueHref,
         });
       } catch { /* ignore */ }

      if (providerId === 'gocardless') {
        if (json.flowId) {
          // Open the GoCardless Drop-in modal on-page; hosted redirect stays
          // as the automatic fallback if the widget fails to load.
          setGcDropin({
            flowId: json.flowId,
            environment: json.environment || 'sandbox',
            authorisationUrl: json.authorisationUrl,
          });
          return;
        }
        leaveForProvider(json.authorisationUrl, paymentNavigation);
        return;
      }

      // Stripe: load Stripe.js and mount the PaymentElement inline.
      setPreparedMembershipTerm(json);
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
      const stripe = window.Stripe(json.publishableKey);
      stripeRef.current = stripe;
      const elements = stripe.elements({ clientSecret: json.clientSecret });
      elementsRef.current = elements;
      // This is a server decision: ordinary forms may map Stripe address
      // components too, while membership payments still require the
      // authoritative billing snapshot even without explicit mappings.
      const requiresStripeAddress = json.requiresBillingAddress === true;
      setStripeAddressRequired(requiresStripeAddress);
      const addressElement = requiresStripeAddress
        ? elements.create('address', { mode: 'billing' })
        : null;
      const paymentElement = requiresStripeAddress
        ? elements.create('payment', { fields: { billingDetails: { address: 'never' } } })
        : elements.create('payment');
      setSelectedProvider('stripe');
      setStripeMounted(true);
      setTimeout(() => {
        const addressContainer = document.getElementById(`form-payment-address-element-${field.id}`);
        const paymentContainer = document.getElementById(`form-payment-element-${field.id}`);
        if (addressContainer && addressElement) addressElement.mount(addressContainer);
        if (paymentContainer) paymentElement.mount(paymentContainer);
      }, 100);
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      startupInFlightRef.current = false;
      setPendingMethod(null);
    }
  };

  const startMonthlyCard = async () => {
    if (startupInFlightRef.current || disabled || busy || processing || confirming) return;
    startupInFlightRef.current = true;
    setPendingMethod('stripe_monthly_card');
    setPaymentError(null);
    setPaymentStage(null);
    setExternalCheckoutUrl(null);
    try {
      const payload = await buildPayload();
      if (!payload) return;
      const paymentNavigation = getPaymentNavigationContext();
      const res = await fetch('/api/public/form-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'create_monthly_card', form_id: payload.form_id, submission_data: payload.submission_data,
          idempotency_key: idempotencyKey || undefined, prefill_organization_id: payload.prefill_organization_id || null,
          role_id: payload.role_id || null, return_path: paymentNavigation.returnPath }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to start monthly card set-up');
      if (!json.checkoutUrl) throw new Error('Could not start secure card checkout');
       paymentProviderRef.current = 'stripe_monthly_card';
       try {
         savePaymentSubmissionContext({
           submissionId: json.submissionId,
           provider: 'stripe_monthly_card',
            returnPath: paymentNavigation.returnPath,
            continuePath: continueHref,
         });
       } catch { /* ignore */ }
      leaveForProvider(json.checkoutUrl, paymentNavigation);
    } catch (err) { setPaymentError(err.message); } finally {
      startupInFlightRef.current = false;
      setPendingMethod(null);
    }
  };

  const handleStripeConfirm = async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setProcessing(true);
    setPaymentError(null);
    try {
      const { error: submitError } = await elementsRef.current.submit();
      if (submitError) throw new Error(submitError.message);

      const returnUrl = new URL(window.location.href);
      returnUrl.searchParams.set('form_payment_submission', submissionIdRef.current);
      returnUrl.searchParams.set('form_payment_provider', 'stripe');
      const { error: confirmError, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: { return_url: returnUrl.toString() },
        redirect: 'if_required',
      });
      if (confirmError) throw new Error(confirmError.message);
      if (paymentIntent?.status === 'succeeded') {
        // From this point the charge must never be offered again, even if the
        // server-side address snapshot/mapping call is temporarily unavailable.
        setPaymentCaptured(true);
        await confirmPayment({ submissionId: submissionIdRef.current, paymentIntentId: paymentIntent.id });
      }
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setProcessing(false);
    }
  };

  const anyBusy = busy || creating || processing || confirming;

  // No amount due, or no usable provider once detection resolved: fall back
  // to the plain Submit button so the form stays usable. NEVER while a
  // matched membership quote is loading or failed — that would submit a
  // fee-carrying application unpaid.
  const fallbackToNormalSubmit = !effective.blocked
    && (amount <= 0 || (usableProviders !== null
      && usableProviders.length === 0
      && !membershipQuote?.matched
      && !effective.membership?.monthly_card));

  return (
    <div className="space-y-3" data-testid={`form-payment-submit-${field?.id || 'unknown'}`}>
      {gcDropin && (
        <GoCardlessDropinFlow
          flowId={gcDropin.flowId}
          environment={gcDropin.environment}
          onSuccess={() => {
            setGcDropin(null);
            // Confirm server-side; setup_complete adopts the dedicated
            // application-submitted screen, while a still-pending mandate
            // shows the existing "being confirmed" message.
            confirmPayment({ submissionId: submissionIdRef.current });
          }}
          onExit={() => {
            setGcDropin(null);
            setPaymentError('No Direct Debit was set up — you exited before completing the bank authorisation. Nothing has been charged. You can try again.');
          }}
          onLoadFailure={() => {
            // Fall back to the hosted redirect flow.
            setGcDropin(null);
            leaveForProvider(gcDropin.authorisationUrl, getPaymentNavigationContext());
          }}
        />
      )}
      {paymentError && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20" role="alert">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{paymentError}</p>
        </div>
      )}
      {!paymentError && stripeConfigurationError && amount > 0 && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20" data-testid="form-payment-stripe-configuration-error">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{stripeConfigurationError}</p>
        </div>
      )}

      {confirming && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Confirming your payment…
        </div>
      )}

      {externalCheckoutUrl ? (
        <div className="space-y-3 rounded-md border bg-muted/40 p-4" data-testid={`form-payment-external-checkout-${field?.id}`}>
          <p className="text-sm font-medium">Continue to secure payment</p>
          <p className="text-sm text-muted-foreground">
            Your website does not allow secure checkout inside this embedded form. Open the payment in a new tab to continue.
          </p>
          <Button asChild data-testid={`button-form-payment-external-checkout-${field?.id}`}>
            <a href={externalCheckoutUrl} target="_blank" rel="noopener noreferrer">Open secure checkout</a>
          </Button>
        </div>
      ) : effective.pending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`form-payment-quote-loading-${field?.id}`}>
          <Loader2 className="h-4 w-4 animate-spin" /> Calculating the amount due…
        </div>
      ) : effective.error ? (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20" data-testid={`form-payment-quote-error-${field?.id}`}>
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm text-destructive">{effective.error}</p>
            {membershipQuote?.refetch && (
              <Button variant="outline" size="sm" onClick={() => membershipQuote.refetch()} disabled={anyBusy}>
                Try again
              </Button>
            )}
          </div>
        </div>
      ) : paymentCaptured ? (
        <div
          className="space-y-3 rounded-md border bg-muted/40 p-4"
          data-testid={`form-payment-captured-${field?.id}`}
          data-payment-status={paymentStage || 'accounting_pending'}
        >
          <p className="text-sm font-medium">
            {paymentStage === 'setup_complete'
              ? 'Payment setup complete'
              : paymentStage === 'pending'
                ? 'Payment status is being confirmed'
                : paymentStage === 'blocked'
                  ? 'Payment status needs attention'
                  : 'Finishing your submission'}
          </p>
          <p className="text-sm text-muted-foreground">
            {paymentError || 'Do not make another payment. You can safely check this submission again.'}
          </p>
          <Button
            variant="outline"
            onClick={() => confirmPayment({ submissionId: submissionIdRef.current })}
            disabled={anyBusy}
            data-testid={`button-form-payment-retry-processing-${field?.id}`}
          >
            {confirming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Check status again
          </Button>
          {continueHref && (
            onContinue ? (
              <Button variant="outline" onClick={onContinue} data-testid={`button-form-payment-continue-${field?.id}`}>
                {continueLabel}
              </Button>
            ) : (
              <Button variant="outline" asChild data-testid={`button-form-payment-continue-${field?.id}`}>
                <a href={continueHref} target={continueTarget} rel={continueRel}>{continueLabel}</a>
              </Button>
            )
          )}
        </div>
      ) : fallbackToNormalSubmit ? (
        <>
          {amount > 0 && usableProviders !== null && usableProviders.length === 0 && (
            <div className="flex items-start gap-2 p-3 bg-muted rounded-md">
              <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">Online payment is not currently available. Your submission will be recorded without payment.</p>
            </div>
          )}
          <Button
            onClick={() => onNormalSubmit?.()}
            disabled={disabled || anyBusy}
            data-testid="button-submit-form"
          >
            {anyBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </>
      ) : stripeMounted && selectedProvider === 'stripe' ? (
        <div className="w-full max-w-2xl space-y-4" data-testid={`form-payment-provider-content-${field.id}`}>
          <MembershipCommitmentNotice startDate={preparedMembershipTerm?.membershipStartDate} renewalDate={preparedMembershipTerm?.membershipRenewalDate} />
          {stripeAddressRequired && (
            <div
              id={`form-payment-address-element-${field.id}`}
              className="min-h-[100px] w-full rounded-md border p-3"
              data-testid={`form-payment-stripe-address-element-${field.id}`}
            />
          )}
          <div
            id={`form-payment-element-${field.id}`}
            className="min-h-[100px] w-full rounded-md border p-3"
            data-testid={`form-payment-stripe-element-${field.id}`}
          />
          <Button
            onClick={handleStripeConfirm}
            disabled={disabled || anyBusy}
            className="w-full"
            data-testid={`button-form-payment-confirm-${field.id}`}
          >
            {processing || confirming ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing payment…</>
            ) : (
              `Pay ${formatPaymentAmount(amount, currency)} and submit`
            )}
          </Button>
        </div>
      ) : (
        <div className="w-full space-y-4">
          <p className="text-sm font-medium">
            Amount due: <span data-testid={`form-payment-amount-${field?.id}`}>{formatPaymentAmount(amount, currency)}</span>
          </p>
          {effective.membership && (
            <p className="text-xs text-muted-foreground" data-testid={`form-payment-membership-context-${field?.id}`}>
              {[effective.membership.config_name, effective.membership.tier_label,
                effective.membership.membership_start_date ? null : effective.membership.membership_year]
                .filter(Boolean).join(' — ')}
            </p>
          )}
          <MembershipCommitmentNotice startDate={effective.membership?.membership_start_date} renewalDate={effective.membership?.membership_renewal_date} />
          {providers === null && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking payment options…
            </div>
          )}
          <section
            className="mt-1"
            data-testid={`form-payment-provider-choices-${field?.id}`}
            aria-labelledby={`form-payment-methods-title-${field?.id}`}
          >
            <div className="mb-3.5">
              <h2 id={`form-payment-methods-title-${field?.id}`} className="text-[0.95rem] font-semibold leading-snug tracking-[-0.01em]">
                Select your desired payment method
              </h2>
              <p className="mt-1 text-[0.82rem] leading-relaxed text-muted-foreground">
                Click an option below to start secure payment or set up your payment plan.
              </p>
              {creating && (
                <p className="mt-2 text-xs font-medium text-muted-foreground" role="status">
                  Starting secure payment…
                </p>
              )}
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,12.5rem),1fr))]">
              {effective.membership?.monthly_card && (
                <button
                  type="button"
                  onClick={startMonthlyCard}
                  disabled={disabled || anyBusy}
                  className={PAYMENT_METHOD_CARD_CLASS}
                  data-testid={`button-form-payment-monthly-card-${field?.id}`}
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground" aria-hidden="true">
                    {pendingMethod === 'stripe_monthly_card' ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col items-start break-words">
                    <span className="min-h-10 text-sm font-semibold leading-snug">Pay monthly by card</span>
                    <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground break-words">
                      {formatPaymentAmount(effective.membership.monthly_card.monthlyAmount, effective.membership.monthly_card.currency || currency)} × {effective.membership.monthly_card.instalmentCount} instalments
                    </span>
                    <span className="mt-1.5 block text-xs font-semibold leading-relaxed break-words">
                      Plan total {formatPaymentAmount(effective.membership.monthly_card.planTotal, effective.membership.monthly_card.currency || currency)}
                    </span>
                  </span>
                </button>
              )}
              {(usableProviders || []).map((p) => {
                const isCard = p.id === 'stripe';
                const monthlyDirectDebit = p.id === 'gocardless' && directDebitOffer;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => startPayment(p.id)}
                    disabled={disabled || anyBusy}
                    className={PAYMENT_METHOD_CARD_CLASS}
                    data-testid={`button-form-payment-${p.id}-${field?.id}`}
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground" aria-hidden="true">
                      {pendingMethod === p.id ? <Loader2 className="h-5 w-5 animate-spin" /> : isCard ? <CreditCard className="h-5 w-5" /> : <Landmark className="h-5 w-5" />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col items-start break-words">
                      <span className="min-h-10 text-sm font-semibold leading-snug">
                        {isCard ? 'Pay in full by card' : monthlyDirectDebit ? 'Pay monthly by Direct Debit' : 'Pay by Direct Debit'}
                      </span>
                      {isCard ? (
                        <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground break-words">{formatPaymentAmount(amount, currency)} due today</span>
                      ) : monthlyDirectDebit ? (
                        <>
                          <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground break-words">
                            {directDebitHasFixedTermTotal(directDebitOffer)
                              ? <>{formatPaymentAmount(directDebitOffer.monthlyAmount, directDebitOffer.currency || currency)} × {directDebitOffer.instalmentCount} instalments</>
                              : <>Current monthly price {formatPaymentAmount(directDebitOffer.monthlyAmount, directDebitOffer.currency || currency)} — variable</>}
                          </span>
                          <span className="mt-1.5 block text-xs font-semibold leading-relaxed break-words">
                            {directDebitHasFixedTermTotal(directDebitOffer)
                              ? <>Plan total for this term {formatPaymentAmount(directDebitOffer.planTotal, directDebitOffer.currency || currency)}</>
                              : 'No fixed term total'}
                          </span>
                          <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground break-words">First collection: {directDebitFirstCollectionText(directDebitOffer)}</span>
                          <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground break-words">{directDebitPolicyText(directDebitOffer)}</span>
                        </>
                      ) : (
                        <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground break-words">Set up a secure bank instruction</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {disabled && disabledMessage && (
        <p className="text-sm text-destructive" data-testid="text-payment-disabled-message">{disabledMessage}</p>
      )}
    </div>
  );
}

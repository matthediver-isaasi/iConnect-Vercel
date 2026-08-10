import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, CreditCard, AlertCircle, Landmark, Info } from "lucide-react";
import { resolveEffectivePayment } from "@/lib/formPaymentQuote";

const CURRENCY_SYMBOLS = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };

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

const SS_KEY = 'form_payment_pending_submission';

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
 *  - onNormalSubmit(): fall back to the plain submit path (zero amount /
 *    no configured provider)
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
  onNormalSubmit,
  submitLabel = 'Submit',
  membershipQuote = null,
}) {
  const [providers, setProviders] = useState(null); // null = loading
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [creating, setCreating] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [stripeMounted, setStripeMounted] = useState(false);

  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const submissionIdRef = useRef(null);
  const returnHandled = useRef(false);

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

  // Provider detection (public, secrets-free).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/form-payment-providers')
      .then((res) => (res.ok ? res.json() : { providers: [] }))
      .then((json) => { if (!cancelled) setProviders(json.providers || []); })
      .catch(() => { if (!cancelled) setProviders([]); });
    return () => { cancelled = true; };
  }, []);

  const enabledProviderIds = Array.isArray(field?.payment_providers) ? field.payment_providers : [];
  const usableProviders = useMemo(() => {
    if (!providers) return null;
    return providers.filter((p) => p.configured && enabledProviderIds.includes(p.id));
  }, [providers, enabledProviderIds]);

  const stripeProvider = usableProviders?.find((p) => p.id === 'stripe') || null;

  const confirmPayment = useCallback(async ({ submissionId, paymentIntentId = null }) => {
    setConfirming(true);
    setPaymentError(null);
    try {
      const res = await fetch('/api/public/form-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'confirm',
          submission_id: submissionId,
          ...(paymentIntentId ? { payment_intent_id: paymentIntentId } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || 'Your payment was taken, but we could not confirm the submission. It will be reconciled automatically — please do NOT pay again.');
      }
      if (json.pending) {
        setPaymentError('Your Direct Debit set-up is still being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.');
        return false;
      }
      try { sessionStorage.removeItem(SS_KEY); } catch { /* ignore */ }
      onPaid?.(submissionId);
      return true;
    } catch (err) {
      setPaymentError(err.message);
      return false;
    } finally {
      setConfirming(false);
    }
  }, [onPaid]);

  // Return legs: GoCardless redirect back, and Stripe 3DS redirect back.
  useEffect(() => {
    if (returnHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const returnedSubmission = params.get('form_payment_submission');
    const returnedProvider = params.get('form_payment_provider');
    const cancelled = params.get('form_payment_cancelled');
    const piFromUrl = params.get('payment_intent');
    const redirectStatus = params.get('redirect_status');
    if (!returnedSubmission && !cancelled && !piFromUrl) return;
    returnHandled.current = true;

    // Clean payment params off the URL.
    ['form_payment_submission', 'form_payment_provider', 'form_payment_cancelled',
      'payment_intent', 'payment_intent_client_secret', 'redirect_status'].forEach((k) => params.delete(k));
    const cleanUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    if (cancelled) {
      setPaymentError('The payment was cancelled. You can try again below.');
      return;
    }

    let submissionId = returnedSubmission;
    if (!submissionId) {
      try { submissionId = sessionStorage.getItem(SS_KEY); } catch { /* ignore */ }
    }
    if (!submissionId) return;

    if (piFromUrl && redirectStatus && redirectStatus !== 'succeeded') {
      setPaymentError('Payment was not completed. Please try again.');
      return;
    }
    confirmPayment({ submissionId, paymentIntentId: piFromUrl || null });
  }, [confirmPayment]);

  const startPayment = async (providerId) => {
    setPaymentError(null);
    const payload = await buildPayload();
    if (!payload) return;
    setCreating(true);
    try {
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
          return_path: `${window.location.pathname}${window.location.search}`,
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
        onPaid?.(json.submissionId);
        return;
      }
      submissionIdRef.current = json.submissionId;
      try { sessionStorage.setItem(SS_KEY, json.submissionId); } catch { /* ignore */ }

      if (providerId === 'gocardless') {
        window.location.href = json.authorisationUrl;
        return;
      }

      // Stripe: load Stripe.js and mount the PaymentElement inline.
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
      const paymentElement = elements.create('payment');
      setSelectedProvider('stripe');
      setStripeMounted(true);
      setTimeout(() => {
        const container = document.getElementById(`form-payment-element-${field.id}`);
        if (container) paymentElement.mount(container);
      }, 100);
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setCreating(false);
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
    && (amount <= 0 || (usableProviders !== null && usableProviders.length === 0));

  return (
    <div className="space-y-3" data-testid={`form-payment-submit-${field?.id || 'unknown'}`}>
      {paymentError && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{paymentError}</p>
        </div>
      )}

      {confirming && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Confirming your payment…
        </div>
      )}

      {effective.pending ? (
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
        <div className="space-y-3 max-w-lg">
          <div
            id={`form-payment-element-${field.id}`}
            className="min-h-[100px] border rounded-md p-3"
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
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Amount due: <span data-testid={`form-payment-amount-${field?.id}`}>{formatPaymentAmount(amount, currency)}</span>
          </p>
          {effective.membership && (
            <p className="text-xs text-muted-foreground" data-testid={`form-payment-membership-context-${field?.id}`}>
              {[effective.membership.config_name, effective.membership.tier_label, effective.membership.membership_year]
                .filter(Boolean).join(' — ')}
            </p>
          )}
          {providers === null && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking payment options…
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {(usableProviders || []).map((p) => (
              <Button
                key={p.id}
                variant={p.id === 'stripe' ? 'default' : 'outline'}
                onClick={() => startPayment(p.id)}
                disabled={disabled || anyBusy}
                data-testid={`button-form-payment-${p.id}-${field?.id}`}
              >
                {creating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : p.id === 'stripe' ? (
                  <CreditCard className="mr-2 h-4 w-4" />
                ) : (
                  <Landmark className="mr-2 h-4 w-4" />
                )}
                {p.id === 'stripe'
                  ? `Pay ${formatPaymentAmount(amount, currency)} by card`
                  : 'Pay by Direct Debit'}
              </Button>
            ))}
          </div>
        </div>
      )}

      {disabled && disabledMessage && (
        <p className="text-sm text-destructive" data-testid="text-payment-disabled-message">{disabledMessage}</p>
      )}
    </div>
  );
}

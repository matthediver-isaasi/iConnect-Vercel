import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, CreditCard, AlertCircle, Landmark, Info } from "lucide-react";
import { resolveEffectivePayment } from "@/lib/formPaymentQuote";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";
import { SS_KEY, confirmFormPayment } from "@/lib/formPaymentReturn";

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
  // GoCardless Drop-in modal state: { flowId, environment, authorisationUrl }
  const [gcDropin, setGcDropin] = useState(null);

  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const submissionIdRef = useRef(null);

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

  // Task #3501: the redirect return legs (GoCardless redirect back, Stripe
  // 3DS redirect back) are handled at PAGE level via useFormPaymentReturn —
  // this component only mounts on the form's last step, so it can never see
  // a redirect return. This path only confirms the inline (non-redirect)
  // Stripe flow, through the same shared confirm helper.
  const confirmPayment = useCallback(async ({ submissionId, paymentIntentId = null }) => {
    setConfirming(true);
    setPaymentError(null);
    try {
      const out = await confirmFormPayment({ submissionId, paymentIntentId });
      if (out.status === 'pending') {
        setPaymentError('Your Direct Debit set-up is still being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.');
        return false;
      }
      if (out.status === 'error') {
        setPaymentError(out.error);
        return false;
      }
      onPaid?.(submissionId);
      return true;
    } finally {
      setConfirming(false);
    }
  }, [onPaid]);

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

  const startMonthlyCard = async () => {
    setPaymentError(null);
    const payload = await buildPayload();
    if (!payload) return;
    setCreating(true);
    try {
      const res = await fetch('/api/public/form-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'create_monthly_card', form_id: payload.form_id, submission_data: payload.submission_data,
          idempotency_key: idempotencyKey || undefined, prefill_organization_id: payload.prefill_organization_id || null,
          role_id: payload.role_id || null, return_path: `${window.location.pathname}${window.location.search}` }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to start monthly card set-up');
      if (!json.checkoutUrl) throw new Error('Could not start secure card checkout');
      try { sessionStorage.setItem(SS_KEY, json.submissionId); } catch { /* ignore */ }
      window.location.href = json.checkoutUrl;
    } catch (err) { setPaymentError(err.message); } finally { setCreating(false); }
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
    && (amount <= 0 || (usableProviders !== null
      && usableProviders.length === 0
      && !effective.membership?.monthly_card));

  return (
    <div className="space-y-3" data-testid={`form-payment-submit-${field?.id || 'unknown'}`}>
      {gcDropin && (
        <GoCardlessDropinFlow
          flowId={gcDropin.flowId}
          environment={gcDropin.environment}
          onSuccess={() => {
            setGcDropin(null);
            // Confirm server-side; a still-pending mandate shows the existing
            // "being confirmed, completes automatically" message.
            confirmPayment({ submissionId: submissionIdRef.current });
          }}
          onExit={() => {
            setGcDropin(null);
            setPaymentError('No Direct Debit was set up — you exited before completing the bank authorisation. Nothing has been charged. You can try again.');
          }}
          onLoadFailure={() => {
            // Fall back to the hosted redirect flow.
            window.location.href = gcDropin.authorisationUrl;
          }}
        />
      )}
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
             {effective.membership?.monthly_card && (
               <Button variant="outline" onClick={startMonthlyCard} disabled={disabled || anyBusy} data-testid={`button-form-payment-monthly-card-${field?.id}`}>
                 {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
                 {`Pay monthly by card — ${formatPaymentAmount(effective.membership.monthly_card.monthlyAmount, effective.membership.monthly_card.currency || currency)} × ${effective.membership.monthly_card.instalmentCount} (total ${formatPaymentAmount(effective.membership.monthly_card.planTotal, effective.membership.monthly_card.currency || currency)})`}
               </Button>
             )}
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

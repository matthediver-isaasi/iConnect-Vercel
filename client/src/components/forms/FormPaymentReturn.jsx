// Task #3501: page-level payment return-leg handling (hook + status screen).
//
// Mounted by BOTH form pages (FormView and EmbedForm) BEFORE any wizard/step
// state matters, so returning from a GoCardless hosted flow or a Stripe 3DS
// redirect always resolves — the old in-component handling only mounted on
// the form's last step, so a redirect return showed a blank cleared form.
import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Clock, XCircle, AlertCircle, Loader2 } from 'lucide-react';
import {
  parsePaymentReturn,
  stripPaymentParams,
  confirmFormPayment,
  loadPaymentSubmissionContext,
  savePaymentSubmissionContext,
  clearPaymentSubmissionContext,
} from '@/lib/formPaymentReturn';

export const PAYMENT_RETURN_POLL_DELAYS_MS = [1500, 3000, 5000];

function hasInitialPaymentReturn() {
  if (typeof window === 'undefined') return false;
  try {
    const stored = loadPaymentSubmissionContext();
    const decision = parsePaymentReturn(window.location.search, {
      storedSubmissionId: stored?.submissionId || null,
    });
    return decision.kind !== 'none' || !!(stored && !stored.legacy);
  } catch {
    return parsePaymentReturn(window.location.search).kind !== 'none';
  }
}

/**
 * Detects a payment return leg on mount, cleans the payment params off the
 * URL (so refresh never re-triggers), and runs the shared confirm call.
 *
 * Returns { active, status, error, dismiss }:
 *  - active: render the status screen instead of the form
 *  - status: 'confirming' | 'paid' | 'pending' | 'cancelled' | 'error'
 *  - dismiss(): return to the form (used from the cancelled/error screens)
 */
export function useFormPaymentReturn() {
  const [state, setState] = useState(() => {
    const detected = hasInitialPaymentReturn();
    return {
      active: detected,
      status: detected ? 'confirming' : null,
      provider: null,
      error: null,
      canRecheck: false,
      continuePath: null,
    };
  });
  const contextRef = useRef(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(null);

  const runConfirm = useCallback(async ({ manual = false } = {}) => {
    if (inFlightRef.current) return inFlightRef.current;
    const context = contextRef.current;
    if (!context) return;
    const operation = (async () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setState((previous) => ({
        ...previous,
        active: true,
        status: 'confirming',
        error: null,
        canRecheck: false,
      }));

      const out = await confirmFormPayment(context);
      if (!mountedRef.current) return;
      const provider = out.provider || null;
      const terminal = out.status === 'paid';
      if (terminal) {
        // Keep a short-lived, path-scoped receipt. Refreshing a verified
        // success must never reveal the payment form or issue another confirm;
        // this record contains only status/navigation metadata, never secrets.
        try {
          savePaymentSubmissionContext({
            submissionId: context.submissionId,
            // Preserve only the provider echoed by the authoritative confirm
            // response; the pre-redirect hint remains client-controlled.
            provider,
            returnPath: context.returnPath,
            continuePath: context.continuePath,
            terminalStatus: 'paid',
          });
        } catch { /* ignore */ }
        contextRef.current = null;
      }
      setState({
        active: true,
        status: out.status,
        provider,
        error: out.error || null,
        canRecheck: !terminal,
        continuePath: context.continuePath || null,
      });

      const shouldPoll = !manual && out.retryable
        && ['pending', 'finalizing', 'accounting_pending', 'blocked'].includes(out.status);
      if (shouldPoll && context.attempt < PAYMENT_RETURN_POLL_DELAYS_MS.length) {
        const delay = PAYMENT_RETURN_POLL_DELAYS_MS[context.attempt];
        context.attempt += 1;
        timerRef.current = setTimeout(() => runConfirm(), delay);
      }
    })();
    inFlightRef.current = operation;
    try {
      return await operation;
    } finally {
      if (inFlightRef.current === operation) inFlightRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Effects are intentionally restartable: React StrictMode runs setup,
    // cleanup, then setup again. The shared in-flight request is retained
    // across that probe, while mounted/timer ownership is re-established.
    mountedRef.current = true;

    let stored = null;
    try { stored = loadPaymentSubmissionContext(); } catch { /* ignore */ }
    const decision = parsePaymentReturn(window.location.search, {
      storedSubmissionId: stored?.submissionId || null,
    });
    const isReturn = decision.kind !== 'none';
    if (!isReturn && stored?.terminalStatus === 'paid') {
      // A terminal receipt restores the status UI without calling confirm
      // again. It remains bounded by loadPaymentSubmissionContext's scope and
      // expiry checks.
      setState({
        active: true,
        status: 'paid',
        provider: stored.provider || null,
        error: null,
        canRecheck: false,
        continuePath: stored.continuePath || null,
      });
      return undefined;
    }
    const resumable = !isReturn && stored && !stored.legacy;
    if (!isReturn && !resumable) return undefined;

    // Clean the payment params off the URL immediately — a refresh after
    // this point is an ordinary page load, never a re-confirm.
    // Preserve any #hash — Stripe's return_url is built from the full
    // current URL, so a fragment can legitimately survive the round trip.
    if (isReturn) {
      const cleaned = stripPaymentParams(window.location.search);
      window.history.replaceState({}, '', `${window.location.pathname}${cleaned}${window.location.hash || ''}`);
    }

    if (decision.kind === 'cancelled') {
      try { clearPaymentSubmissionContext(); } catch { /* ignore */ }
      setState({ active: true, status: 'cancelled', provider: stored?.provider || null, error: null, canRecheck: false, continuePath: stored?.continuePath || null });
      return undefined;
    }
    if (decision.kind === 'failed') {
      try { clearPaymentSubmissionContext(); } catch { /* ignore */ }
      setState({
        active: true,
        status: 'cancelled',
        provider: stored?.provider || null,
        error: 'Payment was not completed. Nothing has been confirmed as charged.',
        canRecheck: false,
        continuePath: stored?.continuePath || null,
      });
      return undefined;
    }
    if (decision.kind === 'orphan') {
      // Params present but no submission id recoverable — the background
      // reconciliation still finalizes it; show the safe pending copy.
      setState({ active: true, status: 'pending', provider: null, error: null, canRecheck: false, continuePath: null });
      return undefined;
    }

    const submissionId = resumable ? stored.submissionId : decision.submissionId;
    if (!contextRef.current || contextRef.current.submissionId !== submissionId) {
      contextRef.current = {
        submissionId,
        paymentIntentId: resumable ? null : decision.paymentIntentId,
        provider: (resumable ? stored.provider : decision.provider) || stored?.provider || null,
        attempt: 0,
        returnPath: stored?.returnPath || null,
        continuePath: stored?.continuePath || null,
      };
    }
    if (!resumable) {
      try {
        savePaymentSubmissionContext({
          submissionId: decision.submissionId,
            provider: decision.provider,
            returnPath: stored?.returnPath || null,
            continuePath: stored?.continuePath || null,
        });
      } catch { /* ignore */ }
    }
    runConfirm();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runConfirm]);

  const dismiss = useCallback(() => setState({
    active: false,
    status: null,
    provider: null,
    error: null,
    canRecheck: false,
    continuePath: null,
  }), []);
  const recheck = useCallback(() => runConfirm({ manual: true }), [runConfirm]);
  return { ...state, dismiss, recheck };
}

const SCREENS = {
  paid: {
    icon: CheckCircle2,
    iconClass: 'text-green-600',
    bubbleClass: 'bg-green-100',
    title: 'Payment received',
  },
  pending: {
    icon: Clock,
    iconClass: 'text-blue-600',
    bubbleClass: 'bg-blue-100',
    title: 'Checking payment status',
    body: 'Your payment or payment set-up is still being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.',
  },
  finalizing: {
    icon: Clock,
    iconClass: 'text-blue-600',
    bubbleClass: 'bg-blue-100',
    title: 'Finishing your submission',
    body: 'The payment provider step is complete. We are finishing the remaining submission updates automatically. Please do not pay again.',
  },
  accounting_pending: {
    icon: Clock,
    iconClass: 'text-blue-600',
    bubbleClass: 'bg-blue-100',
    title: 'Payment received — finishing submission',
    body: 'Your payment was verified. We are completing the remaining submission updates automatically. Please do not pay again.',
  },
  setup_complete: {
    icon: CheckCircle2,
    iconClass: 'text-green-600',
    bubbleClass: 'bg-green-100',
    title: 'Payment setup complete',
    body: 'Your recurring payment method has been set up. Your first collection has not yet been confirmed and will be recorded separately.',
  },
  blocked: {
    icon: AlertCircle,
    iconClass: 'text-amber-600',
    bubbleClass: 'bg-amber-100',
    title: 'Payment status needs attention',
    body: 'We could not finish checking this payment. Do not make another payment. You can safely check the same submission again.',
  },
  cancelled: {
    icon: XCircle,
    iconClass: 'text-slate-500',
    bubbleClass: 'bg-slate-100',
    title: 'Payment cancelled',
    body: 'The payment was cancelled and your form was not submitted. You can return to the form and try again.',
  },
  confirming: {
    icon: Loader2,
    iconClass: 'text-blue-600 animate-spin',
    bubbleClass: 'bg-blue-100',
    title: 'Confirming your payment…',
    body: 'One moment — verifying your payment with the provider.',
  },
};

/**
 * The status screen shown instead of the form on a payment return.
 *  - status/error: from useFormPaymentReturn
 *  - successMessage: the form's configured success copy (paid outcome)
 *  - onReturnToForm: dismiss back to the form (cancelled / error)
 *  - embedded: compact layout for the iframe page
 *  - continueHref/continueLabel: a safe non-payment destination. In an
 *    embedded form this stays inside the iframe, leaving the containing site's
 *    own chrome and navigation intact.
 *  - onContinue: optional same-origin parent navigation invoked by a user
 *    click; when absent the safe href is used (including `_blank` embeds).
 */
export function FormPaymentReturnScreen({
  status,
  provider,
  error,
  successMessage,
  onReturnToForm,
  onRecheck,
  canRecheck = false,
  embedded = false,
  continueHref = '/',
  continueLabel = 'Continue to site',
  continueTarget,
  continueRel,
  onContinue,
}) {
  const def = SCREENS[status] || SCREENS.confirming;
  const Icon = def.icon;
  const pendingBody = provider === 'gocardless'
    ? 'Your Direct Debit set-up is being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.'
    : provider === 'stripe_monthly_card'
      ? 'Your monthly card set-up is being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.'
      : def.body;
  const body = status === 'paid'
    ? (successMessage || 'Thank you — your payment was received and your submission is complete.')
    : error
      ? error
      : status === 'pending' ? pendingBody : def.body;
  const showReturn = status === 'cancelled' && onReturnToForm;
  // Never offer a completed, pending, or ambiguous payment back to the form:
  // that page contains payment controls and could invite a second attempt.
  const showContinue = status !== 'confirming' && status !== 'cancelled' && !!continueHref;

  const card = (
    <Card
      className={embedded ? 'w-full' : 'max-w-md w-full'}
      data-testid="payment-return-screen"
      data-payment-status={status || 'confirming'}
      data-payment-provider={provider || 'unknown'}
    >
      <CardContent className="p-10 text-center">
        <div className={`w-16 h-16 ${def.bubbleClass} rounded-full flex items-center justify-center mx-auto mb-4`}>
          <Icon className={`w-8 h-8 ${def.iconClass}`} />
        </div>
        <h3 className="text-xl font-semibold text-slate-900 mb-2" data-testid="payment-return-title">{def.title}</h3>
        {body && <p className="text-slate-600 whitespace-pre-line" data-testid="payment-return-body">{body}</p>}
        {showReturn && (
          <Button className="mt-6" variant="outline" onClick={onReturnToForm} data-testid="button-return-to-form">
            Return to form
          </Button>
        )}
        {canRecheck && onRecheck && status !== 'confirming' && (
          <Button className="mt-6" variant="outline" onClick={onRecheck} data-testid="button-payment-return-recheck">
            Check status again
          </Button>
        )}
        {showContinue && (
          onContinue ? (
            <Button className="mt-3" onClick={onContinue} data-testid="button-payment-return-continue">
              {continueLabel}
            </Button>
          ) : (
            <Button className="mt-3" asChild data-testid="button-payment-return-continue">
              <a href={continueHref} target={continueTarget} rel={continueRel}>{continueLabel}</a>
            </Button>
          )
        )}
      </CardContent>
    </Card>
  );

  if (embedded) return <div className="p-4">{card}</div>;
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
      {card}
    </div>
  );
}

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

export const PAYMENT_RETURN_STANDARD_POLL_DELAYS_MS = Object.freeze([1500, 3000, 5000]);
export const PAYMENT_RETURN_POLL_WINDOW_MS = 5 * 60 * 1000;
const EXTENDED_POLL_START_DELAYS_MS = [1500, 3000, 5000, 7500, 10000, 15000];

// Stripe's one-off reconciliation worker runs once per minute. Keep checking
// long enough to observe that worker, while still putting a hard upper bound
// on browser work. The first checks are deliberately quick; after that the
// browser backs off to a maximum of 15 seconds.
function buildExtendedPollDelays() {
  const delays = [];
  let elapsed = 0;
  while (elapsed < PAYMENT_RETURN_POLL_WINDOW_MS) {
    const delay = delays.length < EXTENDED_POLL_START_DELAYS_MS.length
      ? EXTENDED_POLL_START_DELAYS_MS[delays.length]
      : 15000;
    if (elapsed + delay > PAYMENT_RETURN_POLL_WINDOW_MS) break;
    delays.push(delay);
    elapsed += delay;
  }
  return delays;
}

export const PAYMENT_RETURN_POLL_DELAYS_MS = Object.freeze(buildExtendedPollDelays());
const EXTENDED_POLL_STATUSES = new Set(['finalizing', 'accounting_pending']);

function pollDelaysForStatus(status) {
  return EXTENDED_POLL_STATUSES.has(status)
    ? PAYMENT_RETURN_POLL_DELAYS_MS
    : PAYMENT_RETURN_STANDARD_POLL_DELAYS_MS;
}

const DEFAULT_PAYMENT_RETURN_STATE = {
  active: false,
  status: null,
  provider: null,
  presentationAccepted: false,
  directDebitCompleted: false,
  error: null,
  canRecheck: false,
  pollingPaused: false,
  continuePath: null,
};

function isCompletedDirectDebit(provider, status) {
  return provider === 'gocardless' && status === 'setup_complete';
}

/**
 * Read the return receipt before the first render. This is deliberately kept
 * synchronous: a paid receipt must not briefly render the payment form while
 * an effect is loading sessionStorage, and must not start a second confirm
 * when the provider included the same return query again.
 */
function readInitialPaymentReturn(windowObj = typeof window !== 'undefined' ? window : null) {
  if (!windowObj?.location) {
    return {
      state: DEFAULT_PAYMENT_RETURN_STATE,
      stored: null,
      decision: { kind: 'none' },
      isReturn: false,
      terminalReceipt: false,
      context: null,
    };
  }

  let stored = null;
  try {
    stored = loadPaymentSubmissionContext();
  } catch {
    stored = null;
  }

  const search = windowObj.location.search || '';
  const decision = parsePaymentReturn(search, {
    storedSubmissionId: stored?.submissionId || null,
  });
  const isReturn = decision.kind !== 'none';
  const returnedSubmissionId = new URLSearchParams(search).get('form_payment_submission');
  // A receipt is usable on an ordinary scoped refresh, or on a return URL
  // which names exactly the submission that produced it. A different
  // submission must never inherit another payment's terminal outcome.
  const receiptMatches = !!stored && !stored.legacy
    && (!isReturn
      || returnedSubmissionId === stored.submissionId
      // Stripe returns from older links may omit our submission parameter;
      // parsePaymentReturn can safely recover that id from this same scoped
      // receipt when the return still has a payment intent.
      || (decision.kind === 'confirm'
        && !returnedSubmissionId
        && decision.submissionId === stored.submissionId));
  const terminalReceipt = receiptMatches
    && (
      stored.presentationAccepted === true
      || stored.terminalStatus === 'paid'
      || stored.terminalStatus === 'attention'
    );
  const presentationAccepted = receiptMatches && stored.presentationAccepted === true;
  const resumable = !isReturn && !!stored && !stored.legacy;
  const visibleStatus = receiptMatches
    && stored.status
    && (stored.status !== 'paid' || terminalReceipt)
    ? stored.status
    : null;

  let state = DEFAULT_PAYMENT_RETURN_STATE;
  if (terminalReceipt) {
    state = {
      active: true,
      status: stored.status || stored.terminalStatus || 'paid',
      provider: stored.provider || null,
      presentationAccepted,
      directDebitCompleted: false,
      error: null,
      canRecheck: false,
      continuePath: stored.continuePath || null,
    };
  } else if (decision.kind === 'cancelled') {
    state = {
      active: true,
      status: 'cancelled',
      provider: stored?.provider || null,
      presentationAccepted: false,
      directDebitCompleted: false,
      error: null,
      canRecheck: false,
      continuePath: stored?.continuePath || null,
    };
  } else if (decision.kind === 'failed') {
    state = {
      active: true,
      status: 'failed',
      provider: stored?.provider || null,
      presentationAccepted: false,
      directDebitCompleted: false,
      error: 'Payment was not completed. Nothing has been confirmed as charged.',
      canRecheck: false,
      continuePath: stored?.continuePath || null,
    };
  } else if (decision.kind === 'orphan') {
    state = {
      active: true,
      status: 'pending',
      provider: null,
      presentationAccepted: false,
      directDebitCompleted: false,
      error: null,
      canRecheck: false,
      continuePath: null,
    };
  } else if (isReturn || resumable) {
    state = {
      active: true,
      status: visibleStatus || 'confirming',
      provider: stored?.provider || decision.provider || null,
      presentationAccepted: false,
      directDebitCompleted: isCompletedDirectDebit(
        stored?.provider || decision.provider || null,
        visibleStatus,
      ),
      error: null,
      canRecheck: !!visibleStatus
        && visibleStatus !== 'paid'
        && !isCompletedDirectDebit(stored?.provider || decision.provider || null, visibleStatus),
      continuePath: stored?.continuePath || null,
    };
  }

  const shouldConfirm = !terminalReceipt
    && decision.kind === 'confirm'
    && !!decision.submissionId;
  const shouldResume = !terminalReceipt && resumable;
  const context = shouldConfirm || shouldResume
    ? {
      submissionId: shouldResume ? stored.submissionId : decision.submissionId,
      paymentIntentId: shouldResume ? null : decision.paymentIntentId,
      provider: (shouldResume ? stored.provider : decision.provider)
        || stored?.provider
        || null,
      attempt: 0,
      returnPath: stored?.returnPath || null,
      continuePath: stored?.continuePath || null,
    }
    : null;

  return {
    state,
    stored,
    decision,
    isReturn,
    terminalReceipt,
    presentationAccepted,
    context,
  };
}

/**
 * Detects a payment return leg on mount, cleans the payment params off the
 * URL (so refresh never re-triggers), and runs the shared confirm call.
 *
 * Returns { active, status, error, dismiss }:
 *  - active: render the status screen instead of the form
 *  - status: 'confirming' | 'paid' | 'pending' | 'cancelled' | 'failed' | 'error'
 *  - dismiss(): return to the form (used from the cancelled/error screens)
 */
export function useFormPaymentReturn() {
  const initial = readInitialPaymentReturn();
  const [state, setState] = useState(() => initial.state);
  const stateRef = useRef(initial.state);
  const contextRef = useRef(initial.context);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(null);
  const requestSequenceRef = useRef(0);

  const updateState = useCallback((next) => {
    setState((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next;
      stateRef.current = resolved;
      return resolved;
    });
  }, []);

  const runConfirm = useCallback(async ({ manual = false } = {}) => {
    if (inFlightRef.current) return inFlightRef.current.promise;
    const context = contextRef.current;
    if (!context) return;
    // A user-requested check is an explicit new bounded window. This is
    // intentionally reset before the request so a previously exhausted
    // automatic window can schedule follow-up checks again.
    if (manual) context.attempt = 0;
    const requestSequence = ++requestSequenceRef.current;
    const isCurrent = () => mountedRef.current
      && contextRef.current === context
      && inFlightRef.current?.sequence === requestSequence;
    const operation = (async () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const previousStatus = stateRef.current.status;
      // Keep the last server-authoritative outcome visible while a bounded
      // poll or a refresh resume is in flight. A generic spinner is only
      // useful before the first outcome exists.
      const retainVisibleStatus = previousStatus && previousStatus !== 'confirming';
      updateState((previous) => ({
        ...previous,
        active: true,
        status: retainVisibleStatus ? previousStatus : 'confirming',
        error: retainVisibleStatus ? previous.error : null,
        canRecheck: false,
        pollingPaused: false,
      }));

      const out = await confirmFormPayment(context);
      if (!isCurrent()) return;
      const provider = out.provider || null;
      // The only accepted one-off presentation is a response that carries
      // both trusted Stripe identity and the explicit verified-payment bit.
      // URL/session provider hints and generic success/status fields are not
      // evidence. The response's provider and paymentSucceeded fields are the
      // acceptance inputs. A known monthly-card return keeps its established
      // lifecycle presentation even though that endpoint uses generic Stripe
      // provider terminology.
      const presentationAccepted = provider === 'stripe'
        && out.paymentSucceeded === true
        && context.provider !== 'stripe_monthly_card';
      // `attention` is terminal by design: a provider or processor may have
      // accepted an effect before its durable outcome was lost, so polling or
      // another browser confirmation must not replay it.
      const terminal = out.status === 'paid' || out.status === 'attention';
      const directDebitCompleted = isCompletedDirectDebit(provider, out.status);
      try {
        savePaymentSubmissionContext({
          submissionId: context.submissionId,
          // Only the server response is allowed to update the persisted
          // provider/status receipt.
          provider,
          returnPath: context.returnPath,
          continuePath: context.continuePath,
          status: out.status,
          terminalStatus: terminal ? out.status : null,
          presentationAccepted,
        });
      } catch { /* ignore */ }
      if (terminal || presentationAccepted) {
        // Keep a short-lived, path-scoped receipt. Refreshing a verified
        // success must never reveal the payment form or issue another confirm;
        // this record contains only status/navigation metadata, never secrets.
        contextRef.current = null;
      }
      updateState({
        active: true,
        status: out.status,
        provider,
        presentationAccepted,
        directDebitCompleted,
        error: out.error || null,
        canRecheck: !terminal && !presentationAccepted && !directDebitCompleted,
        pollingPaused: false,
        continuePath: context.continuePath || null,
      });

      const shouldPoll = !presentationAccepted
        && out.retryable
        && ['pending', 'finalizing', 'accounting_pending', 'blocked'].includes(out.status)
        // Keep the established pending Direct Debit / blocked manual flow;
        // only the Stripe finalization window needs to restart automatically.
        && (!manual || EXTENDED_POLL_STATUSES.has(out.status));
      const pollDelays = pollDelaysForStatus(out.status);
      if (shouldPoll && context.attempt < pollDelays.length) {
        const delay = pollDelays[context.attempt];
        context.attempt += 1;
        timerRef.current = setTimeout(() => {
          if (mountedRef.current && contextRef.current === context) runConfirm();
        }, delay);
      } else if (shouldPoll && EXTENDED_POLL_STATUSES.has(out.status)) {
        // The background worker may still finish this one-off payment, but
        // this tab must not poll forever. Keep the safe no-repay affordance
        // and tell the applicant why automatic checks have paused.
        updateState((previous) => ({ ...previous, pollingPaused: true }));
      }
    })();
    inFlightRef.current = { promise: operation, sequence: requestSequence };
    try {
      return await operation;
    } finally {
      if (inFlightRef.current?.sequence === requestSequence) inFlightRef.current = null;
    }
  }, [updateState]);

  useEffect(() => {
    // Effects are intentionally restartable: React StrictMode runs setup,
    // cleanup, then setup again. The shared in-flight request is retained
    // across that probe, while mounted/timer ownership is re-established.
    mountedRef.current = true;

    const snapshot = readInitialPaymentReturn();
    const {
      stored,
      decision,
      isReturn,
      terminalReceipt,
      presentationAccepted,
    } = snapshot;
    const cleanReturnUrl = () => {
      if (!isReturn) return;
      // Clean the payment params off the URL immediately — a refresh after
      // this point is an ordinary page load, never a re-confirm.
      // Preserve any #hash — Stripe's return_url is built from the full
      // current URL, so a fragment can legitimately survive the round trip.
      const cleaned = stripPaymentParams(window.location.search);
      window.history.replaceState({}, '', `${window.location.pathname}${cleaned}${window.location.hash || ''}`);
    };

    cleanReturnUrl();

    if (terminalReceipt) {
      // A terminal receipt wins even when the provider repeats the same
      // return URL. It is scoped and expiring, so no confirm is needed.
      contextRef.current = null;
      updateState({
        active: true,
        status: stored?.terminalStatus || 'paid',
        provider: stored?.provider || null,
        presentationAccepted,
        directDebitCompleted: false,
        error: null,
        canRecheck: false,
        continuePath: stored?.continuePath || null,
      });
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
      };
    }

    const resumable = !isReturn && stored && !stored.legacy;
    if (!isReturn && !resumable) {
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
      };
    }

    if (decision.kind === 'cancelled') {
      try { clearPaymentSubmissionContext(); } catch { /* ignore */ }
      updateState({
        active: true,
        status: 'cancelled',
        provider: stored?.provider || null,
        presentationAccepted: false,
        directDebitCompleted: false,
        error: null,
        canRecheck: false,
        continuePath: stored?.continuePath || null,
      });
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
      };
    }
    if (decision.kind === 'failed') {
      try { clearPaymentSubmissionContext(); } catch { /* ignore */ }
      updateState({
        active: true,
        status: 'failed',
        provider: stored?.provider || null,
        presentationAccepted: false,
        directDebitCompleted: false,
        error: 'Payment was not completed. Nothing has been confirmed as charged.',
        canRecheck: false,
        continuePath: stored?.continuePath || null,
      });
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
      };
    }
    if (decision.kind === 'orphan') {
      // Params present but no submission id recoverable — the background
      // reconciliation still finalizes it; show the safe pending copy.
      updateState({
        active: true,
        status: 'pending',
        provider: null,
        presentationAccepted: false,
        directDebitCompleted: false,
        error: null,
        canRecheck: false,
        continuePath: null,
      });
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
      };
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
      timerRef.current = null;
    };
  }, [runConfirm, updateState]);

  // Inline payment flows have already called the same server confirmation
  // helper before they reach this callback. Adopt that verified result into
  // the page-level screen so inline and hosted completions have identical
  // copy, continuation, scrolling, and iframe behaviour.
  const adoptCompletion = useCallback(({ submissionId, provider = null } = {}) => {
    if (!submissionId || !isCompletedDirectDebit(provider, 'setup_complete')) return;
    contextRef.current = {
      submissionId,
      paymentIntentId: null,
      provider,
      attempt: 0,
      returnPath: null,
      continuePath: null,
    };
    updateState({
      active: true,
      status: 'setup_complete',
      provider,
      presentationAccepted: false,
      directDebitCompleted: true,
      error: null,
      canRecheck: false,
      continuePath: null,
    });
  }, [updateState]);

  const adoptPaymentAcceptance = useCallback(({
    submissionId,
    provider = null,
    status = 'paid',
    paymentSucceeded = false,
  } = {}) => {
    if (!submissionId || provider !== 'stripe' || paymentSucceeded !== true) return;
    let stored = null;
    try { stored = loadPaymentSubmissionContext(); } catch { /* ignore */ }
    try {
      savePaymentSubmissionContext({
        submissionId,
        provider,
        status,
        terminalStatus: ['paid', 'attention'].includes(status) ? status : null,
        returnPath: stored?.returnPath || null,
        continuePath: stored?.continuePath || null,
        presentationAccepted: true,
      });
    } catch { /* ignore */ }
    contextRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    updateState({
      active: true,
      status,
      provider,
      presentationAccepted: true,
      directDebitCompleted: false,
      error: null,
      canRecheck: false,
      pollingPaused: false,
      continuePath: stored?.continuePath || null,
    });
  }, [updateState]);

  const dismiss = useCallback(() => {
    contextRef.current = null;
    requestSequenceRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    updateState({ ...DEFAULT_PAYMENT_RETURN_STATE });
  }, [updateState]);
  const recheck = useCallback(() => runConfirm({ manual: true }), [runConfirm]);
  return { ...state, dismiss, recheck, adoptCompletion, adoptPaymentAcceptance };
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
    title: 'Payment received — finishing submission',
    body: 'Your payment was verified. We are finishing the remaining submission updates automatically. Please do not pay again.',
  },
  accounting_pending: {
    icon: Clock,
    iconClass: 'text-blue-600',
    bubbleClass: 'bg-blue-100',
    title: 'Payment received — finishing submission',
    body: 'Your payment was verified. We are completing the remaining submission updates automatically. Please do not pay again.',
  },
  attention: {
    icon: AlertCircle,
    iconClass: 'text-amber-600',
    bubbleClass: 'bg-amber-100',
    title: 'Payment received — submission needs attention',
    body: 'Your payment was verified, but we could not safely confirm a remaining submission update. Please do not pay again. Our team can review the submission.',
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
  failed: {
    icon: XCircle,
    iconClass: 'text-slate-500',
    bubbleClass: 'bg-slate-100',
    title: 'Payment not completed',
    body: 'The payment was not completed. Nothing has been confirmed as charged. You can return to the form and try again.',
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
  presentationAccepted = false,
  error,
  successMessage,
  onReturnToForm,
  onRecheck,
  canRecheck = false,
  pollingPaused = false,
  embedded = false,
  continueHref = '/',
  continueLabel = 'Continue to site',
  continueTarget,
  continueRel,
  onContinue,
}) {
  const def = SCREENS[status] || SCREENS.confirming;
  const displayDef = presentationAccepted ? SCREENS.paid : def;
  const Icon = displayDef.icon;
  const directDebitCompleted = provider === 'gocardless' && status === 'setup_complete';
  const pendingBody = provider === 'gocardless'
    ? 'Your Direct Debit set-up is being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.'
    : provider === 'stripe_monthly_card'
      ? 'Your monthly card set-up is being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.'
      : def.body;
  const pausedBody = status === 'accounting_pending'
    ? 'We are still waiting for the remaining submission updates. Automatic status checks are paused for now. Do not pay again. Choose “Check status again” to start another check window.'
    : 'We are still waiting for payment finalization. Automatic status checks are paused for now. Do not pay again. Choose “Check status again” to start another check window.';
  const body = presentationAccepted
    ? 'Thank you. Your payment has been received and your application has been submitted. We’ll email you with the next steps and login instructions when your membership is ready. You can now leave this page.'
    : directDebitCompleted
    ? 'Your application has been submitted and your Direct Debit is set up.\nYour first payment will be collected separately.\nYou can now leave this page.'
    : status === 'paid'
    ? (successMessage || 'Thank you — your payment was received and your submission is complete.')
    : pollingPaused && EXTENDED_POLL_STATUSES.has(status)
      ? pausedBody
      : error
      ? error
      : status === 'pending' ? pendingBody : def.body;
  const title = presentationAccepted
    ? 'Payment received — application submitted'
    : directDebitCompleted ? 'Application submitted' : def.title;
  const showReturn = ['cancelled', 'failed'].includes(status) && onReturnToForm;
  // Never offer a completed, pending, or ambiguous payment back to the form:
  // that page contains payment controls and could invite a second attempt.
  const showContinue = !['confirming', 'cancelled', 'failed'].includes(status) && !!continueHref;

  const card = (
    <Card
      className={embedded ? 'w-full' : 'max-w-md w-full'}
      data-testid="payment-return-screen"
      data-payment-status={status || 'confirming'}
      data-payment-provider={provider || 'unknown'}
    >
      <CardContent className="p-10 text-center">
        <div className={`w-16 h-16 ${displayDef.bubbleClass} rounded-full flex items-center justify-center mx-auto mb-4`}>
          <Icon className={`w-8 h-8 ${displayDef.iconClass}`} />
        </div>
        <h3 className="text-xl font-semibold text-slate-900 mb-2" data-testid="payment-return-title">{title}</h3>
        {body && <p className="text-slate-600 whitespace-pre-line" data-testid="payment-return-body">{body}</p>}
        {showReturn && (
          <Button className="mt-6" variant="outline" onClick={onReturnToForm} data-testid="button-return-to-form">
            Return to form
          </Button>
        )}
        {canRecheck && onRecheck && status !== 'confirming' && !directDebitCompleted && (
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

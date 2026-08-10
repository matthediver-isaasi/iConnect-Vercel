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
  SS_KEY,
  parsePaymentReturn,
  stripPaymentParams,
  confirmFormPayment,
} from '@/lib/formPaymentReturn';

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
  const [state, setState] = useState({ active: false, status: null, error: null });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let stored = null;
    try { stored = sessionStorage.getItem(SS_KEY); } catch { /* ignore */ }
    const decision = parsePaymentReturn(window.location.search, { storedSubmissionId: stored });
    if (decision.kind === 'none') return;

    // Clean the payment params off the URL immediately — a refresh after
    // this point is an ordinary page load, never a re-confirm.
    // Preserve any #hash — Stripe's return_url is built from the full
    // current URL, so a fragment can legitimately survive the round trip.
    const cleaned = stripPaymentParams(window.location.search);
    window.history.replaceState({}, '', `${window.location.pathname}${cleaned}${window.location.hash || ''}`);

    if (decision.kind === 'cancelled') {
      setState({ active: true, status: 'cancelled', error: null });
      return;
    }
    if (decision.kind === 'failed') {
      setState({ active: true, status: 'error', error: 'Payment was not completed. Please try again.' });
      return;
    }
    if (decision.kind === 'orphan') {
      // Params present but no submission id recoverable — the background
      // reconciliation still finalizes it; show the safe pending copy.
      setState({ active: true, status: 'pending', error: null });
      return;
    }

    setState({ active: true, status: 'confirming', error: null });
    confirmFormPayment({ submissionId: decision.submissionId, paymentIntentId: decision.paymentIntentId })
      .then((out) => {
        if (out.status === 'paid') setState({ active: true, status: 'paid', error: null });
        else if (out.status === 'pending') setState({ active: true, status: 'pending', error: null });
        else setState({ active: true, status: 'error', error: out.error });
      });
  }, []);

  const dismiss = useCallback(() => setState({ active: false, status: null, error: null }), []);
  return { ...state, dismiss };
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
    title: 'Direct Debit being confirmed',
    body: 'Your Direct Debit set-up is being confirmed. You can safely close this page — your submission completes automatically once it is confirmed.',
  },
  cancelled: {
    icon: XCircle,
    iconClass: 'text-slate-500',
    bubbleClass: 'bg-slate-100',
    title: 'Payment cancelled',
    body: 'The payment was cancelled and your form was not submitted. You can return to the form and try again.',
  },
  error: {
    icon: AlertCircle,
    iconClass: 'text-amber-600',
    bubbleClass: 'bg-amber-100',
    title: 'Confirmation problem',
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
 */
export function FormPaymentReturnScreen({ status, error, successMessage, onReturnToForm, embedded = false }) {
  const def = SCREENS[status] || SCREENS.confirming;
  const Icon = def.icon;
  const body = status === 'paid'
    ? (successMessage || 'Thank you — your payment was received and your submission is complete.')
    : status === 'error'
      ? error
      : def.body;
  const showReturn = (status === 'cancelled' || status === 'error') && onReturnToForm;

  const card = (
    <Card className={embedded ? 'w-full' : 'max-w-md w-full'} data-testid="payment-return-screen">
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

import React, { useMemo, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/button';

function CheckoutCardForm({ amount, returnUrl, markSubmitted, onFinished, disabled }) {
  const stripe = useStripe();
  const elements = useElements();
  const submitted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (submitted.current || !stripe || !elements || !ready || disabled) return;
    submitted.current = true;
    setBusy(true);
    markSubmitted();
    try {
      const result = await stripe.confirmPayment({
        elements, confirmParams: { return_url: returnUrl }, redirect: 'if_required',
      });
      // Even a Stripe success is not a registration confirmation. The server
      // must verify payment evidence and commit the original aggregate order.
      await onFinished(result.error?.message || '');
    } catch {
      await onFinished('The card payment outcome could not be verified.');
    }
  }
  return <form onSubmit={submit} className="event-funnel-checkout__panel" aria-label="Secure card payment">
    <p className="event-funnel-checkout__muted">Card details are handled securely by Stripe.</p>
    {!ready && !loadError && <div className="event-reservation-loading" role="status">
      <span aria-hidden="true" /><span aria-hidden="true" /><p>Loading secure card fields…</p>
    </div>}
    <PaymentElement onReady={() => setReady(true)} onLoadError={() => setLoadError('Secure card fields could not be loaded. Reload the page, or choose a different payment method.')} />
    {loadError && <p role="alert">{loadError}</p>}
    <Button type="submit" disabled={!stripe || !elements || !ready || busy || disabled || Boolean(loadError)}>
      {busy ? 'Checking payment…' : `Pay ${amount}`}
    </Button>
  </form>;
}

export default function EventFunnelCheckoutPayment({ payment, ...props }) {
  const stripe = useMemo(() => loadStripe(payment.publishableKey), [payment.publishableKey]);
  return <Elements stripe={stripe} options={{ clientSecret: payment.clientSecret }}>
    <CheckoutCardForm {...props} />
  </Elements>;
}

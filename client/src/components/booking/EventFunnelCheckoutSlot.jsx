import React, { useEffect, useRef, useState } from 'react';
import EventFunnelInvoices from './EventFunnelInvoices';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invoiceAddressDraft } from '@/lib/eventInvoiceAddress.mjs';
import UnifiedBookingCustomer from './UnifiedBookingCustomer';
import EventFunnelCheckoutFunding from './EventFunnelCheckoutFunding';
import EventFunnelCheckoutPayment from './EventFunnelCheckoutPayment';
import { checkoutTerminal, useEventFunnelCheckout } from './useEventFunnelCheckout';
import './EventReservationIntegration.css';
import './EventFunnelCheckout.css';

const methodNames = { card: 'Card', account: 'Invoice to account', public_invoice_po: 'Invoice / PO', free: 'No payment required' };
const canPay = state => ['pending', 'prepared', 'payable', 'requires_payment_method', 'requires_confirmation', 'requires_action'].includes(state);
const quoteSignature = quote => JSON.stringify({
  revision: quote.revision, currency: quote.currency, payableMinor: quote.payableMinor,
  paymentMethod: quote.paymentMethod, invoiceMode: quote.invoiceMode,
  paymentMethods: [...quote.paymentMethods].sort(),
  trainingFundMinor: quote.trainingFundMinor, voucherMinor: quote.voucherMinor,
  lines: [...quote.lines].sort((first, second) => `${first.nodeId}:${first.ticketId}`.localeCompare(`${second.nodeId}:${second.ticketId}`)),
});
function initialDraft(summary) {
  const choice = summary.customers[0];
  return {
    customer: choice ? { kind: choice.kind, id: choice.id,
      address: invoiceAddressDraft(choice.invoicingAddress || summary.personalAddress) } : { kind: 'guest', address: {} },
    paymentMethod: summary.totalMinor === 0 ? 'free' : summary.paymentMethods.find(method => method !== 'free') || '',
    purchaseOrderNumber: '', training: '', voucherIds: [],
  };
}

// The reservation parent mounts this explicitly outside the event-editing
// fieldset. Recovery stays usable even when event details are disabled/inert.
export function EventFunnelCheckoutSlot(props) {
  return <OwnedCheckout key={props.snapshot.session.id} {...props} />;
}

function OwnedCheckout({ snapshot, change, refresh, checkoutEligibility }) {
  const eligibilityRef = useRef(checkoutEligibility);
  eligibilityRef.current = checkoutEligibility;
  const canSubmitNow = () => eligibilityRef.current?.allowed === true
    && eligibilityRef.current.canSubmitNow?.() === true;
  const checkout = useEventFunnelCheckout(snapshot.session.id, snapshot.session.revision, refresh, canSubmitNow);
  const { summary, order, busy, error } = checkout;
  const [draft, setDraft] = useState(null);
  const [review, setReview] = useState(null);
  const [quotedMethods, setQuotedMethods] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const [cancelRequested, setCancelRequested] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const confirmationLock = useRef(false);
  const initialized = useRef(false);
  const draftVersion = useRef(0);
  useEffect(() => {
    if (summary && !initialized.current) {
      initialized.current = true;
      setDraft(initialDraft(summary));
    } else if (summary && quotedMethods?.revision !== summary.revision) {
      // Re-reserving can change the unfunded methods. Do not leave a stale,
      // previously funding-only method selected in a newly verified summary.
      setDraft(previous => previous && !summary.paymentMethods.includes(previous.paymentMethod)
        ? { ...previous, paymentMethod: initialDraft(summary).paymentMethod } : previous);
    }
  }, [summary, quotedMethods?.revision]);
  // A journey change always invalidates review, even if a later summary has
  // the same total. Attendee and customer changes matter as much as amounts.
  useEffect(() => {
    draftVersion.current += 1;
    setReview(null);
    setAccepted(false);
  }, [snapshot.session.revision]);
  const eligible = checkoutEligibility?.allowed === true;
  useEffect(() => {
    if (!eligible) {
      draftVersion.current += 1;
      setReview(null);
      setAccepted(false);
    }
  }, [eligible]);

  const money = amount => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: summary?.currency || order?.currency || 'GBP',
  }).format(amount / 100);
  const edit = patch => {
    if (order || busy || finalizing || checkout.fence || !canSubmitNow()) return;
    draftVersion.current += 1;
    const methodOnly = Object.keys(patch).length === 1 && 'paymentMethod' in patch;
    if (!methodOnly) setQuotedMethods(null);
    setDraft(previous => ({
      ...previous, ...patch,
      ...(!methodOnly && !summary.paymentMethods.includes(previous.paymentMethod)
        ? { paymentMethod: initialDraft(summary).paymentMethod } : {}),
    }));
    setReview(null);
    setAccepted(false);
    setMessage('');
  };
  const currentSummary = summary && summary.revision === snapshot.session.revision;
  const editable = !order && !checkout.fence && currentSummary && summary.atCheckout
    && snapshot.session.state === 'held' && eligible;
  const blocked = Boolean(busy || finalizing || checkout.cardSubmitting);
  function command() {
    const training = summary.memberFunding && summary.trainingFund?.enabled ? draft.training.trim() : '';
    if (training && !/^\d+(?:\.\d{1,2})?$/.test(training)) {
      setMessage('Enter the training fund amount using no more than two decimal places.');
      return null;
    }
    const trainingFundMinor = training ? Math.round(Number(training) * 100) : 0;
    if (!Number.isSafeInteger(trainingFundMinor) || trainingFundMinor > (summary.trainingFund?.availableMinor || 0)) {
      setMessage('The training fund amount is higher than the available balance.');
      return null;
    }
    if (!draft.paymentMethod) { setMessage('No payment method has been verified for this reservation. Check its status before continuing.'); return null; }
    if (summary.memberFunding && !summary.customers.some(choice => choice.kind === draft.customer.kind && choice.id === draft.customer.id)) {
      setMessage('Select a verified invoice customer before reviewing your quote.');
      return null;
    }
    return {
      expectedRevision: summary.revision, paymentMethod: draft.paymentMethod,
      customer: draft.customer, purchaseOrderNumber: draft.purchaseOrderNumber,
      trainingFundMinor, voucherIds: summary.memberFunding ? draft.voucherIds : [],
    };
  }
  async function reviewQuote(event) {
    event.preventDefault();
    if (!editable || blocked || !canSubmitNow()) return;
    setMessage('');
    setAccepted(false);
    setReview(null);
    const requested = command();
    if (!requested) return;
    const version = draftVersion.current;
    const quote = await checkout.quote(requested);
    if (quote && version === draftVersion.current && canSubmitNow()) {
      setQuotedMethods({ revision: quote.revision, methods: quote.paymentMethods });
      setDraft(previous => ({ ...previous, paymentMethod: quote.paymentMethod }));
      setReview({ quote, command: { ...requested, paymentMethod: quote.paymentMethod }, version });
      setMessage('Quote ready. Review the amounts and payment method below before confirming.');
    }
  }
  async function confirm() {
    if (!review || !accepted || !editable || blocked || confirmationLock.current || !canSubmitNow()) return;
    confirmationLock.current = true;
    setFinalizing(true);
    setMessage('');
    try {
      const finalCommand = { ...review.command, paymentMethod: review.quote.paymentMethod };
      // Fresh, read-only quote immediately before preparing. Any change is
      // shown for review; it is never silently accepted on the user's behalf.
      const fresh = await checkout.quote(finalCommand);
      if (!fresh) { setReview(null); setAccepted(false); return; }
      if (draftVersion.current !== review.version || !canSubmitNow()) return;
      setQuotedMethods({ revision: fresh.revision, methods: fresh.paymentMethods });
      setDraft(previous => ({ ...previous, paymentMethod: fresh.paymentMethod }));
      if (quoteSignature(fresh) !== quoteSignature(review.quote)) {
        setReview({ quote: fresh, command: { ...finalCommand, paymentMethod: fresh.paymentMethod }, version: review.version });
        setAccepted(false);
        setMessage('Your quote changed. Review the updated amounts and confirm again if you wish to continue.');
        return;
      }
      const prepared = await checkout.prepare({
        ...finalCommand, paymentMethod: fresh.paymentMethod, submissionAccepted: true,
        expectedPayableMinor: fresh.payableMinor,
      });
      if (!prepared) {
        setReview(null);
        setAccepted(false);
      }
      // Non-card methods require server reconciliation too. Card payment
      // instructions are obtained separately for this exact order.
      if (prepared && prepared.paymentMethod !== 'card') await checkout.status();
    } finally {
      confirmationLock.current = false;
      setFinalizing(false);
    }
  }
  async function checkOriginal() {
    setReview(null);
    setAccepted(false);
    setMessage('');
    if (order) await checkout.status();
    else await checkout.reload();
    await refresh();
  }
  async function returnToReservation() {
    setReview(null);
    setAccepted(false);
    setMessage('');
    setCancelRequested(false);
    const result = await checkout.returnToReservation();
    if (result?.returned) {
      draftVersion.current += 1;
      setDraft(initialDraft(result.summary));
      setQuotedMethods(null);
      setMessage('The original checkout has ended and no active order remains. Review your reservation and request a new quote before submitting revised choices.');
    }
  }

  const quote = review?.version === draftVersion.current && currentSummary ? review.quote : null;
  const paymentMethods = quotedMethods?.revision === snapshot.session.revision
    ? quotedMethods.methods : summary?.paymentMethods || [];
  const uncertain = checkout.fence.startsWith('submitted:') || checkout.fence.startsWith('uncertain:');
  const confirmed = order?.state === 'confirmed';
  // Remove provider return parameters, retaining the exact owned session route.
  const returnUrl = new URL(window.location.href);
  ['payment_intent', 'payment_intent_client_secret', 'redirect_status'].forEach(key => returnUrl.searchParams.delete(key));

  return <section className="event-funnel-checkout" aria-labelledby="reservation-checkout-heading"
    data-testid="event-funnel-checkout" data-session-state={snapshot.session.state}
    data-checkout-eligible={eligible} aria-busy={blocked}>
    <header>
      <div className="flex items-center gap-2"><ShieldCheck size={19} aria-hidden="true" />
        <h3 id="reservation-checkout-heading">{confirmed ? 'Booking confirmed' : order ? 'Your original checkout' : 'Review and confirm your reservation'}</h3>
      </div>
      <p className="event-funnel-checkout__muted mt-2">{confirmed
        ? 'Your payment or invoice submission has been verified and your event bookings are confirmed.'
        : 'Your event tickets and optional extras are checked together. A quote does not confirm a booking or take payment.'}</p>
    </header>

    {error && <div className="event-funnel-checkout__notice" data-error="true" role="alert" data-testid="event-funnel-checkout-error">
      <h4>{error.code === 'CHECKOUT_NOT_READY' ? 'Checkout is not available yet' : 'Checkout needs checking'}</h4>
      <p>{error.code === 'CHECKOUT_NOT_READY'
        ? 'This reservation cannot be submitted while checkout activation is closed. No booking or payment has been confirmed here. Your reservation timer still applies.'
        : error.message}</p>
      <Button type="button" variant="outline" className="mt-3" disabled={blocked} onClick={checkOriginal}>Check original checkout</Button>
    </div>}
    {message && <p className="event-funnel-checkout__notice" role="status">{message}</p>}

    {!summary && !error && <div className="event-reservation-loading" role="status">
      <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><p>Checking checkout details…</p>
    </div>}

    {order && <section className="event-funnel-checkout__panel" aria-label="Original order status">
      <h4>{confirmed ? 'Your places are booked' : order.state === 'cancelled' ? 'Reservation cancelled'
        : order.state === 'failed' ? 'Original checkout has stopped' : 'Your booking is not confirmed yet'}</h4>
      <p className="event-funnel-checkout__reference">Order reference: {order.id}</p>
      {confirmed && <EventFunnelInvoices sessionId={snapshot.session.id} orderId={order.id} />}
      <p><strong>{methodNames[order.paymentMethod] || 'Original payment method'}</strong>
        {Number.isSafeInteger(order.payableMinor) && <> · {money(order.payableMinor)}</>}</p>
      {!confirmed && <p className="event-funnel-checkout__muted">{order.state === 'cancelled'
        ? 'The server has verified this cancellation. Check the reservation for its latest state.'
        : 'Your choices are locked to this original order. Do not start a second checkout or make a separate payment. Check this order and only use a verified resume action when offered.'}</p>}
      {!checkoutTerminal(order.state) && <div className="event-funnel-checkout__actions">
        <Button type="button" variant="outline" onClick={() => checkout.status()} disabled={blocked}>Check booking status</Button>
        {order.paymentMethod === 'card' && canPay(order.state) && (!uncertain || checkout.canResumePayment) && !checkout.payment
          && <Button type="button" onClick={() => checkout.startPayment()} disabled={blocked}
            data-testid="event-funnel-resume-payment">{checkout.canResumePayment ? 'Resume verified original card payment' : 'Continue original card payment'}</Button>}
        <Button type="button" variant="ghost" disabled={blocked} onClick={() => setCancelRequested(true)}>Request cancellation</Button>
      </div>}
      {checkout.canResumePayment && !checkout.payment && <p className="event-funnel-checkout__notice" role="status">
        The server has verified that this same original card payment can be resumed. Resuming opens its payment details for your explicit confirmation; it does not create a new order.
      </p>}
      {checkout.canReturnToReservation && <div className="event-funnel-checkout__actions">
        <Button type="button" variant="outline" disabled={blocked} onClick={returnToReservation}
          data-testid="event-funnel-return-reservation">Return to reservation</Button>
        <p className="event-funnel-checkout__muted">We will verify that this checkout has ended and no active order remains before unlocking revised choices.</p>
      </div>}
      {cancelRequested && !checkoutTerminal(order.state) && <div className="event-funnel-checkout__notice" role="group" aria-label="Confirm cancellation request">
        <h4>Cancel this original checkout?</h4>
        <p>The server must check any payment before cancelling. Places will not be released here unless cancellation is verified. An already completed payment may finish the booking instead.</p>
        <div className="event-funnel-checkout__actions mt-3">
          <Button type="button" variant="destructive" disabled={blocked} onClick={async () => {
            await checkout.cancel(); setCancelRequested(false);
          }}>Request server cancellation</Button>
          <Button type="button" variant="outline" disabled={blocked} onClick={() => setCancelRequested(false)}>Keep checkout</Button>
        </div>
      </div>}
      <p role="status" aria-live="polite" data-testid="event-funnel-order-state">
        {confirmed ? 'Confirmed' : `Server status: ${order.state.replaceAll('_', ' ')}`}
      </p>
    </section>}

    {checkout.payment && order && (!uncertain || checkout.cardSubmitting) && !checkoutTerminal(order.state) && <EventFunnelCheckoutPayment
      key={order.id} payment={checkout.payment} amount={money(order.payableMinor)} returnUrl={returnUrl.href}
      markSubmitted={checkout.markSubmitted} onFinished={checkout.paymentFinished} disabled={blocked || cancelRequested} />}

    {!order && checkout.fence && <div className="event-funnel-checkout__notice" role="status">
      <h4>Recover your original submission</h4>
      <p>The result of an earlier submission has not been verified. Do not submit or pay again. Check for the original order, or contact support with reservation reference {snapshot.session.id} if it remains unavailable.</p>
      <Button type="button" variant="outline" className="mt-3" onClick={checkOriginal} disabled={blocked}>Recover original checkout</Button>
      {checkout.canReturnToReservation && <Button type="button" variant="ghost" className="mt-3"
        onClick={returnToReservation} disabled={blocked}>Return to reservation</Button>}
    </div>}

    {summary && draft && <div className="event-funnel-checkout__columns">
      {!order && <form onSubmit={reviewQuote} className="event-funnel-checkout__fields" aria-label="Checkout details">
        <fieldset className="event-funnel-checkout__fields" disabled={!editable || blocked}>
          <legend className="sr-only">Invoice and funding choices</legend>
          {summary.incomplete && <p className="event-funnel-checkout__notice">Some invoice customers could not be verified. Only verified customers are listed. You can check the reservation again before proceeding.</p>}
          <UnifiedBookingCustomer choices={summary.customers} value={draft.customer} onChange={customer => edit({ customer })}
            guest={!summary.memberFunding} required={summary.totalMinor > 0} />
          <section className="event-funnel-checkout__panel">
            <h4>Payment method</h4>
            {paymentMethods.length === 1 && paymentMethods[0] === 'free' ? <p>No payment is required. Your booking still needs final confirmation.</p>
              : <label className="event-funnel-checkout__label">Pay any remaining balance by
                <select value={draft.paymentMethod} onChange={event => edit({ paymentMethod: event.target.value })} required>
                  {!draft.paymentMethod && <option value="">No verified payment method</option>}
                  {paymentMethods.filter(method => methodNames[method]).map(method =>
                    <option key={method} value={method}>{methodNames[method]}</option>)}
                </select>
              </label>}
            <label className="event-funnel-checkout__label">Purchase order number (optional)
              <input value={draft.purchaseOrderNumber} maxLength={250} onChange={event => edit({ purchaseOrderNumber: event.target.value })} />
            </label>
            <p className="event-funnel-checkout__muted">If member funding covers the full quote, no payment will be required. Review the final method before confirming.</p>
          </section>
          {summary.memberFunding && <EventFunnelCheckoutFunding summary={summary} session={snapshot.session}
            value={draft} onChange={edit} money={money} />}
          <Button type="submit" disabled={!editable || blocked || summary.lines.length === 0}>
            {busy === 'quote' ? 'Checking quote…' : 'Review final quote'}
          </Button>
        </fieldset>
        {!editable && !checkout.fence && <p className="event-funnel-checkout__notice" role="status">
          {checkoutEligibility?.reason || 'Checkout requires a current held reservation at the checkout step. Use the reservation controls to check availability or return to your event details.'}
        </p>}
      </form>}

      <section className="event-funnel-checkout__panel" aria-label="Reservation summary">
        <h4>{quote ? 'Your final quote' : 'Your saved selections'}</h4>
        {summary.lines.length === 0 ? <p>No ticket selections could be verified. Return to the event details in your reservation.</p>
          : <ul className="event-funnel-checkout__lines">{summary.lines.map(line => {
            const priced = quote?.lines.find(item => item.nodeId === line.nodeId && item.ticketId === line.ticketId);
            return <li className="event-funnel-checkout__line" key={`${line.nodeId}:${line.ticketId}`}>
              <div><strong>{line.eventTitle}</strong><p className="event-funnel-checkout__muted">{line.quantity} × {line.ticketName}</p>
                {priced && <p className="event-funnel-checkout__muted">
                  Tickets {money(priced.amountMinor)} · Training fund {money(priced.trainingFundMinor || 0)} · Vouchers {money(priced.voucherMinor || 0)}
                </p>}</div>
              {priced && <span className="event-funnel-checkout__amount">{money(priced.payableMinor)}</span>}
            </li>;
          })}</ul>}
        <dl className="event-funnel-checkout__totals">
          <div><dt>Ticket total</dt><dd className="event-funnel-checkout__amount">{money(summary.totalMinor)}</dd></div>
          {quote && <>
            <div><dt>Training fund</dt><dd>−{money(quote.trainingFundMinor)}</dd></div>
            <div><dt>Voucher credit</dt><dd>−{money(quote.voucherMinor)}</dd></div>
            <div><dt>Amount payable</dt><dd className="event-funnel-checkout__amount">{money(quote.payableMinor)}</dd></div>
          </>}
        </dl>
        {quote ? <>
          <p><strong>{methodNames[quote.paymentMethod]}</strong>
            {quote.invoiceMode && <span className="event-funnel-checkout__muted"> · Invoice: {quote.invoiceMode.replaceAll('_', ' ')}</span>}</p>
          <p className="event-funnel-checkout__muted">Billed to {summary.customers.find(choice => choice.kind === draft.customer.kind && choice.id === draft.customer.id)?.name || 'you'}.
            {draft.purchaseOrderNumber && <> PO: {draft.purchaseOrderNumber}.</>}</p>
          <label className="event-funnel-checkout__choice">
            <input type="checkbox" checked={accepted} disabled={blocked || !editable} onChange={event => setAccepted(event.target.checked)} />
            <span>I have reviewed these event selections, invoice details, funding and amount payable. I agree to submit this reservation using the payment method shown.</span>
          </label>
          <Button type="button" onClick={confirm} disabled={!accepted || !editable || blocked} data-testid="event-funnel-confirm">
            {finalizing ? 'Verifying your submission…' : quote.paymentMethod === 'card' ? 'Confirm and continue to card payment' : 'Confirm and submit reservation'}
          </Button>
          <p className="event-funnel-checkout__muted">We check this quote again before submitting. Any changes must be reviewed before confirmation.</p>
        </> : !order && <p className="event-funnel-checkout__muted">Review a final quote to check funding, invoice instructions and the exact amount payable. Nothing has been submitted.</p>}
      </section>
    </div>}
    <footer className="event-funnel-checkout__actions">
      <Button type="button" variant="outline" disabled={blocked} onClick={checkOriginal}>Check reservation status</Button>
      {!order && !checkout.fence && snapshot.session.journey?.checkoutNow && <Button type="button" variant="ghost"
        disabled={blocked || !editable} onClick={async () => { setReview(null); setAccepted(false); await change({ type: 'resume_offers' }); }}>
        Return to optional offers
      </Button>}
    </footer>
    {blocked && <p role="status" className="event-funnel-checkout__muted">Checking the original reservation. Please wait…</p>}
  </section>;
}
export default EventFunnelCheckoutSlot;

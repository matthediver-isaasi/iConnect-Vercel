import React, { useEffect, useRef, useState } from 'react';
import EventFunnelInvoices from './EventFunnelInvoices';
import { CreditCard, PoundSterling, Receipt, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invoiceAddressDraft } from '@/lib/eventInvoiceAddress.mjs';
import EventFunnelBilling from './EventFunnelBilling';
import EventFunnelCart from './EventFunnelCart';
import EventFunnelVouchers, { EventFunnelDiscountCode, EventFunnelTrainingFund } from './EventFunnelCheckoutFunding';
import EventFunnelCheckoutPayment from './EventFunnelCheckoutPayment';
import { checkoutTerminal, useEventFunnelCheckout } from './useEventFunnelCheckout';
import './EventReservationIntegration.css';
import './EventFunnelCheckout.css';

const methodNames = { card: 'Card', account: 'Invoice to account', public_invoice_po: 'Invoice / PO', free: 'No payment required' };
const methodLabels = { card: 'Pay by Credit/Debit Card', account: 'Pay by Invoice', public_invoice_po: 'Invoice / PO' };
const methodHints = {
  card: 'Secure payment via Stripe',
  account: 'The remaining amount is invoiced, not deducted from a stored balance.',
  public_invoice_po: 'Register now and receive an invoice. No online payment is taken.',
};
const invoiceMethod = method => method === 'account' || method === 'public_invoice_po';
const canPay = state => ['pending', 'prepared', 'payable', 'requires_payment_method', 'requires_confirmation', 'requires_action'].includes(state);
const quoteSignature = quote => JSON.stringify({
  revision: quote.revision, currency: quote.currency, payableMinor: quote.payableMinor,
  paymentMethod: quote.paymentMethod, invoiceMode: quote.invoiceMode,
  paymentMethods: [...quote.paymentMethods].sort(),
  trainingFundMinor: quote.trainingFundMinor, voucherMinor: quote.voucherMinor,
  discountMinor: quote.discountMinor || 0, discountCode: quote.discountCode || null,
  lines: [...quote.lines].sort((first, second) => `${first.nodeId}:${first.ticketId}`.localeCompare(`${second.nodeId}:${second.ticketId}`)),
});
function initialDraft(summary) {
  const choice = summary.customers[0];
  return {
    customer: choice ? { kind: choice.kind, id: choice.id,
      address: invoiceAddressDraft(choice.invoicingAddress || summary.personalAddress) } : { kind: 'guest', address: {} },
    paymentMethod: summary.totalMinor === 0 ? 'free' : summary.paymentMethods.find(method => method !== 'free') || '',
    purchaseOrderNumber: '', training: '', voucherIds: [], discount: null,
  };
}

// The reservation parent mounts this explicitly outside the event-editing
// fieldset. Recovery stays usable even when event details are disabled/inert.
export function EventFunnelCheckoutSlot(props) {
  return <OwnedCheckout key={props.snapshot.session.id} {...props} />;
}

function OwnedCheckout({ snapshot, change, refresh, checkoutEligibility, expired = false }) {
  const eligibilityRef = useRef(checkoutEligibility);
  eligibilityRef.current = checkoutEligibility;
  const canSubmitNow = () => eligibilityRef.current?.allowed === true
    && eligibilityRef.current.canSubmitNow?.() === true;
  const checkout = useEventFunnelCheckout(snapshot.session.id, snapshot.session.revision, refresh, canSubmitNow);
  const { summary, order, busy, error } = checkout;
  const [draft, setDraft] = useState(null);
  const [review, setReview] = useState(null);
  const [quotedMethods, setQuotedMethods] = useState(null);
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
  }, [snapshot.session.revision]);
  const eligible = checkoutEligibility?.allowed === true;
  useEffect(() => {
    if (!eligible) {
      draftVersion.current += 1;
      setReview(null);
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
    setMessage('');
  };
  const currentSummary = summary && summary.revision === snapshot.session.revision;
  const editable = !order && !checkout.fence && currentSummary && summary.atCheckout
    && snapshot.session.state === 'held' && eligible;
  const blocked = Boolean(busy || finalizing || checkout.cardSubmitting);
  // A code checked against an older reservation revision is not offered; the
  // quote is the only authority for the saving actually charged.
  const appliedDiscount = draft?.discount && draft.discount.revision === summary?.revision ? draft.discount : null;
  async function applyDiscount(code) {
    if (!editable || blocked || !canSubmitNow()) throw new Error('Checkout cannot be changed right now.');
    const result = await checkout.checkDiscount(summary.revision, code);
    edit({ discount: { revision: result.revision, code: result.code, discountMinor: result.discountMinor, lines: result.lines || [] } });
  }
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
      customer: draft.customer, purchaseOrderNumber: invoiceMethod(draft.paymentMethod) ? draft.purchaseOrderNumber : '',
      trainingFundMinor, voucherIds: summary.memberFunding ? draft.voucherIds : [],
      ...(appliedDiscount ? { discountCode: appliedDiscount.code } : {}),
    };
  }
  // One step: a fresh server quote immediately before preparing. It goes
  // straight through unless the total would be higher than the amount the
  // customer has seen; that case stops and shows the new figures instead.
  async function submit(event) {
    event.preventDefault();
    if (!editable || blocked || confirmationLock.current || !canSubmitNow()) return;
    const requested = command();
    if (!requested) return;
    confirmationLock.current = true;
    setFinalizing(true);
    setMessage('');
    try {
      const version = draftVersion.current;
      const shownMinor = review?.version === version ? review.quote.payableMinor : displayedDueMinor;
      const fresh = await checkout.quote(requested);
      if (!fresh) { setReview(null); return; }
      if (version !== draftVersion.current || !canSubmitNow()) return;
      setQuotedMethods({ revision: fresh.revision, methods: fresh.paymentMethods });
      setDraft(previous => ({ ...previous, paymentMethod: fresh.paymentMethod }));
      const finalCommand = { ...requested, paymentMethod: fresh.paymentMethod };
      setReview({ quote: fresh, command: finalCommand, version });
      if (fresh.payableMinor > shownMinor) {
        setMessage(`The total is now ${money(fresh.payableMinor)}. Check the amounts and submit again to continue.`);
        return;
      }
      const prepared = await checkout.prepare({ ...finalCommand, submissionAccepted: true, expectedPayableMinor: fresh.payableMinor });
      if (!prepared) setReview(null);
      // Continue without another click: card orders open the payment form for
      // this exact order; other methods are reconciled to their final state.
      if (prepared?.paymentMethod === 'card') await checkout.startPayment();
      else if (prepared) await checkout.status();
    } finally {
      confirmationLock.current = false;
      setFinalizing(false);
    }
  }
  async function checkOriginal() {
    setReview(null);
    setMessage('');
    if (order) await checkout.status();
    else await checkout.reload();
    await refresh();
  }
  async function returnToReservation() {
    setReview(null);
    setMessage('');
    setCancelRequested(false);
    const result = await checkout.returnToReservation();
    if (result?.returned) {
      draftVersion.current += 1;
      setDraft(initialDraft(result.summary));
      setQuotedMethods(null);
      setMessage('The original checkout has ended and no active order remains. Check your reservation and submit again when you are ready.');
    }
  }

  const quote = review?.version === draftVersion.current && currentSummary ? review.quote : null;
  const paymentMethods = quotedMethods?.revision === snapshot.session.revision
    ? quotedMethods.methods : summary?.paymentMethods || [];
  const discountLines = quote ? quote.lines.filter(line => line.discountMinor > 0) : appliedDiscount?.lines || [];
  const discountMinor = quote ? quote.discountMinor || 0 : appliedDiscount?.discountMinor || 0;
  const displayedDueMinor = (summary?.totalMinor || 0) - discountMinor;
  // Display only: VAT included in each line's price after its own saving.
  const includedTaxMinor = (summary?.lines || []).reduce((sum, line) => {
    if (!Number.isSafeInteger(line.includedTaxMinor)) return sum;
    const saving = discountLines.find(part => part.nodeId === line.nodeId && part.ticketId === line.ticketId)?.discountMinor || 0;
    return sum + (saving && line.taxPercentage ? Math.round((line.amountMinor - saving) * line.taxPercentage / (100 + line.taxPercentage)) : line.includedTaxMinor);
  }, 0);
  const hasFunding = Boolean(summary?.memberFunding);
  const ticketCount = (summary?.lines || []).reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const uncertain = checkout.fence.startsWith('submitted:') || checkout.fence.startsWith('uncertain:');
  const confirmed = order?.state === 'confirmed';
  // Submitting stays quiet: no interim order or status panels flash up while
  // the booking (or a card payment) is being submitted. Errors, uncertainty
  // and recovery are always shown.
  const quiet = Boolean(order && !checkoutTerminal(order.state) && !error && !cancelRequested
    && (finalizing || checkout.cardSubmitting));
  // Remove provider return parameters, retaining the exact owned session route.
  const returnUrl = new URL(window.location.href);
  ['payment_intent', 'payment_intent_client_secret', 'redirect_status'].forEach(key => returnUrl.searchParams.delete(key));

  return <section className="event-funnel-checkout" aria-labelledby="reservation-checkout-heading"
    data-testid="event-funnel-checkout" data-session-state={snapshot.session.state}
    data-checkout-eligible={eligible} aria-busy={blocked}>
    <header>
      <div className="flex items-center gap-2"><ShieldCheck size={19} aria-hidden="true" />
        <h3 id="reservation-checkout-heading">{confirmed ? 'Booking confirmed' : order && !quiet ? 'Your original checkout' : 'Your basket'}</h3>
      </div>
      <p className="event-funnel-checkout__muted mt-1">{confirmed
        ? 'Your payment or invoice submission has been verified and your event bookings are confirmed.'
        : 'Your tickets and extras are checked together. Nothing is booked or paid until you confirm.'}</p>
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

    {order && !quiet && <section className="event-funnel-checkout__panel" aria-label="Original order status">
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

    {summary && draft && <>
      <EventFunnelCart snapshot={snapshot} lines={summary.lines} money={money}
        discounts={discountLines}
        canRemove={editable && !blocked && !review} onRemove={nodeId => change({ type: 'skip', nodeId })} />
      <form onSubmit={submit} className="event-funnel-checkout__columns" aria-label="Checkout details">
        <div className="event-funnel-checkout__fields">
          {!order && <fieldset className="event-funnel-checkout__fields" disabled={!editable || blocked}>
            <legend className="sr-only">Billing</legend>
            {summary.incomplete && <p className="event-funnel-checkout__notice">Some invoice customers could not be verified. Only verified customers are listed. You can check the reservation again before proceeding.</p>}
            <EventFunnelBilling summary={summary} value={draft.customer} onChange={customer => edit({ customer })}
              disabled={!editable || blocked} />
          </fieldset>}
          {!order && !editable && !checkout.fence && !expired && <p className="event-funnel-checkout__notice" role="status">
            {checkoutEligibility?.reason || 'Checkout requires a current held reservation at the checkout step. Use the reservation controls to check availability or return to your event details.'}
          </p>}
        </div>

        <aside className="event-funnel-checkout__summary space-y-4" aria-label="Order summary"
          id={`funnel-order-summary-${snapshot.session.id}`}>
          <section className="rounded-lg border-2 border-blue-200 bg-blue-50 p-4" aria-label="Ticket pricing">
            <div className="mb-3 flex items-center gap-2">
              <PoundSterling className="h-5 w-5 text-blue-600" aria-hidden="true" />
              <h4 className="font-semibold text-blue-900">Ticket Pricing</h4>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between"><dt className="text-blue-700">Tickets:</dt>
                <dd className="font-bold text-blue-900">{ticketCount}</dd></div>
              {includedTaxMinor > 0 && <div className="flex items-center justify-between"><dt className="text-blue-700">Includes VAT:</dt>
                <dd className="font-bold text-blue-900 tabular-nums">{money(includedTaxMinor)}</dd></div>}
              {discountMinor > 0 && <div className="flex items-center justify-between" data-testid="event-funnel-discount-line">
                <dt className="text-green-700">Discount ({quote ? quote.discountCode : appliedDiscount.code}):</dt>
                <dd className="font-bold text-green-700 tabular-nums">−{money(discountMinor)}</dd></div>}
              <div className="flex items-center justify-between border-t border-blue-200 pt-2"><dt className="font-medium text-blue-700">Total Cost:</dt>
                <dd className="text-lg font-bold text-blue-900 tabular-nums" data-testid="event-funnel-total">{money(summary.totalMinor - discountMinor)}</dd></div>
            </dl>
          </section>

          {!order && <fieldset className="space-y-4" disabled={!editable || blocked || Boolean(quote)}>
            <legend className="sr-only">Funding and payment</legend>
            <EventFunnelDiscountCode summary={summary} applied={appliedDiscount} money={money}
              disabled={!editable || blocked || Boolean(quote)} onApply={applyDiscount} onRemove={() => edit({ discount: null })} />
            <EventFunnelVouchers summary={summary} session={snapshot.session} value={draft} onChange={edit} />
            <EventFunnelTrainingFund summary={summary} value={draft} onChange={edit} money={money} />

            {paymentMethods.length === 1 && paymentMethods[0] === 'free'
              ? <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">No payment is required. Your booking still needs final confirmation.</p>
              : <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Pay balance">
                <div className="mb-4 flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-indigo-600" aria-hidden="true" />
                  <span className="text-sm font-medium">Pay Balance</span>
                </div>
                <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Amount Due:</span>
                    <span className="text-lg font-bold text-slate-900 tabular-nums">{money(quote ? quote.payableMinor : summary.totalMinor - discountMinor)}</span>
                  </div>
                  {!quote && hasFunding && <p className="mt-1 text-xs text-slate-500">Credit and training fund are deducted when you submit.</p>}
                </div>
                <div className="space-y-3" role="radiogroup" aria-label="Payment method">
                  {!draft.paymentMethod && <p className="text-xs text-slate-500">No verified payment method.</p>}
                  {paymentMethods.filter(method => methodNames[method] && method !== 'free').map(method =>
                    <label key={method} className="event-funnel-checkout__method" data-checked={draft.paymentMethod === method}>
                      <input type="radio" name={`funnel-method-${snapshot.session.id}`} value={method}
                        checked={draft.paymentMethod === method} onChange={() => edit({ paymentMethod: method })} />
                      {method === 'card' ? <CreditCard className="mt-0.5 h-5 w-5 text-indigo-600" aria-hidden="true" />
                        : <Receipt className="mt-0.5 h-5 w-5 text-indigo-600" aria-hidden="true" />}
                      <span className="flex-1"><span className="block text-sm font-medium">{methodLabels[method]}</span>
                        <span className="mt-1 block text-xs font-normal text-slate-500">{methodHints[method]}</span></span>
                    </label>)}
                  {invoiceMethod(draft.paymentMethod) && <label className="event-funnel-checkout__label">Purchase order number (optional)
                    <input value={draft.purchaseOrderNumber} maxLength={250} onChange={event => edit({ purchaseOrderNumber: event.target.value })} />
                  </label>}
                </div>
              </section>}
          </fieldset>}

          {quote && (quote.voucherMinor > 0 || quote.trainingFundMinor > 0 || quote.discountMinor > 0) && <section className="rounded-lg border-2 border-green-200 bg-green-50 p-4" aria-label="Payment summary">
            <h4 className="mb-2 text-sm font-medium text-green-900">Payment Summary</h4>
            <dl className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between text-green-700"><dt>Total Cost:</dt><dd>{money(summary.totalMinor)}</dd></div>
              {quote.discountMinor > 0 && <div className="flex justify-between text-green-700"><dt>Discount ({quote.discountCode}):</dt><dd>−{money(quote.discountMinor)}</dd></div>}
              {quote.voucherMinor > 0 && <div className="flex justify-between text-green-700"><dt>Vouchers:</dt><dd>−{money(quote.voucherMinor)}</dd></div>}
              {quote.trainingFundMinor > 0 && <div className="flex justify-between text-green-700"><dt>Training Fund:</dt><dd>−{money(quote.trainingFundMinor)}</dd></div>}
              <div className="flex justify-between border-t border-green-200 pt-2 font-bold text-green-900"><dt>Balance to Pay:</dt><dd>{money(quote.payableMinor)}</dd></div>
            </dl>
          </section>}

          {(!order || finalizing) && <div className="space-y-2">
            <Button type="submit" size="lg" className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700"
              disabled={!editable || blocked || summary.lines.length === 0} data-testid="event-funnel-submit">
              {finalizing ? 'Submitting your booking…' : 'Submit booking'}
            </Button>
            {quote && !finalizing && <Button type="button" variant="ghost" className="w-full" disabled={blocked} onClick={() => { setReview(null); setMessage(''); }}>
              Change details
            </Button>}
          </div>}
        </aside>
      </form>
      {!order && editable && <div className="event-funnel-checkout__paybar" aria-hidden="true">
        <span><span className="event-funnel-checkout__muted block">{quote ? 'Total due' : 'Total'}</span>
          <strong className="event-funnel-checkout__amount">{money(quote ? quote.payableMinor : displayedDueMinor)}</strong></span>
        <Button type="button" tabIndex={-1} onClick={() => document.getElementById(`funnel-order-summary-${snapshot.session.id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Submit booking</Button>
      </div>}
    </>}
    <footer className="event-funnel-checkout__actions">
      {!order && !checkout.fence && !expired && snapshot.session.journey?.checkoutNow && <Button type="button" variant="ghost"
        disabled={blocked || !editable} onClick={async () => { setReview(null); await change({ type: 'resume_offers' }); }}>
        Back to options
      </Button>}
    </footer>
  </section>;
}
export default EventFunnelCheckoutSlot;

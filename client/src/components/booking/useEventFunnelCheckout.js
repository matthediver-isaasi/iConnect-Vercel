import { useCallback, useEffect, useRef, useState } from 'react';

// This is the only checkout transport. In particular, do not fall back to any
// single-event payment endpoint when aggregate checkout is unavailable.
export async function eventFunnelCheckoutRequest(sessionId, action, details = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/event-funnels/checkout', {
      method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action, ...details }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || typeof data !== 'object') {
      const error = new Error(data?.error || 'The checkout response could not be verified. Check the original reservation before trying again.');
      error.code = data?.code || 'CHECKOUT_UNAVAILABLE';
      throw error;
    }
    return data;
  } catch (failure) {
    if (failure.name === 'AbortError' || failure instanceof TypeError) {
      throw new Error('The request outcome could not be verified. Check the original reservation; do not submit or pay again.');
    }
    throw failure;
  } finally {
    window.clearTimeout(timeout);
  }
}

const fenceKey = sessionId => `event-funnel-checkout-attempt:${sessionId}`;
function readFence(sessionId) {
  try { return sessionStorage.getItem(fenceKey(sessionId)) || ''; } catch { return ''; }
}
function writeFence(sessionId, value) {
  try {
    if (value) sessionStorage.setItem(fenceKey(sessionId), value);
    else sessionStorage.removeItem(fenceKey(sessionId));
  } catch { /* In-memory protection still applies if browser storage is blocked. */ }
}
export const checkoutTerminal = state => ['confirmed', 'cancelled', 'failed'].includes(state);
const payableStates = new Set(['pending', 'prepared', 'payable', 'requires_payment_method', 'requires_confirmation', 'requires_action']);
// These are verified provider states, not durable order or generic pending
// states. Only a successful STATUS response can authorize an explicit resume.
const retryableProviderStates = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);
const attemptOrderId = fence => {
  const match = /^(?:order|submitted|uncertain):([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(fence || '');
  return match?.[1] || null;
};

export function useEventFunnelCheckout(sessionId, revision, refresh, canSubmitNow) {
  const [summary, setSummary] = useState(null);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [payment, setPayment] = useState(null);
  const [cardSubmitting, setCardSubmitting] = useState(false);
  const [resumable, setResumable] = useState(null);
  const [fence, setFence] = useState(() => readFence(sessionId));
  const orderRef = useRef(null);
  const summaryRef = useRef(null);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const fenceRef = useRef(fence);
  const cardSubmittingRef = useRef(false);
  const resumableRef = useRef(null);
  const lock = useRef(false);
  const mounted = useRef(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const eligibilityRef = useRef(canSubmitNow);
  eligibilityRef.current = canSubmitNow;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const remember = useCallback(value => {
    fenceRef.current = value;
    writeFence(sessionId, value);
    if (mounted.current) setFence(value);
  }, [sessionId]);

  const adoptOrder = useCallback(next => {
    if (!next?.id || (orderRef.current && next.id !== orderRef.current.id)) return;
    const merged = { ...orderRef.current, ...next };
    orderRef.current = merged;
    if (mounted.current) setOrder(merged);
  }, []);

  const allowResume = useCallback(proof => {
    resumableRef.current = proof;
    if (mounted.current) setResumable(proof);
  }, []);

  // A raw, validated read is also used by the explicit terminal reset. That
  // action must not forget or replace the original order while checking.
  const loadSummary = useCallback(async () => {
    const data = await eventFunnelCheckoutRequest(sessionId, 'summary');
    if (!Array.isArray(data.lines) || !Array.isArray(data.customers)
      || !Array.isArray(data.paymentMethods) || !Number.isSafeInteger(data.revision)
      || !Number.isSafeInteger(data.totalMinor) || !/^[A-Z]{3}$/i.test(data.currency || '')) {
      throw new Error('Checkout details could not be verified. Please check the reservation again.');
    }
    return data;
  }, [sessionId]);

  const readSummary = useCallback(async () => {
    const data = await loadSummary();
    if (mounted.current) {
      allowResume(null);
      summaryRef.current = data;
      setSummary(data);
      // Never forget a known original order just because a later read is stale.
      if (data.order) {
        const changed = orderRef.current?.id !== data.order.id || orderRef.current?.state !== data.order.state;
        adoptOrder(data.order);
        if (changed) await refreshRef.current?.();
      }
    }
    return data;
  }, [loadSummary, adoptOrder, allowResume]);

  const run = useCallback(async (name, task) => {
    if (lock.current || !mounted.current) return null;
    lock.current = true;
    setBusy(name);
    setError(null);
    try { return await task(); }
    catch (failure) {
      if (mounted.current) setError(failure);
      return null;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy('');
    }
  }, []);

  const reload = useCallback(() => run('summary', readSummary), [run, readSummary]);
  useEffect(() => { void reload(); }, [reload, revision]);

  const status = useCallback(() => run('status', async () => {
    if (cardSubmittingRef.current) return null;
    allowResume(null);
    const current = orderRef.current;
    if (!current) {
      const data = await readSummary();
      // An active-order summary excludes ended orders. A fence still carries
      // the original ID across reload, allowing authoritative terminal checks.
      if (!data.order && !attemptOrderId(fenceRef.current)) return data;
    }
    const original = orderRef.current || { id: attemptOrderId(fenceRef.current) };
    try {
      const result = await eventFunnelCheckoutRequest(sessionId, 'status', { orderId: original.id });
      if (result.orderId !== original.id || typeof result.state !== 'string') throw new Error('The original order status could not be verified.');
      if (mounted.current) {
        adoptOrder({ id: original.id, state: result.state });
        if (retryableProviderStates.has(result.state)) {
          // Keep uncertain/submitted fences intact. This single-use proof only
          // enables the explicit payment action for this SAME original order.
          allowResume({ orderId: original.id, state: result.state });
        } else {
          setPayment(null);
          if (!checkoutTerminal(result.state) && original.paymentMethod !== 'account'
            && original.paymentMethod !== 'public_invoice_po' && original.paymentMethod !== 'free') {
            remember(`uncertain:${original.id}`);
          }
        }
        if (checkoutTerminal(result.state)) await refreshRef.current?.();
      }
      return result;
    } catch (failure) {
      if (mounted.current) {
        setPayment(null);
        remember(`uncertain:${original.id}`);
      }
      throw failure;
    }
  }), [run, readSummary, sessionId, adoptOrder, allowResume, remember]);

  const returnToReservation = useCallback(() => run('return', async () => {
    if (cardSubmittingRef.current) return null;
    const originalId = orderRef.current?.id || attemptOrderId(fenceRef.current);
    if (!originalId) throw new Error('The original checkout reference is not yet verified. Recover its status before returning to the reservation.');
    const localFence = fenceRef.current;
    const storedFence = readFence(sessionId);
    const localAttempt = attemptOrderId(localFence);
    const storedAttempt = attemptOrderId(storedFence);
    const knownFence = value => !value || value === 'preparing' || attemptOrderId(value) === originalId;
    if (!knownFence(localFence) || !knownFence(storedFence)
      || (localAttempt && localAttempt !== originalId) || (storedAttempt && storedAttempt !== originalId)) {
      throw new Error('Another checkout attempt needs checking. The original safety record has not been cleared.');
    }
    allowResume(null);
    setPayment(null);
    // Never infer terminality from a cancel click, a browser error, a missing
    // order in summary, or the last locally remembered order state.
    const checked = await eventFunnelCheckoutRequest(sessionId, 'status', { orderId: originalId });
    if (checked.orderId !== originalId || typeof checked.state !== 'string') {
      throw new Error('The original order status could not be verified. Its safety record has been retained.');
    }
    if (!mounted.current) return null;
    adoptOrder({ id: originalId, state: checked.state });
    if (!['cancelled', 'failed'].includes(checked.state)) {
      if (checked.state !== 'confirmed') remember(`uncertain:${originalId}`);
      await refreshRef.current?.();
      throw new Error(checked.state === 'confirmed'
        ? 'The original booking is confirmed and cannot be reset here. Use the booking cancellation process.'
        : 'The original checkout has not ended. Keep checking or resume that checkout; no safety record has been cleared.');
    }
    // This must be a NEW read after the terminal status, and must explicitly
    // report null rather than omit the order field or present another order.
    const latest = await loadSummary();
    if (latest.order !== null
      || latest.revision < Math.max(summaryRef.current?.revision ?? 0, revisionRef.current ?? 0)) {
      throw new Error('The reservation still has an active or unverifiable checkout. Its original safety record has been retained.');
    }
    if (!mounted.current) return null;
    if (orderRef.current?.id !== originalId || fenceRef.current !== localFence
      || readFence(sessionId) !== storedFence) {
      throw new Error('Checkout changed while it was checked. The original safety record has not been cleared.');
    }
    // The two independent authoritative reads are satisfied. Clear this
    // original attempt only; any revised checkout must obtain a new quote.
    orderRef.current = null;
    summaryRef.current = latest;
    setOrder(null);
    setSummary(latest);
    remember('');
    await refreshRef.current?.();
    return { returned: true, orderId: originalId, summary: latest };
  }), [run, sessionId, loadSummary, adoptOrder, remember, allowResume]);

  const quote = useCallback(command => run('quote', async () => {
    if (!eligibilityRef.current?.()) throw new Error('Reservation timing must be verified before reviewing a quote. Check availability and prices again.');
    if (orderRef.current || fenceRef.current || readFence(sessionId)) throw new Error('Resume the original checkout before reviewing another quote.');
    const result = await eventFunnelCheckoutRequest(sessionId, 'quote', { command });
    if (!Number.isSafeInteger(result.payableMinor) || result.payableMinor < 0
      || result.revision !== command.expectedRevision || !Array.isArray(result.lines)
      || !Array.isArray(result.paymentMethods) || result.paymentMethods.length === 0
      || result.paymentMethods.some(method => !['free', 'card', 'account', 'public_invoice_po'].includes(method))
      || !result.paymentMethods.includes(result.paymentMethod)
      || result.currency !== summaryRef.current?.currency
      || ![result.trainingFundMinor, result.voucherMinor, result.discountMinor].every(value => Number.isSafeInteger(value) && value >= 0)
      || result.lines.some(line => !['amountMinor', 'payableMinor', 'trainingFundMinor', 'voucherMinor']
        .every(key => Number.isSafeInteger(line[key]) && line[key] >= 0))
      || !['free', 'card', 'account', 'public_invoice_po'].includes(result.paymentMethod)) {
      throw new Error('The quote could not be verified. Please review it again.');
    }
    if (!eligibilityRef.current?.()) throw new Error('The reservation is no longer eligible for checkout. Review availability and timing before continuing.');
    return result;
  }), [run, sessionId]);

  // Inline code check: errors stay with the discount field, not the checkout.
  const checkDiscount = useCallback(async (expectedRevision, discountCode) => {
    if (lock.current) throw new Error('Please wait for the current check to finish.');
    if (orderRef.current || fenceRef.current || readFence(sessionId)) throw new Error('Resume the original checkout before changing a discount code.');
    const result = await eventFunnelCheckoutRequest(sessionId, 'discount', { command: { expectedRevision, discountCode } });
    if (result.revision !== expectedRevision || typeof result.code !== 'string'
      || !Number.isSafeInteger(result.discountMinor) || result.discountMinor <= 0) {
      throw new Error('The discount could not be verified. Please try again.');
    }
    return result;
  }, [sessionId]);

  const prepare = useCallback(command => run('prepare', async () => {
    if (orderRef.current || fenceRef.current || readFence(sessionId)) {
      await readSummary();
      return null;
    }
    if (!eligibilityRef.current?.()) throw new Error('Reservation time or eligibility changed. Check availability and prices again before submitting.');
    remember('preparing');
    try {
      const result = await eventFunnelCheckoutRequest(sessionId, 'prepare', { command });
      if (!result.order?.id || !result.order?.state) throw new Error('The submission response is incomplete. Check the original checkout.');
      if (mounted.current) {
        adoptOrder(result.order);
        remember(`order:${result.order.id}`);
        await refreshRef.current?.();
      }
      return result.order;
    } catch (failure) {
      // A lost response may have created an order. Recover it, never prepare
      // another. A definitive closed-activation response created no order.
      if (failure.code === 'CHECKOUT_NOT_READY') remember('');
      if (mounted.current) {
        try { await readSummary(); } catch { /* Keep the original error and fence. */ }
      }
      throw failure;
    }
  }), [run, sessionId, readSummary, remember, adoptOrder]);

  const startPayment = useCallback(() => run('payment', async () => {
    const current = orderRef.current;
    const proof = resumableRef.current;
    const verifiedResume = current && proof?.orderId === current.id && proof.state === current.state
      && retryableProviderStates.has(proof.state);
    const needsVerification = /^(submitted|uncertain):/.test(fenceRef.current)
      || /^(submitted|uncertain):/.test(readFence(sessionId));
    if (!current || current.paymentMethod !== 'card' || !payableStates.has(current.state)
      || cardSubmittingRef.current || (needsVerification && !verifiedResume)) return null;
    const storedAttempt = attemptOrderId(readFence(sessionId));
    const localAttempt = attemptOrderId(fenceRef.current);
    if ((storedAttempt && storedAttempt !== current.id) || (localAttempt && localAttempt !== current.id)) {
      throw new Error('The original payment reference changed. Check the checkout status before continuing.');
    }
    // Consume proof BEFORE setup. A timeout or another decline needs another
    // successful status check, never another prepare or automatic confirmation.
    allowResume(null);
    // Any ambiguous setup result only permits reconciliation, not a second pay.
    remember(`uncertain:${current.id}`);
    const result = await eventFunnelCheckoutRequest(sessionId, 'payment', { orderId: current.id });
    if (result.orderId !== current.id || typeof result.state !== 'string') throw new Error('Payment setup could not be verified. Check the original order.');
    if (mounted.current) {
      adoptOrder({ id: current.id, state: result.state });
      if (retryableProviderStates.has(result.state) && result.clientSecret && result.publishableKey) {
        setPayment({ clientSecret: result.clientSecret, publishableKey: result.publishableKey });
        remember(`order:${current.id}`);
      } else {
        setPayment(null);
      }
      if (checkoutTerminal(result.state)) await refreshRef.current?.();
    }
    return result;
  }), [run, sessionId, remember, adoptOrder, allowResume]);

  const markSubmitted = useCallback(() => {
    const current = orderRef.current;
    if (current) {
      allowResume(null);
      cardSubmittingRef.current = true;
      setCardSubmitting(true);
      remember(`submitted:${current.id}`);
    }
  }, [remember, allowResume]);
  const paymentFinished = useCallback(async failure => {
    cardSubmittingRef.current = false;
    if (!mounted.current) return;
    setPayment(null);
    await status();
    if (mounted.current) setCardSubmitting(false);
    if (failure && mounted.current) {
      setError(Object.assign(new Error(`${failure} You can try the card again or choose a different payment method.`), { code: 'PAYMENT_NOT_COMPLETED' }));
    }
  }, [status]);

  const cancel = useCallback(() => run('cancel', async () => {
    const current = orderRef.current;
    if (!current || checkoutTerminal(current.state) || cardSubmittingRef.current) return null;
    allowResume(null);
    setPayment(null);
    remember(`uncertain:${current.id}`);
    try {
      const result = await eventFunnelCheckoutRequest(sessionId, 'cancel', { orderId: current.id });
      if (result.orderId !== current.id || typeof result.state !== 'string') throw new Error('Cancellation could not be verified.');
      if (mounted.current) adoptOrder({ id: current.id, state: result.state });
      return result;
    } finally {
      // Only the server may release stock; always reread the original journey.
      if (mounted.current) await refreshRef.current?.();
    }
  }), [run, sessionId, remember, adoptOrder, allowResume]);

  // "Change payment method": the server cancels this unpaid card attempt
  // (verifying with the provider first; places stay reserved), then the
  // usual two-read check returns to the payment choices. If the payment had
  // in fact gone through, cancel finalizes the booking instead.
  const changePaymentMethod = useCallback(async () => {
    const current = orderRef.current;
    if (!current || current.paymentMethod !== 'card' || checkoutTerminal(current.state) || cardSubmittingRef.current) return null;
    const cancelled = await cancel();
    if (!cancelled || !['cancelled', 'failed'].includes(cancelled.state)) return cancelled ? { returned: false, state: cancelled.state } : null;
    return returnToReservation();
  }, [cancel, returnToReservation]);

  // One bounded reconciliation cycle for a recovered/prepared order. No
  // automatic payment/prepare, no infinite polling after an uncertain response.
  const recoveredId = order?.id;
  useEffect(() => {
    if (!recoveredId) return undefined;
    const timers = [500, 3500, 9000].map(delay => window.setTimeout(() => {
      const current = orderRef.current;
      if (current && !checkoutTerminal(current.state)) void status();
    }, delay));
    return () => timers.forEach(window.clearTimeout);
  }, [recoveredId, status]);

  const canResumePayment = Boolean(order && resumable?.orderId === order.id
    && resumable.state === order.state && retryableProviderStates.has(resumable.state));
  const canReturnToReservation = order ? ['cancelled', 'failed'].includes(order.state)
    : Boolean(attemptOrderId(fence));
  return { summary, order, error, busy, payment, fence, cardSubmitting, reload, status, quote, prepare, checkDiscount,
    canResumePayment, canReturnToReservation, returnToReservation,
    startPayment, markSubmitted, paymentFinished, cancel, changePaymentMethod };
}

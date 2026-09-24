/**
 * Derive attendee-level net ticket values from the financial snapshot stored
 * when each booking was created. Standard and complex bookings intentionally
 * use different formulae: complex ticket_price is already code-discounted,
 * while standard total_cost is not.
 */
export function normalizeGroupPricePaid(bookings) {
  const money = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const optionalMoney = (value) => money(value) ?? 0;
  const roundCents = (value) => Math.round((value + Number.EPSILON) * 100);

  const normalized = (bookings || []).map((booking) => {
    const isComplex = booking._report_booking_source === 'complex';
    const base = money(isComplex ? booking.ticket_price : booking.total_cost);
    if (base === null) {
      return { price_paid: null, price_paid_status: 'unavailable', rawCents: null };
    }

    const separatelyStoredReductions = isComplex
      ? optionalMoney(booking.voucher_amount)
        + optionalMoney(booking.training_fund_amount)
        + optionalMoney(booking.account_balance_amount)
      : optionalMoney(booking.discount_code_amount)
        + optionalMoney(booking.voucher_amount)
        + optionalMoney(booking.training_fund_amount);
    const raw = Math.max(0, base - separatelyStoredReductions);
    const paymentStatus = String(booking.payment_status || '').toLowerCase();
    const bookingStatus = String(booking.status || '').toLowerCase();
    const paymentMethod = String(booking.payment_method || '').toLowerCase();
    let pricePaidStatus = 'net';
    if (raw > 0) {
      const explicitlyPending = bookingStatus === 'pending'
        || paymentStatus === 'pending'
        || paymentStatus === 'unpaid';
      if (paymentMethod === 'public_invoice_po' || explicitlyPending) {
        pricePaidStatus = 'pending';
      } else if (['failed', 'unknown', 'void', 'voided'].includes(paymentStatus)) {
        pricePaidStatus = 'unavailable';
      } else if (isComplex) {
        // Complex writers persist payment_status as their settlement evidence.
        // A settled legacy invoice may therefore be net rather than pending.
        if (paymentStatus === 'paid') {
          pricePaidStatus = 'net';
        } else if (paymentMethod === 'invoice' || paymentMethod === 'account') {
          pricePaidStatus = 'pending';
        } else {
          pricePaidStatus = 'unavailable';
        }
      } else if (paymentStatus === 'paid') {
        pricePaidStatus = 'net';
      } else if (paymentMethod === 'account' || paymentMethod === 'invoice') {
        // Standard account_amount represents a liability/payment allocation,
        // not consumed account credit and not proof of settlement.
        pricePaidStatus = 'pending';
      } else if (paymentMethod === 'card' && booking.stripe_payment_intent_id) {
        pricePaidStatus = 'net';
      } else {
        pricePaidStatus = 'unavailable';
      }
    }

    return {
      price_paid: null,
      price_paid_status: pricePaidStatus,
      rawCents: raw * 100,
    };
  });

  // Round as a group, then distribute any fractional-cent remainder
  // deterministically. This avoids N-way division creating a penny mismatch.
  const available = normalized
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.rawCents !== null);
  const targetCents = roundCents(available.reduce((sum, { row }) => sum + row.rawCents, 0) / 100);
  const cents = available.map(({ row }) => Math.max(0, Math.round(row.rawCents)));
  let difference = targetCents - cents.reduce((sum, value) => sum + value, 0);
  const fractional = available.map(({ row }, index) => index)
    .filter(index => Math.abs(available[index].row.rawCents - cents[index]) > 1e-7)
    .sort((a, b) => difference > 0
      ? (available[b].row.rawCents - cents[b]) - (available[a].row.rawCents - cents[a])
      : (available[a].row.rawCents - cents[a]) - (available[b].row.rawCents - cents[b]));
  for (let cursor = 0; difference !== 0 && cursor < fractional.length; cursor++) {
    const index = fractional[cursor];
    const direction = difference > 0 ? 1 : -1;
    if (direction > 0 || cents[index] > 0) {
      cents[index] += direction;
      difference -= direction;
    }
  }
  available.forEach(({ row }, index) => {
    row.price_paid = cents[index] / 100;
    delete row.rawCents;
  });
  normalized.forEach((row) => delete row.rawCents);
  return normalized;
}
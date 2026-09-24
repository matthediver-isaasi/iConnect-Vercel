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

const moneyToCents = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) : 0;
};

const centsToMoney = (value) => value / 100;

const complexDiscountKey = (booking) => {
  const ticketIdentity = booking.ticket_class_id || booking.ticket_class_name || '';
  return `${ticketIdentity}::${moneyToCents(booking.ticket_price)}`;
};

const complexDiscountCentsByRow = (rows) => {
  const discountByTicket = new Map();
  for (const booking of rows) {
    const discountCents = Math.max(0, moneyToCents(booking.discount_amount));
    if (discountCents > 0) {
      discountByTicket.set(complexDiscountKey(booking), discountCents);
    }
  }
  return rows.map(booking => {
    const ownDiscount = Math.max(0, moneyToCents(booking.discount_amount));
    return ownDiscount || discountByTicket.get(complexDiscountKey(booking)) || 0;
  });
};

/**
 * Canonical registration values used by the report's financial footer.
 *
 * Standard bookings persist total_cost before a separately stored code
 * discount. Complex bookings instead persist ticket_price after their code
 * discount, so the gross ticket value must be reconstructed. Neither account
 * liabilities nor vouchers/funds belong in this pre-credit total.
 */
export function normalizeGroupPayment(bookings) {
  const rows = bookings || [];
  const isComplex = rows.some(booking => booking._report_booking_source === 'complex');
  const isStandardPublicInvoicePo = !isComplex && rows.some(
    booking => booking.payment_method === 'public_invoice_po'
      && booking.purchaser_context?.classification === 'public_non_member',
  );
  const publicInvoiceSnapshot = isStandardPublicInvoicePo
    ? rows.find(booking => booking.purchaser_context?.financial_snapshot)
      ?.purchaser_context.financial_snapshot
    : null;
  const complexCodeDiscounts = isComplex ? complexDiscountCentsByRow(rows) : [];
  const codeDiscountCents = isComplex
    ? complexCodeDiscounts.reduce((sum, value) => sum + value, 0)
    : rows.reduce((sum, booking) => sum + Math.max(
      0,
      moneyToCents(booking.discount_code_amount),
    ), 0);

  let ticketTotalCents;
  let totalAfterDiscountCents;
  let offerDiscountCents;

  if (isComplex) {
    totalAfterDiscountCents = rows.reduce(
      (sum, booking) => sum + Math.max(0, moneyToCents(booking.ticket_price)),
      0,
    );
    offerDiscountCents = 0;
    ticketTotalCents = totalAfterDiscountCents + codeDiscountCents;
  } else {
    const storedTicketCents = rows.reduce(
      (sum, booking) => sum + Math.max(0, moneyToCents(booking.ticket_price)),
      0,
    );
    const storedCostCents = rows.reduce(
      (sum, booking) => sum + Math.max(0, moneyToCents(booking.total_cost)),
      0,
    );
    totalAfterDiscountCents = Math.max(0, storedCostCents - codeDiscountCents);
    const snapshotGrossCents = publicInvoiceSnapshot
      ? moneyToCents(publicInvoiceSnapshot.gross_ticket_total_amount)
      : 0;
    if (isStandardPublicInvoicePo && snapshotGrossCents <= 0) {
      return {
        ticketTotal: null,
        totalAfterDiscount: centsToMoney(totalAfterDiscountCents),
        discount: null,
        offerDiscount: null,
        codeDiscount: centsToMoney(codeDiscountCents),
        totalsStatus: 'unavailable_gross_snapshot',
      };
    }
    // Derive the offer component from the persisted snapshots, but make the
    // canonical values reconcile even for a fully discounted booking.
    const authoritativeTicketCents = snapshotGrossCents || storedTicketCents;
    offerDiscountCents = Math.max(0, authoritativeTicketCents - storedCostCents);
    ticketTotalCents = Math.max(
      authoritativeTicketCents,
      totalAfterDiscountCents + codeDiscountCents + offerDiscountCents,
    );
  }

  const discountCents = ticketTotalCents - totalAfterDiscountCents;
  // If malformed/legacy values forced reconciliation, assign the remainder to
  // the offer component rather than inventing a larger persisted code amount.
  offerDiscountCents = Math.max(0, discountCents - codeDiscountCents);

  return {
    ticketTotal: centsToMoney(ticketTotalCents),
    totalAfterDiscount: centsToMoney(totalAfterDiscountCents),
    discount: centsToMoney(discountCents),
    offerDiscount: centsToMoney(offerDiscountCents),
    codeDiscount: centsToMoney(codeDiscountCents),
    totalsStatus: 'available',
  };
}

/** Gross attendee ticket value for display; complex ticket_price is net. */
export function grossTicketPrice(booking) {
  if (booking?._report_booking_source !== 'complex') return booking?.ticket_price;
  const ticketCents = Math.max(0, moneyToCents(booking?.ticket_price));
  const codeCents = Math.max(0, moneyToCents(booking.discount_amount));
  return centsToMoney(ticketCents + codeCents);
}

/**
 * Group-aware display values. Complex writers store a per-ticket discount only
 * on the first attendee of each ticket-class item, so propagate that snapshot
 * to matching attendees when reconstructing their gross price.
 */
export function normalizeGroupTicketPrices(bookings) {
  const rows = bookings || [];
  const complexDiscounts = complexDiscountCentsByRow(rows);
  const publicInvoiceUnit = rows.find(
    booking => booking.payment_method === 'public_invoice_po'
      && booking.purchaser_context?.classification === 'public_non_member'
      && booking.purchaser_context?.financial_snapshot,
  )?.purchaser_context.financial_snapshot.gross_ticket_unit_amount;
  return rows.map((booking, index) => {
    if (booking?._report_booking_source !== 'complex') {
      const isLegacyPublicInvoicePo = booking?.payment_method === 'public_invoice_po'
        && booking.purchaser_context?.classification === 'public_non_member'
        && publicInvoiceUnit == null;
      if (isLegacyPublicInvoicePo) return null;
      return publicInvoiceUnit == null
        ? booking?.ticket_price
        : centsToMoney(Math.max(0, moneyToCents(publicInvoiceUnit)));
    }
    return centsToMoney(
      Math.max(0, moneyToCents(booking.ticket_price)) + complexDiscounts[index],
    );
  });
}

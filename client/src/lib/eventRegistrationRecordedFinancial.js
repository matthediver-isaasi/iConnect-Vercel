import { financialAmount, financialCurrency, financialExport } from './eventRegistrationFinancial.js';

export function isGrossSnapshotUnavailable(record) {
  return ['unavailable_gross_snapshot', 'unavailable_import_financials'].includes(record?.totalsStatus)
    || ['unavailable_gross_snapshot', 'unavailable_import_financials'].includes(record?.ticket_price_status);
}

export const RECORDED_TICKET_EXPLANATION = 'Recorded ticket amount after offers. The original list price is unavailable; this is not the gross ticket price.';
export const RECORDED_DISCOUNT_EXPLANATION = 'Recorded discount-code amount only. The historical offer discount is unknown, so the full discount is unavailable.';
export const PARTIAL_DISCOUNTS_EXPLANATION = 'Recorded discounts only: includes full discounts where known and recorded discount-code amounts otherwise. Some discount components are unknown; this is not a complete discount total.';
export const UNPAID_EXPLANATION = 'Unpaid: this amount has not been received.';

export function registrationTicketPricePresentation(attendee) {
  if (attendee?.price_paid_status === 'proposal_pending') return { amount: null, recorded: false, allocationPending: true };
  const recorded = attendee?.payment_method === 'public_invoice_po'
    && attendee?.ticket_price_status === 'unavailable_gross_snapshot';
  const amount = recorded
    ? financialAmount(attendee.raw_ticket_price)
    : isGrossSnapshotUnavailable(attendee) ? null : financialAmount(attendee?.ticket_price);
  return { amount, recorded: recorded && amount !== null };
}

export function registrationDiscountPresentation(payment) {
  const full = !isGrossSnapshotUnavailable(payment) ? financialAmount(payment?.discount) : null;
  if (full !== null) return { amount: full, recorded: false, partial: false };
  const code = payment?.totalsStatus === 'unavailable_gross_snapshot'
    ? financialAmount(payment?.codeDiscount) : null;
  return { amount: code, recorded: code !== null, partial: true };
}

export function registrationTicketPriceExport(attendee) {
  if (attendee?.price_paid_status === 'proposal_pending') return 'Pending allocation';
  const { amount, recorded } = registrationTicketPricePresentation(attendee);
  return recorded
    ? `${financialExport(amount)} (recorded after offers; original list price unavailable)`
    : financialExport(amount);
}

export function registrationDiscountExport(payment) {
  const { amount, recorded } = registrationDiscountPresentation(payment);
  if (amount === null) return 'Unavailable';
  const value = financialExport(amount === 0 ? 0 : -Math.abs(amount));
  return recorded ? `${value} (recorded code discount only; offer discount unknown)` : value;
}

export function registrationPricePaidPresentation(attendee) {
  if (attendee?.price_paid_status === 'proposal_pending') return { label: 'Pending allocation', pending: false };
  const pending = attendee?.price_paid_status === 'pending';
  const amount = financialAmount(attendee?.price_paid);
  return {
    pending,
    label: pending || ['net', 'proposal_attributed'].includes(attendee?.price_paid_status) ? financialCurrency(amount) : 'Unavailable',
  };
}

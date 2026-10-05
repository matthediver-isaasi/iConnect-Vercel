import { resolveTicketPrice, computeDiscountedPrice, validateDiscountCode } from './complexEventPricing.js';

export function publicTicketSimpleBaseTotal(ticket, attendeeCount) {
  if (!Number.isInteger(attendeeCount) || attendeeCount < 1 || attendeeCount > 100) {
    throw new Error('A valid attendee quantity is required.');
  }
  const resolved = resolveTicketPrice([ticket], ticket.id);
  if (!resolved.found || !Number.isFinite(resolved.price) || resolved.price < 0) {
    throw new Error('Ticket pricing is unavailable.');
  }
  let quantity = attendeeCount;
  const buy = Number(ticket.bogo_buy_quantity);
  const free = Number(ticket.bogo_get_free_quantity);
  if (ticket.offer_type === 'bogo' && buy > 0 && free > 0) {
    const remainder = quantity % (buy + free);
    quantity = Math.floor(quantity / (buy + free)) * buy
      + (ticket.bogo_logic_type === 'enter_total_pay_less' ? remainder : Math.min(remainder, buy));
  }
  let total = resolved.price * quantity;
  if (ticket.offer_type === 'bulk_discount' && Number(ticket.bulk_discount_threshold) > 0
      && attendeeCount >= Number(ticket.bulk_discount_threshold)) {
    total *= 1 - Math.min(100, Math.max(0, Number(ticket.bulk_discount_percentage) || 0)) / 100;
  }
  return Math.round(total * 100) / 100;
}

export async function validatePublicTicketSimpleCharge({ ticket, attendees, tenantId, eventId, discountCode, amount }) {
  let total = publicTicketSimpleBaseTotal(ticket, attendees?.length);
  if (discountCode) {
    const result = await validateDiscountCode({
      code: discountCode, tenantId, eventId, ticketClassId: ticket.id, memberId: null, memberRoleId: null, orgId: null,
    });
    if (!result.valid) throw new Error(result.reason || 'Discount code is invalid.');
    total = computeDiscountedPrice(total, result.discountCode);
  }
  if (!Number.isFinite(Number(amount)) || Math.round(Number(amount) * 100) < Math.round(total * 100)) {
    throw new Error('The payment amount does not cover the selected tickets.');
  }
}

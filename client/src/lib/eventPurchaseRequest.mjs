// Deliberately excludes invoiceAddressSelection: a frozen payment request must
// reject a changed address, not silently mint a new ID and potentially charge twice.
export function eventPurchaseRequestFingerprint({
  eventId, source, tenantId, member, purchaser, attendees, tickets, selectedTicket, cart,
  ticketCount, registrationMode, paymentMethod, amount, totalCost,
  discount, voucherIds, voucherOrderManual, voucherAmount, trainingFundAmount, allocationTicketId, codeOfConduct,
}) {
  return JSON.stringify({
    version: 2, eventId, source, tenantId: tenantId || null,
    member: member ? { id: member.id || null, email: member.email || null, tenantId: member.tenant_id || tenantId || null } : null,
    purchaser, attendees, tickets, selectedTicket, cart, ticketCount, registrationMode, paymentMethod,
    amount, totalCost, discount, voucherIds, voucherOrderManual, voucherAmount, trainingFundAmount,
    allocationTicketId: allocationTicketId || null,
    ...(codeOfConduct ? { codeOfConduct } : {}),
  });
}

export function resolveEventPurchaseRequest({ fingerprint, key, previous, storage, createId }) {
  if (previous?.fingerprint === fingerprint && previous.id) return previous;
  let id;
  try {
    id = storage.getItem(`${key}_fingerprint`) === fingerprint ? storage.getItem(key) : null;
  } catch { /* In-memory retries still retain their ID if storage is blocked. */ }
  id ||= createId();
  try {
    storage.setItem(key, id);
    storage.setItem(`${key}_fingerprint`, fingerprint);
  } catch { /* Never generate a second ID after a partially successful write. */ }
  return { fingerprint, id };
}

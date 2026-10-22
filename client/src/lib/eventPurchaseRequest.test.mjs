import test from "node:test";
import assert from "node:assert/strict";
import { eventPurchaseRequestFingerprint, resolveEventPurchaseRequest } from "./eventPurchaseRequest.mjs";
import { invoiceAddressConflictMessage, invoiceAddressRequired } from "./eventInvoiceAddress.mjs";

const checkout = {
  eventId: "event", source: "simple", tenantId: "tenant",
  member: { id: "member", email: "member@example.org" }, purchaser: { email: "member@example.org" },
  attendees: [{ email: "attendee@example.org" }], tickets: [{ id: "ticket" }],
  selectedTicket: { id: "ticket", price: 30 }, cart: null, ticketCount: 1,
  registrationMode: "self", paymentMethod: "card", amount: 30, totalCost: 30,
  discount: null, voucherIds: [], voucherOrderManual: false, voucherAmount: 0, trainingFundAmount: 0,
};

test("regular member request identity covers event/member/selected tickets/cart/quantity/credit/payment changes", () => {
  const original = eventPurchaseRequestFingerprint(checkout);
  for (const change of [
    { member: { ...checkout.member, id: "another-member" } },
    { tenantId: "other-tenant" }, { eventId: "other-event" }, { source: "complex" },
    { selectedTicket: { id: "same-price-other-ticket", price: 30 } },
    { tickets: [{ id: "other-ticket" }] }, { ticketCount: 2 },
    { cart: [{ ticket_class_id: "complex-ticket", attendees: [{ email: "other@example.org" }] }] },
    { attendees: [{ email: "other@example.org" }] }, { amount: 20 }, { totalCost: 40 },
    { paymentMethod: "account" }, { discount: { code: "TENOFF" } },
    { voucherIds: ["voucher"] }, { voucherAmount: 10 }, { voucherOrderManual: true },
    { trainingFundAmount: 10 }, { allocationTicketId: "invitation-ticket" },
  ]) {
    assert.notEqual(eventPurchaseRequestFingerprint({ ...checkout, ...change }), original, JSON.stringify(change));
  }
});

test("same checkout/PI retries retain request ID through remount; changed cart gets new ID", () => {
  const stored = new Map();
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  let generated = 0;
  const resolve = (input, previous) => resolveEventPurchaseRequest({
    fingerprint: eventPurchaseRequestFingerprint(input), key: "event-key", previous,
    storage, createId: () => `request-${++generated}`,
  });
  const first = resolve(checkout);
  assert.equal(resolve(checkout, first).id, first.id);
  assert.equal(resolve(checkout).id, first.id);
  assert.notEqual(resolve({ ...checkout, amount: 50 }, first).id, first.id);
  assert.equal(generated, 2);
});

test("private selected address is excluded: changing frozen address never silently creates a new charge identity", () => {
  const fingerprint = eventPurchaseRequestFingerprint(checkout);
  for (const invoiceAddressSelection of [
    { mode: "personal", address: { invoicing_address_line1: "PRIVATE ADDRESS" } },
    { mode: "organization" },
  ]) {
    const changed = eventPurchaseRequestFingerprint({ ...checkout, invoiceAddressSelection });
    assert.equal(changed, fingerprint);
    assert.doesNotMatch(changed, /PRIVATE ADDRESS|invoicing_address/);
  }
  const conflict = { errorData: { code: "EVENT_INVOICE_POLICY_CONFLICT" } };
  assert.match(invoiceAddressConflictMessage(conflict), /No new payment was started/);
  assert.equal(invoiceAddressRequired(conflict), false);
  assert.match(invoiceAddressConflictMessage({ errorData: {
    error: "Checkout details changed after invoice instructions were frozen. Start a new checkout.",
  } }), /contact support before making another payment/);
});

test("blocked session storage still retains ID in memory and partial writes do not mint extra IDs", () => {
  let generated = 0;
  const input = {
    fingerprint: eventPurchaseRequestFingerprint(checkout), key: "key",
    storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } },
    createId: () => `request-${++generated}`,
  };
  const first = resolveEventPurchaseRequest(input);
  assert.equal(resolveEventPurchaseRequest({ ...input, previous: first }).id, first.id);
  assert.equal(generated, 1);
});

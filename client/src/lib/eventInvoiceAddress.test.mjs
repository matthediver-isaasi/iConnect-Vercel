import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoverEventInvoiceAddress, invoiceAddressRequired, invoiceAddressSelectionPayload, personalInvoiceAddressSelection } from "./eventInvoiceAddress.mjs";

test("discovery sends only event/source and fails closed on HTTP or malformed responses", async () => {
  let call;
  const result = await discoverEventInvoiceAddress(async (...args) => {
    call = args;
    return { ok: true, json: async () => ({ required: false, applicable: true }) };
  }, { eventId: "event", source: "complex" });
  assert.equal(result.required, false);
  assert.equal(call[0], "/api/event-invoice-address");
  assert.deepEqual(JSON.parse(call[1].body), { eventId: "event", source: "complex" });
  for (const response of [
    { ok: false, json: async () => ({ error: "Session expired" }) },
    { ok: true, json: async () => ({}) },
  ]) {
    await assert.rejects(discoverEventInvoiceAddress(async () => response, { eventId: "event", source: "simple" }));
  }
});

test("personal selection normalizes all six fields without record updates; organisation sends no address", () => {
  assert.throws(() => personalInvoiceAddressSelection({}), /line 1/);
  const selection = personalInvoiceAddressSelection({ invoicing_address_line1: "  1 Road  ",
    invoicing_city: "London", invoicing_postal_code: "SW1A 1AA", invoicing_country: "United Kingdom", ignored: "not sent" });
  assert.equal(Object.keys(selection.address).length, 6);
  assert.equal(selection.address.invoicing_address_line1, "1 Road");
  assert.deepEqual(invoiceAddressSelectionPayload(undefined), {});
  assert.deepEqual(invoiceAddressSelectionPayload({ mode: "organization" }), { invoiceAddressSelection: { mode: "organization" } });
});

test("state-change requirement is recognized in simple and complex error envelopes", () => {
  for (const value of [
    { code: "INVOICE_ADDRESS_REQUIRED" },
    { response: { data: { code: "INVOICE_ADDRESS_REQUIRED" } } },
    { errorData: { code: "INVOICE_ADDRESS_REQUIRED" } },
  ]) assert.equal(invoiceAddressRequired(value), true);
  assert.equal(invoiceAddressRequired(new Error("Network error")), false);
});

test("simple, complex and adapter all forward the selected address without altering Stripe card verification", () => {
  const payment = readFileSync(new URL("../components/booking/PaymentOptions.jsx", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../pages/ComplexEventDetail.jsx", import.meta.url), "utf8");
  assert.equal((payment.match(/\.\.\.invoiceAddressSelectionPayload\(invoiceAddressSelection\)/g) || []).length, 2);
  assert.match(adapter, /invoiceAddressSelection: data\.invoiceAddressSelection/);
  assert.match(payment, /<AddressElement/);
  assert.match(payment, /!isGuestCheckout && !!memberInfo && \(isOneOffEvent \|\| isComplexEvent\)/);
});

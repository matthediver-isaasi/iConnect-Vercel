import assert from "node:assert/strict";
import test from "node:test";
import { ambiguousCustomerCandidates, historicalInvoices, invoiceErrorText, invoicePermissions, invoiceReference, normalizeInvoice } from "./invoiceStatus.js";

test("invoice permissions default to explicit denial", () => {
  assert.deepEqual(invoicePermissions(), {
    canCreateInvoice: false,
    canRetryInvoice: false,
    canViewInvoice: false,
  });
});

test("normalizes provider-neutral invoice fields and number fallback", () => {
  const invoice = normalizeInvoice({
    provider_label: "Example Books",
    invoice_id: "inv-42",
    invoice_status: "processing",
    external_url: "https://example.test/invoices/42",
  });
  assert.equal(invoice.provider, "Example Books");
  assert.equal(invoice.pending, true);
  assert.equal(invoice.externalUrl, "https://example.test/invoices/42");
  assert.equal(invoiceReference(invoice.raw), "inv-42");
});

test("uses explicit invoice permission aliases", () => {
  assert.deepEqual(invoicePermissions({
    can_create_invoice: true,
    canRetryInvoice: true,
    canViewInvoice: true,
  }), {
    canCreateInvoice: true,
    canRetryInvoice: true,
    canViewInvoice: true,
  });
});

test("accounting management is only a fallback and cannot override explicit denial", () => {
  assert.deepEqual(invoicePermissions({ canManageAccounting: true }), {
    canCreateInvoice: true,
    canRetryInvoice: true,
    canViewInvoice: true,
  });
  assert.deepEqual(invoicePermissions({ canManageAccounting: true, canCreateInvoice: false }), {
    canCreateInvoice: false,
    canRetryInvoice: true,
    canViewInvoice: true,
  });
});

test("extracts safe ambiguous customer choices from backend conflict details", () => {
  const error = {
    status: 409,
    payload: {
      code: "AMBIGUOUS_CUSTOMER_MATCH",
      details: { candidates: [{ id: "provider-id-1", name: "Ada Lovelace", email: "ada@example.test" }] },
    },
  };
  assert.deepEqual(ambiguousCustomerCandidates(error), [{
    providerCustomerId: "provider-id-1",
    name: "Ada Lovelace",
    email: "ada@example.test",
  }]);
});

test("reads validation errors from backend details", () => {
  assert.equal(invoiceErrorText({
    message: "Request failed",
    payload: { details: { errors: [{ message: "Customer email is required" }] } },
  }), "Customer email is required");
});

test("keeps historical invoices visible without treating them as the current invoice", () => {
  const history = historicalInvoices([
    { id: "old-provider-invoice", provider: "Former provider", status: "paid", created_at: "2025-01-01T10:00:00Z" },
    { id: "current-invoice", provider: "Current provider", status: "sent" },
  ], { id: "current-invoice", provider: "Current provider" });

  assert.equal(history.length, 1);
  assert.equal(history[0].provider, "Former provider");
  assert.equal(history[0].status, "paid");
});
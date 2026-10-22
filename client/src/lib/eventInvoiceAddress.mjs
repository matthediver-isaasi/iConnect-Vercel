import { INVOICING_ADDRESS_FIELDS, invoicingAddressError } from "../../../shared/invoicingAddress.js";

export const invoiceAddressDraft = resolved => Object.fromEntries(
  INVOICING_ADDRESS_FIELDS.map(({ key }) => [key, resolved?.source === "structured" ? resolved.address?.[key] || "" : ""]),
);

export function personalInvoiceAddressSelection(address) {
  const error = invoicingAddressError(address);
  if (error) throw new Error(error);
  const normalized = Object.fromEntries(INVOICING_ADDRESS_FIELDS.map(({ key }) => [key, (address?.[key] || "").trim()]));
  for (const [key, label] of [
    ["invoicing_address_line1", "invoicing address line 1"], ["invoicing_city", "invoicing city"],
    ["invoicing_postal_code", "invoicing postcode"], ["invoicing_country", "invoicing country"],
  ]) {
    if (!normalized[key]) throw new Error(`Please enter ${label}.`);
  }
  return { mode: "personal", address: normalized };
}

export function invoiceAddressRequired(error) {
  const bodies = [error, error?.data, error?.response?.data, error?.errorData];
  return bodies.some(body => body?.code === "INVOICE_ADDRESS_REQUIRED" ||
    body?.code === "EVENT_INVOICE_ADDRESS_REQUIRED" || body?.invoiceAddressRequired === true ||
    body?.error === "Select a personal or linked organization invoice address" ||
    body?.message === "Select a personal or linked organization invoice address");
}

export function invoiceAddressConflictMessage(error) {
  const bodies = [error, error?.data, error?.response?.data, error?.errorData];
  const conflict = bodies.find(body => [
    "INVOICE_ADDRESS_POLICY_CONFLICT", "EVENT_INVOICE_ADDRESS_POLICY_CONFLICT",
    "EVENT_INVOICE_POLICY_CONFLICT", "INVOICE_POLICY_CONFLICT",
    "EVENT_INVOICE_POLICY_CHANGED", "EVENT_INVOICE_ADDRESS_CONFLICT",
  ].includes(body?.code) ||
    body?.error === "Checkout details changed after invoice instructions were frozen. Start a new checkout." ||
    body?.message === "Checkout details changed after invoice instructions were frozen. Start a new checkout.");
  return conflict
    ? "This checkout already has a frozen invoice address or payment. No new payment was started. Retry with the original invoice address to resume it, or contact support before making another payment."
    : null;
}

export const invoiceAddressSelectionPayload = selection =>
  selection ? { invoiceAddressSelection: selection } : {};

export async function discoverEventInvoiceAddress(request, { eventId, source, signal }) {
  const response = await request("/api/event-invoice-address", {
    method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, source }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "Unable to check invoice addresses. Please retry.");
  if (typeof data?.required !== "boolean" || typeof data?.applicable !== "boolean") {
    throw new Error("Invalid invoice address response. Please retry.");
  }
  return data;
}

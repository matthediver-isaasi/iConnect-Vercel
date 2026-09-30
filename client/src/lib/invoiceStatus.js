const first = (value, keys, fallback = null) => {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return fallback;
};

export function invoicePermissions(permissions = {}) {
  const explicit = (keys) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(permissions, key)) return permissions[key] === true;
    }
    return null;
  };
  // Older detail DTOs exposed only this broad accounting capability. Individual
  // invoice capabilities always take precedence, including an explicit false.
  const accountingFallback = explicit(["canManageAccounting", "can_manage_accounting"]) === true;
  return {
    canCreateInvoice: explicit(["canCreateInvoice", "can_create_invoice"]) ?? accountingFallback,
    canRetryInvoice: explicit(["canRetryInvoice", "can_retry_invoice"]) ?? accountingFallback,
    canViewInvoice: explicit(["canViewInvoice", "can_view_invoice"]) ?? accountingFallback,
  };
}

export function normalizeInvoice(invoice) {
  if (!invoice) return null;
  const status = String(first(invoice, ["status", "state", "invoiceStatus", "invoice_status"], "created")).toLowerCase();
  const providerValue = first(invoice, ["providerLabel", "provider_label", "providerName", "provider_name", "provider"]);
  return {
    raw: invoice,
    id: first(invoice, ["id", "invoiceId", "invoice_id", "externalId", "external_id"]),
    number: first(invoice, ["number", "invoiceNumber", "invoice_number", "externalNumber", "external_number"]),
    provider: typeof providerValue === "string"
      ? providerValue
      : providerValue?.label || providerValue?.name || "Accounting provider",
    externalUrl: first(invoice, ["externalUrl", "external_url", "url", "invoiceUrl", "invoice_url"]),
    createdAt: first(invoice, ["createdAt", "created_at", "creationDate", "creation_date"]),
    createdBy: first(invoice, ["createdByName", "created_by_name", "createdBy", "created_by"]),
    creationDetail: first(invoice, ["creationDetail", "creation_detail", "statusDetail", "status_detail", "message"]),
    error: first(invoice, ["errorMessage", "error_message", "lastError", "last_error", "error"]),
    status,
    pending: ["pending", "creating", "queued", "processing"].includes(status),
    failed: ["failed", "error", "creation_failed"].includes(status),
  };
}

export function invoiceReference(invoice) {
  const normalized = normalizeInvoice(invoice);
  return normalized?.number || normalized?.id || "Pending reference";
}

export function historicalInvoices(invoices, currentInvoice) {
  const current = normalizeInvoice(currentInvoice);
  return (Array.isArray(invoices) ? invoices : [])
    .map((invoice) => normalizeInvoice(invoice))
    .filter(Boolean)
    .filter((invoice) => !current?.id || invoice.id !== current.id);
}

export function invoiceErrorText(error) {
  const details = error?.payload?.details;
  if (typeof details === "string") return details;
  const validation = error?.payload?.validationErrors || error?.payload?.validation_errors
    || error?.payload?.errors || details?.validationErrors || details?.validation_errors
    || details?.errors || details?.error || details;
  if (Array.isArray(validation)) {
    const messages = validation.map((item) => typeof item === "string" ? item : item?.message || item?.msg).filter(Boolean);
    if (messages.length) return messages.join(" ");
  }
  if (validation && typeof validation === "object") {
    const messages = Object.values(validation).flat().map((item) => typeof item === "string" ? item : item?.message || item?.msg).filter(Boolean);
    if (messages.length) return messages.join(" ");
  }
  return details?.message || details?.errorMessage || error?.message || "The invoice action could not be completed.";
}

export function ambiguousCustomerCandidates(error) {
  const payload = error?.payload || {};
  const details = payload.details || {};
  if (error?.status !== 409 || (payload.code || details.code || payload.error?.code) !== "AMBIGUOUS_CUSTOMER_MATCH") return [];
  const candidates = Array.isArray(details.candidates) ? details.candidates : [];
  return candidates.map((candidate) => ({
    providerCustomerId: first(candidate, ["providerCustomerId", "provider_customer_id", "customerId", "customer_id", "id"]),
    name: first(candidate, ["name", "displayName", "display_name"], ""),
    email: first(candidate, ["email", "emailAddress", "email_address"], ""),
  })).filter((candidate) => candidate.providerCustomerId);
}
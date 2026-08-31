const valueOf = (value, keys, fallback = null) => {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return fallback;
};

const asArray = (value) => Array.isArray(value) ? value : [];

const option = (value, idKeys) => {
  if (typeof value === "string") return { id: value, label: value };
  const id = valueOf(value, idKeys);
  return {
    id: id == null ? "" : String(id),
    label: valueOf(value, ["label", "name", "displayName", "display_name", "description"], id == null ? "" : String(id)),
  };
};

export function formatRequiredTaxRate(rate) {
  const numeric = Number(rate);
  if (!Number.isFinite(numeric)) return String(rate);
  const percentage = Math.abs(numeric) > 100 ? numeric / 100 : numeric;
  return `${percentage.toLocaleString()}%`;
}

export function normalizeSalesAccountingConfiguration(payload) {
  const value = payload?.data || payload || {};
  const provider = value.activeProvider ?? value.active_provider ?? null;
  const providerKey = typeof provider === "string"
    ? provider
    : valueOf(provider, ["key", "id", "provider", "name"], "");
  const providerLabel = typeof provider === "string"
    ? ({ quickbooks: "QuickBooks", quickbooks_online: "QuickBooks", xero: "Xero" }[provider.toLowerCase()] || provider)
    : valueOf(provider, ["label", "displayName", "display_name", "name"], "Not connected");
  const rawMappings = value.mappings || {};
  const mappings = Array.isArray(rawMappings)
    ? Object.fromEntries(rawMappings.map((mapping) => [
      String(valueOf(mapping, ["taxRate", "tax_rate", "taxRateBps", "tax_rate_bps", "rate"])),
      valueOf(mapping, ["providerTaxCodeId", "provider_tax_code_id", "taxCodeId", "tax_code_id", "taxCode", "tax_code"]),
    ]))
    : { ...rawMappings };
  return {
    activeProvider: provider,
    providerKey: String(providerKey || "").toLowerCase(),
    providerLabel: providerLabel || "Not connected",
    isReady: value.isReady === true || value.is_ready === true,
    missing: asArray(value.missing).map((item) => typeof item === "string" ? item : valueOf(item, ["message", "label", "code"], "Configuration required")),
    requiredTaxRates: asArray(value.requiredTaxRates ?? value.required_tax_rates).map((item) => ({
      value: String(typeof item === "object" ? valueOf(item, ["taxRateBps", "tax_rate_bps", "rateBps", "rate_bps", "rate"]) : item),
      label: typeof item === "object" ? valueOf(item, ["label", "name"], formatRequiredTaxRate(valueOf(item, ["taxRateBps", "tax_rate_bps", "rateBps", "rate_bps", "rate"]))) : formatRequiredTaxRate(item),
    })),
    mappings,
    availableTaxCodes: asArray(value.availableTaxCodes ?? value.available_tax_codes).map((item) => option(item, ["id", "code", "taxCodeId", "tax_code_id"])).filter((item) => item.id),
    quickbooksSalesItemId: value.quickbooksSalesItemId ?? value.quickbooks_sales_item_id ?? null,
    availableItems: asArray(value.availableItems ?? value.available_items).map((item) => option(item, ["id", "itemId", "item_id"])).filter((item) => item.id),
  };
}

export function hasAccountingManagementCapability(...sources) {
  for (const source of sources) {
    const candidates = [source, source?.permissions, source?.capabilities, source?.salesPermissions, source?.sales_permissions];
    for (const candidate of candidates) {
      if (candidate?.canManageAccounting === true || candidate?.can_manage_accounting === true) return true;
    }
  }
  return false;
}

export function missingPrerequisiteLabel(value) {
  const labels = {
    tax_mapping: "Map every required Sales tax rate to a provider tax code.",
    tax_mappings: "Map every required Sales tax rate to a provider tax code.",
    quickbooks_sales_item: "Choose the QuickBooks sales item used for invoice lines.",
    quickbooks_sales_item_id: "Choose the QuickBooks sales item used for invoice lines.",
    active_provider: "Connect and select an accounting provider.",
    missing_tax_mapping: "Map every required Sales tax rate to a provider tax code.",
    missing_sales_item: "Choose the QuickBooks sales item used for invoice lines.",
  };
  const key = String(value || "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return labels[key] || String(value || "Configuration required").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

export function serializeSalesAccountingConfiguration(configuration, draft) {
  const requiredRates = configuration?.requiredTaxRates || [];
  if (!requiredRates.length) throw new Error("At least one required tax rate must be configured.");
  const missingRates = [];
  const mappings = requiredRates.map((rate) => {
    const taxRateBps = Number(rate.value);
    const providerTaxCodeId = draft?.mappings?.[rate.value];
    if (!Number.isInteger(taxRateBps) || providerTaxCodeId === null
      || providerTaxCodeId === undefined || String(providerTaxCodeId).trim() === "") {
      missingRates.push(rate.label);
      return null;
    }
    return { taxRateBps, providerTaxCodeId: String(providerTaxCodeId) };
  }).filter(Boolean);
  if (missingRates.length) {
    throw new Error(`Select a provider tax code for: ${missingRates.join(", ")}.`);
  }
  const payload = { mappings };
  if (String(configuration?.providerKey || "").includes("quickbooks")) {
    if (!draft?.quickbooksSalesItemId) throw new Error("Select a QuickBooks sales item.");
    payload.quickbooksSalesItemId = String(draft.quickbooksSalesItemId);
  }
  return payload;
}

export function accountingErrorGuidance(error) {
  const payload = error?.payload || {};
  const code = payload.code || payload.errorCode || payload.error_code
    || payload.details?.code || payload.details?.errorCode || payload.details?.error_code || payload.error?.code
    || (typeof payload.error === "string" ? payload.error : null);
  const guidance = {
    ACCOUNTING_TAX_MAPPING_REQUIRED: "Map every required tax rate in Sales settings, then try again.",
    ACCOUNTING_SALES_ITEM_REQUIRED: "Choose the QuickBooks sales item in Sales settings, then try again.",
    ACCOUNTING_TAX_CODE_INVALID: "A mapped tax code is no longer available. Update the tax mappings in Sales settings, then try again.",
    ACCOUNTING_SALES_ITEM_INVALID: "The selected QuickBooks sales item is no longer available. Choose another item in Sales settings, then try again.",
    // Retained for responses created by older API versions.
    ACCOUNTING_TAX_MAPPING_MISSING: "Map every required tax rate in Sales settings, then try again.",
    ACCOUNTING_ITEM_MISSING: "Choose the QuickBooks sales item in Sales settings, then try again.",
    ACCOUNTING_CONFIGURATION_REQUIRED: "Complete the accounting configuration in Sales settings, then try again.",
  };
  return guidance[code] ? { code, message: guidance[code], href: "/sales/settings" } : null;
}
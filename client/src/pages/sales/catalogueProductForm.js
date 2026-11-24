import { selectedProviderTaxCode, taxCodeKey } from "../../lib/salesTaxCodes.js";

export const CATALOGUE_FIELDS = {
  categories: ["name", "code", "description"],
  products: ["name", "code", "sku", "categoryId", "currency", "standardPriceMinor", "minimumPriceMinor", "costMinor", "shortDescription", "description", "availableFrom", "availableTo", "eventReference", "capacityMetadata", "createTaskOnAcceptance", "spaceRequirementId", "membershipScheduleId"],
  bundles: ["name", "code", "categoryId", "currency", "sellingPriceMinor", "minimumPriceMinor", "presentationMode", "availableFrom", "availableTo", "description", "items", "billingGroups"],
};

// Copy only createable fields, never identity, lifecycle or accounting snapshots.
export function catalogueCopyForEditing(type, source, freshCode) {
  const copy = Object.fromEntries(CATALOGUE_FIELDS[type].filter((key) => key in source).map((key) => [key, structuredClone(source[key])]));
  copy.name = `${String(source.name || "").slice(0, 248)} (copy)`;
  copy.code = freshCode;
  if (type === "products") {
    copy.sku = "";
    copy.eventReference = null;
    Object.assign(copy, productPricesForEditing(source));
  }
  if (type === "bundles") {
    copy.copySourceId = source.id;
    Object.assign(copy, bundlePricesForEditing(source));
    const componentIds = new Map();
    copy.items = (source.items || []).map(item => {
      if (item.kind !== "ticket") return { productId: item.productId, quantity: item.quantity };
      const componentId = crypto.randomUUID();
      componentIds.set(item.componentId, componentId);
      return { kind: "ticket", componentId, eventReference: structuredClone(item.eventReference), quantity: item.quantity };
    });
    copy.billingGroups = (source.billingGroups || []).map((group, position) => ({
      id: crypto.randomUUID(), sourceGroupId: group.id, name: group.name, position,
      productIds: group.productIds.map(id => componentIds.get(id) || id), allocatedMinor: group.allocatedMinor,
      timing: structuredClone(group.timing), paymentTerms: structuredClone(group.paymentTerms),
      ...(group.issueDelayPreset ? { issueDelayPreset: structuredClone(group.issueDelayPreset) } : {}),
    }));
  }
  return copy;
}

export function bundleItemsForSaving(items = []) {
  return items.map(item => {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Use a positive whole quantity for every included item.");
    if (item.kind === "ticket") {
      const reference = item.eventReference || {};
      if (!reference.kind || !reference.eventId || !reference.ticketTypeId) throw new Error("Choose an event and ticket type for every included ticket.");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.componentId || "")) throw new Error("Ticket identity is missing. Remove and add the ticket again.");
      return { kind: "ticket", componentId: item.componentId, eventReference: { kind: reference.kind, eventId: reference.eventId, ticketTypeId: reference.ticketTypeId }, quantity };
    }
    if (!item.productId) throw new Error("Choose a product for every included item, or remove the empty row.");
    return { productId: item.productId, quantity };
  });
}

export function selectableCopyTaxId(source, items) {
  const key = taxCodeKey(source?.taxCode);
  return items.some((item) => item.selectable && taxCodeKey(item) === key) ? key : "";
}

const PRICE_FIELDS = ["standardPriceMinor", "minimumPriceMinor", "costMinor"];
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

// Never multiply a floating point decimal: construct the integer from digits.
export function decimalToMinor(value, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    if (required) throw new Error("Enter a standard price.");
    return null;
  }
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) {
    throw new Error("Enter a non-negative amount with at most two decimal places.");
  }
  const [whole = "", fraction = ""] = text.split(".");
  const minor = BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > MAX_MINOR) throw new Error("This amount is too large to save safely.");
  return Number(minor);
}

export function minorToDecimal(value) {
  if (value === null || value === undefined || value === "") return "";
  const minor = BigInt(value);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
}

export function productPricesForEditing(row = {}) {
  return Object.fromEntries(PRICE_FIELDS.map((key) => [key, minorToDecimal(row[key])]));
}

export function productPricesForSaving(form) {
  const prices = {};
  const labels = { standardPriceMinor: "Standard price", minimumPriceMinor: "Minimum price", costMinor: "Cost" };
  for (const key of PRICE_FIELDS) {
    try {
      prices[key] = decimalToMinor(form[key], { required: key === "standardPriceMinor" });
    } catch (error) {
      throw new Error(`${labels[key]}: ${error.message}`);
    }
  }
  if (prices.minimumPriceMinor !== null && prices.minimumPriceMinor > prices.standardPriceMinor) {
    throw new Error("Minimum price must not exceed standard price.");
  }
  return prices;
}

export function bundlePricesForEditing(row = {}) {
  return {
    sellingPriceMinor: minorToDecimal(row.sellingPriceMinor),
    minimumPriceMinor: minorToDecimal(row.minimumPriceMinor),
  };
}

export function bundlePricesForSaving(form) {
  if (!String(form.sellingPriceMinor ?? "").trim()) throw new Error("Enter a selling price.");
  const prices = {};
  for (const [key, label] of [["sellingPriceMinor", "Selling price"], ["minimumPriceMinor", "Minimum price"]]) {
    try {
      prices[key] = decimalToMinor(form[key]);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
  }
  if (prices.minimumPriceMinor !== null && prices.minimumPriceMinor > prices.sellingPriceMinor) {
    throw new Error("Minimum price must not exceed selling price.");
  }
  return prices;
}

export function productTaxForSaving(existing, selectedId, items, available = true) {
  if (!selectedId && existing) return {};
  const code = selectedProviderTaxCode(selectedId, items, available);
  return { taxCode: { provider: code.provider, id: code.id } };
}

export function taxPercent(rateBps) {
  return rateBps === null || rateBps === undefined || rateBps === "" ? "Not set" : `${Number(rateBps) / 100}%`;
}

import { selectedProviderTaxCode, taxCodeKey } from "../../lib/salesTaxCodes.js";

export const CATALOGUE_FIELDS = {
  categories: ["name", "code", "description"],
  products: ["name", "code", "sku", "categoryId", "currency", "standardPriceMinor", "minimumPriceMinor", "costMinor", "shortDescription", "description", "availableFrom", "availableTo", "eventReference", "capacityMetadata", "createTaskOnAcceptance"],
  bundles: ["name", "code", "currency", "sellingPriceMinor", "minimumPriceMinor", "presentationMode", "availableFrom", "availableTo", "description", "items"],
};

// Copy only createable fields, never identity, lifecycle or accounting snapshots.
export function catalogueCopyForEditing(type, source, freshCode) {
  const copy = Object.fromEntries(CATALOGUE_FIELDS[type].filter((key) => key in source).map((key) => [key, structuredClone(source[key])]));
  copy.name = `${String(source.name || "").slice(0, 248)} (copy)`;
  copy.code = freshCode;
  if (type === "products") {
    copy.sku = "";
    Object.assign(copy, productPricesForEditing(source));
  }
  if (type === "bundles") {
    Object.assign(copy, bundlePricesForEditing(source));
    copy.items = (source.items || []).map(({ productId, quantity }) => ({ productId, quantity }));
  }
  return copy;
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

import { decimalToMinor, minorToDecimal } from "../../pages/sales/catalogueProductForm.js";

export function quotePriceText(line, field) {
  return line[`${field}Input`] ?? minorToDecimal(line[field]);
}

export function quotePriceMinor(line, field) {
  const text = quotePriceText(line, field);
  if (!String(text).trim()) throw new Error("Enter a price.");
  return decimalToMinor(text);
}

export function quotePriceError(line) {
  for (const [field, label] of [["standardUnitPriceMinor", "Standard"], ["quotedUnitPriceMinor", "Quoted"]]) {
    try { quotePriceMinor(line, field); } catch (error) { return `${label} price: ${error.message}`; }
  }
  return "";
}

export function emptyBillingAddress() {
  return { addressee: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };
}

export function organizationBillingAddress(organization) {
  const address = emptyBillingAddress();
  const raw = organization?.invoicing_address;
  if (typeof raw !== "string" || !raw.trim()) return address;
  // The organisation field is free text, not structured address data.
  // Keep every line; do not invent a country or guess a postcode.
  const lines = raw.trim().split(/\r?\n/);
  return { ...address, addressee: organization.name || "", line1: lines[0], line2: lines.slice(1).join("\n") };
}

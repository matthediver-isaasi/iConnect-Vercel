import { decimalToMinor, minorToDecimal } from "../../pages/sales/catalogueProductForm.js";
import { resolveStoredInvoicingAddress } from "../../../../shared/invoicingAddress.js";

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
  const resolved = resolveStoredInvoicingAddress(organization, "organization");
  if (!resolved) return address;
  if (resolved.source === "structured") {
    const fields = resolved.address;
    return {
      addressee: organization?.name || "",
      line1: fields.invoicing_address_line1,
      line2: fields.invoicing_address_line2,
      city: fields.invoicing_city,
      region: fields.invoicing_region,
      postalCode: fields.invoicing_postal_code,
      country: fields.invoicing_country,
    };
  }
  // Preserve genuinely legacy text without guessing geographic components.
  // Structured and legacy addresses must never be spliced together.
  const lines = resolved.address.trim().split(/\r?\n/);
  return { ...address, addressee: organization.name || "", line1: lines[0], line2: lines.slice(1).join("\n") };
}

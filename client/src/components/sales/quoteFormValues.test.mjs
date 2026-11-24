import test from "node:test";
import assert from "node:assert/strict";
import { quotePriceText, quotePriceMinor, quotePriceError, organizationBillingAddress } from "./quoteFormValues.js";

test("quote currency preserves stored amounts and converts edits exactly once", () => {
  for (const amount of [0, 29, 4000, 1234567, Number.MAX_SAFE_INTEGER]) {
    const line = { standardUnitPriceMinor: amount, quotedUnitPriceMinor: amount };
    assert.equal(quotePriceMinor(line, "quotedUnitPriceMinor"), amount);
    assert.equal(quotePriceError(line), "");
  }
  const line = { standardUnitPriceMinor: 4000, quotedUnitPriceMinor: 4000, quotedUnitPriceMinorInput: "35.29" };
  assert.equal(quotePriceText(line, "standardUnitPriceMinor"), "40.00");
  assert.equal(quotePriceText(line, "quotedUnitPriceMinor"), "35.29");
  assert.equal(quotePriceMinor(line, "quotedUnitPriceMinor"), 3529);
  for (const input of ["", "-2", "1.234", "1e3", "NaN", "£40", "90071992547409.92"]) {
    const invalid = { ...line, quotedUnitPriceMinorInput: input };
    assert.throws(() => quotePriceMinor(invalid, "quotedUnitPriceMinor"));
    assert.match(quotePriceError(invalid), /Quoted price/);
  }
});

test("free-text organisation address is preserved completely without geographic guesses", () => {
  const address = organizationBillingAddress({ name: "Example", invoicing_address: "10 High Street\r\nBuilding 2\r\nLeeds\r\nLS1 1AA\r\nUK" });
  assert.equal(address.addressee, "Example");
  assert.equal(address.line1, "10 High Street");
  assert.equal(address.line2, "Building 2\nLeeds\nLS1 1AA\nUK");
  assert.equal(address.country, "");
  assert.equal(address.postalCode, "");
  assert.ok(Object.values(organizationBillingAddress({})).every(value => value === ""));
});

test("structured CRM invoicing fields map one-to-one, without legacy contamination", () => {
  const source = {
    name: "Example", invoicing_address: "Old address\nOld city\nOld postcode",
    invoicing_address_line1: " 10 Finance Road ", invoicing_address_line2: "Building 2",
    invoicing_city: "Leeds", invoicing_region: "West Yorkshire",
    invoicing_postal_code: "LS1 1AA", invoicing_country: "United Kingdom",
  };
  const snapshot = organizationBillingAddress(source);
  assert.deepEqual(snapshot, {
    addressee: "Example", line1: "10 Finance Road", line2: "Building 2",
    city: "Leeds", region: "West Yorkshire", postalCode: "LS1 1AA", country: "United Kingdom",
  });
  assert.equal(source.invoicing_address_line1, " 10 Finance Road ");
  assert.equal(organizationBillingAddress({ ...source, invoicing_address_line2: "" }).line2, "");
});

test("partial structured addresses do not invent or mix geographic values", () => {
  assert.deepEqual(organizationBillingAddress({ name: "Example", invoicing_address_line1: "One street" }), {
    addressee: "Example", line1: "One street", line2: "", city: "", region: "", postalCode: "", country: "",
  });
  assert.throws(() => organizationBillingAddress({ invoicing_city: {} }), /must be text/);
});

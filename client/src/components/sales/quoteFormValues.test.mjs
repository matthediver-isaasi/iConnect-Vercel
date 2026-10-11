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

import assert from "node:assert/strict";
import test from "node:test";
import { INVOICING_CORE_FIELDS, DEFAULT_INVOICING_CARD, invoicingAddressFormValues, invoicingAddressChanges, withInvoicingAddressChanges } from "./invoicingAddressFields.js";

test("all six address fields are available as independent core layout fields", () => {
  assert.equal(INVOICING_CORE_FIELDS.length, 6);
  assert.equal(new Set(INVOICING_CORE_FIELDS.map(f => f.id)).size, 6);
  for (const field of INVOICING_CORE_FIELDS) {
    assert.equal(field.id, `core:${field.fieldKey}`);
    assert.equal(field.type, "text");
    assert.ok(field.label);
    assert.ok(field.maxLength > 0);
    assert.ok(DEFAULT_INVOICING_CARD.fields.some(f => f.id === field.id));
  }
});

test("hydration never inherits a linked organisation or group billing address", () => {
  const member = { invoicing_city: "Personal city", organization: { invoicing_city: "Organisation city" }, organization_group: { invoicing_country: "Group country" } };
  const values = invoicingAddressFormValues(member);
  assert.equal(values.invoicing_city, "Personal city");
  assert.equal(values.invoicing_country, "");
  assert.equal(Object.keys(values).length, 6);
});

test("ordinary edits retain legacy address and do not submit missing new columns", () => {
  const oldRecord = { name: "Legacy organisation", invoicing_address: "Building\nTown\nPostcode" };
  const draft = { ...oldRecord, ...invoicingAddressFormValues(oldRecord), name: "Updated name" };
  assert.deepEqual(invoicingAddressChanges(draft, oldRecord), {});
  assert.deepEqual(withInvoicingAddressChanges(draft, oldRecord), { ...oldRecord, name: "Updated name" });
});

test("only changed structured fields are sent; explicit clearing is retained", () => {
  const record = { invoicing_city: "Old city", invoicing_country: "United Kingdom", invoicing_address: "Legacy" };
  const draft = { ...record, ...invoicingAddressFormValues(record), invoicing_city: "", invoicing_address_line1: "New street" };
  assert.deepEqual(invoicingAddressChanges(draft, record), { invoicing_address_line1: "New street", invoicing_city: "" });
  assert.equal(withInvoicingAddressChanges(draft, record).invoicing_address, "Legacy");
  assert.equal(record.invoicing_city, "Old city");
});

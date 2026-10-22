import assert from "node:assert/strict";
import test from "node:test";
import { INVOICING_CORE_FIELDS, DEFAULT_INVOICING_CARD, invoicingAddressFormValues, invoicingAddressChanges, withoutInvoicingAddress, saveNewInvoicingAddressOwner } from "./invoicingAddressFields.js";

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
  assert.deepEqual(withoutInvoicingAddress(draft), { ...oldRecord, name: "Updated name" });
});

test("only changed structured fields are sent; explicit clearing is retained", () => {
  const record = { invoicing_city: "Old city", invoicing_country: "United Kingdom", invoicing_address: "Legacy" };
  const draft = { ...record, ...invoicingAddressFormValues(record), invoicing_city: "", invoicing_address_line1: "New street" };
  assert.deepEqual(invoicingAddressChanges(draft, record), { invoicing_address_line1: "New street", invoicing_city: "" });
  assert.deepEqual(withoutInvoicingAddress(draft), { invoicing_address: "Legacy" });
  assert.equal(record.invoicing_city, "Old city");
});

test("new organisation address failure is surfaced and retry does not create another owner", async () => {
  let creates = 0;
  let writes = 0;
  let fail = true;
  const createdOwnerRef = { current: null };
  const options = {
    createdOwnerRef,
    core: { name: "New org", invoicing_city: "Never an entity column", invoicing_address: "Legacy" },
    address: {
      scopeKey: "tenant/viewer/new",
      assertCurrent() {},
      async save(ownerId) {
        assert.equal(creates, 1, "owner must exist before the address write");
        assert.equal(ownerId, "created-owner");
        if (fail) throw new Error("Address write failed");
      },
    },
    async createOwner(core) {
      creates++;
      assert.deepEqual(core, { name: "New org", invoicing_address: "Legacy" });
      return { id: "created-owner" };
    },
    async updateOwner(id, core) {
      writes++;
      assert.equal(id, "created-owner");
      assert.equal(core.invoicing_city, undefined);
    },
  };
  await assert.rejects(saveNewInvoicingAddressOwner(options), /Address write failed/);
  assert.equal(createdOwnerRef.current.organization.id, "created-owner");
  fail = false;
  assert.equal((await saveNewInvoicingAddressOwner(options)).id, "created-owner");
  assert.equal(creates, 1);
  assert.equal(writes, 1);
  options.address.assertCurrent = () => { throw new Error("Session changed"); };
  await assert.rejects(saveNewInvoicingAddressOwner(options), /Session changed/);
  assert.equal(writes, 1);
});

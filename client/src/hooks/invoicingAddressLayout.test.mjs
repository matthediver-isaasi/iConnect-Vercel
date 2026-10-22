import test from "node:test";
import assert from "node:assert/strict";
import { MEMBER_CORE_FIELDS, mergeLayoutWithCustomFields as mergeMember } from "./useMemberDetailLayout.js";
import { CORE_FIELDS, mergeLayoutWithCustomFields as mergeOrg } from "./useOrgDetailLayout.js";
import { GROUP_CORE_FIELDS, mergeGroupLayoutWithCustomFields as mergeGroup } from "./useGroupDetailLayout.js";
import { INVOICING_CORE_FIELDS } from "../lib/invoicingAddressFields.js";

test("member, organisation and group layout pickers expose all billing core fields", () => {
  for (const registry of [MEMBER_CORE_FIELDS, CORE_FIELDS, GROUP_CORE_FIELDS]) {
    for (const field of INVOICING_CORE_FIELDS) {
      assert.deepEqual(registry.find(item => item.id === field.id), field);
      assert.equal(registry.filter(item => item.id === field.id).length, 1);
    }
  }
  assert.ok(CORE_FIELDS.find(field => field.fieldKey === "invoicing_address"));
});

test("existing customised layouts are not repopulated with new billing fields", () => {
  for (const [merge, fieldKey] of [[mergeMember, "first_name"], [mergeOrg, "name"], [mergeGroup, "name"]]) {
    const layout = { cards: [{ id: "saved-card", title: "Saved", columns: 1,
      fields: [{ id: `core:${fieldKey}`, fieldKey, type: "core", columnIndex: 0 }] }] };
    assert.deepEqual(merge(structuredClone(layout), []), layout);
  }
});

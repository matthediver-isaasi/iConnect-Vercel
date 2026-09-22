import assert from "node:assert/strict";
import test from "node:test";
import { categoryStatus } from "./MemberCommunicationStatusReport.jsx";

const category = { id: "category-role-only" };

test("categoryStatus preserves canonical optedIn consent when a category is unavailable", () => {
  const status = categoryStatus({
    categoryStatuses: {
      "category-role-only": {
        optedIn: true,
        available: false,
        unavailableReason: "role_ineligible",
      },
    },
  }, category);

  assert.deepEqual(status, {
    value: true,
    unavailable: true,
    reason: "role_ineligible",
  });
});

test("categoryStatus preserves explicit canonical false consent when unavailable", () => {
  const status = categoryStatus({
    categoryStatuses: {
      "category-role-only": {
        optedIn: false,
        available: false,
        unavailableReason: "inactive",
      },
    },
  }, category);

  assert.equal(status.value, false);
  assert.equal(status.unavailable, true);
});
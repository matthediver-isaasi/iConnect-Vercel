import assert from "node:assert/strict";
import test from "node:test";
import { getOpportunityUiCapabilities } from "./opportunityCapabilities.js";

test("collaborator can edit without receiving collaborator-management controls", () => {
  const capabilities = getOpportunityUiCapabilities({
    canEdit: true,
    canManage: false,
  });

  assert.equal(capabilities.canEdit, true);
  assert.equal(capabilities.canManage, false);
});

test("owner management capability remains distinct from edit capability", () => {
  const capabilities = getOpportunityUiCapabilities({
    canEdit: true,
    canManage: true,
  });

  assert.deepEqual(capabilities, { canEdit: true, canManage: true });
});
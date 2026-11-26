import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("client/src/components/sales/OpportunitiesWorkspace.jsx", "utf8");

test("opportunity list separates active and archived cache entries and requests the selected archive state", () => {
  assert.match(source, /queryKey:\s*\["opportunities", page, debouncedSearch, stageId, mine, view, archived, destination, "converted-forecast"\]/);
  assert.match(source, /params\.set\("archived", String\(archived\)\)/);
  assert.match(source, /aria-pressed=\{archived\}[\s\S]*?setArchived\(true\)/);
  assert.match(source, /\{archived \? "Archived"[\s\S]*?date\(archived \? item\.archived_at/);
});

test("archive, restore, and permanent delete use optimistic version checks and required delete confirmation", () => {
  assert.match(source, /action, expectedVersion: opportunity\.version/);
  assert.match(source, /method: "DELETE", body: JSON\.stringify\(\{ expectedVersion: opportunity\.version, confirmDelete: true \}\)/);
  assert.match(source, /lifecycle\.mutate\("restore"\)/);
  assert.match(source, /canManageLifecycle && \(archived/);
  assert.match(source, /lifecycleDialog === "delete" && !archived/);
});

test("archive/delete confirmations describe the affected records and archival financial safeguards", () => {
  assert.match(source, /does not cancel invoices, payments or proposals/i);
  assert.match(source, /notes, tasks, contacts and activity/i);
  assert.match(source, /proposals, commercial records or documents remain/i);
  assert.match(source, /Archived opportunity\./);
});

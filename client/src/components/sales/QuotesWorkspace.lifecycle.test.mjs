import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./QuotesWorkspace.jsx", import.meta.url), "utf8");

test("proposal list isolates Active and Archived pages in its query and resets pagination", () => {
  assert.match(source, /queryKey:\s*\["sales-quotes", search, status, page, opportunityId, archived\]/);
  assert.match(source, /params\.set\("archived", String\(archived\)\)/);
  assert.match(source, /setArchived\(value === "archived"\); setPage\(1\)/);
});

test("lifecycle requests use the root row version and exact API contract", () => {
  assert.match(source, /action === "delete" \? "" : `\?action=\$\{action\}`/);
  assert.match(source, /method:\s*action === "delete" \? "DELETE" : "POST"/);
  assert.match(source, /expectedVersion: row\.row_version \?\? row\.rowVersion/);
  assert.match(source, /confirmDelete: true/);
  assert.doesNotMatch(source, /expectedVersion:\s*row\.version_number/);
});

test("lifecycle UI protects commitments, confirms irreversible deletion and invalidates related caches", () => {
  assert.match(source, /does not cancel payments, invoices, bookings or release reservations/);
  assert.match(source, /Only unused drafts can be deleted\. This is irreversible/);
  assert.match(source, /qc\.invalidateQueries\(\{ queryKey: \["sales-quotes"\] \}\)/);
  assert.match(source, /qc\.invalidateQueries\(\{ queryKey: \["opportunity"\] \}\)/);
  assert.match(source, /qc\.invalidateQueries\(\{ queryKey: \["sales-reports"\] \}\)/);
  assert.match(source, /qc\.removeQueries\(\{ queryKey: \["sales-quote", idOf\(row\)\] \}\)/);
});

test("archived proposals remain navigable and lifecycle controls stop row navigation", () => {
  assert.match(source, /onClick=\{\(\) => navigate\(quotePath\(naming, idOf\(row\)\)\)\}/);
  assert.match(source, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(source, /"restore"/);
  assert.match(source, /"delete"/);
});

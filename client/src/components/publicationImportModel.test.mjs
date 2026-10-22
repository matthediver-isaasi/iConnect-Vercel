import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkbook, canApplyPreview, displayImportValue, postPublicationImport, validateImportReceipt } from "./publicationImportModel.mjs";

test("accepts XLSX up to 1MB and rejects missing, empty, oversized or other files", () => {
  assert.equal(validateWorkbook({ name: "Publications.XLSX", size: 1024 * 1024 }), null);
  for (const file of [null, { name: "x.xlsx", size: 0 }, { name: "x.xlsx", size: 1048577 }, { name: "x.csv", size: 25 }]) {
    assert.equal(typeof validateWorkbook(file), "string");
  }
});

test("requires server approval, a token and no errors; allows an all-skipped receipt", () => {
  const valid = { planId: "plan-1", canApply: true, rows: [{ action: "create", errors: [] }, { action: "skip", errors: [] }] };
  assert.equal(canApplyPreview(valid), true);
  assert.equal(canApplyPreview({ ...valid, rows: [{ action: "skip" }] }), true);
  for (const change of [
    { planId: "" }, { canApply: false }, { needsSheetSelection: true }, { rows: [] },
    { rows: [{ action: "error", errors: [] }] },
    { rows: [{ action: "create", errors: ["Unknown writer"] }] },
    { rows: Array.from({ length: 101 }, () => ({ action: "create" })) },
  ]) assert.equal(canApplyPreview({ ...valid, ...change }), false);
});

test("validates final counts and per-row receipts instead of showing an empty success", () => {
  const valid = { done: true, created: 1, skipped: 1, failed: 0, rows: [{ row: 2, action: "create" }, { row: 3, action: "skip" }] };
  assert.equal(validateImportReceipt(valid, 2), true);
  assert.equal(validateImportReceipt({ ...valid, done: false }, 3), true);
  for (const value of [
    {}, null, { done: true }, { ...valid, created: "1" },
    { ...valid, failed: -1 }, { ...valid, rows: [] },
    { ...valid, rows: [null, {}] }, { ...valid, skipped: 0 },
    { ...valid, rows: [{ row: 2 }, { row: 2 }] },
    { ...valid, rows: [{ row: "2" }, { row: 3 }] },
    { done: true, created: 0, skipped: 0, failed: 0, rows: [] },
  ]) assert.equal(validateImportReceipt(value, 2), false);
});

test("distinguishes definitive rejection from uncertain 5xx/timeout responses", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 401, 403, 409, 410, 422, 408, 429, 500, 503]) {
      globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ error: "Fixture failure" }) });
      await assert.rejects(postPublicationImport({ action: "apply", planId: "fixture" }), error => {
        assert.equal(error.status, status);
        assert.equal(error.definitive, [400, 401, 403, 409, 410, 422].includes(status));
        return true;
      });
    }
  } finally { globalThis.fetch = original; }
});

test("displays nested contributor data, booleans, nulls and arrays without hiding fields", () => {
  assert.equal(displayImportValue(false), "No");
  assert.equal(displayImportValue(null), "Not set");
  assert.match(displayImportValue({ contributor: { email: "mira@example.org" }, copyright_required: true }), /mira@example.org.*Copyright required: Yes/);
});

test("apply retries retain the exact plan token and include session credentials", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) throw new TypeError("Network interrupted");
    return { ok: true, json: async () => ({ done: true, created: 1, skipped: 0, failed: 0 }) };
  };
  try {
    const body = { action: "apply", planId: "same-private-plan" };
    await assert.rejects(postPublicationImport(body), /Network interrupted/);
    assert.equal((await postPublicationImport(body)).done, true);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[1].credentials, "include");
  } finally { globalThis.fetch = original; }
});

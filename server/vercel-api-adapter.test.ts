import test from "node:test";
import assert from "node:assert/strict";
import { findHandler } from "./vercel-api-adapter";

test("catch-all API routes expose Vercel-compatible detail parameters", async () => {
  const result = await findHandler("/api/sales/quotes/quote-id");

  assert.equal(typeof result?.handler, "function");
  assert.deepEqual(result?.params, { path: "quote-id" });
});

test("catch-all API routes consume all nested action segments", async () => {
  const result = await findHandler("/api/sales/quotes/quote-id/issue");

  assert.equal(typeof result?.handler, "function");
  assert.deepEqual(result?.params, { path: "quote-id/issue" });
});
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

test("event click endpoints are discoverable through the Vercel API adapter", async () => {
  const ingestion = await findHandler("/api/public/event-click");
  const counts = await findHandler("/api/admin/events/click-counts");

  assert.equal(typeof ingestion?.handler, "function");
  assert.deepEqual(ingestion?.params, {});
  assert.equal(typeof counts?.handler, "function");
  assert.deepEqual(counts?.params, {});
});

test("Department current-set prefill is discoverable through the Vercel API adapter", async () => {
  const result = await findHandler("/api/public/form/current-set");
  assert.equal(typeof result?.handler, "function");
  assert.deepEqual(result?.params, {});
});

test("historical Direct Debit endpoint is discoverable through the Vercel API adapter", async () => {
  const result = await findHandler("/api/membership/historical-dd");
  assert.equal(typeof result?.handler, "function");
  assert.deepEqual(result?.params, {});
});
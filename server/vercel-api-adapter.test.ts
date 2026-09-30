import test from "node:test";
import assert from "node:assert/strict";
import { findHandler } from "./vercel-api-adapter";

test("booking credit reconciliation endpoints are discoverable as distinct exact routes", async () => {
  const admin = await findHandler("/api/reports/reconcile-booking-credits");
  const cron = await findHandler("/api/cron/reconcile-booking-credits");
  assert.equal(typeof admin?.handler, "function");
  assert.equal(typeof cron?.handler, "function");
  assert.deepEqual(admin?.params, {});
  assert.deepEqual(cron?.params, {});
  assert.notEqual(admin?.handler, cron?.handler);
});

test("role settings replacement is registered separately from duplication", async () => {
  const copy = await findHandler("/api/admin/roles/copy-settings");
  const duplicate = await findHandler("/api/admin/roles/duplicate");
  assert.equal(typeof copy?.handler, "function");
  assert.equal(typeof duplicate?.handler, "function");
  assert.notEqual(copy?.handler, duplicate?.handler);
  assert.deepEqual(copy?.params, {});
});

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

test("historical Direct Debit invoice endpoint is discoverable through the Vercel API adapter", async () => {
  const result = await findHandler("/api/membership/historical-dd-invoice");
  assert.equal(typeof result?.handler, "function");
  assert.deepEqual(result?.params, {});
});

for (const entity of ["Event", "ComplexEvent"]) {
  test(`generic ${entity} collection and record handlers are available in development`, async () => {
    const collection = await findHandler(`/api/entities/${entity}`);
    const record = await findHandler(`/api/entities/${entity}/event-id`);

    assert.equal(typeof collection?.handler, "function");
    assert.deepEqual(collection?.params, { entity });
    assert.equal(typeof record?.handler, "function");
    assert.deepEqual(record?.params, { entity, id: "event-id" });
    assert.notEqual(collection?.handler, record?.handler);
  });
}

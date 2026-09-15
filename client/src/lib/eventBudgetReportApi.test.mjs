import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBudgetError,
  eventBudgetErrorMessage,
  normalizeEventBudgetError,
  readEventBudgetResponse,
} from "./eventBudgetReportApi.js";

test("reports an actionable sign-in message for unauthenticated requests", () => {
  assert.match(eventBudgetErrorMessage(401), /sign in again/i);
  assert.equal(createEventBudgetError(401, {}).status, 401);
});

test("reports an actionable permission message for forbidden requests", () => {
  assert.match(eventBudgetErrorMessage(403, "add a cost line"), /permission/i);
  assert.match(eventBudgetErrorMessage(403, "add a cost line"), /add a cost line/i);
});

test("reports an actionable reload message for tenant conflicts", () => {
  assert.match(eventBudgetErrorMessage(409), /reload/i);
  assert.match(eventBudgetErrorMessage({ code: "TENANT_CONTEXT_CHANGED" }), /reload/i);
});

test("reports an actionable retry message for service and network failures", () => {
  assert.match(eventBudgetErrorMessage(503), /retry/i);
  assert.match(normalizeEventBudgetError(new TypeError("network down"), "load cost lines").message, /retry/i);
});

test("preserves useful endpoint validation messages", async () => {
  const response = new Response(JSON.stringify({ error: "description is required" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(
    () => readEventBudgetResponse(response, "add a cost line"),
    (error) => error.status === 400 && error.message === "description is required",
  );
});
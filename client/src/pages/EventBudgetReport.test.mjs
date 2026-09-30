import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pageSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "EventBudgetReport.jsx"),
  "utf8",
);

test("the report and inline cost-line requests use the tenant-aware adminFetch wrapper", () => {
  assert.match(pageSource, /adminFetch\(`\/api\/reports\/event-budget-report\?/);
  assert.match(pageSource, /adminFetch\(`\/api\/reports\/event-budget-report-cost-lines/);
  assert.doesNotMatch(pageSource, /\bfetch\s*\(/);
});

test("report and cost-line caches are scoped by tenant context and readiness", () => {
  assert.match(pageSource, /queryKey: \["event-budget-report", tenantKey, tenantContextRevision, appliedFilters\]/);
  assert.match(pageSource, /const linesQueryKey = \["event-cost-lines", tenantKey, tenantContextRevision, eventKind, eventId\]/);
  assert.match(pageSource, /enabled: reportReady && !!appliedFilters/);
  assert.match(pageSource, /enabled: !!eventId && !!tenantKey/);
  assert.match(pageSource, /disabled=\{!reportReady \|\| isFetching\}/);
});

test("failed queries remove stale report and cost-line data from the UI", () => {
  assert.match(pageSource, /const rows = !reportReady \|\| isError \? \[\] :/);
  assert.match(pageSource, /const totals = !reportReady \|\| isError \? null :/);
  assert.match(pageSource, /const costLines = isError \? \[\] :/);
  assert.match(pageSource, /data-testid="button-retry-report"/);
  assert.match(pageSource, /data-testid="button-retry-cost-lines"/);
});
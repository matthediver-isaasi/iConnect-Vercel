import { test, expect } from "@playwright/test";

/*
 * These tests intentionally use an isolated browser fixture.  Every /api/
 * request is intercepted below and served from in-memory records; no
 * credentials, live tenant, or database are used.
 */

const TENANT = {
  id: "tenant-task4397",
  slug: "task4397-fixture",
  name: "Task 4397 Fixture",
};

const MEMBER = {
  id: "member-task4397",
  email: "task4397.admin@example.invalid",
  first_name: "Task",
  last_name: "4397",
  tenant_id: TENANT.id,
  organization_id: "organisation-task4397",
  role_id: "role-task4397",
  member_excluded_features: [],
  is_team_member: false,
};

const ROLE = {
  id: MEMBER.role_id,
  name: "Task 4397 administrator",
  excluded_features: [],
  default_landing_page: "Preferences",
};

const EVENT_ROWS = [
  {
    event_id: "simple-event-task4397",
    event_kind: "simple",
    project_code: "TASK-4397-S",
    event_name: "Training workshop",
    start_date: "2026-04-10T09:00:00.000Z",
    internal_event_type: "Training",
    actual_income: 1200,
    budgeted_income: 1000,
    income_difference: 200,
    vouchers_redeemed: 50,
    vouchers_ledger_total: 50,
    training_fund_total: 25,
    actual_costs: 300,
    budgeted_costs: 250,
    costs_difference: 50,
    actual_profit: 900,
    budgeted_profit: 750,
    profit_difference: 150,
    seats: 20,
    seats_unlimited: false,
    attendees: 8,
    organisations: 2,
  },
  {
    event_id: "complex-event-task4397",
    event_kind: "complex",
    project_code: "TASK-4397-C",
    event_name: "Conference day",
    start_date: "2026-05-15T09:00:00.000Z",
    internal_event_type: "Conference",
    actual_income: 800,
    budgeted_income: 900,
    income_difference: -100,
    vouchers_redeemed: 0,
    vouchers_ledger_total: 0,
    training_fund_total: 0,
    actual_costs: 400,
    budgeted_costs: 450,
    costs_difference: -50,
    actual_profit: 400,
    budgeted_profit: 450,
    profit_difference: -50,
    seats: 50,
    seats_unlimited: false,
    attendees: 12,
    organisations: 3,
  },
];

const INITIAL_COST_LINES = [
  {
    id: "cost-line-existing-task4397",
    event_id: EVENT_ROWS[0].event_id,
    event_kind: "simple",
    description: "Existing venue hire",
    cost_type: "Venue",
    quantity: 2,
    unit_cost: 100,
  },
];

function json(route, body, status = 200, headers = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

function totalsFor(rows) {
  const totals = {
    actual_income: 0,
    budgeted_income: 0,
    vouchers_redeemed: 0,
    training_fund_total: 0,
    actual_costs: 0,
    budgeted_costs: 0,
    actual_profit: 0,
    budgeted_profit: 0,
    seats: 0,
    seats_unlimited: false,
    attendees: 0,
    organisations: 0,
  };

  for (const row of rows) {
    for (const key of [
      "actual_income",
      "budgeted_income",
      "vouchers_redeemed",
      "training_fund_total",
      "actual_costs",
      "budgeted_costs",
      "actual_profit",
      "budgeted_profit",
      "seats",
      "attendees",
    ]) {
      totals[key] += Number(row[key]) || 0;
    }
    totals.seats_unlimited ||= row.seats_unlimited === true;
  }

  // The fixture deliberately models the endpoint's distinct-organisation
  // total, rather than summing the per-event organisation counts.
  totals.organisations = new Set(
    rows.flatMap((row) => row.event_id === EVENT_ROWS[0].event_id
      ? ["organisation-a-task4397", "organisation-b-task4397"]
      : ["organisation-a-task4397", "organisation-c-task4397", "organisation-d-task4397"]),
  ).size;
  totals.income_difference = totals.actual_income - totals.budgeted_income;
  totals.costs_difference = totals.actual_costs - totals.budgeted_costs;
  totals.profit_difference = totals.actual_profit - totals.budgeted_profit;
  return totals;
}

function reportForQuery(url) {
  const selectedTypes = url.searchParams.getAll("internalEventType");
  const rows = selectedTypes.length === 0
    ? EVENT_ROWS
    : EVENT_ROWS.filter((row) => selectedTypes.includes(row.internal_event_type));
  return {
    rows,
    totals: totalsFor(rows),
    eventCount: rows.length,
  };
}

async function installFixtures(page, {
  memberOnly = false,
  reportStatuses = [],
  costLoadStatuses = [],
  costAddStatuses = [],
  costDeleteStatuses = [],
} = {}) {
  const state = {
    reportRequests: [],
    costRequests: [],
    writes: [],
    reportStatuses: [...reportStatuses],
    costLoadStatuses: [...costLoadStatuses],
    costAddStatuses: [...costAddStatuses],
    costDeleteStatuses: [...costDeleteStatuses],
    costLines: INITIAL_COST_LINES.map((line) => ({ ...line })),
  };

  await page.addInitScript(() => {
    // Playwright's websocket interception uses URL.parse; the workspace's
    // system Chromium predates that API.
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
    localStorage.removeItem("agcas_member");
    localStorage.removeItem("agcas_organization");
    sessionStorage.clear();
  });

  // The app's Supabase-backed floater widget can issue a direct REST request
  // outside the /api/ proxy. Keep that optional shell request inside this
  // fixture as well; an unmocked schema error would open Vite's runtime error
  // overlay and intercept every subsequent UI click.
  await page.context().route("**/rest/v1/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": "0-0/0" },
    body: "[]",
  }));

  // The shell mounts tenant-scoped Supabase realtime listeners before the
  // report controls are ready. A live Realtime server rejects these fixture
  // table/filter combinations with a `system` status:error message, which in
  // turn surfaces as a browser runtime error and blocks later clicks. Keep
  // this optional shell transport inside the isolated fixture too. The
  // report does not depend on realtime notifications, so intentionally leave
  // the routed socket open without forwarding it to Supabase.
  await page.context().routeWebSocket("**/realtime/v1/websocket*", (webSocket) => {
    webSocket.onMessage(() => {});
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const requestHeaders = request.headers();

    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") {
      return json(route, MEMBER);
    }
    if (path === "/api/auth/tenant-user-me") {
      if (memberOnly) return json(route, { authenticated: false });
      // The shape is intentional: the app's transport bootstrap uses this
      // response to establish the active tenant for X-Tenant-Id headers.
      return json(route, {
        authenticated: true,
        user: MEMBER,
        tenant: TENANT,
        tenantId: TENANT.id,
        memberId: MEMBER.id,
      });
    }
    if (path === "/api/auth/logout") return json(route, { ok: true });

    if (path === "/api/reports/event-budget-report" && method === "GET") {
      state.reportRequests.push({
        url: request.url(),
        query: Object.fromEntries(url.searchParams.entries()),
        internalEventTypes: url.searchParams.getAll("internalEventType"),
        headers: requestHeaders,
      });
      const status = state.reportStatuses.shift() ?? 200;
      if (status !== 200) {
        const body = status === 401
          ? { error: "Authentication required" }
          : status === 403
            ? { error: "Admin access required" }
            : status === 409
              ? {
                error: "Your browser session has switched to a different organisation. Reload this tab to continue.",
                code: "TENANT_CONTEXT_CHANGED",
              }
              : { error: "Report backend unavailable" };
        return json(route, body, status);
      }
      return json(route, reportForQuery(url));
    }

    if (path === "/api/reports/event-budget-report-cost-lines") {
      if (method === "GET") {
        state.costRequests.push({
          method,
          url: request.url(),
          headers: requestHeaders,
        });
        const status = state.costLoadStatuses.shift() ?? 200;
        if (status !== 200) {
          return json(route, { error: "Cost lines unavailable" }, status);
        }
        const eventId = url.searchParams.get("event_id");
        const eventKind = url.searchParams.get("event_kind");
        return json(route, {
          costLines: state.costLines.filter(
            (line) => line.event_id === eventId && line.event_kind === eventKind,
          ),
        });
      }

      if (method === "POST") {
        const body = request.postDataJSON();
        state.costRequests.push({ method, url: request.url(), body, headers: requestHeaders });
        const status = state.costAddStatuses.shift() ?? 201;
        if (status !== 201) return json(route, { error: "Cost line could not be saved" }, status);
        const line = {
          id: "cost-line-added-task4397",
          event_id: body.event_id,
          event_kind: body.event_kind,
          description: body.description,
          cost_type: body.cost_type,
          quantity: body.quantity,
          unit_cost: body.unit_cost,
        };
        state.costLines.push(line);
        return json(route, { costLine: line }, 201);
      }

      if (method === "DELETE") {
        state.costRequests.push({ method, url: request.url(), headers: requestHeaders });
        const status = state.costDeleteStatuses.shift() ?? 200;
        if (status !== 200) return json(route, { error: "Cost line could not be deleted" }, status);
        const id = url.searchParams.get("id");
        state.costLines = state.costLines.filter((line) => line.id !== id);
        return json(route, { success: true });
      }
    }

    // Queries issued by Layout and useMemberAccess are kept inside the
    // fixture too, so a browser regression cannot silently reach live data.
    if (path === "/api/entities/SystemSettings") {
      return json(route, [{
        id: "setting-internal-event-types-task4397",
        setting_key: "internal_event_types",
        setting_value: JSON.stringify(["Training", "Conference", "Internal"]),
      }]);
    }
    if (path === "/api/entities/RoleAccessItem") return json(route, []);
    if (path === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (path === "/api/entities/Role") return json(route, [ROLE]);
    if (path === `/api/entities/Member/${MEMBER.id}`) return json(route, MEMBER);
    if (path === "/api/entities/Member") return json(route, [MEMBER]);
    if (path === `/api/entities/Organization/${MEMBER.organization_id}`) {
      return json(route, {
        id: MEMBER.organization_id,
        tenant_id: TENANT.id,
        name: "Task 4397 Fixture Organisation",
      });
    }
    if (path === "/api/entities/Organization") return json(route, []);
    if (path === "/api/entities/MemberGroupAssignment") return json(route, []);

    if (method === "PATCH" || method === "POST" || method === "DELETE") {
      state.writes.push({ method, path, headers: requestHeaders });
      return json(route, { ok: true });
    }
    return json(route, []);
  });

  return state;
}

async function openReport(page, fixtureOptions = {}) {
  const state = await installFixtures(page, fixtureOptions);
  await page.goto("/EventBudgetReport");
  await expect(page.getByTestId("page-event-budget-report")).toBeVisible();
  await expect(page.getByTestId("button-generate-report")).toBeEnabled();
  return state;
}

async function generateReport(page) {
  await page.getByTestId("button-generate-report").click();
  await expect(page.getByTestId("table-event-budget")).toBeVisible();
}

async function requestReport(page) {
  await page.getByTestId("button-generate-report").click();
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("generating without filters waits for readiness and requests the unfiltered report", async ({ page }) => {
  const state = await openReport(page);

  // Readiness must not turn initial page mount into a data request.
  expect(state.reportRequests).toHaveLength(0);
  await generateReport(page);

  await expect(page.getByTestId("row-event-simple-event-task4397")).toBeVisible();
  await expect(page.getByTestId("row-event-complex-event-task4397")).toBeVisible();
  expect(state.reportRequests).toHaveLength(1);
  expect(state.reportRequests[0].internalEventTypes).toEqual([]);
  expect(new URL(state.reportRequests[0].url).search).toBe("");
  expect(state.reportRequests[0].headers["x-tenant-id"]).toBe(TENANT.id);
});

test("multiple internal event types are sent as repeated scoped query parameters", async ({ page }) => {
  const state = await openReport(page);
  await page.getByTestId("filter-internal-event-types").click();
  await page.getByTestId("filter-internal-event-types-option-Training").click();
  await page.getByTestId("filter-internal-event-types-option-Conference").click();
  await expect(page.getByTestId("filter-internal-event-types")).toContainText("2 selected");

  await generateReport(page);

  expect(state.reportRequests).toHaveLength(1);
  expect(state.reportRequests[0].internalEventTypes).toEqual(["Training", "Conference"]);
  expect(new URL(state.reportRequests[0].url).searchParams.getAll("internalEventType"))
    .toEqual(["Training", "Conference"]);
  await expect(page.getByTestId("row-event-simple-event-task4397")).toBeVisible();
  await expect(page.getByTestId("row-event-complex-event-task4397")).toBeVisible();
});

test("standalone member admin establishes the validated tenant before generating", async ({ page }) => {
  const state = await openReport(page, { memberOnly: true });
  await generateReport(page);
  expect(state.reportRequests[0].headers["x-tenant-id"]).toBe(TENANT.id);
});

test("clear filters resets controls and fetches again; filters can then be reapplied", async ({ page }) => {
  const state = await openReport(page);
  await page.getByTestId("input-event-date-from").fill("2026-04-01");
  await page.getByTestId("input-event-date-to").fill("2026-04-30");
  await page.getByTestId("filter-internal-event-types").click();
  await page.getByTestId("filter-internal-event-types-option-Training").click();
  await generateReport(page);

  expect(state.reportRequests[0].internalEventTypes).toEqual(["Training"]);
  expect(new URL(state.reportRequests[0].url).searchParams.get("eventDateFrom")).toBe("2026-04-01");
  expect(new URL(state.reportRequests[0].url).searchParams.get("eventDateTo")).toBe("2026-04-30");

  await page.getByTestId("button-clear-filters").click();
  await expect(page.getByTestId("input-event-date-from")).toHaveValue("");
  await expect(page.getByTestId("input-event-date-to")).toHaveValue("");
  await expect(page.getByTestId("filter-internal-event-types")).toContainText("All internal event types");
  await expect.poll(() => state.reportRequests.length).toBe(2);
  expect(state.reportRequests[1].internalEventTypes).toEqual([]);
  expect(new URL(state.reportRequests[1].url).search).toBe("");

  await page.getByTestId("input-event-date-from").fill("2026-05-01");
  await page.getByTestId("filter-internal-event-types").click();
  await page.getByTestId("filter-internal-event-types-option-Conference").click();
  await generateReport(page);

  await expect.poll(() => state.reportRequests.length).toBe(3);
  expect(state.reportRequests[2].internalEventTypes).toEqual(["Conference"]);
  expect(new URL(state.reportRequests[2].url).searchParams.get("eventDateFrom")).toBe("2026-05-01");
});

test("CSV export contains the selected report rows and a matching totals row", async ({ page }) => {
  const state = await openReport(page);
  await page.getByTestId("filter-internal-event-types").click();
  await page.getByTestId("filter-internal-event-types-option-Training").click();
  await generateReport(page);

  await expect(page.getByTestId("row-event-simple-event-task4397")).toBeVisible();
  await expect(page.getByTestId("row-event-complex-event-task4397")).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-export-csv").click();
  const csv = await readDownload(await downloadPromise);

  expect(csv).toContain("Project Code,Event Name,Event Date,Type");
  expect(csv).toContain("TASK-4397-S,Training workshop");
  expect(csv).not.toContain("TASK-4397-C,Conference day");
  expect(csv).toContain("TOTALS");
  expect(csv).toContain("1200");
  expect(csv).toContain("300");
  expect(state.reportRequests[0].internalEventTypes).toEqual(["Training"]);
});

test("cost lines load, add, total, and delete through tenant-scoped requests", async ({ page }) => {
  const state = await openReport(page);
  await generateReport(page);
  await page.getByTestId("button-cost-lines-simple-event-task4397").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("report-cost-line-cost-line-existing-task4397")).toBeVisible();
  await expect(dialog).toContainText("Total actual costs: £200.00");
  const initialGet = state.costRequests.find((request) => request.method === "GET");
  expect(initialGet?.headers["x-tenant-id"]).toBe(TENANT.id);

  await page.getByTestId("input-report-new-line-description").fill("Catering");
  await page.getByTestId("input-report-new-line-cost-type").fill("Food");
  await page.getByTestId("input-report-new-line-quantity").fill("2");
  await page.getByTestId("input-report-new-line-unit-cost").fill("20");
  await page.getByTestId("button-report-add-cost-line").click();

  await expect(page.getByTestId("report-cost-line-cost-line-added-task4397")).toBeVisible();
  await expect(dialog).toContainText("Total actual costs: £240.00");
  const addRequest = state.costRequests.find((request) => request.method === "POST");
  expect(addRequest?.body).toMatchObject({
    event_id: EVENT_ROWS[0].event_id,
    event_kind: "simple",
    description: "Catering",
    cost_type: "Food",
    quantity: 2,
    unit_cost: 20,
  });
  expect(addRequest?.headers["x-tenant-id"]).toBe(TENANT.id);

  await page.getByTestId("button-report-delete-line-cost-line-added-task4397").click();
  await expect(page.getByTestId("report-cost-line-cost-line-added-task4397")).toHaveCount(0);
  await expect(dialog).toContainText("Total actual costs: £200.00");
  const deleteRequest = state.costRequests.find((request) => request.method === "DELETE");
  expect(deleteRequest?.headers["x-tenant-id"]).toBe(TENANT.id);
});

for (const [status, message] of [
  [401, "Authentication required"],
  [403, "Admin access required"],
]) {
  test(`report ${status} response is shown explicitly instead of an empty report`, async ({ page }) => {
    const state = await openReport(page, { reportStatuses: [status] });
    await requestReport(page);

    await expect(page.getByText(message, { exact: false })).toBeVisible();
    await expect(page.getByTestId("table-event-budget")).toHaveCount(0);
    expect(state.reportRequests).toHaveLength(1);
    expect(state.reportRequests[0].headers["x-tenant-id"]).toBe(TENANT.id);
  });
}

test("report 500 response is explicit and retry reloads the same report", async ({ page }) => {
  const state = await openReport(page, { reportStatuses: [500, 200] });
  await requestReport(page);

  await expect(page.getByText("Report backend unavailable", { exact: false })).toBeVisible();
  await expect(page.getByTestId("table-event-budget")).toHaveCount(0);
  const retry = page.getByRole("button", { name: /retry/i }).first();
  await expect(retry).toBeVisible();
  await retry.click();

  await expect(page.getByTestId("table-event-budget")).toBeVisible();
  await expect(page.getByTestId("row-event-simple-event-task4397")).toBeVisible();
  await expect.poll(() => state.reportRequests.length).toBe(2);
  expect(state.reportRequests[1].internalEventTypes).toEqual([]);
  expect(state.reportRequests[1].headers["x-tenant-id"]).toBe(TENANT.id);
});

test("409 stale-tenant response shows the blocking overlay and preserves transport headers", async ({ page }) => {
  const state = await openReport(page, { reportStatuses: [409] });
  await requestReport(page);

  const staleOverlay = page.getByRole("alertdialog");
  await expect(staleOverlay).toBeVisible();
  await expect(staleOverlay).toContainText("Your session has switched organisations");
  await expect(staleOverlay).toContainText("reload it");
  expect(state.reportRequests).toHaveLength(1);
  expect(state.reportRequests[0].headers["x-tenant-id"]).toBe(TENANT.id);
});
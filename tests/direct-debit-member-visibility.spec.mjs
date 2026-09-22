import { test, expect } from "@playwright/test";

const TENANT = { id: "task-4687-tenant", slug: "task-4687" };
const ADMIN = {
  id: "task-4687-admin",
  tenant_id: TENANT.id,
  role_id: "task-4687-role",
  email: "admin@fixture.invalid",
  first_name: "Fixture",
  last_name: "Administrator",
  member_excluded_features: [],
  is_team_member: true,
};

function plan(index, overrides = {}) {
  const number = String(index).padStart(3, "0");
  return {
    id: `plan-${number}`,
    status: "active",
    payer_name: `Member ${number}`,
    payer_email: `member${number}@fixture.invalid`,
    amount_minor: 1300,
    currency: "GBP",
    next_charge_date: "2026-10-01",
    updated_at: new Date(Date.UTC(2026, 8, 30, 0, 0, 0) - index * 1000).toISOString(),
    ...overrides,
  };
}

const OLDER = plan(260, {
  id: "older-imported-plan",
  payer_name: "Older Imported Member",
  payer_email: "older.imported@fixture.invalid",
  status: "first_payment_pending",
  next_charge_date: "2026-10-01",
  mandatePresentation: {
    existingMandate: true,
    awaitingFirstPayment: true,
    collectionHeld: true,
  },
});
const PLANS = [
  ...Array.from({ length: 100 }, (_, index) => plan(index + 1)),
  OLDER,
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installFixture(page) {
  const state = { reads: [], writes: [], mockedSessionWrites: [], pageErrors: [] };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.addInitScript(member => {
    localStorage.setItem("agcas_member", JSON.stringify(member));
  }, ADMIN);

  await page.route("**/realtime/v1/**", route => route.abort("blockedbyclient"));
  await page.route("**/rest/v1/**", route => json(route, []));
  await page.route("**/storage/v1/**", route => route.abort("blockedbyclient"));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === `/api/entities/Member/${ADMIN.id}` && method === "PATCH") {
      state.mockedSessionWrites.push(`${method} ${path}`);
      return json(route, ADMIN);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(`${method} ${path}`);
      return json(route, { error: "Read-only Direct Debit fixture" }, 599);
    }
    state.reads.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me") return json(route, ADMIN);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        authenticated: true,
        user: ADMIN,
        member: ADMIN,
        tenant: TENANT,
        tenantId: TENANT.id,
        memberId: ADMIN.id,
      });
    }
    if (path === `/api/entities/Member/${ADMIN.id}`) return json(route, ADMIN);
    if (path === `/api/entities/Role/${ADMIN.role_id}`) {
      return json(route, { id: ADMIN.role_id, name: "Administrator", excluded_features: [] });
    }
    if (path === "/api/entities/Member") return json(route, [ADMIN]);
    if (path === "/api/entities/Role") {
      return json(route, [{ id: ADMIN.role_id, name: "Administrator", excluded_features: [] }]);
    }

    if (path === "/api/admin/gocardless-dd") {
      const view = url.searchParams.get("view");
      if (view === "summary") {
        return json(route, {
          byStatus: { active: 100, first_payment_pending: 1 },
          attention: [],
          pendingActivations: 0,
          pendingCancellations: 0,
          failedAccounting: 0,
          chargebacksAfterPayout: 0,
        });
      }
      if (view === "plans") {
        const query = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (query === "failure") {
          return json(route, { error: "Fixture plan lookup failed" }, 503);
        }
        const status = url.searchParams.get("status");
        const pageNumber = Number(url.searchParams.get("page") || 1);
        const pageSize = Number(url.searchParams.get("pageSize") || 50);
        const matching = PLANS.filter(row =>
          (!query || `${row.payer_name} ${row.payer_email}`.toLowerCase().includes(query))
          && (!status || row.status === status));
        const offset = (pageNumber - 1) * pageSize;
        return json(route, {
          plans: matching.slice(offset, offset + pageSize),
          total: matching.length,
          page: pageNumber,
          pageSize,
          hasMore: offset + pageSize < matching.length,
        });
      }
      if (view === "plan" && url.searchParams.get("planId") === OLDER.id) {
        return json(route, {
          plan: OLDER,
          agreement: {
            metadata: {
              dd: {
                grace_days: 7,
                membership_year: "rolling:2026-10-01",
                activation_rule: "first_payment",
              },
            },
          },
          payments: [],
          statusHistory: [],
          adminActions: [],
          cancellationRequests: [],
          refunds: [],
          retryAttempts: [],
          membershipActivation: { status: "pending_payment_setup", payment_status: "unpaid" },
        });
      }
      return json(route, { error: "Unknown Direct Debit fixture view" }, 404);
    }
    if (path === "/api/admin/dd-cancellation-requests") return json(route, { requests: [] });

    if (method === "GET") return json(route, []);
    return json(route, {});
  });
  return state;
}

test("older imported members remain searchable with complete pagination, status, detail and hold evidence", async ({ page }, testInfo) => {
  const state = await installFixture(page);
  await page.goto("/DirectDebitAdmin");

  await expect(page.getByTestId("text-page-title")).toHaveText(/Direct Debit Console/);
  await expect(page.getByTestId("tab-plans")).toHaveText("Plans (101)");
  await expect(page.getByTestId("text-plan-count")).toHaveText("Showing 1–50 of 101 plans");
  await expect(page.getByTestId("text-plans-page")).toHaveText("Page 1");

  await page.getByTestId("button-plans-next").click();
  await expect(page.getByTestId("text-plan-count")).toHaveText("Showing 51–100 of 101 plans");
  await page.getByTestId("button-plans-next").click();
  await expect(page.getByTestId("text-plan-count")).toHaveText("Showing 101–101 of 101 plans");
  await expect(page.getByTestId(`card-plan-${OLDER.id}`)).toBeVisible();

  await page.getByTestId("input-plan-search").fill("Older Imported");
  await expect(page.getByTestId("text-plans-page")).toHaveText("Page 1");
  await expect(page.getByTestId("text-plan-count")).toHaveText("Showing 1–1 of 1 plans");
  await expect(page.getByTestId(`badge-dd-status-first_payment_pending`)).toBeVisible();
  await expect(page.getByText("Existing mandate active · awaiting first payment · collections held")).toBeVisible();

  await page.getByTestId("select-plan-status").click();
  await page.getByRole("option", { name: "first payment pending" }).click();
  await expect(page.getByTestId("text-plans-page")).toHaveText("Page 1");
  await expect.poll(() => state.reads.some(entry =>
    entry.includes("view=plans")
    && entry.includes("status=first_payment_pending")
    && entry.includes("page=1"))).toBe(true);

  await page.getByTestId(`card-plan-${OLDER.id}`).click();
  await expect(page.getByRole("heading", { name: "Plan detail" })).toBeVisible();
  await expect(page.getByTestId("text-plan-amount")).toHaveText("£13.00");
  await expect(page.getByTestId("text-plan-year")).toHaveText("rolling:2026-10-01");
  await expect(page.getByTestId("text-membership-activation-status")).toHaveText("pending payment setup");
  await expect(page.getByText("Existing mandate active · awaiting first payment · collections held")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("older-imported-member-held-detail.png"), fullPage: true });

  expect(state.writes).toEqual([]);
  expect(state.mockedSessionWrites.length).toBeLessThanOrEqual(1);
  expect(state.pageErrors).toEqual([]);
});

test("a failed filtered lookup shows an explicit error rather than a false empty result", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/DirectDebitAdmin");
  await expect(page.getByTestId("text-plan-count")).toBeVisible();

  await page.getByTestId("input-plan-search").fill("failure");
  await expect(page.getByText("Direct Debit plans could not be loaded.")).toBeVisible();
  await expect(page.getByText("Fixture plan lookup failed")).toBeVisible();
  await expect(page.getByTestId("text-no-plans")).toHaveCount(0);
  await expect(page.getByTestId("text-plan-count")).toHaveCount(0);
  await expect(page.getByTestId("tab-plans")).toHaveText("Plans");

  expect(state.writes).toEqual([]);
  expect(state.mockedSessionWrites.length).toBeLessThanOrEqual(1);
  expect(state.pageErrors).toEqual([]);
});
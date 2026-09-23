import { test, expect } from "@playwright/test";

const TENANT = { id: "dry-run-tenant", slug: "dry-run" };
const ADMIN = {
  id: "dry-run-admin",
  tenant_id: TENANT.id,
  role_id: "dry-run-role",
  email: "admin@fixture.invalid",
  first_name: "Fixture",
  last_name: "Administrator",
  member_excluded_features: [],
  is_team_member: true,
};
const PLAN = {
  id: "adopted-plan-1",
  status: "payment_grace_period",
  payer_name: "Ada Member",
  payer_email: "ada@fixture.invalid",
  amount_minor: 1250,
  currency: "GBP",
  next_charge_date: "2027-01-12",
  membershipPresentation: { displayStatus: "current", current: true },
};
const SUCCESS = {
  evaluatedAt: "2027-01-10T09:30:00.000Z",
  plan: { id: PLAN.id, ownerLabel: PLAN.payer_name },
  jobs: [
    {
      id: "automatic-retry",
      label: "Automatic payment retry",
      stages: [{
        stage: "Eligibility",
        status: "conditional",
        reason: "The failed payment is currently eligible for retry.",
        evidenceAt: "2027-01-10T09:29:00.000Z",
        operations: [{
          type: "retry_payment",
          description: "Ask GoCardless to retry payment",
          amountMinor: 1250,
          currency: "GBP",
          date: "2027-01-12",
          conditional: true,
        }],
      }],
    },
    {
      id: "arrears",
      label: "Arrears sweep",
      stages: [{
        stage: "Grace period",
        status: "not_due",
        reason: "The grace period has not expired.",
        evidenceAt: "2027-01-10T09:30:00.000Z",
        operations: [],
      }],
    },
  ],
  limitations: ["Provider state can change before the scheduled job runs."],
};
const APP_ORIGIN = process.env.PLAYWRIGHT_BASE_URL
  || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000");

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixture(page) {
  const state = {
    dryRunRequests: [],
    unexpectedWrites: [],
    pageErrors: [],
    mode: "success",
  };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === new URL(APP_ORIGIN).origin ? route.continue() : route.abort("blockedbyclient");
  });
  await page.addInitScript(member => localStorage.setItem("agcas_member", JSON.stringify(member)), ADMIN);
  await page.route("**/realtime/v1/**", route => route.abort("blockedbyclient"));
  await page.route("**/rest/v1/**", route => json(route, []));
  await page.route("**/storage/v1/**", route => route.abort("blockedbyclient"));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") return json(route, ADMIN);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        authenticated: true, user: ADMIN, member: ADMIN, tenant: TENANT,
        tenantId: TENANT.id, memberId: ADMIN.id,
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
    if (path === "/api/admin/gocardless-dd" && method === "GET") {
      if (url.searchParams.get("view") === "summary") {
        return json(route, {
          totalPlans: 1,
          byStatus: { payment_grace_period: 1 },
          byDisplayStatus: { current: 1 },
          pendingActivations: 0,
          pendingCancellations: 0,
          failedAccounting: 0,
          chargebacksAfterPayout: 0,
        });
      }
      if (url.searchParams.get("view") === "plans") {
        return json(route, { plans: [PLAN], total: 1, page: 1, pageSize: 50, hasMore: false });
      }
    }
    if (path === "/api/admin/gocardless-dd" && method === "POST") {
      const body = request.postDataJSON();
      if (body.action !== "dry_run" || body.planId !== PLAN.id) {
        state.unexpectedWrites.push({ path, body });
        return json(route, { error: "Only dry-run evaluation is allowed" }, 599);
      }
      state.dryRunRequests.push(body);
      if (state.mode === "failure") return json(route, { error: "Evidence service unavailable" }, 503);
      if (state.mode === "delayed") await new Promise(resolve => setTimeout(resolve, 400));
      return json(route, SUCCESS);
    }
    if (path === "/api/admin/dd-cancellation-requests") return json(route, { requests: [] });
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push({ method, path });
      return json(route, { error: "Unexpected fixture mutation" }, 599);
    }
    return json(route, []);
  });
  return state;
}

test("plan-card dry run is non-navigating and presents accessible, conditional job evidence", async ({ page }, testInfo) => {
  const state = await installFixture(page);
  await page.goto("/DirectDebitAdmin");
  await expect(page.getByTestId(`card-plan-${PLAN.id}`)).toBeVisible();

  await page.getByTestId(`button-dry-run-${PLAN.id}`).click();
  await expect(page.getByTestId("dialog-dd-dry-run")).toBeVisible();
  await expect(page.getByRole("heading", { name: `Direct Debit dry run — ${PLAN.payer_name}` })).toBeVisible();
  await expect(page.getByText("No changes were made.")).toBeVisible();
  await expect(page.getByText(/Scheduled jobs run independently/)).toBeVisible();
  await expect(page.getByText(/does not guarantee their order/)).toBeVisible();
  await expect(page.getByText(/successful claims, fresh data, and provider acceptance/)).toBeVisible();
  await expect(page.getByTestId("dry-run-job-automatic-retry")).toContainText("£12.50");
  await expect(page.getByTestId("dry-run-job-automatic-retry")).toContainText("conditional");
  await expect(page.getByText("Provider state can change before the scheduled job runs.")).toBeVisible();
  await expect(page.getByRole("button", { name: /execute/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Plan detail" })).toHaveCount(0);
  expect(state.dryRunRequests).toEqual([{ action: "dry_run", planId: PLAN.id }]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("direct-debit-dry-run.png"), fullPage: true });
});

test("repeat clicks are guarded and a failed evaluation can be retried", async ({ page }) => {
  const state = await installFixture(page);
  state.mode = "delayed";
  await page.goto("/DirectDebitAdmin");

  await page.getByTestId(`button-dry-run-${PLAN.id}`).evaluate(button => {
    button.click();
    button.click();
  });
  await expect(page.getByText("Evaluating current scheduled-job evidence…")).toBeVisible();
  await expect.poll(() => state.dryRunRequests.length).toBe(1);
  await expect(page.getByText("No changes were made.")).toBeVisible();

  await page.getByTestId("button-dry-run-close").click();
  state.mode = "failure";
  await page.getByTestId(`button-dry-run-${PLAN.id}`).click();
  await expect(page.getByTestId("alert-dry-run-error")).toContainText("Evidence service unavailable");

  state.mode = "success";
  await page.getByTestId("button-dry-run-retry").click();
  await expect(page.getByText("No changes were made.")).toBeVisible();
  expect(state.dryRunRequests).toHaveLength(3);
  expect(state.unexpectedWrites).toEqual([]);
});

test("closing a pending preview aborts and ignores its late response", async ({ page }) => {
  const state = await installFixture(page);
  state.mode = "delayed";
  await page.goto("/DirectDebitAdmin");

  await page.getByTestId(`button-dry-run-${PLAN.id}`).click();
  await expect(page.getByText("Evaluating current scheduled-job evidence…")).toBeVisible();
  await page.getByTestId("button-dry-run-close").click();
  await expect(page.getByTestId("dialog-dd-dry-run")).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(page.getByTestId("dialog-dd-dry-run")).toHaveCount(0);
  await expect(page.getByText("No changes were made.")).toHaveCount(0);
  expect(state.dryRunRequests).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
import { test, expect } from "@playwright/test";

const TENANT = { id: "task-4704-tenant", slug: "task-4704" };
const ADMIN = {
  id: "task-4704-admin",
  tenant_id: TENANT.id,
  role_id: "task-4704-role",
  email: "admin@fixture.invalid",
  first_name: "Fixture",
  last_name: "Administrator",
  member_excluded_features: [],
  is_team_member: true,
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixture(page) {
  const state = { exportRequests: [], exportMode: "success", pageErrors: [] };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === "http://127.0.0.1:5000" ? route.continue() : route.abort("blockedbyclient");
  });
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
    if (!path.startsWith("/api/")) return route.continue();
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
          totalPlans: 1,
          byStatus: { active: 1 },
          byDisplayStatus: { current: 1 },
          pendingActivations: 0,
          pendingCancellations: 0,
          failedAccounting: 0,
          chargebacksAfterPayout: 0,
        });
      }
      if (view === "plans") {
        return json(route, {
          plans: [{
            id: "plan-1",
            status: "active",
            payer_name: "Filtered Member",
            payer_email: "filtered@example.invalid",
            amount_minor: 1200,
            currency: "GBP",
            membershipPresentation: { displayStatus: "current", current: true },
          }],
          total: 1,
          page: 1,
          pageSize: 50,
          hasMore: false,
        });
      }
      if (view === "plans_export") {
        state.exportRequests.push({
          displayStatus: url.searchParams.get("displayStatus"),
          q: url.searchParams.get("q"),
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("pageSize"),
        });
        if (state.exportMode === "failure") {
          return json(route, { error: "Fixture export failed" }, 503);
        }
        return route.fulfill({
          status: 200,
          contentType: "text/csv; charset=utf-8",
          headers: { "Content-Disposition": 'attachment; filename="matching-plans.csv"' },
          body: "Name,Email\nFiltered Member,filtered@example.invalid\n",
        });
      }
    }
    if (path === "/api/admin/dd-cancellation-requests") return json(route, { requests: [] });
    return json(route, []);
  });
  return state;
}

test("downloads all plans with click-time filters and no pagination", async ({ page }, testInfo) => {
  const state = await installFixture(page);
  await page.goto("/DirectDebitAdmin");
  await expect(page.getByTestId("text-page-title")).toBeVisible();
  expect(state.pageErrors).toEqual([]);
  await expect(page.getByTestId("button-plans-export")).toBeVisible();
  await expect(page.getByTestId("text-plans-export-scope")).toContainText("all matching plans across every page");

  await page.getByTestId("select-plan-status").click();
  await page.getByRole("option", { name: "Current", exact: true }).click();
  await page.getByTestId("input-plan-search").fill("Filtered Member");

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-plans-export").click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("matching-plans.csv");
  await expect.poll(() => state.exportRequests.length).toBe(1);
  expect(state.exportRequests[0]).toEqual({
    displayStatus: "current",
    q: "Filtered Member",
    page: null,
    pageSize: null,
  });
  await expect(page.getByTestId("alert-plans-export-error")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("plans-export-control.png"), fullPage: true });
});

test("prevents repeat clicks while loading and shows then clears export failures", async ({ page }) => {
  const state = await installFixture(page);
  state.exportMode = "failure";
  await page.goto("/DirectDebitAdmin");

  await page.getByTestId("button-plans-export").evaluate(button => {
    button.click();
    button.click();
  });
  await expect(page.getByTestId("alert-plans-export-error")).toContainText("Fixture export failed");
  expect(state.exportRequests).toHaveLength(1);

  state.exportMode = "success";
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-plans-export").click();
  await downloadPromise;
  await expect(page.getByTestId("alert-plans-export-error")).toHaveCount(0);
  expect(state.exportRequests).toHaveLength(2);
});
import { expect, test } from "@playwright/test";

/*
 * Task 4603 browser coverage is deliberately fixture-only. Every API and
 * Supabase request is intercepted, all non-GET API methods are rejected, and
 * no real tenant, login, provider, or database is contacted.
 */

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000"),
).origin;

const TENANT = {
  id: "tenant-payment-report",
  name: "Payment report fixture",
  slug: "payment-report-fixture",
};

const REPORT_PERMISSION = "commerce.membership-payment-report";
const MEMBERS_PERMISSION = "crm.members";

const ROWS = [
  {
    memberId: "member-alex",
    name: "Alex Card",
    email: "alex@example.invalid",
    tier: "Professional",
    status: "active",
    paymentMethod: "monthly_card",
    nextPaymentDate: "2026-11-06",
    scheduleState: "confirmed",
  },
  {
    memberId: "member-billie",
    name: "Billie Debit",
    email: "billie@example.invalid",
    tier: "Associate",
    status: "payment_pending",
    paymentMethod: "direct_debit",
    nextPaymentDate: null,
    scheduleState: "unavailable",
  },
  {
    memberId: "member-upfront",
    name: "Uma Upfront",
    email: "uma@example.invalid",
    tier: "Associate",
    status: "active",
    paymentMethod: "upfront",
    nextPaymentDate: null,
    scheduleState: "not_scheduled",
  },
];

const METHODS = [
  { value: "all", label: "All payment methods" },
  { value: "card", label: "Card" },
  { value: "monthly_card", label: "Monthly card" },
  { value: "direct_debit", label: "Direct Debit" },
  { value: "monthly_direct_debit", label: "Monthly Direct Debit" },
  { value: "upfront", label: "Upfront" },
  { value: "invoice", label: "Invoice" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
];

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

function member(exclusions = []) {
  const value = {
    id: "admin-payment-report",
    email: "payment-report-admin@example.invalid",
    first_name: "Payment",
    last_name: "Administrator",
    tenant_id: TENANT.id,
    organization_id: null,
    role_id: "role-payment-report",
    member_excluded_features: [],
    is_team_member: true,
  };
  return {
    ...value,
    sessionRole: {
      status: "ready",
      member_id: value.id,
      tenant_id: value.tenant_id,
      role_id: value.role_id,
      role: {
        id: value.role_id,
        name: "Payment report administrator",
        excluded_features: exclusions,
      },
    },
  };
}

async function installFixture(page, {
  excluded = [],
  canViewMembers = true,
  holdReport = false,
  reportStatuses = [],
  holdCsv = false,
  csvStatuses = [],
} = {}) {
  const gate = deferred();
  const csvGate = deferred();
  const state = {
    reportRequests: [],
    csvRequests: [],
    writes: [],
    unexpectedExternal: [],
    reportStatuses: [...reportStatuses],
    csvStatuses: [...csvStatuses],
    releaseReport: gate.release,
    releaseCsv: csvGate.release,
  };
  if (!holdReport) gate.release();
  if (!holdCsv) csvGate.release();
  const currentMember = member(excluded);

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
  });

  await page.context().routeWebSocket("**/realtime/v1/websocket*", (socket) => {
    socket.onMessage(() => {});
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.hostname.endsWith(".supabase.co")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/0" },
        body: "[]",
      });
    }
    if (url.origin !== APP_ORIGIN) {
      if (["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com",
        "js.stripe.com", "va.vercel-scripts.com", "teeone.pythonanywhere.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      state.unexpectedExternal.push(`${method} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    // Layout persists the current portal page on the fixture member. Keep
    // that shell-only write local and successful; it is unrelated to the
    // report and never reaches a database.
    if (method === "PATCH"
      && url.pathname === `/api/entities/Member/${currentMember.id}`) {
      return json(route, currentMember);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(`${method} ${url.pathname}`);
      return json(route, { error: "Read-only payment report fixture" }, 599);
    }

    if (url.pathname === "/api/auth/me") return json(route, currentMember);
    if (url.pathname === "/api/auth/tenant-user-me") {
      return json(route, { authenticated: false }, 401);
    }
    if (url.pathname === "/api/admin/membership-payment-report") {
      if (url.searchParams.get("format") === "csv") {
        state.csvRequests.push({
          format: url.searchParams.get("format"),
          method: url.searchParams.get("method"),
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("pageSize"),
        });
        await csvGate.promise;
        const status = state.csvStatuses.shift() ?? 200;
        if (status !== 200) {
          return json(route, {
            error: status === 403
              ? "Membership payment report permission required"
              : "Payment report export temporarily unavailable",
          }, status);
        }
        const selectedMethod = url.searchParams.get("method") || "all";
        return route.fulfill({
          status: 200,
          contentType: "text/csv; charset=utf-8",
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Disposition": `attachment; filename="individual-membership-payments-${selectedMethod}.csv"`,
          },
          body: `Member,Payment method\r\nFixture member,${selectedMethod}\r\n`,
        });
      }
      state.reportRequests.push({
        method: url.searchParams.get("method"),
        page: url.searchParams.get("page"),
        pageSize: url.searchParams.get("pageSize"),
      });
      await gate.promise;
      const status = state.reportStatuses.shift() ?? 200;
      if (status !== 200) {
        return json(route, {
          error: status === 403
            ? "Membership payment report permission required"
            : "Payment report temporarily unavailable",
        }, status);
      }
      const selectedMethod = url.searchParams.get("method") || "all";
      const requestedPage = Number(url.searchParams.get("page")) || 1;
      const filtered = selectedMethod === "all"
        ? ROWS
        : ROWS.filter((row) => row.paymentMethod === selectedMethod);
      // Keep more than one page for the unfiltered view without manufacturing
      // additional personally identifying row data.
      const total = selectedMethod === "all" ? 27 : filtered.length;
      const rows = requestedPage === 1 ? filtered : [{
        ...ROWS[0],
        memberId: "member-page-two",
        name: "Casey Second Page",
      }];
      return json(route, {
        rows,
        total,
        page: requestedPage,
        pageSize: 25,
        methods: METHODS,
        canViewMembers,
      });
    }

    if (url.pathname.startsWith("/api/entities/Role/")) {
      return json(route, currentMember.sessionRole.role);
    }
    if (url.pathname === "/api/entities/Role") return json(route, [currentMember.sessionRole.role]);
    if (url.pathname === "/api/entities/Member") return json(route, [currentMember]);
    if (url.pathname.startsWith("/api/entities/Member/")) return json(route, currentMember);
    if (url.pathname === "/api/entities/PortalMenu"
      || url.pathname === "/api/entities/RoleAccessItem"
      || url.pathname === "/api/entities/SystemSettings"
      || url.pathname === "/api/entities/MemberGroupAssignment"
      || url.pathname === "/api/entities/Booking"
      || url.pathname === "/api/entities/PageBanner"
      || url.pathname === "/api/entities/ResourceCategory"
      || url.pathname === "/api/entities/PreferenceField"
      || url.pathname === "/api/public/microsites"
      || url.pathname === "/api/public/navigation-items"
      || url.pathname === "/api/public/banners"
      || url.pathname === "/api/public/typography-styles"
      || url.pathname === "/api/entities/TypographyStyle"
      || url.pathname === "/api/public/installed-fonts"
      || url.pathname === "/api/zoom/webinars"
      || url.pathname === "/api/bookmarks"
      || url.pathname === "/api/bookmarks/enriched") return json(route, []);
    if (url.pathname === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (url.pathname === "/api/admin/form-submissions/stats") return json(route, {});
    if (url.pathname === "/api/public/article-settings") return json(route, {});
    if (url.pathname === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (url.pathname === "/api/public/platform-defaults") return json(route, {});
    if (url.pathname === "/api/public/ai-help-persona") return json(route, { enabled: false });
    if (url.pathname === "/api/public/form-consent-message") return json(route, { message: null });
    if (url.pathname === "/api/tenant-canvas-theme") return json(route, { theme: null });
    if (url.pathname === "/api/public/canvas-symbols") return json(route, { symbols: [] });
    if (url.pathname.startsWith("/api/redirects/resolve")) return json(route, { found: false });
    return json(route, []);
  });

  return state;
}

test("loads only after permission readiness and shows evidenced and unavailable schedules", async ({ page }) => {
  const state = await installFixture(page, { holdReport: true });
  await page.goto("/MembershipPaymentReport", { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("text-page-title")).toHaveText("Individual Membership Payment Report");
  await expect(page.getByTestId("membership-payment-loading")).toBeVisible();
  expect(state.reportRequests).toEqual([{ method: "all", page: "1", pageSize: "25" }]);

  state.releaseReport();
  await expect(page.getByTestId("row-payment-member-alex")).toContainText("06 Nov 2026");
  await expect(page.getByTestId("row-payment-member-billie")).toContainText("Unknown");
  await expect(page.getByTestId("row-payment-member-billie")).toContainText("Unavailable");
  await expect(page.getByTestId("text-result-count")).toHaveText("27 members");
  await expect(page.getByRole("link", { name: "Alex Card", exact: true }))
    .toHaveAttribute("href", "/members/member-alex");
  await expect(page.getByRole("link", {
    name: "Individual Membership Payment Report",
    exact: true,
  })).toBeVisible();
  await page.screenshot({
    path: "/tmp/membership-payment-report-rendered.png",
    fullPage: true,
  });
  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("pagination and method filtering send server-side query parameters and reset the page", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/MembershipPaymentReport");
  await expect(page.getByTestId("row-payment-member-alex")).toBeVisible();

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("row-payment-member-page-two")).toBeVisible();
  expect(state.reportRequests.at(-1)).toEqual({ method: "all", page: "2", pageSize: "25" });

  await page.getByTestId("select-payment-method").click();
  await page.getByRole("option", { name: "Upfront", exact: true }).click();
  await expect(page.getByTestId("row-payment-member-upfront")).toContainText("Upfront");
  await expect(page.getByTestId("row-payment-member-upfront")).toContainText("Not Scheduled");
  await expect(page.getByTestId("row-payment-member-upfront")).toContainText("Unknown");
  await expect(page.getByText("Page 1 of", { exact: false })).toHaveCount(0);
  expect(state.reportRequests.at(-1)).toEqual({ method: "upfront", page: "1", pageSize: "25" });

  await page.getByTestId("select-payment-method").click();
  await page.getByRole("option", { name: "Direct Debit", exact: true }).click();
  await expect(page.getByTestId("row-payment-member-billie")).toBeVisible();
  await expect(page.getByText("Page 1 of", { exact: false })).toHaveCount(0);
  expect(state.reportRequests.at(-1)).toEqual({ method: "direct_debit", page: "1", pageSize: "25" });

  await page.getByTestId("select-payment-method").click();
  await page.getByRole("option", { name: "Invoice", exact: true }).click();
  await expect(page.getByTestId("text-no-payment-rows")).toBeVisible();
  expect(state.reportRequests.at(-1)).toEqual({ method: "invoice", page: "1", pageSize: "25" });
});

test("downloads the selected full-report CSV with the server filename and leaves pagination intact", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/MembershipPaymentReport");
  await expect(page.getByTestId("row-payment-member-alex")).toBeVisible();

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await page.getByTestId("select-payment-method").click();
  await page.getByRole("option", { name: "Upfront", exact: true }).click();
  await expect(page.getByTestId("row-payment-member-upfront")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-download-payment-report").click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("individual-membership-payments-upfront.csv");
  expect(state.csvRequests).toEqual([{
    format: "csv",
    method: "upfront",
    page: null,
    pageSize: null,
  }]);
  expect(state.reportRequests.at(-1)).toEqual({
    method: "upfront",
    page: "1",
    pageSize: "25",
  });
  await expect(page.getByTestId("row-payment-member-upfront")).toBeVisible();
});

test("prevents duplicate exports while pending and reports JSON export failures without hiding the report", async ({ page }) => {
  const state = await installFixture(page, { holdCsv: true, csvStatuses: [500] });
  await page.goto("/MembershipPaymentReport");
  await expect(page.getByTestId("row-payment-member-alex")).toBeVisible();

  await page.getByTestId("button-download-payment-report").evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.getByTestId("button-download-payment-report"))
    .toHaveText("Downloading…");
  await expect(page.getByTestId("button-download-payment-report")).toBeDisabled();
  expect(state.csvRequests).toHaveLength(1);

  state.releaseCsv();
  await expect(page.getByTestId("text-export-error"))
    .toHaveText("Payment report export temporarily unavailable");
  await expect(page.getByTestId("button-download-payment-report")).toHaveText("Download CSV");
  await expect(page.getByTestId("button-download-payment-report")).toBeEnabled();
  await expect(page.getByTestId("row-payment-member-alex")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();

  await page.getByTestId("select-payment-method").click();
  await page.getByRole("option", { name: "Invoice", exact: true }).click();
  await expect(page.getByTestId("text-export-error")).toHaveCount(0);
});

test("member names remain plain text unless both client and endpoint allow member access", async ({ page }) => {
  await installFixture(page, {
    excluded: [MEMBERS_PERMISSION],
    // An accidentally optimistic endpoint response must not override the role.
    canViewMembers: true,
  });
  await page.goto("/MembershipPaymentReport");
  await expect(page.getByTestId("row-payment-member-alex")).toBeVisible();
  await expect(page.getByText("Alex Card", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Alex Card", exact: true })).toHaveCount(0);
});

test("the endpoint member permission cannot be overridden by an otherwise privileged client", async ({ page }) => {
  await installFixture(page, { canViewMembers: false });
  await page.goto("/MembershipPaymentReport");
  await expect(page.getByTestId("row-payment-member-alex")).toBeVisible();
  await expect(page.getByText("Alex Card", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Alex Card", exact: true })).toHaveCount(0);
});

test("endpoint failure is explicit rather than presenting an empty report", async ({ page }) => {
  const state = await installFixture(page, { reportStatuses: [500] });
  await page.goto("/MembershipPaymentReport");
  await expect(page.getByTestId("text-report-error"))
    .toHaveText("Payment report temporarily unavailable");
  await expect(page.getByTestId("text-no-payment-rows")).toHaveCount(0);
  expect(state.reportRequests).toHaveLength(1);
});

test("excluded users are redirected before any report request is made", async ({ page }) => {
  const state = await installFixture(page, { excluded: [REPORT_PERMISSION] });
  await page.goto("/MembershipPaymentReport", { waitUntil: "domcontentloaded" });
  // The report asks for Events; the portal shell may subsequently apply the
  // fixture role's configured landing-page fallback. Either way, protected
  // report content must have been left before any report request is issued.
  await expect(page).not.toHaveURL(/\/MembershipPaymentReport$/);
  expect(state.reportRequests).toEqual([]);
  expect(state.csvRequests).toEqual([]);
  await expect(page.getByTestId("text-page-title")).toHaveCount(0);
  await expect(page.getByTestId("button-download-payment-report")).toHaveCount(0);
  await expect(page.getByRole("link", {
    name: "Individual Membership Payment Report",
    exact: true,
  })).toHaveCount(0);
});
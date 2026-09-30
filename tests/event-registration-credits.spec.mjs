import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

/*
 * Task 4768 browser coverage is fixture-only. Provider discovery and report
 * reads are intercepted; every other financial mutation is rejected.
 */

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000"),
).origin;

const TENANT = { id: "tenant-credit-refresh", name: "Credit refresh fixture", slug: "credit-refresh" };
const ADMIN = {
  id: "admin-credit-refresh",
  email: "credit-refresh-admin@example.invalid",
  first_name: "Credit",
  last_name: "Administrator",
  tenant_id: TENANT.id,
  organization_id: null,
  role_id: "role-credit-refresh",
  member_excluded_features: [],
  is_team_member: true,
  sessionRole: {
    status: "ready",
    member_id: "admin-credit-refresh",
    tenant_id: TENANT.id,
    role_id: "role-credit-refresh",
    role: { id: "role-credit-refresh", name: "Credit administrator", excluded_features: [] },
  },
};
const EVENT = {
  id: "event-credit-refresh",
  title: "Credit Recovery Workshop",
  start_date: "2026-11-10T09:00:00.000Z",
  end_date: "2026-11-10T16:00:00.000Z",
  internal_reference: "CR-4768",
  is_complex: false,
};

function group(index, { source = "booking", credit = null, status = "unavailable" } = {}) {
  const number = String(index).padStart(2, "0");
  const id = `credit-refresh-${number}`;
  const amount = credit ?? null;
  const attendee = {
    id,
    attendee_first_name: source === "complex_event_booking" ? "Complex" : "Standard",
    attendee_last_name: `Credit ${number}`,
    attendee_email: `${id}@example.invalid`,
    ticket_class_name: "Credit fixture",
    ticket_price: 20,
    ticket_price_status: "available",
    price_paid: 20,
    price_paid_status: "net",
    payment_method: "card",
    booking_reference: `REF-${number}`,
    status: "confirmed",
    created_at: "2026-09-01T12:00:00.000Z",
    third_party_consent: false,
    badge: true,
  };
  return {
    groupRef: null,
    isGroup: false,
    attendeeCount: 1,
    eventTitle: EVENT.title,
    internalReference: EVENT.internal_reference,
    eventId: EVENT.id,
    isComplexEvent: source === "complex_event_booking",
    bookingSource: source,
    eventStartDate: EVENT.start_date,
    eventEndDate: EVENT.end_date,
    hasZoom: false,
    hasTeams: false,
    hasAttendance: false,
    booker: null,
    credits: {
      amount,
      currency: amount == null ? null : "GBP",
      status: amount == null ? status : "confirmed",
      breakdown: amount == null ? [] : [{
        type: "refund",
        provider: "stripe",
        providerId: `re_${number}`,
        amount,
        currency: "GBP",
        status: "confirmed",
        operationKey: `refresh-${number}`,
      }],
    },
    groupPayment: {
      ticketTotal: 20,
      totalCost: 20,
      totalAfterDiscount: 20,
      discount: 0,
      offerDiscount: 0,
      codeDiscount: 0,
      discountCode: null,
      voucherAmount: 0,
      trainingFundAmount: 0,
      accountAmount: 0,
      paymentMethod: "card",
      purchaseOrderNumber: null,
      poToFollow: false,
      stripePaymentIntentId: `pi_${number}`,
      xeroInvoiceNumber: null,
      xeroInvoiceId: null,
      xeroInvoiceError: null,
      bookingReference: `REF-${number}`,
    },
    attendees: [attendee],
  };
}

function report(groups) {
  return {
    tenantId: TENANT.id,
    canRefreshCredits: true,
    events: [EVENT],
    bookingGroups: groups,
    organizations: {},
    summary: {},
    hasZoomForSelectedEvents: false,
    hasTeamsForSelectedEvents: false,
    hasAttendanceForSelectedEvents: false,
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installFixture(page, {
  groups = [group(1)],
  authorized = true,
  canRefresh = authorized,
  reconcile,
} = {}) {
  const state = {
    reconciliationCalls: [],
    rejectedWrites: [],
    unexpectedExternal: [],
    reportReads: 0,
  };

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

    if (method === "PATCH" && url.pathname === `/api/entities/Member/${ADMIN.id}`) {
      return json(route, ADMIN);
    }
    if (method === "POST" && url.pathname === "/api/reports/reconcile-booking-credits") {
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        return json(route, { error: "Invalid fixture reconciliation request" }, 400);
      }
      state.reconciliationCalls.push(body);
      const response = reconcile
        ? await reconcile(body, state)
        : { body: { written: body.bookingIds.length, unresolved: false, nextCursor: null } };
      const responseBody = response.body && Object.prototype.hasOwnProperty.call(response.body, "tenantId")
        ? response.body
        : { ...response.body, tenantId: TENANT.id };
      return json(route, responseBody, response.status || 200);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.rejectedWrites.push(`${method} ${url.pathname}`);
      return json(route, { error: "Fixture rejected unexpected financial mutation" }, 599);
    }

    const user = authorized
      ? ADMIN
      : {
        ...ADMIN,
        member_excluded_features: ["events.event-report"],
        sessionRole: {
          ...ADMIN.sessionRole,
          role: { ...ADMIN.sessionRole.role, excluded_features: ["events.event-report"] },
        },
      };
    if (url.pathname === "/api/auth/me") return json(route, user);
    if (url.pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: false }, 401);
    if (url.pathname === "/api/reports/event-registration-report") {
      if (url.searchParams.get("generate") === "true") {
        state.reportReads += 1;
        return json(route, { ...report(groups), canRefreshCredits: canRefresh });
      }
      return json(route, { events: [EVENT] });
    }
    if (url.pathname.startsWith("/api/entities/Role/")) return json(route, user.sessionRole.role);
    if (url.pathname === "/api/entities/Role") return json(route, [user.sessionRole.role]);
    if (url.pathname === "/api/entities/Member") return json(route, [user]);
    if (url.pathname.startsWith("/api/entities/Member/")) return json(route, user);
    if (url.pathname === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (url.pathname === "/api/admin/form-submissions/stats") return json(route, {});
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

async function openReport(page, options) {
  const state = await installFixture(page, options);
  await page.goto("/EventRegistrationReport", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("text-page-title")).toHaveText("Event Registration Report");
  await page.getByTestId("button-generate-report").click();
  await expect(page.getByTestId("row-booking-credit-refresh-01")).toBeVisible();
  return state;
}

async function confirmRefresh(page) {
  await page.getByTestId("button-refresh-booking-credits").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("button-confirm-credit-refresh").click();
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function exportCreditColumns(page) {
  await page.getByTestId("button-export-csv").click();
  await page.getByTestId("button-clear-all-columns").click();
  await page.getByTestId("checkbox-column-std:name").click();
  await page.getByTestId("checkbox-column-std:credits").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-confirm-export").click();
  return readDownload(await downloadPromise);
}

test("confirmation describes the immutable report-wide scope across pages", async ({ page }) => {
  const groups = Array.from({ length: 28 }, (_, index) =>
    group(index + 1, { source: index % 3 === 0 ? "complex_event_booking" : "booking" }));
  const state = await openReport(page, { groups });

  await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await page.getByTestId("button-refresh-booking-credits").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("28 eligible bookings");
  await expect(dialog).toContainText("18 standard");
  await expect(dialog).toContainText("10 complex");
  await expect(dialog).toContainText("fixed snapshot");
  await expect(dialog.getByTestId("credit-refresh-filter-scope")).not.toBeEmpty();
  await expect(page.getByTestId("button-confirm-credit-refresh")).toHaveText("Refresh 28 bookings");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  expect(state.reconciliationCalls).toEqual([]);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("mixed sources are bounded to 25 and every provider cursor is continued", async ({ page }) => {
  const groups = Array.from({ length: 32 }, (_, index) =>
    group(index + 1, { source: index < 27 ? "booking" : "complex_event_booking" }));
  const seen = new Map();
  const state = await openReport(page, {
    groups,
    reconcile: async (body) => {
      const key = `${body.source}:${body.bookingIds.join(",")}`;
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      return count === 1
        ? { body: { written: 1, unresolved: true, nextCursor: { index: 0, after: "re_page_1" } } }
        : { body: { written: body.bookingIds.length, unresolved: false, nextCursor: null } };
    },
  });

  await confirmRefresh(page);
  await expect(page.getByTestId("credit-refresh-progress")).toHaveCount(0);
  await expect(page.getByTestId("button-refresh-booking-credits")).toBeEnabled();

  expect(state.reconciliationCalls.length).toBe(6);
  for (const call of state.reconciliationCalls) {
    expect(["booking", "complex_event_booking"]).toContain(call.source);
    expect(call.bookingIds.length).toBeGreaterThan(0);
    expect(call.bookingIds.length).toBeLessThanOrEqual(25);
  }
  const isInitialCursor = (cursor) => !cursor || Object.keys(cursor).length === 0;
  expect(state.reconciliationCalls.filter((call) => call.source === "booking" && isInitialCursor(call.cursor))
    .map((call) => call.bookingIds.length)).toEqual([25, 2]);
  expect(state.reconciliationCalls.filter((call) =>
    call.source === "complex_event_booking" && isInitialCursor(call.cursor))
    .map((call) => call.bookingIds.length)).toEqual([5]);
  for (let index = 0; index < state.reconciliationCalls.length; index += 2) {
    expect(state.reconciliationCalls[index + 1].cursor)
      .toEqual({ index: 0, after: "re_page_1" });
  }
  expect(state.rejectedWrites).toEqual([]);
});

test("duplicate clicks cannot start overlapping refreshes", async ({ page }) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const state = await openReport(page, {
    reconcile: async (body) => {
      await blocked;
      return { body: { written: body.bookingIds.length, unresolved: false, nextCursor: null } };
    },
  });

  await page.getByTestId("button-refresh-booking-credits").click();
  await page.getByTestId("button-confirm-credit-refresh").dblclick();
  await expect.poll(() => state.reconciliationCalls.length).toBe(1);
  await expect(page.getByTestId("button-refresh-booking-credits")).toBeDisabled();
  release();
  await expect(page.getByTestId("button-refresh-booking-credits")).toBeEnabled();
  expect(state.reconciliationCalls).toHaveLength(1);
  expect(state.rejectedWrites).toEqual([]);
});

test("stop and Resume retain the cursor without replaying completed batches", async ({ page }) => {
  const groups = Array.from({ length: 28 }, (_, index) => group(index + 1));
  let releaseSecond;
  const secondBlocked = new Promise((resolve) => { releaseSecond = resolve; });
  let calls = 0;
  const state = await openReport(page, {
    groups,
    reconcile: async (body) => {
      calls += 1;
      if (calls === 1) {
        return { body: { written: 1, unresolved: true, nextCursor: { index: 1, after: "re_first" } } };
      }
      if (calls === 2) await secondBlocked;
      return { body: { written: body.bookingIds.length, unresolved: false, nextCursor: null } };
    },
  });

  await confirmRefresh(page);
  await expect.poll(() => state.reconciliationCalls.length).toBe(2);
  await page.getByTestId("button-stop-credit-refresh").click();
  releaseSecond();
  await expect(page.getByTestId("credit-refresh-stopped")).toContainText("Stopped after 25 of 28");
  expect(state.reconciliationCalls).toHaveLength(2);

  await expect(page.getByTestId("button-retry-credit-refresh")).toHaveCount(0);
  await page.getByTestId("button-resume-credit-refresh").click();
  await expect(page.getByTestId("button-refresh-booking-credits")).toBeEnabled();
  expect(state.reconciliationCalls).toHaveLength(3);
  expect(state.reconciliationCalls[2].bookingIds).toEqual([
    "credit-refresh-26", "credit-refresh-27", "credit-refresh-28",
  ]);
  expect(state.reconciliationCalls[2].cursor).toEqual({});
  expect(state.rejectedWrites).toEqual([]);
});

test("the 1000-request safety pause resumes with a fresh budget and no cursor replay", async ({ page }) => {
  test.setTimeout(60_000);
  let calls = 0;
  const state = await openReport(page, {
    reconcile: async () => {
      calls += 1;
      return {
        body: {
          written: 0,
          unresolved: calls <= 1000,
          nextCursor: calls <= 1000 ? { index: 0, after: `re_budget_${calls}` } : null,
        },
      };
    },
  });

  await confirmRefresh(page);
  const stopped = page.getByTestId("credit-refresh-stopped");
  await expect(stopped).toContainText("per-run safety budget", { timeout: 45_000 });
  await expect(stopped).toContainText("saved cursor");
  expect(state.reconciliationCalls).toHaveLength(1000);

  await page.getByTestId("button-resume-credit-refresh").click();
  await expect(stopped).toHaveCount(0);
  await expect(page.getByTestId("button-refresh-booking-credits")).toBeEnabled();
  expect(state.reconciliationCalls).toHaveLength(1001);
  expect(state.reconciliationCalls[1000].cursor).toEqual({ index: 0, after: "re_budget_1000" });
  expect(new Set(state.reconciliationCalls.map((call) => JSON.stringify(call.cursor))).size).toBe(1001);
  expect(state.rejectedWrites).toEqual([]);
});

test("one provider failure is explicit and retry only replays its failed batch", async ({ page }) => {
  const groups = [group(1), group(2, { source: "complex_event_booking" })];
  let complexAttempts = 0;
  const state = await openReport(page, {
    groups,
    reconcile: async (body) => {
      if (body.source === "complex_event_booking" && ++complexAttempts === 1) {
        return { status: 422, body: { error: "Credit reconciliation incomplete: Xero unavailable" } };
      }
      return { body: { written: body.bookingIds.length, unresolved: false, nextCursor: null } };
    },
  });

  await confirmRefresh(page);
  await expect(page.getByTestId("credit-refresh-error")).toContainText("Xero unavailable");
  await expect(page.getByTestId("button-retry-credit-refresh")).toBeVisible();
  expect(state.reconciliationCalls.map((call) => call.source))
    .toEqual(["booking", "complex_event_booking"]);

  await page.getByTestId("button-retry-credit-refresh").click();
  await expect(page.getByTestId("credit-refresh-error")).toHaveCount(0);
  expect(state.reconciliationCalls.map((call) => call.source))
    .toEqual(["booking", "complex_event_booking", "complex_event_booking"]);
  expect(state.rejectedWrites).toEqual([]);
});

test("scope changes invalidate confirmation and tenant changes stop continuation", async ({ page }) => {
  const groups = Array.from({ length: 27 }, (_, index) => group(index + 1));
  let calls = 0;
  const state = await openReport(page, {
    groups,
    reconcile: async (body) => {
      calls += 1;
      if (calls === 2) {
        return { status: 409, body: { error: "Tenant context changed. Reload this page." } };
      }
      return { body: { written: body.bookingIds.length, unresolved: false, nextCursor: null } };
    },
  });

  await page.getByTestId("button-refresh-booking-credits").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("input-search").fill("Credit 01");
  await page.getByTestId("button-refresh-booking-credits").click();
  await expect(page.getByTestId("button-confirm-credit-refresh")).toHaveText("Refresh 1 bookings");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("input-search").fill("");

  await confirmRefresh(page);
  await expect(page.getByTestId("credit-refresh-error"))
    .toContainText("Tenant context changed");
  expect(state.reconciliationCalls).toHaveLength(2);
  await expect(page.getByTestId("button-retry-credit-refresh")).toBeVisible();
  await page.getByTestId("input-search").fill("Credit 01");
  await expect(page.getByTestId("button-retry-credit-refresh")).toHaveCount(0);
  await expect(page.getByTestId("credit-refresh-error")).toHaveCount(0);
  expect(state.rejectedWrites).toEqual([]);
});

test("unauthorized report roles never see the refresh control", async ({ page }) => {
  const state = await openReport(page, { canRefresh: false });
  await expect(page.getByTestId("button-refresh-booking-credits")).toHaveCount(0);
  expect(state.reconciliationCalls).toEqual([]);
  expect(state.rejectedWrites).toEqual([]);
});

test("refreshed values, totals and CSV agree and visible proof is saved", async ({ page }) => {
  const groups = [group(1, { credit: 12.5 }), group(2, { credit: 7 })];
  const state = await openReport(page, { groups });

  await expect(page.getByTestId("text-credits-credit-refresh-01")).toHaveText("£12.50");
  await expect(page.getByTestId("text-credits-credit-refresh-02")).toHaveText("£7.00");
  await expect(page.getByTestId("text-total-credits")).toHaveText("£19.50");
  const csv = await exportCreditColumns(page);
  expect(csv).toContain('"Standard Credit 01","£12.50 — Refund (stripe) #re_01: £12.50"');
  expect(csv).toContain('"Standard Credit 02","£7.00 — Refund (stripe) #re_02: £7.00"');

  const acceptCookies = page.getByRole("button", { name: "Accept", exact: true });
  if (await acceptCookies.isVisible().catch(() => false)) await acceptCookies.click();
  await page.locator(".overflow-x-auto").evaluate((element) => { element.scrollLeft = 720; });
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({
    path: "screenshots/task-4768-event-registration-refresh-credits.png",
    fullPage: true,
  });

  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});
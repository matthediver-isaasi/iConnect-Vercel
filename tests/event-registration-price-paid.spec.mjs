import { expect, test } from "@playwright/test";

/*
 * Task 4733 browser coverage is fixture-only. Every API/Supabase request is
 * intercepted, non-shell writes are rejected, and no tenant or database is
 * contacted.
 */

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000"),
).origin;

const TENANT = {
  id: "tenant-price-paid",
  name: "Price Paid fixture",
  slug: "price-paid-fixture",
};

const ADMIN = {
  id: "admin-price-paid",
  email: "price-paid-admin@example.invalid",
  first_name: "Price",
  last_name: "Administrator",
  tenant_id: TENANT.id,
  organization_id: null,
  role_id: "role-price-paid",
  member_excluded_features: [],
  is_team_member: true,
  sessionRole: {
    status: "ready",
    member_id: "admin-price-paid",
    tenant_id: TENANT.id,
    role_id: "role-price-paid",
    role: {
      id: "role-price-paid",
      name: "Price Paid administrator",
      excluded_features: [],
    },
  },
};

const EVENT = {
  id: "event-price-paid",
  title: "Price Paid Workshop",
  start_date: "2026-10-15T09:00:00.000Z",
  end_date: "2026-10-15T16:00:00.000Z",
  internal_reference: "PP-4733",
  is_complex: false,
};

function attendee({
  id,
  firstName,
  lastName,
  email,
  ticketPrice,
  pricePaid,
  pricePaidStatus,
}) {
  return {
    id,
    attendee_first_name: firstName,
    attendee_last_name: lastName,
    attendee_email: email,
    ticket_class_name: "Standard",
    ticket_price: ticketPrice,
    price_paid: pricePaid,
    price_paid_status: pricePaidStatus,
    payment_method: pricePaidStatus === "pending" ? "public_invoice_po" : "card",
    booking_reference: `REF-${id}`,
    status: "confirmed",
    created_at: "2026-09-01T12:00:00.000Z",
    third_party_consent: false,
    badge: true,
  };
}

function bookingGroup(row) {
  return {
    groupRef: null,
    isGroup: false,
    attendeeCount: 1,
    eventTitle: EVENT.title,
    internalReference: EVENT.internal_reference,
    eventId: EVENT.id,
    isComplexEvent: false,
    eventStartDate: EVENT.start_date,
    eventEndDate: EVENT.end_date,
    hasZoom: false,
    hasTeams: false,
    hasAttendance: false,
    booker: null,
    groupPayment: {
      ticketTotal: row.ticket_price,
      totalCost: row.price_paid ?? row.ticket_price,
      discount: Math.max(0, row.ticket_price - (row.price_paid ?? row.ticket_price)),
      offerDiscount: 0,
      codeDiscount: 0,
      discountCode: null,
      voucherAmount: 0,
      trainingFundAmount: 0,
      accountAmount: 0,
      paymentMethod: row.payment_method,
      purchaseOrderNumber: null,
      poToFollow: false,
      stripePaymentIntentId: row.payment_method === "card" ? `pi_${row.id}` : null,
      xeroInvoiceNumber: null,
      xeroInvoiceId: null,
      xeroInvoiceError: null,
      bookingReference: row.booking_reference,
    },
    attendees: [row],
  };
}

const NET_ATTENDEE = attendee({
  id: "nettie",
  firstName: "Nettie",
  lastName: "Net",
  email: "nettie@example.invalid",
  ticketPrice: 25,
  pricePaid: 18.25,
  pricePaidStatus: "net",
});
const PENDING_ATTENDEE = attendee({
  id: "penny",
  firstName: "Penny",
  lastName: "Pending",
  email: "penny@example.invalid",
  ticketPrice: 40,
  pricePaid: 40,
  pricePaidStatus: "pending",
});

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installFixture(page) {
  const state = { writes: [], unexpectedExternal: [] };

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

    // The portal shell persists the current page; keep this isolated write
    // local while rejecting all report-affecting writes.
    if (method === "PATCH" && url.pathname === `/api/entities/Member/${ADMIN.id}`) {
      return json(route, ADMIN);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(`${method} ${url.pathname}`);
      return json(route, { error: "Read-only Price Paid fixture" }, 599);
    }

    if (url.pathname === "/api/auth/me") return json(route, ADMIN);
    if (url.pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: false }, 401);
    if (url.pathname === "/api/reports/event-registration-report") {
      if (url.searchParams.get("generate") === "true") {
        return json(route, {
          events: [EVENT],
          bookingGroups: [bookingGroup(NET_ATTENDEE), bookingGroup(PENDING_ATTENDEE)],
          organizations: {},
          summary: {},
          hasZoomForSelectedEvents: false,
          hasTeamsForSelectedEvents: false,
          hasAttendanceForSelectedEvents: false,
        });
      }
      return json(route, { events: [EVENT] });
    }

    if (url.pathname.startsWith("/api/entities/Role/")) return json(route, ADMIN.sessionRole.role);
    if (url.pathname === "/api/entities/Role") return json(route, [ADMIN.sessionRole.role]);
    if (url.pathname === "/api/entities/Member") return json(route, [ADMIN]);
    if (url.pathname.startsWith("/api/entities/Member/")) return json(route, ADMIN);
    if (url.pathname === "/api/entities/Form"
      || url.pathname === "/api/entities/PortalMenu"
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

async function openGeneratedReport(page) {
  const state = await installFixture(page);
  await page.goto("/EventRegistrationReport", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("text-page-title")).toHaveText("Event Registration Report");
  await page.getByTestId("button-generate-report").click();
  await expect(page.getByTestId("row-booking-nettie")).toBeVisible();
  return state;
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("Price Paid is visible with net and pending semantics and selected by default", async ({ page }) => {
  const state = await openGeneratedReport(page);

  await expect(page.getByRole("columnheader", { name: "Price Paid", exact: true })).toBeVisible();
  await expect(page.getByTestId("text-price-paid-nettie")).toHaveText("£18.25");
  await expect(page.getByTestId("text-price-paid-penny")).toHaveText("Pending/unpaid — £40.00");
  await expect(page.getByTestId("text-price-paid-explanation"))
    .toContainText("net ticket price after discounts and credits");

  await page.getByTestId("button-export-csv").click();
  const pricePaidCheckbox = page.getByTestId("checkbox-column-std:pricePaid");
  await expect(pricePaidCheckbox).toHaveAttribute("data-state", "checked");
  await pricePaidCheckbox.click();
  await expect(pricePaidCheckbox).toHaveAttribute("data-state", "unchecked");
  await pricePaidCheckbox.click();
  await expect(pricePaidCheckbox).toHaveAttribute("data-state", "checked");

  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("filtered selected CSV agrees with the visible Price Paid row", async ({ page }) => {
  const state = await openGeneratedReport(page);

  await page.getByTestId("input-search").fill("Nettie");
  await expect(page.getByTestId("row-booking-nettie")).toBeVisible();
  await expect(page.getByTestId("row-booking-penny")).toHaveCount(0);
  await expect(page.getByTestId("text-price-paid-nettie")).toHaveText("£18.25");

  await page.getByTestId("button-export-csv").click();
  await page.getByTestId("button-clear-all-columns").click();
  await page.getByTestId("checkbox-column-std:name").click();
  await page.getByTestId("checkbox-column-std:pricePaid").click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-confirm-export").click();
  const csv = await readDownload(await downloadPromise);

  expect(csv).toBe('"Name","Price Paid"\n"Nettie Net","£18.25"');
  expect(csv).not.toContain("Penny Pending");
  expect(csv).not.toContain("£40.00");
  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});
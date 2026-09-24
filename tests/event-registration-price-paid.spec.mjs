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
  ticketClassName = "Standard",
  ticketPriceStatus,
  paymentMethod,
  createdAt = "2026-09-01T12:00:00.000Z",
}) {
  return {
    id,
    attendee_first_name: firstName,
    attendee_last_name: lastName,
    attendee_email: email,
    ticket_class_name: ticketClassName,
    ticket_price: ticketPrice,
    ticket_price_status: ticketPriceStatus,
    price_paid: pricePaid,
    price_paid_status: pricePaidStatus,
    payment_method: paymentMethod || (pricePaidStatus === "pending" ? "public_invoice_po" : "card"),
    booking_reference: `REF-${id}`,
    status: "confirmed",
    created_at: createdAt,
    third_party_consent: false,
    badge: true,
  };
}

function bookingGroup(row, overrides = {}) {
  const payment = overrides.groupPayment || {};
  return {
    groupRef: overrides.groupRef ?? null,
    isGroup: overrides.isGroup ?? false,
    attendeeCount: overrides.attendeeCount ?? 1,
    eventTitle: EVENT.title,
    internalReference: EVENT.internal_reference,
    eventId: EVENT.id,
    isComplexEvent: overrides.isComplexEvent ?? false,
    eventStartDate: EVENT.start_date,
    eventEndDate: EVENT.end_date,
    hasZoom: false,
    hasTeams: false,
    hasAttendance: false,
    booker: null,
    groupPayment: {
      ticketTotal: payment.ticketTotal ?? row.ticket_price,
      totalCost: payment.totalCost ?? row.price_paid ?? row.ticket_price,
      totalAfterDiscount: payment.totalAfterDiscount ?? row.ticket_price,
      discount: payment.discount ?? 0,
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
      ...payment,
    },
    attendees: overrides.attendees || [row],
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

function financialFixtureGroups() {
  const make = (details, payment, overrides) => {
    const row = attendee({
      email: `${details.id}@example.invalid`,
      firstName: details.firstName,
      lastName: details.lastName || "Fixture",
      pricePaidStatus: details.pricePaidStatus || "net",
      ticketClassName: details.ticketClassName,
      paymentMethod: details.paymentMethod,
      ...details,
    });
    return bookingGroup(row, { groupPayment: payment, ...overrides });
  };

  const fullCode = make(
    { id: "full-code", firstName: "Fully Code", ticketPrice: 60, pricePaid: 0 },
    {
      ticketTotal: 60,
      totalCost: 60,
      totalAfterDiscount: 0,
      discount: 60,
      codeDiscount: 60,
      discountCode: "FULL60",
    },
  );
  const partial = make(
    { id: "partial", firstName: "Partial", ticketPrice: 100, pricePaid: 60 },
    {
      ticketTotal: 100,
      totalCost: 100,
      totalAfterDiscount: 80,
      discount: 20,
      codeDiscount: 20,
      voucherAmount: 15,
      trainingFundAmount: 5,
      discountCode: "LESS20",
    },
  );
  const noDiscount = make(
    { id: "no-discount", firstName: "No Discount", ticketPrice: 45, pricePaid: 45 },
    { ticketTotal: 45, totalCost: 45, totalAfterDiscount: 45 },
  );
  const unavailable = make(
    {
      id: "unavailable",
      firstName: "Legacy Unavailable",
      ticketPrice: 35,
      pricePaid: null,
      pricePaidStatus: "unavailable",
    },
    { ticketTotal: 35, totalCost: 35, totalAfterDiscount: 35 },
  );
  const pending = make(
    {
      id: "pending-expanded",
      firstName: "Invoice Pending",
      ticketPrice: 50,
      pricePaid: 50,
      pricePaidStatus: "pending",
      paymentMethod: "public_invoice_po",
    },
    { ticketTotal: 50, totalCost: 50, totalAfterDiscount: 50, paymentMethod: "public_invoice_po" },
  );
  const complex = make(
    { id: "complex-applied", firstName: "Complex Applied", ticketPrice: 120, pricePaid: 75 },
    {
      ticketTotal: 120,
      totalCost: 90,
      totalAfterDiscount: 90,
      discount: 30,
      codeDiscount: 30,
      voucherAmount: 10,
      trainingFundAmount: 5,
      discountCode: "ALREADY30",
    },
    { isComplexEvent: true },
  );

  const groupA = attendee({
    id: "group-a",
    firstName: "Grouped",
    lastName: "Alpha",
    email: "group-a@example.invalid",
    ticketPrice: 30,
    pricePaid: 20,
    pricePaidStatus: "net",
  });
  const groupB = attendee({
    id: "group-b",
    firstName: "Grouped",
    lastName: "Beta",
    email: "group-b@example.invalid",
    ticketPrice: 70,
    pricePaid: 40,
    pricePaidStatus: "net",
  });
  const grouped = bookingGroup(groupA, {
    groupRef: "GROUP-PRICE",
    isGroup: true,
    attendeeCount: 2,
    attendees: [groupA, groupB],
    groupPayment: {
      ticketTotal: 100,
      totalCost: 100,
      totalAfterDiscount: 90,
      discount: 10,
      codeDiscount: 10,
      discountCode: "GROUP10",
      voucherAmount: 20,
      trainingFundAmount: 10,
    },
  });

  return [fullCode, partial, noDiscount, complex, grouped, pending, unavailable];
}

function paginationFixtureGroups() {
  return Array.from({ length: 27 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const row = attendee({
      id: `page-${number}`,
      firstName: "Pagination",
      lastName: `Person ${number}`,
      email: `page-${number}@example.invalid`,
      ticketPrice: 10,
      pricePaid: 10,
      pricePaidStatus: "net",
      ticketClassName: "Pagination Cohort",
    });
    return bookingGroup(row, {
      groupPayment: { ticketTotal: 10, totalCost: 10, totalAfterDiscount: 10 },
    });
  });
}

function publicInvoiceOfferGroups() {
  const makeGroup = ({
    groupRef,
    prefix,
    attendeeCount,
    attendeePricePaid,
    discount,
    totalAfterDiscount,
  }) => {
    const attendees = Array.from({ length: attendeeCount }, (_, index) => attendee({
      id: `${prefix}-${index + 1}`,
      firstName: prefix === "bogo" ? "BOGO" : "Bulk",
      lastName: `Attendee ${index + 1}`,
      email: `${prefix}-${index + 1}@example.invalid`,
      ticketPrice: 100,
      pricePaid: attendeePricePaid,
      pricePaidStatus: "pending",
      ticketClassName: prefix === "bogo" ? "BOGO Offer" : "Bulk Offer",
      paymentMethod: "public_invoice_po",
    }));
    return bookingGroup(attendees[0], {
      groupRef,
      isGroup: true,
      attendeeCount,
      attendees,
      groupPayment: {
        ticketTotal: attendeeCount * 100,
        totalCost: totalAfterDiscount,
        totalAfterDiscount,
        discount,
        offerDiscount: discount,
        codeDiscount: 0,
        paymentMethod: "public_invoice_po",
      },
    });
  };

  return [
    makeGroup({
      groupRef: "BOGO-PO",
      prefix: "bogo",
      attendeeCount: 2,
      attendeePricePaid: 50,
      discount: 100,
      totalAfterDiscount: 100,
    }),
    makeGroup({
      groupRef: "BULK-PO",
      prefix: "bulk",
      attendeeCount: 3,
      attendeePricePaid: 80,
      discount: 60,
      totalAfterDiscount: 240,
    }),
  ];
}

function legacyPublicInvoiceOfferGroups() {
  return [
    {
      groupRef: "LEGACY-BOGO-PO",
      prefix: "legacy-bogo",
      attendeeCount: 2,
      attendeePricePaid: 50,
      totalAfterDiscount: 100,
      ticketClassName: "Legacy BOGO Offer",
    },
    {
      groupRef: "LEGACY-BULK-PO",
      prefix: "legacy-bulk",
      attendeeCount: 3,
      attendeePricePaid: 80,
      totalAfterDiscount: 240,
      ticketClassName: "Legacy Bulk Offer",
    },
  ].map((fixture) => {
    const attendees = Array.from({ length: fixture.attendeeCount }, (_, index) => attendee({
      id: `${fixture.prefix}-${index + 1}`,
      firstName: fixture.prefix === "legacy-bogo" ? "Legacy BOGO" : "Legacy Bulk",
      lastName: `Attendee ${index + 1}`,
      email: `${fixture.prefix}-${index + 1}@example.invalid`,
      ticketPrice: null,
      ticketPriceStatus: "unavailable_gross_snapshot",
      pricePaid: fixture.attendeePricePaid,
      pricePaidStatus: "pending",
      ticketClassName: fixture.ticketClassName,
      paymentMethod: "public_invoice_po",
    }));
    return bookingGroup(attendees[0], {
      groupRef: fixture.groupRef,
      isGroup: true,
      attendeeCount: fixture.attendeeCount,
      attendees,
      groupPayment: {
        ticketTotal: null,
        totalCost: fixture.totalAfterDiscount,
        totalAfterDiscount: fixture.totalAfterDiscount,
        discount: null,
        offerDiscount: null,
        codeDiscount: 0,
        totalsStatus: "unavailable_gross_snapshot",
        paymentMethod: "public_invoice_po",
      },
    });
  });
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installFixture(page, { bookingGroups } = {}) {
  const state = { writes: [], unexpectedExternal: [] };
  const reportGroups = bookingGroups
    || [bookingGroup(NET_ATTENDEE), bookingGroup(PENDING_ATTENDEE)];

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
          bookingGroups: reportGroups,
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

async function openGeneratedReport(page, options = {}) {
  const state = await installFixture(page, options);
  await page.goto("/EventRegistrationReport", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("text-page-title")).toHaveText("Event Registration Report");
  await page.getByTestId("button-generate-report").click();
  const readyId = options.readyId || options.bookingGroups?.[0]?.attendees?.[0]?.id || "nettie";
  await expect(page.getByTestId(`row-booking-${readyId}`)).toBeVisible();
  return state;
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function selectOnlyColumns(page, keys) {
  await page.getByTestId("button-export-csv").click();
  await page.getByTestId("button-clear-all-columns").click();
  for (const key of keys) {
    await page.getByTestId(`checkbox-column-${key}`).click();
  }
}

async function exportSelectedColumns(page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-confirm-export").click();
  return readDownload(await downloadPromise);
}

function financialCells(page, attendeeId) {
  const cells = page.getByTestId(`row-booking-${attendeeId}`).locator("td");
  return {
    ticketPrice: cells.nth(7),
    discount: cells.nth(8),
    totalAfterDiscount: cells.nth(9),
    voucher: cells.nth(10),
    fund: cells.nth(11),
    pricePaid: cells.nth(12),
  };
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

test("canonical financial columns cover discounts, credits, complex values, and payment evidence", async ({ page }) => {
  const state = await openGeneratedReport(page, {
    bookingGroups: financialFixtureGroups(),
    readyId: "full-code",
  });

  const headers = await page.getByRole("columnheader").allTextContents();
  const ticketPriceIndex = headers.indexOf("Ticket Price");
  expect(headers.slice(ticketPriceIndex, ticketPriceIndex + 6)).toEqual([
    "Ticket Price",
    "Discount",
    "Total after Discount",
    "Voucher",
    "Fund",
    "Price Paid",
  ]);

  const fullyCovered = financialCells(page, "full-code");
  await expect(fullyCovered.ticketPrice).toHaveText("£60.00");
  await expect(fullyCovered.discount).toContainText("-£60.00");
  await expect(fullyCovered.totalAfterDiscount).toHaveText("£0.00");
  await expect(fullyCovered.voucher).toHaveText("-");
  await expect(fullyCovered.fund).toHaveText("-");
  await expect(fullyCovered.pricePaid).toHaveText("£0.00");

  const partial = financialCells(page, "partial");
  await expect(partial.ticketPrice).toHaveText("£100.00");
  await expect(partial.discount).toContainText("-£20.00");
  await expect(partial.totalAfterDiscount).toHaveText("£80.00");
  await expect(partial.voucher).toHaveText("£15.00");
  await expect(partial.fund).toHaveText("£5.00");
  await expect(partial.pricePaid).toHaveText("£60.00");

  const undiscounted = financialCells(page, "no-discount");
  await expect(undiscounted.ticketPrice).toHaveText("£45.00");
  await expect(undiscounted.discount).toHaveText("-");
  await expect(undiscounted.totalAfterDiscount).toHaveText("£45.00");
  await expect(undiscounted.pricePaid).toHaveText("£45.00");

  const complex = financialCells(page, "complex-applied");
  await expect(complex.ticketPrice).toHaveText("£120.00");
  await expect(complex.discount).toContainText("-£30.00");
  await expect(complex.totalAfterDiscount).toHaveText("£90.00");
  await expect(complex.voucher).toHaveText("£10.00");
  await expect(complex.fund).toHaveText("£5.00");
  await expect(complex.pricePaid).toHaveText("£75.00");

  await expect(page.getByTestId("text-price-paid-pending-expanded"))
    .toHaveText("Pending/unpaid — £50.00");
  await expect(page.getByTestId("text-price-paid-unavailable")).toHaveText("Unavailable");

  await page.screenshot({ path: "/tmp/task-4751-price-paid-fixture.png", fullPage: true });
  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("group financials render once while Price Paid remains attendee-specific", async ({ page }) => {
  const groups = financialFixtureGroups();
  const grouped = groups.find((group) => group.groupRef === "GROUP-PRICE");
  const state = await openGeneratedReport(page, { bookingGroups: [grouped], readyId: "group-a" });

  const firstRow = financialCells(page, "group-a");
  await expect(firstRow.ticketPrice).toHaveText("£30.00");
  await expect(firstRow.discount).toContainText("-£10.00");
  await expect(firstRow.totalAfterDiscount).toHaveText("£90.00");
  await expect(firstRow.voucher).toHaveText("£20.00");
  await expect(firstRow.fund).toHaveText("£10.00");
  await expect(firstRow.pricePaid).toHaveText("£20.00");
  await expect(page.getByTestId("text-price-paid-group-b")).toHaveText("£40.00");

  await expect(page.getByTestId("text-discount-code-group-a")).toHaveCount(1);
  await expect(page.getByTestId("text-discount-code-group-b")).toHaveCount(0);
  await expect(page.locator("tbody").getByText("£90.00", { exact: true })).toHaveCount(1);
  await expect(page.locator("tbody").getByText("£20.00", { exact: true })).toHaveCount(2);

  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("authoritative-snapshot public invoice offers keep gross, discount, pending allocation, footer, and CSV aligned", async ({ page }) => {
  const state = await openGeneratedReport(page, {
    bookingGroups: publicInvoiceOfferGroups(),
    readyId: "bogo-1",
  });

  const bogo = financialCells(page, "bogo-1");
  await expect(bogo.ticketPrice).toHaveText("£100.00");
  await expect(bogo.discount).toHaveText("-£100.00");
  await expect(bogo.totalAfterDiscount).toHaveText("£100.00");
  await expect(bogo.voucher).toHaveText("-");
  await expect(bogo.fund).toHaveText("-");
  await expect(bogo.pricePaid).toHaveText("Pending/unpaid — £50.00");
  await expect(page.getByTestId("text-price-paid-bogo-2"))
    .toHaveText("Pending/unpaid — £50.00");

  const bulk = financialCells(page, "bulk-1");
  await expect(bulk.ticketPrice).toHaveText("£100.00");
  await expect(bulk.discount).toHaveText("-£60.00");
  await expect(bulk.totalAfterDiscount).toHaveText("£240.00");
  await expect(bulk.voucher).toHaveText("-");
  await expect(bulk.fund).toHaveText("-");
  await expect(bulk.pricePaid).toHaveText("Pending/unpaid — £80.00");
  await expect(page.getByTestId("text-price-paid-bulk-2"))
    .toHaveText("Pending/unpaid — £80.00");
  await expect(page.getByTestId("text-price-paid-bulk-3"))
    .toHaveText("Pending/unpaid — £80.00");

  await expect(page.locator("tbody").getByText("-£100.00", { exact: true })).toHaveCount(1);
  await expect(page.locator("tbody").getByText("-£60.00", { exact: true })).toHaveCount(1);
  await expect(page.locator("tbody").getByText("£240.00", { exact: true })).toHaveCount(1);

  const footerCells = page.locator("table tfoot td");
  await expect(footerCells.nth(0)).toHaveText("Totals (5 attendees, 2 bookings)");
  await expect(footerCells.nth(1)).toHaveText("£500.00");
  await expect(footerCells.nth(2)).toHaveText("-£160.00");
  await expect(footerCells.nth(3)).toHaveText("£340.00");
  await expect(footerCells.nth(4)).toHaveText("£0.00");
  await expect(footerCells.nth(5)).toHaveText("£0.00");
  await expect(footerCells.nth(6)).toHaveText("£0.00");

  await selectOnlyColumns(page, [
    "std:name",
    "std:ticketPrice",
    "std:groupDiscount",
    "std:groupTotal",
    "std:voucher",
    "std:trainingFund",
    "std:pricePaid",
  ]);
  const csv = await exportSelectedColumns(page);
  expect(csv).toBe([
    '"Name","Ticket Price","Discount","Total after Discount","Voucher Amount","Training Fund","Price Paid"',
    '"BOGO Attendee 1","100.00","-100.00","100.00","0.00","0.00","Pending/unpaid — £50.00"',
    '"BOGO Attendee 2","100.00","","","","","Pending/unpaid — £50.00"',
    '"Bulk Attendee 1","100.00","-60.00","240.00","0.00","0.00","Pending/unpaid — £80.00"',
    '"Bulk Attendee 2","100.00","","","","","Pending/unpaid — £80.00"',
    '"Bulk Attendee 3","100.00","","","","","Pending/unpaid — £80.00"',
  ].join("\n"));

  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("legacy public invoice offers preserve known net values without inventing gross or discount", async ({ page }) => {
  const state = await openGeneratedReport(page, {
    bookingGroups: legacyPublicInvoiceOfferGroups(),
    readyId: "legacy-bogo-1",
  });

  const bogo = financialCells(page, "legacy-bogo-1");
  await expect(bogo.ticketPrice).toHaveText("Unavailable");
  await expect(bogo.discount).toHaveText("Unavailable");
  await expect(bogo.totalAfterDiscount).toHaveText("£100.00");
  await expect(bogo.pricePaid).toHaveText("Pending/unpaid — £50.00");
  await expect(page.getByTestId("text-price-paid-legacy-bogo-2"))
    .toHaveText("Pending/unpaid — £50.00");

  const bulk = financialCells(page, "legacy-bulk-1");
  await expect(bulk.ticketPrice).toHaveText("Unavailable");
  await expect(bulk.discount).toHaveText("Unavailable");
  await expect(bulk.totalAfterDiscount).toHaveText("£240.00");
  await expect(bulk.pricePaid).toHaveText("Pending/unpaid — £80.00");
  await expect(page.getByTestId("text-price-paid-legacy-bulk-2"))
    .toHaveText("Pending/unpaid — £80.00");
  await expect(page.getByTestId("text-price-paid-legacy-bulk-3"))
    .toHaveText("Pending/unpaid — £80.00");

  const footerCells = page.locator("table tfoot td");
  await expect(footerCells.nth(0)).toHaveText("Totals (5 attendees, 2 bookings)");
  await expect(footerCells.nth(1)).toHaveText("Unavailable");
  await expect(footerCells.nth(2)).toHaveText("Unavailable");
  await expect(footerCells.nth(3)).toHaveText("£340.00");
  await expect(footerCells.nth(4)).toHaveText("£0.00");
  await expect(footerCells.nth(5)).toHaveText("£0.00");
  await expect(footerCells.nth(6)).toHaveText("£0.00");

  await selectOnlyColumns(page, [
    "std:name",
    "std:ticketPrice",
    "std:groupDiscount",
    "std:groupTotal",
    "std:pricePaid",
  ]);
  const csv = await exportSelectedColumns(page);
  expect(csv).toBe([
    '"Name","Ticket Price","Discount","Total after Discount","Price Paid"',
    '"Legacy BOGO Attendee 1","Unavailable","Unavailable","100.00","Pending/unpaid — £50.00"',
    '"Legacy BOGO Attendee 2","Unavailable","","","Pending/unpaid — £50.00"',
    '"Legacy Bulk Attendee 1","Unavailable","Unavailable","240.00","Pending/unpaid — £80.00"',
    '"Legacy Bulk Attendee 2","Unavailable","","","Pending/unpaid — £80.00"',
    '"Legacy Bulk Attendee 3","Unavailable","","","Pending/unpaid — £80.00"',
  ].join("\n"));
  expect(csv).not.toContain('"0.00","0.00"');
  expect(csv).not.toContain('"100.00","-100.00"');
  expect(csv).not.toContain('"300.00","-60.00"');

  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("mixed known and unavailable gross snapshots keep aggregate gross and discount unavailable", async ({ page }) => {
  const knownGroup = financialFixtureGroups().find((group) =>
    group.attendees[0].id === "no-discount");
  const state = await openGeneratedReport(page, {
    bookingGroups: [...legacyPublicInvoiceOfferGroups(), knownGroup],
    readyId: "legacy-bogo-1",
  });

  const footerCells = page.locator("table tfoot td");
  await expect(footerCells.nth(0)).toHaveText("Totals (6 attendees, 3 bookings)");
  await expect(footerCells.nth(1)).toHaveText("Unavailable");
  await expect(footerCells.nth(2)).toHaveText("Unavailable");
  await expect(footerCells.nth(3)).toHaveText("£385.00");
  await expect(footerCells.nth(6)).toHaveText("£45.00");
  await expect(page.getByTestId("row-booking-no-discount")).toContainText("£45.00");

  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("financial CSV order uses stable keys and column deselection persists when reopened", async ({ page }) => {
  const state = await openGeneratedReport(page, {
    bookingGroups: [financialFixtureGroups()[0]],
    readyId: "full-code",
  });
  const financialKeys = [
    "std:ticketPrice",
    "std:groupDiscount",
    "std:groupTotal",
    "std:voucher",
    "std:trainingFund",
    "std:pricePaid",
  ];

  await selectOnlyColumns(page, financialKeys);
  for (const key of financialKeys) {
    await expect(page.getByTestId(`checkbox-column-${key}`)).toHaveAttribute("data-state", "checked");
  }

  await page.getByTestId("checkbox-column-std:voucher").click();
  await expect(page.getByTestId("checkbox-column-std:voucher"))
    .toHaveAttribute("data-state", "unchecked");
  await page.getByTestId("button-cancel-export").click();
  await page.getByTestId("button-export-csv").click();
  await expect(page.getByTestId("checkbox-column-std:voucher"))
    .toHaveAttribute("data-state", "unchecked");
  await page.getByTestId("checkbox-column-std:voucher").click();

  const csv = await exportSelectedColumns(page);
  expect(csv).toBe(
    '"Ticket Price","Discount","Total after Discount","Voucher Amount","Training Fund","Price Paid"\n'
    + '"60.00","-60.00","0.00","0.00","0.00","£0.00"',
  );
  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("filtered totals and CSV cover every booking beyond the 25-group page", async ({ page }) => {
  const state = await openGeneratedReport(page, {
    bookingGroups: paginationFixtureGroups(),
    readyId: "page-01",
  });

  await page.getByTestId("input-search").fill("Pagination");
  await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await expect(page.locator('tbody [data-testid^="row-booking-page-"]')).toHaveCount(25);
  await expect(page.getByTestId("row-booking-page-27")).toHaveCount(0);

  const footerCells = page.locator("table tfoot td");
  await expect(footerCells.nth(0)).toHaveText("Totals (27 attendees, 27 bookings)");
  await expect(footerCells.nth(1)).toHaveText("£270.00");
  await expect(footerCells.nth(2)).toHaveText("-");
  await expect(footerCells.nth(3)).toHaveText("£270.00");
  await expect(footerCells.nth(4)).toHaveText("£0.00");
  await expect(footerCells.nth(5)).toHaveText("£0.00");
  await expect(footerCells.nth(6)).toHaveText("£270.00");

  await page.getByTestId("button-next-page").click();
  await expect(page.getByTestId("row-booking-page-27")).toBeVisible();
  await expect(page.locator('tbody [data-testid^="row-booking-page-"]')).toHaveCount(2);

  await selectOnlyColumns(page, ["std:name", "std:pricePaid"]);
  const csv = await exportSelectedColumns(page);
  const lines = csv.split("\n");
  expect(lines).toHaveLength(28);
  expect(lines[0]).toBe('"Name","Price Paid"');
  expect(lines.slice(1).every((line) => /"Pagination Person \d{2}","£10\.00"/.test(line))).toBe(true);
  expect(csv).toContain('"Pagination Person 01","£10.00"');
  expect(csv).toContain('"Pagination Person 27","£10.00"');
  const csvPricePaidTotal = lines.slice(1).reduce((sum, line) => {
    const amount = line.match(/"£(\d+\.\d{2})"$/)?.[1];
    return sum + Number(amount);
  }, 0);
  expect(csvPricePaidTotal).toBe(270);

  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});
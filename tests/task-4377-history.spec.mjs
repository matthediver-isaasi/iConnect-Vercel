import { test, expect } from "@playwright/test";

const member = {
  id: "history-member-4377",
  tenant_id: "history-tenant-4377",
  organization_id: "history-org-4377",
  role_id: "history-role-4377",
  email: "history-member@example.invalid",
  first_name: "History",
  last_name: "Fixture",
  member_excluded_features: [],
  page_tours_seen: { History: true },
};

const organization = {
  id: member.organization_id,
  tenant_id: member.tenant_id,
  name: "History Fixture Organisation",
};

const role = {
  id: member.role_id,
  name: "Member",
  excluded_features: [],
};

const membershipRecords = [
  {
    id: "personal-2026-4377",
    tenant_id: member.tenant_id,
    member_id: member.id,
    membership_source: "personal",
    membership_year: "2026/2027",
    tier_label: "Personal Standard",
    final_cost: 80,
    total_with_vat: 96,
    payment_method: "invoice",
    accounting_invoice_id: "qbo-personal-8901",
    accounting_invoice_number: "INV-8901",
    xero_invoice_id: null,
    xero_invoice_number: null,
    created_at: "2026-01-15T10:00:00.000Z",
  },
  {
    id: "personal-2027-4377",
    tenant_id: member.tenant_id,
    member_id: member.id,
    membership_source: "personal",
    membership_year: "2027/2028",
    tier_label: "Personal Standard",
    final_cost: 85,
    total_with_vat: 102,
    payment_method: "invoice",
    accounting_invoice_id: "qbo-personal-8902",
    accounting_invoice_number: "INV-8901-2027",
    xero_invoice_id: null,
    xero_invoice_number: null,
    created_at: "2027-01-15T10:00:00.000Z",
  },
  {
    id: "personal-2028-4377",
    tenant_id: member.tenant_id,
    member_id: member.id,
    membership_source: "personal",
    membership_year: "2028/2029",
    tier_label: "Personal Standard",
    final_cost: 90,
    total_with_vat: 108,
    payment_method: "invoice",
    accounting_invoice_id: null,
    accounting_invoice_number: null,
    xero_invoice_id: "xero-personal-2028",
    xero_invoice_number: "XERO-2028-P",
    created_at: "2028-01-15T10:00:00.000Z",
  },
  {
    id: "organisation-2028-4377",
    tenant_id: member.tenant_id,
    organization_id: organization.id,
    membership_source: "organisation",
    membership_year: "2028/2029",
    tier_label: "Organisation Standard",
    final_cost: 120,
    total_with_vat: 144,
    payment_method: "invoice",
    accounting_invoice_id: null,
    accounting_invoice_number: null,
    xero_invoice_id: "xero-org-2028",
    xero_invoice_number: "XERO-2028-O",
    created_at: "2028-02-15T10:00:00.000Z",
  },
  {
    id: "organisation-unlinked-4377",
    tenant_id: member.tenant_id,
    organization_id: organization.id,
    membership_source: "organisation",
    membership_year: "2029/2030",
    tier_label: "Organisation Standard",
    final_cost: 120,
    total_with_vat: 144,
    payment_method: "invoice",
    accounting_invoice_id: null,
    accounting_invoice_number: null,
    xero_invoice_id: null,
    xero_invoice_number: null,
    created_at: "2029-01-15T10:00:00.000Z",
  },
  {
    id: "personal-number-only-4377",
    tenant_id: member.tenant_id,
    member_id: member.id,
    membership_source: "personal",
    membership_year: "2010/2011",
    tier_label: "Personal Archive",
    final_cost: 40,
    total_with_vat: 48,
    payment_method: "invoice",
    accounting_invoice_id: null,
    accounting_invoice_number: "INV-NUMBER-ONLY",
    xero_invoice_id: null,
    xero_invoice_number: null,
    created_at: "2010-01-15T10:00:00.000Z",
  },
];

const programTransaction = {
  id: "program-history-4377",
  organization_id: organization.id,
  transaction_type: "purchase",
  program_name: "Fixture Programme",
  quantity: 1,
  created_date: "2028-03-01T10:00:00.000Z",
};

const booking = {
  id: "booking-history-4377",
  member_id: member.id,
  organization_id: organization.id,
  is_one_off_event: true,
  booking_group_reference: "booking-group-4377",
  booking_reference: "BOOK-4377",
  event_name: "Fixture Event",
  attendee_first_name: "History",
  attendee_last_name: "Fixture",
  total_cost: 25,
  created_date: "2028-04-01T10:00:00.000Z",
};

const paginationRecords = [
  ...membershipRecords,
  ...Array.from({ length: 8 }, (_, index) => {
    const year = 2018 + index;
    return {
      id: `pagination-personal-${year}-4377`,
      tenant_id: member.tenant_id,
      member_id: member.id,
      membership_source: "personal",
      membership_year: `${year}/${year + 1}`,
      tier_label: "Personal Archive",
      final_cost: 50 + index,
      total_with_vat: 60 + index,
      payment_method: "stripe",
      accounting_invoice_id: null,
      accounting_invoice_number: null,
      xero_invoice_id: null,
      xero_invoice_number: null,
      created_at: `${year}-01-15T10:00:00.000Z`,
    };
  }),
];

const pdfBody = "%PDF-1.4 history-4377 fixture";
const historicalDdPayments = [
  {
    id: "historical-dd-jan-4377",
    period: "2026-01-01",
    charge_date: "2026-01-06",
    amount_minor: 1304,
    currency: "GBP",
    provider_payment_id: "PM-HISTORY-JAN",
    provider_status: "paid_out",
    xero_invoice_id: "3e69cfdf-4d7c-4d70-9630-aa68f8c8fced",
    xero_invoice_number: "INV-HISTORY-JAN",
    invoice_available: true,
    historical_only: true,
  },
  {
    id: "historical-dd-unlinked-4377",
    period: "2025-12-01",
    charge_date: "2025-12-05",
    amount_minor: 1304,
    currency: "GBP",
    provider_payment_id: "PM-HISTORY-UNLINKED",
    provider_status: "paid_out",
    xero_invoice_id: null,
    xero_invoice_number: null,
    invoice_available: false,
    invoice_unavailable_reason: "not_linked",
    historical_only: true,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page, {
  membership,
  membershipShape = "combined",
  membershipFailures = 0,
  invoiceStatus = 200,
  invoiceFailures = invoiceStatus === 200 ? 0 : Number.POSITIVE_INFINITY,
  delayMembershipInvoice = false,
  invoiceBody = pdfBody,
  historicalInvoiceStatus = 200,
  historicalInvoiceFailures = historicalInvoiceStatus === 200 ? 0 : Number.POSITIVE_INFINITY,
  delayHistoricalInvoice = false,
  historicalPayments = historicalDdPayments,
  excludedFeatures = [],
} = {}) {
  const fixtureMember = membershipShape === "member-without-organisation"
    ? { ...member, organization_id: null }
    : member;
  const shapeMembership = membershipShape === "personal-only"
    || membershipShape === "member-without-organisation"
    ? membershipRecords.filter((record) => record.membership_source === "personal")
    : membershipShape === "organisation-only"
      ? membershipRecords.filter((record) => record.membership_source === "organisation")
      : membershipRecords;
  const fixtureMembership = membership ?? shapeMembership;
  const state = {
    membershipCalls: 0,
    invoiceRequests: [],
    membershipInvoiceDelayReleased: !delayMembershipInvoice,
    historicalInvoiceRequests: [],
    historicalInvoiceDelayReleased: !delayHistoricalInvoice,
    escapedWrites: [],
  };
  const fixtureRole = { ...role, excluded_features: excludedFeatures };

  await page.context().route("**/rest/v1/**", (route) => json(route, []));
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (!path.startsWith("/api/")) return route.continue();
    if (method === "PATCH" && path === `/api/entities/Member/${fixtureMember.id}`) {
      const body = request.postDataJSON();
      const isLayoutActivity = body
        && Object.keys(body).length === 1
        && typeof body.last_activity === "string"
        && Number.isFinite(Date.parse(body.last_activity));
      const isTourAcknowledgement = body
        && Object.keys(body).length === 1
        && body.page_tours_seen?.History === true;
      if (isLayoutActivity || isTourAcknowledgement) {
        return json(route, { ...fixtureMember, ...body });
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    if (path === "/api/auth/me") return json(route, fixtureMember);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: fixtureMember, tenant: { id: fixtureMember.tenant_id } });
    }
    if (path === `/api/entities/Member/${fixtureMember.id}`) return json(route, fixtureMember);
    if (path === "/api/entities/Member") return json(route, [fixtureMember]);
    if (path === `/api/entities/Organization/${organization.id}`) {
      return json(route, fixtureMember.organization_id ? organization : {});
    }
    if (path === "/api/entities/Organization") {
      return json(route, fixtureMember.organization_id ? [organization] : []);
    }
    if (path === `/api/entities/Role/${role.id}`) return json(route, fixtureRole);
    if (path === "/api/entities/Role") return json(route, [fixtureRole]);
    if (path === "/api/entities/Event") return json(route, []);
    if (path === "/api/entities/Booking") return json(route, [booking]);
    if (path === "/api/entities/ProgramTicketTransaction") return json(route, [programTransaction]);
    if (path === "/api/membership/member-history") {
      state.membershipCalls += 1;
      if (state.membershipCalls <= membershipFailures) {
        return json(route, { error: "Membership fixture unavailable" }, 503);
      }
      return json(route, fixtureMembership);
    }
    if (path === "/api/membership/historical-dd") {
      const invoiceAllowed = !excludedFeatures.includes("commerce.history.access-invoices")
        && !excludedFeatures.includes("commerce.history");
      return json(route, {
        payments: historicalPayments.map((payment) => invoiceAllowed ? payment : {
          ...payment,
          xero_invoice_id: null,
          xero_invoice_number: null,
          invoice_available: false,
          invoice_unavailable_reason: "permission_denied",
        }),
      });
    }
    if (path === "/api/membership/historical-dd-invoice") {
      state.historicalInvoiceRequests.push({
        recordId: url.searchParams.get("recordId"),
        inline: url.searchParams.get("inline"),
      });
      while (!state.historicalInvoiceDelayReleased) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const responseStatus = state.historicalInvoiceRequests.length <= historicalInvoiceFailures
        ? historicalInvoiceStatus
        : 200;
      return route.fulfill({
        status: responseStatus,
        contentType: responseStatus === 200 ? "application/pdf" : "application/json",
        headers: responseStatus === 200
          ? { "Content-Disposition": 'attachment; filename="historical-fixture.pdf"' }
          : {},
        body: responseStatus === 200
          ? invoiceBody
          : JSON.stringify({ error: "Historical accounting provider unavailable" }),
      });
    }
    if (path.startsWith("/api/membership-invoice/")) {
      state.invoiceRequests.push({
        path,
        source: url.searchParams.get("source"),
        inline: url.searchParams.get("inline"),
      });
      while (!state.membershipInvoiceDelayReleased) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const responseStatus = state.invoiceRequests.length <= invoiceFailures ? invoiceStatus : 200;
      return route.fulfill({
        status: responseStatus,
        contentType: responseStatus === 200 ? "application/pdf" : "application/json",
        headers: responseStatus === 200
          ? { "Content-Disposition": 'attachment; filename="../../unsafe membership.pdf"' }
          : {},
        body: responseStatus === 200
          ? invoiceBody
          : JSON.stringify({ error: "Accounting provider temporarily unavailable" }),
      });
    }

    return json(route, []);
  });

  return state;
}

test("combined personal and organisation history keeps source labels and same-year rows", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/history");

  await expect(page.getByTestId("membership-history-card-personal-personal-2026-4377")).toBeVisible();
  await expect(page.getByTestId("membership-history-card-personal-personal-2027-4377")).toBeVisible();
  await expect(page.getByTestId("membership-history-card-personal-personal-2028-4377")).toBeVisible();
  await expect(page.getByTestId("membership-history-card-organisation-organisation-2028-4377")).toBeVisible();
  await expect(page.getByText("Personal membership", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Organisation membership", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Invoice: INV-8901", { exact: true })).toBeVisible();
  await expect(page.getByText("Invoice: XERO-2028-P", { exact: true })).toBeVisible();
  await expect(page.getByText("Membership 2029/2030", { exact: true })).toBeVisible();
  await expect(page.getByTestId("membership-history-card-organisation-organisation-unlinked-4377")).toContainText(
    "Organisation membership",
  );
  await expect(page.getByTestId("membership-history-card-organisation-organisation-unlinked-4377").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("membership-invoice-unavailable-organisation-organisation-unlinked-4377"))
    .toHaveText("Invoice unavailable");
  await expect(page.getByText("Standard Ticket Purchases", { exact: false })).toBeVisible();
  await expect(page.getByText("Program Ticket Transactions", { exact: false })).toBeVisible();

  await page.getByTestId("tab-membership").click();
  await expect(page.getByTestId("membership-history-card-personal-personal-2026-4377")).toBeVisible();
  await expect(page.getByTestId("membership-history-card-organisation-organisation-2028-4377")).toBeVisible();
  const numberOnlyCard = page.getByTestId("membership-history-card-personal-personal-number-only-4377");
  await expect(numberOnlyCard).toContainText("INV-NUMBER-ONLY");
  await expect(numberOnlyCard.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("membership-invoice-unavailable-personal-personal-number-only-4377"))
    .toHaveText("Invoice unavailable");
  await page.screenshot({
    path: "/tmp/invoice-4543-browser/membership-history.jpg",
    fullPage: true,
    type: "jpeg",
    quality: 80,
  });
  expect(state.escapedWrites).toEqual([]);
});

test("historical Direct Debit records use protected invoice preview/download with cleanup and feature gating", async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__historicalCreatedUrls = [];
    window.__historicalRevokedUrls = [];
    URL.createObjectURL = (blob) => {
      const value = create(blob);
      window.__historicalCreatedUrls.push(value);
      return value;
    };
    URL.revokeObjectURL = (value) => {
      window.__historicalRevokedUrls.push(value);
      return revoke(value);
    };
  });
  const state = await installFixtures(page);
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();

  const row = page.getByTestId("row-historical-dd-historical-dd-jan-4377");
  await expect(row).toBeVisible();
  await expect(row).toContainText("January 2026");
  await expect(row).toContainText("6 Jan 2026");
  await expect(row).toContainText("£13.04");
  await expect(row).toContainText("Paid out");
  const view = page.getByTestId("button-view-historical-dd-invoice-historical-dd-jan-4377");
  const download = page.getByTestId("button-download-historical-dd-invoice-historical-dd-jan-4377");
  await expect(view).toHaveAccessibleName("View invoice INV-HISTORY-JAN");
  await expect(download).toHaveAccessibleName("Download invoice INV-HISTORY-JAN");
  await expect(page.getByTestId("historical-dd-invoice-unavailable-historical-dd-unlinked-4377"))
    .toHaveText("Invoice unavailable");
  await view.click();
  const invoiceDialog = page.getByRole("dialog", { name: "Invoice INV-HISTORY-JAN" });
  await expect(invoiceDialog).toBeVisible();
  expect(state.historicalInvoiceRequests[0]).toEqual({
    recordId: "historical-dd-jan-4377",
    inline: "true",
  });
  await invoiceDialog.getByRole("button", { name: "Close" }).click();
  await expect(invoiceDialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => ({
    created: window.__historicalCreatedUrls.length,
    revoked: window.__historicalRevokedUrls.length,
  }))).toEqual({ created: 1, revoked: 1 });
  await download.click();
  await expect.poll(() => state.historicalInvoiceRequests.length).toBe(2);
  expect(state.historicalInvoiceRequests[1]).toEqual({
    recordId: "historical-dd-jan-4377",
    inline: null,
  });
  await expect.poll(() => page.evaluate(() => ({
    created: window.__historicalCreatedUrls.length,
    revoked: window.__historicalRevokedUrls.length,
  }))).toEqual({ created: 2, revoked: 2 });
  await expect(page.getByText(/never trigger a collection, retry, refund or accounting action/).first()).toBeVisible();
  await page.screenshot({
    path: "/tmp/invoice-4543-browser/bnms-historical-dd-history.jpg",
    fullPage: true,
    type: "jpeg",
    quality: 85,
  });
  expect(state.escapedWrites).toEqual([]);

  const restricted = await page.context().newPage();
  await installFixtures(restricted, { excludedFeatures: ["commerce.history.access-invoices"] });
  await restricted.goto("/history");
  await restricted.getByTestId("tab-membership").click();
  await expect(restricted.getByTestId("row-historical-dd-historical-dd-jan-4377")).toBeVisible();
  await expect(restricted.getByTestId("button-view-historical-dd-invoice-historical-dd-jan-4377")).toHaveCount(0);
  await expect(restricted.getByTestId("button-download-historical-dd-invoice-historical-dd-jan-4377")).toHaveCount(0);
  await expect(restricted.getByTestId("historical-dd-invoice-denied-historical-dd-jan-4377"))
    .toHaveText("Invoice access denied");
  await expect(restricted.getByTestId("historical-dd-invoice-unavailable-historical-dd-jan-4377")).toHaveCount(0);
  await restricted.close();
});

test("historical Direct Debit older API shape supports protected View and Download actions", async ({ page }) => {
  const olderShapePayment = {
    id: "historical-dd-older-shape-4377",
    period: "2024-11-01",
    charge_date: "2024-11-05",
    amount_minor: 1304,
    currency: "GBP",
    provider_payment_id: "PM-HISTORY-OLDER-SHAPE",
    provider_status: "paid_out",
    xero_invoice_id: "ebb642c08-older-persisted-invoice-id",
    xero_invoice_number: "INV-HISTORY-OLDER-SHAPE",
    historical_only: true,
  };
  const state = await installFixtures(page, { historicalPayments: [olderShapePayment] });
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();

  const view = page.getByTestId(
    "button-view-historical-dd-invoice-historical-dd-older-shape-4377",
  );
  const download = page.getByTestId(
    "button-download-historical-dd-invoice-historical-dd-older-shape-4377",
  );
  await expect(view).toHaveAccessibleName("View invoice INV-HISTORY-OLDER-SHAPE");
  await expect(download).toHaveAccessibleName("Download invoice INV-HISTORY-OLDER-SHAPE");

  await view.click();
  const dialog = page.getByRole("dialog", { name: "Invoice INV-HISTORY-OLDER-SHAPE" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => state.historicalInvoiceRequests.length).toBe(1);
  expect(state.historicalInvoiceRequests[0]).toEqual({
    recordId: olderShapePayment.id,
    inline: "true",
  });
  await dialog.getByRole("button", { name: "Close" }).click();

  await download.click();
  await expect.poll(() => state.historicalInvoiceRequests.length).toBe(2);
  expect(state.historicalInvoiceRequests[1]).toEqual({
    recordId: olderShapePayment.id,
    inline: null,
  });
  expect(state.escapedWrites).toEqual([]);
});

test("historical invoice controls expose loading and endpoint errors", async ({ page }) => {
  const loadingState = await installFixtures(page, { delayHistoricalInvoice: true });
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();
  const view = page.getByTestId("button-view-historical-dd-invoice-historical-dd-jan-4377");
  await view.click();
  await expect(view).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("button-download-historical-dd-invoice-historical-dd-jan-4377")).toBeDisabled();
  loadingState.historicalInvoiceDelayReleased = true;
  await expect(page.getByRole("dialog", { name: "Invoice INV-HISTORY-JAN" })).toBeVisible();

  const errorPage = await page.context().newPage();
  const errorState = await installFixtures(errorPage, {
    historicalInvoiceStatus: 503,
    historicalInvoiceFailures: 1,
  });
  await errorPage.goto("/history");
  await errorPage.getByTestId("tab-membership").click();
  await errorPage.getByTestId("button-view-historical-dd-invoice-historical-dd-jan-4377").click();
  await expect(errorPage.getByTestId("historical-dd-invoice-error-historical-dd-jan-4377"))
    .toHaveText(/Historical accounting provider unavailable/);
  await errorPage.getByTestId("button-retry-historical-dd-invoice-historical-dd-jan-4377").click();
  await expect(errorPage.getByRole("dialog", { name: "Invoice INV-HISTORY-JAN" })).toBeVisible();
  expect(errorState.historicalInvoiceRequests).toHaveLength(2);
  await errorPage.close();
});

test("membership accounting invoice fallback is searchable and PDF preview/download sends source", async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__membershipCreatedUrls = [];
    window.__membershipRevokedUrls = [];
    URL.createObjectURL = (blob) => {
      const value = create(blob);
      window.__membershipCreatedUrls.push(value);
      return value;
    };
    URL.revokeObjectURL = (value) => {
      window.__membershipRevokedUrls.push(value);
      return revoke(value);
    };
  });
  const state = await installFixtures(page);
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();

  await page.getByTestId("input-search").fill("qbo-personal-8901");
  await expect(page.getByTestId("membership-history-card-personal-personal-2026-4377")).toBeVisible();
  await expect(page.getByTestId("membership-history-card-personal-personal-2027-4377")).toHaveCount(0);

  await page.getByTestId("input-search").fill("INV-8901");
  await expect(page.getByTestId("membership-history-card-personal-personal-2026-4377")).toBeVisible();

  await page.getByTestId("button-view-membership-invoice-personal-personal-2026-4377").click();
  const invoiceDialog = page.locator('[role="dialog"]').filter({ hasText: "Invoice" });
  await expect(invoiceDialog).toBeVisible();
  await expect.poll(() => state.invoiceRequests.length).toBe(1);
  expect(state.invoiceRequests[0]).toEqual(expect.objectContaining({
    source: "personal",
    inline: "true",
  }));

  await invoiceDialog.getByRole("button", { name: "Download" }).click();
  await invoiceDialog.getByRole("button").last().click();
  await expect(invoiceDialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => ({
    created: window.__membershipCreatedUrls.length,
    revoked: window.__membershipRevokedUrls.length,
  }))).toEqual({ created: 1, revoked: 1 });
  await page.getByTestId("input-search").fill("");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-download-membership-invoice-personal-personal-2026-4377").click();
  const membershipDownload = await downloadPromise;
  expect(membershipDownload.suggestedFilename()).toMatch(/unsafe membership\.pdf$/);
  expect(membershipDownload.suggestedFilename()).not.toMatch(/[/\\]/);
  await expect.poll(() => state.invoiceRequests.length).toBe(2);
  expect(state.invoiceRequests[1]).toEqual(expect.objectContaining({
    source: "personal",
    inline: null,
  }));

  await page.getByTestId("button-view-membership-invoice-organisation-organisation-2028-4377").click();
  await expect(invoiceDialog).toBeVisible();
  await expect.poll(() => state.invoiceRequests.length).toBe(3);
  expect(state.invoiceRequests[2]).toEqual(expect.objectContaining({
    source: "organisation",
    inline: "true",
  }));
  await invoiceDialog.getByRole("button").last().click();
  await expect.poll(() => page.evaluate(() =>
    window.__membershipRevokedUrls.length)).toBe(3);
  const organisationDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("button-download-membership-invoice-organisation-organisation-2028-4377").click();
  const organisationDownload = await organisationDownloadPromise;
  expect(organisationDownload.suggestedFilename()).toMatch(/unsafe membership\.pdf$/);
  expect(organisationDownload.suggestedFilename()).not.toMatch(/[/\\]/);
  expect(state.invoiceRequests[3]).toEqual(expect.objectContaining({
    source: "organisation",
    inline: null,
  }));
  await expect.poll(() => page.evaluate(() =>
    window.__membershipRevokedUrls.length)).toBe(4);
  expect(state.escapedWrites).toEqual([]);
});

test("membership provider failure is actionable and retry preserves personal source", async ({ page }) => {
  const state = await installFixtures(page, {
    invoiceStatus: 503,
    invoiceFailures: 1,
  });
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();

  await page.getByTestId("button-view-membership-invoice-personal-personal-2026-4377").click();
  const error = page.getByTestId("membership-invoice-error-personal-personal-2026-4377");
  await expect(error).toHaveText(/Accounting provider temporarily unavailable/);
  await page.getByTestId("button-retry-membership-invoice-personal-personal-2026-4377").click();
  await expect(page.locator('[role="dialog"]').filter({ hasText: "Invoice INV-8901" })).toBeVisible();
  expect(state.invoiceRequests).toHaveLength(2);
  expect(state.invoiceRequests.every((request) => request.source === "personal")).toBe(true);
});

test("membership invoice loading is source-scoped and pending previews abort on unmount", async ({ page }) => {
  let createdMembershipPdfUrls = 0;
  await page.exposeFunction("recordMembershipObjectUrl", (type) => {
    if (type === "application/pdf") createdMembershipPdfUrls += 1;
  });
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.recordMembershipObjectUrl(blob?.type || "");
      return create(blob);
    };
  });
  const duplicateId = "shared-ledger-record-4377";
  const state = await installFixtures(page, {
    delayMembershipInvoice: true,
    membership: [
      { ...membershipRecords[0], id: duplicateId },
      { ...membershipRecords[3], id: duplicateId },
    ],
  });
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();

  const personalView = page.getByTestId(`button-view-membership-invoice-personal-${duplicateId}`);
  const organisationView = page.getByTestId(`button-view-membership-invoice-organisation-${duplicateId}`);
  await personalView.click();
  await expect(personalView).toBeDisabled();
  await expect(organisationView).toBeEnabled();
  await expect.poll(() => state.invoiceRequests.length).toBe(1);
  expect(state.invoiceRequests[0]).toEqual(expect.objectContaining({ source: "personal" }));

  const navigation = page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  state.membershipInvoiceDelayReleased = true;
  await navigation;
  await page.waitForTimeout(100);
  expect(createdMembershipPdfUrls).toBe(0);
});

test("QBO-linked records remain visible without invoice controls when permission is denied", async ({ page }) => {
  const state = await installFixtures(page, {
    excludedFeatures: ["commerce.history.access-invoices"],
  });
  await page.goto("/history");

  const card = page.getByTestId("membership-history-card-personal-personal-2026-4377");
  await expect(card).toBeVisible();
  await expect(card).toContainText("INV-8901");
  await expect(card.getByRole("button", { name: "View Invoice" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Download" })).toHaveCount(0);
  await expect(page.getByTestId("membership-invoice-unavailable-personal-personal-2026-4377")).toHaveCount(0);
  expect(state.invoiceRequests).toEqual([]);
  expect(state.escapedWrites).toEqual([]);
});

test("membership history failure is explicit in overview and Membership tab and can retry", async ({ page }) => {
  const state = await installFixtures(page, { membershipFailures: 1 });
  await page.goto("/history");

  await expect(page.getByTestId("membership-history-error-overview")).toBeVisible();
  await expect(page.getByText("No transactions yet", { exact: true })).toHaveCount(0);
  await page.getByTestId("tab-membership").click();
  await expect(page.getByTestId("membership-history-error-tab")).toBeVisible();
  await page.getByTestId("tab-all").click();
  await page.getByTestId("button-retry-membership-history-overview").click();
  await expect(page.getByTestId("membership-history-card-personal-personal-2026-4377")).toBeVisible();

  await page.getByTestId("tab-membership").click();
  await expect(page.getByTestId("membership-history-error-tab")).toHaveCount(0);
  await expect(page.getByTestId("membership-history-card-organisation-organisation-2028-4377")).toBeVisible();
  expect(state.membershipCalls).toBeGreaterThanOrEqual(2);
  expect(state.escapedWrites).toEqual([]);
});

test("Membership tab keeps pagination and sort controls for combined history", async ({ page }) => {
  const state = await installFixtures(page, { membership: paginationRecords });
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();

  await expect(page.getByTestId("button-next-page")).toBeVisible();
  await expect(page.getByTestId("membership-history-card-personal-pagination-personal-2018-4377")).toHaveCount(0);
  await page.getByTestId("button-next-page").click();
  await expect(page.getByTestId("membership-history-card-personal-pagination-personal-2018-4377")).toBeVisible();

  await page.getByTestId("select-sort-order").click();
  await page.getByRole("option", { name: "Oldest First", exact: true }).click();
  await expect(page.getByTestId("button-prev-page")).toBeDisabled();
  await expect(page.getByTestId("membership-history-card-personal-pagination-personal-2018-4377")).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
});

test("malformed membership history response is an explicit load failure", async ({ page }) => {
  const state = await installFixtures(page, { membership: { records: [] } });
  await page.goto("/history");

  await expect(page.getByTestId("membership-history-error-overview")).toBeVisible();
  await expect(page.getByText("No transactions yet", { exact: true })).toHaveCount(0);
  expect(state.escapedWrites).toEqual([]);
});

const historyShapeMatrix = [
  {
    shape: "personal-only",
    card: "membership-history-card-personal-personal-2026-4377",
  },
  {
    shape: "organisation-only",
    card: "membership-history-card-organisation-organisation-2028-4377",
  },
  {
    shape: "member-without-organisation",
    card: "membership-history-card-personal-personal-2026-4377",
  },
];

for (const { shape, card } of historyShapeMatrix) {
  test(`history fixture supports ${shape} membership shape in overview and tab`, async ({ page }) => {
    const state = await installFixtures(page, { membershipShape: shape });
    await page.goto("/history");

    await expect(page.getByText("View your transaction and membership history", { exact: true })).toBeVisible();
    await expect(page.getByTestId(card)).toBeVisible();
    await page.getByTestId("tab-membership").click();
    await expect(page.getByTestId(card)).toBeVisible();

    if (shape === "personal-only") {
      const invoiceDialog = page.locator('[role="dialog"]').filter({ hasText: "Invoice" });
      await page.getByTestId("button-view-membership-invoice-personal-personal-2026-4377").click();
      await expect(invoiceDialog).toBeVisible();
      await expect.poll(() => state.invoiceRequests.length).toBe(1);
      expect(state.invoiceRequests[0]).toEqual(expect.objectContaining({
        source: "personal",
        inline: "true",
      }));

      await invoiceDialog.getByRole("button", { name: "Download" }).click();
      await invoiceDialog.getByRole("button").last().click();
      await expect(invoiceDialog).toBeHidden();
      await page.getByTestId("button-download-membership-invoice-personal-personal-2026-4377").click();
      await expect.poll(() => state.invoiceRequests.length).toBe(2);
      expect(state.invoiceRequests[1]).toEqual(expect.objectContaining({
        source: "personal",
        inline: null,
      }));
    }

    expect(state.escapedWrites).toEqual([]);
  });
}
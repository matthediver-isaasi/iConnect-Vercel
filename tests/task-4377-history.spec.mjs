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
  invoiceBody = pdfBody,
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
    if (path.startsWith("/api/membership-invoice/")) {
      state.invoiceRequests.push({
        path,
        source: url.searchParams.get("source"),
        inline: url.searchParams.get("inline"),
      });
      return route.fulfill({
        status: invoiceStatus,
        contentType: invoiceStatus === 200 ? "application/pdf" : "application/json",
        body: invoiceStatus === 200 ? invoiceBody : JSON.stringify({ error: "Invoice permission denied" }),
      });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });

  return state;
}

test("combined personal and organisation history keeps source labels and same-year rows", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/History");

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
  await expect(page.getByText("Standard Ticket Purchases", { exact: false })).toBeVisible();
  await expect(page.getByText("Program Ticket Transactions", { exact: false })).toBeVisible();

  await page.getByTestId("tab-membership").click();
  await expect(page.getByTestId("membership-history-card-personal-personal-2026-4377")).toBeVisible();
  await expect(page.getByTestId("membership-history-card-organisation-organisation-2028-4377")).toBeVisible();
  const numberOnlyCard = page.getByTestId("membership-history-card-personal-personal-number-only-4377");
  await expect(numberOnlyCard).toContainText("INV-NUMBER-ONLY");
  await expect(numberOnlyCard.getByRole("button")).toHaveCount(0);
  await page.screenshot({
    path: "screenshots/membership-history.jpg",
    fullPage: true,
    type: "jpeg",
    quality: 80,
  });
  expect(state.escapedWrites).toEqual([]);
});

test("membership accounting invoice fallback is searchable and PDF preview/download sends source", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/History");
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
  await page.getByTestId("input-search").fill("");
  await page.getByTestId("button-download-membership-invoice-personal-personal-2026-4377").click();
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
  expect(state.escapedWrites).toEqual([]);
});

test("QBO-linked records remain visible without invoice controls when permission is denied", async ({ page }) => {
  const state = await installFixtures(page, {
    excludedFeatures: ["commerce.history.access-invoices"],
  });
  await page.goto("/History");

  const card = page.getByTestId("membership-history-card-personal-personal-2026-4377");
  await expect(card).toBeVisible();
  await expect(card).toContainText("INV-8901");
  await expect(card.getByRole("button", { name: "View Invoice" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Download" })).toHaveCount(0);
  expect(state.invoiceRequests).toEqual([]);
  expect(state.escapedWrites).toEqual([]);
});

test("membership history failure is explicit in overview and Membership tab and can retry", async ({ page }) => {
  const state = await installFixtures(page, { membershipFailures: 1 });
  await page.goto("/History");

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
  await page.goto("/History");
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
  await page.goto("/History");

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
    await page.goto("/History");

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
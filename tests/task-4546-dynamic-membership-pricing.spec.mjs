import { test, expect } from "@playwright/test";

const MEMBER_ID = "dynamic-pricing-member-4546";
const member = {
  id: MEMBER_ID,
  tenant_id: "dynamic-pricing-tenant-4546",
  organization_id: "dynamic-pricing-org-4546",
  role_id: "dynamic-pricing-role-4546",
  email: "dynamic-pricing@example.invalid",
  first_name: "Dynamic",
  last_name: "Pricing",
  status: "active",
  member_excluded_features: [],
  page_tours_seen: { History: true },
};
const organization = {
  id: member.organization_id,
  tenant_id: member.tenant_id,
  name: "Dynamic Pricing Organisation",
};
const role = {
  id: member.role_id,
  name: "Administrator",
  excluded_features: [],
};

const dynamicSnapshot = {
  version: 1,
  start_mode: "immediate",
  payment_method: "gocardless",
  payment_frequency: "monthly",
  collection_policy: {
    version: 1,
    end_policy: "continue",
    pricing_policy: "dynamic",
  },
  amounts: {
    annual_cost: null,
    final_cost: null,
    vat_amount: null,
    total_with_vat: null,
    currency: "GBP",
  },
};

const record = (id, overrides = {}) => ({
  id,
  tenant_id: member.tenant_id,
  member_id: member.id,
  membership_source: "personal",
  membership_year: `rolling:2026-09-${id === "calculated" ? "01" : "02"}`,
  term_key: `rolling:2026-09-${id === "calculated" ? "01" : "02"}`,
  term_start_date: "2026-09-01",
  term_end_date: "2027-08-31",
  membership_renewal_date: "2027-09-01",
  term_duration_months: 12,
  tier_label: `Pricing ${id}`,
  annual_cost: null,
  final_cost: null,
  vat_amount: null,
  total_with_vat: null,
  currency: "GBP",
  payment_method: "direct_debit",
  payment_status: "unpaid",
  status: "active",
  commitment_snapshot: structuredClone(dynamicSnapshot),
  created_at: "2026-09-19T12:00:00.000Z",
  ...overrides,
});

const history = [
  record("calculated", {
    monthly_price: {
      state: "calculated",
      amount: 13,
      currency: "GBP",
      date: "2026-10-01",
    },
    accounting_invoice_id: "invoice-calculated-4546",
    accounting_invoice_number: "INV-CALCULATED-4546",
  }),
  record("scheduled", {
    monthly_price: {
      state: "provider_scheduled",
      amount: 13,
      currency: "GBP",
      date: "2026-09-24",
    },
  }),
  record("unavailable", {
    monthly_price: {
      state: "unavailable",
      amount: null,
      currency: "GBP",
      date: null,
    },
  }),
  record("genuine-zero", {
    membership_year: "2025/2026",
    term_key: "fixed:2025-09-01",
    annual_cost: 0,
    final_cost: 0,
    vat_amount: 0,
    total_with_vat: 0,
    payment_method: "invoice",
    payment_status: "paid",
    status: "expired",
    commitment_snapshot: {
      payment_method: "invoice",
      payment_frequency: "upfront",
      amounts: {
        annual_cost: 0,
        final_cost: 0,
        vat_amount: 0,
        total_with_vat: 0,
        currency: "GBP",
      },
    },
  }),
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function memberMembershipFixture() {
  return {
    member: {
      id: member.id,
      name: `${member.first_name} ${member.last_name}`,
      email: member.email,
    },
    config: null,
    currentYearCost: null,
    nextYearPreview: null,
    history,
    commitments: [],
    currentCommitments: [],
    pricingCapability: { mode: "history_only", status: "pricing_unavailable" },
    pause: { paused: false },
  };
}

async function installFixtures(page) {
  const state = {
    escapedWrites: [],
    providerRequests: [],
  };

  await page.context().route(/\/(?:rest|auth)\/v1\//, route => {
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
      return json(route, { error: "Fixture rejected database or auth mutation" }, 599);
    }
    return json(route, []);
  });
  await page.context().route(/^https?:\/\/[^/]*(?:stripe|gocardless)\./i, route => {
    state.providerRequests.push(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (!path.startsWith("/api/")) return route.continue();
    if (method === "PATCH" && path === `/api/entities/Member/${MEMBER_ID}`) {
      const body = request.postDataJSON();
      if (body && Object.keys(body).length === 1
          && typeof body.last_activity === "string") {
        return json(route, { ...member, ...body });
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: "Fixture rejected API mutation" }, 599);
    }

    if (path === "/api/auth/me") return json(route, member);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: member, tenant: { id: member.tenant_id, slug: "dynamic-pricing" } });
    }
    if (path === `/api/entities/Member/${MEMBER_ID}`) return json(route, member);
    if (path === "/api/entities/Member") return json(route, [member]);
    if (path === `/api/entities/Organization/${organization.id}`) return json(route, organization);
    if (path === "/api/entities/Organization") return json(route, [organization]);
    if (path === `/api/entities/Role/${role.id}`) return json(route, role);
    if (path === "/api/entities/Role") return json(route, [role]);
    if (path === "/api/membership/member-history") return json(route, history);
    if (path === "/api/membership/member-membership") return json(route, memberMembershipFixture());
    if (path === "/api/membership/historical-dd") return json(route, { payments: [] });
    if (path === "/api/membership/membership-settings") return json(route, { require_approval: false });
    if (path === "/api/membership/member-membership-invoicing") return json(route, { settings: {} });
    if (path === "/api/membership/member-membership-configs") return json(route, []);
    if (path === "/api/membership/member-membership-override") return json(route, null);
    return json(route, []);
  });

  return state;
}

async function assertPriceStates(root) {
  const calculated = root.getByTestId("membership-monthly-price-calculated");
  await expect(calculated).toContainText("Variable estimate for 1 Oct 2026 (not confirmed)");
  await expect(calculated).toContainText("£13.00");

  const scheduled = root.getByTestId("membership-monthly-price-scheduled");
  await expect(scheduled).toContainText("Scheduled collection for 24 Sept 2026");
  await expect(scheduled).toContainText("£13.00");
  await expect(scheduled).not.toContainText("estimate");

  await expect(root.getByTestId("membership-monthly-price-unavailable"))
    .toHaveText("Variable monthly price unavailable");
}

test("member History distinguishes variable estimates, provider schedules, unavailable lookups and zero", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/history");
  await page.getByTestId("tab-membership").click();

  await assertPriceStates(page);
  const calculated = page.getByTestId("membership-history-card-personal-calculated");
  await expect(calculated).toContainText("Net: Uncommitted");
  await expect(calculated).not.toContainText("Net: £0.00");
  await expect(calculated).toContainText("Invoice: INV-CALCULATED-4546");
  await expect(page.getByTestId("button-view-membership-invoice-personal-calculated")).toBeVisible();
  await expect(page.getByTestId("button-download-membership-invoice-personal-calculated")).toBeVisible();

  const zero = page.getByTestId("membership-history-card-personal-genuine-zero");
  await expect(zero).toContainText("Net: £0.00");
  await expect(zero).not.toContainText("Uncommitted");
  await page.screenshot({
    path: "/tmp/task-4546-dynamic-membership-pricing/history-pricing-states.jpg",
    fullPage: true,
    type: "jpeg",
    quality: 85,
  });
  expect(state.escapedWrites).toEqual([]);
  expect(state.providerRequests.every(url => url.startsWith("https://js.stripe.com/"))).toBe(true);
});

test("Member Detail fee history keeps dynamic totals uncommitted, unpaid status and invoice actions", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto(`/members/${MEMBER_ID}?tab=membership`);
  await expect(page.getByTestId("tab-member-membership")).toHaveAttribute("data-state", "active");

  await assertPriceStates(page);
  const calculated = page.getByTestId("row-member-history-calculated");
  await expect(calculated).toContainText("Uncommitted");
  await expect(calculated).not.toContainText("£0.00");
  await expect(calculated).toContainText("Unpaid");
  await expect(page.getByTestId("button-view-invoice-calculated")).toBeVisible();
  await expect(page.getByTestId("button-download-invoice-calculated")).toBeVisible();

  const zero = page.getByTestId("row-member-history-genuine-zero");
  await expect(zero).toContainText("£0.00");
  await expect(zero).not.toContainText("Uncommitted");
  expect(state.escapedWrites).toEqual([]);
  expect(state.providerRequests.every(url => url.startsWith("https://js.stripe.com/"))).toBe(true);
});
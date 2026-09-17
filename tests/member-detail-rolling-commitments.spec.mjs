import { test, expect } from "@playwright/test";

const MEMBER_ID = "rolling-member-fixture";
const member = {
  id: MEMBER_ID,
  tenant_id: "rolling-tenant-fixture",
  organization_id: "rolling-org-fixture",
  role_id: "rolling-admin-role",
  email: "rolling.member@example.invalid",
  first_name: "Rolling",
  last_name: "Member",
  member_excluded_features: [],
  status: "active",
};
const role = {
  id: member.role_id,
  name: "Administrator",
  excluded_features: [],
};
const organization = {
  id: member.organization_id,
  tenant_id: member.tenant_id,
  name: "Rolling Organisation",
};

const snapshot = (overrides = {}) => ({
  version: 1,
  start_mode: "immediate",
  config_id: "structure-2026",
  billing_period: "annual",
  config: { id: "structure-2026", name: "2026 Professional" },
  pricing: { tier_label: "Professional" },
  payment_method: "stripe_monthly_card",
  payment_frequency: "monthly",
  amounts: {
    annual_cost: 240,
    final_cost: 240,
    vat_amount: 48,
    total_with_vat: 288,
    monthly_amount: 24,
    currency: "GBP",
  },
  ...overrides,
});

const history = [{
  id: "personal-current",
  membership_source: "personal",
  membership_year: "rolling:2026-09-15",
  term_key: "rolling:2026-09-15",
  term_start_date: "2026-09-15",
  term_end_date: "2027-09-14",
  membership_renewal_date: "2027-09-15",
  term_duration_months: 12,
  config_id: "structure-2026",
  tier_label: "Professional",
  final_cost: 240,
  total_with_vat: 288,
  annual_cost: 240,
  currency: "GBP",
  payment_method: "stripe_monthly_card",
  payment_status: "partial",
  status: "active",
  commitment_snapshot: snapshot(),
}, {
  id: "personal-scheduled",
  membership_source: "personal",
  membership_year: "rolling:2027-09-15",
  term_key: "rolling:2027-09-15",
  term_start_date: "2027-09-15",
  term_end_date: "2028-09-14",
  membership_renewal_date: "2028-09-15",
  term_duration_months: 12,
  config_id: "structure-2027",
  tier_label: "Professional Plus",
  final_cost: 300,
  total_with_vat: 360,
  annual_cost: 300,
  currency: "GBP",
  payment_method: "invoice",
  payment_status: "paid",
  status: "scheduled",
  commitment_snapshot: snapshot({
    config_id: "structure-2027",
    config: { id: "structure-2027", name: "2027 Professional" },
    payment_method: "invoice",
    payment_frequency: "upfront",
    amounts: {
      annual_cost: 300, final_cost: 300, vat_amount: 60,
      total_with_vat: 360, currency: "GBP",
    },
  }),
}, {
  id: "organisation-current",
  membership_source: "organisation",
  membership_year: "rolling:2026-11-01",
  term_key: "rolling:2026-11-01",
  term_start_date: "2026-11-01",
  term_end_date: "2027-10-31",
  membership_renewal_date: "2027-11-01",
  term_duration_months: 12,
  config_id: "org-structure-2026",
  tier_label: "Organisation Gold",
  final_cost: 600,
  total_with_vat: 720,
  annual_cost: 600,
  currency: "GBP",
  payment_method: "gocardless",
  payment_status: "partial",
  status: "active",
  commitment_snapshot: snapshot({
    config_id: "org-structure-2026",
    config: { id: "org-structure-2026", name: "Organisation Gold 2026" },
    payment_method: "gocardless",
    amounts: {
      annual_cost: 600, final_cost: 600, vat_amount: 120,
      total_with_vat: 720, monthly_amount: 60, currency: "GBP",
    },
  }),
}, {
  id: "personal-past",
  membership_source: "personal",
  membership_year: "rolling:2025-09-15",
  term_key: "rolling:2025-09-15",
  term_start_date: "2025-09-15",
  term_end_date: "2026-09-14",
  membership_renewal_date: "2026-09-15",
  term_duration_months: 12,
  tier_label: "Professional Legacy",
  annual_cost: 180,
  final_cost: 180,
  total_with_vat: 216,
  currency: "GBP",
  payment_method: "stripe",
  payment_status: "paid",
  status: "expired",
  commitment_snapshot: snapshot({
    config: { id: "structure-2025", name: "2025 Professional" },
    amounts: {
      annual_cost: 180, final_cost: 180, vat_amount: 36,
      total_with_vat: 216, currency: "GBP",
    },
    payment_method: "stripe",
    payment_frequency: "upfront",
  }),
}, {
  id: "personal-legacy-unknown",
  membership_source: "personal",
  membership_year: "2024/2025",
  tier_label: "Legacy",
  annual_cost: 150,
  final_cost: 150,
  currency: "GBP",
  payment_method: "invoice",
  payment_status: "paid",
  status: "expired",
}];

const commitments = [{
  id: "personal-current",
  source: "personal",
  lifecycle: "current",
  termKey: "rolling:2026-09-15",
  startDate: "2026-09-15",
  endDate: "2027-09-14",
  renewalDate: "2027-09-15",
  durationMonths: 12,
  structureId: "structure-2026",
  structureName: "2026 Professional",
  tierLabel: "Professional",
  billingPeriod: "annual",
  agreedPrice: 288,
  monthlyAmount: 24,
  currency: "GBP",
  paymentFrequency: "monthly",
  paymentMethod: "stripe_monthly_card",
}, {
  id: "personal-scheduled",
  source: "personal",
  lifecycle: "scheduled",
  termKey: "rolling:2027-09-15",
  startDate: "2027-09-15",
  endDate: "2028-09-14",
  renewalDate: "2028-09-15",
  durationMonths: 12,
  structureName: "2027 Professional",
  tierLabel: "Professional Plus",
  billingPeriod: "annual",
  agreedPrice: 360,
  currency: "GBP",
  paymentFrequency: "upfront",
  paymentMethod: "invoice",
}, {
  id: "organisation-current",
  source: "organisation",
  lifecycle: "current",
  termKey: "rolling:2026-11-01",
  startDate: "2026-11-01",
  endDate: "2027-10-31",
  renewalDate: "2027-11-01",
  durationMonths: 12,
  structureName: "Organisation Gold 2026",
  tierLabel: "Organisation Gold",
  billingPeriod: "annual",
  agreedPrice: 720,
  monthlyAmount: 60,
  currency: "GBP",
  paymentFrequency: "monthly",
  paymentMethod: "gocardless",
}];

function membershipFixture() {
  return {
    member: {
      id: member.id,
      name: `${member.first_name} ${member.last_name}`,
      email: member.email,
    },
    // Deliberately newer live pricing. A bought current term must not be
    // substituted with this estimate in the current commitment presentation.
    config: {
      id: "structure-2027-live",
      name: "Live £25 structure",
      currency: "GBP",
      billing_period: "annual",
      source: "live",
    },
    currentYearCost: {
      membershipYear: "rolling:2026-09-15",
      tierLabel: "Professional",
      annualCost: 240,
      finalCost: 240,
      currency: "GBP",
      recordedFromHistory: true,
    },
    nextYearPreview: null,
    history,
    commitments: [...commitments, {
      id: "personal-past",
      source: "personal",
      lifecycle: "past",
      startDate: "2025-09-15",
      endDate: "2026-09-14",
      renewalDate: "2026-09-15",
      durationMonths: 12,
    }],
    currentCommitments: commitments,
    pricingCapability: { mode: "live", status: "matched" },
    pause: { paused: false },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page, { membershipStatus = 200 } = {}) {
  const state = { writes: [], providerRequests: [], membershipRequests: 0 };
  await page.context().route(/\/(?:rest|auth)\/v1\//, async (route) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      state.writes.push(`${route.request().method()} ${route.request().url()}`);
      return json(route, { error: "Fixture rejected data mutation" }, 599);
    }
    return json(route, []);
  });
  await page.context().route(/^https?:\/\/[^/]*(?:stripe|gocardless)\./i, (route) => {
    state.providerRequests.push(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") return json(route, member);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: member, tenant: { id: member.tenant_id, slug: "rolling-fixture" } });
    }
    if (path === `/api/entities/Member/${MEMBER_ID}`) return json(route, member);
    if (path === "/api/entities/Member") return json(route, [member]);
    if (path === `/api/entities/Role/${role.id}`) return json(route, role);
    if (path === "/api/entities/Role") return json(route, [role]);
    if (path === `/api/entities/Organization/${organization.id}`) return json(route, organization);
    if (path === "/api/entities/Organization") return json(route, [organization]);
    if (path === "/api/entities/SystemSettings") return json(route, []);
    if (path === "/api/membership/member-membership") {
      state.membershipRequests += 1;
      return membershipStatus === 200
        ? json(route, membershipFixture())
        : json(route, { error: "Membership commitment access denied" }, membershipStatus);
    }
    if (path === "/api/membership/membership-settings") return json(route, { require_approval: false });
    if (path === "/api/membership/member-membership-invoicing") return json(route, { settings: {} });
    if (path === "/api/membership/member-membership-configs") return json(route, []);
    if (path === "/api/membership/member-membership-override") return json(route, null);

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(`${method} ${path}`);
      return json(route, { error: "Fixture rejected API mutation" }, 599);
    }
    return json(route, []);
  });
  return state;
}

async function openMembership(page) {
  await page.goto(`/members/${MEMBER_ID}?tab=membership`);
  await expect(page.getByTestId("tab-member-membership")).toBeVisible();
  await expect(page.getByTestId("tab-member-membership")).toHaveAttribute("data-state", "active");
}

test("Member Detail renders persisted current, scheduled, past, personal and inherited commitments", async ({ page }) => {
  const state = await installFixtures(page);
  await openMembership(page);

  const current = page.getByTestId("card-member-commitment-personal-current");
  await expect(current).toContainText("Current Membership Commitment");
  await expect(current).toContainText("Personal membership");
  await expect(current).toContainText("15 Sept 2026");
  await expect(current).toContainText("15 Sept 2027");
  await expect(current).toContainText("Annual (12 months)");
  await expect(current).toContainText("2026 Professional");
  await expect(current).toContainText("£288.00");
  await expect(current).toContainText("Monthly (£24.00 per collection)");
  await expect(current).toContainText("Stripe");

  const scheduled = page.getByTestId("card-member-commitment-personal-scheduled");
  await expect(scheduled).toContainText("Scheduled Membership Commitment");
  await expect(scheduled).toContainText("15 Sept 2028");
  await expect(scheduled).toContainText("£360.00");

  const inherited = page.getByTestId("card-member-commitment-organisation-current");
  await expect(inherited).toContainText("Inherited from organisation");
  await expect(inherited).toContainText("Organisation Gold 2026");
  await expect(inherited).toContainText("GoCardless");

  // Past terms belong in fee history, not among current/scheduled cards.
  await expect(page.getByTestId("card-member-commitment-personal-past")).toHaveCount(0);
  const past = page.getByTestId("row-member-history-personal-past");
  await expect(past).toContainText("15 Sept 2025 – 14 Sept 2026");
  await expect(past).toContainText("Renewal: 15 Sept 2026");
  await expect(past).toContainText("2025 Professional");

  const legacy = page.getByTestId("row-member-history-personal-legacy-unknown");
  await expect(legacy).toContainText("Legacy record · commitment dates unknown");
  await expect(legacy).toContainText("Structure unknown");

  // The mocked live £25/new structure must not replace the purchased term.
  await expect(page.getByText("Live £25 structure", { exact: true })).toHaveCount(0);
  await expect(page.getByText("rolling:2026-09-15", { exact: true })).toHaveCount(0);
  expect(state.membershipRequests).toBeGreaterThan(0);
  expect(state.writes).toEqual([]);
  // The application shell eagerly asks for Stripe.js. The fixture intercepts
  // it inertly; Member Detail must never start checkout or contact GoCardless.
  expect(state.providerRequests.every((url) => url.startsWith("https://js.stripe.com/"))).toBe(true);

  const declineCookies = page.getByRole("button", { name: "Decline" });
  if (await declineCookies.isVisible()) await declineCookies.click();
  await page.screenshot({
    path: "screenshots/member-detail-rolling-commitments.jpg",
    fullPage: true,
    type: "jpeg",
    quality: 85,
  });
});

test("Member Detail fails closed when the authorized commitment read is denied", async ({ page }) => {
  const state = await installFixtures(page, { membershipStatus: 403 });
  await openMembership(page);

  await expect(page.getByTestId("text-member-membership-error")).toHaveText("Failed to load membership data");
  await expect(page.getByTestId("card-member-commitment-personal-current")).toHaveCount(0);
  await expect(page.getByText("2026 Professional", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Organisation Gold 2026", { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.providerRequests.every((url) => url.startsWith("https://js.stripe.com/"))).toBe(true);
});
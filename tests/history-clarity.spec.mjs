import { test, expect } from "@playwright/test";

const member = {
  id: "history-clarity-member",
  tenant_id: "history-clarity-tenant",
  organization_id: "history-clarity-org",
  role_id: "history-clarity-role",
  email: "history-clarity@example.invalid",
  first_name: "Clarity",
  last_name: "Fixture",
  member_excluded_features: [],
  page_tours_seen: { History: true },
};

const organization = {
  id: member.organization_id,
  tenant_id: member.tenant_id,
  name: "History Clarity Organisation",
};

const membershipBase = {
  tenant_id: member.tenant_id,
  member_id: member.id,
  membership_source: "personal",
  tier_label: "Clarity Membership",
  final_cost: 120,
  total_with_vat: 144,
  created_at: "2026-02-01T10:00:00.000Z",
};

const schedules = [
  {
    ...membershipBase,
    id: "stripe-upfront",
    membership_year: "rolling:2026-02-01",
    payment_method: "stripe",
    billing_period: "annual",
    term_key: "rolling:stripe-upfront",
    term_start_date: "2026-02-01",
    term_end_date: "2027-01-31",
    membership_renewal_date: "2027-02-01",
    term_duration_months: 12,
    commitment_snapshot: { payment_method: "stripe", payment_frequency: "upfront" },
  },
  {
    ...membershipBase,
    id: "stripe-monthly",
    membership_year: "rolling:2026-03-15",
    payment_method: "stripe",
    billing_period: "monthly",
    term_key: "rolling:stripe-monthly",
    term_start_date: "2026-03-15",
    term_end_date: "2027-03-14",
    membership_renewal_date: "2027-03-15",
    term_duration_months: 12,
    commitment_snapshot: { payment_method: "stripe", payment_frequency: "monthly" },
  },
  {
    ...membershipBase,
    id: "gc-active",
    membership_year: "rolling:2026-04-01",
    payment_method: "gocardless",
    status: "active",
    term_key: "rolling:gc-active",
    term_start_date: "2026-04-01",
    commitment_snapshot: { payment_method: "gocardless", payment_frequency: "monthly" },
  },
  ...["historical", "cancelled", "paused", "scheduled"].map((status, index) => ({
    ...membershipBase,
    id: `gc-${status}`,
    membership_year: `rolling:202${index + 1}-05-01`,
    payment_method: "direct_debit",
    status,
    term_key: `rolling:gc-${status}`,
    term_start_date: `202${index + 1}-05-01`,
    commitment_snapshot: { payment_method: "gocardless", payment_frequency: "monthly" },
  })),
  {
    ...membershipBase,
    id: "snapshot-only",
    membership_year: "rolling:snapshot",
    payment_method: "stripe",
    commitment_snapshot: {
      payment_method: "stripe",
      payment_frequency: "upfront",
      term_key: "rolling:snapshot-only",
      term_start_date: "2025-06-10",
      term_end_date: "2026-06-09",
      membership_renewal_date: "2026-06-10",
      term_duration_months: 12,
    },
  },
  {
    ...membershipBase,
    id: "invalid-dates",
    membership_year: "rolling:not-a-date",
    payment_method: "stripe",
    term_key: "rolling:invalid",
    term_start_date: "not-a-date",
    term_end_date: "also-not-a-date",
    membership_renewal_date: "invalid",
  },
  {
    ...membershipBase,
    id: "end-only",
    membership_year: "rolling:legacy",
    payment_method: "stripe",
    term_key: "rolling:end-only",
    term_end_date: "2024-08-31",
  },
  {
    ...membershipBase,
    id: "regular-year",
    membership_year: "2024/2025",
    payment_method: "invoice",
  },
];

const bookings = [
  {
    id: "booking-a",
    member_id: member.id,
    organization_id: organization.id,
    is_one_off_event: true,
    booking_group_reference: "GROUP-ONE",
    event_name: "Grouped Conference",
    attendee_first_name: "Ada",
    attendee_last_name: "One",
    total_cost: 30,
    created_date: "2026-07-01T10:00:00.000Z",
  },
  {
    id: "booking-b",
    member_id: member.id,
    organization_id: organization.id,
    is_one_off_event: true,
    booking_group_reference: "GROUP-ONE",
    event_name: "Grouped Conference",
    attendee_first_name: "Ben",
    attendee_last_name: "Two",
    total_cost: 45,
    created_date: "2026-07-01T10:00:00.000Z",
  },
  {
    id: "booking-c",
    member_id: member.id,
    organization_id: organization.id,
    is_one_off_event: true,
    booking_reference: "SINGLE-BOOKING",
    event_name: "Single Workshop",
    attendee_first_name: "Cara",
    attendee_last_name: "Three",
    total_cost: 20,
    created_date: "2026-06-01T10:00:00.000Z",
  },
];

const programs = [
  {
    id: "program-purchase",
    organization_id: organization.id,
    transaction_type: "purchase",
    program_name: "Leadership Programme",
    quantity: 4,
    created_date: "2026-07-02T10:00:00.000Z",
  },
  {
    id: "program-usage",
    organization_id: organization.id,
    transaction_type: "usage",
    program_name: "Leadership Programme",
    event_name: "Leadership Day",
    booking_reference: "LEAD-USE",
    quantity: 1,
    created_date: "2026-07-03T10:00:00.000Z",
  },
];

const trainingPurchases = [{
  id: "training-purchase",
  organization_id: organization.id,
  transaction_id: "training-ledger-credit",
  amount: 40,
  status: "paid",
  payment_method: "stripe",
  created_date: "2026-07-04T10:00:00.000Z",
}];

const trainingLedger = [
  {
    id: "training-ledger-credit",
    organization_id: organization.id,
    type: "credit",
    amount: 40,
    reason: "Duplicate purchase ledger row",
    balance_before: 0,
    balance_after: 40,
    created_at: "2026-07-04T10:00:00.000Z",
  },
  {
    id: "training-ledger-usage",
    organization_id: organization.id,
    type: "booking_usage",
    amount: 12,
    event_title: "Funded Workshop",
    booking_reference: "FUND-USE",
    balance_before: 40,
    balance_after: 28,
    created_at: "2026-07-05T10:00:00.000Z",
  },
];

const vouchers = [{
  id: "voucher-usage",
  organization_id: organization.id,
  type: "booking_usage",
  amount: 15,
  event_title: "Voucher Workshop",
  booking_reference: "VOUCHER-USE",
  balance_before: 30,
  balance_after: 15,
  created_at: "2026-07-06T10:00:00.000Z",
}];

const categoryForEntity = {
  Booking: "tickets",
  ProgramTicketTransaction: "program",
  TrainingFundTransaction: "training-fund",
  TrainingFundPurchase: "training-fund",
  VoucherTransaction: "vouchers",
};

const defaultData = {
  Booking: bookings,
  Event: [],
  ProgramTicketTransaction: programs,
  TrainingFundTransaction: trainingLedger,
  TrainingFundPurchase: trainingPurchases,
  VoucherTransaction: vouchers,
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installHistoryFixtures(page, {
  withOrganization = true,
  membership = schedules,
  data = defaultData,
  failing = [],
  delayed = [],
  failingEntities = [],
  delayedEntities = [],
} = {}) {
  const fixtureMember = withOrganization ? member : { ...member, organization_id: null };
  const state = {
    calls: {},
    released: new Set(),
    delayReleased: new Set(),
    escapedWrites: [],
  };

  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path } = url;
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
    if (path === `/api/entities/Member/${fixtureMember.id}` || path === "/api/entities/Member") {
      return json(route, path.endsWith(fixtureMember.id) ? fixtureMember : [fixtureMember]);
    }
    if (path === `/api/entities/Organization/${organization.id}` || path === "/api/entities/Organization") {
      const value = path.endsWith(organization.id) ? organization : [organization];
      return json(route, withOrganization ? value : (Array.isArray(value) ? [] : {}));
    }
    if (path === `/api/entities/Role/${member.role_id}`) {
      return json(route, { id: member.role_id, name: "Member", excluded_features: [] });
    }
    if (path === "/api/entities/Role") {
      return json(route, [{ id: member.role_id, name: "Member", excluded_features: [] }]);
    }
    if (path === "/api/membership/member-history") return json(route, membership);

    const entityMatch = path.match(/^\/api\/entities\/([^/]+)$/);
    if (entityMatch) {
      const entity = entityMatch[1];
      const category = categoryForEntity[entity];
      state.calls[entity] = (state.calls[entity] || 0) + 1;
      const failureKey = failingEntities.includes(entity)
        ? entity
        : (category && failing.includes(category) ? category : null);
      if (failureKey && !state.released.has(failureKey)) {
        return json(route, { error: `${category} fixture unavailable` }, 503);
      }
      const delayKey = delayedEntities.includes(entity)
        ? entity
        : (category && delayed.includes(category) ? category : null);
      if (delayKey && !state.delayReleased.has(delayKey)) {
        await new Promise(resolve => {
          const poll = setInterval(() => {
            if (state.delayReleased.has(delayKey)) {
              clearInterval(poll);
              resolve();
            }
          }, 20);
        });
      }
      return json(route, data[entity] || []);
    }

    return json(route, []);
  });

  return state;
}

test("mixed history keeps unfiltered category tabs, grouped counts, and deduplicated fund totals", async ({ page }) => {
  const state = await installHistoryFixtures(page);
  await page.goto("/History");

  await expect(page.getByTestId("tab-tickets")).toHaveText("Standard Tickets (2)");
  await expect(page.getByTestId("tab-program")).toHaveText("Program Tickets (2)");
  await expect(page.getByTestId("tab-training-fund")).toHaveText("Training Fund (2)");
  await expect(page.getByTestId("tab-vouchers")).toHaveText("Vouchers (1)");
  await expect(page.getByTestId("tab-membership")).toHaveText(`Membership (${schedules.length})`);
  await expect(page.getByText("Grouped Conference", { exact: true })).toHaveCount(1);
  await expect(page.getByText("2 attendees • £75.00", { exact: true })).toBeVisible();
  await expect(page.getByText("Duplicate purchase ledger row", { exact: true })).toHaveCount(0);

  await page.getByTestId("input-search").fill("no fixture matches this");
  for (const tab of ["tickets", "program", "training-fund", "vouchers", "membership"]) {
    await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
  }
  await page.getByTestId("input-search").fill("");
  await page.screenshot({
    path: "screenshots/history-clarity.jpg",
    fullPage: true,
    type: "jpeg",
    quality: 80,
  });
  expect(state.escapedWrites).toEqual([]);
});

test("successful empty categories disappear while mixed and all-empty histories stay clear", async ({ page }) => {
  await installHistoryFixtures(page, {
    membership: [schedules.at(-1)],
    data: { ...defaultData, Booking: [], ProgramTicketTransaction: [], TrainingFundTransaction: [], TrainingFundPurchase: [], VoucherTransaction: [] },
  });
  await page.goto("/History");

  await expect(page.getByTestId("tab-all")).toBeVisible();
  await expect(page.getByTestId("tab-membership")).toBeVisible();
  for (const tab of ["tickets", "program", "training-fund", "vouchers"]) {
    await expect(page.getByTestId(`tab-${tab}`)).toHaveCount(0);
  }

  const emptyPage = await page.context().newPage();
  await installHistoryFixtures(emptyPage, {
    membership: [],
    data: { Event: [], Booking: [], ProgramTicketTransaction: [], TrainingFundTransaction: [], TrainingFundPurchase: [], VoucherTransaction: [] },
  });
  await emptyPage.goto("/History");
  await expect(emptyPage.getByText("No transactions yet", { exact: true })).toBeVisible();
  await expect(emptyPage.getByTestId("tab-all")).toHaveCount(0);
});

test("a confirmed-empty Membership source disappears while other categories remain", async ({ page }) => {
  await installHistoryFixtures(page, { membership: [] });
  await page.goto("/History");

  await expect(page.getByTestId("tab-tickets")).toBeVisible();
  await expect(page.getByTestId("tab-program")).toBeVisible();
  await expect(page.getByTestId("tab-membership")).toHaveCount(0);
  await expect(page.getByText("Grouped Conference", { exact: true })).toBeVisible();
});

test("a purchase-only Training Fund history remains visible and is counted once", async ({ page }) => {
  await installHistoryFixtures(page, {
    membership: [],
    data: {
      Event: [],
      Booking: [],
      ProgramTicketTransaction: [],
      TrainingFundTransaction: [],
      TrainingFundPurchase: trainingPurchases,
      VoucherTransaction: [],
    },
  });
  await page.goto("/History");

  await expect(page.getByTestId("tab-training-fund")).toHaveText("Training Fund (1)");
  await page.getByTestId("tab-training-fund").click();
  await expect(page.getByText("+£40.00", { exact: true })).toBeVisible();
});

test("Training Fund waits for both sources and surfaces a one-source failure", async ({ page }) => {
  const emptyTrainingData = {
    Event: [],
    Booking: [],
    ProgramTicketTransaction: [],
    TrainingFundTransaction: [],
    TrainingFundPurchase: [],
    VoucherTransaction: [],
  };
  const pendingState = await installHistoryFixtures(page, {
    membership: [],
    data: emptyTrainingData,
    delayedEntities: ["TrainingFundTransaction"],
  });
  await page.goto("/History");
  await expect(page.getByText("Loading transactions...", { exact: true })).toBeVisible();
  await expect(page.getByText("No transactions yet", { exact: true })).toHaveCount(0);
  pendingState.delayReleased.add("TrainingFundTransaction");
  await expect(page.getByText("No transactions yet", { exact: true })).toBeVisible();

  const errorPage = await page.context().newPage();
  await installHistoryFixtures(errorPage, {
    membership: [],
    data: emptyTrainingData,
    failingEntities: ["TrainingFundTransaction"],
  });
  await errorPage.goto("/History");
  await expect(errorPage.getByTestId("history-error-training-fund")).toBeVisible();
  await expect(errorPage.getByText("No transactions yet", { exact: true })).toHaveCount(0);
});

test("unlinked members retain personal ticket and membership eligibility without organisation categories", async ({ page }) => {
  await installHistoryFixtures(page, {
    withOrganization: false,
    membership: [schedules.at(-1)],
    data: { ...defaultData, Booking: [bookings[2]] },
  });
  await page.goto("/History");

  await expect(page.getByTestId("tab-tickets")).toHaveText("Standard Tickets (1)");
  await expect(page.getByTestId("tab-membership")).toHaveText("Membership (1)");
  for (const tab of ["program", "training-fund", "vouchers"]) {
    await expect(page.getByTestId(`tab-${tab}`)).toHaveCount(0);
  }
});

test("category search and type filters show a local no-match without removing navigation", async ({ page }) => {
  await installHistoryFixtures(page);
  await page.goto("/History");
  await page.getByTestId("tab-program").click();
  await page.getByTestId("select-type-filter").click();
  await page.getByRole("option", { name: "Returns", exact: true }).click();

  await expect(page.getByText("No matching program ticket transactions", { exact: true })).toBeVisible();
  await expect(page.getByTestId("tab-program")).toBeVisible();
  await expect(page.getByTestId("tab-tickets")).toBeVisible();
  await page.getByTestId("button-clear-filters").click();
  await expect(page.getByText("Leadership Programme", { exact: true }).first()).toBeVisible();
});

test("loading is not treated as confirmed emptiness", async ({ page }) => {
  const state = await installHistoryFixtures(page, {
    membership: [],
    data: { Event: [], Booking: [], ProgramTicketTransaction: [], TrainingFundTransaction: [], TrainingFundPurchase: [], VoucherTransaction: [] },
    delayed: ["tickets"],
  });
  await page.goto("/History");
  await expect(page.getByText("Loading transactions...", { exact: true })).toBeVisible();
  await expect(page.getByText("No transactions yet", { exact: true })).toHaveCount(0);
  state.delayReleased.add("tickets");
  await expect(page.getByText("No transactions yet", { exact: true })).toBeVisible();
});

for (const category of ["tickets", "program", "training-fund", "vouchers"]) {
  test(`${category} failures have a global retry alert and are not mistaken for empty history`, async ({ page }) => {
    const state = await installHistoryFixtures(page, {
      membership: [schedules.at(-1)],
      failing: [category],
    });
    await page.goto("/History");

    const alert = page.getByTestId(`history-error-${category}`);
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    state.released.add(category);
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByTestId(`tab-${category}`)).toBeVisible();
    expect(state.escapedWrites).toEqual([]);
  });
}

test("a selected category removed by refresh returns to All and clears category filters", async ({ page }) => {
  const manyPrograms = Array.from({ length: 12 }, (_, index) => ({
    ...programs[0],
    id: `refresh-program-${index}`,
    program_name: `Refresh Programme ${index}`,
    created_date: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
  }));
  const data = { ...defaultData, ProgramTicketTransaction: manyPrograms };
  const state = await installHistoryFixtures(page, { data });
  await page.goto("/History");
  await page.getByTestId("tab-program").click();
  await page.getByTestId("button-next-page").click();
  await page.getByTestId("select-type-filter").click();
  await page.getByRole("option", { name: "Purchases", exact: true }).click();
  await page.getByTestId("input-search").fill("Refresh Programme");

  state.released.delete("program");
  data.ProgramTicketTransaction = [];
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.getByTestId("tab-program")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("tab-all")).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("input-search")).toHaveValue("");
  await expect(page.getByTestId("select-type-filter")).toHaveCount(0);
});

test("short-end membership years remain readable in All and Membership", async ({ page }) => {
  await installHistoryFixtures(page, {
    membership: [
      { ...membershipBase, id: "short-year-card", membership_year: "2026/27", payment_method: "card_monthly" },
      { ...membershipBase, id: "short-year-dd", membership_year: "2026-27", payment_method: "direct_debit" },
    ],
    data: { Event: [], Booking: [], ProgramTicketTransaction: [], TrainingFundTransaction: [], TrainingFundPurchase: [], VoucherTransaction: [] },
  });
  await page.goto("/History");
  for (const tab of ["all", "membership"]) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId("membership-history-card-personal-short-year-card").getByRole("heading")).toHaveText("Membership 2026/27");
    await expect(page.getByTestId("membership-history-card-personal-short-year-dd").getByRole("heading")).toHaveText("Membership 2026-27");
    await expect(page.getByText(/Renewal date:|End date:/)).toHaveCount(0);
  }
});

test("membership schedules use retained evidence and never expose rolling identifiers", async ({ page }) => {
  await installHistoryFixtures(page, {
    data: { Event: [], Booking: [], ProgramTicketTransaction: [], TrainingFundTransaction: [], TrainingFundPurchase: [], VoucherTransaction: [] },
  });
  await page.goto("/History");

  const assertPrimarySchedules = async () => {
    const upfront = page.getByTestId("membership-history-card-personal-stripe-upfront");
    await expect(upfront).toContainText("Schedule: From 1 February 2026 · 12 months");
    await expect(upfront).toContainText("Renewal date: 1 February 2027");
    await expect(upfront).not.toContainText("rolling:");

    const monthly = page.getByTestId("membership-history-card-personal-stripe-monthly");
    await expect(monthly).toContainText("Schedule: From 15 March 2026 · 12 months");
    await expect(monthly).toContainText("Renewal date: 15 March 2027");
    await expect(monthly).toContainText("Monthly card payments");
    await expect(monthly).not.toContainText(/Schedule: (?:1|one) month/i);

    const activeDebit = page.getByTestId("membership-history-card-personal-gc-active");
    await expect(activeDebit).toContainText(
      "Schedule: Ongoing — Direct Debit · From 1 April 2026",
    );
    await expect(activeDebit).not.toContainText("Renewal date:");
    await expect(activeDebit).not.toContainText(/currently active|active membership/i);
    await expect(activeDebit).not.toContainText("rolling:");
  };

  // Schedule evidence must be equally clear in the combined All view and the
  // category-specific Membership view.
  await assertPrimarySchedules();
  await page.getByTestId("tab-membership").click();
  await assertPrimarySchedules();
  await page.screenshot({
    path: "screenshots/history-membership-clarity.jpg",
    fullPage: true,
    type: "jpeg",
    quality: 80,
  });

  for (const status of ["historical", "cancelled", "paused", "scheduled"]) {
    const card = page.getByTestId(`membership-history-card-personal-gc-${status}`);
    await expect(card).toContainText("Schedule: Ongoing — Direct Debit · From");
    await expect(card).not.toContainText("Renewal date:");
    await expect(card).not.toContainText(/currently active|active membership/i);
    await expect(card).not.toContainText("rolling:");
  }

  const snapshot = page.getByTestId("membership-history-card-personal-snapshot-only");
  await expect(snapshot).toContainText("Renewal date: 10 June 2026");
  await expect(page.getByTestId("membership-history-card-personal-invalid-dates")).not.toContainText(/Invalid Date|rolling:/);
  const endOnly = page.getByTestId("membership-history-card-personal-end-only");
  await expect(endOnly).toContainText(/End date: 31 August 2024/i);
  await expect(endOnly).not.toContainText("Renewal date:");
  await page.getByTestId("button-next-page").click();
  await expect(page.getByTestId("membership-history-card-personal-regular-year")).toContainText("Membership 2024/2025");
  await page.getByTestId("button-prev-page").click();
  await expect(page.getByTestId("membership-history-card-personal-stripe-monthly")).toContainText("Monthly card payments");
});
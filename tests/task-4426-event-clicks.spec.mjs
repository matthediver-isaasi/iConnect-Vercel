import { test, expect } from "@playwright/test";

const TENANT = {
  id: "44260000-0000-4000-8000-000000000001",
  slug: "task4426-fixture",
  name: "Event click fixture",
};

const EVENTS = {
  simpleFeatured: "44260000-0000-4000-8000-000000000011",
  simpleStandard: "44260000-0000-4000-8000-000000000012",
  complexFeatured: "44260000-0000-4000-8000-000000000021",
  complexStandard: "44260000-0000-4000-8000-000000000022",
};

const MEMBER = {
  id: "44260000-0000-4000-8000-000000000101",
  email: "event-click-member@example.invalid",
  first_name: "Event",
  last_name: "Click",
  tenant_id: TENANT.id,
  role_id: "44260000-0000-4000-8000-000000000102",
  organization_id: null,
  member_excluded_features: [],
};

const ROLE = {
  id: MEMBER.role_id,
  name: "Event click verification role",
  excluded_features: [],
};

const FUTURE_START = "2099-01-15T10:00:00.000Z";
const FUTURE_END = "2099-01-15T11:00:00.000Z";

function ticketClasses() {
  return [{
    id: "44260000-0000-4000-8000-000000000201",
    name: "General admission",
    description: "Fixture ticket",
    price: 0,
    currency: "gbp",
    visibility_mode: "members_and_public",
    is_public: true,
  }];
}

function simpleEvent(id, title, isFeatured) {
  return {
    id,
    title,
    slug: `${title.toLowerCase().replaceAll(" ", "-")}`,
    description: `<p>${title} description</p>`,
    summary: `${title} summary`,
    start_date: FUTURE_START,
    end_date: FUTURE_END,
    location: "Fixture venue",
    image_url: null,
    image_focal_point: null,
    pricing_config: { ticket_classes: ticketClasses() },
    cheapest_price: 0,
    status: "published",
    available_seats: null,
    show_seat_count: true,
    event_type: null,
    is_online: false,
    timezone: "Europe/London",
    event_state: "active",
    registration_closes_at: null,
    is_featured: isFeatured,
    is_training: false,
    filter_tags: [],
    cta_override_url: null,
    cta_override_mode: "card",
    cta_button_label: "Register",
  };
}

function complexEvent(id, title, isFeatured) {
  return {
    id,
    title,
    slug: `${title.toLowerCase().replaceAll(" ", "-")}`,
    description: `<p>${title} description</p>`,
    summary: `${title} summary`,
    start_date: FUTURE_START,
    end_date: FUTURE_END,
    location: "Fixture venue",
    image_url: null,
    status: "published",
    available_seats: null,
    timezone: "Europe/London",
    event_state: "active",
    registration_closes_at: null,
    event_type: null,
    is_featured: isFeatured,
    is_complex: true,
    session_count: 1,
    day_count: 1,
    days_nonconsecutive: false,
    track_count: 0,
    cheapest_price: 0,
    pricing_config: { ticket_classes: ticketClasses() },
    cta_override_url: null,
    cta_override_mode: "card",
    cta_button_label: "Register",
  };
}

const SIMPLE_EVENTS = [
  simpleEvent(EVENTS.simpleFeatured, "Simple Featured", true),
  simpleEvent(EVENTS.simpleStandard, "Simple Standard", false),
];

const COMPLEX_EVENTS = [
  complexEvent(EVENTS.complexFeatured, "Complex Featured", true),
  complexEvent(EVENTS.complexStandard, "Complex Standard", false),
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Install a complete network boundary around the real /Events route. This
 * keeps the browser test deterministic and prevents fixture clicks/counts from
 * touching tenant data in a development or preview database.
 */
async function installFixtures(page, {
  auth = "guest",
  clickCountMode = "zero",
  clickCounts = {},
  eventClickStatus = 200,
} = {}) {
  const state = {
    eventClicks: [],
    clickCountRequests: [],
    attendeeCountRequests: [],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const pathname = requestUrl.pathname;
    if (!pathname.startsWith("/api/")) return route.continue();

    if (pathname === "/api/auth/me") {
      if (auth === "guest") return json(route, {}, 401);
      return json(route, MEMBER);
    }
    if (pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: auth !== "guest" });
    if (pathname === "/api/public/tenant-branding") {
      return json(route, {
        success: true,
        branding: {
          id: TENANT.id,
          slug: TENANT.slug,
          name: TENANT.name,
          faviconUrl: "",
        },
      });
    }
    if (pathname === "/api/public/portal-branding") {
      return json(route, { logoUrl: "", logoHeight: "medium", logoLink: "", homePageSlug: "", faviconUrl: "", tenantName: TENANT.name });
    }
    if (pathname === "/api/public/events") return json(route, SIMPLE_EVENTS);
    if (pathname === "/api/public/complex-events") return json(route, COMPLEX_EVENTS);
    if (pathname === "/api/public/system-settings") {
      return json(route, [{ setting_key: "event_types", setting_value: "[]" }]);
    }
    if (pathname === "/api/public/resource-categories") return json(route, []);
    if (pathname === "/api/public/banners") return json(route, []);
    if (pathname === "/api/public/navigation-items") return json(route, []);
    if (pathname === "/api/public/typography-styles") return json(route, []);
    if (pathname === "/api/public/ai-help-persona") return json(route, { name: "Fixture helper" });

    if (pathname === "/api/entities/Event") return json(route, SIMPLE_EVENTS);
    if (pathname === "/api/entities/ComplexEvent") return json(route, COMPLEX_EVENTS);
    if (pathname === "/api/entities/ComplexEventSession"
      || pathname === "/api/entities/ComplexEventTrack"
      || pathname === "/api/entities/ComplexEventTicketClass"
      || pathname === "/api/entities/ResourceCategory"
      || pathname === "/api/entities/MemberGroupAssignment"
      || pathname === "/api/entities/RoleAccessItem"
      || pathname === "/api/entities/PageBanner"
      || pathname === "/api/entities/PortalMenu") {
      return json(route, []);
    }
    if (pathname === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (pathname === `/api/entities/Member/${MEMBER.id}`) return json(route, MEMBER);
    if (pathname === "/api/admin/events/attendee-counts") {
      state.attendeeCountRequests.push(JSON.parse(request.postData() || "{}"));
      const payload = JSON.parse(request.postData() || "{}");
      return json(route, {
        counts: Object.fromEntries([
          ...(payload.simpleEventIds || []),
          ...(payload.complexEventIds || []),
        ].map((id) => [id, 0])),
      });
    }
    if (pathname === "/api/admin/events/click-counts") {
      const payload = JSON.parse(request.postData() || "{}");
      state.clickCountRequests.push(payload);
      if (clickCountMode === "loading") {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      if (clickCountMode === "error") return json(route, { error: "Fixture count failure" }, 503);
      return json(route, {
        counts: {
          simple: Object.fromEntries((payload.simpleEventIds || []).map((id) => [id, clickCounts[id] ?? 0])),
          complex: Object.fromEntries((payload.complexEventIds || []).map((id) => [id, clickCounts[id] ?? 0])),
        },
      });
    }
    if (pathname === "/api/public/event-click") {
      const payload = JSON.parse(request.postData() || "{}");
      state.eventClicks.push(payload);
      return json(route, { accepted: eventClickStatus === 200 }, eventClickStatus);
    }

    // Event details can be requested after a CTA navigation. The test only
    // verifies navigation, but returning a valid fixture prevents the app's
    // route from turning the navigation assertion into a data-load failure.
    if (pathname === "/api/public/event") {
      const slug = requestUrl.searchParams.get("slug");
      return json(route, [...SIMPLE_EVENTS, ...COMPLEX_EVENTS].find((event) => event.slug === slug) || SIMPLE_EVENTS[0]);
    }

    // The public shell makes a number of optional requests which are not part
    // of this feature. Return empty collections rather than touching a real
    // backend if a new optional query is introduced.
    return json(route, []);
  });

  return state;
}

async function openEvents(page, options) {
  const state = await installFixtures(page, options);
  await page.goto("/Events");
  await expect(page.getByRole("heading", { name: "Simple Featured" }).first()).toBeVisible();
  return state;
}

test.describe("task 4426 event-card click tracking", () => {
  test("tracks accepted guest activation for featured/standard simple and inline complex cards", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cookie-consent", "accepted");
    });
    const state = await openEvents(page, { auth: "guest" });

    await expect(page.getByTestId("banner-cookie-consent")).toHaveCount(0);
    await expect(page.getByTestId(`card-featured-event-${EVENTS.complexFeatured}`)).toBeVisible();

    // Use a real primary activation for every card variant. Navigation is
    // intentionally allowed; returning to /Events between activations also
    // proves tracking is fire-and-forget and does not hold up CTA navigation.
    let expectedClicks = 0;
    for (const eventId of Object.values(EVENTS)) {
      await page.getByTestId(`button-register-event-${eventId}`).first().click();
      expectedClicks += 1;
      await expect.poll(() => state.eventClicks.length).toBe(expectedClicks);
      await page.goto("/Events");
      await expect(page.getByRole("heading", { name: "Simple Featured" }).first()).toBeVisible();
    }

    await expect.poll(() => state.eventClicks.length).toBe(4);
    expect(state.eventClicks.map(({ eventId, eventType }) => ({ eventId, eventType })))
      .toEqual(expect.arrayContaining([
        { eventId: EVENTS.simpleFeatured, eventType: "simple" },
        { eventId: EVENTS.simpleStandard, eventType: "simple" },
        { eventId: EVENTS.complexFeatured, eventType: "complex" },
        { eventId: EVENTS.complexStandard, eventType: "complex" },
      ]));
    for (const payload of state.eventClicks) {
      expect(payload.visitorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
    expect(await page.evaluate(() => (
      Object.entries(localStorage)
        .find(([key]) => key.startsWith("iconn:event-click-visitor:"))?.[1] || null
    )))
      .toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("does not call the count endpoint or show a count to an unauthorized guest", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cookie-consent", "accepted");
    });
    const state = await openEvents(page, { auth: "guest" });

    await expect(page.getByTestId(`text-event-click-count-${EVENTS.simpleFeatured}`)).toHaveCount(0);
    await expect.poll(() => state.clickCountRequests.length).toBe(0);
    await expect.poll(() => state.attendeeCountRequests.length).toBe(0);
  });

  test("shows a permitted zero click count without confusing it with loading or unavailable", async ({ page }) => {
    const state = await openEvents(page, {
      auth: "member",
      clickCountMode: "zero",
    });

    const metric = page.getByTestId(`text-event-click-count-${EVENTS.simpleFeatured}`).first();
    await expect(metric).toHaveAttribute("aria-label", "Event clicks: 0");
    await expect(metric).toContainText("0");
    await expect.poll(() => state.clickCountRequests.find((request) => request.complexEventIds?.length > 0)).toBeTruthy();
    const countRequest = state.clickCountRequests.find((request) => request.complexEventIds?.length > 0);
    expect(countRequest).toEqual({
      simpleEventIds: expect.arrayContaining(Object.values(EVENTS).filter((id) => id.includes("011") || id.includes("012"))),
      complexEventIds: expect.arrayContaining([EVENTS.complexFeatured, EVENTS.complexStandard]),
    });
  });

  test("shows a distinct loading state while a permitted count request is pending", async ({ page }) => {
    const loadingState = await openEvents(page, {
      auth: "member",
      clickCountMode: "loading",
    });
    const loadingMetric = page.getByTestId(`text-event-click-count-${EVENTS.simpleFeatured}`).first();
    await expect(loadingMetric).toHaveAttribute("aria-label", "Event click count loading");
    expect(loadingState.clickCountRequests.length).toBeGreaterThan(0);
  });

  test("shows unavailable rather than zero when a permitted count request fails", async ({ page }) => {
    await openEvents(page, {
      auth: "member",
      clickCountMode: "error",
    });
    await expect(page.getByTestId(`text-event-click-count-${EVENTS.simpleFeatured}`).first())
      .toHaveAttribute("aria-label", "Event click count unavailable");
  });

  test("keeps CTA navigation working when ingestion fails", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cookie-consent", "accepted");
    });
    await openEvents(page, { auth: "guest", eventClickStatus: 503 });

    await page.getByTestId(`button-register-event-${EVENTS.simpleStandard}`).click();
    await expect(page).toHaveURL(/\/events\/simple-standard$/);
  });

  test("does not count shared EventCard administrative actions as public CTA clicks", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cookie-consent", "accepted");
    });
    const state = await openEvents(page, { auth: "member" });

    await expect(page.getByTestId(`button-edit-event-${EVENTS.simpleFeatured}`).first()).toBeVisible();
    await page.getByTestId(`button-edit-event-${EVENTS.simpleFeatured}`).first().click();
    await expect(page).toHaveURL(/\/EditEvent\?id=44260000-0000-4000-8000-000000000011$/);
    expect(state.eventClicks).toEqual([]);
  });
});
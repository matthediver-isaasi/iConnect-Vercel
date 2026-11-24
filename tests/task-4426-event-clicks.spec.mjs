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
  eventOverrides = {},
  branded = false,
} = {}) {
  const simpleEvents = SIMPLE_EVENTS.map(event => ({ ...event, ...eventOverrides }));
  const complexEvents = COMPLEX_EVENTS.map(event => ({ ...event, ...eventOverrides }));
  const state = {
    eventClicks: [],
    clickCountRequests: [],
    attendeeCountRequests: [],
  };
  // Include popup first requests in the boundary: no fixture navigation reaches
  // a real destination or database, including external card overrides.
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() && request.resourceType() === "document"
      && url.pathname.toLowerCase() !== "/events") {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>CTA destination</title><p>Fixture destination</p>" });
    }
    return route.fallback();
  });
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const pathname = requestUrl.pathname;
    if (!pathname.startsWith("/api/")) return route.continue();

    if (pathname === "/api/auth/me") {
      if (auth === "guest") return json(route, {}, 401);
      return json(route, MEMBER);
    }
    if (pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: auth !== "guest" });
    if (pathname === "/api/public/cookie-consent") {
      // SDK/banner integration has its own suite. This suite exercises the
      // real tracking hook with controlled consent snapshots below.
      return json(route, { error: "Consent SDK outside event-navigation fixture" }, 503);
    }
    if (pathname === "/api/public/tenant-branding") {
      return json(route, {
        success: true,
        branding: {
          id: TENANT.id,
          slug: TENANT.slug,
          name: TENANT.name,
          faviconUrl: "",
          ...(branded ? {
            buttonStyles: { primary: { background: { type: "solid", solidColor: "#123456" } } },
          } : {}),
        },
      });
    }
    if (pathname === "/api/public/portal-branding") {
      return json(route, { logoUrl: "", logoHeight: "medium", logoLink: "", homePageSlug: "", faviconUrl: "", tenantName: TENANT.name });
    }
    if (pathname === "/api/public/events") return json(route, simpleEvents);
    if (pathname === "/api/public/complex-events") return json(route, complexEvents);
    if (pathname === "/api/public/system-settings") {
      if (requestUrl.searchParams.has("key")) return json(route, []);
      return json(route, [{ setting_key: "event_types", setting_value: "[]" }]);
    }
    if (pathname === "/api/public/resource-categories") return json(route, []);
    if (pathname === "/api/public/banners") return json(route, []);
    if (pathname === "/api/public/navigation-items") return json(route, []);
    if (pathname === "/api/public/typography-styles") return json(route, []);
    if (pathname === "/api/public/ai-help-persona") return json(route, { name: "Fixture helper" });

    if (pathname === "/api/entities/Event") return json(route, simpleEvents);
    if (pathname === "/api/entities/ComplexEvent") return json(route, complexEvents);
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
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "Simple Featured" }).first()).toBeVisible();
  if (options?.consent) {
    await page.evaluate(async (consent) => {
      const { consentState } = await import("/src/lib/consentState.js");
      consentState.publish({
        ready: true, hasActed: true,
        categories: { necessary: true, functional: false, analytics: consent === "accepted", marketing: false },
      });
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, options.consent);
  }
  return state;
}

async function activateInNewTab(page, cta, activate = () => cta.click()) {
  const listingUrl = page.url();
  const href = await cta.getAttribute("href");
  await expect(cta).toHaveAttribute("target", "_blank");
  await expect(cta).toHaveAttribute("rel", "noopener noreferrer");
  // Modified/background tabs do not always emit the opener's popup event.
  const popupPromise = page.context().waitForEvent("page");
  await activate();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(new URL(href, listingUrl).href);
  await popup.waitForLoadState("domcontentloaded");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  expect(page.context().pages()).toHaveLength(2);
  await expect(page).toHaveURL(listingUrl);
  await popup.close();
}

test.describe("task 4426 event-card click tracking", () => {
  test("tracks accepted guest activation for featured/standard simple and inline complex cards", async ({ page }, testInfo) => {
    const state = await openEvents(page, { auth: "guest", consent: "accepted" });

    await expect(page.getByTestId("banner-cookie-consent")).toHaveCount(0);
    await expect(page.getByTestId(`card-featured-event-${EVENTS.complexFeatured}`)).toBeVisible();

    const search = page.getByPlaceholder("Search events by name, description or location...");
    await search.fill("Fixture");
    await page.evaluate(() => { window.listingInstance = "original"; });
    await page.screenshot({ path: testInfo.outputPath("events-listing.png"), fullPage: true });
    // Activate every rendered branch, including the featured cards repeated
    // in the ordinary grid. Both mouse and keyboard must use native links.
    let expectedClicks = 0;
    for (const eventId of Object.values(EVENTS)) {
      const ctas = page.getByTestId(`button-register-event-${eventId}`);
      for (const cta of await ctas.all()) {
        await activateInNewTab(page, cta, async () => {
          if (expectedClicks % 2) {
            await cta.focus();
            await page.keyboard.press("Enter");
          } else await cta.click();
        });
        expectedClicks += 1;
        await expect.poll(() => state.eventClicks.length).toBe(expectedClicks);
        await expect(search).toHaveValue("Fixture");
        expect(await page.evaluate(() => window.listingInstance)).toBe("original");
      }
    }

    await expect.poll(() => state.eventClicks.length).toBe(6);
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
    await openEvents(page, { auth: "guest", eventClickStatus: 503, consent: "accepted" });

    await activateInNewTab(page, page.getByTestId(`button-register-event-${EVENTS.simpleStandard}`));
  });

  test("does not count shared EventCard administrative actions as public CTA clicks", async ({ page }) => {
    const state = await openEvents(page, { auth: "member", consent: "accepted" });

    await expect(page.getByTestId(`button-edit-event-${EVENTS.simpleFeatured}`).first()).toBeVisible();
    await page.getByTestId(`button-edit-event-${EVENTS.simpleFeatured}`).first().click();
    await expect(page).toHaveURL(/\/EditEvent\?id=44260000-0000-4000-8000-000000000011$/);
    expect(state.eventClicks).toEqual([]);
  });
});

for (const scenario of [
  { name: "ID fallbacks", overrides: { slug: null } },
  { name: "card overrides", overrides: { cta_override_url: "https://example.invalid/book?x=1&y=2" } },
  { name: "detail-only overrides", overrides: { cta_override_url: "https://example.invalid/ignored", cta_override_mode: "detail_page" } },
  { name: "waiting lists ignore overrides and sold-out capacity", overrides: { waiting_list_enabled: true, available_seats: 0, cta_override_url: "https://example.invalid/ignored" } },
  { name: "registration closed can still view details", overrides: { event_state: "closed" } },
  { name: "registration deadline passed", overrides: { registration_closes_at: "2000-01-15T11:00:00Z" } },
  { name: "tenant-styled CTAs", overrides: {}, branded: true },
]) {
  test(`new-tab CTAs preserve ${scenario.name} in both listing branches`, async ({ page }) => {
    await openEvents(page, { eventOverrides: scenario.overrides, branded: scenario.branded });
    for (const event of [...SIMPLE_EVENTS, ...COMPLEX_EVENTS]) {
      const isComplex = !!event.is_complex;
      const expectedUrl = scenario.overrides.slug === null
        ? `/${isComplex ? "ComplexEventDetail" : "EventDetails"}?id=${event.id}`
        : !isComplex && scenario.name === "card overrides"
          ? scenario.overrides.cta_override_url
          : `/${isComplex ? "session-events" : "events"}/${event.slug}`;
      const ctas = page.getByTestId(`button-register-event-${event.id}`);
      await expect(ctas).toHaveCount(event.is_featured ? 2 : 1);
      for (const cta of await ctas.all()) {
        await expect(cta).toHaveAttribute("href", expectedUrl);
        if (scenario.branded) await expect(cta).toHaveCSS("background-color", "rgb(18, 52, 86)");
        await activateInNewTab(page, cta);
      }
    }
  });
}

test("Buy Tickets uses its existing destination in both simple listing branches", async ({ page }) => {
  const state = await openEvents(page, { eventOverrides: { program_tag: "fixture-program" }, consent: "accepted" });
  for (const event of SIMPLE_EVENTS) {
    const ctas = page.getByTestId(`button-buy-tickets-${event.id}`);
    await expect(ctas).toHaveCount(event.is_featured ? 2 : 1);
    for (const cta of await ctas.all()) {
      await expect(cta).toHaveAttribute("href", "/BuyProgramTickets");
      await activateInNewTab(page, cta);
    }
  }
  await expect.poll(() => state.eventClicks.length).toBe(3);
});

test("sold-out CTAs are inert buttons without a navigable ancestor", async ({ page }) => {
  const state = await openEvents(page, { eventOverrides: { available_seats: 0, shopping_held: 1 }, auth: "member" });
  for (const event of [...SIMPLE_EVENTS, ...COMPLEX_EVENTS]) {
    const ctas = page.getByTestId(`button-register-event-${event.id}`);
    await expect(ctas).toHaveCount(event.is_featured ? 2 : 1);
    for (const cta of await ctas.all()) {
      await expect(cta).toBeDisabled();
      await expect(cta).toHaveJSProperty("tagName", "BUTTON");
      expect(await cta.evaluate(el => el.closest("a"))).toBeNull();
      await cta.dispatchEvent("auxclick", { button: 1 });
    }
  }
  expect(page.context().pages()).toHaveLength(1);
  expect(state.eventClicks).toEqual([]);
});

test("ended CTAs stay disabled in both listing branches", async ({ page }) => {
  const state = await installFixtures(page, { eventOverrides: { start_date: "2000-01-15T10:00:00Z", end_date: "2000-01-15T11:00:00Z" } });
  await page.goto("/events");
  await page.getByTestId("switch-show-past-events").click();
  for (const event of [...SIMPLE_EVENTS, ...COMPLEX_EVENTS]) {
    const ctas = page.getByTestId(`button-event-ended-${event.id}`);
    await expect(ctas).toHaveCount(event.is_featured ? 2 : 1);
    for (const cta of await ctas.all()) {
      await expect(cta).toBeDisabled();
      await expect(cta).toHaveJSProperty("tagName", "BUTTON");
      expect(await cta.evaluate(el => el.closest("a"))).toBeNull();
    }
  }
  expect(state.eventClicks).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
});

test("modified and middle clicks open once and retain consent-aware tracking", async ({ page }) => {
  const state = await openEvents(page, { consent: "accepted" });
  let count = 0;
  for (const eventId of [EVENTS.simpleStandard, EVENTS.complexStandard]) {
    const cta = page.getByTestId(`button-register-event-${eventId}`);
    for (const options of [{ modifiers: ["Control"] }, { button: "middle" }]) {
      await activateInNewTab(page, cta, () => cta.click(options));
      await expect.poll(() => state.eventClicks.length).toBe(++count);
    }
  }
});

test("declined analytics consent does not block new-tab navigation or create tracking identity", async ({ page }) => {
  const state = await openEvents(page, { consent: "declined" });
  for (const eventId of [EVENTS.simpleStandard, EVENTS.complexStandard]) {
    await activateInNewTab(page, page.getByTestId(`button-register-event-${eventId}`));
  }
  expect(state.eventClicks).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("iconn:event-click-visitor:")))).toBe(false);
});
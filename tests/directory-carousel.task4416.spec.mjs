import { test, expect } from "@playwright/test";

/*
 * Browser coverage for the DirectoryCarousel canvas block.
 *
 * This suite deliberately owns the whole network boundary.  It is therefore
 * safe to run against a local Vite instance (and against a deployed preview)
 * without depending on a tenant, database rows, uploaded logos, or secrets.
 * The page and editor are real application routes; only their API responses
 * are fixture-backed.
 */

const PAGE_ID = "directory-carousel-browser-page";
const PAGE_SLUG = "directory-carousel-browser-fixture";
const DIRECTORY_SLUG = "directory-carousel-browser";
const STABLE_SEED = "stable-seed";
const EVENT_ID = "directory-carousel-sponsor-event";
const BLOCK_ID = "directory-carousel-browser-block";
const SPONSOR_BLOCK_ID = "directory-carousel-sponsor-regression";

const MEMBER = {
  id: "directory-carousel-browser-member",
  email: "directory-carousel-browser@example.invalid",
  first_name: "Directory",
  last_name: "Carousel",
  tenant_id: "directory-carousel-browser-tenant",
  organization_id: "directory-carousel-browser-org",
  role_id: "directory-carousel-browser-role",
  is_team_member: true,
  member_excluded_features: [],
};

const ROLE = {
  id: MEMBER.role_id,
  name: "Directory carousel browser role",
  excluded_features: [],
};

const AUTHORIZED_DIRECTORY_CONTEXT = {
  tenantId: MEMBER.tenant_id,
  memberId: MEMBER.id,
  roleId: ROLE.id,
};

const LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='%233b82f6'/%3E%3C/svg%3E";

const LARGE_RECORDS = Array.from({ length: 1200 }, (_, index) => {
  const number = String(index + 1).padStart(4, "0");
  return {
    id: `large-${index + 1}`,
    name: `Large Organisation ${number}`,
    logo_url: LOGO,
    description: `Large directory fixture organisation ${number}.`,
    website_url: `https://large-${number}.example.invalid`,
  };
});

const STABLE_RECORDS = [
  {
    id: "stable-1",
    name: "Stable Alpha",
    logo_url: LOGO,
    description: "The first stable directory record.",
    website_url: "https://stable-alpha.example.invalid",
  },
  {
    id: "stable-2",
    name: "Stable Beta",
    logo_url: LOGO,
    description: "The second stable directory record.",
    website_url: "https://stable-beta.example.invalid",
  },
  {
    id: "stable-3",
    name: "Stable Gamma",
    logo_url: LOGO,
    description: "The third stable directory record.",
    website_url: "https://stable-gamma.example.invalid",
  },
  {
    id: "stable-4",
    name: "Stable Delta",
    logo_url: LOGO,
    description: "The fourth stable directory record.",
    website_url: "https://stable-delta.example.invalid",
  },
  {
    id: "stable-5",
    name: "Stable Epsilon",
    logo_url: LOGO,
    description: "The fifth stable directory record.",
    website_url: "https://stable-epsilon.example.invalid",
  },
  {
    id: "stable-6",
    name: "Stable Zeta",
    logo_url: LOGO,
    description: "The sixth stable directory record.",
    website_url: "https://stable-zeta.example.invalid",
  },
];

const FRESH_RECORDS = [
  { ...STABLE_RECORDS[0], id: "fresh-1", name: "Fresh One" },
  { ...STABLE_RECORDS[1], id: "fresh-2", name: "Fresh Two" },
  { ...STABLE_RECORDS[2], id: "fresh-3", name: "Fresh Three" },
  { ...STABLE_RECORDS[3], id: "fresh-4", name: "Fresh Four" },
  { ...STABLE_RECORDS[4], id: "fresh-5", name: "Fresh Five" },
  { ...STABLE_RECORDS[5], id: "fresh-6", name: "Fresh Six" },
];

const MISSING_LOGO_RECORDS = [
  {
    id: "missing-logo",
    name: "Missing Logo Company",
    logo_url: null,
    description: "This record intentionally has no logo.",
    website_url: "https://missing-logo.example.invalid",
  },
  {
    id: "missing-logo-2",
    name: "Logo Company",
    logo_url: LOGO,
    description: "A neighbouring record with a logo.",
    website_url: "https://logo-company.example.invalid",
  },
];

const SPONSORS = [
  {
    id: "sponsor-regression-1",
    name: "Regression Sponsor",
    logo_url: LOGO,
    description: "Sponsor carousel remains available.",
    website_url: "https://sponsor.example.invalid",
    category_id: null,
  },
];

function directoryBlock(content = {}) {
  return {
    id: BLOCK_ID,
    type: "directory-carousel",
    name: "Directory carousel fixture",
    geom: { x: 0, y: 0, w: 1200, h: 390 },
    bp: {
      desktop: { x: 0, y: 0, w: 1200, h: 390 },
      tablet: { x: 0, y: 0, w: 768, h: 390 },
      mobile: { x: 0, y: 0, w: 375, h: 390 },
    },
    style: {
      background: "#f8fafc",
      borderWidth: 1,
      borderColor: "#e2e8f0",
      borderRadius: 8,
      opacity: 1,
    },
    content: {
      directorySlug: DIRECTORY_SLUG,
      // Stable/default mode intentionally omits `seed` from client requests;
      // the API's stable default is covered by STABLE_SEED below.
      randomiseOrder: false,
      perView: { desktop: 3, tablet: 2, mobile: 1 },
      showArrows: true,
      showIndicators: true,
      autoplay: false,
      autoplayMs: 1600,
      ...content,
    },
  };
}

function sponsorBlock() {
  return {
    id: SPONSOR_BLOCK_ID,
    type: "sponsor-carousel",
    name: "Sponsor regression fixture",
    geom: { x: 0, y: 410, w: 1200, h: 350 },
    bp: {
      desktop: { x: 0, y: 410, w: 1200, h: 350 },
      tablet: { x: 0, y: 410, w: 768, h: 350 },
      mobile: { x: 0, y: 410, w: 375, h: 350 },
    },
    style: {
      background: "#ffffff",
      borderWidth: 1,
      borderColor: "#e2e8f0",
      borderRadius: 8,
      opacity: 1,
    },
    content: {
      eventId: EVENT_ID,
      sponsorsPerView: 1,
      showArrows: true,
      showIndicators: true,
      autoplay: false,
    },
  };
}

function canvasDesign(directoryContent = {}) {
  return {
    version: 1,
    root: {
      background: null,
      groups: [],
      guides: { vertical: [], horizontal: [] },
      sections: [{
        id: "directory-carousel-browser-section",
        children: [directoryBlock(directoryContent), sponsorBlock()],
      }],
    },
  };
}

function pageFixture(directoryContent = {}) {
  return {
    id: PAGE_ID,
    title: "Directory carousel browser fixture",
    slug: PAGE_SLUG,
    status: "published",
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: "none",
    tenant_id: MEMBER.tenant_id,
    canvas_design: canvasDesign(directoryContent),
  };
}

function json(route, body, status = 200, headers = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

function recordsForSeed(seed) {
  if (String(seed || "") === "fresh-a") return FRESH_RECORDS;
  // Fresh visits use the same eligible directory rows, but a different seed
  // produces a different deterministic order. Keep this a reorder rather
  // than a second inventory so the browser fixture matches the API contract.
  if (String(seed || "") === "fresh-b") return [...FRESH_RECORDS].reverse();
  if (String(seed || "") === STABLE_SEED) return STABLE_RECORDS;
  return STABLE_RECORDS;
}

function getPageBlocks(design) {
  return design?.root?.sections?.flatMap((section) => section.children || []) || [];
}

/**
 * Install public-page and editor fixtures.  All root-level API requests are
 * recorded; non-GET mutations are rejected except for the one canvas-design
 * PUT used by the persistence test.
 */
async function installFixtures(page, {
  state = "ready",
  directoryContent = {},
  records = undefined,
  delayPage = undefined,
} = {}) {
  const fixturePage = pageFixture({
    ...directoryContent,
  });
  const requests = [];
  const writes = [];
  const pageErrors = [];
  const consoleErrors = [];
  const delayedPageResolvers = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript(({ member, tenant }) => {
    localStorage.setItem("agcas_member", JSON.stringify(member));
    localStorage.setItem("tenant_slug", tenant);
  }, { member: MEMBER, tenant: "directory-carousel-browser" });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    // Let Vite modules, styles, fonts and static assets retain their native
    // response content type.  Only root-level API calls are fixture-owned.
    if (!path.startsWith("/api/")) return route.continue();

    const query = Object.fromEntries(url.searchParams.entries());
    requests.push({ path, method, query });

    if (path === "/api/auth/me") return json(route, MEMBER);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        authenticated: true,
        tenantUser: {
          id: "directory-carousel-browser-tenant-user",
          email: MEMBER.email,
          first_name: MEMBER.first_name,
          last_name: MEMBER.last_name,
          role: ROLE,
          tenant: { id: MEMBER.tenant_id, slug: "directory-carousel-browser" },
        },
        user: MEMBER,
        member: MEMBER,
        tenant: { id: MEMBER.tenant_id, slug: "directory-carousel-browser" },
        tenantId: MEMBER.tenant_id,
        memberId: MEMBER.id,
      });
    }
    if (path === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (path === `/api/entities/Member/${MEMBER.id}`) return json(route, MEMBER);
    if (path === `/api/entities/Organization/${MEMBER.organization_id}`) {
      return json(route, { id: MEMBER.organization_id, name: "Directory Carousel Org" });
    }
    if (path === "/api/entities/Role") return json(route, [ROLE]);
    if (path === "/api/entities/Member") return json(route, [MEMBER]);
    if (path === "/api/entities/Organization") {
      return json(route, [{ id: MEMBER.organization_id, name: "Directory Carousel Org" }]);
    }
    if (path === "/api/entities/DynamicDirectory") {
      return json(route, [{
        id: "directory-carousel-browser-directory",
        slug: DIRECTORY_SLUG,
        name: "Directory carousel browser directory",
        entity_type: "organization",
        is_active: true,
        // The browser is deliberately an authenticated, role-authorized
        // context. This must not accidentally exercise a public directory.
        is_public: false,
        allowed_role_ids: [ROLE.id],
      }]);
    }
    if (path === "/api/entities/IEditPage") return json(route, [fixturePage]);

    if (path === `/api/canvas-design/${PAGE_ID}` && method === "GET") {
      return json(route, { page: fixturePage });
    }
    if (path === `/api/canvas-design/${PAGE_ID}` && method === "PUT") {
      const body = request.postDataJSON?.() || {};
      writes.push({ path, method, body });
      if (body.canvas_design) fixturePage.canvas_design = body.canvas_design;
      return json(route, { page: fixturePage });
    }

    if (path === `/api/public/page/${PAGE_SLUG}`) {
      return json(route, {
        success: true,
        page: fixturePage,
        elements: [],
        symbols: [],
      }, 200, { "Cache-Control": "no-store" });
    }

    if (path === "/api/public/dynamic-directory") {
      if (query.mode !== "carousel") {
        return json(route, { error: "Carousel mode is required" }, 400);
      }
      if (
        AUTHORIZED_DIRECTORY_CONTEXT.tenantId !== MEMBER.tenant_id
        || AUTHORIZED_DIRECTORY_CONTEXT.memberId !== MEMBER.id
        || AUTHORIZED_DIRECTORY_CONTEXT.roleId !== ROLE.id
      ) {
        return json(route, { error: "Directory access denied" }, 403);
      }
      if (state === "error") return json(route, { error: "Directory fixture unavailable" }, 503);
      if (delayPage !== undefined && Number(query.page || 1) === Number(delayPage)) {
        await new Promise((resolve) => delayedPageResolvers.push(resolve));
      }
      const selected = records || (state === "empty"
        ? []
        : state === "missing-logo"
          ? MISSING_LOGO_RECORDS
          : recordsForSeed(query.seed));
      const pageNumber = Math.max(1, Number(query.page || 1));
      const pageSize = Math.max(1, Number(query.limit || 6));
      const offset = (pageNumber - 1) * pageSize;
      return json(route, {
        records: selected.slice(offset, offset + pageSize),
        total: selected.length,
        page: pageNumber,
        pageSize,
      });
    }

    if (path === "/api/public/events") {
      return json(route, [{ id: EVENT_ID, slug: EVENT_ID, event_type: "simple" }]);
    }
    if (path === "/api/public/event-sponsors") {
      return json(route, {
        sponsors: SPONSORS,
        categories: [],
        assignments: [],
      });
    }

    // Canvas preview audits are expected editor telemetry, not a content
    // mutation.  Return the smallest valid shape and keep them visible in the
    // request log.
    if (path.startsWith("/api/canvas-page-audits/")) {
      return json(route, method === "GET" ? { audits: [] } : { audit: {} });
    }
    if (path.startsWith("/api/canvas-versions/")) {
      return json(route, method === "GET" ? { versions: [] } : { version: {} });
    }

    if (method === "GET") {
      if (path.includes("/branding") || path.includes("/settings")) {
        return json(route, { tenant: { id: MEMBER.tenant_id }, branding: {} });
      }
      return json(route, []);
    }

    writes.push({ path, method, body: request.postDataJSON?.() });
    return json(route, { error: "Unexpected fixture mutation" }, 405);
  });

  return {
    fixturePage,
    requests,
    writes,
    pageErrors,
    consoleErrors,
    releaseDirectoryPage() {
      while (delayedPageResolvers.length) delayedPageResolvers.shift()();
    },
  };
}

function carousel(pageOrFrame) {
  return pageOrFrame.locator(
    "[data-testid='directory-carousel'], [data-testid='directory-carousel-renderer'], [data-testid='directory-carousel-preview']",
  ).first();
}

function carouselCards(surface) {
  return surface.locator(
    "button[data-testid^='button-directory-carousel-']"
      + ":not([data-testid='button-directory-carousel-prev'])"
      + ":not([data-testid='button-directory-carousel-next'])"
      + ":not([data-testid^='button-directory-carousel-ellipsis-'])"
      + ":not([data-testid^='button-directory-carousel-indicator-'])",
  );
}

function carouselNext(surface) {
  return surface.locator(
    "[data-testid='button-directory-carousel-next'], [data-testid='directory-carousel-next']",
  ).first();
}

function carouselPrev(surface) {
  return surface.locator(
    "[data-testid='button-directory-carousel-prev'], [data-testid='directory-carousel-prev']",
  ).first();
}

function carouselPageStatus(surface) {
  return surface.locator(
    "[data-testid='directory-carousel-page-status'], [role='status'], [aria-live='polite']",
  ).filter({ hasText: /Page \d+ of \d+/ }).first();
}

function carouselIndicators(surface) {
  return surface.locator(
    "[data-testid^='button-directory-carousel-indicator-'], [data-testid^='directory-carousel-indicator-'], [data-testid^='button-directory-carousel-ellipsis-']",
  );
}

async function expectDirectoryRequest(state, seed = undefined) {
  await expect.poll(() => state.requests.filter((request) => (
    request.path === "/api/public/dynamic-directory"
    && request.query.mode === "carousel"
  )).at(-1)).toBeTruthy();
  const request = state.requests.filter((item) => item.path === "/api/public/dynamic-directory").at(-1);
  expect(request.query.slug).toBe(DIRECTORY_SLUG);
  expect(request.query.mode).toBe("carousel");
  expect(Number(request.query.page)).toBeGreaterThanOrEqual(1);
  expect(Number(request.query.limit)).toBeGreaterThan(0);
  if (seed !== undefined) expect(request.query.seed).toBe(seed);
  return request;
}

async function swipe(locator, fromX = 240, toX = 50) {
  await locator.dispatchEvent("touchstart", {
    touches: [{ identifier: 1, clientX: fromX, clientY: 120 }],
  });
  await locator.dispatchEvent("touchend", {
    changedTouches: [{ identifier: 1, clientX: toX, clientY: 120 }],
  });
}

function directoryContentFromSavedBody(body) {
  return getPageBlocks(body?.canvas_design)
    .find((block) => block.type === "directory-carousel")?.content || null;
}

test.describe("DirectoryCarousel published renderer", () => {
  test("renders the stable seed on desktop, navigates by controls/keyboard/swipe, and preserves SponsorCarousel", async ({ page }) => {
    const state = await installFixtures(page, {
      directoryContent: {
        autoplay: false,
        perView: { desktop: 3, tablet: 2, mobile: 1 },
      },
    });
    await page.goto(`/${PAGE_SLUG}`);

    const directory = carousel(page);
    await expect(directory).toBeVisible();
    await expect(directory).toHaveAttribute("role", "region");
    await expect(directory).toHaveAttribute("aria-roledescription", "carousel");
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();
    await expect(page.getByText("Stable Beta", { exact: true })).toBeVisible();
    await expect(page.getByText("Stable Gamma", { exact: true })).toBeVisible();
    await expectDirectoryRequest(state);
    const initialDirectoryRequest = state.requests
      .filter((request) => request.path === "/api/public/dynamic-directory")
      .at(-1);
    // `randomiseOrder: false` uses the API's stable default (alpha) and must
    // not pretend that a persisted stable-seed setting exists in the client.
    expect(initialDirectoryRequest.query.seed).toBeUndefined();

    // Three records are visible on the desktop slide, and the second page is
    // exposed through both explicit navigation controls and indicators.
    await expect(carouselCards(directory)).toHaveCount(3);
    await expect(carouselNext(directory)).toBeVisible();
    await expect(carouselPrev(directory)).toBeVisible();
    await expect(carouselIndicators(directory)).toHaveCount(2);
    await carouselNext(directory).click();
    await expect(page.getByText("Stable Delta", { exact: true })).toBeVisible();
    await expect(page.getByText("Stable Alpha", { exact: true })).toHaveCount(0);

    await directory.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();
    await carouselNext(directory).click();
    await swipe(directory, 50, 240);
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();

    // This is a regression guard for the existing SponsorCarousel registry
    // entry.  Adding a data block must not unregister or blank the sponsor
    // implementation.
    const sponsor = page.getByTestId("sponsor-carousel");
    await expect(sponsor).toBeVisible();
    await expect(page.getByText("Regression Sponsor", { exact: true })).toBeVisible();
    await expect(sponsor.getByRole("button", { name: "Next sponsors" })).toHaveCount(0);
    // Let the shared transition finish before recording the visual result.
    await page.waitForTimeout(600);
    await page.screenshot({
      path: "/tmp/directory-carousel-task4416-desktop.png",
      fullPage: true,
    });
    expect(state.writes).toEqual([]);
  });

  test("does not clamp an uncached page while loading and wraps at both ends", async ({ page }) => {
    const state = await installFixtures(page, { delayPage: 2 });
    await page.goto(`/${PAGE_SLUG}`);
    const directory = carousel(page);
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();

    const directoryRequests = () => state.requests.filter((request) => (
      request.path === "/api/public/dynamic-directory"
      && request.query.mode === "carousel"
    ));
    const initialPageOneRequests = directoryRequests()
      .filter((request) => request.query.page === "1").length;

    await carouselNext(directory).click();
    await expect.poll(() => directoryRequests()
      .filter((request) => request.query.page === "2").length).toBe(1);
    // A page-2 cache miss must not transiently reset currentPage to one while
    // the response is pending. That regression can trigger an extra page-1
    // request and loses the user's intended navigation.
    await page.waitForTimeout(250);
    expect(directoryRequests().filter((request) => request.query.page === "1").length)
      .toBe(initialPageOneRequests);

    state.releaseDirectoryPage();
    await expect(page.getByText("Stable Delta", { exact: true })).toBeVisible();

    // Directory navigation is circular rather than disabled at either end.
    await carouselNext(directory).click();
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();
    await carouselPrev(directory).click();
    await expect(page.getByText("Stable Delta", { exact: true })).toBeVisible();
    expect(state.writes).toEqual([]);
  });

  test("windows indicators for 1200 organisations while exposing the active page through status", async ({ page }) => {
    const state = await installFixtures(page, { records: LARGE_RECORDS });
    await page.goto(`/${PAGE_SLUG}`);
    const directory = carousel(page);
    await expect(directory).toBeVisible();
    await expect(carouselCards(directory)).toHaveCount(3);

    const indicators = carouselIndicators(directory);
    const activeIndicator = directory.locator(
      "[data-testid^='button-directory-carousel-indicator-'][aria-current='page'],"
        + " [data-testid^='directory-carousel-indicator-'][aria-current='page']",
    ).first();
    const pageStatus = carouselPageStatus(directory);
    await expect.poll(() => indicators.count()).toBeLessThanOrEqual(9);
    await expect(activeIndicator).toBeVisible();
    await expect(pageStatus).toContainText("Page 1 of 400");

    // The next arrow must remain operable even though only a bounded indicator
    // window is rendered.
    await carouselNext(directory).click();
    await expect(pageStatus).toContainText("Page 2 of 400");
    await expect(activeIndicator).toBeVisible();
    await expect.poll(() => indicators.count()).toBeLessThanOrEqual(9);

    // The window must keep the late-page target and its active dot visible.
    const lastIndicator = directory.locator(
      "[aria-label='Show page 400 of 400'], [aria-label='Go to page 400 of 400']",
    ).first();
    await expect(lastIndicator).toBeVisible();
    await lastIndicator.click();
    await expect(pageStatus).toContainText("Page 400 of 400");
    await expect(activeIndicator).toBeVisible();
    await expect.poll(() => indicators.count()).toBeLessThanOrEqual(9);
    expect(state.requests.filter((request) => (
      request.path === "/api/public/dynamic-directory"
      && request.query.mode === "carousel"
    )).at(-1).query.page).toBe("400");
    expect(state.writes).toEqual([]);
  });

  test("uses responsive per-view settings after a desktop-to-mobile resize", async ({ page }) => {
    const state = await installFixtures(page, {
      directoryContent: {
        autoplay: false,
        perView: { desktop: 3, tablet: 2, mobile: 1 },
      },
    });
    await page.goto(`/${PAGE_SLUG}`);
    const directory = carousel(page);
    await expect(directory).toBeVisible();
    await expect(carouselCards(directory)).toHaveCount(3);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => carouselCards(directory).count()).toBe(1);
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
    await page.screenshot({
      path: "/tmp/directory-carousel-task4416-mobile.png",
      fullPage: true,
    });
    expect(state.writes).toEqual([]);
  });

  test("autoplays only on the published renderer and remains deterministic for a stable seed", async ({ page }) => {
    const state = await installFixtures(page, {
      directoryContent: {
        autoplay: true,
        autoplayMs: 1600,
        perView: { desktop: 3, tablet: 2, mobile: 1 },
      },
    });
    await page.goto(`/${PAGE_SLUG}`);
    const directory = carousel(page);
    await expect(directory).toBeVisible();
    const initial = await carouselIndicators(directory).evaluateAll((buttons) =>
      buttons.findIndex((button) => button.getAttribute("aria-current") === "page"));
    await expect.poll(async () => carouselIndicators(directory).evaluateAll((buttons) =>
      buttons.findIndex((button) => button.getAttribute("aria-current") === "page"),
    ), { timeout: 5_000 }).not.toBe(initial);
    await expectDirectoryRequest(state);

    // A stable seed must produce the same first page on a fresh navigation.
    await page.reload();
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();
    await expectDirectoryRequest(state);
    expect(state.writes).toEqual([]);
  });

  test("renders an explicit request error, empty state, and missing-logo fallback", async ({ page }) => {
    const failed = await installFixtures(page, { state: "error" });
    await page.goto(`/${PAGE_SLUG}`);
    await expect.poll(() => page.locator("body").textContent())
      .toMatch(/Directory fixture unavailable|directory carousel fetch failed|couldn't load directory|failed to load/i);
    await expect(carousel(page)).toHaveCount(0);
    await expectDirectoryRequest(failed);

    await page.unroute("**/*");
    const empty = await installFixtures(page, { state: "empty" });
    await page.goto(`/${PAGE_SLUG}`);
    await expect.poll(() => page.locator("body").textContent())
      .toMatch(/No organisations to show yet|no (directory )?(records|results)|empty|nothing to show/i);
    await expect(carouselCards(page)).toHaveCount(0);
    expect(empty.writes).toEqual([]);

    await page.unroute("**/*");
    const missingLogo = await installFixtures(page, { state: "missing-logo" });
    await page.goto(`/${PAGE_SLUG}`);
    await expect(page.getByText("Missing Logo Company", { exact: true })).toBeVisible();
    const missingLogoCard = page.getByRole("button", {
      name: "View details for Missing Logo Company",
    });
    await expect(missingLogoCard).toBeVisible();
    await expect(missingLogoCard.locator("img")).toHaveCount(0);
    await expect(page.locator("img[src='']").first()).toHaveCount(0);
    expect(missingLogo.writes).toEqual([]);
  });

  test("distinguishes fresh API seeds from stable API seeds without mutating production data", async ({ page }) => {
    const state = await installFixtures(page);
    await page.goto(`/${PAGE_SLUG}`);
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();

    const responses = await page.evaluate(async ({ slug, stableSeed }) => {
      const read = async (seed) => {
        const response = await fetch(`/api/public/dynamic-directory?mode=carousel&slug=${slug}&page=1&limit=3&seed=${seed}`);
        return { status: response.status, body: await response.json() };
      };
      return {
        stableA: await read(stableSeed),
        stableB: await read(stableSeed),
        freshA: await read("fresh-a"),
        freshB: await read("fresh-b"),
      };
    }, { slug: DIRECTORY_SLUG, stableSeed: STABLE_SEED });

    expect(responses.stableA.status).toBe(200);
    expect(responses.stableB.status).toBe(200);
    expect(responses.stableA.body).toEqual(responses.stableB.body);
    expect(responses.freshA.status).toBe(200);
    expect(responses.freshB.status).toBe(200);
    expect(responses.freshA.body.records[0].id).not.toBe(responses.freshB.body.records[0].id);
    expect(responses.stableA.body).toMatchObject({ page: 1, pageSize: 3, total: 6 });
    expect(responses.stableA.body.records[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      name: expect.any(String),
      logo_url: expect.anything(),
      description: expect.any(String),
      website_url: expect.any(String),
    }));
    expect(state.writes).toEqual([]);
  });

  test("creates one fresh random seed per mounted visit and reuses it across pages and resize", async ({ page }) => {
    const state = await installFixtures(page, {
      directoryContent: {
        randomiseOrder: true,
        autoplay: false,
        perView: { desktop: 3, tablet: 2, mobile: 1 },
      },
    });
    await page.goto(`/${PAGE_SLUG}`);
    const directory = carousel(page);
    await expect(directory).toBeVisible();
    await expectDirectoryRequest(state);
    const firstVisitRequests = () => state.requests.filter((request) => (
      request.path === "/api/public/dynamic-directory"
      && request.query.mode === "carousel"
    ));
    const firstSeed = firstVisitRequests().at(-1).query.seed;
    expect(firstSeed).toEqual(expect.any(String));
    expect(firstSeed.length).toBeGreaterThan(0);

    await carouselNext(directory).click();
    await expect(page.getByText("Stable Delta", { exact: true })).toBeVisible();
    await expect.poll(() => firstVisitRequests().length).toBeGreaterThan(1);
    expect(firstVisitRequests().at(-1).query.seed).toBe(firstSeed);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => firstVisitRequests().at(-1).query.limit).toBe("1");
    // Resizing after advancing must preserve the first item's ordinal and
    // mounted visit seed; only the request page size/page translation changes.
    await expect.poll(() => firstVisitRequests().at(-1).query.page).toBe("4");
    expect(firstVisitRequests().at(-1).query.seed).toBe(firstSeed);
    await expect(page.getByText("Stable Delta", { exact: true })).toBeVisible();
    expect(new Set(firstVisitRequests().map((request) => request.query.seed)))
      .toEqual(new Set([firstSeed]));

    await page.reload();
    await expect(page.getByText("Stable Alpha", { exact: true })).toBeVisible();
    await expect.poll(() => firstVisitRequests().at(-1).query.seed).not.toBe(firstSeed);
    expect(state.writes).toEqual([]);
  });
});

test.describe("DirectoryCarousel editor registry and preview", () => {
  test("mounts through the registry, persists inspector content, and renders desktop/mobile preview", async ({ page }) => {
    const state = await installFixtures(page, {
      directoryContent: {
        autoplay: false,
      },
    });
    await page.goto(`/CanvasPageEditor?pageId=${PAGE_ID}`);
    await expect(page.getByTestId("canvas-page-editor")).toBeVisible();

    const block = page.getByTestId(`canvas-block-${BLOCK_ID}`);
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("data-block-type", "directory-carousel");
    await block.click();

    // Registry inspectors use stable data-testid names.  The two aliases make
    // this harness tolerant of the early renderer's slug naming while still
    // requiring a real inspector field (not a static text snapshot).
    const slug = page.locator(
      "[data-testid='input-directory-carousel-slug'], [data-testid='input-directory-carousel-directory-slug'], [data-testid='select-directory-carousel-slug'], [data-testid='select-directory-carousel-directory']",
    ).first();
    await expect(slug).toBeVisible();
    if (await slug.getAttribute("data-testid") === "select-directory-carousel-directory") {
      await slug.click();
      await page.getByRole("option", { name: "Directory carousel browser directory" }).click();
    } else if (await slug.evaluate((element) => element.tagName === "INPUT" || element.tagName === "TEXTAREA")) {
      await slug.fill(DIRECTORY_SLUG);
    }

    const perView = page.getByTestId("input-directory-carousel-per-view");
    await expect(perView).toBeVisible();
    await perView.fill("2");

    const randomise = page.getByTestId("toggle-directory-carousel-randomise-order");
    await expect(randomise).toBeVisible();
    if (await randomise.getAttribute("data-state") !== "checked") await randomise.click();

    const autoplay = page.locator(
      "[data-testid='toggle-directory-carousel-autoplay'], [data-testid='toggle-directory-carousel-auto-play']",
    ).first();
    if (await autoplay.count() && await autoplay.isVisible()) {
      // Ensure editor preview does not start an interval while this test edits
      // the inspector.  A switch may already be off in the fixture.
      const checked = await autoplay.getAttribute("aria-checked");
      if (checked === "true") await autoplay.click();
    }

    await page.getByTestId("button-save").click();
    await expect.poll(() => state.writes.filter((write) => write.method === "PUT").length)
      .toBeGreaterThan(0);
    const save = state.writes.find((write) => write.method === "PUT");
    const savedContent = directoryContentFromSavedBody(save.body);
    expect(savedContent).toEqual(expect.objectContaining({
      directorySlug: DIRECTORY_SLUG,
      randomiseOrder: true,
    }));
    expect(savedContent.perView.desktop).toBe(2);

    await page.getByTestId("button-breakpoint-desktop").click();
    await page.getByTestId("button-toggle-preview").click();
    const frame = page.frameLocator("iframe[data-testid='iframe-preview']");
    await expect(frame.locator(
      "[data-testid='directory-carousel'], [data-testid='directory-carousel-renderer']",
    ).first()).toBeVisible();
    await expect(frame.getByText("Stable Alpha", { exact: true })).toBeVisible();

    await page.getByTestId("button-modal-close").click();
    await expect(page.getByTestId("dialog-preview-audit")).toBeHidden();
    await page.getByTestId("button-breakpoint-mobile").click();
    await page.getByTestId("button-toggle-preview").click();
    const mobileFrame = page.frameLocator("iframe[data-testid='iframe-preview']");
    await expect(mobileFrame.locator(
      "[data-testid='directory-carousel'], [data-testid='directory-carousel-renderer']",
    ).first()).toBeVisible();
    await expect(mobileFrame.getByText("Stable Alpha", { exact: true })).toBeVisible();
    expect(state.writes.filter((write) => write.method !== "PUT")).toEqual([]);
  });
});

import { test, expect } from "@playwright/test";

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000"),
).origin;

const TENANT = { id: "tenant-task1925", name: "Task 1925 Tenant", slug: "task1925" };
const MEMBER = {
  id: "member-task1925",
  email: "member.task1925@example.invalid",
  tenant_id: TENANT.id,
  organization_id: null,
  role_id: "role-task1925",
};
const MICROSITE = {
  id: "microsite-task1925",
  name: "Task 1925 Microsite",
  path_prefix: "branch",
  home_slug: "branch-home",
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

function htmlBlock(id, copy, y = 0) {
  return {
    id,
    type: "custom-html",
    name: id,
    geom: { x: 0, y, w: 900, h: 120 },
    bp: {
      desktop: { x: 0, y, w: 900, h: 120 },
      tablet: { x: 0, y, w: 700, h: 120 },
      mobile: { x: 0, y, w: 350, h: 120 },
    },
    style: { background: "#fff", opacity: 1, zIndex: 1 },
    content: { html: `<p data-copy="${id}">${copy}</p>` },
  };
}

function canvasDesign(id, copy) {
  return {
    version: 1,
    root: {
      background: null,
      groups: [],
      guides: { vertical: [], horizontal: [] },
      sections: [{ id: `section-${id}`, type: "section", children: [htmlBlock(`copy-${id}`, copy)] }],
    },
  };
}

function pageRecord(slug, {
  chrome = "both",
  copy = `Content for ${slug}`,
  hideChrome = false,
  status = "published",
  micrositeId = null,
} = {}) {
  return {
    id: `page-${slug}`,
    slug,
    title: `Title ${slug}`,
    meta_title: `Metadata ${slug}`,
    meta_description: `Description ${slug}`,
    status,
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: chrome,
    hide_chrome: hideChrome,
    microsite_id: micrositeId,
    tenant_id: TENANT.id,
    canvas_design: canvasDesign(slug, copy),
  };
}

function ieditPageRecord(slug, {
  chrome = "both",
  copy,
  hideChrome = false,
} = {}) {
  return {
    ...pageRecord(slug, { chrome, hideChrome }),
    builder_type: "iedit",
    canvas_design: undefined,
    __element: {
      id: `element-${slug}`,
      page_id: `page-${slug}`,
      element_type: "text_block",
      display_order: 1,
      content: { heading: copy, text: `<p>${copy}</p>` },
      settings: {},
    },
  };
}

const defaultPages = {
  both: pageRecord("both", { chrome: "both" }),
  header: pageRecord("header", { chrome: "header" }),
  footer: pageRecord("footer", { chrome: "footer" }),
  none: pageRecord("none", { chrome: "none" }),
  legacy: pageRecord("legacy", { chrome: "both", hideChrome: true }),
  alpha: pageRecord("alpha", { chrome: "both", copy: "Alpha route content" }),
  beta: pageRecord("beta", { chrome: "none", copy: "Beta route content" }),
  slow: pageRecord("slow", { chrome: "both", copy: "Slow stale content" }),
  "branch-home": pageRecord("branch-home", {
    chrome: "both",
    copy: "Microsite home content",
    micrositeId: MICROSITE.id,
  }),
  "branch-page": pageRecord("branch-page", {
    chrome: "both",
    copy: "Microsite page content",
    micrositeId: MICROSITE.id,
  }),
  "root-home": pageRecord("root-home", { chrome: "both", copy: "Root home route content" }),
};

function standardBranding(name = TENANT.name) {
  return {
    id: TENANT.id,
    name,
    primaryColor: "#155e75",
    logoUrl: null,
    footerSource: "standard",
    footerConfig: {
      backgroundColor: "#102a43",
      textColor: "#ffffff",
      copyrightText: "Task 1925 standard footer",
    },
    headerConfig: {},
    platformBranding: { enabled: false },
  };
}

async function installFixtures(page, options = {}) {
  const state = {
    auth: options.auth || "guest",
    authDelayMs: options.authDelayMs || 0,
    pages: { ...defaultPages, ...(options.pages || {}) },
    pageDelays: { ...(options.pageDelays || {}) },
    pageFailures: new Set(options.pageFailures || []),
    requests: [],
    unexpected: [],
    writes: [],
    external: [],
    branding: options.branding || standardBranding(),
    brandingDelayMs: options.brandingDelayMs || 0,
    micrositesDelayMs: options.micrositesDelayMs || 0,
    articleMetadataDelayMs: options.articleMetadataDelayMs || 0,
    micrositesFailure: !!options.micrositesFailure,
    forms: { ...(options.forms || {}) },
    homeSlug: options.homeSlug || "root-home",
  };

  await page.addInitScript(() => {
    localStorage.removeItem("agcas_member");
    localStorage.removeItem("agcas_organization");
    window.__task1925ChromeInsertions = [];
    window.__task1925InstallChromeObserver = () => {
      if (window.__task1925ChromeObserver || !document.documentElement) return;
      const record = (node) => {
        if (!(node instanceof Element)) return;
        const candidates = [
          ...(node.matches("header,footer") ? [node] : []),
          ...node.querySelectorAll("header,footer"),
        ];
        for (const element of candidates) {
          window.__task1925ChromeInsertions.push({
            tag: element.tagName.toLowerCase(),
            testid: element.getAttribute("data-testid"),
            path: location.pathname + location.search,
            at: performance.now(),
          });
        }
      };
      window.__task1925ChromeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) record(node);
        }
      });
      window.__task1925ChromeObserver.observe(document.documentElement, { childList: true, subtree: true });
    };
    window.__task1925InstallChromeObserver();
    document.addEventListener("readystatechange", window.__task1925InstallChromeObserver);
  });

  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.origin !== APP_ORIGIN) {
      // PublicLayout deliberately declares these static font assets. Keep them
      // inert and local to the fixture; every other external origin is an
      // unexpected escape and is both recorded and blocked.
      if (["fonts.googleapis.com", "fonts.gstatic.com", "teeone.pythonanywhere.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      if (url.hostname === "cdnjs.cloudflare.com") {
        return route.fulfill({ status: 200, contentType: "text/css", body: "" });
      }
      if (url.hostname === "js.stripe.com" || url.hostname === "va.vercel-scripts.com") {
        return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
      }
      if (url.hostname.endsWith(".supabase.co")) {
        return url.pathname.includes("/storage/")
          ? route.fulfill({ status: 404, body: "" })
          : json(route, []);
      }
      state.external.push(`${method} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();

    const path = url.pathname;
    const key = `${method} ${path}${url.search}`;
    state.requests.push(key);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(key);
      return json(route, { error: `Task 1925 fixture blocks writes: ${key}` }, 599);
    }

    if (path === "/api/auth/me") {
      if (state.authDelayMs) await new Promise((resolve) => setTimeout(resolve, state.authDelayMs));
      if (state.auth === "member") return json(route, MEMBER);
      return json(route, null, 401);
    }
    if (path === "/api/auth/tenant-user-me") {
      if (state.auth === "admin") {
        return json(route, {
          authenticated: true,
          tenantUser: { id: "admin-task1925", tenant_id: TENANT.id },
          tenant: TENANT,
        });
      }
      return json(route, { authenticated: false }, 401);
    }
    if (path === `/api/entities/Role/${MEMBER.role_id}`) {
      return json(route, { id: MEMBER.role_id, name: "Member", excluded_features: [] });
    }
    if (path === "/api/entities/Role") {
      return json(route, [{ id: MEMBER.role_id, name: "Member", excluded_features: [] }]);
    }
    if (path === "/api/entities/Member") return json(route, [MEMBER]);
    if (path === "/api/entities/RoleAccessItem") return json(route, []);
    if (path === "/api/entities/MemberGroupAssignment") return json(route, []);
    if (path === "/api/entities/PortalMenu") return json(route, []);
    if (path === "/api/entities/Booking") return json(route, []);
    if (path === "/api/entities/SystemSettings") return json(route, []);
    if (path === "/api/public/ai-help-persona") return json(route, { enabled: false });
    if (path === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (path === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (path === "/api/admin/form-submissions/stats") return json(route, {});
    if (path === "/api/zoom/webinars") return json(route, []);
    if (path === "/api/bookmarks/enriched") return json(route, { bookmarks: [] });
    if (path === "/api/bookmarks") return json(route, []);
    if (path === "/api/public/tenant-branding") {
      if (state.brandingDelayMs) await new Promise((resolve) => setTimeout(resolve, state.brandingDelayMs));
      const microsite = url.searchParams.get("microsite");
      return json(route, {
        success: true,
        branding: microsite === MICROSITE.path_prefix
          ? {
            ...state.branding,
            name: "Task 1925 Microsite Brand",
            footerConfig: {
              ...state.branding.footerConfig,
              backgroundColor: "#4c1d95",
              copyrightText: "Task 1925 microsite footer",
            },
            microsite: MICROSITE,
          }
          : state.branding,
      });
    }
    if (path === "/api/public/microsites") {
      if (state.micrositesDelayMs) await new Promise((resolve) => setTimeout(resolve, state.micrositesDelayMs));
      return state.micrositesFailure
        ? json(route, { error: "Fixture microsite metadata unavailable" }, 503)
        : json(route, { microsites: [MICROSITE] });
    }
    if (path === "/api/public/system-settings") {
      if (url.searchParams.get("key") === "article_display_name" && state.articleMetadataDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.articleMetadataDelayMs));
      }
      return json(route, []);
    }
    if (path === "/api/public/article-settings") return json(route, {});
    if (path === "/api/public/navigation-items") {
      const suffix = url.searchParams.get("microsite") ? "microsite" : "tenant";
      return json(route, [
        { id: `header-${suffix}`, label: `${suffix} header navigation`, url: "/", location: "header", is_active: true },
        { id: `footer-${suffix}`, label: `${suffix} footer navigation`, url: "/", location: "footer", is_active: true },
      ]);
    }
    if (path === "/api/public/banners") return json(route, []);
    if (path === "/api/public/typography-styles") return json(route, []);
    if (path === "/api/entities/TypographyStyle") return json(route, []);
    if (path === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (path === "/api/public/installed-fonts") return json(route, []);
    if (path === "/api/tenant-canvas-theme") return json(route, { theme: null });
    if (path === "/api/public/form-consent-message") return json(route, { message: null });
    if (path === "/api/public/platform-defaults") {
      return json(route, { platformBrandingText: "Fixture platform", platformBrandingUrl: "https://example.invalid" });
    }
    if (path === "/api/public/portal-branding") return json(route, { homePageSlug: state.homeSlug });
    if (path === "/api/public/canvas-symbols" || path === "/api/canvas-symbols") {
      return json(route, { symbols: [] });
    }
    if (path.startsWith("/api/redirects/resolve")) return json(route, { found: false });
    if (path.startsWith("/api/public/form/")) {
      const slug = decodeURIComponent(path.slice("/api/public/form/".length));
      return state.forms[slug]
        ? json(route, state.forms[slug])
        : json(route, { error: "No fixture form" }, 404);
    }
    if (path === "/api/public/form-payment-providers") return json(route, { providers: [] });

    if (path.startsWith("/api/public/page/")) {
      const slug = decodeURIComponent(path.slice("/api/public/page/".length));
      if (state.pageDelays[slug]) {
        await new Promise((resolve) => setTimeout(resolve, state.pageDelays[slug]));
      }
      if (state.pageFailures.has(slug)) return json(route, { error: "Fixture page failure" }, 503);
      const found = state.pages[slug];
      const microsite = url.searchParams.get("microsite");
      const correctlyScoped = found && (
        (!found.microsite_id && !microsite)
        || (found.microsite_id === MICROSITE.id && microsite === MICROSITE.path_prefix)
      );
      if (!correctlyScoped || found.status !== "published") return json(route, { error: "Not found" }, 404);
      return json(route, {
        success: true,
        page: found,
        elements: found.__element ? [found.__element] : [],
        symbols: [],
      });
    }

    if (path === "/api/entities/IEditPage") {
      const slug = url.searchParams.get("slug")
        || url.searchParams.get("filter[slug]")
        || url.searchParams.get("filter")?.match(/"slug":"([^"]+)"/)?.[1];
      const candidates = Object.values(state.pages).filter((entry) => !slug || entry.slug === slug);
      return json(route, candidates);
    }
    if (path === "/api/entities/IEditPageElement") {
      return json(route, Object.values(state.pages).flatMap((entry) => entry.__element ? [entry.__element] : []));
    }

    state.unexpected.push(key);
    return json(route, { error: `Unexpected Task 1925 API read: ${key}` }, 599);
  });

  return state;
}

async function expectChrome(page, { header, footer }) {
  await expect(page.locator("header")).toHaveCount(header ? 1 : 0);
  await expect(page.locator("footer")).toHaveCount(footer ? 1 : 0);
}

async function expectChromeInsertionHistory(page, { header, footer }) {
  const tags = await page.evaluate(() => window.__task1925ChromeInsertions.map((entry) => entry.tag));
  expect(tags.includes("header")).toBe(header);
  expect(tags.includes("footer")).toBe(footer);
}

async function expectNoFixtureEscape(state) {
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  // PublicLayout contains external font declarations, but declarations are not
  // traffic. Any actual cross-origin request is blocked and remains observable.
  expect(state.external).toEqual([]);
}

test("task1925 all public_chrome values and legacy hide_chrome compose one real app layout", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  const cases = [
    ["both", true, true],
    ["header", true, false],
    ["footer", false, true],
    ["none", false, false],
    ["legacy", false, false],
  ];
  for (const [slug, header, footer] of cases) {
    await page.goto(`/${slug}`);
    await expect(page.getByText(`Content for ${slug}`, { exact: true })).toBeVisible();
    await expectChrome(page, { header, footer });
    await expectChromeInsertionHistory(page, { header, footer });
    expect(await page.locator("#main-content").count()).toBeLessThanOrEqual(1);
  }
  await page.goto("/");
  await expect(page.getByText("Root home route content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: true, footer: true });
  await page.screenshot({ path: testInfo.outputPath("task1925-root-home-fixture.png"), fullPage: true });
  await expectNoFixtureEscape(state);
});

test("task1925 route decision never mounts chrome while guest auth is delayed", async ({ page }) => {
  const state = await installFixtures(page, { authDelayMs: 1_800 });
  const navigation = page.goto("/none");
  await expect.poll(() => state.requests.some((request) => request === "GET /api/auth/me")).toBe(true);
  // Span multiple ordinary query/render intervals rather than inspecting one
  // lucky frame. The observer catches even chrome inserted and removed between
  // polls; DOM assertions make the current state explicit as well.
  for (let elapsed = 0; elapsed < 1_200; elapsed += 100) {
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__task1925ChromeInsertions)).toEqual([]);
    await expectChrome(page, { header: false, footer: false });
  }
  await navigation;
  await expect(page.getByText("Content for none", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__task1925ChromeInsertions)).toEqual([]);
  await expectNoFixtureEscape(state);
});

test("task1925 returning from legacy blank to a static page restores exactly its requested chrome", async ({ page }) => {
  const staticPage = {
    ...pageRecord("static-return", { chrome: "header" }),
    builder_type: "ai_static",
    canvas_design: undefined,
    static_html: '<section><h1>Static page after blank route</h1></section>',
    static_css: "",
  };
  const state = await installFixtures(page, { pages: { "static-return": staticPage } });
  await page.goto("/legacy");
  await expectChrome(page, { header: false, footer: false });
  await page.evaluate(() => {
    history.pushState({}, "", "/static-return");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByTestId("static-page-static-return")).toContainText("Static page after blank route");
  await expectChrome(page, { header: true, footer: false });
  await expectNoFixtureEscape(state);
});

test("task1925 returning from blank to a member page restores the portal composition", async ({ page }) => {
  const portalPage = {
    ...pageRecord("portal-return", { copy: "Portal page after blank route" }),
    layout_type: "member",
  };
  const state = await installFixtures(page, {
    auth: "member",
    pages: { "portal-return": portalPage },
  });
  await page.goto("/legacy");
  await expectChrome(page, { header: false, footer: false });
  await page.evaluate(() => {
    history.pushState({}, "", "/portal-return");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Portal page after blank route", { exact: true })).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
  // The portal has its own semantic header/sidebar footer. Distinguish it from
  // PublicHeader by the tenant-name homepage link rather than generic tags.
  await expect(page.getByRole("link", { name: TENANT.name })).toHaveCount(0);
  await expectNoFixtureEscape(state);
});

test("task1925 known built-in PublicAbout restores public shell after a blank page", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/legacy");
  await expectChrome(page, { header: false, footer: false });
  await page.evaluate(() => {
    history.pushState({}, "", "/PublicAbout");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "About AGCAS" })).toBeVisible();
  await expectChrome(page, { header: true, footer: true });
  await expectNoFixtureEscape(state);
});

for (const [name, delays] of [
  ["page response", { pageDelays: { none: 1_500 } }],
  ["article metadata", { articleMetadataDelayMs: 1_500 }],
  ["microsite list", { micrositesDelayMs: 1_500 }],
  ["tenant branding", { brandingDelayMs: 1_500 }],
]) {
  test(`task1925 delayed ${name} never inserts chrome before the none-page decision`, async ({ page }) => {
    const state = await installFixtures(page, delays);
    const navigation = page.goto("/none");
    await expect.poll(() => state.requests.some((request) => request === "GET /api/auth/me")).toBe(true);
    for (let elapsed = 0; elapsed < 900; elapsed += 100) {
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.__task1925ChromeInsertions)).toEqual([]);
    }
    await navigation;
    await expect(page.getByText("Content for none", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__task1925ChromeInsertions)).toEqual([]);
    await expectNoFixtureEscape(state);
  });
}

test("task1925 failed route metadata shows terminal unavailable UI without page request or chrome", async ({ page }) => {
  const state = await installFixtures(page, { micrositesFailure: true });
  await page.goto("/both");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await expectChrome(page, { header: false, footer: false });
  expect(state.requests.some((request) => request.startsWith("GET /api/public/page/both"))).toBe(false);
  await expectNoFixtureEscape(state);
});

test("task1925 route metadata and standard tenant branding follow page navigation", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/alpha");
  await expect(page).toHaveTitle("Metadata alpha");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Description alpha");
  await expect(page.locator("footer")).toHaveCSS("background-color", "rgb(16, 42, 67)");

  await page.evaluate(() => {
    history.pushState({}, "", "/header");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Content for header", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Metadata header");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Description header");
  await expectChrome(page, { header: true, footer: false });
  await expectNoFixtureEscape(state);
});

test("task1925 configured reusable Canvas footer is the only footer", async ({ page }) => {
  const branding = {
    ...standardBranding(),
    footerSource: "canvas",
    canvasFooter: {
      id: "footer-task1925",
      design: canvasDesign("reusable-footer", "Reusable configured footer content"),
    },
  };
  const state = await installFixtures(page, { branding });
  await page.goto("/header");
  await expect(page.getByText("Content for header", { exact: true })).toBeVisible();
  await expectChromeInsertionHistory(page, { header: true, footer: false });
  await page.goto("/none");
  await expect(page.getByText("Content for none", { exact: true })).toBeVisible();
  await expectChromeInsertionHistory(page, { header: false, footer: false });
  await page.goto("/both");
  await expect(page.getByTestId("canvas-site-footer")).toHaveCount(1);
  await expect(page.getByText("Reusable configured footer content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: true, footer: true });
  await expectNoFixtureEscape(state);
});

test("task1925 ViewPage slug uses route layout once and honors legacy/page chrome", async ({ page }) => {
  const viewBoth = ieditPageRecord("view-both", { chrome: "both", copy: "ViewPage composed content" });
  const viewHidden = ieditPageRecord("view-hidden", { hideChrome: true, copy: "ViewPage hidden content" });
  const state = await installFixtures(page, { pages: { "view-both": viewBoth, "view-hidden": viewHidden } });

  await page.goto("/ViewPage?slug=view-both");
  await expect(page.getByRole("heading", { name: "ViewPage composed content" })).toBeVisible();
  await expectChrome(page, { header: true, footer: true });
  await expect(page.locator("#main-content")).toHaveCount(1);

  await page.goto("/ViewPage?slug=view-hidden");
  await expect(page.getByRole("heading", { name: "ViewPage hidden content" })).toBeVisible();
  await expectChrome(page, { header: false, footer: false });
  await expectNoFixtureEscape(state);
});

test("task1925 ViewPage canvas dispatch honors none chrome without transient insertion", async ({ page }) => {
  const canvasNone = pageRecord("view-canvas-none", {
    chrome: "none",
    copy: "ViewPage Canvas none content",
  });
  const state = await installFixtures(page, { pages: { "view-canvas-none": canvasNone } });
  await page.goto("/ViewPage?slug=view-canvas-none");
  await expect(page.getByText("ViewPage Canvas none content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: false, footer: false });
  await expectChromeInsertionHistory(page, { header: false, footer: false });
  expect(state.requests.some((request) => request.startsWith("GET /api/entities/IEditPage"))).toBe(true);
  await expectNoFixtureEscape(state);
});

test("task1925 microsite page and bare-prefix home use scoped requests and branding", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/branch/branch-page");
  await expect(page.getByText("Microsite page content", { exact: true })).toBeVisible();
  await expect(page.locator("footer")).toHaveCSS("background-color", "rgb(76, 29, 149)");
  await expect(page.getByRole("link", { name: "Task 1925 Microsite Brand" })).toHaveAttribute("href", "/branch/branch-home");

  await page.goto("/branch");
  await expect(page.getByText("Microsite home content", { exact: true })).toBeVisible();
  expect(state.requests.some((request) => request.includes("GET /api/public/page/branch-home?microsite=branch"))).toBe(true);
  expect(state.requests.some((request) => request === "GET /api/public/page/branch-home")).toBe(false);
  await expectNoFixtureEscape(state);
});

test("task1925 microsite page slug colliding with built-in Events stays microsite-scoped", async ({ page }) => {
  const collision = pageRecord("Events", {
    chrome: "header",
    copy: "Microsite Events slug content",
    micrositeId: MICROSITE.id,
  });
  const state = await installFixtures(page, { pages: { Events: collision } });
  await page.goto("/branch/Events");
  await expect(page.getByText("Microsite Events slug content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: true, footer: false });
  expect(state.requests.some((request) => request.startsWith("GET /api/public/page/Events?microsite=branch"))).toBe(true);
  await expectNoFixtureEscape(state);
});

test("task1925 authorized draft preview selects authenticated page read without public leakage", async ({ page }) => {
  const draft = pageRecord("draft-preview", {
    chrome: "none",
    copy: "Authorized draft preview content",
    status: "draft",
  });
  const state = await installFixtures(page, { auth: "admin", pages: { "draft-preview": draft } });
  await page.goto("/draft-preview?_canvasPreview=task1925");
  await expect(page.getByText("Authorized draft preview content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: false, footer: false });
  expect(state.requests.some((request) => request.startsWith("GET /api/entities/IEditPage"))).toBe(true);
  expect(state.requests.some((request) => request.startsWith("GET /api/public/page/draft-preview"))).toBe(false);
  await expectNoFixtureEscape(state);
});

test("task1925 authorized microsite draft preview keeps authenticated lookup scoped", async ({ page }) => {
  const draft = pageRecord("branch-draft", {
    chrome: "none",
    copy: "Authorized microsite draft content",
    status: "draft",
    micrositeId: MICROSITE.id,
  });
  const state = await installFixtures(page, { auth: "admin", pages: { "branch-draft": draft } });
  await page.goto("/branch/branch-draft?_canvasPreview=task1925-microsite");
  await expect(page.getByText("Authorized microsite draft content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: false, footer: false });
  const authenticatedRead = state.requests.find((request) => request.startsWith("GET /api/entities/IEditPage"));
  expect(authenticatedRead).toContain(encodeURIComponent(MICROSITE.id));
  expect(state.requests.some((request) => request.startsWith("GET /api/public/page/branch-draft"))).toBe(false);
  await expectNoFixtureEscape(state);
});

test("task1925 back/forward, cached loads, and rapid stale response keep current route chrome", async ({ page }) => {
  const state = await installFixtures(page, { pageDelays: { slow: 800 } });
  await page.goto("/alpha");
  await expect(page.getByText("Alpha route content", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    history.pushState({}, "", "/slow");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    history.pushState({}, "", "/beta");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Beta route content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: false, footer: false });
  await page.waitForTimeout(900);
  await expect(page.getByText("Slow stale content", { exact: true })).toHaveCount(0);
  await expectChrome(page, { header: false, footer: false });

  await page.goBack();
  await expect(page.getByText("Slow stale content", { exact: true })).toBeVisible();
  await expectChrome(page, { header: true, footer: true });
  await page.goBack();
  await expect(page.getByText("Alpha route content", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByText("Slow stale content", { exact: true })).toBeVisible();
  await expectNoFixtureEscape(state);
});

test("task1925 DynamicPage pretty-form fallback preserves blank-layout input across route decision refresh", async ({ page }) => {
  const form = {
    id: "form-state-task1925",
    slug: "form-state",
    name: "State preservation form",
    description: "Exercises the real FormView route under a new route decision token.",
    fields: [{
      id: "answer-task1925",
      type: "text",
      label: "Preserved answer",
      required: false,
    }],
    pages: [],
    visibility_rules: [],
    entity_pipelines: {},
    require_authentication: false,
    is_active: true,
    form_type: "application",
    blank_layout: true,
  };
  const state = await installFixtures(page, { forms: { "form-state": form } });
  await page.goto("/form-state");
  const input = page.getByRole("textbox");
  await expect(input).toBeVisible();
  await input.fill("Keep this value across the decision refresh");
  await page.evaluate(() => {
    history.replaceState({}, "", "/form-state?route_token=2");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(input).toHaveValue("Keep this value across the decision refresh");
  await expectChrome(page, { header: false, footer: false });
  await expectChromeInsertionHistory(page, { header: false, footer: false });
  await expectNoFixtureEscape(state);
});

test("task1925 missing and failed page reads settle to visible not-found without mutations", async ({ page }) => {
  const state = await installFixtures(page, { pageFailures: ["broken"] });
  await page.goto("/missing-task1925");
  await expect(page.getByTestId("page-not-found")).toBeVisible();
  await expectChrome(page, { header: false, footer: false });

  await page.goto("/broken");
  await expect(page.getByTestId("page-not-found")).toBeVisible();
  await expectChrome(page, { header: false, footer: false });
  expect(state.requests.some((request) => request.startsWith("GET /api/public/page/broken"))).toBe(true);
  await expectNoFixtureEscape(state);
});
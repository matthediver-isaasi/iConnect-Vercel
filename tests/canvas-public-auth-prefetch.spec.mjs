import { test, expect } from "@playwright/test";

const TENANT = {
  id: "tenant-canvas-prefetch",
  name: "Canvas Prefetch Fixture",
  slug: "canvas-prefetch",
};
const MEMBER = {
  id: "member-canvas-prefetch",
  email: "canvas-prefetch@example.invalid",
  tenant_id: TENANT.id,
  role_id: "role-canvas-prefetch",
  member_excluded_features: [],
};
const MEMBER_B = {
  ...MEMBER,
  id: "member-canvas-prefetch-b",
  email: "canvas-prefetch-b@example.invalid",
};
const PRIVATE_ALPHA = "Alpha private account details";
const PRIVATE_BETA = "Beta private account details";
const GUEST_COPY = "Sign in to view private account details";

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

function htmlBlock(id, html, y, extraContent = {}) {
  return {
    id,
    type: "custom-html",
    name: id,
    geom: { x: 0, y, w: 800, h: 120 },
    bp: {
      desktop: { x: 0, y, w: 800, h: 120 },
      tablet: { x: 0, y, w: 700, h: 120 },
      mobile: { x: 0, y, w: 350, h: 120 },
    },
    style: { background: "#fff", opacity: 1, zIndex: 1 },
    content: { html, ...extraContent },
  };
}

function pageRecord(slug, privateCopy, {
  hideChrome = false,
  redacted = false,
  layoutType = "public",
} = {}) {
  const protectedContent = redacted
    ? {
      memberOnly: true,
      memberOnlyRedacted: true,
      guestMessage: GUEST_COPY,
    }
    : {
      html: `<p>${privateCopy}</p>`,
      memberOnly: true,
      guestMessage: GUEST_COPY,
    };
  return {
    id: `page-${slug}`,
    slug,
    title: `Canvas ${slug}`,
    status: "published",
    builder_type: "canvas",
    layout_type: layoutType,
    public_chrome: "none",
    hide_chrome: hideChrome,
    tenant_id: TENANT.id,
    canvas_design: {
      version: 1,
      root: {
        background: null,
        groups: [],
        guides: { vertical: [], horizontal: [] },
        sections: [{
          id: `section-${slug}`,
          type: "section",
          children: [
            htmlBlock(`public-${slug}`, `<p>Public content for ${slug}</p>`, 0),
            htmlBlock(`private-${slug}`, protectedContent.html || "", 140, protectedContent),
          ],
        }],
      },
    },
  };
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function installFixture(page, {
  audience = "member",
  holdSettings = false,
  holdAuth = true,
  heldPages = [],
  holdFirstPageSlugs = [],
  publicFailure = null,
  protectedMissing = false,
  holdProtected = false,
  microsites = [],
} = {}) {
  const settingsGate = deferred();
  const authGate = deferred();
  const protectedGate = deferred();
  if (!holdProtected) protectedGate.release();
  if (!holdSettings) settingsGate.release();
  if (!holdAuth) authGate.release();

  const state = {
    audience,
    requests: [],
    completedPageReads: [],
    startedPageReads: [],
    writes: [],
    unexpected: [],
    releaseSettings: settingsGate.release,
    releaseAuth: authGate.release,
    releaseProtected: protectedGate.release,
    setAudience(nextAudience) {
      state.audience = nextAudience;
    },
  };
  const pageGates = new Map(heldPages.map((slug) => [slug, deferred()]));
  const firstPageGates = new Map(holdFirstPageSlugs.map((slug) => [slug, deferred()]));
  state.releasePage = (slug) => {
    pageGates.get(slug)?.release();
    firstPageGates.get(slug)?.release();
  };

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.__canvasPrefetchChromeInsertions = [];
    const install = () => {
      if (window.__canvasPrefetchObserver || !document.documentElement) return;
      const record = (node) => {
        if (!(node instanceof Element)) return;
        const chrome = [
          ...(node.matches("header,footer") ? [node] : []),
          ...node.querySelectorAll("header,footer"),
        ];
        for (const element of chrome) {
          window.__canvasPrefetchChromeInsertions.push({
            tag: element.tagName.toLowerCase(),
            path: location.pathname,
          });
        }
      };
      window.__canvasPrefetchObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) record(node);
        }
      });
      window.__canvasPrefetchObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    };
    install();
    document.addEventListener("readystatechange", install);
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== new URL(process.env.PLAYWRIGHT_BASE_URL
      || (process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : "http://127.0.0.1:5000")).origin) {
      if (["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com",
        "js.stripe.com", "va.vercel-scripts.com", "teeone.pythonanywhere.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();

    const key = `${method} ${url.pathname}${url.search}`;
    state.requests.push(key);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(key);
      return json(route, { error: "Fixture is read-only" }, 405);
    }

    if (url.pathname === "/api/public/system-settings") {
      if (url.searchParams.get("key") === "page_visibility_settings") {
        await settingsGate.promise;
      }
      return json(route, []);
    }
    if (url.pathname === "/api/auth/me") {
      await authGate.promise;
      if (state.audience === "member") return json(route, MEMBER);
      if (state.audience === "member-b") return json(route, MEMBER_B);
      return json(route, null, 401);
    }
    if (url.pathname === "/api/auth/tenant-user-me") {
      return json(route, { authenticated: false }, 401);
    }
    if (url.pathname === `/api/entities/Role/${MEMBER.role_id}`) {
      return json(route, {
        id: MEMBER.role_id,
        name: "Fixture member",
        excluded_features: ["admin.role-management"],
      });
    }
    if (url.pathname === "/api/entities/Role") return json(route, []);
    if (url.pathname === "/api/entities/Member") {
      if (state.audience === "member") return json(route, [MEMBER]);
      if (state.audience === "member-b") return json(route, [MEMBER_B]);
      return json(route, []);
    }
    if (url.pathname === "/api/public/microsites") return json(route, { microsites });
    if (url.pathname === "/api/entities/IEditPage") {
      await protectedGate.promise;
      return json(route, protectedMissing ? [] : [
        pageRecord("portal", `Protected portal — ${state.audience}`, { layoutType: "member" }),
      ]);
    }
    if (url.pathname === "/api/canvas-symbols") return json(route, { symbols: [] });
    if (url.pathname.startsWith("/api/public/form/")) return json(route, { error: "Form not found" }, 404);
    if (url.pathname === "/api/public/tenant-branding") {
      return json(route, {
        success: true,
        branding: {
          id: TENANT.id,
          name: TENANT.name,
          headerConfig: {},
          footerConfig: {},
          platformBranding: { enabled: false },
        },
      });
    }
    if (url.pathname === "/api/public/navigation-items") return json(route, []);
    if (url.pathname.startsWith("/api/public/page/")) {
      const slug = decodeURIComponent(url.pathname.slice("/api/public/page/".length));
      const requestAudience = state.audience;
      const requestNumber = state.startedPageReads.filter((read) => read.slug === slug).length + 1;
      state.startedPageReads.push({ slug, audience: requestAudience, requestNumber });
      if (publicFailure?.status === "aborted") return route.abort("aborted");
      if (publicFailure) return json(route, { error: publicFailure.error }, publicFailure.status);
      if (pageGates.has(slug)) await pageGates.get(slug).promise;
      if (requestNumber === 1 && firstPageGates.has(slug)) {
        await firstPageGates.get(slug).promise;
      }
      const basePrivateCopy = slug === "prefetch-beta" ? PRIVATE_BETA : PRIVATE_ALPHA;
      const privateCopy = `${basePrivateCopy} — ${requestAudience}`;
      const record = pageRecord(slug, privateCopy, {
        hideChrome: slug === "prefetch-beta",
        redacted: requestAudience === "guest",
        layoutType: slug === "prefetch-hybrid" ? "hybrid" : "public",
      });
      state.completedPageReads.push({ slug, audience: requestAudience, requestNumber });
      return json(route, { success: true, page: record, elements: [], symbols: [] });
    }
    if (url.pathname === "/api/public/canvas-symbols"
      || url.pathname === "/api/public/typography-styles"
      || url.pathname === "/api/entities/TypographyStyle"
      || url.pathname === "/api/public/banners"
      || url.pathname === "/api/public/installed-fonts"
      || url.pathname === "/api/entities/SystemSettings"
      || url.pathname === "/api/entities/RoleAccessItem"
      || url.pathname === "/api/entities/MemberGroupAssignment"
      || url.pathname === "/api/entities/PortalMenu"
      || url.pathname === "/api/entities/Booking") {
      return json(route, []);
    }
    if (url.pathname === "/api/public/article-settings"
      || url.pathname === "/api/admin/form-submissions/stats") return json(route, {});
    if (url.pathname === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (url.pathname === "/api/public/platform-defaults") return json(route, {});
    if (url.pathname === "/api/public/portal-branding") return json(route, {});
    if (url.pathname === "/api/public/ai-help-persona") return json(route, { enabled: false });
    if (url.pathname === "/api/public/form-consent-message") return json(route, { message: null });
    if (url.pathname === "/api/tenant-canvas-theme") return json(route, { theme: null });
    if (url.pathname === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (url.pathname === "/api/zoom/webinars") return json(route, []);
    if (url.pathname === "/api/bookmarks/enriched") return json(route, { bookmarks: [] });
    if (url.pathname === "/api/bookmarks") return json(route, []);
    if (url.pathname.startsWith("/api/redirects/resolve")) return json(route, { found: false });

    state.unexpected.push(key);
    return json(route, { error: `Unexpected fixture read: ${key}` }, 599);
  });

  return state;
}

async function expectNeutralBoundary(page) {
  await expect(page.locator("[aria-busy='true']").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(PRIVATE_ALPHA);
  await expect(page.locator("body")).not.toContainText(PRIVATE_BETA);
  await expect(page.locator("body")).not.toContainText("Public content for");
  await expect(page.locator("header,footer")).toHaveCount(0);
}

async function expectNoChromeEver(page) {
  await expect(page.locator("header,footer")).toHaveCount(0);
  expect(await page.evaluate(() => window.__canvasPrefetchChromeInsertions)).toEqual([]);
}

test("Canvas public transport prefetches while settings/session are delayed but consumption waits for the verified member audience", async ({ page }) => {
  const state = await installFixture(page, {
    audience: "member",
    holdSettings: true,
    holdAuth: true,
  });
  await page.goto("/prefetch-alpha", { waitUntil: "domcontentloaded" });

  await expect.poll(() => state.completedPageReads.some(({ slug }) => slug === "prefetch-alpha")).toBe(true);
  await expect.poll(
    () => state.requests.filter((request) => request.startsWith("GET /api/auth/me")).length,
  ).toBe(1);
  await expectNeutralBoundary(page);

  state.releaseSettings();
  await page.waitForTimeout(200);
  expect(state.requests.filter((request) => request.startsWith("GET /api/auth/me"))).toHaveLength(1);
  await expectNeutralBoundary(page);

  state.releaseAuth();
  await expect(page.getByText(`${PRIVATE_ALPHA} — member`, { exact: true })).toBeVisible();
  await expect(page.getByText("Public content for prefetch-alpha", { exact: true })).toBeVisible();
  await expect(page.getByText(GUEST_COPY, { exact: true })).toHaveCount(0);
  await expectNoChromeEver(page);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.startedPageReads.filter(({ slug }) => slug === "prefetch-alpha")).toHaveLength(1);
  expect(state.requests.filter(request => request.startsWith("GET /api/entities/IEditPage"))).toEqual([]);
});

const PAGE_MISS = { status: 404, error: "Page not found or not published" };
const protectedReads = state => state.requests.filter(request => request.startsWith("GET /api/entities/IEditPage"));
const formReads = state => state.requests.filter(request => request.startsWith("GET /api/public/form/"));
const redirectReads = state => state.requests.filter(request => request.startsWith("GET /api/redirects/resolve"));

test("portal public miss is fetched once across boot settlement and only then resolves the authenticated member page", async ({ page }) => {
  const state = await installFixture(page, { publicFailure: PAGE_MISS, holdSettings: true });
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.startedPageReads.length).toBe(1);
  expect(protectedReads(state)).toEqual([]);
  state.releaseSettings();
  state.releaseAuth();
  await expect(page.getByText("Protected portal — member", { exact: true })).toBeVisible();
  expect(state.startedPageReads).toHaveLength(1);
  // Private entity data is deliberately not shared across shell remounts.
  expect(protectedReads(state).length).toBeGreaterThanOrEqual(1);
  expect(formReads(state)).toEqual([]);
  expect(redirectReads(state)).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

for (const failure of [
  { status: 401, error: "Unauthorized" },
  { status: 403, error: "Forbidden" },
  { status: 500, error: "Internal server error" },
  { status: 404, error: "Tenant not found" },
  { status: 404, error: "Microsite not found" },
  { status: 404, error: "Unexpected missing resource" },
  { status: "aborted", error: "Cancelled request" },
]) {
  test(`portal ${failure.status} ${failure.error} fails closed`, async ({ page }) => {
    const state = await installFixture(page, { publicFailure: failure, holdAuth: false });
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
    expect(protectedReads(state)).toEqual([]);
    expect(formReads(state)).toEqual([]);
    expect(redirectReads(state)).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

test("unknown page waits for authenticated lookup before checking form then redirect", async ({ page }) => {
  const state = await installFixture(page, {
    publicFailure: PAGE_MISS, protectedMissing: true, holdProtected: true,
  });
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.startedPageReads.length).toBe(1);
  expect(protectedReads(state)).toEqual([]);
  expect(formReads(state)).toEqual([]);
  expect(redirectReads(state)).toEqual([]);
  state.releaseAuth();
  await expect.poll(() => protectedReads(state).length).toBe(1);
  expect(formReads(state)).toEqual([]);
  expect(redirectReads(state)).toEqual([]);
  state.releaseProtected();
  await expect.poll(() => redirectReads(state).length).toBe(1);
  expect(formReads(state)).toHaveLength(1);
  expect(state.requests.indexOf(formReads(state)[0])).toBeLessThan(state.requests.indexOf(redirectReads(state)[0]));
  expect(state.unexpected).toEqual([]);
});

test("microsite page miss never performs a bare authenticated fallback", async ({ page }) => {
  const state = await installFixture(page, {
    publicFailure: PAGE_MISS, holdAuth: false,
    microsites: [{ id: "fixture-micro", path_prefix: "fixture-micro", name: "Fixture microsite" }],
  });
  await page.goto("/fixture-micro/portal", { waitUntil: "domcontentloaded" });
  await expect.poll(() => redirectReads(state).length).toBe(1);
  expect(protectedReads(state)).toEqual([]);
  expect(formReads(state)).toEqual([]);
  expect(state.requests.find(request => request.startsWith("GET /api/public/page/portal"))).toContain("microsite=fixture-micro");
  expect(state.unexpected).toEqual([]);
});

test("unauthenticated page miss does not query protected entities", async ({ page }) => {
  const state = await installFixture(page, { audience: "guest", publicFailure: PAGE_MISS, holdAuth: false });
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect.poll(() => redirectReads(state).length).toBe(1);
  expect(protectedReads(state)).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("portal account switch invalidates miss evidence and cannot retain private member page data", async ({ page }) => {
  const state = await installFixture(page, { publicFailure: PAGE_MISS, holdAuth: false });
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Protected portal — member", { exact: true })).toBeVisible();
  const before = state.startedPageReads.length;
  state.setAudience("member-b");
  await page.evaluate(member => {
    const oldValue = localStorage.getItem("agcas_member");
    const newValue = JSON.stringify(member);
    localStorage.setItem("agcas_member", newValue);
    dispatchEvent(new StorageEvent("storage", { key: "agcas_member", oldValue, newValue }));
  }, MEMBER_B);
  await expect(page.getByText("Protected portal — member-b", { exact: true })).toBeVisible();
  await expect(page.getByText("Protected portal — member", { exact: true })).toHaveCount(0);
  expect(state.startedPageReads.length).toBeGreaterThan(before);
  state.setAudience("guest");
  await page.evaluate(() => {
    const oldValue = localStorage.getItem("agcas_member");
    localStorage.removeItem("agcas_member");
    dispatchEvent(new StorageEvent("storage", { key: "agcas_member", oldValue, newValue: null }));
  });
  await expect.poll(() => redirectReads(state).length).toBeGreaterThan(0);
  await expect(page.locator("body")).not.toContainText("Protected portal");
  expect(state.unexpected).toEqual([]);
});

test("route changes discard prefetched private payloads and a verified guest only consumes the redacted audience", async ({ page }) => {
  const state = await installFixture(page, { audience: "guest", holdAuth: true });
  await page.goto("/prefetch-alpha", { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.completedPageReads.some(({ slug }) => slug === "prefetch-alpha")).toBe(true);
  await expectNeutralBoundary(page);

  await page.evaluate(() => {
    history.pushState({}, "", "/prefetch-beta?phase=latest");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => state.completedPageReads.some(({ slug }) => slug === "prefetch-beta")).toBe(true);
  await expectNeutralBoundary(page);

  state.releaseAuth();
  await expect(page.getByText("Public content for prefetch-beta", { exact: true })).toBeVisible();
  await expect(page.getByText(GUEST_COPY, { exact: true })).toBeVisible();
  await expect(page.getByText("Public content for prefetch-alpha", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(PRIVATE_ALPHA);
  await expect(page.locator("body")).not.toContainText(PRIVATE_BETA);
  await expectNoChromeEver(page);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("hybrid member page holds one stable loading boundary and settles once into the portal layout", async ({ page }) => {
  const state = await installFixture(page, {
    audience: "member",
    holdAuth: false,
    heldPages: ["prefetch-hybrid"],
  });
  await page.goto("/prefetch-hybrid", { waitUntil: "domcontentloaded" });
  await expect.poll(
    () => state.startedPageReads.some(({ slug }) => slug === "prefetch-hybrid"),
  ).toBe(true);

  const loading = page.locator("[aria-busy='true']").first();
  await expect(loading).toBeVisible();
  await loading.evaluate((node) => { node.dataset.stableLoadingBoundary = "true"; });
  await page.waitForTimeout(300);
  await expect(page.locator("[data-stable-loading-boundary='true']")).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(PRIVATE_ALPHA);

  state.releasePage("prefetch-hybrid");
  await expect(page.getByText(`${PRIVATE_ALPHA} — member`, { exact: true })).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
  await expect(page.getByRole("link", { name: TENANT.name })).toHaveCount(0);

  await expect.poll(() => state.startedPageReads.filter(
    ({ slug }) => slug === "prefetch-hybrid",
  ).length).toBeGreaterThanOrEqual(1);
  const settledReadCount = state.startedPageReads.filter(
    ({ slug }) => slug === "prefetch-hybrid",
  ).length;
  await page.waitForTimeout(400);
  expect(state.startedPageReads.filter(
    ({ slug }) => slug === "prefetch-hybrid",
  )).toHaveLength(settledReadCount);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("account switch before initial auth, logout, late response, and same-route remount never reuse a full prior audience", async ({ page }) => {
  const state = await installFixture(page, {
    audience: "member",
    holdAuth: true,
    holdFirstPageSlugs: ["prefetch-alpha"],
  });
  await page.goto("/prefetch-alpha", { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.startedPageReads.some(
    ({ slug, audience, requestNumber }) => (
      slug === "prefetch-alpha" && audience === "member" && requestNumber === 1
    ),
  )).toBe(true);
  await expectNeutralBoundary(page);

  // Simulate another tab switching accounts before the first session request
  // resolves. The old page transport remains deliberately blocked.
  state.setAudience("member-b");
  await page.evaluate((nextMember) => {
    localStorage.setItem("agcas_member", JSON.stringify(nextMember));
    dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member",
      oldValue: JSON.stringify({ id: "member-canvas-prefetch" }),
      newValue: JSON.stringify(nextMember),
    }));
  }, MEMBER_B);
  state.releaseAuth();

  await expect(page.getByText(`${PRIVATE_ALPHA} — member-b`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${PRIVATE_ALPHA} — member`, { exact: true })).toHaveCount(0);

  // Logout while the original member-A page response is still in flight, then
  // let that response arrive. It must not overwrite the guest audience.
  state.setAudience("guest");
  await page.evaluate(() => {
    const oldValue = localStorage.getItem("agcas_member");
    localStorage.removeItem("agcas_member");
    dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member",
      oldValue,
      newValue: null,
    }));
  });
  await expect(page.getByText(GUEST_COPY, { exact: true })).toBeVisible();
  state.releasePage("prefetch-alpha");
  await expect.poll(() => state.completedPageReads.some(
    ({ slug, audience, requestNumber }) => (
      slug === "prefetch-alpha" && audience === "member" && requestNumber === 1
    ),
  )).toBe(true);
  await page.waitForTimeout(200);
  await expect(page.getByText(`${PRIVATE_ALPHA} — member`, { exact: true })).toHaveCount(0);
  await expect(page.getByText(`${PRIVATE_ALPHA} — member-b`, { exact: true })).toHaveCount(0);

  // Force a real route unmount/remount, then return to the same URL. A cached
  // full member projection must not be eligible for the now-guest audience.
  await page.evaluate(() => {
    history.pushState({}, "", "/prefetch-beta");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Public content for prefetch-beta", { exact: true })).toBeVisible();
  const guestAlphaReadsBeforeRemount = state.startedPageReads.filter(
    ({ slug, audience }) => slug === "prefetch-alpha" && audience === "guest",
  ).length;
  await page.evaluate(() => {
    history.pushState({}, "", "/prefetch-alpha");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Public content for prefetch-alpha", { exact: true })).toBeVisible();
  await expect(page.getByText(GUEST_COPY, { exact: true })).toBeVisible();
  await expect.poll(() => state.startedPageReads.filter(
    ({ slug, audience }) => slug === "prefetch-alpha" && audience === "guest",
  ).length).toBeGreaterThan(guestAlphaReadsBeforeRemount);
  await expect(page.locator("body")).not.toContainText(PRIVATE_ALPHA);
  await expectNoChromeEver(page);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
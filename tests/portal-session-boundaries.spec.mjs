import { test, expect } from "@playwright/test";

const APP_ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000").origin;
const FIVE_MINUTES = 5 * 60 * 1000;
const TENANT = { id: "tenant-session-boundary", name: "Session boundary fixture" };
const MEMBER = {
  id: "member-session-boundary",
  email: "session-boundary@example.invalid",
  first_name: "Boundary",
  last_name: "Member",
  tenant_id: TENANT.id,
  role_id: "role-session-boundary",
  organization_id: null,
  is_team_member: true,
  member_excluded_features: [],
};
const ROLE = {
  id: MEMBER.role_id,
  tenant_id: TENANT.id,
  name: "Session boundary role",
  excluded_features: [],
};

function sessionBody() {
  return {
    ...MEMBER,
    sessionRole: {
      status: "ready",
      member_id: MEMBER.id,
      tenant_id: TENANT.id,
      role_id: MEMBER.role_id,
      session_key: "fixture-session",
      role: ROLE,
    },
  };
}

function pageRecord(slug) {
  const publicPage = slug === "session-boundary-public";
  return {
    id: `page-${slug}`,
    slug,
    title: `Session boundary ${slug}`,
    status: "published",
    builder_type: "canvas",
    layout_type: publicPage ? "public" : "member",
    public_chrome: "both",
    hide_chrome: false,
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
          children: [{
            id: `copy-${slug}`,
            type: "custom-html",
            name: "Fixture content",
            geom: { x: 0, y: 0, w: 800, h: 120 },
            bp: {
              desktop: { x: 0, y: 0, w: 800, h: 120 },
              tablet: { x: 0, y: 0, w: 700, h: 120 },
              mobile: { x: 0, y: 0, w: 350, h: 120 },
            },
            style: { background: "#fff", opacity: 1, zIndex: 1 },
            content: { html: `<p>Session boundary content: ${slug}</p>` },
          }],
        }],
      },
    },
  };
}

function deferred(released = false) {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  if (released) release();
  return { promise, release };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installFixture(page) {
  const state = {
    authReads: 0,
    authStatus: 200,
    authBody: sessionBody(),
    authGate: deferred(true),
    logoutGate: deferred(false),
    logoutReads: 0,
    writes: [],
    unexpected: [],
    external: [],
    setAuth({ status = 200, body = sessionBody(), hold = false } = {}) {
      state.authStatus = status;
      state.authBody = body;
      state.authGate = deferred(!hold);
    },
    releaseAuth() {
      state.authGate.release();
    },
    releaseLogout() {
      state.logoutGate.release();
    },
  };

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== APP_ORIGIN) {
      if (["fonts.googleapis.com", "fonts.gstatic.com", "teeone.pythonanywhere.com",
        "cdnjs.cloudflare.com", "js.stripe.com", "va.vercel-scripts.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      if (url.hostname.endsWith(".supabase.co")) return route.fulfill({ status: 404, body: "" });
      state.external.push(`${method} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();

    const key = `${method} ${url.pathname}${url.search}`;
    if (method === "POST" && url.pathname === "/api/auth/logout") {
      state.logoutReads += 1;
      await state.logoutGate.promise;
      return json(route, { success: true });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(key);
      return json(route, { error: `Read-only session fixture blocked ${key}` }, 599);
    }
    if (url.pathname === "/api/auth/me") {
      state.authReads += 1;
      const gate = state.authGate;
      const status = state.authStatus;
      const body = state.authBody;
      await gate.promise;
      return json(route, body, status);
    }
    if (url.pathname === "/api/auth/tenant-user-me") {
      return json(route, { authenticated: false }, 401);
    }
    if (url.pathname.startsWith("/api/entities/Role/")) return json(route, ROLE);
    if (url.pathname === "/api/entities/Role") return json(route, [ROLE]);
    if (url.pathname === "/api/entities/PortalMenu") {
      return json(route, [{
        id: "menu-events",
        title: "Fixture workspace",
        url: "Events",
        feature_id: "fixture.workspace",
        section: "user",
        icon: "Calendar",
        display_order: 1,
        is_active: true,
      }]);
    }
    if (url.pathname === "/api/entities/Member") return json(route, [MEMBER]);
    if (url.pathname === "/api/public/page/session-boundary"
      || url.pathname === "/api/public/page/session-boundary-next"
      || url.pathname === "/api/public/page/session-boundary-public") {
      const slug = url.pathname.split("/").pop();
      return json(route, { success: true, page: pageRecord(slug), elements: [], symbols: [] });
    }
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
    if (url.pathname === "/api/public/portal-branding") {
      return json(route, { tenantName: TENANT.name, homePageSlug: "session-boundary" });
    }
    if (url.pathname === "/api/public/system-settings"
      || url.pathname === "/api/entities/SystemSettings"
      || url.pathname === "/api/entities/RoleAccessItem"
      || url.pathname === "/api/entities/MemberGroupAssignment"
      || url.pathname === "/api/entities/Booking"
      || url.pathname === "/api/entities/PageBanner"
      || url.pathname === "/api/entities/ResourceCategory"
      || url.pathname === "/api/entities/PreferenceField"
      || url.pathname === "/api/public/microsites"
      || url.pathname === "/api/public/navigation-items"
      || url.pathname === "/api/public/banners"
      || url.pathname === "/api/public/typography-styles"
      || url.pathname === "/api/entities/TypographyStyle"
      || url.pathname === "/api/public/installed-fonts"
      || url.pathname === "/api/zoom/webinars"
      || url.pathname === "/api/bookmarks"
      || url.pathname === "/api/bookmarks/enriched") return json(route, []);
    if (url.pathname === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (url.pathname === "/api/admin/form-submissions/stats") return json(route, {});
    if (url.pathname === "/api/public/article-settings") return json(route, {});
    if (url.pathname === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (url.pathname === "/api/public/platform-defaults") return json(route, {});
    if (url.pathname === "/api/public/ai-help-persona") return json(route, { enabled: false });
    if (url.pathname === "/api/public/form-consent-message") return json(route, { message: null });
    if (url.pathname === "/api/tenant-canvas-theme") return json(route, { theme: null });
    if (url.pathname === "/api/public/canvas-symbols") return json(route, { symbols: [] });
    if (url.pathname.startsWith("/api/redirects/resolve")) return json(route, { found: false });

    state.unexpected.push(key);
    return json(route, { error: `Unexpected session fixture read: ${key}` }, 599);
  });
  return state;
}

function expectReadOnlyClean(state) {
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
}

async function expectShellClosed(page) {
  // A page-owned Canvas route may show its own loading status while the route
  // decision is recomputed; either way the previous portal shell is closed.
  await expect(page.getByRole("status")).toContainText(/Loading (?:portal|page)…/);
  await expect(page.getByText(/Session boundary content:/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeHidden();
}

test("navigation before expiry reuses auth, then five-minute expiry closes the shell until revalidated", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  expect(state.authReads).toBe(1);

  await page.evaluate(() => {
    history.pushState({}, "", "/session-boundary-next");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Session boundary content: session-boundary-next", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading portal…", { exact: true })).toHaveCount(0);
  expect(state.authReads).toBe(1);

  state.setAuth({ hold: true });
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(2);
  await expectShellClosed(page);

  state.releaseAuth();
  await expect(page.getByText("Session boundary content: session-boundary-next", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeVisible();
  expect(state.authReads).toBe(2);
  expectReadOnlyClean(state);
});

test("failed expiry revalidation stays closed and Try again recovers", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();

  state.setAuth({ status: 503, body: { error: "Synthetic auth outage" } });
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(2);
  await expect(page.getByRole("alert")).toContainText("Unable to verify your session");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeHidden();

  state.setAuth();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => state.authReads).toBe(3);
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeVisible();
  expectReadOnlyClean(state);
});

test("logout closes the protected workspace before the intercepted request settles", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("button", { name: "Sign Out", exact: true }).click();
  await expect.poll(() => state.logoutReads).toBe(1);
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(/Loading (?:portal|page)…/);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);

  state.releaseLogout();
});

test("a prior member identity cannot strand a guest public destination behind the portal guard", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();

  state.setAuth({ body: null });
  await page.evaluate(() => {
    const oldValue = localStorage.getItem("agcas_member");
    localStorage.removeItem("agcas_member");
    dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member",
      oldValue,
      newValue: null,
    }));
    history.pushState({}, "", "/session-boundary-public");
    dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect.poll(() => state.authReads).toBe(2);
  await expect(page.getByText("Session boundary content: session-boundary-public", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toHaveCount(0);
  expectReadOnlyClean(state);
});
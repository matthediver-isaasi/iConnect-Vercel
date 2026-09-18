import { test, expect } from "@playwright/test";

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000"),
).origin;

const TENANT = {
  id: "tenant-sidebar-role",
  name: "Sidebar role fixture",
  slug: "sidebar-role",
};

function member(id = "member-sidebar-a", roleId = "role-sidebar-a") {
  return {
    id,
    email: `${id}@example.invalid`,
    first_name: id.endsWith("-b") ? "Member B" : "Member A",
    last_name: "Fixture",
    tenant_id: TENANT.id,
    role_id: roleId,
    organization_id: null,
    is_team_member: true,
    member_excluded_features: [],
  };
}

const MEMBER_A = member();
const MEMBER_B = member("member-sidebar-b", "role-sidebar-b");
const EXCLUDED = ["fixture.user.hidden", "fixture.admin.hidden"];

function roleFor(currentMember, excludedFeatures = EXCLUDED) {
  return {
    id: currentMember.role_id,
    name: `Verified role for ${currentMember.id}`,
    excluded_features: excludedFeatures,
  };
}

function sessionBody(status, currentMember = MEMBER_A, excludedFeatures = EXCLUDED) {
  return {
    ...currentMember,
    sessionRole: {
      status,
      member_id: currentMember.id,
      tenant_id: currentMember.tenant_id,
      role_id: currentMember.role_id,
      role: status === "ready" ? roleFor(currentMember, excludedFeatures) : null,
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

function fixturePage() {
  return {
    id: "page-sidebar-session-role",
    slug: "sidebar-session-role",
    title: "Sidebar session role fixture",
    status: "published",
    builder_type: "canvas",
    layout_type: "member",
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
          id: "section-sidebar-session-role",
          type: "section",
          children: [{
            id: "copy-sidebar-session-role",
            type: "custom-html",
            name: "Fixture content",
            geom: { x: 0, y: 0, w: 800, h: 120 },
            bp: {
              desktop: { x: 0, y: 0, w: 800, h: 120 },
              tablet: { x: 0, y: 0, w: 700, h: 120 },
              mobile: { x: 0, y: 0, w: 350, h: 120 },
            },
            style: { background: "#fff", opacity: 1, zIndex: 1 },
            content: { html: "<p>Verified sidebar fixture content</p>" },
          }],
        }],
      },
    },
  };
}

const PORTAL_MENU = [
  {
    id: "menu-user-ready",
    title: "Permitted workspace",
    url: "Events",
    feature_id: "fixture.user.ready",
    section: "user",
    icon: "Calendar",
    display_order: 1,
    is_active: true,
  },
  {
    id: "menu-user-hidden",
    title: "Hidden user reports",
    url: "History",
    feature_id: "fixture.user.hidden",
    section: "user",
    icon: "History",
    display_order: 2,
    is_active: true,
  },
  {
    id: "menu-admin-ready",
    title: "Permitted administration",
    url: "AdminSetup",
    feature_id: "fixture.admin.ready",
    section: "admin",
    icon: "Settings",
    display_order: 1,
    is_active: true,
  },
  {
    id: "menu-admin-hidden",
    title: "Hidden role controls",
    url: "RoleManagement",
    feature_id: "fixture.admin.hidden",
    section: "admin",
    icon: "Shield",
    display_order: 2,
    is_active: true,
  },
];

async function installFixture(page, {
  authBody = sessionBody("ready"),
  holdAuth = false,
  cachedMember = null,
  legacy = false,
  roleFailure = false,
  hangRole = false,
  memberLookup = true,
} = {}) {
  const initialGate = deferred(!holdAuth);
  const state = {
    authBody: legacy ? { ...MEMBER_A } : authBody,
    authGate: initialGate,
    authReads: 0,
    roleReads: 0,
    roleFailure,
    hangRole,
    roleGate: deferred(false),
    memberLookup,
    requests: [],
    writes: [],
    unexpected: [],
    external: [],
    setAuth(nextBody, { hold = false } = {}) {
      state.authBody = nextBody;
      state.authGate = deferred(!hold);
    },
    releaseAuth() {
      state.authGate.release();
    },
    setRoleFailure(value) {
      state.roleFailure = value;
    },
  };

  await page.addInitScript((cached) => {
    localStorage.clear();
    sessionStorage.clear();
    if (cached) localStorage.setItem("agcas_member", JSON.stringify(cached));
  }, cachedMember);

  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.origin !== APP_ORIGIN) {
      if (["fonts.googleapis.com", "fonts.gstatic.com", "teeone.pythonanywhere.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      if (["cdnjs.cloudflare.com", "js.stripe.com", "va.vercel-scripts.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      if (url.hostname.endsWith(".supabase.co")) return route.fulfill({ status: 404, body: "" });
      state.external.push(`${method} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();

    const key = `${method} ${url.pathname}${url.search}`;
    state.requests.push(key);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(key);
      return json(route, { error: `Read-only sidebar fixture blocked ${key}` }, 599);
    }

    if (url.pathname === "/api/auth/me") {
      state.authReads += 1;
      const body = state.authBody;
      const gate = state.authGate;
      await gate.promise;
      return json(route, body);
    }
    if (url.pathname === "/api/auth/tenant-user-me") {
      return json(route, { authenticated: false }, 401);
    }
    if (url.pathname.startsWith("/api/entities/Role/")) {
      state.roleReads += 1;
      if (state.hangRole) await state.roleGate.promise;
      if (state.roleFailure) return json(route, { error: "Synthetic legacy role failure" }, 503);
      const roleId = decodeURIComponent(url.pathname.split("/").pop());
      const currentMember = roleId === MEMBER_B.role_id ? MEMBER_B : MEMBER_A;
      return json(route, roleFor(currentMember));
    }
    if (url.pathname === "/api/entities/Role") {
      state.roleReads += 1;
      if (state.hangRole) await state.roleGate.promise;
      if (state.roleFailure) return json(route, { error: "Synthetic legacy role failure" }, 503);
      return json(route, [roleFor(MEMBER_A), roleFor(MEMBER_B)]);
    }
    if (url.pathname === "/api/entities/PortalMenu") return json(route, PORTAL_MENU);
    if (url.pathname === "/api/entities/Member") {
      return json(route, state.memberLookup ? [MEMBER_A, MEMBER_B] : []);
    }
    if (url.pathname === "/api/public/page/sidebar-session-role") {
      return json(route, { success: true, page: fixturePage(), elements: [], symbols: [] });
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
      return json(route, { tenantName: TENANT.name, homePageSlug: "sidebar-session-role" });
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
    return json(route, { error: `Unexpected sidebar fixture read: ${key}` }, 599);
  });

  return state;
}

const permittedUser = (page) => page.getByRole("link", { name: "Permitted workspace", exact: true });
const permittedAdmin = (page) => page.getByRole("link", { name: "Permitted administration", exact: true });
const hiddenUser = (page) => page.getByText("Hidden user reports", { exact: true });
const hiddenAdmin = (page) => page.getByText("Hidden role controls", { exact: true });

async function expectNoPrivilegedNavigation(page) {
  await expect(permittedUser(page)).toHaveCount(0);
  await expect(permittedAdmin(page)).toHaveCount(0);
  await expect(hiddenUser(page)).toHaveCount(0);
  await expect(hiddenAdmin(page)).toHaveCount(0);
}

async function expectReadyNavigation(page) {
  await expect(permittedUser(page)).toBeVisible();
  await expect(permittedAdmin(page)).toBeVisible();
  await expect(hiddenUser(page)).toHaveCount(0);
  await expect(hiddenAdmin(page)).toHaveCount(0);
}

function expectReadOnlyClean(state) {
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
}

test("trusted ready session snapshot renders permitted desktop and mobile navigation without any Role GET", async ({ page }, testInfo) => {
  const state = await installFixture(page, { hangRole: true });
  await page.goto("/sidebar-session-role");
  await expect(page.getByText("Verified sidebar fixture content", { exact: true })).toBeVisible();
  await expectReadyNavigation(page);
  expect(state.roleReads).toBe(0);
  expect(state.requests.some((entry) => /^GET \/api\/entities\/Role(?:\/|\?|$)/.test(entry))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("sidebar-ready-menu.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("button-mobile-menu").click();
  const mobileSheet = page.getByRole("dialog");
  await expect(mobileSheet.getByRole("link", { name: "Permitted workspace", exact: true })).toBeVisible();
  await expect(mobileSheet.getByRole("link", { name: "Permitted administration", exact: true })).toBeVisible();
  await expect(mobileSheet.getByText("Hidden user reports", { exact: true })).toHaveCount(0);
  await expect(mobileSheet.getByText("Hidden role controls", { exact: true })).toHaveCount(0);
  expect(state.roleReads).toBe(0);
  expectReadOnlyClean(state);
});

test("missing then error role snapshots remain closed and retries can reach a ready snapshot", async ({ page }, testInfo) => {
  const state = await installFixture(page, { authBody: sessionBody("missing") });
  await page.goto("/sidebar-session-role");
  await expect(page.getByText("Navigation unavailable", { exact: true })).toBeVisible();
  await expectNoPrivilegedNavigation(page);
  await page.screenshot({ path: testInfo.outputPath("sidebar-navigation-unavailable.png"), fullPage: true });

  state.setAuth(sessionBody("error"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => state.authReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Navigation unavailable", { exact: true })).toBeVisible();
  await expectNoPrivilegedNavigation(page);

  state.setAuth(sessionBody("ready"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expectReadyNavigation(page);
  expect(state.roleReads).toBe(0);
  expectReadOnlyClean(state);
});

test("legacy response bounds the Role fallback, exposes failure, and recovers on Retry", async ({ page }) => {
  const state = await installFixture(page, { legacy: true, roleFailure: true });
  await page.goto("/sidebar-session-role");
  await expect(page.getByText("Navigation unavailable", { exact: true })).toBeVisible();
  await expectNoPrivilegedNavigation(page);
  expect(state.roleReads).toBeGreaterThan(0);

  state.setRoleFailure(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expectReadyNavigation(page);
  expect(state.roleReads).toBeGreaterThan(1);
  expectReadOnlyClean(state);
});

test("delayed auth never exposes dangerous cached navigation and an account switch rejects the old role", async ({ page }) => {
  const dangerousCache = {
    ...MEMBER_A,
    sessionExpiry: new Date(Date.now() + 60_000).toISOString(),
    role: roleFor(MEMBER_A, []),
    memberRole: roleFor(MEMBER_A, []),
  };
  const state = await installFixture(page, {
    authBody: sessionBody("ready", MEMBER_A),
    holdAuth: true,
    cachedMember: dangerousCache,
  });
  await page.goto("/sidebar-session-role", { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.authReads).toBe(1);
  await expectNoPrivilegedNavigation(page);

  state.releaseAuth();
  await expectReadyNavigation(page);

  state.setAuth(sessionBody("ready", MEMBER_B, EXCLUDED), { hold: true });
  await page.evaluate((nextMember) => {
    const oldValue = localStorage.getItem("agcas_member");
    localStorage.setItem("agcas_member", JSON.stringify(nextMember));
    dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member",
      oldValue,
      newValue: JSON.stringify(nextMember),
    }));
  }, MEMBER_B);
  await expect.poll(() => state.authReads).toBeGreaterThanOrEqual(2);
  await expectNoPrivilegedNavigation(page);
  state.releaseAuth();
  await expectReadyNavigation(page);
  await expect(page.getByText("Member B Fixture", { exact: true })).toBeVisible();
  expectReadOnlyClean(state);
});

test("reload invalidates the role projection until a fresh ready session response arrives", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/sidebar-session-role");
  await expectReadyNavigation(page);
  const readsBeforeReload = state.authReads;

  state.setAuth(sessionBody("ready"), { hold: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => state.authReads).toBeGreaterThan(readsBeforeReload);
  await expectNoPrivilegedNavigation(page);
  state.releaseAuth();
  await expectReadyNavigation(page);
  expect(state.roleReads).toBe(0);
  expectReadOnlyClean(state);
});

test("a stuck auth check eventually offers a visible retry without exposing navigation", async ({ page }) => {
  const state = await installFixture(page, {
    authBody: sessionBody("ready"),
    holdAuth: true,
    cachedMember: { ...MEMBER_A, role: roleFor(MEMBER_A, []) },
    memberLookup: false,
  });
  await page.goto("/Preferences", { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.authReads).toBe(1);
  await expectNoPrivilegedNavigation(page);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 13_000 });
  await expectNoPrivilegedNavigation(page);
  expectReadOnlyClean(state);
});
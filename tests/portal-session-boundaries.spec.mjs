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
const NEXT_MEMBER = {
  ...MEMBER,
  id: "member-session-boundary-next",
  email: "session-boundary-next@example.invalid",
  first_name: "Next",
  tenant_id: "tenant-session-boundary-next",
};
const NEXT_ROLE = {
  ...ROLE,
  tenant_id: NEXT_MEMBER.tenant_id,
  name: "Next session boundary role",
};

function sessionBody(member = MEMBER, role = ROLE) {
  return {
    ...member,
    sessionRole: {
      status: "ready",
      member_id: member.id,
      tenant_id: member.tenant_id,
      role_id: member.role_id,
      session_key: "fixture-session",
      role,
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
    hide_chrome: slug === "session-boundary-blank",
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
    pageGate: deferred(true),
    pageReads: 0,
    documents: 0,
    authReads: 0,
    authStatus: 200,
    authBody: sessionBody(),
    authGate: deferred(true),
    authAttempts: [],
    roleReads: 0,
    roleBody: ROLE,
    roleGate: deferred(true),
    roleAttempts: [],
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
    releaseAuthAttempt(attempt) {
      const request = state.authAttempts[attempt - 1];
      if (!request) throw new Error(`Auth attempt ${attempt} has not started`);
      request.gate.release();
    },
    setRole({ body = ROLE, hold = false } = {}) {
      state.roleBody = body;
      state.roleGate = deferred(!hold);
    },
    releaseRoleAttempt(attempt) {
      const request = state.roleAttempts[attempt - 1];
      if (!request) throw new Error(`Role attempt ${attempt} has not started`);
      request.gate.release();
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
    if (!url.pathname.startsWith("/api/")) {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.documents += 1;
      return route.continue();
    }

    const key = `${method} ${url.pathname}${url.search}`;
    // Layout legitimately records navigation activity. Keep this exact write
    // entirely in the fixture; all other writes remain blocked below.
    if (method === "PATCH" && url.pathname === `/api/entities/Member/${MEMBER.id}`
      && Object.keys(request.postDataJSON() || {}).join() === "last_activity") {
      return json(route, { ...MEMBER, ...request.postDataJSON() });
    }
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
      state.authAttempts.push({ gate, status, body });
      await gate.promise;
      return json(route, body, status);
    }
    if (url.pathname === "/api/auth/tenant-user-me") {
      return json(route, { authenticated: false }, 401);
    }
    if (url.pathname.startsWith("/api/entities/Role/")) {
      state.roleReads += 1;
      const gate = state.roleGate;
      const body = state.roleBody;
      state.roleAttempts.push({ gate, body });
      await gate.promise;
      return json(route, body);
    }
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
    if (url.pathname === "/api/public/page/portal"
      || url.pathname === "/api/public/page/session-boundary"
      || url.pathname === "/api/public/page/session-boundary-next"
      || url.pathname === "/api/public/page/session-boundary-blank"
      || url.pathname === "/api/public/page/session-boundary-public") {
      const slug = url.pathname.split("/").pop();
      state.pageReads += 1;
      await state.pageGate.promise;
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

test("slow /portal discovery and history navigation retain the actual shell and sidebar state", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByTestId("button-sidebar-toggle").click();
  await page.evaluate(() => {
    window.shellHeader = document.querySelector("header");
    window.shellSidebar = document.querySelector('[data-sidebar="sidebar"]');
    window.shellToggle = document.querySelector('[data-testid="button-sidebar-toggle"]');
  });
  const documents = state.documents;
  const authReads = state.authReads;
  const assertShell = async () => {
    expect(await page.evaluate(() => ({
      header: !!window.shellHeader && window.shellHeader === document.querySelector("header"),
      sidebar: !!window.shellSidebar && window.shellSidebar === document.querySelector('[data-sidebar="sidebar"]'),
      toggle: window.shellToggle === document.querySelector('[data-testid="button-sidebar-toggle"]'),
      collapsed: window.shellSidebar.closest("[data-state]").getAttribute("data-state") === "collapsed",
    }))).toEqual({ header: true, sidebar: true, toggle: true, collapsed: true });
    expect(state.authReads).toBe(authReads);
    expect(state.documents).toBe(documents);
  };
  for (const action of ["push", "back", "forward", "back", "forward"]) {
    state.pageGate = deferred(false);
    const reads = state.pageReads;
    if (action === "push") {
      await page.evaluate(() => {
        history.pushState({}, "", "/portal");
        dispatchEvent(new PopStateEvent("popstate"));
      });
    } else if (action === "back") await page.goBack();
    else await page.goForward();
    await expect.poll(() => state.pageReads).toBeGreaterThan(reads);
    await expect(page.getByRole("status")).toContainText("Loading page");
    await assertShell();
    state.pageGate.release();
    const slug = action === "back" ? "session-boundary" : "portal";
    await expect(page.getByText(`Session boundary content: ${slug}`, { exact: true })).toBeVisible();
    await assertShell();
  }
  expectReadOnlyClean(state);
});

test("confirmed public and blank destinations replace retained portal chrome", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  for (const destination of ["public", "blank"]) {
    state.pageGate = deferred(false);
    const reads = state.pageReads;
    await page.evaluate((slug) => {
      history.pushState({}, "", `/session-boundary-${slug}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, destination);
    await expect.poll(() => state.pageReads).toBeGreaterThan(reads);
    await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeVisible();
    state.pageGate.release();
    await expect(page.getByText(`Session boundary content: session-boundary-${destination}`, { exact: true })).toBeVisible();
    await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeVisible();
  }
  expect(state.authReads).toBe(1);
  expect(state.documents).toBe(1);
  expectReadOnlyClean(state);
});

async function expectShellClosed(page) {
  // A page-owned Canvas route may show its own loading status while the route
  // decision is recomputed; either way the previous portal shell is closed.
  await expect(page.getByRole("status")).toContainText(/Loading (?:portal|page)…/);
  await expect(page.getByText(/Session boundary content:/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeHidden();
}

async function prepareRetentionState(page, value) {
  await page.evaluate(() => {
    const content = [...document.querySelectorAll("p")]
      .find((node) => node.textContent.startsWith("Session boundary content:"));
    if (!content) throw new Error("Fixture portal content was not mounted");
    const fixture = document.createElement("div");
    fixture.innerHTML = `
      <label>Idle draft <input aria-label="Idle draft" /></label>
      <details>
        <summary>Idle disclosure</summary>
        <p>Open control content</p>
      </details>
      <div data-idle-scroll style="height: 100px; overflow: auto">
        <div style="height: 600px">Scrollable fixture content</div>
      </div>
    `;
    content.parentElement.append(fixture);
  });
  const input = page.getByRole("textbox", { name: "Idle draft" });
  const disclosure = page.getByText("Idle disclosure", { exact: true });
  await input.fill(value);
  await disclosure.click();
  await page.evaluate(() => {
    window.__idleFixtureInput = document.querySelector('input[aria-label="Idle draft"]');
    window.__idleFixtureScroll = document.querySelector("[data-idle-scroll]");
    window.__idleFixtureScroll.scrollTop = 120;
  });
  await expect(disclosure.locator("..")).toHaveAttribute("open", "");
  await expect.poll(() => page.evaluate(() => window.__idleFixtureScroll.scrollTop)).toBe(120);
  return input;
}

async function expectRetentionState(page, input, value, scrollTop) {
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(value);
  await expect(page.getByText("Idle disclosure", { exact: true }).locator("..")).toHaveAttribute("open", "");
  await expect.poll(() => page.evaluate(() => ({
    sameInput: window.__idleFixtureInput === document.querySelector('input[aria-label="Idle draft"]'),
    connected: window.__idleFixtureInput?.isConnected,
    scrollTop: window.__idleFixtureScroll?.scrollTop,
  }))).toEqual({ sameInput: true, connected: true, scrollTop });
}

test("slow five-minute timer revalidation keeps the active portal route mounted and interactive", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  expect(state.authReads).toBe(1);

  const input = await prepareRetentionState(page, "unsaved timer draft");
  const scrollTop = await page.evaluate(() => window.__idleFixtureScroll.scrollTop);

  state.setAuth({ hold: true });
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(2);
  await expectRetentionState(page, input, "unsaved timer draft", scrollTop);
  await input.fill("edited while timer check is pending");
  await expect(page.getByText("Loading portal…", { exact: true })).toHaveCount(0);

  state.releaseAuth();
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  await expectRetentionState(page, input, "edited while timer check is pending", scrollTop);
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeVisible();
  expect(state.authReads).toBe(2);

  state.setAuth();
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(3);
  await expectRetentionState(page, input, "edited while timer check is pending", scrollTop);
  expectReadOnlyClean(state);
});

test("overdue focus and visibility checks coalesce while retaining the second portal route", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const state = await installFixture(page);
  await page.addInitScript(() => {
    let fixtureVisibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => fixtureVisibility,
    });
    window.__setFixtureVisibility = (value) => {
      fixtureVisibility = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  await page.goto("/session-boundary-next");
  await expect(page.getByText("Session boundary content: session-boundary-next", { exact: true })).toBeVisible();
  const input = await prepareRetentionState(page, "unsaved focus draft");
  const scrollTop = await page.evaluate(() => window.__idleFixtureScroll.scrollTop);
  expect(state.authReads).toBe(1);

  await page.evaluate(() => window.__setFixtureVisibility("hidden"));
  await page.clock.fastForward(FIVE_MINUTES + 1);
  expect(state.authReads).toBe(1);

  state.setAuth({ hold: true });
  await page.evaluate(() => {
    window.__setFixtureVisibility("visible");
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => state.authReads).toBe(2);
  await expectRetentionState(page, input, "unsaved focus draft", scrollTop);
  await expect(page.getByText("Loading portal…", { exact: true })).toHaveCount(0);

  state.releaseAuth();
  await expectRetentionState(page, input, "unsaved focus draft", scrollTop);
  expect(state.authReads).toBe(2);
  expectReadOnlyClean(state);
});

test("legacy routine checks retain content while refreshing role permissions and time out closed", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const state = await installFixture(page);
  const { sessionRole: _sessionRole, ...legacyMember } = sessionBody();
  state.setAuth({ body: legacyMember });
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  await expect.poll(() => state.roleReads).toBe(1);
  const input = await prepareRetentionState(page, "legacy role draft");
  const scrollTop = await page.evaluate(() => window.__idleFixtureScroll.scrollTop);

  state.setRole({
    body: {
      ...ROLE,
      name: "Revoked legacy role",
      excluded_features: ["fixture.workspace"],
    },
    hold: true,
  });
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(2);
  await expect.poll(() => state.roleReads).toBe(2);
  await expectRetentionState(page, input, "legacy role draft", scrollTop);

  state.releaseRoleAttempt(2);
  await expect(page.getByText("Revoked legacy role", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeHidden();

  state.setRole({ hold: true });
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(3);
  await expect.poll(() => state.roleReads).toBe(3);
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("alert")).toContainText("Unable to verify your session");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toHaveCount(0);
  expectReadOnlyClean(state);
});

test("routine timeout closes access and explicit retry restores the route", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const state = await installFixture(page);
  await page.goto("/session-boundary");
  await expect(page.getByText("Session boundary content: session-boundary", { exact: true })).toBeVisible();
  const input = await prepareRetentionState(page, "timeout draft");
  const scrollTop = await page.evaluate(() => window.__idleFixtureScroll.scrollTop);

  state.setAuth({ hold: true });
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(2);
  await expectRetentionState(page, input, "timeout draft", scrollTop);

  await page.clock.fastForward(10_000);
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

test("tenant account change supersedes a held routine response and rejects its late identity", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const state = await installFixture(page);
  await page.goto("/session-boundary-next");
  await expect(page.getByText("Boundary Member", { exact: true })).toBeVisible();
  expect(state.authReads).toBe(1);

  state.setAuth({ hold: true });
  await page.clock.fastForward(FIVE_MINUTES);
  await expect.poll(() => state.authReads).toBe(2);
  await expect(page.getByText("Session boundary content: session-boundary-next", { exact: true })).toBeVisible();

  state.setAuth({ body: sessionBody(NEXT_MEMBER, NEXT_ROLE), hold: true });
  await page.evaluate((nextMember) => {
    const oldValue = localStorage.getItem("agcas_member");
    const newValue = JSON.stringify(nextMember);
    localStorage.setItem("agcas_member", newValue);
    dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member",
      oldValue,
      newValue,
    }));
  }, NEXT_MEMBER);
  await expect.poll(() => state.authReads).toBe(3);
  await expect(page.getByText("Session boundary content: session-boundary-next", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeHidden();

  state.releaseAuthAttempt(2);
  await page.clock.runFor(1);
  await expect(page.getByText("Boundary Member", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Next Member", { exact: true })).toHaveCount(0);
  expect(state.authReads).toBe(3);

  state.releaseAuthAttempt(3);
  await expect(page.getByText("Next Member", { exact: true })).toBeVisible();
  await expect(page.getByText("Boundary Member", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Session boundary content: session-boundary-next", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fixture workspace", exact: true })).toBeVisible();
  expect(state.authReads).toBe(3);
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
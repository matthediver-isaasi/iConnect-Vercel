import { test, expect } from "@playwright/test";

const TENANT = {
  id: "tenant-task4387",
  slug: "task4387-fixture",
  name: "Task 4387 Fixture",
};

const MEMBER = {
  id: "member-task4387",
  email: "task4387.member@example.invalid",
  first_name: "Task",
  last_name: "4387",
  tenant_id: TENANT.id,
  organization_id: "org-task4387",
  role_id: "role-task4387",
};

const ROLE = {
  id: MEMBER.role_id,
  tenant_id: TENANT.id,
  name: "Member",
  excluded_features: [],
  default_landing_page: "Events",
};

const PAGE_ID = "canvas-member-only-task4387";
const PAGE_SLUG = "task4387-member-only";
const SYMBOL_ID = "symbol-member-only-task4387";
const PROTECTED_COPY = "Protected member HTML — do not expose to guests";
const SYMBOL_PROTECTED_COPY = "Protected symbol HTML — do not expose to guests";
const PUBLIC_COPY = "Shared public copy";
const GUEST_COPY = "Members can see this content after signing in";

function json(route, body, status = 200, headers = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

function style() {
  return {
    background: "#ffffff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    opacity: 1,
    zIndex: 1,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 12,
    paddingLeft: 12,
  };
}

function customHtmlBlock(id, {
  x = 0,
  y = 0,
  w = 620,
  h = 150,
  html = "",
  memberOnly = false,
  redacted = false,
  mobileY = y,
} = {}) {
  const content = {
    html,
    memberOnly,
    guestMessage: GUEST_COPY,
  };
  if (redacted) {
    delete content.html;
    content.memberOnlyRedacted = true;
  }
  return {
    id,
    type: "custom-html",
    name: id,
    geom: { x, y, w, h },
    bp: {
      desktop: { x, y, w, h },
      tablet: { x: 0, y, w: Math.min(w, 700), h },
      mobile: { x: 0, y: mobileY, w: 350, h },
    },
    style: style(),
    content,
  };
}

function symbolBlock(id, { x = 0, y = 320 } = {}) {
  return {
    id,
    type: "symbol",
    name: "Protected symbol",
    geom: { x, y, w: 620, h: 120 },
    bp: {
      desktop: { x, y, w: 620, h: 120 },
      tablet: { x: 0, y, w: 700, h: 120 },
      mobile: { x: 0, y, w: 350, h: 120 },
    },
    style: style(),
    content: { symbolId: SYMBOL_ID },
  };
}

function symbolDesign({ redacted }) {
  return {
    version: 1,
    root: {
      background: null,
      groups: [],
      guides: { vertical: [], horizontal: [] },
      sections: [{
        id: "symbol-section-task4387",
        children: [
          customHtmlBlock("symbol-protected-html", {
            x: 0,
            y: 0,
            w: 620,
            h: 120,
            html: `<p>${SYMBOL_PROTECTED_COPY}</p>`,
            memberOnly: true,
            redacted,
          }),
        ],
      }],
    },
  };
}

function canvasDesign(version, { redacted = false, includeSymbol = version === 1 } = {}) {
  const blocks = [
    customHtmlBlock(`public-html-v${version}`, {
      y: 0,
      html: `<p>${PUBLIC_COPY}</p>`,
      h: 120,
    }),
    customHtmlBlock(`protected-html-v${version}`, {
      y: 150,
      html: `<p>${PROTECTED_COPY}</p>`,
      memberOnly: true,
      redacted,
    }),
  ];
  if (includeSymbol) blocks.push(symbolBlock(`protected-symbol-v${version}`));

  const section = {
    id: `section-task4387-v${version}`,
    type: "section",
    children: blocks,
  };

  if (version === 2) {
    section.layoutMode = "flow";
    section.flow = { direction: "column", gap: 18, align: "stretch" };
    section.children = blocks.map((block) => ({
      ...block,
      layoutMode: "flow",
      flow: { heightMode: "fixed", height: block.geom.h, flex: "none" },
    }));
  }

  return {
    version,
    ...(version === 2 ? { layoutMode: "flow" } : {}),
    root: {
      background: null,
      groups: [],
      guides: { vertical: [], horizontal: [] },
      ...(version === 2 ? { layout: "flow" } : {}),
      sections: [section],
    },
  };
}

function pageFixture(version, {
  redacted = false,
  status = "published",
  publicChrome = "none",
} = {}) {
  return {
    id: PAGE_ID,
    title: `Member-only HTML V${version}`,
    slug: PAGE_SLUG,
    status,
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: publicChrome,
    tenant_id: TENANT.id,
    canvas_design: canvasDesign(version, { redacted, includeSymbol: version === 1 }),
  };
}

async function installFixtures(page, {
  version,
  auth = "guest",
  unpublished = false,
  asButton = true,
  topNavTextColor = "#172554",
  publicChrome = "none",
  includeAccountNav = false,
  firstLogin = false,
  tenantSlug = TENANT.slug,
  roles = [ROLE],
  existingLoginSession = false,
}) {
  const state = {
    auth,
    version,
    requests: [],
    writes: [],
    loginCount: 0,
    roleReads: 0,
  };
  const branding = {
    id: TENANT.id,
    name: TENANT.name,
    headerConfig: {
      topNavTextColor,
      loginLink: {
        label: "Fixture Login",
        asButton,
        labelColor: "#ffffff",
        solidColor: "#1d4ed8",
        cornerRadius: 6,
        borderWidth: 1,
        borderColor: "#1e40af",
      },
    },
  };
  const fullPage = pageFixture(version, {
    redacted: false,
    status: unpublished ? "draft" : "published",
    publicChrome,
  });
  const guestPage = pageFixture(version, { redacted: true, publicChrome });

  await page.addInitScript((slug) => {
    localStorage.setItem("tenant_slug", slug);
    localStorage.removeItem("agcas_member");
    localStorage.removeItem("agcas_organization");
  }, tenantSlug);

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    // Some legacy components still call Supabase directly. Never let fixture
    // runs reach a provider (including reads) outside the application origin.
    if (url.origin !== new URL(test.info().project.use.baseURL).origin) return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();

    state.requests.push({ path, method, query: Object.fromEntries(url.searchParams.entries()) });

    if (path === "/api/auth/me") {
      if (existingLoginSession) return json(route, {
        ...MEMBER,
        sessionRole: {
          status: "ready",
          member_id: MEMBER.id,
          tenant_id: MEMBER.tenant_id,
          role_id: MEMBER.role_id,
          role: roles.find(({ id }) => id === MEMBER.role_id) || null,
        },
      });
      if (state.auth === "error") return json(route, { error: "auth lookup failed" }, 500);
      return state.auth === "member" ? json(route, MEMBER) : json(route, {});
    }
    if (path === "/api/auth/tenant-user-me") {
      return state.auth === "member"
        ? json(route, { ...MEMBER, tenant: TENANT, tenantId: TENANT.id, memberId: MEMBER.id })
        : json(route, {}, 401);
    }
    if (path === "/api/auth/tenant-public-settings") {
      return json(route, {
        success: true,
        settings: {
          member_google_login_enabled: false,
          member_portal_login_enabled: true,
        },
      });
    }
    if (path === "/api/auth/login" && method === "POST") {
      state.loginCount += 1;
      state.auth = "member";
      return json(route, { success: true, member: MEMBER, requiresPasswordChange: firstLogin });
    }
    if (path === "/api/auth/set-password" && method === "POST") {
      state.auth = "member";
      return json(route, { success: true, member: MEMBER });
    }
    if (path === "/api/entities/Role") {
      state.roleReads += 1;
      return json(route, roles);
    }
    if (path === `/api/entities/Role/${MEMBER.role_id}`) {
      return json(route, roles.find(role => role.id === MEMBER.role_id) || null);
    }
    if (path === "/api/public/portal-branding") {
      return json(route, { homePageSlug: PAGE_SLUG });
    }
    if (path === `/api/public/page/${PAGE_SLUG}`) {
      const body = state.auth === "member" && !unpublished
        ? fullPage
        : guestPage;
      return json(route, {
        success: true,
        page: body,
        elements: [],
        // Deliberately omit embedded symbols so the renderer exercises its
        // audience-aware fallback symbol request.
        symbols: [],
      }, 200, { "Cache-Control": "no-store" });
    }
    if (path === "/api/public/canvas-symbols") {
      return json(route, {
        symbols: [{
          id: SYMBOL_ID,
          design: symbolDesign({ redacted: state.auth !== "member" }),
        }],
      });
    }
    if (path === "/api/public/tenant-branding") {
      return json(route, { success: true, branding });
    }
    if (path === "/api/public/system-settings") return json(route, []);
    if (path === "/api/public/microsites") return json(route, []);
    if (path === "/api/public/navigation-items") {
      return json(route, includeAccountNav ? [{
        id: "account-nav-task4387",
        parent_id: null,
        location: "top_nav",
        link_type: "content_block",
        content_block_type: "account",
        display_order: 0,
      }] : []);
    }
    if (path === `/api/entities/IEditPage`) return json(route, [fullPage]);
    if (path === `/api/canvas-design/${PAGE_ID}`) return json(route, { page: fullPage });
    if (path.startsWith("/api/canvas-page-audits/")) {
      return json(route, method === "GET" ? { audits: [] } : { audit: {} });
    }

    // Login/Layout/Canvas issue several optional metadata reads. Keep every
    // request inside the fixture so a regression cannot quietly use real data.
    if (method === "GET") {
      if (path.includes("/branding") || path.includes("/settings")) {
        return json(route, { success: true, branding, settings: {} });
      }
      return json(route, []);
    }
    state.writes.push({ path, method, body: request.postDataJSON?.() });
    return json(route, { error: "Unexpected fixture mutation" }, 500);
  });

  return { state, fullPage, guestPage };
}

async function openPublished(page, slug = PAGE_SLUG) {
  await page.goto(`/${slug}`);
  await expect(page.locator("[data-block-type='custom-html']").first()).toBeVisible();
}

async function expectGuestSurface(page, version, { assertButton = true } = {}) {
  await expect(page.getByText(GUEST_COPY, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(PROTECTED_COPY, { exact: true })).toHaveCount(0);
  if (version === 1) {
    await expect(page.getByText(SYMBOL_PROTECTED_COPY, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(PUBLIC_COPY, { exact: true })).toBeVisible();
  await expect(page.getByTestId("member-only-guest-placeholder").first()).toBeVisible();
  const login = page.getByTestId("link-member-only-login").first();
  await expect(login).toBeVisible();
  if (assertButton) {
    await expect(login).toHaveCSS("background-color", "rgb(29, 78, 216)");
  } else {
    await expect(login).toHaveCSS("color", "rgb(15, 23, 42)");
  }
}

async function expectMemberSurface(page, version) {
  await expect(page.getByText(PROTECTED_COPY, { exact: true })).toBeVisible();
  if (version === 1) {
    await expect(page.getByText(SYMBOL_PROTECTED_COPY, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(GUEST_COPY, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("member-only-guest-placeholder")).toHaveCount(0);
}

for (const version of [1, 2]) {
  test(`task4387 V${version} desktop guest redacts member HTML and keeps public parity`, async ({ page }) => {
    const fixture = await installFixtures(page, { version, auth: "guest" });
    await openPublished(page);
    await expectGuestSurface(page, version);

    const block = page.locator(`[data-block-type='custom-html']`).first();
    const box = await block.boundingBox();
    expect(box?.width || 0).toBeGreaterThan(0);
    expect(box?.height || 0).toBeGreaterThan(0);
    expect(fixture.state.writes).toEqual([]);
  });

  test(`task4387 V${version} desktop member renders protected HTML`, async ({ page }) => {
    const fixture = await installFixtures(page, { version, auth: "member" });
    await openPublished(page);
    await expectMemberSurface(page, version);
    expect(fixture.state.requests.some(({ path }) => path === "/api/auth/me")).toBe(true);
    expect(fixture.state.writes).toEqual([]);
  });

  test(`task4387 V${version} mobile guest/member transition stays bounded`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await installFixtures(page, { version, auth: "guest" });
    await openPublished(page);
    await expectGuestSurface(page, version);

    const guestOverflow = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(guestOverflow.body).toBeLessThanOrEqual(guestOverflow.viewport + 1);

    // The audience-keyed page and symbol queries must be safe to refresh after
    // a session transition rather than keeping the guest projection forever.
    fixture.state.auth = "member";
    await page.reload();
    await expectMemberSurface(page, version);
    const memberOverflow = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(memberOverflow.body).toBeLessThanOrEqual(memberOverflow.viewport + 1);
    expect(fixture.state.writes).toEqual([]);
  });
}

for (const version of [1, 2]) {
  test(`task4387 V${version} editor stage and preview show actual HTML with guest parity`, async ({ page }) => {
    const fixture = await installFixtures(page, { version, auth: "member" });
    await page.goto(`/CanvasPageEditor?pageId=${PAGE_ID}`);
    await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
    await expect(page.getByText(PROTECTED_COPY, { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("member-only-guest-placeholder")).toHaveCount(0);

    await page.getByTestId("button-toggle-preview").click();
    const frame = page.frameLocator("iframe[data-testid='iframe-preview']");
    await expect(frame.getByText(PROTECTED_COPY, { exact: true })).toBeVisible();
    await expect(frame.getByTestId("member-only-guest-placeholder")).toHaveCount(0);

    const editorText = await page.getByText(PROTECTED_COPY, { exact: true }).first().innerText();
    const previewText = await frame.getByText(PROTECTED_COPY, { exact: true }).innerText();
    expect(editorText).toBe(previewText);
    expect(fixture.state.writes).toEqual([]);
  });
}

test("task4387 authenticated editor preview can render an unpublished draft", async ({ page }) => {
  const fixture = await installFixtures(page, {
    version: 1,
    auth: "member",
    unpublished: true,
  });
  await page.goto(`/${PAGE_SLUG}?_canvasPreview=unpublished`);
  await expect(page.getByText(PROTECTED_COPY, { exact: true })).toBeVisible();
  await expect(page.getByTestId("member-only-guest-placeholder")).toHaveCount(0);
  expect(fixture.state.requests.some(({ path }) => path === `/api/entities/IEditPage`)).toBe(true);
});

test("task4387 default plain login link stays visible on the light placeholder surface", async ({ page }) => {
  await installFixtures(page, {
    version: 1,
    auth: "guest",
    asButton: false,
    topNavTextColor: "#FFFFFF",
  });
  await openPublished(page);
  await expectGuestSurface(page, 1, { assertButton: false });
});

test("task4387 mobile header plain login link stays visible on its white drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixtures(page, {
    version: 1,
    auth: "guest",
    asButton: false,
    topNavTextColor: "#FFFFFF",
    publicChrome: "both",
    includeAccountNav: true,
  });
  await openPublished(page);
  await page.getByRole("button", { name: "Open menu" }).click();
  const mobileLogin = page.getByTestId("link-mobile-login");
  await expect(mobileLogin).toBeVisible();
  await expect(mobileLogin).toHaveCSS("color", "rgb(15, 23, 42)");
});

test("task4387 bare anonymous canvas preview cannot select the editor audience", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1, auth: "guest" });
  await page.goto(`/${PAGE_SLUG}?_canvasPreview=anonymous`);
  await expect(page.locator("[data-block-type='custom-html']").first()).toBeVisible();
  await expectGuestSurface(page, 1);

  // An editor nonce is only a preview handshake value. Without a positively
  // verified member/editor or tenant-admin session, the draft endpoint must
  // never be selected.
  expect(fixture.state.requests.some(({ path }) => path === `/api/entities/IEditPage`)).toBe(false);
});

test("task4387 primed editor preview fails closed after session expiry", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1, auth: "member" });
  await page.goto(`/${PAGE_SLUG}?_canvasPreview=primed`);
  await expect(page.getByText(PROTECTED_COPY, { exact: true })).toBeVisible();

  fixture.state.auth = "guest";
  const requestCountBeforeExpiry = fixture.state.requests.length;
  await page.reload();
  await expectGuestSurface(page, 1);
  await expect(page.getByText(PROTECTED_COPY, { exact: true })).toHaveCount(0);

  // The redaction marker in the guest projection remains authoritative after
  // the editor session disappears; no stale editor query may be reused.
  const afterExpiry = fixture.state.requests.slice(requestCountBeforeExpiry);
  expect(afterExpiry.some(({ path }) => path === `/api/entities/IEditPage`)).toBe(false);
});

test("task4387 audience transitions to guest without a document reload", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1, auth: "member" });
  let topLevelLoads = 0;
  page.on("load", () => { topLevelLoads += 1; });

  await page.goto(`/${PAGE_SLUG}?_canvasPreview=transition`);
  await expect(page.getByText(PROTECTED_COPY, { exact: true })).toBeVisible();
  const authRequestsBeforeExpiry = fixture.state.requests.filter(({ path }) => path === "/api/auth/me").length;

  fixture.state.auth = "guest";
  const navigateWithoutReload = async (url) => {
    await page.evaluate((target) => {
      window.history.pushState({}, "", target);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, url);
  };
  await navigateWithoutReload("/Home");
  await expect.poll(
    () => fixture.state.requests.filter(({ path }) => path === "/api/auth/me").length,
  ).toBeGreaterThan(authRequestsBeforeExpiry);
  await navigateWithoutReload(`/${PAGE_SLUG}?_canvasPreview=transition`);

  await expectGuestSurface(page, 1);
  expect(topLevelLoads).toBe(1);
  expect(fixture.state.writes).toEqual([]);
});

test("task4387 auth error keeps protected HTML out of the guest DOM", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 2, auth: "error" });
  await openPublished(page);
  await expectGuestSurface(page, 2);
  expect(fixture.state.writes).toEqual([]);
});

test("task4387 keyboard login validates and preserves returnTo query/hash", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1, auth: "guest" });
  await page.goto(`/${PAGE_SLUG}?view=members#protected`);
  await expect(page.getByTestId("member-only-guest-placeholder").first()).toBeVisible();

  const login = page.getByTestId("link-member-only-login").first();
  await login.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  const loginUrl = new URL(page.url());
  expect(loginUrl.searchParams.get("returnTo")).toBe(`/${PAGE_SLUG}?view=members#protected`);

  await page.getByTestId("input-email").fill(MEMBER.email);
  await page.getByTestId("input-password").fill("correct horse battery staple");
  await page.getByTestId("button-login").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/${PAGE_SLUG}`);
  expect(new URL(page.url()).search).toBe("?view=members");
  expect(new URL(page.url()).hash).toBe("#protected");
  await expectMemberSurface(page, 1);
  expect(fixture.state.writes).toEqual([]);
});

test("task4387 LoginForm rejects an external returnTo before consuming it", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1, auth: "guest" });
  await page.goto("/login?returnTo=https%3A%2F%2Fevil.example%2Fsteal%3Ftoken%3D1");
  await page.getByTestId("input-email").fill(MEMBER.email);
  await page.getByTestId("input-password").fill("correct horse battery staple");
  await page.getByTestId("button-login").click();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe("/login");
  expect(new URL(page.url()).hostname).not.toBe("evil.example");
  expect(fixture.state.writes).toEqual([]);
});

for (const mobile of [false, true]) {
  for (const source of ["/", `/${PAGE_SLUG}?view=public#intro`]) {
    test(`header ordinary login resolves role destination: ${mobile ? "mobile" : "desktop"} ${source}`, async ({ page }) => {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      const fixture = await installFixtures(page, {
        version: 1, publicChrome: "both", includeAccountNav: true,
      });
      await page.goto(source);
      if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
      const login = page.getByTestId(mobile ? "link-mobile-login" : "link-header-login");
      await expect(login).toHaveText("Fixture Login");
      await expect(login).toHaveCSS("background-color", "rgb(29, 78, 216)");
      await expect(login).toHaveAttribute("href", "/login");
      await login.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/login$/);
      // Closed drawers are translated offscreen, not display:none.
      if (mobile) await expect(page.getByTestId("link-mobile-login")).not.toBeInViewport();
      await page.getByTestId("input-email").fill(MEMBER.email);
      await page.getByTestId("input-password").fill("fixture password");
      await page.getByTestId("button-login").click();
      await expect.poll(() => new URL(page.url()).pathname.toLowerCase()).toBe("/events");
      expect(fixture.state.loginCount).toBe(1);
      expect(fixture.state.roleReads).toBeGreaterThan(0);
      expect(fixture.state.writes).toEqual([]);
    });
  }
}

// Exercise the actual LoginForm and full browser navigation, with all API
// responses isolated. Destination documents are sentinels, not live accounts.
test("BNMS demo remains directly routable", async ({ page }) => {
  test.skip(!["localhost", "127.0.0.1"].includes(new URL(test.info().project.use.baseURL).hostname),
    "Use the BNMS config: tenant-subdomain hosts override fixture localStorage.");
  const fixture = await installFixtures(page, { version: 1, tenantSlug: "bnms", auth: "member" });
  await page.goto("/BnmsMemberDemo");
  await expect(page.getByTestId("text-hero-greeting")).toBeVisible();
  await expect(page).toHaveURL(/\/BnmsMemberDemo$/);
  expect(fixture.state.writes).toEqual([]);
});

for (const flow of ["login", "existing-session", "password-setup"]) {
  for (const scenario of [
    { name: "portal slug", landing: "portal", expected: "/portal" },
    { name: "portal path", landing: "/portal", expected: "/portal" },
    { name: "different role", landing: "Resources", expected: "/Resources" },
    { name: "missing role", missingRole: true, expected: "/Preferences" },
    { name: "deliberate demo", landing: "BnmsMemberDemo", expected: "/BnmsMemberDemo" },
    { name: "GSF unchanged", tenantSlug: "gsf", landing: "portal", expected: "/MemberDemo" },
    { name: "explicit resource", landing: "portal", target: "/Resources?view=mine#details", extra: "&resourceId=fixture-resource", expected: "/Resources?view=mine&resourceId=fixture-resource#details" },
    { name: "explicit group", landing: "portal", target: "/MemberGroupDetail?view=mine#details", extra: "&groupId=fixture-group", expected: "/MemberGroupDetail?view=mine&id=fixture-group#details" },
    { name: "invalid return uses existing safe fallback", landing: "portal", target: "https://evil.example/steal", expected: "/" },
  ]) {
    test(`BNMS role navigation: ${flow} / ${scenario.name}`, async ({ page }) => {
      test.skip(!["localhost", "127.0.0.1"].includes(new URL(test.info().project.use.baseURL).hostname),
        "Use the BNMS config: tenant-subdomain hosts override fixture localStorage.");
      const fixture = await installFixtures(page, {
        version: 1,
        tenantSlug: scenario.tenantSlug || "bnms",
        roles: scenario.missingRole ? [] : [{ ...ROLE, default_landing_page: scenario.landing }],
        existingLoginSession: flow === "existing-session",
      });
      await page.route("**/*", route => {
        const request = route.request();
        if (request.isNavigationRequest() && new URL(request.url()).pathname !== "/login") {
          return route.fulfill({ contentType: "text/html", body: "<h1>Fixture destination</h1>" });
        }
        return route.fallback();
      });
      const params = new URLSearchParams();
      if (scenario.target) params.set("returnTo", scenario.target);
      if (flow === "password-setup") {
        params.set("mode", "set-password");
        params.set("token", "isolated-fixture-token");
        params.set("email", MEMBER.email);
      }
      await page.goto(`/login?${params}${scenario.extra || ""}`);
      if (flow === "login") {
        await page.getByTestId("input-email").fill(MEMBER.email);
        await page.getByTestId("input-password").fill("fixture password");
        await page.getByTestId("button-login").click();
      } else if (flow === "password-setup") {
        await page.getByTestId("input-new-password").fill("new fixture password");
        await page.getByTestId("input-confirm-password").fill("new fixture password");
        await page.getByTestId("button-set-password").click();
      }
      await expect(page.getByRole("heading", { name: "Fixture destination" })).toBeVisible();
      const url = new URL(page.url());
      expect(url.pathname + url.search + url.hash).toBe(scenario.expected);
      expect(fixture.state.loginCount).toBe(flow === "login" ? 1 : 0);
      if (flow === "existing-session") {
        expect(fixture.state.requests.filter(({ path }) => path === "/api/auth/me")).toHaveLength(1);
        const cachedMember = await page.evaluate(() => JSON.parse(
          localStorage.getItem("agcas_member") || "null",
        ));
        expect(cachedMember?.sessionRole).toBeUndefined();
        expect(cachedMember?.role).toBeUndefined();
        expect(cachedMember?.memberRole).toBeUndefined();
      }
      expect(fixture.state.requests.filter(r => r.path === "/api/auth/set-password")).toHaveLength(flow === "password-setup" ? 1 : 0);
      expect(fixture.state.roleReads).toBe(
        scenario.target || (flow === "existing-session" && !scenario.missingRole) ? 0 : 1,
      );
      expect(fixture.state.writes).toEqual([]);
    });
  }
}

for (const context of [
  { target: "/", extra: "", expected: "/" },
  { target: `/${PAGE_SLUG}?view=members#protected`, extra: "&resourceId=resource-fixture", expected: `/${PAGE_SLUG}?view=members&resourceId=resource-fixture#protected` },
  { target: `/${PAGE_SLUG}?view=members#protected`, extra: "&groupId=group-fixture", expected: `/${PAGE_SLUG}?view=members&id=group-fixture#protected` },
]) {
  test(`explicit contextual login survives first-password transition: ${context.extra || "root"}`, async ({ page }) => {
    const fixture = await installFixtures(page, { version: 1, firstLogin: true });
    await page.goto(`/login?returnTo=${encodeURIComponent(context.target)}${context.extra}`);
    await page.getByTestId("input-email").fill(MEMBER.email);
    await page.getByTestId("input-password").fill("fixture password");
    await page.getByTestId("button-login").click();
    await page.getByTestId("input-new-password").fill("new fixture password");
    await page.getByTestId("input-confirm-password").fill("new fixture password");
    await page.getByTestId("button-set-password").click();
    await expect.poll(() => {
      const url = new URL(page.url());
      return url.pathname + url.search + url.hash;
    }).toBe(context.expected);
    expect(fixture.state.loginCount).toBe(1);
    expect(fixture.state.roleReads).toBe(0);
    expect(fixture.state.writes).toEqual([]);
  });
}
import { test, expect } from "@playwright/test";

const TENANT = {
  id: "46020000-0000-4000-8000-000000000001",
  slug: "mobile-header-fixture",
  name: "A deliberately long tenant name for narrow mobile headers",
};

const WIDE_LOGO = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="120" viewBox="0 0 960 120">'
  + '<rect width="960" height="120" rx="12" fill="#5c0085"/><text x="30" y="78" font-size="58" fill="white">WIDE BRAND MARK</text></svg>',
);
const TALL_LOGO = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="480" viewBox="0 0 120 480">'
  + '<rect width="120" height="480" rx="12" fill="#ba0087"/><circle cx="60" cy="60" r="40" fill="white"/></svg>',
);

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installFixture(page, {
  mobileHeaderHeight,
  headerLogoUrl = WIDE_LOGO,
  showLogo = true,
  desktopLogoHeight = 112,
  desktopScrolledHeight = 52,
} = {}) {
  const state = {
    unexpectedReads: [],
    unexpectedWrites: [],
    pageErrors: [],
  };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("cookie-consent", "accepted");
  });

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.protocol === "data:" || !url.pathname.startsWith("/api/")) {
      // TenantBrandingContext performs this read-only Supabase hostname lookup
      // during shell bootstrap. Keep it fixture-local; reject every other
      // direct database request.
      if (url.pathname === "/rest/v1/tenant" && ["GET", "HEAD"].includes(method)) {
        return json(route, []);
      }
      if (url.pathname.startsWith("/rest/v1/")) {
        state.unexpectedReads.push(`${method} ${url.pathname}`);
        return json(route, { error: "Unexpected direct database access" }, 599);
      }
      return route.continue();
    }

    const key = `${method} ${url.pathname}${url.search}`;
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(key);
      return json(route, { error: `Unexpected mutation: ${key}` }, 599);
    }

    if (url.pathname === "/api/auth/me") return json(route, {}, 401);
    if (url.pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: false });
    if (url.pathname === "/api/public/tenant-branding") {
      const headerConfig = {
        logoHeight: desktopLogoHeight,
        logoShrinkOnScroll: true,
        logoScrolledHeight: desktopScrolledHeight,
      };
      if (mobileHeaderHeight !== undefined) headerConfig.mobileHeaderHeight = mobileHeaderHeight;
      return json(route, {
        success: true,
        branding: {
          ...TENANT,
          headerLogoUrl,
          headerConfig,
          brandingConfig: {},
          footerConfig: {},
          platformBranding: { enabled: false },
        },
      });
    }
    if (url.pathname === "/api/public/microsites"
      || url.pathname === "/api/public/navigation-items"
      || url.pathname === "/api/public/events"
      || url.pathname === "/api/public/complex-events"
      || url.pathname === "/api/public/resource-categories"
      || url.pathname === "/api/public/banners"
      || url.pathname === "/api/public/typography-styles") {
      return json(route, []);
    }
    if (url.pathname === "/api/public/system-settings") {
      const settingKey = url.searchParams.get("key");
      if (settingKey === "header_icons_config") {
        return json(route, [{
          setting_key: settingKey,
          setting_value: JSON.stringify({ logo: showLogo, login: false, search: false, social: false }),
        }]);
      }
      if (!settingKey || [
        "social_icons_config",
        "article_display_name",
        "global_border_radius",
        "page_visibility_settings",
        "member_display_name",
      ].includes(settingKey)) {
        return json(route, []);
      }
    }
    if (url.pathname === "/api/public/installed-fonts") return json(route, []);
    if (url.pathname === "/api/public/form-consent-message") {
      return json(route, { message: "" });
    }
    if (url.pathname === "/api/public/article-settings") return json(route, {});
    if (url.pathname === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (url.pathname === "/api/public/portal-branding") return json(route, {});
    if (url.pathname === "/api/public/platform-defaults") return json(route, {});
    if (url.pathname === "/api/public/ai-help-persona") return json(route, {});
    if (url.pathname === "/api/tenant-canvas-theme") return json(route, {});

    state.unexpectedReads.push(key);
    return json(route, { error: `Unexpected read: ${key}` }, 599);
  });
  return state;
}

async function openHeader(page, options) {
  const state = await installFixture(page, options);
  await page.goto("/Events");
  await dismissPreviewBanner(page);
  await expect(page.getByTestId("mobile-header-toolbar")).toBeVisible();
  return state;
}

async function dismissPreviewBanner(page) {
  const closeBanner = page.getByRole("button", { name: "Close banner" });
  await closeBanner.waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
  if (await closeBanner.isVisible().catch(() => false)) {
    await closeBanner.click();
    await closeBanner.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
  }
}

function expectCleanFixture(state) {
  expect(state.unexpectedReads).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
}

async function expectMobileGeometry(page, expectedHeight, { logo = true } = {}) {
  const toolbar = page.getByTestId("mobile-header-toolbar");
  await expect(toolbar).toHaveCSS("height", `${expectedHeight}px`);
  const hamburger = page.getByRole("button", { name: "Open menu" });
  await expect(hamburger).toBeVisible();

  const toolbarBox = await toolbar.boundingBox();
  const buttonBox = await hamburger.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox.y).toBeGreaterThanOrEqual(toolbarBox.y);
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(toolbarBox.y + toolbarBox.height);
  if (logo) {
    const logoLink = page.getByTestId("link-header-logo-mobile");
    const logoBox = await logoLink.boundingBox();
    expect(logoBox).not.toBeNull();
    expect(logoBox.x + logoBox.width).toBeLessThanOrEqual(buttonBox.x);
    expect(logoBox.y).toBeGreaterThanOrEqual(toolbarBox.y);
    expect(logoBox.y + logoBox.height).toBeLessThanOrEqual(toolbarBox.y + toolbarBox.height);
  } else {
    await expect(page.getByTestId("link-header-logo-mobile")).toHaveCount(0);
  }
}

test.describe("task 4602 mobile public header height", () => {
  for (const width of [320, 375, 430, 768]) {
    test(`uses configured height without collision at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 760 });
      const state = await openHeader(page, {
        mobileHeaderHeight: 128,
        headerLogoUrl: width < 400 ? WIDE_LOGO : TALL_LOGO,
      });
      await expectMobileGeometry(page, 128);

      const image = page.getByTestId("link-header-logo-mobile").locator("img");
      await expect(image).toHaveCSS("height", "104px");
      await page.screenshot({
        path: testInfo.outputPath(`configured-${width}.png`),
        fullPage: false,
      });
      expectCleanFixture(state);
    });
  }

  test("defaults to 64px and keeps the text fallback constrained", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const state = await openHeader(page, { headerLogoUrl: null });
    await expectMobileGeometry(page, 64);
    await expect(page.getByTestId("link-header-logo-mobile").locator("span")).toHaveCSS("line-height", "40px");
    await page.screenshot({ path: testInfo.outputPath("default-text-320.png"), fullPage: false });
    expectCleanFixture(state);
  });

  test("keeps the hamburger aligned when the logo is hidden", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 430, height: 700 });
    const state = await openHeader(page, { mobileHeaderHeight: 200, showLogo: false });
    await expectMobileGeometry(page, 200, { logo: false });
    await page.screenshot({ path: testInfo.outputPath("hidden-logo-430.png"), fullPage: false });
    expectCleanFixture(state);
  });

  test("does not apply desktop logo shrinking to mobile before or after scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 320 });
    const state = await openHeader(page, { mobileHeaderHeight: 96, headerLogoUrl: TALL_LOGO });
    const image = page.getByTestId("link-header-logo-mobile").locator("img");
    await expect(image).toHaveCSS("height", "72px");
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(20);
    await expect(image).toHaveCSS("height", "72px");
    await expectMobileGeometry(page, 96);
    expectCleanFixture(state);
  });

  test("leaves the mobile drawer logo and sizing behavior unchanged", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 700 });
    const state = await openHeader(page, { mobileHeaderHeight: 160, headerLogoUrl: WIDE_LOGO });
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawerLogo = page.getByTestId("link-mobile-drawer-logo").locator("img");
    await expect(drawerLogo).toBeVisible();
    await expect(drawerLogo).toHaveCSS("height", "40px");
    const drawer = page.getByRole("button", { name: "Close menu" }).locator("../..");
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBeCloseTo(37.5, 0);
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox.width).toBeCloseTo(337.5, 0);
    await page.screenshot({ path: testInfo.outputPath("drawer-375.png"), fullPage: false });
    expectCleanFixture(state);
  });

  test("uses desktop chrome and preserves desktop shrink-on-scroll", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 420 });
    const state = await installFixture(page, {
      mobileHeaderHeight: 180,
      headerLogoUrl: WIDE_LOGO,
      desktopLogoHeight: 112,
      desktopScrolledHeight: 52,
    });
    await page.goto("/Events");
    await dismissPreviewBanner(page);
    await expect(page.getByTestId("mobile-header-toolbar")).toBeHidden();
    const desktopImage = page.getByTestId("link-header-logo").locator("img");
    await expect(desktopImage).toHaveCSS("height", "112px");
    await page.screenshot({ path: testInfo.outputPath("desktop-before-scroll.png"), fullPage: false });
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(20);
    await expect(desktopImage).toHaveCSS("height", "52px");
    await page.screenshot({ path: testInfo.outputPath("desktop-after-scroll.png"), fullPage: false });
    expectCleanFixture(state);
  });
});
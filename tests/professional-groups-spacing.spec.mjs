import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const SLUG = "professional-groups-spacing-fixture";
const CARD_ID = "groups-cards";
const OWNER_ID = "groups-owner";
const FOLLOWING_ID = "groups-following";
const IDS = Array.from({ length: 9 }, (_, index) => `group-${index + 1}`);
const MEMBER = {
  id: "groups-member",
  email: "groups-member@example.invalid",
  tenant_id: "groups-tenant",
  role_id: "groups-role",
  member_excluded_features: [],
};
const RESTRICTED_MEMBER = {
  ...MEMBER,
  id: "groups-restricted-member",
  email: "groups-restricted@example.invalid",
  role_id: "groups-restricted-role",
};

const GEOMETRY = {
  desktop: {
    owner: { x: 0, y: 1048, w: 1200, h: 1464 },
    cards: { x: 0, y: 1160, w: 800, h: 1296 },
    following: { x: 0, y: 2560, w: 420, h: 65 },
  },
  tablet: {
    owner: { x: 0, y: 2575, w: 768, h: 1104, hidden: true },
    cards: { x: 0, y: 1255, w: 768, h: 1296 },
    following: { x: 24, y: 3703, w: 420, h: 65 },
  },
  mobile: {
    owner: { x: 0, y: 2994, w: 375, h: 1360 },
    cards: { x: 0, y: 1638, w: 375, h: 3200 },
    following: { x: 16, y: 4870, w: 343, h: 59 },
  },
};

function block(id, type, bp, style, content = {}) {
  return {
    id,
    type,
    name: id,
    bp,
    style: {
      zIndex: 1,
      opacity: 1,
      boxShadow: "none",
      background: "transparent",
      borderColor: "#cbd5e1",
      borderStyle: "solid",
      borderWidth: 0,
      borderRadius: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      ...style,
    },
    content,
    a11y: {},
  };
}

function pageFixture() {
  return {
    id: "professional-groups-spacing-page",
    slug: SLUG,
    title: "Professional Groups spacing fixture",
    status: "published",
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: "none",
    tenant_id: "groups-tenant",
    canvas_design: {
      version: 1,
      root: {
        background: null,
        groups: [],
        guides: { vertical: [], horizontal: [] },
        sections: [{
          id: "root-section",
          type: "section",
          children: [
            block(
              OWNER_ID,
              "section",
              Object.fromEntries(Object.entries(GEOMETRY).map(([bp, value]) => [bp, value.owner])),
              {
                background: "#f8fafc",
                paddingTop: 24,
                paddingRight: 24,
                paddingBottom: 24,
                paddingLeft: 24,
              },
              { bgType: "color", fullBleed: true },
            ),
            block(
              CARD_ID,
              "member-group-cards",
              Object.fromEntries(Object.entries(GEOMETRY).map(([bp, value]) => [bp, value.cards])),
              {
                // Deliberately non-zero: the regression was caused by reporting
                // only the inner grid and dropping authored wrapper padding.
                paddingTop: 32,
                paddingRight: 24,
                paddingBottom: 36,
                paddingLeft: 24,
              },
              {
                source: "selected",
                limit: 9,
                columns: { desktop: 3, tablet: 2, mobile: 1 },
                selectedGroupIds: IDS,
                selectedGroupRoles: {},
              },
            ),
            block(
              FOLLOWING_ID,
              "text",
              Object.fromEntries(Object.entries(GEOMETRY).map(([bp, value]) => [bp, value.following])),
              {},
              { html: "<p>Why get involved?</p>", headingAs: "2" },
            ),
            block(
              "after-groups-section",
              "section",
              {
                desktop: { x: 0, y: 2880, w: 1200, h: 240 },
                tablet: { x: 0, y: 4244, w: 768, h: 240 },
                mobile: { x: 0, y: 5570, w: 375, h: 320 },
              },
              {
                background: "#eef6ff",
                paddingTop: 24,
                paddingRight: 24,
                paddingBottom: 24,
                paddingLeft: 24,
              },
              { bgType: "color", fullBleed: true },
            ),
          ],
        }],
      },
    },
  };
}

function groups() {
  return IDS.map((id, index) => ({
    id,
    name: [
      "Clinical Standards and a deliberately wrapping title",
      "Education and training",
      "Research, innovation and professional practice",
    ][index % 3],
    description: `<p>Controlled group ${index + 1} content. This deliberately varies in length ${
      "to exercise asynchronous card equalisation and wrapping. ".repeat((index % 3) + 1)
    }</p>`,
    allow_self_join: index !== 7,
    is_active: true,
    default_self_join_role: "Member",
    header_image_url: `/groups-fixture/image-${index + 1}.svg`,
  }));
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
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

async function attachJson(testInfo, name, value) {
  const path = testInfo.outputPath(name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await testInfo.attach(name, { path, contentType: "application/json" });
}

async function installFixture(page, {
  audience = "guest",
  holdGroups = false,
  holdImages = false,
} = {}) {
  const groupGate = deferred();
  const imageGate = deferred();
  if (!holdGroups) groupGate.release();
  if (!holdImages) imageGate.release();
  const fixturePage = pageFixture();
  const state = {
    audience,
    reads: [],
    errors: [],
    writes: [],
    releaseGroups: groupGate.release,
    releaseImages: imageGate.release,
    setAudience(nextAudience) {
      state.audience = nextAudience;
    },
  };
  page.on("pageerror", (error) => state.errors.push(error.message));

  if (audience !== "guest") {
    await page.addInitScript((member) => {
      localStorage.setItem("agcas_member", JSON.stringify(member));
    }, audience === "restricted" ? RESTRICTED_MEMBER : MEMBER);
  }

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.startsWith("/groups-fixture/image-")) {
      await imageGate.promise;
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="200"><rect width="500" height="200" fill="#dbeafe"/></svg>',
      });
    }
    if (path === "/groups-fixture/late-font.woff2") {
      await imageGate.promise;
      return route.fulfill({
        status: 200,
        contentType: "font/woff2",
        path: "node_modules/@fortawesome/fontawesome-free/webfonts/fa-regular-400.woff2",
      });
    }
    if (!path.startsWith("/api/")) return route.continue();
    state.reads.push(`${request.method()} ${path}${url.search}`);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.writes.push(`${request.method()} ${path}`);
      return json(route, { error: "read-only fixture" }, 405);
    }

    const activeMember = state.audience === "restricted" ? RESTRICTED_MEMBER : MEMBER;
    if (path === "/api/auth/me") {
      return state.audience === "guest" ? json(route, null, 401) : json(route, activeMember);
    }
    if (path === "/api/auth/tenant-user-me") {
      return state.audience === "guest"
        ? json(route, { authenticated: false }, 401)
        : json(route, { user: activeMember, tenant: { id: activeMember.tenant_id } });
    }
    if (path === `/api/entities/Member/${activeMember.id}`) return json(route, activeMember);
    if (path === `/api/entities/Role/${activeMember.role_id}`) {
      return json(route, {
        id: activeMember.role_id,
        name: "Fixture role",
        excluded_features: state.audience === "restricted" ? ["membership.member-group-access"] : [],
      });
    }
    if (path === "/api/entities/Role") return json(route, []);
    if (path === "/api/entities/MemberGroup") {
      await groupGate.promise;
      return json(route, groups());
    }
    if (path === "/api/entities/Vacancy" || path === "/api/entities/MemberGroupAssignment") {
      return json(route, []);
    }
    if (path === "/api/public/member-groups") {
      await groupGate.promise;
      return json(route, groups());
    }
    if (path.startsWith("/api/public/page/")) {
      return json(route, { success: true, page: fixturePage, elements: [], symbols: [] });
    }
    if (path === "/api/public/tenant-branding") {
      return json(route, {
        success: true,
        branding: { id: "groups-tenant", name: "Groups fixture", headerConfig: {}, footerConfig: {} },
      });
    }
    if (path === "/api/public/microsites") return json(route, { microsites: [] });
    if (path === "/api/public/navigation-items"
      || path === "/api/public/canvas-symbols"
      || path === "/api/public/typography-styles"
      || path === "/api/public/installed-fonts"
      || path === "/api/public/system-settings"
      || path === "/api/entities/TypographyStyle"
      || path === "/api/public/banners") return json(route, []);
    if (path === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (path === "/api/public/platform-defaults"
      || path === "/api/public/portal-branding"
      || path === "/api/tenant-canvas-theme") return json(route, {});
    return json(route, []);
  });
  return state;
}

async function boxes(page) {
  return page.evaluate(({ cardId, ownerId, followingId }) => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && {
        top: value.top + scrollY,
        bottom: value.bottom + scrollY,
        height: value.height,
        width: value.width,
      };
    };
    const outer = document.querySelector(`[data-cb="${cardId}"]`);
    const style = outer && getComputedStyle(outer);
    return {
      outer: rect(`[data-cb="${cardId}"]`),
      grid: rect(`[data-cb="${cardId}"] [data-member-group-cards-grid]`),
      owner: rect(`[data-cb="${ownerId}"]`),
      following: rect(`[data-cb="${followingId}"]`),
      paddingTop: style ? parseFloat(style.paddingTop) : NaN,
      paddingBottom: style ? parseFloat(style.paddingBottom) : NaN,
    };
  }, { cardId: CARD_ID, ownerId: OWNER_ID, followingId: FOLLOWING_ID });
}

async function expectSettledGeometry(page, breakpoint) {
  await expect(page.getByTestId("member-group-cards-grid")).toBeVisible();
  await expect(page.locator(`[data-cb="${FOLLOWING_ID}"]`)).toBeVisible();
  await expect.poll(async () => {
    const value = await boxes(page);
    return Math.round(value.following.top - value.outer.bottom);
  }).toBe(
    GEOMETRY[breakpoint].following.y
      - (GEOMETRY[breakpoint].cards.y + GEOMETRY[breakpoint].cards.h),
  );

  const value = await boxes(page);
  expect(value.grid.top - value.outer.top).toBeGreaterThanOrEqual(value.paddingTop - 1);
  expect(value.outer.bottom - value.grid.bottom).toBeGreaterThanOrEqual(value.paddingBottom - 1);
  expect(value.following.top).toBeGreaterThanOrEqual(value.outer.bottom);

  if (breakpoint === "desktop") {
    expect(value.owner.bottom - value.outer.bottom).toBeGreaterThanOrEqual(23);
  }
  if (breakpoint === "tablet") {
    expect(value.owner.height).toBe(0);
    expect(value.outer.height).toBeGreaterThan(0);
    expect(value.following.height).toBeGreaterThan(0);
  }
  return value;
}

async function expectAuthoredFollowingGap(page, breakpoint) {
  const expectedGap = GEOMETRY[breakpoint].following.y
    - (GEOMETRY[breakpoint].cards.y + GEOMETRY[breakpoint].cards.h);
  await expect.poll(async () => {
    const value = await boxes(page);
    return Math.round(value.following.top - value.outer.bottom);
  }).toBe(expectedGap);
  return boxes(page);
}

test("cold guest loading to cards preserves desktop/mobile padding and authored gaps after late image/font settle", async ({ page }, testInfo) => {
  const state = await installFixture(page, { audience: "guest", holdGroups: true, holdImages: true });
  await page.goto(`/${SLUG}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("member-group-cards-loading")).toBeVisible();
  const loading = await boxes(page);
  expect(loading.following.top).toBeGreaterThanOrEqual(loading.outer.bottom);
  await page.screenshot({ path: testInfo.outputPath("guest-desktop-cold-loading-reference.png"), fullPage: true });

  state.releaseGroups();
  await expect(page.getByTestId("member-group-cards-grid")).toBeVisible();
  await page.addStyleTag({
    content: `@font-face{font-family:GroupsLate;src:url("/groups-fixture/late-font.woff2")} [data-cb="${CARD_ID}"]{font-family:GroupsLate,Arial,sans-serif}`,
  });
  state.releaseImages();
  await page.evaluate(() => document.fonts?.ready);
  const desktop = await expectSettledGeometry(page, "desktop");
  await page.screenshot({ path: testInfo.outputPath("guest-desktop-after.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await expectSettledGeometry(page, "mobile");
  await page.screenshot({ path: testInfo.outputPath("guest-mobile-after.png"), fullPage: true });
  await attachJson(testInfo, "professional-groups-geometry.json", { loading, desktop, mobile });
  expect(mobile.outer.height).toBeGreaterThan(desktop.outer.height);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("cached guest remount and tablet hidden owner do not collapse cards or following content", async ({ page }) => {
  const state = await installFixture(page, { audience: "guest" });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/${SLUG}`, { waitUntil: "domcontentloaded" });
  const first = await expectSettledGeometry(page, "tablet");

  // A second Canvas slug gives the first tree a real unmount while retaining
  // the app-level QueryClient cache. Returning exercises the cached mount path
  // rather than a full document reload.
  await page.evaluate(() => {
    history.pushState({}, "", "/professional-groups-spacing-interstitial");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByTestId("member-group-cards-grid")).toBeVisible();
  await page.evaluate((slug) => {
    history.pushState({}, "", `/${slug}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, SLUG);
  const second = await expectSettledGeometry(page, "tablet");
  expect(Math.abs(second.following.top - first.following.top)).toBeLessThanOrEqual(1);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const audience of ["member", "restricted"]) {
  test(`${audience} projection keeps spacing contract at desktop and mobile`, async ({ page }) => {
    const state = await installFixture(page, { audience });
    await page.goto(`/${SLUG}`, { waitUntil: "domcontentloaded" });
    if (audience === "restricted") {
      await expect(page.getByTestId("member-group-cards-restricted")).toBeVisible();
    } else {
      await expect(page.getByTestId("member-group-cards-grid")).toBeVisible();
    }
    let value = audience === "restricted"
      ? await expectAuthoredFollowingGap(page, "desktop")
      : await boxes(page);
    expect(value.grid ? value.grid.top - value.outer.top : value.following.top - value.outer.bottom)
      .toBeGreaterThanOrEqual(0);
    expect(value.following.top).toBeGreaterThanOrEqual(value.outer.bottom);

    await page.setViewportSize({ width: 390, height: 844 });
    if (audience === "member") await expectSettledGeometry(page, "mobile");
    else {
      value = await expectAuthoredFollowingGap(page, "mobile");
      expect(value.following.top).toBeGreaterThanOrEqual(value.outer.bottom);
    }
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test("same-page auth transitions guest to member to guest to restricted without leaking controls or spacing", async ({ page }, testInfo) => {
  const state = await installFixture(page, { audience: "guest" });
  await page.goto(`/${SLUG}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("button-login-required-group-1")).toBeVisible();
  const snapshots = { guest: await expectSettledGeometry(page, "desktop") };

  const publishSession = async (nextAudience, member) => {
    state.setAudience(nextAudience);
    await page.evaluate((nextMember) => {
      const oldValue = localStorage.getItem("agcas_member");
      if (nextMember) localStorage.setItem("agcas_member", JSON.stringify(nextMember));
      else localStorage.removeItem("agcas_member");
      dispatchEvent(new StorageEvent("storage", {
        key: "agcas_member",
        oldValue,
        newValue: nextMember ? JSON.stringify(nextMember) : null,
      }));
    }, member);
  };

  await publishSession("member", MEMBER);
  await expect(page.getByTestId("button-find-out-more-group-1")).toBeVisible();
  await expect(page.getByTestId("button-login-required-group-1")).toHaveCount(0);
  snapshots.member = await expectSettledGeometry(page, "desktop");

  await publishSession("guest", null);
  await expect(page.getByTestId("button-login-required-group-1")).toBeVisible();
  await expect(page.getByTestId("button-find-out-more-group-1")).toHaveCount(0);
  snapshots.loggedOutGuest = await expectSettledGeometry(page, "desktop");

  await publishSession("restricted", RESTRICTED_MEMBER);
  await expect(page.getByTestId("member-group-cards-restricted")).toBeVisible();
  await expect(page.getByTestId("button-login-required-group-1")).toHaveCount(0);
  await expect(page.getByTestId("button-find-out-more-group-1")).toHaveCount(0);
  snapshots.restricted = await boxes(page);
  expect(snapshots.restricted.following.top).toBeGreaterThanOrEqual(snapshots.restricted.outer.bottom);

  await attachJson(testInfo, "auth-transition-bounds.json", snapshots);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
import { test, expect } from "@playwright/test";

const PAGE_ID = "member-group-pagination-page";
const PAGE_SLUG = "member-group-pagination-fixture";
const GROUP_ID = "member-group-pagination-group";
const BLOCK_ID = "member-group-pagination-block";
const FOLLOWING_ID = "member-group-pagination-following";
const TENANT = { id: "member-group-pagination-tenant", slug: "member-group-pagination" };
const MEMBER = {
  id: "member-group-pagination-editor",
  email: "member-group-pagination@example.invalid",
  tenant_id: TENANT.id,
  role_id: "member-group-pagination-role",
  member_excluded_features: [],
};
const ROLE = { id: MEMBER.role_id, name: "Fixture editor", excluded_features: [] };
const RECORDS = ["Ada", "Grace", "Katherine", "Dorothy", "Mary"].map((first_name, index) => ({
  id: `pagination-member-${index + 1}`,
  first_name,
  last_name: "Fixture",
  job_title: `Fixture role ${index + 1}`,
  group_role: "Committee member",
  organization_name: "Fixture organisation",
}));

function block(id, type, y, h, content = {}) {
  return {
    id,
    type,
    name: id,
    geom: { x: 0, y, w: 900, h },
    bp: {
      desktop: { x: 150, y, w: 900, h },
      tablet: { x: 24, y, w: 720, h },
      mobile: { x: 16, y, w: 343, h },
    },
    style: {
      zIndex: 1,
      opacity: 1,
      background: "#ffffff",
      borderWidth: 0,
      borderRadius: 0,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
    },
    content,
    a11y: {},
  };
}

function fixturePage() {
  return {
    id: PAGE_ID,
    slug: PAGE_SLUG,
    title: "Member group pagination browser fixture",
    status: "published",
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: "none",
    tenant_id: TENANT.id,
    canvas_design: {
      version: 1,
      root: {
        background: null,
        groups: [],
        guides: { vertical: [], horizontal: [] },
        sections: [{
          id: "member-group-pagination-root",
          children: [
            block("pagination-intro", "text", 0, 180, {
              html: "<h1>Pagination fixture</h1><p>Spacer before the member group.</p>",
            }),
            block(BLOCK_ID, "member-group", 900, 980, {
              groupId: GROUP_ID,
              rows: 2,
              columns: { desktop: 2, tablet: 2, mobile: 1 },
              showMembers: true,
              showGroupName: true,
              showGroupDescription: true,
              gap: 16,
            }),
            block(FOLLOWING_ID, "text", 1980, 120, {
              html: "<h2>Following content marker</h2>",
            }),
            block("pagination-terminal", "section", 3500, 1000, {
              bgType: "color",
              fullBleed: true,
            }),
          ],
        }],
      },
    },
  };
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
  const pageRecord = fixturePage();
  const state = { requests: [], writes: [], pageErrors: [] };
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  await page.addInitScript((member) => {
    localStorage.setItem("agcas_member", JSON.stringify(member));
  }, MEMBER);

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me") return json(route, MEMBER);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        authenticated: true,
        user: MEMBER,
        member: MEMBER,
        tenant: TENANT,
        tenantId: TENANT.id,
        memberId: MEMBER.id,
      });
    }
    if (path === `/api/entities/Member/${MEMBER.id}`) return json(route, MEMBER);
    if (path === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (path === "/api/entities/Member") return json(route, [MEMBER]);
    if (path === "/api/entities/Role") return json(route, [ROLE]);
    if (path === "/api/entities/IEditPage") return json(route, [pageRecord]);
    if (path === `/api/canvas-design/${PAGE_ID}` && method === "GET") {
      return json(route, { page: pageRecord });
    }
    if (path === `/api/public/page/${PAGE_SLUG}`) {
      return json(route, { success: true, page: pageRecord, elements: [], symbols: [] });
    }
    if (path === "/api/public/member-group-members") {
      const pageNumber = Math.max(1, Number(url.searchParams.get("page") || 1));
      const limit = Math.max(1, Number(url.searchParams.get("limit") || 1));
      const offset = (pageNumber - 1) * limit;
      return json(route, {
        config: {
          group: {
            id: GROUP_ID,
            name: "Fixture leadership group",
            description: "<p>Five fixture members exercise a shorter final page.</p>",
          },
          displaySettings: {},
        },
        records: RECORDS.slice(offset, offset + limit),
        total: RECORDS.length,
        page: pageNumber,
        pageSize: limit,
      });
    }
    if (path === "/api/public/tenant-branding") {
      return json(route, { success: true, branding: { tenant: TENANT, tenantSlug: TENANT.slug } });
    }
    if (path === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (path === "/api/public/canvas-symbols") return json(route, { symbols: [] });
    if (path === "/api/public/microsites"
      || path === "/api/public/navigation-items"
      || path === "/api/public/typography-styles"
      || path === "/api/public/installed-fonts"
      || path === "/api/public/system-settings"
      || path === "/api/public/banners"
      || path === "/api/entities/TypographyStyle") return json(route, []);
    if (path.startsWith("/api/canvas-page-audits/")) {
      if (method !== "GET") state.writes.push(`${method} ${path} (mocked telemetry)`);
      return json(route, method === "GET" ? { audits: [] } : { audit: {} });
    }
    if (path.startsWith("/api/canvas-versions/")) {
      if (method !== "GET") state.writes.push(`${method} ${path} (mocked version)`);
      return json(route, method === "GET" ? { versions: [] } : { version: {} });
    }
    if (method === "GET") {
      if (path.includes("branding") || path.includes("settings")) {
        return json(route, { tenant: TENANT, branding: {} });
      }
      return json(route, []);
    }
    state.writes.push(`${method} ${path} (rejected)`);
    return json(route, { error: "Read-only browser fixture" }, 405);
  });
  return state;
}

async function publicLayout(page) {
  return page.evaluate(({ blockId, followingId }) => {
    const block = document.querySelector(`[data-cb="${blockId}"]`);
    const scrollTarget = block.querySelector("[data-testid='member-group-block']");
    const following = document.querySelector(`[data-cb="${followingId}"]`);
    const blockRect = block.getBoundingClientRect();
    const scrollTargetRect = scrollTarget.getBoundingClientRect();
    const followingRect = following.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      scrollTargetViewportTop: scrollTargetRect.top,
      blockDocumentBottom: blockRect.bottom + window.scrollY,
      followingDocumentTop: followingRect.top + window.scrollY,
    };
  }, { blockId: BLOCK_ID, followingId: FOLLOWING_ID });
}

async function expectPublicScrollAtBlock(page) {
  await expect.poll(async () => (await publicLayout(page)).scrollTargetViewportTop).toBeGreaterThanOrEqual(7);
  await expect.poll(async () => (await publicLayout(page)).scrollTargetViewportTop).toBeLessThanOrEqual(9);
}

async function clickPageControl(page, testId, expectedPage, options = {}) {
  const control = page.getByTestId(testId);
  if (options.dispatch) await control.dispatchEvent("click");
  else await control.click(options);
  await expect(page.getByTestId("text-member-group-page")).toHaveText(expectedPage);
}

test("published desktop and mobile pagination scrolls after Next/Previous and reflows the shorter last page", async ({ browser }, testInfo) => {
  for (const viewport of [
    { name: "desktop", size: { width: 1440, height: 900 }, finalPage: "Page 2 of 2", finalName: "Mary Fixture" },
    { name: "mobile", size: { width: 390, height: 844 }, finalPage: "Page 3 of 3", finalName: "Mary Fixture" },
  ]) {
    const context = await browser.newContext({ viewport: viewport.size });
    const page = await context.newPage();
    const state = await installFixture(page);
    await page.goto(`/${PAGE_SLUG}`);
    await expect(page.getByTestId("member-group-list")).toBeVisible();
    const firstPage = await publicLayout(page);

    await clickPageControl(
      page,
      "button-member-group-next",
      viewport.name === "mobile" ? "Page 2 of 3" : "Page 2 of 2",
    );
    await expectPublicScrollAtBlock(page);
    if (viewport.name === "mobile") {
      await clickPageControl(page, "button-member-group-next", viewport.finalPage);
      await expectPublicScrollAtBlock(page);
    }
    await expect(page.getByText(viewport.finalName, { exact: true })).toBeVisible();
    await expect(page.getByTestId("member-group-list").locator(":scope > li")).toHaveCount(1);
    const shortPage = await publicLayout(page);
    expect(shortPage.followingDocumentTop).toBeLessThan(firstPage.followingDocumentTop - 100);
    expect(shortPage.followingDocumentTop).toBeGreaterThanOrEqual(shortPage.blockDocumentBottom - 1);
    if (viewport.name === "desktop") {
      await page.screenshot({
        path: testInfo.outputPath("published-desktop-short-final-page.png"),
        fullPage: false,
      });
    }

    await clickPageControl(
      page,
      "button-member-group-prev",
      viewport.name === "mobile" ? "Page 2 of 3" : "Page 1 of 2",
    );
    await expectPublicScrollAtBlock(page);
    await expect(page.getByTestId("member-group-list").locator(":scope > li")).toHaveCount(
      viewport.name === "mobile" ? 2 : 4,
    );
    const restoredPage = await publicLayout(page);
    expect(restoredPage.followingDocumentTop).toBeGreaterThan(shortPage.followingDocumentTop + 100);
    expect(state.writes.filter((entry) => entry.endsWith("(rejected)"))).toEqual([]);
    expect(state.pageErrors).toEqual([]);
    await context.close();
  }
});

test("editor desktop and mobile pagination changes records without moving the stage scroll owner", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto(`/CanvasPageEditor?pageId=${PAGE_ID}`);
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  const cookieBanner = page.getByTestId("banner-cookie-consent");
  if (await cookieBanner.isVisible()) await page.getByTestId("button-decline-cookies").click();
  const stagePanel = page.getByTestId("panel-stage");

  for (const breakpoint of [
    { button: "button-breakpoint-desktop", first: "Page 1 of 2", second: "Page 2 of 2" },
    { button: "button-breakpoint-mobile", first: "Page 1 of 3", second: "Page 2 of 3" },
  ]) {
    await page.getByTestId(breakpoint.button).first().click();
    await expect(page.getByTestId("text-member-group-page")).toHaveText(breakpoint.first);
    const next = page.getByTestId("button-member-group-next");
    await next.scrollIntoViewIfNeeded();
    const beforeNext = await stagePanel.evaluate((element) => element.scrollTop);
    await clickPageControl(page, "button-member-group-next", breakpoint.second, { dispatch: true });
    await expect.poll(() => stagePanel.evaluate((element) => element.scrollTop)).toBe(beforeNext);

    const previous = page.getByTestId("button-member-group-prev");
    await previous.scrollIntoViewIfNeeded();
    const beforePrevious = await stagePanel.evaluate((element) => element.scrollTop);
    await clickPageControl(page, "button-member-group-prev", breakpoint.first, { dispatch: true });
    await expect.poll(() => stagePanel.evaluate((element) => element.scrollTop)).toBe(beforePrevious);
  }

  expect(state.writes.filter((entry) => entry.endsWith("(rejected)"))).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
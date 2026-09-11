import { test, expect } from "@playwright/test";

const TENANT = {
  id: "tenant-canvas-fixture",
  name: "Canvas Fixture Tenant",
  slug: "canvas-fixture",
};

const MEMBER = {
  id: "member-canvas-fixture",
  email: "canvas.fixture@example.invalid",
  first_name: "Canvas",
  last_name: "Fixture",
  tenant_id: TENANT.id,
  role_id: "role-canvas-fixture",
  organization_id: "org-canvas-fixture",
  member_excluded_features: [],
};

const ROLE = {
  id: MEMBER.role_id,
  name: "Canvas fixture role",
  excluded_features: [],
};

const WIDGETS = {
  chart: {
    id: "canvas-widget-chart",
    title: "Revenue by region",
    widget_type: "bar",
    scope: "shared",
    tenant_id: TENANT.id,
    width: "third",
    height: "medium",
    display_order: 0,
    config: {
      source: "members",
      groupBy: "region",
      measure: { aggregator: "count" },
    },
  },
  stat: {
    id: "canvas-widget-stat",
    title: "Active members",
    widget_type: "stat",
    scope: "shared",
    tenant_id: TENANT.id,
    width: "third",
    height: "medium",
    display_order: 1,
    config: {
      source: "members",
      measure: { aggregator: "count" },
    },
  },
  list: {
    id: "canvas-widget-list",
    title: "Members by region",
    widget_type: "list",
    scope: "shared",
    tenant_id: TENANT.id,
    width: "third",
    height: "medium",
    display_order: 2,
    config: {
      source: "members",
      groupBy: "region",
      measure: { aggregator: "count" },
    },
  },
};

const WIDGET_PAYLOADS = {
  [WIDGETS.chart.id]: {
    type: "group",
    rows: [
      { key: "North", value: 7 },
      { key: "South", value: 5 },
    ],
    total: 12,
  },
  [WIDGETS.stat.id]: {
    type: "scalar",
    value: 42,
    total: 42,
  },
  [WIDGETS.list.id]: {
    type: "group",
    rows: [
      { key: "North", value: 7 },
      { key: "South", value: 5 },
    ],
    total: 12,
  },
};

function dynamicWidget(widgetId, id, overrides = {}) {
  return {
    id,
    type: "dynamic-widget",
    name: `Dynamic ${widgetId}`,
    geom: { x: 0, y: 0, w: 600, h: 400 },
    style: {
      background: "#ffffff",
      borderWidth: 1,
      borderColor: "#e5e7eb",
      borderRadius: 8,
      opacity: 1,
    },
    content: {
      widgetId,
      // This field is deliberately present in the fixture to ensure that a
      // dashboard response cannot become persisted Canvas content.
      copiedDashboardData: { shouldNotPersist: true },
    },
    ...overrides,
  };
}

function canvasDesign(version, {
  duplicateChart = false,
  allowUserResize = false,
} = {}) {
  const dynamicContent = (widgetId) => ({
    allowUserResize,
    copiedDashboardData: { shouldNotPersist: true },
  });
  // Keep V1's absolute blocks separate so a browser click selects the same
  // chart/stat/list instance that is visible in the screenshot. V2 ignores
  // these coordinates and uses the flow section below.
  const geometry = [
    { x: 0, y: 0, w: 600, h: 400 },
    { x: 620, y: 0, w: 600, h: 400 },
    { x: 0, y: 420, w: 600, h: 400 },
  ];
  const breakpointGeometry = (rect) => ({
    desktop: { ...rect },
    tablet: {
      x: 0,
      y: rect.y,
      w: Math.min(rect.w, 768),
      h: rect.h,
    },
    mobile: {
      x: 0,
      y: rect.y,
      w: 375,
      h: rect.h,
    },
  });
  const blocks = [
    dynamicWidget(WIDGETS.chart.id, `dynamic-chart-${version}`, {
      geom: geometry[0],
      bp: breakpointGeometry(geometry[0]),
      content: { widgetId: WIDGETS.chart.id, ...dynamicContent(WIDGETS.chart.id) },
    }),
    dynamicWidget(WIDGETS.stat.id, `dynamic-stat-${version}`, {
      geom: geometry[1],
      bp: breakpointGeometry(geometry[1]),
      content: { widgetId: WIDGETS.stat.id, ...dynamicContent(WIDGETS.stat.id) },
    }),
    dynamicWidget(WIDGETS.list.id, `dynamic-list-${version}`, {
      geom: geometry[2],
      bp: breakpointGeometry(geometry[2]),
      content: { widgetId: WIDGETS.list.id, ...dynamicContent(WIDGETS.list.id) },
    }),
  ];
  if (duplicateChart) {
    blocks.push(dynamicWidget(WIDGETS.chart.id, `dynamic-chart-copy-${version}`, {
      geom: geometry[0],
      bp: breakpointGeometry(geometry[0]),
      content: { widgetId: WIDGETS.chart.id, ...dynamicContent(WIDGETS.chart.id) },
    }));
  }

  if (version === 1) {
    return {
      version: 1,
      root: {
        background: null,
        groups: [],
        guides: { vertical: [], horizontal: [] },
        sections: [{ id: `section-v${version}`, children: blocks }],
      },
    };
  }

  return {
    version: 2,
    root: {
      background: null,
      groups: [],
      guides: { vertical: [], horizontal: [] },
      layout: "flow",
      sections: [{
        id: `section-v${version}`,
        type: "section",
        layoutMode: "flow",
        flow: { direction: "column", gap: 16, align: "stretch" },
        children: blocks.map((block) => ({
          ...block,
          layoutMode: "flow",
          flow: { heightMode: "fixed", height: 400, flex: "none" },
        })),
      }],
    },
  };
}

function pageFixture(version, {
  published = true,
  duplicateChart = false,
  allowUserResize = false,
} = {}) {
  const id = `canvas-dynamic-widget-v${version}`;
  return {
    id,
    title: `Canvas dynamic widgets V${version}`,
    slug: id,
    status: published ? "published" : "draft",
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: "full",
    tenant_id: TENANT.id,
    canvas_design: canvasDesign(version, { duplicateChart, allowUserResize }),
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

/**
 * Install a completely controlled Canvas/dashboard fixture. In particular,
 * no request from this suite can fall through to a real dashboard, Supabase,
 * or provider endpoint. The returned request log also makes accidental
 * writes and non-Canvas dashboard reads visible to the assertions.
 */
async function installFixtures(page, {
  version = 1,
  state = "ready",
  duplicateChart = false,
  allowUserResize = false,
  pageCanvasDesign = undefined,
} = {}) {
  const fixturePage = pageFixture(version, { duplicateChart, allowUserResize });
  if (pageCanvasDesign !== undefined) {
    fixturePage.canvas_design = pageCanvasDesign;
  }
  const requests = [];
  const writes = [];
  const pageErrors = [];
  const consoleErrors = [];
  let releaseLoading;
  let loadingReleased = false;
  const loadingGate = new Promise((resolve) => {
    releaseLoading = () => {
      loadingReleased = true;
      resolve();
    };
  });

  await page.addInitScript(({ member }) => {
    localStorage.setItem("agcas_member", JSON.stringify(member));
  }, { member: MEMBER });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    // A URL such as /src/api/base44Client.js is an application module, not
    // an API request. Restrict the fixture to root-level /api routes so Vite
    // modules retain their JavaScript MIME type.
    if (!path.startsWith("/api/")) {
      return route.continue();
    }
    requests.push({
      path,
      method,
      embed: url.searchParams.get("embed"),
      query: Object.fromEntries(url.searchParams.entries()),
    });

    if (path === "/api/auth/me") {
      return json(route, MEMBER);
    }
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        ...MEMBER,
        tenant: TENANT,
        tenantId: TENANT.id,
        memberId: MEMBER.id,
      });
    }
    if (path === `/api/entities/Role/${ROLE.id}`) {
      return json(route, ROLE);
    }
    if (path === `/api/entities/Member/${MEMBER.id}`) {
      return json(route, MEMBER);
    }
    if (path === `/api/entities/Organization/${MEMBER.organization_id}`) {
      return json(route, { id: MEMBER.organization_id, name: "Canvas Fixture Org" });
    }
    // The member/dashboard shell uses filtered collection reads rather than
    // the id-shaped endpoint in a few Layout branches.
    if (path === "/api/entities/Member") {
      return json(route, [MEMBER]);
    }
    if (path === "/api/entities/Organization") {
      return json(route, [{
        id: MEMBER.organization_id,
        name: "Canvas Fixture Org",
        program_ticket_balances: {},
        training_fund_balance: 0,
      }]);
    }
    if (path === "/api/entities/Role") {
      return json(route, [ROLE]);
    }
    if (path === "/api/entities/IEditPage") {
      return json(route, [fixturePage]);
    }
    if (path === "/api/public/page/" + fixturePage.slug) {
      return json(route, {
        success: true,
        page: fixturePage,
        elements: [],
        symbols: [],
      }, 200, { "Cache-Control": "no-store" });
    }
    if (path === `/api/canvas-design/${fixturePage.id}` && method === "GET") {
      return json(route, { page: fixturePage });
    }
    if (path === `/api/canvas-design/${fixturePage.id}` && method === "PUT") {
      writes.push({ path, method, body: request.postDataJSON?.() });
      return json(route, { page: fixturePage });
    }

    if (path === "/api/dashboard/widgets") {
      if (method !== "GET") {
        writes.push({ path, method, body: request.postDataJSON?.() });
        return json(route, { error: "Fixture does not allow widget writes" }, 405);
      }
      const shared = Object.values(WIDGETS);
      // The Canvas contract is intentionally shared-only and paginated,
      // while the dashboard contract includes both scopes.
      if (url.searchParams.get("embed") === "canvas") {
        const pageNumber = Number(url.searchParams.get("page") || 1);
        const pageSize = Number(url.searchParams.get("pageSize") || 50);
        const offset = (pageNumber - 1) * pageSize;
        const pageShared = shared.slice(offset, offset + pageSize);
        return json(route, {
          shared: pageShared,
          palette: [],
          pagination: {
            page: pageNumber,
            pageSize,
            total: shared.length,
            pages: Math.max(1, Math.ceil(shared.length / pageSize)),
            hasMore: offset + pageShared.length < shared.length,
          },
        });
      }
      return json(route, {
        shared,
        personal: [],
        palette: [],
        permissions: { view: true, manageShared: true, managePersonal: true },
      });
    }

    const widgetDataMatch = path.match(/^\/api\/dashboard\/widgets\/([^/]+)\/data$/);
    if (widgetDataMatch) {
      const widgetId = decodeURIComponent(widgetDataMatch[1]);
      if (state === "loading" && !loadingReleased) {
        await loadingGate;
      }
      if (state === "deleted") {
        return json(route, { error: "Widget not found" }, 404);
      }
      if (state === "denied") {
        return json(route, { error: "Dashboard not available for this role" }, 403);
      }
      const widget = Object.values(WIDGETS).find((item) => item.id === widgetId);
      if (!widget) {
        return json(route, { error: "Widget not found" }, 404);
      }
      const payload = state === "empty"
        ? { type: "group", rows: [], total: 0 }
        : WIDGET_PAYLOADS[widgetId];
      return json(route, { widget, data: payload });
    }

    const widgetMatch = path.match(/^\/api\/dashboard\/widgets\/([^/]+)$/);
    if (widgetMatch) {
      const widgetId = decodeURIComponent(widgetMatch[1]);
      if (state === "deleted") {
        return json(route, { error: "Widget not found" }, 404);
      }
      if (state === "denied") {
        return json(route, { error: "Dashboard not available for this role" }, 403);
      }
      const widget = Object.values(WIDGETS).find((item) => item.id === widgetId);
      return widget
        ? json(route, { widget })
        : json(route, { error: "Widget not found" }, 404);
    }

    if (path.startsWith("/api/canvas-versions/")) {
      if (method !== "GET") {
        writes.push({ path, method, body: request.postDataJSON?.() });
      }
      return json(route, method === "GET" ? { versions: [] } : { version: {} });
    }
    // Opening the editor preview runs the existing accessibility audit. That
    // telemetry is an expected editor side effect, not a dashboard mutation.
    if (path.startsWith("/api/canvas-page-audits/")) {
      return json(route, method === "GET" ? { audits: [] } : { audit: {} });
    }

    // Layout and the editor have a number of optional metadata reads. Return
    // safe fixture-shaped empty values, but still record every request above.
    if (method === "GET") {
      if (path.includes("/branding") || path.includes("/settings")) {
        return json(route, { tenant: TENANT, branding: {} });
      }
      return json(route, []);
    }

    // Do not let a new mutation silently reach a real server.
    writes.push({ path, method, body: request.postDataJSON?.() });
    return json(route, { error: "Unexpected fixture mutation" }, 405);
  });

  return {
    fixturePage,
    requests,
    writes,
    pageErrors,
    consoleErrors,
    releaseLoading,
    wasLoadingReleased: () => loadingReleased,
  };
}

function dashboardCalls(requests, suffix) {
  return requests.filter((request) => (
    request.path.endsWith(suffix)
    && request.path.startsWith("/api/dashboard/widgets/")
  ));
}

async function expectCanvasApiScope(fixture) {
  const embedCalls = fixture.requests.filter((request) => (
    request.path.startsWith("/api/dashboard/widgets")
    && request.embed === "canvas"
  ));
  expect(embedCalls.length).toBeGreaterThan(0);
  expect(embedCalls.every((request) => request.embed === "canvas")).toBe(true);
}

async function assertWidgetCards(surface) {
  const chart = surface.getByTestId(`widget-card-${WIDGETS.chart.id}`).first();
  const stat = surface.getByTestId(`widget-card-${WIDGETS.stat.id}`).first();
  const list = surface.getByTestId(`widget-card-${WIDGETS.list.id}`).first();

  await expect(chart).toBeVisible();
  await expect(stat).toBeVisible();
  await expect(list).toBeVisible();
  await expect(chart).toContainText(WIDGETS.chart.title);
  await expect(chart).toContainText("North");
  await expect(chart).toContainText("South");
  await expect(chart.getByTestId(`widget-total-${WIDGETS.chart.id}`)).toContainText("12");
  await expect(stat).toContainText(WIDGETS.stat.title);
  await expect(stat).toContainText("42");
  await expect(list).toContainText(WIDGETS.list.title);
  await expect(list).toContainText("North");
  await expect(list).toContainText("South");
  await expect(list.getByTestId(`widget-list-${WIDGETS.list.id}`)).toBeVisible();
}

async function openPublished(page, fixturePage, diagnostics = null) {
  await page.goto(`/${fixturePage.slug}`);
  try {
    await expect(page.locator("[data-block-type='dynamic-widget']").first()).toBeVisible();
  } catch (error) {
    if (diagnostics) {
      error.message += `\nPage errors: ${JSON.stringify(diagnostics.pageErrors)}`
        + `\nConsole errors: ${JSON.stringify(diagnostics.consoleErrors)}`
        + `\nFixture requests: ${JSON.stringify(diagnostics.requests.slice(0, 40))}`;
    }
    throw error;
  }
  return page.locator("[data-testid^='widget-card-']");
}

async function openEditorPreview(page, fixturePage, diagnostics = null) {
  await page.goto(`/CanvasPageEditor?pageId=${fixturePage.id}`);
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  // Assert the actual builder stage before opening its iframe preview. This
  // keeps the test from passing by exercising only the published renderer.
  await expect(page.locator("[data-block-type='dynamic-widget']")).toHaveCount(3);
  await assertWidgetCards(page);
  await page.getByTestId("button-toggle-preview").click();
  const frame = page.frameLocator("iframe[data-testid='iframe-preview']");
  try {
    await expect(frame.locator("[data-block-type='dynamic-widget']").first()).toBeVisible();
  } catch (error) {
    if (diagnostics) {
      error.message += `\nPage errors: ${JSON.stringify(diagnostics.pageErrors)}`
        + `\nConsole errors: ${JSON.stringify(diagnostics.consoleErrors)}`
        + `\nFixture requests: ${JSON.stringify(diagnostics.requests.slice(-40))}`
        + `\nFrames: ${JSON.stringify(page.frames().map((item) => item.url()))}`;
    }
    throw error;
  }
  return frame;
}

for (const version of [1, 2]) {
  test(`V${version} published and builder preview keep chart/stat/list parity`, async ({ page }, testInfo) => {
    const fixture = await installFixtures(page, { version });
    const published = await openPublished(page, fixture.fixturePage, fixture);
    await assertWidgetCards(page);
    await expectCanvasApiScope(fixture);
    await page.screenshot({
      path: testInfo.outputPath(`canvas-v${version}-published-chart-stat-list.png`),
      fullPage: true,
    });

    const editorPreview = await openEditorPreview(page, fixture.fixturePage, fixture);
    await assertWidgetCards(editorPreview);
    await expectCanvasApiScope(fixture);

    // The shared widget data is rendered in both surfaces, but each surface
    // remains a Canvas embed and therefore never receives private/personal
    // dashboard data.
    await expect(page.locator("[data-testid^='widget-card-'][data-embedded='true']")).toHaveCount(3);
    await expect(editorPreview.locator("[data-testid^='widget-card-'][data-embedded='true']")).toHaveCount(3);
    if (version === 2) {
      // The editor preview is the published renderer in an iframe, so it
      // does not expose CanvasStage's editor-only content wrapper. Assert the
      // actual dynamic-widget render frame and its authored flow height.
      const editorWidget = editorPreview.locator("[data-testid='canvas-dynamic-widget-dynamic-chart-2']");
      await expect(editorWidget).toBeVisible();
      const contentBox = await editorWidget.boundingBox();
      expect(contentBox?.height || 0).toBeGreaterThanOrEqual(390);
    }
    const canvasBoxes = await page.locator("[data-testid^='widget-card-'][data-embedded='true']")
      .evaluateAll((cards) => cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }));
    expect(canvasBoxes).toHaveLength(3);
    expect(canvasBoxes.every(({ width, height }) => width > 0 && height > 0)).toBe(true);
    await editorPreview.locator("body").screenshot({
      path: testInfo.outputPath(`canvas-v${version}-builder-preview-chart-stat-list.png`),
    });
    expect(published).toBeTruthy();
    expect(fixture.writes).toEqual([]);
  });
}

for (const version of [1, 2]) {
  test(`V${version} optional viewer resize controls stay local and keyboard accessible`, async ({ page }) => {
    const fixture = await installFixtures(page, { version, allowUserResize: true });
    await page.goto(`/${fixture.fixturePage.slug}`);
    const block = page.locator("[data-block-type='dynamic-widget']").first();
    await expect(block).toBeVisible();

    const controls = block.locator("[data-testid^='canvas-dynamic-widget-resize-controls-']");
    await expect(controls).toBeVisible();
    await controls.click();
    const width = page.locator("input[aria-label='Dashboard widget width']").first();
    const handle = block.locator("[data-testid^='canvas-dynamic-widget-resize-handle-']");
    const widgetFrame = block.locator("[data-testid^='canvas-dynamic-widget-']").first();
    await expect(page.locator("[data-testid^='canvas-dynamic-widget-resize-popover-']").first()).toBeVisible();
    await expect(width).toBeVisible();
    await expect(handle).toHaveAttribute("aria-keyshortcuts", /ArrowLeft/);

    // The local-size attributes belong to DynamicWidgetRender's inner frame,
    // not the CanvasStage block wrapper (which has data-block-type).
    const before = Number(await widgetFrame.getAttribute("data-canvas-widget-local-width"));
    // Use the range's own press helper so Chromium dispatches the input event
    // to the Radix-ported control even when the V1 blocks overlap visually.
    await width.press("ArrowLeft");
    await expect.poll(async () => (
      Number(await widgetFrame.getAttribute("data-canvas-widget-local-width"))
    )).toBeLessThan(before);

    await handle.press("Home");
    await expect.poll(async () => (
      Number(await widgetFrame.getAttribute("data-canvas-widget-local-width"))
    )).toBeGreaterThanOrEqual(before);
    expect(fixture.writes).toEqual([]);
  });
}

test("narrow Canvas rendering fits the viewport and keeps embedded resize local", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await installFixtures(page, { version: 2 });
  await openPublished(page, fixture.fixturePage, fixture);
  await assertWidgetCards(page);

  const overflow = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    canvasScrollWidth: document.querySelector("[data-testid='canvas-page-renderer']")?.scrollWidth,
  }));
  expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  if (overflow.canvasScrollWidth != null) {
    expect(overflow.canvasScrollWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  }
  await expect(page.locator("[data-testid^='button-widget-resize-']")).toHaveCount(0);
  await expect(page.locator("[data-testid^='button-widget-resize-height-']")).toHaveCount(0);
});

test("duplicate widget references stay isolated by Canvas instance and never expose resize controls", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 2, duplicateChart: true });
  await openPublished(page, fixture.fixturePage, fixture);
  await assertWidgetCards(page);

  const blocks = page.locator("[data-block-type='dynamic-widget']");
  await expect(blocks).toHaveCount(4);
  await expect(page.getByTestId(`widget-card-${WIDGETS.chart.id}`)).toHaveCount(2);
  await expect(page.locator("[data-testid^='canvas-dynamic-widget-resize-controls-']")).toHaveCount(0);
  await expect(page.locator("[data-testid^='canvas-dynamic-widget-resize-handle-']")).toHaveCount(0);
  for (const block of await blocks.all()) {
    await expect(block.locator("[data-testid^='widget-card-']")).toHaveCount(1);
  }

  const chartDataCalls = dashboardCalls(fixture.requests, `/data`);
  expect(chartDataCalls.filter((request) => request.path.includes(WIDGETS.chart.id)).length).toBeGreaterThan(0);
  await expect(page.locator("[data-testid^='button-widget-resize-']")).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

test("loading and empty widget states are visible without leaking a private response", async ({ page }) => {
  const loading = await installFixtures(page, { version: 1, state: "loading" });
  await page.goto(`/${loading.fixturePage.slug}`);
  await expect(page.getByTestId(`widget-loading-${WIDGETS.chart.id}`).first()).toBeVisible();
  expect(loading.wasLoadingReleased()).toBe(false);

  loading.releaseLoading();
  await expect(page.getByTestId(`widget-card-${WIDGETS.chart.id}`).first()).toContainText("North");
  expect(loading.writes).toEqual([]);

  await page.unroute("**/*");
  const empty = await installFixtures(page, { version: 1, state: "empty" });
  await page.goto(`/${empty.fixturePage.slug}`);
  await expect(page.getByText("No data yet.").first()).toBeVisible();
  expect(empty.writes).toEqual([]);
});

for (const state of ["deleted", "denied"]) {
  test(`${state} widget references render an explicit unavailable state`, async ({ page }) => {
    const fixture = await installFixtures(page, { version: 1, state });
    await page.goto(`/${fixture.fixturePage.slug}`);
    const block = page.locator("[data-block-type='dynamic-widget']").first();
    await expect(block).toBeVisible();
    await expect(block).toContainText(/widget|dashboard|permission|access|available|found/i);
    await expect(block.getByTestId(`widget-card-${WIDGETS.chart.id}`)).toHaveCount(0);
    expect(fixture.writes).toEqual([]);
  });
}

test("Canvas embed API requests use the shared-only paginated contract", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1 });
  // A document origin is required for a relative fetch; the page itself is
  // also a useful guard that the fixture is installed before the contract
  // request is made.
  await page.goto(`/${fixture.fixturePage.slug}`);
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/dashboard/widgets?embed=canvas&page=1&pageSize=2");
    return { status: result.status, body: await result.json() };
  });
  expect(response.status).toBe(200);
  expect(response.body.shared).toHaveLength(2);
  expect(response.body.personal).toBeUndefined();
  expect(response.body.pagination).toMatchObject({
    page: 1,
    pageSize: 2,
    total: 3,
    pages: 2,
    hasMore: true,
  });
  await expectCanvasApiScope(fixture);
  expect(fixture.writes).toEqual([]);
});

test("existing dashboard still renders its normal non-Canvas WidgetCard contract", async ({ page }, testInfo) => {
  const fixture = await installFixtures(page, { version: 1 });
  await page.goto("/Dashboard");
  await expect(page.getByTestId(`widget-card-${WIDGETS.stat.id}`).first()).toBeVisible();
  await expect(page.getByTestId(`widget-card-${WIDGETS.stat.id}`).first()).toContainText("42");
  await expect(page.getByTestId(`widget-card-${WIDGETS.stat.id}`).first()).not.toHaveAttribute("data-embedded", "true");

  const dashboardData = dashboardCalls(fixture.requests, "/data");
  expect(dashboardData.length).toBeGreaterThan(0);
  expect(dashboardData.some((request) => request.embed === "canvas")).toBe(false);
  const dashboardBox = await page.getByTestId(`widget-card-${WIDGETS.stat.id}`).first().boundingBox();
  expect(dashboardBox?.width || 0).toBeGreaterThan(0);
  expect(dashboardBox?.height || 0).toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath("dashboard-chart-stat-list-regression.png"),
    fullPage: true,
  });
  expect(fixture.writes).toEqual([]);
});

test("editor persistence sends the normalized reference rather than dashboard data", async ({ page }) => {
  const fixturePage = pageFixture(1);
  const fixture = await installFixtures(page, {
    version: 1,
    pageCanvasDesign: fixturePage.canvas_design,
  });
  await page.goto(`/CanvasPageEditor?pageId=${fixture.fixturePage.id}`);
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  await expect(page.getByText("Dynamic Widget", { exact: true }).first()).toBeVisible();

  // Select the first block and use the existing keyboard shortcut for a
  // harmless design change. The saved payload is the important assertion:
  // WidgetCard data/config must not be copied into the Canvas document.
  const block = page.locator("[data-testid='canvas-block-dynamic-chart-1']");
  await expect(block).toBeVisible();
  await block.click();
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("button-save").click();
  await expect.poll(() => fixture.writes.filter((write) => write.method === "PUT").length)
    .toBeGreaterThan(0);
  const save = fixture.writes.find((write) => write.method === "PUT");
  expect(save.body.canvas_design.root.sections[0].children[0].content).toEqual({
    widgetId: WIDGETS.chart.id,
    allowUserResize: false,
  });
});
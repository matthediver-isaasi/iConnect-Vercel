import { test, expect } from "@playwright/test";

const FORM_SLUG = "embed-transition-fixture";
const PAGE_SLUG = "embed-transition-canvas";

const pageIds = {
  tallOne: "page-tall-one",
  shortOne: "page-short-one",
  tallTwo: "page-tall-two",
  shortTwo: "page-short-two",
  equalShort: "page-equal-short",
};

function textField(id, pageId, required = false) {
  return {
    id,
    page_id: pageId,
    type: "text",
    label: `Fixture field ${id}`,
    placeholder: `Enter ${id}`,
    required,
  };
}

function formFixture() {
  const repeated = (prefix, pageId, count) => Array.from(
    { length: count },
    (_, index) => textField(`${prefix}-${index + 1}`, pageId),
  );
  return {
    id: "embed-transition-form",
    slug: FORM_SLUG,
    name: "Embedded transition fixture",
    description: "Browser-only fixture for page sizing and scroll behavior.",
    form_type: "application",
    layout_type: "standard",
    require_authentication: false,
    is_active: true,
    prefill_source: "none",
    pages: [
      { id: pageIds.tallOne, title: "Tall page one" },
      { id: pageIds.shortOne, title: "Short required page" },
      { id: pageIds.tallTwo, title: "Tall page two" },
      { id: pageIds.shortTwo, title: "Short page two" },
      { id: pageIds.equalShort, title: "Equal short page" },
    ],
    fields: [
      ...repeated("tall-one", pageIds.tallOne, 12),
      textField("required-short", pageIds.shortOne, true),
      ...repeated("tall-two", pageIds.tallTwo, 12),
      textField("short-two", pageIds.shortTwo),
      {
        id: "short-two-toggle",
        page_id: pageIds.shortTwo,
        type: "boolean",
        label: "Compact fixture toggle",
        default_value: false,
      },
      textField("equal-short", pageIds.equalShort),
      {
        id: "show-delayed-fields",
        page_id: pageIds.equalShort,
        type: "boolean",
        label: "Show additional fields",
        default_value: false,
      },
      ...repeated("delayed", pageIds.equalShort, 8).map(field => ({
        ...field,
        starts_hidden: true,
      })),
    ],
    visibility_rules: Array.from({ length: 8 }, (_, index) => ({
      id: `show-delayed-${index + 1}`,
      conditions: [{
        field_id: "show-delayed-fields",
        operator: "equals",
        value: "true",
      }],
      actions: [{
        id: `show-delayed-action-${index + 1}`,
        action_type: "visibility",
        field_states: {
          [`delayed-${index + 1}`]: { visible: true },
        },
      }],
    })),
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    submit_button_text: "Do not submit",
  };
}

function formBlock(id, y) {
  const geom = { x: 40, y, w: 920, h: 420 };
  return {
    id,
    type: "form-embed",
    geom,
    bp: {
      desktop: geom,
      tablet: { x: 24, y, w: 720, h: 420 },
      mobile: { x: 8, y, w: 359, h: 420 },
    },
    content: {
      formSlug: FORM_SLUG,
      mode: "iframe",
      title: `Transition form ${id}`,
    },
    style: {
      background: "#f8fafc",
      borderColor: "#cbd5e1",
      borderWidth: 1,
      borderStyle: "solid",
    },
  };
}

function canvasTextBlock(id, y, height, html) {
  const geom = { x: 40, y, w: 920, h: height };
  return {
    id,
    type: "text",
    geom,
    bp: {
      desktop: geom,
      tablet: { x: 24, y, w: 720, h: height },
      mobile: { x: 8, y, w: 359, h: height },
    },
    content: { html },
    style: {},
  };
}

function canvasPageFixture() {
  return {
    id: "embed-transition-canvas-page",
    slug: PAGE_SLUG,
    name: "Embedded transition Canvas",
    status: "published",
    builder_type: "canvas",
    public_chrome: "none",
    canvas_design: {
      version: 1,
      root: {
        sections: [{
          id: "root",
          children: [
            canvasTextBlock(
              "transition-intro",
              40,
              60,
              "<h1>Embedded form transition fixture</h1><p>Introductory Canvas content above both forms.</p>",
            ),
            formBlock("transition-form-a", 160),
            formBlock("transition-form-b", 760),
            canvasTextBlock(
              "transition-downstream",
              1360,
              80,
              "<h2>Downstream Canvas content</h2><p>This must follow both independently resizing forms.</p>",
            ),
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
    body: JSON.stringify(body),
  });
}

async function installFixtures(page, { legacyMeasurement = false } = {}) {
  const state = {
    unexpectedWrites: [],
    externalRequests: [],
    pageErrors: [],
  };
  const baseURL = process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000");
  const localOrigin = new URL(baseURL).origin;
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("cookie-consent", "declined");
    if (window.self === window.top) {
      const installHeader = () => {
        if (document.querySelector("[data-fixture-sticky-header]")) return;
        const header = document.createElement("header");
        header.dataset.fixtureStickyHeader = "true";
        header.dataset.canvasSticky = "true";
        header.textContent = "Sticky fixture header";
        header.style.cssText = [
          "position:fixed",
          "inset:0 0 auto 0",
          "height:72px",
          "display:flex",
          "align-items:center",
          "padding:0 20px",
          "box-sizing:border-box",
          "background:#0f172a",
          "color:white",
          "z-index:100000",
        ].join(";");
        document.body.prepend(header);
      };
      if (document.body) installHeader();
      else document.addEventListener("DOMContentLoaded", installHeader, { once: true });
      window.__fixtureNavigationMessages = [];
      window.addEventListener("message", event => {
        if (event.data?.type === "iconn-form-page-navigated") {
          window.__fixtureNavigationMessages.push({
            height: event.data.height,
            source: event.source,
          });
        }
      });
    }
  });

  await page.context().route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.unexpectedWrites.push(`${request.method()} ${url.href}`);
      return json(route, { error: "Fixture blocks every network write" }, 599);
    }
    if (url.origin !== localOrigin) {
      if (![
        "cdnjs.cloudflare.com",
        "fonts.googleapis.com",
        "js.stripe.com",
        "va.vercel-scripts.com",
        "teeone.pythonanywhere.com",
      ].includes(url.hostname) && !url.pathname.includes("/storage/v1/object/public/")) {
        state.externalRequests.push(`${request.method()} ${url.href}`);
      }
      return route.abort();
    }
    return route.continue();
  });
  await page.context().route(/\/(?:rest|auth)\/v1\//, route => {
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: "Fixture blocks all writes" }, 599);
    }
    return json(route, []);
  });
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: "Fixture blocks all writes" }, 599);
    }
    if (path === "/api/auth/me") return json(route, null, 401);
    if (path === "/api/auth/tenant-user-me") return json(route, { user: null }, 401);
    if (path === `/api/public/form/${FORM_SLUG}`) return json(route, formFixture());
    if (path === `/api/public/page/${PAGE_SLUG}`) {
      return json(route, { page: canvasPageFixture(), elements: [], symbols: [] });
    }
    if (path === "/api/public/microsites") return json(route, { microsites: [] });
    if (path === "/api/public/tenant-branding") {
      return json(route, {
        success: true,
        branding: {
          name: "Transition fixture",
          primaryColor: "#155e75",
          footerSource: "standard",
        },
      });
    }
    if (path === "/api/public/navigation-items") return json(route, []);
    return json(route, []);
  });
  if (legacyMeasurement) {
    // Negative control: faithfully restore the former viewport-bound
    // documentElement.scrollHeight measurement without modifying production
    // files. Once the host gives the iframe a tall height this value cannot
    // shrink again, reproducing the defect the intrinsic wrapper fixes.
    await page.context().route("**/src/lib/formEmbedRuntime.js*", async route => {
      const response = await route.fetch();
      const original = await response.text();
      const transformed = original.replace(
        "const height = measureFormContent(root);",
        "const height = Math.ceil(document.documentElement.scrollHeight);",
      );
      if (transformed === original) {
        throw new Error("Legacy measurement transform did not match runtime source");
      }
      return route.fulfill({
        response,
        body: transformed,
        headers: {
          ...response.headers(),
          "content-type": "application/javascript",
        },
      });
    });
  }
  return state;
}

async function frameMetrics(page, index) {
  return page.locator('[data-testid="iframe-form-embed"]').nth(index).evaluate(iframe => {
    const block = iframe.closest("[data-cb]");
    const stage = block.closest(".canvas-stage");
    const iframeRect = iframe.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    return {
      iframeHeight: iframeRect.height,
      blockHeight: blockRect.height,
      blockTop: blockRect.top + window.scrollY,
      blockBottom: blockRect.bottom + window.scrollY,
      stageHeight: stage.getBoundingClientRect().height,
      scrollY: window.scrollY,
      viewportHeight: iframe.contentWindow.innerHeight,
      intrinsicRectHeight: iframe.contentDocument
        .querySelector("[data-form-embed-content]")?.getBoundingClientRect().height,
      intrinsicScrollHeight: iframe.contentDocument
        .querySelector("[data-form-embed-content]")?.scrollHeight,
    };
  });
}

async function blockMetrics(page, id) {
  return page.locator(`[data-cb="${id}"]`).evaluate(block => {
    const rect = block.getBoundingClientRect();
    return {
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
      height: rect.height,
    };
  });
}

async function expectSettledHeight(page, index, predicate) {
  await expect.poll(async () => {
    const metrics = await frameMetrics(page, index);
    return predicate(metrics) ? metrics.iframeHeight : -1;
  }).toBeGreaterThan(0);
  return frameMetrics(page, index);
}

async function navigate(frame, testId) {
  await frame.getByTestId(testId).click();
  await pageCounter(frame);
}

async function expectNavigationPosition(page, expectedCount, index = 0) {
  await expect.poll(() => page.evaluate(() => window.__fixtureNavigationMessages?.length || 0))
    .toBe(expectedCount);
  let position;
  await expect.poll(async () => {
    position = await page.locator('[data-testid="iframe-form-embed"]').nth(index).evaluate(iframe => {
      let headerBottom = 0;
      for (const header of document.querySelectorAll("header, nav, [data-canvas-sticky]")) {
        const style = getComputedStyle(header);
        const rect = header.getBoundingClientRect();
        if ((style.position === "sticky" || style.position === "fixed")
          && rect.bottom > 0 && rect.top < innerHeight) {
          headerBottom = Math.max(headerBottom, rect.bottom);
        }
      }
      return {
        actual: iframe.getBoundingClientRect().top,
        expected: headerBottom + 16,
        headerBottom,
      };
    });
    return Math.abs(position.actual - position.expected);
  }).toBeLessThanOrEqual(4);
  expect(position.headerBottom).toBeGreaterThan(0);
  expect(Math.abs(position.actual - position.expected)).toBeLessThanOrEqual(4);
}

function expectIntrinsicSizing(metrics) {
  const intrinsic = Math.max(metrics.intrinsicRectHeight, metrics.intrinsicScrollHeight);
  expect(Math.abs(metrics.iframeHeight - intrinsic)).toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.blockHeight - metrics.iframeHeight)).toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.viewportHeight - metrics.iframeHeight)).toBeLessThanOrEqual(2);
}

function expectedDownstreamGap(formMetrics) {
  // Canvas never pulls downstream authored content upward when an embed becomes
  // shorter than its 420px authored box. In that case the unused authored
  // portion remains in the gap; above 420px the original 180px gap is retained.
  return 180 + Math.max(0, 420 - formMetrics.blockHeight);
}

async function pageCounter(frame) {
  await expect(frame.getByText(/Page \d+ of 5/, { exact: true })).toBeVisible();
}

async function scrollWithoutAnimation(page, top) {
  await page.evaluate(value => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, value);
  }, top);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 740 },
]) {
  test(`${viewport.name}: Canvas iframe handles tall-short transitions, validation, equal height, and delayed visibility`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const state = await installFixtures(page);
    await page.goto(`/${PAGE_SLUG}`);

    const iframes = page.locator('[data-testid="iframe-form-embed"]');
    await expect(iframes).toHaveCount(2);
    const first = page.frameLocator('[data-testid="iframe-form-embed"]').first();
    await expect(first.getByText("Page 1 of 5", { exact: true })).toBeVisible();
    await expect(page.getByText("Embedded form transition fixture", { exact: true })).toBeVisible();
    await expect(page.getByText("Downstream Canvas content", { exact: true })).toBeAttached();
    const initialIntro = await blockMetrics(page, "transition-intro");
    const initialDownstream = await blockMetrics(page, "transition-downstream");

    // Initial iframe resizing must not move a visitor who has not interacted.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    let tallOne = await frameMetrics(page, 0);
    expect(tallOne.iframeHeight).toBeGreaterThan(700);
    expectIntrinsicSizing(tallOne);
    const initialSecond = await frameMetrics(page, 1);
    const authoredGap = 180;
    expect(Math.abs(
      initialSecond.blockTop - tallOne.blockBottom - expectedDownstreamGap(tallOne),
    )).toBeLessThanOrEqual(3);
    if (viewport.name === "desktop") {
      await page.setViewportSize({ width: 390, height: viewport.height });
      await page.waitForTimeout(300);
      const narrowMetrics = await frameMetrics(page, 0);
      expectIntrinsicSizing(narrowMetrics);
      expect(await page.evaluate(() => window.__fixtureNavigationMessages?.length || 0)).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(300);
      tallOne = await frameMetrics(page, 0);
      expectIntrinsicSizing(tallOne);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }

    // Put the first form's navigation in view. Successful navigation always
    // repositions the iframe start just below any sticky host chrome.
    await scrollWithoutAnimation(page, Math.max(1, tallOne.blockBottom - viewport.height + 30));
    await navigate(first, "button-next-page");
    await expect(first.getByText("Page 2 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 1);
    const shortOne = await expectSettledHeight(page, 0, metrics => (
      metrics.iframeHeight < tallOne.iframeHeight - 300
    ));
    expectIntrinsicSizing(shortOne);
    const secondAfterShrink = await frameMetrics(page, 1);
    const growthDelta = Math.max(0, tallOne.blockHeight - 420)
      - Math.max(0, shortOne.blockHeight - 420);
    expect(Math.abs((initialSecond.blockTop - secondAfterShrink.blockTop) - growthDelta)).toBeLessThanOrEqual(4);
    expect(Math.abs((tallOne.stageHeight - shortOne.stageHeight) - growthDelta)).toBeLessThanOrEqual(4);
    expect(Math.abs(
      secondAfterShrink.blockTop - shortOne.blockBottom - expectedDownstreamGap(shortOne),
    )).toBeLessThanOrEqual(3);
    const downstreamAfterShrink = await blockMetrics(page, "transition-downstream");
    expect(Math.abs(
      (initialDownstream.top - downstreamAfterShrink.top) - growthDelta,
    )).toBeLessThanOrEqual(4);
    expect((await blockMetrics(page, "transition-intro")).top).toBe(initialIntro.top);

    // Failed required validation is not a page transition: neither the parent
    // scroll nor the iframe/block height may change.
    const failedNext = first.getByTestId("button-next-page");
    await failedNext.scrollIntoViewIfNeeded();
    const beforeValidationY = await page.evaluate(() => window.scrollY);
    const beforeValidationMessages = await page.evaluate(
      () => window.__fixtureNavigationMessages?.length || 0,
    );
    await failedNext.click();
    await expect(first.getByText("Page 2 of 5", { exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    const afterValidation = await frameMetrics(page, 0);
    expect(Math.abs(afterValidation.iframeHeight - shortOne.iframeHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterValidation.scrollY - beforeValidationY)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.__fixtureNavigationMessages?.length || 0))
      .toBe(beforeValidationMessages);

    await first.getByPlaceholder("Enter required-short").fill("valid");
    await navigate(first, "button-next-page");
    await expect(first.getByText("Page 3 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 2);
    const tallTwo = await expectSettledHeight(page, 0, metrics => (
      metrics.iframeHeight > shortOne.iframeHeight + 300
    ));
    expect(Math.abs(tallTwo.iframeHeight - tallOne.iframeHeight)).toBeLessThan(80);
    expectIntrinsicSizing(tallTwo);

    await navigate(first, "button-next-page");
    await expect(first.getByText("Page 4 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 3);
    const shortTwo = await expectSettledHeight(page, 0, metrics => (
      metrics.iframeHeight < tallTwo.iframeHeight - 300
    ));
    expectIntrinsicSizing(shortTwo);

    // Page 5 has the same compact shape as page 4. Equal-height transitions
    // must still keep the form usable and must not create cumulative stage gaps.
    await navigate(first, "button-next-page");
    await expect(first.getByText("Page 5 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 4);
    const equalShort = await frameMetrics(page, 0);
    expect(Math.abs(equalShort.iframeHeight - shortTwo.iframeHeight)).toBeLessThanOrEqual(3);
    expectIntrinsicSizing(equalShort);

    // Conditional field visibility is a resize, not navigation. Even after
    // ResizeObserver's delayed reports settle it must not move the host page.
    const beforeVisibilityY = await page.evaluate(() => window.scrollY);
    await first.getByTestId("switch-boolean-show-delayed-fields").click();
    await expect(first.getByPlaceholder("Enter delayed-8")).toBeVisible();
    await expectSettledHeight(page, 0, metrics => (
      metrics.iframeHeight > equalShort.iframeHeight + 250
    ));
    await page.waitForTimeout(300);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - beforeVisibilityY)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.__fixtureNavigationMessages?.length || 0)).toBe(4);
    await first.getByTestId("switch-boolean-show-delayed-fields").click();
    await expect(first.getByPlaceholder("Enter delayed-8")).toHaveCount(0);
    const hiddenAgain = await expectSettledHeight(page, 0, metrics => (
      Math.abs(metrics.iframeHeight - equalShort.iframeHeight) <= 3
    ));
    expectIntrinsicSizing(hiddenAgain);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - beforeVisibilityY)).toBeLessThanOrEqual(2);

    // A delayed intrinsic DOM/image-like geometry update exercises the same
    // observer independently of form logic and must grow and shrink naturally
    // without being mistaken for page navigation.
    await first.locator("[data-form-embed-content]").evaluate(root => {
      setTimeout(() => {
        const image = document.createElement("img");
        image.dataset.fixtureDelayedGeometry = "true";
        image.alt = "";
        image.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='180'%3E%3C/svg%3E";
        image.style.cssText = "display:block;width:10px;height:180px";
        root.appendChild(image);
      }, 80);
    });
    const delayedGrow = await expectSettledHeight(page, 0, metrics => (
      metrics.iframeHeight > hiddenAgain.iframeHeight + 150
    ));
    expectIntrinsicSizing(delayedGrow);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - beforeVisibilityY)).toBeLessThanOrEqual(2);
    await first.locator("[data-fixture-delayed-geometry]").evaluate(element => element.remove());
    const delayedShrink = await expectSettledHeight(page, 0, metrics => (
      Math.abs(metrics.iframeHeight - hiddenAgain.iframeHeight) <= 3
    ));
    expectIntrinsicSizing(delayedShrink);
    expect(await page.evaluate(() => window.__fixtureNavigationMessages?.length || 0)).toBe(4);

    // Previous works repeatedly after both expansion and contraction.
    await navigate(first, "button-previous-page");
    await expect(first.getByText("Page 4 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 5);
    await navigate(first, "button-previous-page");
    await expect(first.getByText("Page 3 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 6);
    await navigate(first, "button-previous-page");
    await expect(first.getByText("Page 2 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 7);
    await navigate(first, "button-previous-page");
    await expect(first.getByText("Page 1 of 5", { exact: true })).toBeVisible();
    await expectNavigationPosition(page, 8);

    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-final-transition-state.png`),
      fullPage: true,
    });

    expect(state.unexpectedWrites).toEqual([]);
    expect(state.externalRequests).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

test("two Canvas form embeds resize independently without overlap or cumulative drift", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto(`/${PAGE_SLUG}`);
  const iframes = page.locator('[data-testid="iframe-form-embed"]');
  await expect(iframes).toHaveCount(2);
  const first = page.frameLocator('[data-testid="iframe-form-embed"]').nth(0);
  const second = page.frameLocator('[data-testid="iframe-form-embed"]').nth(1);
  await expect(first.getByText("Page 1 of 5", { exact: true })).toBeVisible();
  await expect(second.getByText("Page 1 of 5", { exact: true })).toBeVisible();
  await expect(page.getByText("Embedded form transition fixture", { exact: true })).toBeVisible();
  await expect(page.getByText("Downstream Canvas content", { exact: true })).toBeAttached();

  const initialA = await frameMetrics(page, 0);
  const initialB = await frameMetrics(page, 1);
  const initialIntro = await blockMetrics(page, "transition-intro");
  const initialDownstream = await blockMetrics(page, "transition-downstream");
  expectIntrinsicSizing(initialA);
  expectIntrinsicSizing(initialB);
  expect(Math.abs(
    initialB.blockTop - initialA.blockBottom - expectedDownstreamGap(initialA),
  )).toBeLessThanOrEqual(3);

  await navigate(first, "button-next-page");
  await expect(first.getByText("Page 2 of 5", { exact: true })).toBeVisible();
  const shrunkA = await expectSettledHeight(page, 0, metrics => (
    metrics.iframeHeight < initialA.iframeHeight - 300
  ));
  const unchangedB = await frameMetrics(page, 1);
  expect(Math.abs(unchangedB.iframeHeight - initialB.iframeHeight)).toBeLessThanOrEqual(2);
  expect(Math.abs(
    unchangedB.blockTop - shrunkA.blockBottom - expectedDownstreamGap(shrunkA),
  )).toBeLessThanOrEqual(3);
  const downstreamAfterA = await blockMetrics(page, "transition-downstream");
  const aGrowthDelta = Math.max(0, initialA.blockHeight - 420)
    - Math.max(0, shrunkA.blockHeight - 420);
  expect(Math.abs(
    (initialDownstream.top - downstreamAfterA.top) - aGrowthDelta,
  )).toBeLessThanOrEqual(4);

  await navigate(second, "button-next-page");
  await expect(second.getByText("Page 2 of 5", { exact: true })).toBeVisible();
  const shrunkB = await expectSettledHeight(page, 1, metrics => (
    metrics.iframeHeight < initialB.iframeHeight - 300
  ));
  expect(Math.abs((await frameMetrics(page, 0)).iframeHeight - shrunkA.iframeHeight)).toBeLessThanOrEqual(2);
  expect(Math.abs(
    shrunkB.blockTop - shrunkA.blockBottom - expectedDownstreamGap(shrunkA),
  )).toBeLessThanOrEqual(3);
  const downstreamAfterB = await blockMetrics(page, "transition-downstream");
  const bGrowthDelta = Math.max(0, initialB.blockHeight - 420)
    - Math.max(0, shrunkB.blockHeight - 420);
  expect(Math.abs(
    (downstreamAfterA.top - downstreamAfterB.top) - bGrowthDelta,
  )).toBeLessThanOrEqual(4);

  // Repeated A transitions must recompute from authored geometry rather than
  // accumulating earlier offsets or changing B's own document height.
  await first.getByPlaceholder("Enter required-short").fill("valid");
  await navigate(first, "button-next-page");
  await expect(first.getByText("Page 3 of 5", { exact: true })).toBeVisible();
  const grownA = await expectSettledHeight(page, 0, metrics => (
    metrics.iframeHeight > shrunkA.iframeHeight + 300
  ));
  const afterGrowB = await frameMetrics(page, 1);
  expect(Math.abs(afterGrowB.iframeHeight - shrunkB.iframeHeight)).toBeLessThanOrEqual(2);
  expect(Math.abs(
    afterGrowB.blockTop - grownA.blockBottom - expectedDownstreamGap(grownA),
  )).toBeLessThanOrEqual(3);

  await navigate(first, "button-next-page");
  await expect(first.getByText("Page 4 of 5", { exact: true })).toBeVisible();
  const reshrunkA = await expectSettledHeight(page, 0, metrics => (
    metrics.iframeHeight < grownA.iframeHeight - 300
  ));
  const finalB = await frameMetrics(page, 1);
  expect(Math.abs(reshrunkA.iframeHeight - shrunkA.iframeHeight)).toBeLessThan(100);
  expect(Math.abs(finalB.blockTop - shrunkB.blockTop)).toBeLessThan(5);
  expect(Math.abs(
    finalB.blockTop - reshrunkA.blockBottom - expectedDownstreamGap(reshrunkA),
  )).toBeLessThanOrEqual(3);
  const finalDownstream = await blockMetrics(page, "transition-downstream");
  expect(finalDownstream.top).toBeLessThan(initialDownstream.top);
  expect((await blockMetrics(page, "transition-intro")).top).toBe(initialIntro.top);
  const stage = page.locator(".canvas-stage");
  const stageBottom = await stage.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.bottom + window.scrollY;
  });
  // Text line boxes can end on a fractional pixel while the published stage
  // min-height is intentionally rounded to a whole pixel.
  expect(Math.abs(stageBottom - finalDownstream.bottom)).toBeLessThanOrEqual(6);

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("negative control: legacy document scrollHeight cannot shrink after a tall iframe", async ({ page }) => {
  const state = await installFixtures(page, { legacyMeasurement: true });
  await page.goto(`/${PAGE_SLUG}?legacy-measurement=1`);
  const first = page.frameLocator('[data-testid="iframe-form-embed"]').first();
  await expect(first.getByText("Page 1 of 5", { exact: true })).toBeVisible();
  const tall = await frameMetrics(page, 0);
  expect(tall.iframeHeight).toBeGreaterThan(700);

  await navigate(first, "button-next-page");
  await expect(first.getByText("Page 2 of 5", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  const trapped = await frameMetrics(page, 0);
  const intrinsic = Math.max(trapped.intrinsicRectHeight, trapped.intrinsicScrollHeight);
  expect(intrinsic).toBeLessThan(tall.iframeHeight - 300);
  expect(trapped.iframeHeight).toBeGreaterThanOrEqual(tall.iframeHeight - 2);
  expect(trapped.iframeHeight - intrinsic).toBeGreaterThan(300);

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
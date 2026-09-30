import { test, expect } from "@playwright/test";
import {
  FIELD_ID,
  PAGE_SLUG,
  blockTop,
  installGoCardlessCanvasFixture,
  outerFrameMetrics,
} from "./task-4517-gocardless-embed.fixture.mjs";

async function openCanvas(page) {
  await page.goto(`/${PAGE_SLUG}`);
  await expect(page.locator('[data-testid="iframe-form-embed"]')).toHaveCount(2);
  const first = page.frameLocator('[data-testid="iframe-form-embed"]').first();
  await expect(first.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`)).toBeVisible();
  await first.locator('input:not([type="hidden"])').first().fill("Sizing Applicant");
  return first;
}

async function openDropin(first) {
  await first.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`).click();
  await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toBeAttached();
}

test("desktop and mobile Canvas embeds reserve provider height without disturbing sibling ownership", async ({ page }, testInfo) => {
  const state = await installGoCardlessCanvasFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const first = await openCanvas(page);
  const before = await outerFrameMetrics(page);
  const secondBefore = await outerFrameMetrics(page, 1);
  const introBefore = await blockTop(page, "task-4517-intro");
  const downstreamBefore = await blockTop(page, "task-4517-downstream");
  expect(before.height).toBeLessThan(720);

  await openDropin(first);
  await expect.poll(async () => (await outerFrameMetrics(page)).height).toBeGreaterThanOrEqual(720);
  let open = await outerFrameMetrics(page);
  const secondOpen = await outerFrameMetrics(page, 1);
  expect(open.receipt).toMatchObject({
    connected: true,
    parent: "BODY",
    position: "fixed",
  });
  expect(Math.abs(open.receipt.height - open.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(open.receipt.width - open.width)).toBeLessThanOrEqual(2);
  expect(open.background).toBe("rgb(248, 250, 252)");
  expect(Math.abs(secondOpen.height - secondBefore.height)).toBeLessThanOrEqual(2);
  expect(secondOpen.blockTop).toBeGreaterThan(secondBefore.blockTop);
  expect(await blockTop(page, "task-4517-intro")).toBe(introBefore);
  expect(await blockTop(page, "task-4517-downstream")).toBeGreaterThan(downstreamBefore);

  // A provider can report success while its receipt remains visible. Underlying
  // confirmation content and repeated observer activity must not collapse that
  // body-level receipt before the provider returns/removes it.
  await first.locator("[data-form-embed-content]").evaluate(root => {
    window.__task4517Gc.receiptSuccessBeforeReturn();
    root.firstElementChild.style.display = "none";
    root.style.height = "120px";
    for (let index = 0; index < 4; index += 1) {
      window.dispatchEvent(new Event("resize"));
    }
  });
  await page.waitForTimeout(150);
  expect((await outerFrameMetrics(page)).height).toBe(open.height);

  await page.setViewportSize({ width: 390, height: 740 });
  await expect.poll(async () => (await outerFrameMetrics(page)).height).toBeGreaterThanOrEqual(820);
  const narrow = await outerFrameMetrics(page);
  expect(narrow.width).toBeLessThan(600);
  expect(Math.abs(narrow.receipt.height - narrow.height)).toBeLessThanOrEqual(2);
  expect((await outerFrameMetrics(page, 1)).receipt).toBeNull();
  const provider = first.frameLocator('body > iframe[id^="gocardless-dropin-iframe-"]');
  const providerScroll = await provider.locator("html").evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(providerScroll.scrollHeight).toBeGreaterThan(providerScroll.clientHeight);
  expect(providerScroll.overflowY).not.toBe("hidden");
  const bottomControl = await provider.locator("#provider-bottom-control").evaluate(element => {
    element.scrollIntoView({ block: "end" });
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
  });
  expect(bottomControl.top).toBeGreaterThanOrEqual(0);
  expect(bottomControl.bottom).toBeLessThanOrEqual(bottomControl.viewportHeight + 1);
  await page.screenshot({
    path: testInfo.outputPath("mobile-live-gocardless-reservation.png"),
    fullPage: true,
  });

  await first.locator("[data-form-embed-content]").evaluate(root => {
    root.firstElementChild.style.display = "";
    root.style.height = "";
  });
  await first.locator("html").evaluate(() => window.__task4517Gc.userExit());
  await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toHaveCount(0);
  await expect(first.getByText(/No Direct Debit was set up/)).toBeVisible();
  await expect.poll(async () => {
    const metrics = await outerFrameMetrics(page);
    return Math.abs(metrics.height - metrics.intrinsic);
  }).toBeLessThanOrEqual(2);
  const restored = await outerFrameMetrics(page);
  expect(Math.abs(restored.height - restored.intrinsic)).toBeLessThanOrEqual(2);
  expect(state.paymentCalls.filter(call => call.action === "create")).toHaveLength(1);
  expect(state.blockedWrites).toEqual([]);
  expect(state.blockedExternalRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("negative control proves a fixed provider receipt remains short when reservation detection is disabled", async ({ page }, testInfo) => {
  const state = await installGoCardlessCanvasFixture(page);
  await page.context().route("**/src/lib/formEmbedRuntime.js*", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const transformed = original.replace(
      "const paymentOverlay = () => windowObj.parent !== windowObj",
      "const paymentOverlay = () => false && windowObj.parent !== windowObj",
    );
    if (transformed === original) {
      throw new Error("Payment reservation negative-control transform did not match runtime source");
    }
    return route.fulfill({
      response,
      body: transformed,
      headers: { ...response.headers(), "content-type": "application/javascript" },
    });
  });
  const first = await openCanvas(page);
  const natural = await outerFrameMetrics(page);
  expect(natural.height).toBeLessThan(720);
  await openDropin(first);
  await page.waitForTimeout(250);
  const trapped = await outerFrameMetrics(page);
  expect(trapped.receipt.connected).toBe(true);
  expect(trapped.height).toBeLessThan(720);
  expect(Math.abs(trapped.height - natural.height)).toBeLessThanOrEqual(3);
  await page.screenshot({
    path: testInfo.outputPath("negative-control-short-provider.png"),
    fullPage: true,
  });
  expect(state.blockedWrites).toEqual([]);
  expect(state.blockedExternalRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("exit, reopen, success cleanup and existing confirmation restore intrinsic sizing", async ({ page }, testInfo) => {
  const state = await installGoCardlessCanvasFixture(page);
  const first = await openCanvas(page);
  await openDropin(first);
  await first.locator("html").evaluate(() => window.__task4517Gc.userExit());
  await expect(first.getByText(/No Direct Debit was set up/)).toBeVisible();
  await expect.poll(async () => (await outerFrameMetrics(page)).receipt).toBeNull();

  await openDropin(first);
  const reopened = await outerFrameMetrics(page);
  expect(reopened.receipt.id).toBe("gocardless-dropin-iframe-2");
  await first.locator("html").evaluate(() => window.__task4517Gc.success());

  await expect.poll(async () => state.paymentCalls.filter(call => call.action === "confirm").length).toBe(1);
  await expect(first.getByTestId("payment-return-screen")).toBeVisible();
  await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toHaveCount(0);
  await expect.poll(async () => {
    const metrics = await outerFrameMetrics(page);
    return Math.abs(metrics.height - metrics.intrinsic);
  }).toBeLessThanOrEqual(2);
  const lifecycle = await first.locator("html").evaluate(() => window.__task4517Gc);
  expect(lifecycle.opens).toBe(2);
  expect(lifecycle.successes).toBe(1);
  expect(lifecycle.receipts).toBe(0);
  // Cleanup must not surface the SDK's exit callback as an abandonment error.
  await expect(first.getByText(/No Direct Debit was set up/)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("desktop-success-cleanup.png"),
    fullPage: true,
  });
  expect(state.paymentCalls.map(call => call.action)).toEqual(["create", "create", "confirm"]);
  expect(state.blockedWrites).toEqual([]);
  expect(state.blockedExternalRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

for (const sdkMode of ["open-failure", "load-failure"]) {
  test(`${sdkMode} leaves no stale reservation and safely uses hosted fallback`, async ({ page }) => {
    const state = await installGoCardlessCanvasFixture(page, { sdkMode });
    const first = await openCanvas(page);
    const natural = await outerFrameMetrics(page);
    await first.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`).click();
    await expect(page.getByText("Hosted fallback opened safely")).toBeVisible({ timeout: 20_000 });
    expect(page.url()).toContain("/task-4517-hosted-fallback");
    expect(state.paymentCalls.map(call => call.action)).toEqual(["create"]);
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
    if (sdkMode === "open-failure") {
      expect(state.blockedExternalRequests).toEqual([]);
      expect(natural.height).toBeLessThan(720);
    } else {
      expect(state.blockedExternalRequests.some(request => (
        request.includes("pay.gocardless.com/billing/static/dropin/v2/initialise.js")
      ))).toBe(true);
    }
  });
}
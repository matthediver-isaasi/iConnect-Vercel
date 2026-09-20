import { test, expect } from "@playwright/test";
import {
  FIELD_ID,
  PAGE_SLUG,
  installGoCardlessCanvasFixture,
  outerFrameMetrics,
} from "./task-4517-gocardless-embed.fixture.mjs";

async function addStickyHeader(page) {
  await page.evaluate(() => {
    const header = document.createElement("header");
    header.dataset.canvasSticky = "true";
    header.textContent = "Fixture navigation";
    header.style.cssText = "position:fixed;inset:0 0 auto;height:72px;z-index:999;background:#0f172a;color:white";
    document.body.prepend(header);
  });
}

async function openLongCanvas(page, options, { fillApplicant = true, beforeGoto = null } = {}) {
  const state = await installGoCardlessCanvasFixture(page, {
    longPage: true,
    ...options,
  });
  await beforeGoto?.();
  await page.goto(`/${PAGE_SLUG}`);
  await expect(page.getByTestId("iframe-form-embed")).toHaveCount(2);
  await addStickyHeader(page);
  const first = page.frameLocator('[data-testid="iframe-form-embed"]').first();
  await expect(first.getByRole("textbox").first()).toBeVisible();
  if (fillApplicant) {
    await first.getByRole("textbox").first().fill("Reveal Applicant");
  }
  // Locator interaction can bring a lazy below-fold iframe into view. Every
  // reveal assertion starts at the top so only the production ready message
  // can reposition the containing Canvas page.
  await page.evaluate(() => window.scrollTo(0, 0));
  return { state, first };
}

async function successMessageCount(page) {
  return page.evaluate(() => window.__task4570SuccessMessages?.length || 0);
}

async function advanceCardSwipePayment(first, layoutType) {
  if (layoutType !== "card_swipe") return;
  await first.getByTestId("button-next-step").evaluate(button => button.click());
  await expect(first.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`)).toBeVisible();
}

async function assertRevealedBelowHeader(page, index = 0) {
  await expect.poll(async () => {
    const box = await page.getByTestId("iframe-form-embed").nth(index).boundingBox();
    return Math.abs((box?.y ?? -1000) - 88);
  }).toBeLessThanOrEqual(16);
  const bounds = await page.getByTestId("iframe-form-embed").nth(index).evaluate(iframe => {
    const rect = iframe.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, scrollY };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(72);
  expect(bounds.top).toBeLessThanOrEqual(92);
  expect(bounds.bottom).toBeGreaterThan(bounds.top);
  expect(bounds.scrollY).toBeGreaterThan(500);
  console.log(`REVEAL_BOUNDS ${JSON.stringify(bounds)}`);
  return bounds;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 740 },
]) {
  for (const provider of ["gocardless", "stripe"]) {
    test(`${viewport.name} long inline ${provider} completion reveals only the originating receipt`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const { state, first } = await openLongCanvas(page, {
        provider,
        delayOverlayRemovalMs: provider === "gocardless" ? 250 : 0,
      });
      await page.evaluate(() => window.scrollTo(0, 0));

      await first.getByTestId(`button-form-payment-${provider}-${FIELD_ID}`).evaluate(button => button.click());
      if (provider === "gocardless") {
        await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toBeAttached();
        await first.locator("html").evaluate(() => window.__task4517Gc.success());
        await expect.poll(() => successMessageCount(page)).toBe(0);
        await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toHaveCount(0);
      } else {
        await expect(first.getByTestId(`form-payment-stripe-element-${FIELD_ID}`)).toBeVisible();
        await first.getByTestId(`button-form-payment-confirm-${FIELD_ID}`).evaluate(button => button.click());
      }

      await expect(first.getByTestId("payment-return-screen")).toBeVisible();
      await expect.poll(() => successMessageCount(page)).toBe(1);
      const bounds = await assertRevealedBelowHeader(page);
      if (provider === "stripe") {
        await page.screenshot({
          path: testInfo.outputPath(`${viewport.name}-stripe-success-reveal.png`),
          fullPage: true,
        });
      }
      await expect(page.frameLocator('[data-testid="iframe-form-embed"]').nth(1).getByTestId("payment-return-screen")).toHaveCount(0);
      expect((await outerFrameMetrics(page, 1)).blockTop).toBeGreaterThan(bounds.scrollY);
      expect(state.paymentCalls.map(call => call.action)).toEqual(["create", "confirm"]);
      expect(state.blockedWrites).toEqual([]);
      expect(state.blockedExternalRequests).toEqual([]);
      expect(state.pageErrors).toEqual([]);

      // Success positioning is one-shot. Neither a later resize nor another
      // ready-shaped message may reclaim the host after the user scrolls away.
      await page.evaluate(() => window.scrollTo(0, 0));
      await first.locator("body").evaluate(() => {
        window.parent.postMessage({ type: "iconn-form-resize", height: 650 }, window.location.origin);
        window.parent.postMessage({ type: "iconn-form-success-ready", height: 650 }, window.location.origin);
      });
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => scrollY)).toBe(0);
    });
  }
}

for (const layoutType of ["standard", "card_swipe"]) {
  test(`normal ${layoutType} submission reveals success while failures and initial load never jump`, async ({ page }) => {
    const { state, first } = await openLongCanvas(page, {
      normalSubmission: true,
      layoutType,
    }, { fillApplicant: false });
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await successMessageCount(page)).toBe(0);

    // Required-field validation is not a completion and must not move the host.
    await first.getByTestId("button-submit-form").evaluate(button => button.click());
    await page.waitForTimeout(150);
    expect(await successMessageCount(page)).toBe(0);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(first.getByTestId("embed-form-success")).toHaveCount(0);

    await first.getByRole("textbox").first().fill("Reveal Applicant");
    await page.evaluate(() => window.scrollTo(0, 0));
    await first.getByTestId("button-submit-form").evaluate(button => button.click());
    await expect(first.getByTestId("embed-form-success")).toBeVisible();
    await expect.poll(() => successMessageCount(page)).toBe(1);
    await assertRevealedBelowHeader(page);
    expect(state.paymentCalls.map(call => call.action)).toEqual(["normal-submit"]);
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

for (const layoutType of ["standard", "card_swipe"]) {
  test(`GoCardless paid onPaid callback reveals the ${layoutType} success surface`, async ({ page }) => {
    const { state, first } = await openLongCanvas(page, {
      provider: "gocardless",
      layoutType,
      confirmationStatus: "paid",
      confirmationPaymentProvider: "gocardless",
      delayOverlayRemovalMs: 200,
    });
    await advanceCardSwipePayment(first, layoutType);
    await first.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`).evaluate(button => button.click());
    await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toBeAttached();
    await first.locator("html").evaluate(() => window.__task4517Gc.success());
    await expect(first.getByTestId("embed-form-success")).toBeVisible();
    await expect(first.getByTestId("payment-return-screen")).toHaveCount(0);
    await expect.poll(() => successMessageCount(page)).toBe(0);
    await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toHaveCount(0);
    await expect.poll(() => successMessageCount(page)).toBe(1);
    await assertRevealedBelowHeader(page);
    expect(state.paymentCalls.map(call => call.action)).toEqual(["create", "confirm"]);
    expect(state.blockedWrites).toEqual([]);
    expect(state.blockedExternalRequests).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

for (const layoutType of ["standard", "card_swipe"]) {
  test(`already-paid create response uses onPaid and reveals the ${layoutType} success surface`, async ({ page }) => {
    const { state, first } = await openLongCanvas(page, {
      provider: "gocardless",
      layoutType,
      alreadyPaid: true,
    });
    await advanceCardSwipePayment(first, layoutType);
    await first.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`).evaluate(button => button.click());
    await expect(first.getByTestId("embed-form-success")).toBeVisible();
    await expect.poll(() => successMessageCount(page)).toBe(1);
    await assertRevealedBelowHeader(page);
    expect(state.paymentCalls.map(call => call.action)).toEqual(["create"]);
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

test("server confirmation failure closes the overlay without publishing success-ready", async ({ page }) => {
  const { state, first } = await openLongCanvas(page, {
    provider: "gocardless",
    confirmationStatus: "failed",
    confirmationPaymentProvider: "gocardless",
  });
  await first.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`).evaluate(button => button.click());
  await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toBeAttached();
  await first.locator("html").evaluate(() => window.__task4517Gc.success());
  await expect(first.locator('body > iframe[id^="gocardless-dropin-iframe-"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await successMessageCount(page)).toBe(0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect(first.getByTestId("embed-form-success")).toHaveCount(0);
  await expect(first.getByTestId("payment-return-screen")).toHaveCount(0);
  expect(state.paymentCalls.map(call => call.action)).toEqual(["create", "confirm"]);
  expect(state.blockedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("an already-visible success receipt does not move the containing page", async ({ page }) => {
  const { state, first } = await openLongCanvas(page, {
    normalSubmission: true,
    longPage: false,
  });
  await page.getByTestId("iframe-form-embed").first().evaluate(iframe => {
    window.scrollTo(0, iframe.getBoundingClientRect().top + scrollY - 88);
  });
  const before = await page.evaluate(() => scrollY);
  await first.getByTestId("button-submit-form").evaluate(button => button.click());
  await expect(first.getByTestId("embed-form-success")).toBeVisible();
  await expect.poll(() => successMessageCount(page)).toBe(1);
  await page.waitForTimeout(300);
  expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThanOrEqual(2);
  expect(state.blockedWrites).toEqual([]);
});

test("negative control proves a committed receipt stays below the fold without success-ready wiring", async ({ page }) => {
  const { state, first } = await openLongCanvas(
    page,
    { normalSubmission: true },
    {
      beforeGoto: () => page.context().route(
        "**/src/components/canvas/blocks/dynamicBlocks.jsx*",
        async route => {
          const response = await route.fetch();
          const original = await response.text();
          const transformed = original.replace(
            "data?.type === FORM_SUCCESS_READY_MESSAGE",
            "data?.type === 'iconn-form-success-ready-disabled'",
          );
          if (transformed === original) {
            throw new Error("Success-ready negative-control transform did not match Canvas host source");
          }
          return route.fulfill({
            response,
            body: transformed,
            headers: { ...response.headers(), "content-type": "application/javascript" },
          });
        },
      ),
    },
  );
  await first.getByTestId("button-submit-form").evaluate(button => button.click());
  await expect(first.getByTestId("embed-form-success")).toBeVisible();
  await page.waitForTimeout(350);
  expect(await successMessageCount(page)).toBe(1);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(state.paymentCalls.map(call => call.action)).toEqual(["normal-submit"]);
  expect(state.blockedWrites).toEqual([]);
});

test("unrelayed payment-return-ready cannot reveal an embed", async ({ page }) => {
  const { state, first } = await openLongCanvas(page, { normalSubmission: true });
  await first.locator("body").evaluate(() => {
    window.parent.postMessage(
      { type: "iconn-form-payment-return-ready", height: 200 },
      window.location.origin,
    );
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await successMessageCount(page)).toBe(0);
  expect(state.paymentCalls).toEqual([]);
  expect(state.blockedWrites).toEqual([]);
});
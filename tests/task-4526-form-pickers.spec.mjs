import { test, expect } from "@playwright/test";
import {
  FORM_SLUG, TYPES, installPickerFixture, installExternalHost, simulateVisualViewport,
  openCanvas, canvasMetrics, pickerMetrics, settleMenu, triggerIn,
} from "./task-4526-form-pickers.fixture.mjs";

for (const tall of [false, true]) {
  for (const kind of ["standard", "country"]) {
    test(`baseline geometry: ${kind} ${tall ? "tall" : "short"}`, async ({ page }, testInfo) => {
      test.skip(process.env.PICKER_BASELINE !== "1", "Explicit pre-implementation reproduction only");
      const state = await installPickerFixture(page, { kind, tall });
      const frame = await openCanvas(page);
      await triggerIn(frame).scrollIntoViewIfNeeded();
      const before = await canvasMetrics(page);
      await triggerIn(frame).click();
      await settleMenu(frame);
      await page.waitForTimeout(350);
      const after = await canvasMetrics(page);
      const picker = await pickerMetrics(frame);
      const evidence = { kind, tall, before, after, picker };
      console.log(JSON.stringify(evidence));
      await testInfo.attach("geometry.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("baseline.png") });
      expect(state.blockedWrites).toEqual([]);
      expect(state.pageErrors).toEqual([]);
    });
  }
}

function assertNoReflow(before, after) {
  for (let index = 0; index < 2; index += 1) {
    expect(Math.abs(after.frames[index].height - before.frames[index].height)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.frames[index].docTop - before.frames[index].docTop)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.frames[index].intrinsic - before.frames[index].intrinsic)).toBeLessThanOrEqual(2);
  }
  expect(Math.abs(after.downstream - before.downstream)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.stageHeight - before.stageHeight)).toBeLessThanOrEqual(2);
}

async function assertContained(page, frame, { visualHeight, offsetTop = 0, index = 0 } = {}) {
  let result;
  await expect.poll(async () => {
    const host = await canvasMetrics(page);
    const picker = await pickerMetrics(frame);
    if (!picker.menu || !picker.trigger) return 9999;
    const box = host.frames[index];
    const top = Math.max(0, offsetTop - box.y);
    const bottom = Math.min(box.height, offsetTop + (visualHeight || host.viewport.height) - box.y);
    const left = Math.max(0, -box.x);
    const right = Math.min(box.width, host.viewport.width - box.x);
    result = { host, picker, visible: { top, bottom, left, right } };
    return Math.max(top - picker.menu.y, picker.menu.bottom - bottom,
      left - picker.menu.x, picker.menu.right - right, 0);
  }).toBeLessThanOrEqual(2);
  expect(result.picker.menu.height).toBeGreaterThan(50);
  return result;
}

async function chooseLast(frame, kind) {
  if (["country", "multicountry"].includes(kind)) {
    await frame.getByPlaceholder("Search countries...").fill("Zimbabwe");
    await frame.getByRole("option", { name: "Zimbabwe", exact: true }).click();
    if (kind === "multicountry") {
      await expect(triggerIn(frame)).toContainText("Zimbabwe");
      await frame.getByPlaceholder("Search countries...").press("Escape");
    }
    await expect(triggerIn(frame)).toContainText("Zimbabwe");
  } else {
    // Real list keyboard navigation and selection, not programmatic click.
    const focused = frame.locator(":focus");
    await focused.press("End");
    await expect(frame.getByRole("option", { name: "Fixture option 40", exact: true })).toBeFocused();
    await focused.press("Enter");
    await expect(triggerIn(frame)).toContainText("Fixture option 40");
  }
  await expect(triggerIn(frame)).toHaveAttribute("aria-expanded", "false");
  await expect(triggerIn(frame)).toBeFocused();
}

for (const mobile of [false, true]) {
  for (const tall of [false, true]) {
    for (const kind of TYPES) {
      test(`${mobile ? "mobile" : "desktop"} ${tall ? "tall" : "short"} ${kind}: contained, scrollable, selectable, no sibling reflow`, async ({ page }, testInfo) => {
        await page.setViewportSize(mobile ? { width: 390, height: 740 } : { width: 1440, height: 900 });
        const state = await installPickerFixture(page, { kind, tall });
        const frame = await openCanvas(page);
        await triggerIn(frame).scrollIntoViewIfNeeded();
        const before = await canvasMetrics(page);
        await triggerIn(frame).click();
        await settleMenu(frame);
        const geometry = await assertContained(page, frame);
        expect(geometry.picker.scrollable).toBe(true);
        if (!geometry.picker.dialog) {
          expect(Math.abs(geometry.picker.menu.width - geometry.picker.trigger.width)).toBeLessThanOrEqual(3);
          const gap = geometry.picker.side === "top"
            ? geometry.picker.trigger.y - geometry.picker.menu.bottom
            : geometry.picker.menu.y - geometry.picker.trigger.bottom;
          expect(gap).toBeGreaterThanOrEqual(0);
          expect(gap).toBeLessThanOrEqual(6);
        }
        assertNoReflow(before, await canvasMetrics(page));
        expect((await canvasMetrics(page)).scrollY).toBe(before.scrollY);
        await testInfo.attach("geometry.json", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
        if (kind === "country" || kind === "standard") {
          await page.screenshot({ path: testInfo.outputPath("open-picker.png") });
        }
        await chooseLast(frame, kind);
        assertNoReflow(before, await canvasMetrics(page));
        // Repeated open/close must preserve selection and restore focus.
        await triggerIn(frame).click();
        await settleMenu(frame);
        await frame.locator(":focus").press("Escape");
        await expect(triggerIn(frame)).toBeFocused();
        assertNoReflow(before, await canvasMetrics(page));
        if (["organisation", "relationship"].includes(kind)) expect(state.optionReads.length).toBeGreaterThan(0);
        expect(state.blockedWrites).toEqual([]);
        expect(state.pageErrors).toEqual([]);
      });
    }
  }
}

for (const kind of ["standard", "country"]) {
  test(`${kind}: open menu tracks host scroll/resize and closes when trigger leaves view`, async ({ page }) => {
    const state = await installPickerFixture(page, { kind, tall: true });
    const frame = await openCanvas(page);
    const triggerBox = await triggerIn(frame).boundingBox();
    await page.evaluate(y => { document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, y); }, triggerBox.y - 500);
    await triggerIn(frame).click();
    await settleMenu(frame);
    const before = await canvasMetrics(page);
    const initial = await assertContained(page, frame);
    expect(initial.picker.dialog).toBe(false);
    await page.evaluate(() => scrollBy(0, 40));
    await assertContained(page, frame);
    await page.setViewportSize({ width: 1100, height: 650 });
    await assertContained(page, frame);
    assertNoReflow(before, await canvasMetrics(page));
    await page.evaluate(() => scrollBy(0, 700));
    await expect(triggerIn(frame)).toHaveAttribute("aria-expanded", "false");
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });

  test(`${kind}: cramped viewport uses bounded fallback with keyboard and focus restoration`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    const state = await installPickerFixture(page, { kind });
    const frame = await openCanvas(page);
    const before = await canvasMetrics(page);
    // This is a simulated visual viewport, not proof of a native mobile IME.
    const box = await triggerIn(frame).boundingBox();
    const viewportTop = Math.max(0, box.y + box.height / 2 - 90);
    await simulateVisualViewport(page, { height: 180, offsetTop: viewportTop });
    await triggerIn(frame).click();
    await settleMenu(frame);
    await expect(frame.locator('[role="dialog"]')).toBeVisible();
    await assertContained(page, frame, { visualHeight: 180, offsetTop: viewportTop });
    await simulateVisualViewport(page, { height: 140, offsetTop: viewportTop + 20 });
    await assertContained(page, frame, { visualHeight: 140, offsetTop: viewportTop + 20 });
    if (kind === "standard") {
      await frame.locator(":focus").press("End");
      const last = frame.getByRole("option", { name: "Fixture option 40", exact: true });
      await expect(last).toBeFocused();
      expect((await canvasMetrics(page)).scrollY).toBe(before.scrollY);
      await last.press("Tab");
      await expect(frame.getByRole("button", { name: /close/i })).toBeFocused();
      await frame.locator(":focus").press("Shift+Tab");
      await expect(last).toBeFocused();
    } else {
      await expect(frame.getByPlaceholder("Search countries...")).toBeFocused();
    }
    await chooseLast(frame, kind);
    assertNoReflow(before, await canvasMetrics(page));
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });

  test(`${kind}: standalone stays on shared overlay and external iframe stays locally bounded`, async ({ page }) => {
    const state = await installPickerFixture(page, { kind });
    await page.goto(`/embed/form/${FORM_SLUG}`);
    await expect(triggerIn(page)).toBeVisible();
    await triggerIn(page).click();
    await settleMenu(page);
    await expect(page.locator("[data-form-picker-menu], [data-form-picker-dialog]")).toHaveCount(0);
    await chooseLast(page, kind);
    const frame = await installExternalHost(page, { height: 280 });
    await triggerIn(frame).click();
    await settleMenu(frame);
    const geometry = await pickerMetrics(frame);
    expect(geometry.menu.y).toBeGreaterThanOrEqual(0);
    expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.innerHeight + 2);
    expect(geometry.menu.x).toBeGreaterThanOrEqual(0);
    await chooseLast(frame, kind);
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

test("two embeds own selection and overlays independently; downstream remains stable", async ({ page }) => {
  const state = await installPickerFixture(page, { kind: "standard" });
  const first = await openCanvas(page);
  const second = page.frameLocator('[data-testid="iframe-form-embed"]').nth(1);
  const before = await canvasMetrics(page);
  await triggerIn(first).click();
  await settleMenu(first);
  await chooseLast(first, "standard");
  await expect(triggerIn(second)).not.toContainText("Fixture option 40");
  await triggerIn(second).click();
  await settleMenu(second);
  await assertContained(page, second, { index: 1 });
  await chooseLast(second, "standard");
  await expect(triggerIn(first)).toContainText("Fixture option 40");
  assertNoReflow(before, await canvasMetrics(page));
  expect(state.blockedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

for (const kind of ["standard", "country"]) {
  test(`${kind}: upper field opens downward when useful space exists`, async ({ page }, testInfo) => {
    const state = await installPickerFixture(page, { kind, tall: true, upper: true });
    const frame = await openCanvas(page);
    const before = await canvasMetrics(page);
    await triggerIn(frame).click();
    await settleMenu(frame);
    const geometry = await assertContained(page, frame);
    expect(geometry.picker.dialog).toBe(false);
    expect(geometry.picker.side).toBe("bottom");
    expect(geometry.picker.menu.y).toBeGreaterThanOrEqual(geometry.picker.trigger.bottom);
    await page.screenshot({ path: testInfo.outputPath("upper-downward-picker.png") });
    await chooseLast(frame, kind);
    assertNoReflow(before, await canvasMetrics(page));
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

for (const cramped of [false, true]) {
  test(`relationship multiple: ${cramped ? "cramped dialog" : "tall anchored"} search, two selections, retained query`, async ({ page }, testInfo) => {
    const state = await installPickerFixture(page, { kind: "relationship-multi", tall: !cramped, upper: !cramped });
    const frame = await openCanvas(page);
    if (cramped) {
      const trigger = await triggerIn(frame).boundingBox();
      await simulateVisualViewport(page, { height: 260, offsetTop: trigger.y + trigger.height / 2 - 130 });
    }
    const before = await canvasMetrics(page);
    await triggerIn(frame).click();
    await settleMenu(frame);
    const picker = await pickerMetrics(frame);
    expect(picker.dialog).toBe(cramped);
    expect(picker.scrollable).toBe(true);
    if (cramped) await expect(frame.locator("[data-form-picker-dialog]")).toBeVisible();
    else await assertContained(page, frame);
    assertNoReflow(before, await canvasMetrics(page));
    const search = frame.getByPlaceholder("Search related records…");
    await expect(search).toBeFocused();
    await search.fill("Fixture option 0");
    await frame.getByRole("option", { name: "Fixture option 01", exact: true }).click();
    await expect(search).toHaveValue("Fixture option 0");
    await frame.getByRole("option", { name: "Fixture option 02", exact: true }).click();
    await expect(search).toHaveValue("Fixture option 0");
    await expect(triggerIn(frame)).toContainText("2 selected");
    // Real answer pills can legitimately grow intrinsic content; unlike mere
    // opening, selecting multiple records isn't asserted to be layout-neutral.
    await expect(frame.getByTestId("relationship-selection-pills-picker").locator('[role="listitem"]')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("multi-relationship-selection.png") });
    await search.press("Escape");
    await expect(triggerIn(frame)).toBeFocused();
    await triggerIn(frame).click();
    await settleMenu(frame);
    await expect(triggerIn(frame)).toContainText("2 selected");
    await expect(frame.getByTestId("relationship-selection-pills-picker").locator('[role="listitem"]')).toHaveCount(2);
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

for (const kind of ["country", "relationship-multi"]) {
  test(`${kind}: open searchable menu hands off to keyboard dialog without losing query or focus`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 740 });
    const state = await installPickerFixture(page, { kind, tall: true, upper: true });
    const frame = await openCanvas(page);
    const before = await canvasMetrics(page);
    await triggerIn(frame).click();
    await settleMenu(frame);
    await expect(frame.locator("[data-form-picker-menu]")).toBeVisible();
    const search = frame.getByPlaceholder(kind === "country" ? "Search countries..." : "Search related records…");
    const query = kind === "country" ? "United" : "Fixture option 0";
    await search.fill(query);
    await expect(search).toBeFocused();
    // Relationship Command uses fuzzy matching (including record ids), unlike
    // Country's substring filter. Preserve the actual filtered result set,
    // rather than assuming both controls use the same search algorithm.
    await expect.poll(() => frame.getByRole("option").count()).toBeLessThan(40);
    const expectedMatches = await frame.getByRole("option").allTextContents();
    expect(expectedMatches.length).toBeGreaterThan(0);
    const trigger = await triggerIn(frame).boundingBox();
    const offsetTop = trigger.y + trigger.height / 2 - 130;
    await simulateVisualViewport(page, { height: 260, offsetTop });
    await expect(frame.locator("[data-form-picker-dialog]")).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue(query);
    await expect(frame.getByRole("option")).toHaveText(expectedMatches);
    await assertContained(page, frame, { visualHeight: 260, offsetTop });
    assertNoReflow(before, await canvasMetrics(page));
    expect((await canvasMetrics(page)).scrollY).toBe(before.scrollY);
    await page.screenshot({ path: testInfo.outputPath("keyboard-handoff.png") });
    await search.fill(kind === "country" ? "Zimbabwe" : "Fixture option 40");
    await expect.poll(() => frame.getByRole("option").count()).toBeLessThan(expectedMatches.length);
    await frame.getByRole("option", { name: kind === "country" ? "Zimbabwe" : "Fixture option 40", exact: true }).click();
    if (kind === "relationship-multi") await search.press("Escape");
    await expect(triggerIn(frame)).toBeFocused();
    await expect(triggerIn(frame)).toContainText(kind === "country" ? "Zimbabwe" : "Fixture option 40");
    expect(state.blockedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}
import { test, expect } from "@playwright/test";
import {
  TOKENS,
  VIEWER_A,
  VIEWER_B,
  TEMPLATE_HTML,
  canvasPage,
  installMemberTextFixture,
} from "./task-4508-canvas-member-text.fixtures.mjs";

function storedHtml(state) {
  return state.page.canvas_design.root.sections[0].children[0].content.html;
}

async function assertViewerOutput(page, version, viewer) {
  const block = page.locator(`[data-block-id="member-text-${version}"]`).first();
  await expect(block).toBeVisible();
  if (viewer) {
    await expect(block).toContainText(`Welcome ${viewer.first_name} ${viewer.last_name}.`);
    await expect(block).toContainText(`Role: ${viewer.job_title}.`);
    await expect(block).toContainText(`Organisation: ${viewer.organization_id ? viewer.organization_name : ""}.`);
    await expect(block.locator("strong")).toHaveText(viewer.first_name);
    await expect(block.locator("em")).toHaveText(viewer.last_name);
  } else {
    await expect(block).toContainText("Welcome .");
    await expect(block).toContainText("Role: .");
    await expect(block).toContainText("Organisation: .");
    await expect(block).not.toContainText(VIEWER_A.first_name);
    await expect(block).not.toContainText(VIEWER_A.organization_name);
  }
  for (const { token } of TOKENS) await expect(block).not.toContainText(token);
  await expect(block).toContainText("{{member.secret}}");
  await expect(block).not.toContainText("STALE ORGANISATION");
  return block;
}

test("Canvas picker inserts all four formatted tokens, saves only templates, and reopens", async ({ page }, testInfo) => {
  const state = { page: canvasPage(1, "<p>Welcome </p>"), writes: [], unexpectedWrites: [] };
  const fixture = await installMemberTextFixture(page, { state });
  await page.goto(`/CanvasPageEditor?pageId=${state.page.id}`);
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  const block = page.getByTestId("canvas-block-member-text-1");
  await expect(block).toBeVisible();
  await block.click();
  const field = page.getByTestId("input-text-content");
  const editor = field.locator(".tiptap[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await field.getByTestId("rte-btn-bold").click();

  for (const [index, option] of TOKENS.entries()) {
    const trigger = field.getByRole("button", { name: "Insert member data", exact: true });
    if (index === 1) {
      // Keyboard opening/selecting must retain the editor selection as well.
      await trigger.focus();
      await page.keyboard.press("Enter");
      const item = page.getByRole("menuitem", { name: `${option.label} ${option.token}`, exact: true });
      await item.focus();
      await page.keyboard.press("Enter");
    } else {
      await trigger.click();
      await page.getByRole("menuitem", { name: `${option.label} ${option.token}`, exact: true }).click();
    }
    await expect(editor).toContainText(option.token);
    await expect(editor.locator("strong")).toContainText(option.token);
    await expect(editor).toBeFocused();
    if (index < TOKENS.length - 1) await page.keyboard.type(" / ");
  }
  // TipTap's normal history must operate on token insertion, not personal data.
  await field.getByTestId("rte-btn-undo").click();
  await expect(editor).not.toContainText(TOKENS[3].token);
  await field.getByTestId("rte-btn-redo").click();
  await expect(editor).toContainText(TOKENS[3].token);
  await page.getByTestId("button-save").click();
  await expect.poll(() => state.writes.length).toBe(1);
  for (const { token } of TOKENS) expect(storedHtml(state)).toContain(token);
  expect(storedHtml(state)).toContain("<strong>");
  expect(JSON.stringify(state.writes)).not.toContain(VIEWER_A.first_name);
  expect(JSON.stringify(state.writes)).not.toContain(VIEWER_A.organization_name);
  await expect.poll(() => state.versionWrites?.length || 0).toBe(1);
  expect(state.versionWrites[0].body.design).toEqual(state.page.canvas_design);
  expect(JSON.stringify(state.versionWrites)).not.toContain(VIEWER_A.first_name);
  expect(JSON.stringify(state.versionWrites)).not.toContain(VIEWER_A.organization_name);

  await page.reload();
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  await page.getByTestId("canvas-block-member-text-1").click();
  for (const { token } of TOKENS) await expect(editor).toContainText(token);
  await expect(editor).not.toContainText(VIEWER_A.first_name);
  await expect(editor.locator("strong")).toContainText(TOKENS[0].token);
  await page.screenshot({ path: testInfo.outputPath("canvas-member-token-editor.png"), fullPage: true });
  expect(state.unexpectedWrites).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});

for (const version of [1, 2]) {
  test(`published V${version}: one saved template resolves independently for A, B and a stale-cache guest`, async ({ browser, baseURL }, testInfo) => {
    const state = { page: canvasPage(version), writes: [], unexpectedWrites: [] };
    const original = structuredClone(state.page.canvas_design);
    for (const viewer of [VIEWER_A, VIEWER_B, null]) {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      const fixture = await installMemberTextFixture(page, { version, viewer, state });
      try {
        await page.goto(`/${state.page.slug}`);
        await assertViewerOutput(page, version, viewer);
        await page.screenshot({
          path: testInfo.outputPath(`v${version}-${viewer?.id || "guest"}.png`),
          fullPage: true,
        });
        expect(fixture.pageErrors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    expect(state.page.canvas_design).toEqual(original);
    expect(storedHtml(state)).toBe(TEMPLATE_HTML);
    expect(state.writes).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
  });

  test(`published V${version}: missing linked organisation is blank despite stale organisation data`, async ({ page }) => {
    const viewer = { ...VIEWER_B, organization_id: null, organization_name: "" };
    const fixture = await installMemberTextFixture(page, { version, viewer });
    await page.goto(`/${fixture.state.page.slug}`);
    await assertViewerOutput(page, version, viewer);
    expect(fixture.state.unexpectedWrites).toEqual([]);
  });

  test(`published V${version}: malicious profile values remain literal text`, async ({ page }) => {
    const viewer = {
      ...VIEWER_B,
      first_name: '<img src=x onerror="window.__memberXss=1">',
      last_name: "<script>window.__memberXss=2</script>",
      job_title: "{{member.first_name}} & <b>Director</b>",
      organization_name: '"><svg onload="window.__memberXss=3">',
    };
    const fixture = await installMemberTextFixture(page, { version, viewer });
    await page.goto(`/${fixture.state.page.slug}`);
    const block = page.locator(`[data-block-id="member-text-${version}"]`).first();
    await expect(block).toBeVisible();
    for (const value of [viewer.first_name, viewer.last_name, viewer.job_title, viewer.organization_name]) {
      await expect(block).toContainText(value);
    }
    await expect(block.locator("img, script, svg, b")).toHaveCount(0);
    expect(await page.evaluate(() => window.__memberXss)).toBeUndefined();
    expect(storedHtml(fixture.state)).toBe(TEMPLATE_HTML);
    expect(fixture.state.unexpectedWrites).toEqual([]);
  });
}

test("an unresolved session never paints the cached previous viewer's token values", async ({ page }) => {
  const fixture = await installMemberTextFixture(page, { viewer: VIEWER_B, holdAuth: true });
  await page.goto(`/${fixture.state.page.slug}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).not.toContainText(VIEWER_A.first_name);
  await expect(page.locator("body")).not.toContainText(VIEWER_A.organization_name);
  fixture.releaseAuth();
  await assertViewerOutput(page, 1, VIEWER_B);
  expect(fixture.state.unexpectedWrites).toEqual([]);
});
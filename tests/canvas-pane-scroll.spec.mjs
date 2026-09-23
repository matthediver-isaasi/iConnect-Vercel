import { test, expect } from "@playwright/test";

const member = { id: "scroll-member", tenant_id: "scroll-tenant", role_id: "scroll-role", email: "scroll@example.invalid", member_excluded_features: [] };
const tenant = { id: member.tenant_id, slug: "scroll-fixture" };
async function fixture(page, { delayed = false, denied = false } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const errors = [];
  const writes = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(member => {
    localStorage.setItem("agcas_member", JSON.stringify(member));
    localStorage.setItem("canvas.layersPanel.open", "false");
  }, member);
  const record = {
    id: "scroll-page", title: "Independent scroll fixture", slug: "scroll-page",
    builder_type: "canvas", layout_type: "member", status: "draft",
    canvas_design: { version: 1, root: { sections: [{ id: "root", children: [
      { id: "heading", type: "text", geom: { x: 0, y: 0, w: 500, h: 180 }, bp: { desktop: { x: 0, y: 0, w: 500, h: 180 } }, content: { html: "<h1>Scroll fixture heading</h1>" } },
      { id: "end", type: "section", geom: { x: 0, y: 4000, w: 1000, h: 500 }, bp: { desktop: { x: 0, y: 4000, w: 1000, h: 500 } }, content: { bgType: "color" } },
    ] }] } },
  };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (route.request().method() !== "GET") {
      writes.push(path);
      return route.fulfill({ status: 405, body: "Fixture is read only" });
    }
    if (path === "/api/auth/me") return json(member);
    if (path === "/api/auth/tenant-user-me") {
      if (delayed) await gate;
      return json({ ...member, member, user: member, tenant, tenantId: tenant.id, memberId: member.id });
    }
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path.startsWith("/api/entities/Role")) {
      const role = { id: member.role_id, name: "Editor", excluded_features: denied ? ["site-builder.page-editor"] : [] };
      return json(path.endsWith(member.role_id) ? role : [role]);
    }
    if (path === "/api/entities/IEditPage") return json([record]);
    if (path === "/api/canvas-design/scroll-page") return json({ page: record });
    if (path === "/api/public/tenant-branding") return json({ success: true, branding: { tenant, tenantSlug: tenant.slug } });
    if (path === "/api/public/canvas-symbols") return json({ symbols: [] });
    if (path.includes("settings") && !path.includes("system-settings")) return json({ settings: {}, tenant, branding: {} });
    return json([]);
  });
  return { release, errors, writes };
}

const ids = ["panel-palette", "panel-stage", "panel-inspector"];
async function positions(page) {
  return page.evaluate(ids => [...ids.map(id => document.querySelector(`[data-testid="${id}"]`).scrollTop),
    document.querySelector("#main-content").scrollTop, window.scrollY], ids);
}
async function wheel(page, pane, delta) {
  const box = await pane.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 100));
  await page.mouse.wheel(0, delta);
  // Wheel events settle asynchronously, including boundary chaining.
  await page.waitForTimeout(250);
}

test("real route shell keeps each pane bounded and independent after resize", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/CanvasPageEditor?pageId=scroll-page");
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  if (await page.getByTestId("banner-cookie-consent").isVisible()) await page.getByTestId("button-decline-cookies").click();
  await page.getByTestId("canvas-block-heading").click();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1200, height: 700 }]) {
    await page.setViewportSize(viewport);
    // Change selection after resizing: the inspector must stay bounded as its
    // property content changes, not just for the initial empty panel.
    await page.getByTestId("canvas-block-heading").click();
    const heights = await page.getByTestId("panel-stage").evaluate(node => {
      const result = [];
      for (; node; node = node.parentElement) result.push({ tag: node.tagName, class: node.className, height: node.clientHeight, scroll: node.scrollHeight });
      return result;
    });
    await info.attach(`ancestor-heights-${viewport.height}`, { body: JSON.stringify(heights, null, 2), contentType: "application/json" });
    for (let i = 0; i < ids.length; i++) {
      const pane = page.getByTestId(ids[i]);
      expect(await pane.evaluate(n => n.scrollHeight - n.clientHeight), ids[i]).toBeGreaterThan(100);
      const before = await positions(page);
      await wheel(page, pane, 150);
      const after = await positions(page);
      expect(after[i], ids[i]).toBeGreaterThan(before[i]);
      expect(after.filter((_, j) => j !== i)).toEqual(before.filter((_, j) => j !== i));
      for (const bottom of [true, false]) {
        await pane.evaluate((n, bottom) => { n.scrollTop = bottom ? n.scrollHeight : 0; }, bottom);
        const boundary = await positions(page);
        await wheel(page, pane, bottom ? 700 : -700);
        expect(await positions(page)).toEqual(boundary);
      }
    }
    const editor = await page.getByTestId("canvas-page-editor").boundingBox();
    expect(editor.y).toBeGreaterThanOrEqual(0);
    expect(editor.y + editor.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.getByTestId("button-zoom-in")).toBeInViewport();
    await page.getByTestId("button-zoom-in").click();
    await expect(page.getByTestId("button-zoom-reset")).toHaveText("125%");
    await page.getByTestId("button-zoom-reset").click();
    const stage = page.getByTestId("panel-stage");
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.wheel(150, 0);
    await expect.poll(() => stage.evaluate(n => n.scrollLeft)).toBeGreaterThan(0);
    await stage.evaluate(n => { n.scrollLeft = 0; });
  }
  await page.screenshot({ path: info.outputPath("independent-panes.png") });
  expect(state.errors).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("session readiness and denied editor access remain gated", async ({ page }) => {
  const state = await fixture(page, { delayed: true, denied: true });
  await page.goto("/CanvasPageEditor?pageId=scroll-page");
  await expect(page.getByTestId("canvas-page-editor")).not.toBeVisible();
  state.release();
  await expect(page).toHaveURL(/\/Events/);
  await expect(page.getByTestId("canvas-page-editor")).not.toBeVisible();
});

test("ordinary portal content still scrolls in main", async ({ page }) => {
  await fixture(page);
  await page.goto("/Help");
  const main = page.locator("#main-content");
  await expect(main).toBeVisible();
  // Deterministic long content within the actual ordinary route shell.
  await main.evaluate(n => {
    const content = document.createElement("div");
    content.style.height = "4000px";
    content.textContent = "Long portal content";
    n.append(content);
  });
  await wheel(page, main, 500);
  expect(await main.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
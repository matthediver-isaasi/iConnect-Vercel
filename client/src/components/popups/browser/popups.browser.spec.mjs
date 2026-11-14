import { test, expect } from "@playwright/test";
import { popupFixtureRecord } from "./popupFixtureData.js";
import { popupEditorDimensions } from "../../../lib/popupEditorDimensions.js";

const dialog = (page) => page.locator("[data-cms-popup-modal]");
const block = (page, id) => dialog(page).locator(`[data-cb="${id}"]`).first();
async function mount(page, options = {}, { candidates, denyStorage = false, discovery = {} } = {}) {
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const records = candidates || [popupFixtureRecord(options)];
  let failSave = false;
  // Fixtures are static snapshots: keep Vite's reload socket local to the test.
  // The server's direct fallback has no port in middleware mode.
  await page.routeWebSocket(/[?&]token=/, () => {});
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (options.mode === "authoring" && url.pathname === "/src/hooks/useMemberAccess.js") return route.fulfill({
      contentType: "text/javascript",
      body: "export function useMemberAccess(){return {isAccessReady:true,isFeatureExcluded:()=>false,hasAccess:true,isAdmin:true};}",
    });
    if (url.pathname.startsWith("/api/")) {
      requests.push({ url: url.pathname + url.search, method: route.request().method(), body: route.request().postDataJSON() });
      if (url.pathname === "/api/cms-popups") {
        const context = { viewer_key: "guest", tenant_id: "fixture-tenant", timezone: "Europe/London" };
        const id = url.searchParams.get("id");
        const selected = records.find((record) => record.id === id);
        return route.fulfill({ json: id ? { ...context, popup: selected } : { ...context, candidates: records.map(({ design, symbols, ...record }) => record) } });
      }
      if (url.pathname === "/api/admin/cms-popups") {
        const record = records.find((record) => record.id === (route.request().postDataJSON()?.id || url.searchParams.get("id"))) || records[0];
        if (route.request().method() === "PATCH") {
          if (failSave) return route.fulfill({ status: 409, json: { error: "Fixture revision conflict" } });
          Object.assign(record, route.request().postDataJSON(), { revision: record.revision + 1 });
          return route.fulfill({ json: { popup: record } });
        }
        if (url.searchParams.has("discovery")) return route.fulfill({ json: { pages: [], microsites: [], fields: {}, timezone: "Europe/London", ...discovery } });
        return route.fulfill({ json: url.searchParams.has("id") ? { popup: record } : { popups: records } });
      }
      return route.fulfill({ json: url.pathname.includes("tenant-canvas-theme") ? { theme: null } : [] });
    }
    if (url.origin !== new URL(test.info().project.use.baseURL || "http://127.0.0.1:5000").origin) return route.abort();
    if (url.pathname.startsWith("/__cms-popup-fixture") || ["/CanvasPopupEditor", "/PopupManagement"].includes(url.pathname)) return route.fulfill({
      contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
window.__POPUP_FIXTURE_OPTIONS__ = ${JSON.stringify({ ...options, denyStorage })};
await import('/src/components/popups/browser/PopupFixture.jsx');
</script></body></html>`,
    });
    return route.continue();
  });
  await page.goto("/__cms-popup-fixture/a");
  // The real Canvas registry has a large lazy Vite dependency graph. Permit
  // cold compilation without weakening any modal/interaction assertions.
  await expect(page.locator("[data-fixture-ready]")).toBeVisible({ timeout: 45000 });
  await expect.poll(() => page.evaluate(() => !!window.popupFixture?.ready)).toBe(true);
  return { errors, requests, records, failSave: (value) => { failSave = value; } };
}

for (const version of [1, 2]) {
  for (const [label, viewport, width, breakpoint] of [
    ["desktop", 1600, 1180, "desktop"],
    ["tablet", 1000, 880, "tablet"],
    ["mobile", 402, 380, "mobile"],
    ["narrow dialog in wide viewport", 1600, 400, "mobile"],
  ]) {
    test(`Canvas v${version}: ${label} uses modal content-width geometry`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 950 });
      const state = await mount(page, { version, width });
      await page.getByRole("button", { name: "Open preview" }).click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole("heading")).toContainText(breakpoint);
      await expect(block(page, `marker-${breakpoint}`)).toBeVisible();
      for (const other of ["desktop", "tablet", "mobile"].filter((bp) => bp !== breakpoint)) await expect(block(page, `marker-${other}`)).not.toBeVisible();
      await expect(dialog(page).getByText("A real Canvas announcement", { exact: false })).toBeVisible();
      await expect(dialog(page).getByRole("link", { name: "Canvas action" })).toBeVisible();
      const geometry = await dialog(page).evaluate((element) => {
        const stage = element.querySelector('[data-testid="canvas-page-stage"]');
        return { modal: element.getBoundingClientRect().width, stage: stage.getBoundingClientRect().width, overflow: element.scrollWidth - element.clientWidth };
      });
      expect(geometry.modal).toBeLessThanOrEqual(viewport - 23);
      expect(geometry.stage).toBeLessThanOrEqual(width - 46);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(state.errors).toEqual([]);
    });
  }
}

for (const version of [1, 2]) {
  test(`Canvas v${version}: internal overflow, visible close, focus trap, Escape and restoration`, async ({ page }) => {
    const state = await mount(page, { version, width: 400, tall: true });
    const origin = page.getByRole("button", { name: "Open preview" });
    await origin.click();
    await expect(dialog(page)).toBeVisible();
    const scroller = dialog(page).locator(".overflow-auto").first();
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(dialog(page).getByText("End of announcement")).toBeVisible();
    await expect(page.getByRole("button", { name: "Close popup" })).toBeInViewport();
    await expect.poll(() => page.evaluate(() => document.body.getAttribute("data-scroll-locked"))).not.toBeNull();
    await page.getByRole("button", { name: "Close popup" }).focus();
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await dialog(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(origin).toBeFocused();
    expect(state.errors).toEqual([]);
  });
}

test("ready priority beats a delayed higher priority, tie IDs are stable, and close never opens a second", async ({ page }) => {
  const ready = popupFixtureRecord({ id: "22222222-2222-4222-8222-222222222222", priority: 7 });
  const tied = popupFixtureRecord({ id: "33333333-3333-4333-8333-333333333333", priority: 7 });
  const delayed = popupFixtureRecord({ priority: 99, trigger: { type: "delay", value: 2 } });
  const state = await mount(page, { mode: "runtime" }, { candidates: [delayed, tied, ready] });
  await expect(dialog(page)).toBeVisible();
  expect(state.requests.filter((item) => item.url.includes("&id=")).map((item) => new URL(item.url, "http://fixture").searchParams.get("id"))).toEqual([ready.id]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2300);
  await expect(dialog(page)).toHaveCount(0);
  expect(state.requests.filter((item) => item.url.includes("&id="))).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test("query changes and history back/forward preserve consumed views; new navigation qualifies", async ({ page }) => {
  const state = await mount(page, { mode: "runtime" });
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Query only" }).click();
  await page.waitForTimeout(650);
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Page B", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goBack();
  await page.waitForTimeout(650);
  await expect(dialog(page)).toHaveCount(0);
  await page.goForward();
  await page.waitForTimeout(650);
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Page A", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  expect(state.requests.filter((item) => item.url.includes("&id="))).toHaveLength(3);
  expect(state.errors).toEqual([]);
});

test("pending consent defers presentation; functional-only consent cannot persist permanent dismissal", async ({ page }) => {
  const state = await mount(page, { mode: "runtime", consent: "pending" });
  await page.waitForTimeout(650);
  await expect(dialog(page)).toHaveCount(0);
  expect(state.requests.filter((item) => item.url.includes("&id="))).toHaveLength(0);
  await page.evaluate(() => window.popupFixture.consent(false));
  await expect(dialog(page)).toBeVisible();
  await page.getByRole("button", { name: "Don't show again" }).click();
  await expect(page.getByRole("alert")).toContainText("storage consent");
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("cms-popup:")))).toEqual([]);
  await page.getByRole("button", { name: "Hide for this session" }).click();
  await page.getByRole("button", { name: "Page B", exact: true }).click();
  await page.waitForTimeout(650);
  await expect(dialog(page)).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("storage denial leaves close/session fallback usable and permanent failure visible", async ({ page }) => {
  const state = await mount(page, { mode: "runtime" }, { denyStorage: true });
  await expect(dialog(page)).toBeVisible();
  await page.getByRole("button", { name: "Don't show again" }).click();
  await expect(page.getByRole("alert")).toContainText("storage is unavailable");
  await page.getByRole("button", { name: "Hide for this session" }).click();
  await page.getByRole("button", { name: "Page B", exact: true }).click();
  await page.waitForTimeout(650);
  await expect(dialog(page)).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

async function dirtyEditor(page) {
  await page.getByRole("button", { name: "Launch editor" }).click();
  const stage = page.getByTestId("canvas-stage");
  await expect(stage).toBeVisible({ timeout: 45000 });
  await page.getByTestId("canvas-block-popup-action").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  await stage.evaluate((element) => { element.dataset.fixtureIdentity = "retained-design"; });
  return stage;
}
const leaveDialog = (page) => page.getByTestId("dialog-popup-unsaved-changes");

const pageId = (n) => `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const assignmentPages = [
  { id: pageId(6), title: "zebra", status: "draft" },
  { id: pageId(3), title: "alpha", status: "draft" },
  { id: pageId(4), title: "", name: "Bravo", slug: "ignored", status: "published" },
  { id: pageId(2), title: "Alpha", status: "published" },
  { id: pageId(5), slug: "charlie", status: "published" },
  { id: pageId(7), title: "Microsite only", microsite_id: "micro", status: "published" },
];
async function openPages(page, name = "Fixture announcement") {
  await page.getByRole("button", { name: `Settings for ${name}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("tab", { name: "Pages", exact: true }).click();
  return page.getByRole("dialog");
}

test("page assignments sort fallback labels, search live, and save hidden selections", async ({ page }) => {
  const popup = popupFixtureRecord();
  popup.config = { ...popup.config, all_pages: false, page_ids: [pageId(6), pageId(9)] };
  const state = await mount(page, { mode: "authoring" }, { candidates: [popup], discovery: { pages: assignmentPages } });
  await page.getByRole("button", { name: "Launch management" }).click();
  const settings = await openPages(page);
  const rows = settings.locator("label").filter({ has: page.getByRole("checkbox") });
  await expect(rows).toHaveText(["Alphapublished", "alphadraft", "Bravopublished", "charliepublished", "zebradraft"]);
  const search = settings.getByRole("searchbox", { name: "Search pages" });
  await search.pressSequentially("  ALpH  ");
  await expect(rows).toHaveText(["Alphapublished", "alphadraft"]);
  await expect(settings.getByText(/2 selected pages/)).toBeVisible();
  await expect(settings.getByText("Unavailable page:", { exact: false })).toHaveCount(1);
  // Search alone must not set the unsaved-settings guard.
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(settings).toHaveCount(0);
  await openPages(page);
  await expect(search).toHaveValue("");
  await search.fill("brAV");
  await settings.getByRole("checkbox", { name: "Bravo" }).focus();
  await page.keyboard.press("Space");
  await expect(settings.getByText(/3 selected pages/)).toBeVisible();
  await search.fill("no such page");
  await expect(settings.getByText("No pages match your search.")).toBeVisible();
  await expect(settings.getByText("No eligible pages in this site yet.")).toHaveCount(0);
  await expect(settings.getByText("Unavailable page:", { exact: false })).toHaveCount(1);
  await settings.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(settings.getByText(/2 selected pages/)).toBeVisible();
  await search.fill("");
  await expect(rows).toHaveCount(5);
  await expect(settings.getByRole("checkbox", { name: "zebra" })).toBeChecked();
  await expect(settings.getByRole("checkbox", { name: "Bravo" })).toBeChecked();
  await search.fill("alpha");
  await settings.getByRole("switch", { name: "All eligible CMS pages in this site" }).click();
  await expect(search).toHaveCount(0);
  await expect(settings.getByText(/All scoped pages/)).toBeVisible();
  await settings.getByRole("switch", { name: "All eligible CMS pages in this site" }).click();
  await expect(search).toHaveValue("alpha");
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings).toHaveCount(0);
  const saved = state.requests.filter((request) => request.method === "PATCH");
  expect(saved).toHaveLength(1);
  expect(saved[0].body.config.page_ids).toEqual([pageId(6), pageId(4)]);
  expect(saved[0].body.config.all_pages).toBe(false);
  expect(saved[0].body.config).not.toHaveProperty("pageSearch");
  await openPages(page);
  await expect(search).toHaveValue("");
  await expect(settings.getByRole("checkbox", { name: "Bravo" })).toBeChecked();
  expect(state.errors).toEqual([]);
});

test("page assignments isolate microsites and distinguish empty eligibility", async ({ page }) => {
  const main = popupFixtureRecord();
  main.config.all_pages = false;
  const micro = { ...popupFixtureRecord({ id: pageId(20) }), name: "Microsite popup", microsite_id: "micro" };
  micro.config.all_pages = false;
  const empty = { ...popupFixtureRecord({ id: pageId(21) }), name: "Empty site popup", microsite_id: "empty" };
  empty.config.all_pages = false;
  const state = await mount(page, { mode: "authoring" }, { candidates: [main, micro, empty], discovery: {
    pages: assignmentPages, microsites: [{ id: "micro", name: "Microsite" }, { id: "empty", name: "Empty" }],
  } });
  await page.getByRole("button", { name: "Launch management" }).click();
  let settings = await openPages(page);
  await settings.getByLabel("Search pages").fill("Microsite");
  await expect(settings.getByText("No pages match your search.")).toBeVisible();
  await page.keyboard.press("Escape");
  settings = await openPages(page, "Microsite popup");
  await expect(settings.getByLabel("Search pages")).toHaveValue("");
  await expect(settings.getByRole("checkbox")).toHaveCount(1);
  await expect(settings.getByRole("checkbox", { name: "Microsite only" })).toBeVisible();
  await settings.getByLabel("Search pages").fill("alpha");
  await expect(settings.getByText("No pages match your search.")).toBeVisible();
  await page.keyboard.press("Escape");
  settings = await openPages(page, "Empty site popup");
  await settings.getByLabel("Search pages").fill("alpha");
  await expect(settings.getByText("No eligible pages in this site yet.")).toBeVisible();
  await expect(settings.getByText("No pages match your search.")).toHaveCount(0);
  expect(state.requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test("actual editor guards in-app navigation, failed save, retry/save-and-leave; cancel retains design and undo", async ({ page }) => {
  const state = await mount(page, { mode: "authoring" });
  const stage = await dirtyEditor(page);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  const editedX = await page.getByTestId("canvas-block-popup-action").evaluate((element) => element.style.left);
  await page.evaluate(() => window.popupFixture.navigate("/PopupManagement"));
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page).toHaveURL(/CanvasPopupEditor/);
  await leaveDialog(page).getByRole("button", { name: "Stay here" }).click();
  await expect(stage).toHaveAttribute("data-fixture-identity", "retained-design");
  await expect(page.getByTestId("canvas-block-popup-action")).toHaveCSS("left", editedX);
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  state.failSave(true);
  await page.getByRole("button", { name: "Back to popups" }).click();
  await leaveDialog(page).getByRole("button", { name: "Save and leave" }).click();
  await expect(leaveDialog(page).getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/CanvasPopupEditor/);
  await expect(stage).toHaveAttribute("data-fixture-identity", "retained-design");
  state.failSave(false);
  await leaveDialog(page).getByRole("button", { name: "Save and leave" }).click();
  await expect(page).toHaveURL(/PopupManagement/);
  expect(state.requests.filter((request) => request.method === "PATCH")).toHaveLength(2);
  expect(state.errors).toEqual([]);
});

test("actual editor restores cancelled browser Back and Forward without remounting or sentinel entries", async ({ page }) => {
  const state = await mount(page, { mode: "authoring" });
  const stage = await dirtyEditor(page);
  const index = await page.evaluate(() => history.state.idx);
  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page).toHaveURL(/CanvasPopupEditor/);
  await leaveDialog(page).getByRole("button", { name: "Stay here" }).click();
  expect(await page.evaluate(() => history.state.idx)).toBe(index);
  await expect(stage).toHaveAttribute("data-fixture-identity", "retained-design");
  // Change query in place without unmounting the editor, then return while clean.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.evaluate(() => window.popupFixture.navigate(`${location.pathname}${location.search}&later=1`));
  await page.goBack();
  await expect(page).not.toHaveURL(/later=1/);
  await page.getByTestId("canvas-block-popup-action").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page).not.toHaveURL(/later=1/);
  await leaveDialog(page).getByRole("button", { name: "Stay here" }).click();
  await expect(stage).toHaveAttribute("data-fixture-identity", "retained-design");
  await page.goBack();
  await leaveDialog(page).getByRole("button", { name: "Leave without saving" }).click();
  await expect(page).toHaveURL(/__cms-popup-fixture\/a$/);
  expect(state.errors).toEqual([]);
});

test("actual management settings guard modal close, design-editor navigation and history Back", async ({ page }) => {
  const state = await mount(page, { mode: "authoring" });
  await page.getByRole("button", { name: "Launch management" }).click();
  await page.getByRole("button", { name: "Settings for Fixture announcement" }).click();
  const settingsDialog = page.getByRole("dialog");
  await settingsDialog.getByRole("tab", { name: "Settings", exact: true }).click();
  const name = settingsDialog.getByLabel("Internal name");
  await name.fill("Edited announcement");
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Stay here" }).click();
  await expect(name).toHaveValue("Edited announcement");
  await settingsDialog.getByRole("tab", { name: "Design", exact: true }).click();
  await settingsDialog.getByRole("button", { name: "Open Canvas editor" }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page).toHaveURL(/PopupManagement/);
  await leaveDialog(page).getByRole("button", { name: "Stay here" }).click();
  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Stay here" }).click();
  await settingsDialog.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(name).toHaveValue("Edited announcement");
  await settingsDialog.getByRole("tab", { name: "Design", exact: true }).click();
  await settingsDialog.getByRole("button", { name: "Open Canvas editor" }).click();
  await leaveDialog(page).getByRole("button", { name: "Save and leave" }).click();
  await expect(page).toHaveURL(/CanvasPopupEditor/);
  expect(state.requests.filter((request) => request.method === "PATCH").map((request) => request.body.name)).toEqual(["Edited announcement"]);
  expect(state.errors).toEqual([]);
});

for (const version of [1, 2]) test(`actual v${version} editor stage and preview agree with modal padding, borders and simulated viewport gutter`, async ({ page }) => {
  const state = await mount(page, { mode: "authoring", version, width: version === 1 ? 800 : 1400, modal: { padding: 28, border_width: 3 } });
  await page.getByRole("button", { name: "Launch editor" }).click();
  const stage = page.getByTestId(version === 1 ? "canvas-stage" : "canvas-flow-stage");
  await expect(stage).toBeVisible({ timeout: 45000 });
  for (const viewport of ["desktop", "tablet", "mobile"]) {
    const expected = popupEditorDimensions(state.records[0].config, viewport);
    await page.getByRole("button", { name: `${viewport} canvas` }).click();
    if (version === 1) await expect(stage).toHaveAttribute("data-breakpoint", expected.breakpoint);
    await expect(stage).toHaveCSS("width", `${expected.contentWidth}px`);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog(page)).toHaveCSS("width", `${expected.modalWidth}px`);
    await expect(dialog(page).getByRole("heading")).toContainText(expected.breakpoint);
    await expect(dialog(page).getByTestId("canvas-page-stage")).toHaveCSS("width", `${expected.contentWidth}px`);
    await page.getByRole("button", { name: "Close popup" }).click();
  }
  expect(state.errors).toEqual([]);
});

test("v1 popup desktop overflow is display-clamped identically in builder and preview without rewriting geometry", async ({ page }) => {
  const popup = popupFixtureRecord({ width: 1400 });
  const action = popup.design.root.sections[0].children.find((child) => child.id === "popup-action");
  action.bp.desktop = { ...action.bp.desktop, x: 1560, w: 180 };
  const state = await mount(page, { mode: "authoring", width: 1400 }, { candidates: [popup] });
  await page.getByRole("button", { name: "Launch editor" }).click();
  await expect(page.getByTestId("canvas-stage")).toBeVisible({ timeout: 45000 });
  const expected = popupEditorDimensions(popup.config, "desktop");
  await expect(page.getByTestId("canvas-stage")).toHaveAttribute("data-breakpoint", "desktop");
  const position = await page.getByTestId("canvas-block-popup-action").evaluate((element) => ({ left: parseFloat(element.style.left), width: parseFloat(element.style.width) }));
  expect(position.left + position.width).toBeLessThanOrEqual(expected.contentWidth);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(block(page, "popup-action")).toHaveCSS("left", `${position.left}px`);
  await expect(block(page, "popup-action")).toHaveCSS("width", `${position.width}px`);
  expect(action.bp.desktop.x).toBe(1560);
  expect(state.requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

for (const kind of ["inbox", "newsletter"]) test(`late ${kind} dialog closes the popup promptly and retains external focus`, async ({ page }) => {
  const state = await mount(page, { mode: "runtime", focusOrigin: true });
  await expect(dialog(page)).toBeVisible();
  await page.evaluate((name) => {
    window.popupFixtureFocusStolen = false;
    document.getElementById("outside-focus").addEventListener("focus", () => { window.popupFixtureFocusStolen = true; });
    window.popupFixture.openDialog(name);
  }, kind);
  await expect(dialog(page)).toHaveCount(0, { timeout: 2000 });
  const external = page.getByTestId(`competing-${kind}`);
  const input = external.getByRole(kind === "inbox" ? "searchbox" : "textbox");
  await expect(input).toBeFocused();
  await page.waitForTimeout(150); // Include Radix's deferred unmount autofocus.
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.popupFixtureFocusStolen)).toBe(false);
  await page.keyboard.press("Tab");
  expect(await external.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await external.getByRole("button", { name: `Close ${kind}`, exact: true }).click();
  await page.waitForTimeout(650);
  await expect(dialog(page)).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

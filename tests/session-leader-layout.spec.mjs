import { test, expect } from "@playwright/test";

async function fixtures(page) {
  const member = { id: "fixture-member", tenant_id: "fixture-tenant", role_id: "fixture-role",
    first_name: "Sample", last_name: "Leader", email: "leader@example.invalid", status: "active" };
  const speaker = { id: "fixture-speaker", full_name: "Existing Leader", is_active: true,
    member_id: member.id, linked_member: member };
  const state = { writes: [], unexpected: [], errors: [] };
  page.on("pageerror", e => state.errors.push(e.message));
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.context().route(/\/(?:rest|auth)\/v1\//, route => json(route, [], 403));
  await page.context().route("**/api/**", route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    if (!path.startsWith("/api/")) return route.continue();
    if ((path === "/api/entities/Speaker" && method === "POST") ||
        (path === "/api/entities/Speaker/fixture-speaker" && method === "PATCH")) {
      state.writes.push({ path, method, body: req.postDataJSON() });
      return json(route, { id: speaker.id, ...req.postDataJSON() });
    }
    if (path === "/api/members/by-ids" && method === "POST") return json(route, [member]);
    if (path === "/api/entities/Member/fixture-member" && method === "PATCH"
        && Object.keys(req.postDataJSON()).join() === "last_activity") return json(route, member);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpected.push(`${method} ${path}`);
      return json(route, { error: "Unexpected fixture write" }, 599);
    }
    if (path === "/api/auth/me") return json(route, member);
    if (path === "/api/auth/tenant-user-me") return json(route, { user: member, tenant: { id: member.tenant_id } });
    if (path.startsWith("/api/entities/Member/")) return json(route, member);
    if (path === "/api/entities/Member" || path === "/api/members/search") return json(route, [member]);
    if (path === "/api/entities/Role" || path === "/api/entities/Role/fixture-role") {
      const role = { id: member.role_id, name: "Administrator", excluded_features: [] };
      return json(route, path.endsWith("/Role") ? [role] : role);
    }
    if (path === "/api/entities/SystemSettings") return json(route, [{
      id: "fixture-setting", setting_key: "speaker_module_name",
      setting_value: JSON.stringify({ singular: "Session Leader", plural: "Session Leaders" }),
    }]);
    if (path === "/api/admin/speakers/paginated") return json(route, {
      speakers: [speaker], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    return json(route, []);
  });
  await page.goto("/SpeakerManagement", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("button-add-speaker")).toHaveText("Add Session Leader");
  await page.getByRole("dialog", { name: "Cookie consent" }).getByRole("button", { name: "Decline" }).click();
  const bannerClose = page.getByRole("button", { name: "Close banner", exact: true });
  if (await bannerClose.isVisible()) await bannerClose.click();
  return state;
}

async function settle(dialog) {
  await expect(dialog).toBeVisible();
  await dialog.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
}

for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 320 }, { width: 1280, height: 720 }]) {
  test(`Add and Edit remain usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await fixtures(page);
    await page.getByTestId("button-add-speaker").click();
    const dialog = page.getByRole("dialog", { name: "Add Session Leader", exact: true });
    await settle(dialog);
    const geometry = await dialog.evaluate(el => {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el);
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        height: el.clientHeight, scrollHeight: el.scrollHeight, overflow: css.overflowY,
        display: css.display, rows: css.gridTemplateRows };
    });
    console.log(viewport, geometry);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
    const save = page.getByTestId("button-save-speaker");
    await expect(save).toBeInViewport({ ratio: 1 });
    const fields = page.getByTestId("speaker-editor-fields");
    const backgroundY = await page.evaluate(() => window.scrollY);
    expect(await fields.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(geometry.left).toBeGreaterThanOrEqual(8);
    expect(geometry.right).toBeLessThanOrEqual(viewport.width - 8);
    await fields.hover();
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => fields.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByTestId("checkbox-speaker-active")).toBeInViewport({ ratio: 1 });
    await expect(save).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY)).toBe(backgroundY);

    // A real touch gesture must scroll the form, not the page behind it.
    await fields.evaluate(el => { el.scrollTop = 0; });
    const box = await fields.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2, y = box.y + box.height * 0.8;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 5; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - box.height * 0.1 * i }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => fields.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await cdp.detach();
    expect(await page.evaluate(() => window.scrollY)).toBe(backgroundY);

    await save.click();
    await expect(page.getByText("Name is required", { exact: true })).toBeVisible();
    expect(state.writes).toEqual([]);
    // Keyboard traversal brings each clipped field into the internal viewport.
    await page.getByTestId("combobox-speaker-member").focus();
    const visited = new Set();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const focused = page.locator(":focus");
      const id = await focused.getAttribute("data-testid");
      if (id) visited.add(id);
      // Native textarea focus reveals the caret; short screens need not fit
      // every row of a multiline control at once.
      if (id === "input-speaker-biography") {
        await expect(focused).toBeInViewport();
        await page.keyboard.type("Keyboard biography");
        await expect(focused).toHaveValue("Keyboard biography");
      } else {
        await expect(focused).toBeInViewport({ ratio: 1 });
      }
      if (id === "button-save-speaker") break;
    }
    for (const id of ["input-speaker-name", "input-speaker-email", "input-speaker-job-title",
      "input-speaker-organization", "input-speaker-biography", "checkbox-speaker-active",
      "button-cancel-speaker", "button-save-speaker"]) expect(visited.has(id), id).toBe(true);
    await page.getByTestId("input-speaker-name").fill("New Fixture Leader");
    await save.click();
    await expect(dialog).toBeHidden();
    expect(state.writes[0]).toMatchObject({
      method: "POST", path: "/api/entities/Speaker", body: { full_name: "New Fixture Leader" },
    });

    await page.getByTestId("button-edit-speaker-fixture-speaker").click();
    const edit = page.getByRole("dialog", { name: "Edit Session Leader", exact: true });
    await settle(edit);
    await page.getByTestId("combobox-speaker-member").click();
    await page.getByTestId("combobox-speaker-member-search").fill("Sample");
    await page.getByTestId("combobox-speaker-member-option-fixture-member").click();
    await expect(page.getByTestId("input-speaker-name")).toHaveValue("Sample Leader");
    await page.getByTestId("input-speaker-biography").fill("Edited biography");
    await save.click();
    await expect(edit).toBeHidden();
    expect(state.writes[1]).toMatchObject({
      method: "PATCH", path: "/api/entities/Speaker/fixture-speaker",
      body: { full_name: "Sample Leader", member_id: "fixture-member", biography: "Edited biography" },
    });
    await page.mouse.move(0, 0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    for (const close of ["cancel", "close", "escape"]) {
      await page.getByTestId("button-add-speaker").click();
      await settle(dialog);
      if (close === "cancel") await page.getByTestId("button-cancel-speaker").click();
      else if (close === "close") await dialog.getByRole("button", { name: "Close", exact: true }).click();
      else await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    expect(state.writes).toHaveLength(2);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
    await page.getByTestId("button-add-speaker").click();
    await settle(dialog);
    await page.screenshot({ path: `/tmp/session-leader-${viewport.width}.png` });
  });
}
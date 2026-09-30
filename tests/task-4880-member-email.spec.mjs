import { test, expect } from "@playwright/test";

// Runs against the real Members route, but all API reads and the only allowed
// write are fulfilled in memory. No CRM message reaches a provider or database.
const tenantId = "48800000-0000-4000-8000-000000000001";
const memberId = "48800000-0000-4000-8000-000000000002";
const member = {
  id: memberId, tenant_id: tenantId, role_id: "48800000-0000-4000-8000-000000000003",
  email: "recipient@example.invalid", first_name: "Fixture", last_name: "Recipient",
  member_excluded_features: [],
};
const role = { id: member.role_id, name: "Administrator", tenant_id: tenantId, excluded_features: [] };
const origin = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000";

async function fixture(page) {
  const state = { sends: [], blocked: [], errors: [], history: [], response: "success", pending: null };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: "application/json", body: JSON.stringify(body),
  });
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== origin) {
      // Abort even read-only third-party assets and direct Supabase reads;
      // report external writes separately from these intentionally denied reads.
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) state.blocked.push(`${method} ${request.url()}`);
      return route.abort();
    }
    // Never intercept Vite's /src/api/ JavaScript modules.
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/me" && method === "GET") return json(route, {
      ...member,
      sessionRole: {
        status: "ready", member_id: member.id, tenant_id: tenantId, role_id: role.id, role,
      },
    });
    if (path === "/api/auth/tenant-user-me" && method === "GET") return json(route, {
      authenticated: true, user: member, tenantUser: { id: member.id, role: "admin" },
      tenant: { id: tenantId, name: "Fixture organisation", slug: "fixture" },
    });
    if (path === `/api/entities/Member/${memberId}` && method === "GET") return json(route, member);
    if (path === `/api/entities/Member/${memberId}` && method === "PATCH") {
      const update = request.postDataJSON();
      if (Object.keys(update).length === 1 && typeof update.last_activity === "string") {
        return json(route, { ...member, last_activity: update.last_activity });
      }
    }
    if (path === "/api/entities/Member" && method === "GET") return json(route, [member]);
    if (path === `/api/entities/Role/${role.id}` && method === "GET") return json(route, role);
    if (path === "/api/entities/Role" && method === "GET") return json(route, [role]);
    if (path === `/api/outlook/emails/${memberId}` && method === "GET") {
      return json(route, { emails: state.history });
    }
    if (path === "/api/outlook/sync" && method === "POST") return json(route, { synced: 0 });
    if (path === "/api/crm/send" && method === "POST") {
      const payload = request.postDataJSON();
      state.sends.push({ payload, headers: request.headers() });
      if (state.pending) await state.pending;
      if (state.response === "failure") return json(route, { error: "Fixture provider rejected message" }, 502);
      if (state.response === "unknown") return json(route, { error: "Fixture acceptance unknown", deliveryUnknown: true }, 502);
      state.history.unshift({
        id: `fixture-email-${state.sends.length}`, direction: "outbound",
        email_provider: "mailgun", subject: payload.subject,
        to_addresses: [{ address: payload.to }], cc_addresses: [],
        body_content_type: "html", body_preview: "Hello formatted recipient",
        // This models the server's accepted rendered HTML after sanitization and
        // footer processing; API tests separately assert the real server boundary.
        body_content: `${payload.body}<p>Fixture footer</p>`,
        sent_at: "2026-09-30T10:00:00.000Z",
      });
      return json(route, { success: true });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.blocked.push(`${method} ${path}`);
      return json(route, { error: `Unexpected fixture write: ${method} ${path}` }, 599);
    }
    if (path === "/api/public/tenant-branding") {
      return json(route, { success: true, branding: { id: tenantId, name: "Fixture organisation" } });
    }
    return json(route, []);
  });
  await page.goto(`/members/${memberId}?tab=communications`);
  const cookieConsent = page.getByRole("dialog", { name: "Cookie consent" });
  if (await cookieConsent.isVisible()) await cookieConsent.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("tab-member-communications")).toHaveAttribute("data-state", "active");
  await expect(page.getByText("Email History", { exact: true })).toBeVisible();
  return state;
}

const dialog = page => page.getByRole("dialog", { name: "Compose Email" });
const editor = page => dialog(page).locator(".tiptap[contenteditable]");

async function selectEditorText(page, text) {
  await editor(page).evaluate((element, needle) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(needle);
      if (index < 0) continue;
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      selection.removeAllRanges();
      selection.addRange(range);
      element.focus();
      return;
    }
    throw new Error(`Missing editor text: ${needle}`);
  }, text);
}

async function compose(page) {
  await page.getByTestId("button-compose-email").click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByTestId("input-email-to")).toHaveValue(member.email);
  await dialog(page).getByTestId("input-email-subject").fill("Formatting check");
}

test("Members Communications composes formatting and links as HTML; accepted content appears in history", async ({ page }) => {
  const state = await fixture(page);
  await compose(page);
  await dialog(page).getByTestId("input-email-cc").fill("copy@example.invalid");
  const rich = editor(page);
  await rich.fill("Hello recipient");
  await selectEditorText(page, "recipient");
  await dialog(page).getByTestId("button-rte-bold").click();
  await expect(rich.locator("strong")).toHaveText("recipient");
  await selectEditorText(page, "Hello");
  await dialog(page).getByTestId("button-rte-italic").click();
  await expect(rich.locator("em")).toHaveText("Hello");
  await selectEditorText(page, "recipient");
  await dialog(page).getByTestId("button-rte-underline").click();
  await expect(rich.locator("u")).toHaveText("recipient");
  await dialog(page).getByTestId("button-rte-add-link").click();
  const linkUrl = dialog(page).getByRole("textbox", { name: /link url|url/i });
  await linkUrl.fill("https://example.org/first");
  await dialog(page).getByTestId("button-rte-save-link").click();
  await expect(rich.locator('a[href="https://example.org/first"]')).toContainText("recipient");
  await rich.locator("a").click();
  await dialog(page).getByTestId("button-rte-add-link").click();
  await linkUrl.fill("https://example.org/updated");
  await dialog(page).getByTestId("button-rte-save-link").click();
  await expect(rich.locator('a[href="https://example.org/updated"]')).toHaveCount(1);
  await rich.locator("a").click();
  await dialog(page).getByTestId("button-rte-remove-link").click();
  await expect(rich.locator("a")).toHaveCount(0);
  await rich.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await dialog(page).getByTestId("button-rte-bullet-list").click();
  await page.keyboard.type("Bullet item");
  await expect(rich.locator("ul li")).toContainText("Bullet item");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await dialog(page).getByTestId("button-rte-numbered-list").click();
  await page.keyboard.type("Numbered item");
  await expect(rich.locator("ol li")).toContainText("Numbered item");
  await dialog(page).getByTestId("button-send-email").click();
  await expect(dialog(page)).toHaveCount(0);
  expect(state.sends).toHaveLength(1);
  const { payload, headers } = state.sends[0];
  expect(headers["x-tenant-id"]).toBe(tenantId);
  expect(payload).toMatchObject({
    memberId, tenantId, to: member.email, cc: "copy@example.invalid",
    subject: "Formatting check", bodyType: "html",
  });
  expect(payload.body).toContain("<strong>");
  expect(payload.body).toContain("<em>");
  expect(payload.body).toContain("<u>");
  expect(payload.body).toContain("<ul>");
  expect(payload.body).toContain("<ol>");
  await expect(page.getByTestId("button-email-fixture-email-1")).toBeVisible();
  await page.getByTestId("button-email-fixture-email-1").click();
  const shown = page.locator(".prose").filter({ hasText: "Fixture footer" }).last();
  await expect(shown.locator("strong")).toContainText("recipient");
  await expect(shown.locator("ul li")).toContainText("Bullet item");
  await expect(shown.locator("ol li")).toContainText("Numbered item");
  const formatting = await shown.evaluate(element => ({
    bold: getComputedStyle(element.querySelector("strong")).fontWeight,
    italic: getComputedStyle(element.querySelector("em")).fontStyle,
    underline: getComputedStyle(element.querySelector("u")).textDecorationLine,
    bullet: getComputedStyle(element.querySelector("ul li")).display,
    numbered: getComputedStyle(element.querySelector("ol li")).display,
  }));
  expect(Number(formatting.bold)).toBeGreaterThanOrEqual(600);
  expect(formatting.italic).toBe("italic");
  expect(formatting.underline).toContain("underline");
  expect(formatting.bullet).toBe("list-item");
  expect(formatting.numbered).toBe("list-item");
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("history presents accepted safe link as a clickable link", async ({ page }) => {
  const state = await fixture(page);
  await compose(page);
  await editor(page).fill("Read guide");
  await selectEditorText(page, "guide");
  await dialog(page).getByTestId("button-rte-add-link").click();
  await dialog(page).getByRole("textbox", { name: /link url|url/i }).fill("https://example.org/guide");
  await dialog(page).getByTestId("button-rte-save-link").click();
  await dialog(page).getByTestId("button-send-email").click();
  await expect(page.getByTestId("button-email-fixture-email-1")).toBeVisible();
  await page.getByTestId("button-email-fixture-email-1").click();
  const link = page.locator(".prose").filter({ hasText: "Fixture footer" }).last().getByRole("link", { name: "guide" });
  await expect(link).toHaveAttribute("href", "https://example.org/guide");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("rel", /noopener|noreferrer/);
  expect(state.sends).toHaveLength(1);
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("blank rich markup is unsendable, failed sends preserve draft, reopening clears it", async ({ page }) => {
  const state = await fixture(page);
  await compose(page);
  const rich = editor(page);
  await rich.fill(" \u00a0 ");
  await expect(dialog(page).getByTestId("button-send-email")).toBeDisabled();
  expect(state.sends).toHaveLength(0);
  await rich.fill("Keep this draft");
  state.response = "failure";
  await dialog(page).getByTestId("button-send-email").click();
  await expect(dialog(page)).toBeVisible();
  await expect(rich).toContainText("Keep this draft");
  await expect(dialog(page).getByTestId("input-email-subject")).toHaveValue("Formatting check");
  await dialog(page).getByTestId("button-cancel-email").click();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByTestId("button-compose-email").click();
  await expect(dialog(page).getByTestId("input-email-subject")).toHaveValue("");
  await expect(editor(page)).toBeEmpty();
  expect(state.sends).toHaveLength(1);
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("pending and uncertain acceptance never permit a duplicate send or a stale edit", async ({ page }) => {
  const state = await fixture(page);
  await compose(page);
  await editor(page).fill("One delivery only");
  let release;
  state.pending = new Promise(resolve => { release = resolve; });
  state.response = "unknown";
  try {
    await dialog(page).getByTestId("button-send-email").click();
    await expect.poll(() => state.sends.length).toBe(1);
    await expect(dialog(page).getByTestId("button-send-email")).toBeDisabled();
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    release();
    state.pending = null;
    await expect(dialog(page)).toContainText(/acceptance could not be confirmed/i);
    await expect(dialog(page).getByTestId("button-send-email")).toBeDisabled();
    await expect(editor(page)).toContainText("One delivery only");
    expect(state.sends).toHaveLength(1);
  } finally {
    release();
  }
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("short narrow viewport can reach subject, editor, toolbar and send controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 560 });
  const state = await fixture(page);
  await compose(page);
  await editor(page).fill("Visible on mobile");
  await expect(dialog(page).getByTestId("button-rte-bold")).toBeVisible();
  await expect(dialog(page).getByTestId("button-send-email")).toBeVisible();
  await dialog(page).getByTestId("button-send-email").scrollIntoViewIfNeeded();
  const bounds = await dialog(page).getByTestId("button-send-email").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(560);
  await dialog(page).screenshot({ path: testInfo.outputPath("narrow-compose.png") });
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});
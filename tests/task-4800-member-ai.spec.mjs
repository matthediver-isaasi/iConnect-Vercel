import { test, expect } from "@playwright/test";

// In-memory tenants only. Every API mutation is denied unless explicitly listed here.
const tenantA = "48000000-0000-4000-8000-000000000001";
const tenantB = "48000000-0000-4000-8000-000000000002";
const member = {
  id: "48000000-0000-4000-8000-000000000003", tenant_id: tenantA,
  role_id: "48000000-0000-4000-8000-000000000004",
  email: "member@example.invalid", first_name: "Fixture", member_excluded_features: [],
};
const original = { enabled: true, name: "Aurora", avatarUrl: "", backgroundColor: "#172554", textColor: "", description: "Aurora tenant introduction." };
const tenantBOriginal = { enabled: true, name: "Borealis", avatarUrl: "", backgroundColor: "#FDE047", description: "Borealis tenant introduction." };
const defaultDescription = "Your AI guide to everything in the member portal.";
const platformDescription = "Platform persona text must not appear in member introductions.";
const copy = value => structuredClone(value);

async function fixture(page, { admin = false, allowTestAsk = false } = {}) {
  const state = {
    currentTenant: tenantA, overrides: { [tenantA]: copy(original), [tenantB]: copy(tenantBOriginal) },
    writes: [], uploads: [], blocked: [], errors: [], reads: [],
    disabledOnAsk: false, holdTenantB: null, testAsks: [], testAskError: null, holdTestAsk: null, failConfig: false,
  };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.hostname === "fixture.invalid" && path === "/avatar.png") {
      return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64") });
    }
    if (url.origin !== (process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000")) {
      // No direct Supabase, analytics, providers or remote uploads in this suite.
      if (!["GET", "HEAD"].includes(method)) state.blocked.push(`${method} ${request.url()}`);
      return route.abort();
    }
    if (!path.startsWith("/api/")) return route.continue();
    const requestedTenant = request.headers()["x-tenant-id"] || state.currentTenant;
    state.reads.push(`${method} ${path} ${requestedTenant}`);
    if (path === "/api/auth/tenant-user-me" && method === "GET") return fulfill(route, {
      authenticated: admin, tenantUser: admin ? { id: member.id, role: "admin" } : null,
      ...(admin ? { tenant: { id: state.currentTenant, name: "Fixture tenant", settings: { member_ai_assistant: copy(state.overrides[state.currentTenant]) } } } : {}),
    });
    if (path === "/api/auth/me" && method === "GET") return fulfill(route, {
      ...member, tenant_id: state.currentTenant,
      sessionRole: { status: "ready", member_id: member.id, tenant_id: state.currentTenant, role_id: member.role_id,
        role: { id: member.role_id, name: "Member", tenant_id: state.currentTenant, excluded_features: [] } },
    });
    if (path === "/api/public/ai-help-persona" && method === "GET") {
      return fulfill(route, { name: "Platform Help", avatarUrl: "", description: platformDescription });
    }
    if (path === "/api/member-ai/config" && method === "GET") {
      if (state.failConfig) return fulfill(route, { error: "Fixture refresh failure" }, 503);
      if (requestedTenant === tenantB && state.holdTenantB) await state.holdTenantB;
      const override = copy(state.overrides[requestedTenant]);
      if (!override) return fulfill(route, { error: "Unknown fixture tenant" }, 404);
      // The config contract exposes the tenant's description, never the platform
      // persona's description (even when the tenant override is empty).
      return fulfill(route, { tenantId: requestedTenant, ...override, overrides: override, description: override.description || "" });
    }
    if (path === "/api/admin/tenant" && method === "PATCH" && admin) {
      const body = request.postDataJSON();
      if (Object.keys(body).join() !== "settings" || Object.keys(body.settings || {}).join() !== "member_ai_assistant") {
        state.blocked.push(`Unexpected tenant settings PATCH ${JSON.stringify(body)}`);
        return fulfill(route, { error: "Only assistant settings may be saved" }, 599);
      }
      const payload = body.settings.member_ai_assistant;
      if (typeof payload.enabled !== "boolean" || typeof payload.name !== "string" ||
          typeof payload.avatarUrl !== "string" || typeof payload.backgroundColor !== "string" ||
          typeof payload.description !== "string" || payload.description.length > 500 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(payload.description)) {
        state.blocked.push("Malformed assistant PATCH");
        return fulfill(route, { error: "Malformed assistant PATCH" }, 599);
      }
      state.writes.push({ tenantId: requestedTenant, payload: copy(payload) });
      state.overrides[requestedTenant] = copy(payload);
      return fulfill(route, { tenant: { id: requestedTenant, settings: { member_ai_assistant: copy(payload) } } });
    }
    if (path === "/api/integrations/upload-file" && method === "POST" && admin) {
      const form = request.postDataBuffer();
      if (!form?.includes(Buffer.from('name="file"'))) {
        state.blocked.push("Malformed image upload");
        return fulfill(route, { error: "Missing file" }, 599);
      }
      state.uploads.push(path);
      return fulfill(route, { file_url: "https://fixture.invalid/avatar.png" });
    }
    if (path === "/api/member-ai/conversations" && method === "GET") {
      return state.disabledOnAsk ? fulfill(route, { code: "assistant_disabled", error: "Disabled" }, 403) : fulfill(route, { conversations: [] });
    }
    if (path === "/api/member-ai/ask" && method === "POST") {
      if (state.disabledOnAsk) {
        state.overrides[requestedTenant].enabled = false;
        return fulfill(route, { code: "assistant_disabled", error: "Disabled" }, 403);
      }
      if (allowTestAsk && admin) {
        state.testAsks.push({ tenantId: requestedTenant, body: request.postDataJSON(), headers: request.headers() });
        if (state.holdTestAsk) {
          await state.holdTestAsk;
          if (requestedTenant !== state.currentTenant) return route.abort().catch(() => {});
        }
        if (state.testAskError) return fulfill(route, { error: state.testAskError }, 403);
        return fulfill(route, {
          answer: "Read the handbook [S1].",
          grounded: true,
          sources: [{ citationId: "S1", title: "Handbook", type: "resource", typeLabel: "Resource", link: "/Resources",
            dates: [{ label: "Published", value: "2026-02-10" }] }],
          escalation: { name: "Member team", instructions: "Contact a specialist.", email: "team@example.org" },
        });
      }
      state.blocked.push(`Unexpected provider ask ${path}`);
      return fulfill(route, { error: "Provider calls disabled" }, 599);
    }
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      state.blocked.push(`${method} ${path}`);
      return fulfill(route, { error: `Unexpected write: ${method} ${path}` }, 599);
    }
    if (path.includes("/Role/")) return fulfill(route, { id: member.role_id, tenant_id: state.currentTenant, name: "Member", excluded_features: [] });
    if (path === "/api/entities/Member") return fulfill(route, [{ ...member, tenant_id: state.currentTenant }]);
    if (path.includes("tenant-branding")) return fulfill(route, { success: true, branding: { id: state.currentTenant, name: "Fixture tenant", headerConfig: {}, footerConfig: {}, platformBranding: { enabled: false } } });
    if (path.includes("microsites")) return fulfill(route, { microsites: [] });
    if (path.includes("unread")) return fulfill(route, { unread_count: 0, conversations: [] });
    if (path === "/api/admin/xero-status") return fulfill(route, { tokens: [] });
    return fulfill(route, []);
  });
  return state;
}

const card = page => page.getByTestId("card-member-ai-assistant");
const save = page => card(page).getByTestId("button-save-ai-assistant");

test("admin settings save, reload, invalid colour, image upload and remove, disabled edits retained", async ({ page }, testInfo) => {
  const state = await fixture(page, { admin: true });
  await page.goto("/admin/settings");
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByTestId("input-ai-assistant-name")).toHaveValue("Aurora");
  await expect(card(page).getByTestId("input-ai-assistant-description")).toHaveValue(original.description);
  await card(page).screenshot({ path: testInfo.outputPath("editor.png") });
  await card(page).getByTestId("input-ai-assistant-color").fill("#123");
  await expect(save(page)).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  await card(page).getByTestId("input-ai-assistant-color").fill("#123456");
  await card(page).getByTestId("input-ai-assistant-name").fill("Orion");
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  expect(state.writes.at(-1).payload).toEqual({ enabled: true, name: "Orion", avatarUrl: "", backgroundColor: "#123456", textColor: "", description: original.description });
  await page.reload();
  await expect(card(page).getByTestId("input-ai-assistant-name")).toHaveValue("Orion");
  await card(page).getByTestId("input-ai-assistant-avatar").setInputFiles({
    name: "avatar.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(card(page).getByAltText("Assistant avatar preview")).toBeVisible();
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  expect(state.uploads).toHaveLength(1);
  expect(state.writes.at(-1).payload.avatarUrl).toBe("https://fixture.invalid/avatar.png");
  await card(page).getByRole("button", { name: "Remove" }).click();
  await card(page).getByTestId("switch-ai-assistant-enabled").click();
  await card(page).getByTestId("input-ai-assistant-name").fill("Later");
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  await page.reload();
  await expect(card(page).getByTestId("switch-ai-assistant-enabled")).toHaveAttribute("data-state", "unchecked");
  await expect(card(page).getByTestId("input-ai-assistant-name")).toHaveValue("Later");
  expect(state.writes.at(-1).payload).toEqual({ enabled: false, name: "Later", avatarUrl: "", backgroundColor: "#123456", textColor: "", description: original.description });
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("text colour round trip, independent override, invalid input and reset after refresh failure", async ({ page }, testInfo) => {
  const state = await fixture(page, { admin: true });
  await page.goto("/admin/settings");
  const text = card(page).getByTestId("input-ai-assistant-text-color");
  const background = card(page).getByTestId("input-ai-assistant-color");
  const preview = card(page).getByTestId("ai-assistant-launcher-preview");
  await text.fill("#xyz");
  await expect(save(page)).toBeDisabled();
  await background.fill("#9333EA");
  await text.fill("#FFFFFF");
  await expect(preview).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(preview).toHaveCSS("background-color", "rgb(147, 51, 234)");
  await card(page).screenshot({ path: testInfo.outputPath("purple-white-preview.png") });
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  expect(state.writes.at(-1).payload.textColor).toBe("#FFFFFF");
  expect(state.overrides[tenantB]).toEqual(tenantBOriginal);
  await page.reload();
  await expect(text).toHaveValue("#FFFFFF");
  await background.fill("");
  await text.fill("#123456");
  await expect(preview).toHaveCSS("color", "rgb(18, 52, 86)");
  expect(await preview.evaluate(el => el.style.getPropertyValue("--ai-bg"))).toBe("");
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  await page.reload();
  await expect(text).toHaveValue("#123456");
  await expect(background).toHaveValue("");
  await card(page).getByRole("button", { name: "Automatic", exact: true }).click();
  state.failConfig = true;
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  await expect(text).toHaveValue("");
  expect(await preview.evaluate(el => el.style.color)).toBe("");
  expect(state.writes.at(-1).payload.textColor).toBe("");
  state.failConfig = false;
  await page.reload();
  await expect(text).toHaveValue("");
  expect(state.errors).toEqual([]);
});

for (const mobile of [false, true]) {
  test(`launcher text colour remains white on purple, hover and keyboard focus (${mobile ? "mobile" : "desktop"})`, async ({ page }, testInfo) => {
    const state = await fixture(page);
    state.overrides[tenantA] = { ...original, name: "Ember", backgroundColor: "#9333EA", textColor: "#FFFFFF" };
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/Help");
    if (mobile) await page.getByTestId("button-mobile-menu").click();
    const launcher = page.getByTestId("button-ask-ai").filter({ visible: true });
    await expect(launcher).toBeVisible();
    await expect(launcher).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(launcher).toHaveCSS("background-color", "rgb(147, 51, 234)");
    await launcher.hover();
    await expect(launcher).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.keyboard.press("Tab");
    await launcher.focus();
    await expect(launcher).toBeFocused();
    await expect(launcher).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.screenshot({ path: testInfo.outputPath("purple-white-launcher.png") });
    await launcher.click();
    await expect(page.getByTestId("dialog-member-ai")).toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

test("tenant description validates, saves normalized text, survives reload and Help modal reopen, and clears to neutral fallback", async ({ page }) => {
  const state = await fixture(page, { admin: true });
  await page.goto("/admin/settings");
  const description = card(page).getByTestId("input-ai-assistant-description");
  const preview = card(page).getByTestId("text-ai-assistant-description-preview");
  await expect(description).toHaveValue(original.description);
  await expect(preview).toHaveText(original.description);
  await expect(description).toHaveAttribute("maxlength", "500");
  await expect(save(page)).toBeDisabled();

  await description.fill("x".repeat(501));
  await expect(description).toHaveValue("x".repeat(500));
  await description.fill("Bad\u0007control");
  await expect(description).toHaveAttribute("aria-invalid", "true");
  await expect(save(page)).toBeDisabled();
  expect(state.writes).toHaveLength(0);

  const normalized = "First line\nSecond line.";
  await description.fill(`  ${normalized}  `);
  await expect(preview).toHaveText(normalized);
  await expect(save(page)).toBeEnabled();
  await expect(card(page).getByText("Unsaved changes", { exact: true })).toBeVisible();
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toEqual({ tenantId: tenantA, payload: { ...original, description: normalized } });
  await expect(description).toHaveValue(normalized);
  await expect(save(page)).toBeDisabled();
  await page.reload();
  await expect(description).toHaveValue(normalized);
  await expect(preview).toHaveText(normalized);
  await expect(save(page)).toBeDisabled();

  await page.goto("/Help");
  const launcher = page.getByTestId("button-ask-ai");
  await expect(launcher).toHaveAttribute("aria-label", "Ask Aurora");
  await launcher.click();
  const modalDescription = page.getByTestId("text-member-ai-description");
  await expect(modalDescription).toHaveText(normalized);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dialog-member-ai")).not.toBeVisible();
  await launcher.click();
  await expect(modalDescription).toHaveText(normalized);
  await page.keyboard.press("Escape");

  await page.goto("/admin/settings");
  await description.fill("   ");
  await expect(preview).toHaveText(defaultDescription);
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  expect(state.writes.at(-1)).toEqual({ tenantId: tenantA, payload: { ...original, description: "" } });
  await expect(description).toHaveValue("");
  await expect(save(page)).toBeDisabled();
  await page.reload();
  await expect(description).toHaveValue("");
  await expect(preview).toHaveText(defaultDescription);
  await page.goto("/Help");
  await launcher.click();
  await expect(modalDescription).toHaveText(defaultDescription);
  await page.keyboard.press("Escape");
  await launcher.click();
  await expect(modalDescription).toHaveText(defaultDescription);
  // Navigating to Help may trigger the unrelated member-profile autosave.
  expect(state.blocked.every(write => write === `PATCH /api/entities/Member/${member.id}`)).toBe(true);
  expect(state.errors).toEqual([]);
});

test("response policy defaults, strict validation, save, reload, reset and current-session test", async ({ page }, testInfo) => {
  const state = await fixture(page, { admin: true, allowTestAsk: true });
  await page.goto("/admin/settings");
  const panel = card(page).getByTestId("member-ai-policy-test");
  const ask = panel.getByTestId("button-ai-policy-test");
  const question = panel.getByTestId("input-ai-policy-test-question");
  await expect(card(page).getByTestId("select-ai-policy-answerLength")).toHaveValue("balanced");
  await expect(card(page).getByTestId("select-ai-policy-clarification")).toHaveValue("when_needed");
  await card(page).screenshot({ path: testInfo.outputPath("response-policy-editor.png") });
  await question.fill("What is the handbook?");
  await card(page).getByTestId("input-ai-policy-role").fill("Guide members using published sources.");
  await expect(ask).toBeDisabled();
  await card(page).getByRole("button", { name: "Add term" }).click();
  await expect(save(page)).toBeDisabled();
  await expect(card(page).getByText(/each with a term and preferred wording/i)).toBeVisible();
  await card(page).getByRole("textbox", { name: "Term 1" }).fill("member");
  await card(page).getByRole("textbox", { name: "Preferred wording 1" }).fill("participant");
  await card(page).getByTestId("input-ai-policy-escalationUrl").fill("http://example.org");
  await expect(save(page)).toBeDisabled();
  await card(page).getByTestId("input-ai-policy-escalationUrl").fill("https://example.org/contact");
  await card(page).getByTestId("select-ai-policy-answerLength").selectOption("detailed");
  await save(page).click();
  await expect(card(page).getByRole("status")).toContainText("saved");
  expect(state.writes.at(-1).payload.responsePolicy).toMatchObject({
    role: "Guide members using published sources.", answerLength: "detailed",
    terminology: [{ term: "member", preferred: "participant" }],
    escalationUrl: "https://example.org/contact",
  });
  expect(state.writes.at(-1).payload.description).toBe(original.description);
  await page.reload();
  await expect(card(page).getByTestId("input-ai-policy-role")).toHaveValue("Guide members using published sources.");
  await question.fill("What is the handbook?");
  await ask.click();
  await expect(panel.getByTestId("member-ai-test-results")).toContainText("Published: 2026-02-10");
  await expect(panel.getByTestId("member-ai-test-results")).toContainText("Member team");
  await panel.screenshot({ path: testInfo.outputPath("response-policy-test.png") });
  expect(state.testAsks).toHaveLength(1);
  expect(state.testAsks[0].tenantId).toBe(tenantA);
  expect(state.testAsks[0].body).toEqual({ question: "What is the handbook?", history: [] });
  expect(state.testAsks[0].headers.cookie || "").not.toContain("impersonat");
  await question.fill("Where else?");
  await ask.click();
  expect(state.testAsks[1].body.history).toEqual([
    { role: "user", content: "What is the handbook?" }, { role: "assistant", content: "Read the handbook [S1]." },
  ]);
  state.testAskError = "Access denied for this session";
  await question.fill("Can I see more?");
  await ask.click();
  await expect(panel.getByRole("alert")).toHaveText("Access denied for this session");
  await expect(panel.getByTestId("member-ai-test-results")).not.toContainText("Can I see more?");
  await card(page).getByRole("button", { name: "Reset response policy to defaults" }).click();
  await expect(ask).toBeDisabled();
  await save(page).click();
  await page.reload();
  await expect(card(page).getByTestId("select-ai-policy-answerLength")).toHaveValue("balanced");
  await expect(card(page).getByTestId("input-ai-policy-role")).toHaveValue("");
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("admin test history and saved policy do not cross tenants", async ({ page }) => {
  const state = await fixture(page, { admin: true, allowTestAsk: true });
  await page.goto("/admin/settings");
  const panel = card(page).getByTestId("member-ai-policy-test");
  await panel.getByTestId("input-ai-policy-test-question").fill("Tenant A handbook?");
  await panel.getByTestId("button-ai-policy-test").click();
  await expect(panel.getByTestId("member-ai-test-results")).toContainText("Tenant A handbook?");
  state.currentTenant = tenantB;
  await page.reload();
  await expect(card(page).getByTestId("input-ai-assistant-name")).toHaveValue("Borealis");
  await expect(card(page).getByTestId("select-ai-policy-answerLength")).toHaveValue("balanced");
  await expect(panel.getByTestId("member-ai-test-results")).toHaveCount(0);
  await panel.getByTestId("input-ai-policy-test-question").fill("Tenant B handbook?");
  await panel.getByTestId("button-ai-policy-test").click();
  await expect(panel.getByTestId("member-ai-test-results")).toContainText("Tenant B handbook?");
  expect(state.testAsks[1].tenantId).toBe(tenantB);
  expect(state.testAsks[1].body.history).toEqual([]);
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("in-flight admin test is discarded on tenant navigation", async ({ page }) => {
  const state = await fixture(page, { admin: true, allowTestAsk: true });
  await page.goto("/admin/settings");
  const panel = card(page).getByTestId("member-ai-policy-test");
  let release;
  state.holdTestAsk = new Promise(resolve => { release = resolve; });
  await panel.getByTestId("input-ai-policy-test-question").fill("Old tenant question?");
  await panel.getByTestId("button-ai-policy-test").click();
  await expect.poll(() => state.testAsks.length).toBe(1);
  state.currentTenant = tenantB;
  try {
    await page.reload();
  } finally {
    release();
    state.holdTestAsk = null;
  }
  await expect(card(page).getByTestId("input-ai-assistant-name")).toHaveValue("Borealis");
  await expect(panel.getByTestId("member-ai-test-results")).toHaveCount(0);
  await expect(panel.getByTestId("button-ai-policy-test")).toBeDisabled();
  expect(state.testAsks).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test("member launcher uses scoped tenant persona, collapses safely, closes when disabled and retains Help Center", async ({ page }, testInfo) => {
  const state = await fixture(page);
  await page.goto("/Help");
  const launcher = page.getByTestId("button-ask-ai");
  await expect(launcher).toHaveAttribute("aria-label", "Ask Aurora");
  await expect(launcher).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.screenshot({ path: testInfo.outputPath("expanded-launcher.png") });
  await expect(page.getByText("Help Center", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("text-ai-persona-description")).toHaveText(platformDescription);
  await launcher.click();
  await expect(page.getByTestId("dialog-member-ai")).toBeVisible();
  await expect(page.getByTestId("text-member-ai-title")).toHaveText("Ask Aurora");
  await expect(page.getByTestId("text-member-ai-description")).toHaveText(original.description);
  await expect(page.getByTestId("dialog-member-ai")).not.toContainText(platformDescription);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dialog-member-ai")).not.toBeVisible();
  const collapse = page.getByTestId("button-sidebar-toggle");
  await collapse.click();
  await expect(launcher).toBeVisible();
  await expect(launcher).toHaveAttribute("title", "Ask Aurora");
  await page.screenshot({ path: testInfo.outputPath("collapsed-launcher.png") });
  // Change the validated member session, not the admin tenant global. Pause B's
  // configuration to detect any flash of A's cached launcher while validating.
  let releaseTenantB;
  state.holdTenantB = new Promise(resolve => { releaseTenantB = resolve; });
  state.currentTenant = tenantB;
  await page.evaluate(id => {
    const oldValue = localStorage.getItem("agcas_member");
    const next = { ...JSON.parse(oldValue), tenant_id: id };
    const newValue = JSON.stringify(next);
    localStorage.setItem("agcas_member", newValue);
    window.dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member", oldValue, newValue, storageArea: localStorage,
    }));
  }, tenantB);
  await expect.poll(() => state.reads.some(read => read === `GET /api/member-ai/config ${tenantB}`)).toBe(true);
  await expect(launcher).toHaveCount(0);
  releaseTenantB();
  await expect(launcher).toHaveAttribute("aria-label", "Ask Borealis");
  await expect(launcher).toHaveCSS("color", "rgb(17, 24, 39)");
  await page.reload();
  await expect(launcher).toHaveAttribute("aria-label", "Ask Borealis");
  expect(state.reads.some(read => read === `GET /api/member-ai/config ${tenantA}`)).toBe(true);
  expect(state.reads.some(read => read === `GET /api/member-ai/config ${tenantB}`)).toBe(true);
  await launcher.click();
  await expect(page.getByTestId("text-member-ai-title")).toHaveText("Ask Borealis");
  await expect(page.getByTestId("text-member-ai-description")).toHaveText(tenantBOriginal.description);
  await expect(page.getByTestId("dialog-member-ai")).not.toContainText(original.description);
  await expect(page.getByTestId("dialog-member-ai")).not.toContainText(platformDescription);
  await page.keyboard.press("Escape");
  await launcher.click();
  await expect(page.getByTestId("text-member-ai-description")).toHaveText(tenantBOriginal.description);
  state.disabledOnAsk = true;
  await page.getByTestId("input-member-ai-ask").fill("When is the next event?");
  await page.getByTestId("button-member-ai-send").click();
  await expect(page.getByTestId("dialog-member-ai")).not.toBeVisible();
  await expect(launcher).toHaveCount(0);
  await expect(page.getByText("Help Center", { exact: true }).first()).toBeVisible();
  // The unrelated member-profile autosave is rejected by the fail-closed
  // fixture; only this known ambient PATCH may have attempted a write.
  expect(state.blocked.every(write => write === `PATCH /api/entities/Member/${member.id}`)).toBe(true);
  expect(state.errors).toEqual([]);
});
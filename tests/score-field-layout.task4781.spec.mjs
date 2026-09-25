import { test, expect } from "@playwright/test";

const FORM_ID = "score-layout-task4781";
const FORM_SLUG = "score-layout-task4781";
const FIELD_ID = "score-layout-field";
const ADMIN = {
  id: "score-layout-admin",
  tenant_id: "score-layout-tenant",
  organization_id: "score-layout-org",
  role_id: "score-layout-role",
  email: "score-layout-admin@example.invalid",
  member_excluded_features: [],
};
const ROLE = { id: ADMIN.role_id, name: "Administrator", excluded_features: [] };

function scoreField(overrides = {}) {
  return {
    id: FIELD_ID,
    type: "score",
    label: "How would you rate this experience?",
    score_style: "numbers",
    score_min: 1,
    score_max: 5,
    score_labels: { low: "Poort", high: "Excellent" },
    allow_na: true,
    na_label: "Not applicable",
    required: false,
    ...overrides,
  };
}

function formFixture(field = scoreField()) {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "Score layout fixture",
    description: "",
    layout_type: "standard",
    form_width: "narrow",
    fields: [field],
    pages: [],
    visibility_rules: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    require_authentication: false,
    access_policy: null,
    is_active: true,
    form_type: "survey",
    submit_button_text: "Submit fixture",
    success_message: "Submitted",
    allow_save_continue_later: false,
    prefill_source: "none",
    is_contract: false,
    blank_layout: true,
    survey_settings: {},
  };
}

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

async function installFixture(page) {
  const state = { form: formFixture(), blockedWrites: [], pageErrors: [] };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  for (const prefix of ["rest", "auth"]) {
    await page.context().route(`**/${prefix}/v1/**`, route => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
        state.blockedWrites.push(`${route.request().method()} ${route.request().url()}`);
        return json(route, { error: "Fixture blocks all mutations" }, 599);
      }
      return json(route, []);
    });
  }
  await page.context().route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    // Do not intercept Vite modules served under /src/api/.
    if (!path.startsWith("/api/")) return route.continue();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.blockedWrites.push(`${method} ${path}`);
      return json(route, { error: `Fixture blocks ${method} ${path}` }, 599);
    }
    if (path === "/api/auth/me") return json(route, ADMIN);
    if (path === "/api/auth/tenant-user-me") return json(route, { user: ADMIN, tenant: { id: ADMIN.tenant_id, slug: FORM_SLUG } });
    if (path === `/api/entities/Member/${ADMIN.id}`) return json(route, ADMIN);
    if (path === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (path === "/api/entities/Role") return json(route, [ROLE]);
    if (path === "/api/entities/Form") return json(route, [state.form]);
    if (path === `/api/public/form/${FORM_SLUG}`) return json(route, state.form);
    if (path === "/api/public/form-payment-providers") return json(route, { providers: [] });
    if (path === "/api/public/form-consent-message") return json(route, { message: "" });
    if (path === "/api/public/tenant-branding") return json(route, { success: true, branding: { name: "Score layout fixture", primaryColor: "#155e75" } });
    if (path === "/api/public/navigation-items") return json(route, []);
    if (path === "/api/public/microsites") return json(route, { microsites: [] });
    return json(route, []);
  });
  return state;
}

async function openPublic(page) {
  await page.goto(`/FormView?slug=${FORM_SLUG}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId(`score-field-${FIELD_ID}`)).toBeVisible();
}

function option(field, value) {
  return field.getByTestId(`score-option-${FIELD_ID}-${value}`).locator('input[type="radio"]');
}

async function selectOption(field, value) {
  await field.getByTestId(`score-option-${FIELD_ID}-${value}`).click();
}

async function geometry(field, low, high, style = "numbers") {
  return field.evaluate((fieldset, labels) => {
    const box = node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height, right: x + width, bottom: y + height };
    };
    const first = fieldset.querySelector(`[data-testid="score-option-${labels.id}-${labels.style === "nps" ? 0 : 1}"]`);
    const last = fieldset.querySelector(`[data-testid="score-option-${labels.id}-${labels.style === "nps" ? 10 : 5}"]`);
    const slider = fieldset.querySelector(`[data-testid="score-slider-${labels.id}"]`);
    const scale = fieldset.querySelector(`[data-testid="score-scale-${labels.id}"]`);
    const endpoints = fieldset.querySelector(`[data-testid="score-endpoints-${labels.id}"]`);
    const na = fieldset.querySelector(`[data-testid="score-option-${labels.id}-na"]`);
    const endpointSpans = slider
      ? [...slider.parentElement.querySelectorAll("span")].filter(el => !el.hasAttribute("aria-live"))
      : [...(endpoints?.querySelectorAll("span") || [])];
    return {
      first: box(first || slider),
      last: box(last || slider),
      scale: box(scale),
      options: box(first?.parentElement || slider),
      low: labels.low ? box(endpointSpans[0]) : null,
      high: labels.high ? box(endpointSpans.at(-1)) : null,
      na: na ? box(na) : null,
      naContent: na ? box(na.querySelector("span")) : null,
      field: box(fieldset),
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  }, { id: FIELD_ID, low, high, style });
}

function expectAligned(g, { low = true, high = true, na = true, lastButton = false } = {}) {
  expect(g.documentWidth).toBeLessThanOrEqual(g.viewport + 1);
  if (low) {
    expect(g.low).not.toBeNull();
    expect(Math.abs(g.low.x - g.first.x), "low endpoint starts beneath first number").toBeLessThanOrEqual(3);
    expect(g.low.y).toBeGreaterThanOrEqual(g.options.bottom - 1);
    expect(g.low.right).toBeLessThanOrEqual(g.scale.right + 2);
  }
  if (high) {
    expect(g.high).not.toBeNull();
    expect(Math.abs(g.high.right - g.scale.right), "high endpoint ends at numeric scale").toBeLessThanOrEqual(3);
    expect(g.high.x).toBeGreaterThanOrEqual(g.scale.x - 2);
  }
  if (lastButton) {
    expect(Math.abs(g.high.right - g.last.right), "Excellent ends exactly at button 5, not the form width").toBeLessThanOrEqual(3);
    expect(Math.abs(g.first.y - g.last.y), "1–5 buttons do not wrap").toBeLessThanOrEqual(2);
  }
  if (low && high) {
    const overlapX = Math.min(g.low.right, g.high.right) - Math.max(g.low.x, g.high.x);
    const overlapY = Math.min(g.low.bottom, g.high.bottom) - Math.max(g.low.y, g.high.y);
    expect(overlapX <= 1 || overlapY <= 1, "endpoint label text must not overlap").toBe(true);
  }
  if (na) {
    expect(g.na).not.toBeNull();
    expect(Math.abs(g.na.x - g.first.x), "NA stays left below the scale").toBeLessThanOrEqual(3);
    expect(g.na.y).toBeGreaterThanOrEqual(Math.max(g.low?.bottom || 0, g.high?.bottom || 0, g.scale.bottom) - 1);
    expect(g.na.width).toBeLessThanOrEqual(g.scale.width + 2);
  } else expect(g.na).toBeNull();
}

test("public FormView: 1–5 numbers, endpoints, NA and responsive geometry", async ({ page }) => {
  const state = await installFixture(page);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await openPublic(page);
    const field = page.getByTestId(`score-field-${FIELD_ID}`);
    for (const value of [1, 2, 3, 4, 5]) await expect(option(field, value)).toBeVisible();
    expectAligned(await geometry(field, "Poort", "Excellent"), { lastButton: true });
    if (width === 1280) {
      await page.screenshot({ path: "/tmp/score-layout-fixed.png", fullPage: true });
      // Recreate the old full-width endpoints/centred-NA DOM geometry without editing source.
      await field.evaluate(fieldset => {
        const scale = fieldset.querySelector('[data-testid^="score-scale-"]');
        const endpoints = fieldset.querySelector('[data-testid^="score-endpoints-"]');
        scale.after(endpoints);
        endpoints.style.cssText = "display:flex;justify-content:space-between;width:448px;max-width:448px";
        const na = fieldset.querySelector('[data-testid$="-na"]');
        na.style.cssText = "width:100%;align-items:center";
      });
      const old = await geometry(field, "Poort", "Excellent");
      expect(old.high.right - old.last.right, "old max-w-md endpoints drift right").toBeGreaterThan(100);
      expect(old.naContent.x - old.first.x, "old stretched NA centres its text").toBeGreaterThan(30);
      await openPublic(page);
      expectAligned(await geometry(page.getByTestId(`score-field-${FIELD_ID}`), "Poort", "Excellent"), { lastButton: true });
    }
  }
  for (const labels of [
    { low: "A much longer description of the very poorest possible result", high: "An exceptionally excellent result over a much longer description" },
    { low: "Poort", high: "" },
    { low: "", high: "Excellent" },
  ]) {
    state.form = formFixture(scoreField({ score_labels: labels }));
    await openPublic(page);
    expectAligned(await geometry(page.getByTestId(`score-field-${FIELD_ID}`), labels.low, labels.high), { low: !!labels.low, high: !!labels.high, lastButton: !!labels.high });
  }
  state.form = formFixture(scoreField({ allow_na: false }));
  await openPublic(page);
  expectAligned(await geometry(page.getByTestId(`score-field-${FIELD_ID}`), "Poort", "Excellent"), { na: false, lastButton: true });
  expect(state.blockedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("public FormView: radio keyboard score/NA transitions and locked answers", async ({ page }) => {
  const state = await installFixture(page);
  await openPublic(page);
  const field = page.getByTestId(`score-field-${FIELD_ID}`);
  await option(field, 1).focus();
  await page.keyboard.press("Space");
  await expect(option(field, 1)).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(option(field, 2)).toBeChecked();
  await selectOption(field, "na");
  await expect(option(field, "na")).toBeChecked();
  await expect(option(field, 2)).not.toBeChecked();
  await selectOption(field, 5);
  await expect(option(field, 5)).toBeChecked();
  await expect(option(field, "na")).not.toBeChecked();
  state.form = formFixture(scoreField({ locked: true }));
  await openPublic(page);
  const locked = page.getByTestId(`score-field-${FIELD_ID}`);
  await expect(option(locked, 5)).toBeDisabled();
  await expect(option(locked, "na")).toBeDisabled();
  await option(locked, 5).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(locked.locator('input[type="radio"]:checked')).toHaveCount(0);
  expect(state.blockedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("public FormView: alternative styles retain selection and constrained layout", async ({ page }) => {
  const state = await installFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const style of ["stars", "smileys", "descriptive", "nps", "slider"]) {
    state.form = formFixture(scoreField({ score_style: style }));
    await openPublic(page);
    const field = page.getByTestId(`score-field-${FIELD_ID}`);
    const dimensions = await field.evaluate(el => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      right: el.getBoundingClientRect().right,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport + 1);
    // Every rendering style shares the endpoints; slider has a distinct track/labels layout.
    const g = await geometry(field, "Poort", "Excellent", style);
    expectAligned(g, { lastButton: style !== "nps" && style !== "slider" });
    if (style === "slider") {
      const slider = page.getByTestId(`score-slider-${FIELD_ID}`);
      await slider.fill("4");
      await expect(slider).toHaveValue("4");
      await selectOption(field, "na");
      await expect(slider).toBeDisabled();
      await expect(slider).toHaveAttribute("aria-valuetext", "No score selected");
      await expect(option(field, "na")).toBeChecked();
    } else {
      if (style === "nps") {
        await expect(option(field, 0)).toBeVisible();
        await expect(option(field, 10)).toBeVisible();
      }
      await selectOption(field, 3);
      await expect(option(field, 3)).toBeChecked();
      await selectOption(field, "na");
      await expect(option(field, 3)).not.toBeChecked();
    }
  }
  expect(state.blockedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("actual FormBuilder ScoreField live preview uses the same bounded scale and NA", async ({ page }) => {
  const state = await installFixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/FormBuilder?formId=${FORM_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`button-configure-field-${FIELD_ID}`)).toBeVisible();
    await page.getByTestId(`button-configure-field-${FIELD_ID}`).click();
    const config = page.getByTestId(`score-config-${FIELD_ID}`);
    await expect(config).toBeVisible();
    const preview = config.getByTestId(`score-field-${FIELD_ID}`);
    await expect(preview).toBeVisible();
    // The narrow builder drawer can wrap buttons; exact button-5 alignment
    // applies only when all five buttons occupy the same row.
    expectAligned(await geometry(preview, "Poort", "Excellent"), { lastButton: width === 1440 });
    await selectOption(preview, "na");
    await expect(option(preview, "na")).toBeChecked();
    await selectOption(preview, 4);
    await expect(option(preview, 4)).toBeChecked();
  }
  expect(state.blockedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
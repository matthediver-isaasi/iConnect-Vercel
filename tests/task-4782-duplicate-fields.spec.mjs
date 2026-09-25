import { test, expect } from "@playwright/test";

// Every request is intercepted. The sole accepted write is an in-memory update
// of this test's own form; this suite never reads or writes tenant data.
const ID = "47820000-0000-4000-8000-000000000001";
const field = (id, label, extra = {}) => ({
  id, label, type: "text", required: false, options: [], page_id: null,
  column_index: 0, ...extra,
});
const pageOne = { id: "page_a", title: "First", column_count: 3 };
const pageTwo = { id: "page_b", title: "Second", column_count: 2 };

async function fixture(page, fields, { pages = [], layout_type = "standard", form_type = "standard", responses = false, integrations = [] } = {}) {
  const form = {
    id: ID, name: "Duplicate fixture", title: "Duplicate fixture",
    slug: "task-4782-duplicate-fixture", status: "published",
    is_active: true, access_level: "public", settings: {},
    layout_type, form_type, pages, fields, survey_settings: { status: "draft" },
  };
  const state = { form, writes: [], blocked: [], errors: [] };
  page.on("pageerror", error => state.errors.push(error.message));
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: "application/json", body: JSON.stringify(body),
  });
  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/api/**", route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const method = req.method();
    const user = {
      id: "47820000-0000-4000-8000-000000000002",
      tenant_id: "47820000-0000-4000-8000-000000000003",
      role_id: "47820000-0000-4000-8000-000000000004",
      email: "duplicate-test@example.invalid",
    };
    const role = { id: user.role_id, tenant_id: user.tenant_id, name: "Administrator", excluded_features: [] };
    if (path === "/api/auth/me") return json(route, {
      ...user,
      sessionRole: { status: "ready", member_id: user.id, tenant_id: user.tenant_id, role_id: user.role_id, role },
    });
    if (path === "/api/auth/tenant-user-me") return json(route, { user, tenant: { id: user.tenant_id } });
    if (path === "/api/entities/Role") return json(route, [role]);
    if (path === `/api/entities/Role/${user.role_id}`) return json(route, role);
    if (path === "/api/entities/Form" && method === "GET") return json(route, [state.form]);
    if (path === `/api/entities/Form/${ID}` && method === "PATCH") {
      const patch = req.postDataJSON();
      state.writes.push(patch);
      state.form = { ...state.form, ...patch };
      return json(route, state.form);
    }
    if (path.startsWith("/api/entities/FormSubmission")) {
      return json(route, responses ? [{ id: "response-1", form_id: ID }] : []);
    }
    if (path === `/api/public/form/${state.form.slug}`) return json(route, state.form);
    if (path === "/api/admin/integrations") return json(route, { integrations });
    if (path === "/api/public/resource-categories") return json(route, []);
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      state.blocked.push(`${method} ${path}`);
      return json(route, { error: `Unexpected write: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

const duplicate = (page, label) => page.getByRole("button", { name: `Duplicate field: ${label}`, exact: true });
async function openBuilder(page, source) {
  await page.goto(`/FormBuilder?formId=${ID}`);
  await expect(duplicate(page, source.label)).toBeVisible();
}
function assertClone(original, clone, fields) {
  expect(clone.id).not.toBe(original.id);
  expect(fields.map(f => f.id).filter(id => id === clone.id)).toHaveLength(1);
  expect(clone.type).toBe(original.type);
  expect(clone.page_id).toBe(original.page_id);
  expect(clone.column_index || 0).toBe(original.column_index || 0);
}
async function save(page, state) {
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.writes.length).toBeGreaterThan(0);
  return state.form.fields;
}

for (const scenario of [
  { name: "flat standard", source: field("flat-a", "Flat"), fields: [field("flat-a", "Flat"), field("flat-b", "After")] },
  { name: "card swipe", layout_type: "card_swipe", source: field("card-a", "Card"), fields: [field("card-a", "Card"), field("card-b", "After")] },
  { name: "unassigned alongside pages", pages: [pageOne], source: field("unassigned-a", "Unassigned"), fields: [field("unassigned-a", "Unassigned"), field("assigned-b", "On page", { page_id: pageOne.id })] },
  { name: "page one column three", pages: [pageOne, pageTwo], source: field("column-a", "Column", { page_id: pageOne.id, column_index: 2 }), fields: [field("column-a", "Column", { page_id: pageOne.id, column_index: 2 }), field("column-b", "Next column", { page_id: pageOne.id, column_index: 2 }), field("other-page", "Other page", { page_id: pageTwo.id })] },
  { name: "second page column two", pages: [pageOne, pageTwo], source: field("second-a", "Second column", { page_id: pageTwo.id, column_index: 1 }), fields: [field("first-a", "First page", { page_id: pageOne.id }), field("second-a", "Second column", { page_id: pageTwo.id, column_index: 1 })] },
]) {
  test(`${scenario.name}: duplicate adjacent, configure, persist and respondent preview`, async ({ page }, testInfo) => {
    const state = await fixture(page, scenario.fields, scenario);
    await openBuilder(page, scenario.source);
    await duplicate(page, scenario.source.label).click();
    await expect(page.getByText("Configure Field", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    // The duplicate must be reachable with its own settings, even across pages.
    await expect.poll(() => page.locator('[data-testid^="button-configure-field-"]').count()).toBe(scenario.fields.length + 1);
    const buttons = await page.locator('[data-testid^="button-configure-field-"]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute("data-testid").replace("button-configure-field-", "")));
    const cloneId = buttons.find(id => !scenario.fields.some(f => f.id === id));
    expect(cloneId).toBeTruthy();
    await page.getByTestId(`button-configure-field-${cloneId}`).click();
    await expect(page.getByText("Configure Field", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Configure Field", { exact: true })).toBeHidden();
    if (scenario.name === "flat standard") {
      await page.screenshot({ path: testInfo.outputPath("populated-duplicate-builder.png"), fullPage: true });
    }
    const saved = await save(page, state);
    const index = saved.findIndex(f => f.id === scenario.source.id);
    assertClone(scenario.source, saved[index + 1], saved);
    expect(saved[index + 1].id).toBe(cloneId);
    await page.reload();
    await expect(page.getByTestId(`button-configure-field-${cloneId}`)).toBeVisible();
    await page.goto(`/FormView?slug=${state.form.slug}`);
    if (scenario.name === "second page column two") {
      await page.getByRole("button", { name: "Next" }).click();
    }
    // Respondent rendering must accept both fields from the saved API payload.
    await expect(page.getByText(scenario.source.label, { exact: true }).first()).toBeVisible();
    expect(state.blocked).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

for (const type of ["select", "radio", "checkbox"]) {
  test(`${type}: editing a cloned choice never mutates original`, async ({ page }) => {
    const original = field("choice-a", "Choices", { type, options: ["Red", "Blue"] });
    const state = await fixture(page, [original]);
    await openBuilder(page, original);
    await duplicate(page, original.label).click();
    await expect(page.getByText("Configure Field", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    const ids = await page.locator('[data-testid^="button-configure-field-"]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute("data-testid").replace("button-configure-field-", "")));
    const cloneId = ids.find(id => id !== original.id);
    expect(cloneId).toBeTruthy();
    await page.getByTestId(`button-configure-field-${cloneId}`).click();
    await page.getByTestId(`input-option-${cloneId}-0`).fill("Green");
    await page.keyboard.press("Escape");
    const saved = await save(page, state);
    expect(saved[0].options).toEqual(["Red", "Blue"]);
    expect(saved[1].options).toEqual(["Green", "Blue"]);
    await page.reload();
    await page.getByTestId(`button-configure-field-${original.id}`).click();
    await expect(page.getByTestId(`input-option-${original.id}-0`)).toHaveValue("Red");
    expect(state.blocked).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test("repeatable rows: clone children use fresh IDs and internal child references", async ({ page }) => {
  const rows = field("rows-a", "Vehicles", {
    type: "repeatable_rows", repeatable_rows_version: 1,
    min_rows: 0, max_rows: 3,
    children: [
      { id: "maker-a", label: "Maker", type: "text" },
      { id: "model-a", label: "Model", type: "select", options: ["S", "XL"], parent_field_id: "maker-a", source_field_id: "maker-a" },
    ],
  });
  const state = await fixture(page, [rows]);
  await openBuilder(page, rows);
  await duplicate(page, rows.label).click();
  await expect(page.getByText("Configure Field", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const saved = await save(page, state);
  const clone = saved[1];
  expect(clone.id).not.toBe(rows.id);
  expect(clone.children).toHaveLength(2);
  expect(clone.children[0].id).not.toBe(rows.children[0].id);
  expect(clone.children[1].id).not.toBe(rows.children[1].id);
  expect(clone.children[1].parent_field_id).toBe(clone.children[0].id);
  expect(clone.children[1].source_field_id).toBe(clone.children[0].id);
  expect(saved[0].children).toEqual(rows.children);
  await page.reload();
  await expect(page.getByTestId(`button-configure-field-${clone.id}`)).toBeVisible();
  await page.goto(`/FormView?slug=${state.form.slug}`);
  await expect(page.getByTestId(`button-add-repeatable-row-${rows.id}`)).toBeVisible();
  await expect(page.getByTestId(`button-add-repeatable-row-${clone.id}`)).toBeVisible();
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("survey with responses: scoring duplication is locked and explains why", async ({ page }) => {
  const score = field("score-a", "Satisfaction", { type: "score", score_style: "stars", score_min: 1, score_max: 5, weight: 1 });
  const state = await fixture(page, [score], { form_type: "survey", responses: true });
  await openBuilder(page, score);
  await expect(duplicate(page, score.label)).toHaveAttribute("aria-disabled", "true");
  await expect(duplicate(page, score.label)).toHaveAttribute("title", /already has responses/);
  await duplicate(page, score.label).dispatchEvent("click");
  await expect(page.locator('[data-testid^="button-configure-field-"]')).toHaveCount(1);
  expect(state.blocked).toEqual([]);
});

test("draft survey without responses can duplicate a score question", async ({ page }) => {
  const score = field("score-draft", "Draft score", { type: "score", score_style: "stars", score_min: 1, score_max: 5, weight: 2 });
  const state = await fixture(page, [score], { form_type: "survey" });
  await openBuilder(page, score);
  await expect(duplicate(page, score.label)).not.toHaveAttribute("aria-disabled", "true");
  await duplicate(page, score.label).click();
  await expect(page.getByText("Configure Field", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const fields = await save(page, state);
  expect(fields[1]).toMatchObject({ type: "score", weight: 2 });
  expect(fields[1].id).not.toBe(score.id);
  expect(state.blocked).toEqual([]);
});

test("address lookup remains restricted without enabled integration", async ({ page }) => {
  const address = field("address-a", "Lookup", { type: "address_lookup" });
  const state = await fixture(page, [address], { integrations: [] });
  await openBuilder(page, address);
  await expect(duplicate(page, address.label)).toHaveAttribute("aria-disabled", "true");
  await expect(duplicate(page, address.label)).toHaveAttribute("title", /Enable the Ideal Postcodes integration/);
  await duplicate(page, address.label).dispatchEvent("click");
  await expect(page.locator('[data-testid^="button-configure-field-"]')).toHaveCount(1);
  expect(state.writes).toEqual([]);
  expect(state.blocked).toEqual([]);
});

test("singleton Payment field cannot be duplicated and explains why", async ({ page }) => {
  const payment = field("payment-a", "Payment", { type: "payment" });
  const state = await fixture(page, [payment]);
  await openBuilder(page, payment);
  await expect(duplicate(page, payment.label)).toHaveAttribute("aria-disabled", "true");
  await expect(duplicate(page, payment.label)).toHaveAttribute("title", /only one Payment field/);
  await duplicate(page, payment.label).dispatchEvent("click");
  await expect(page.locator('[data-testid^="button-configure-field-"]')).toHaveCount(1);
  await expect(page.getByText("Configure Field", { exact: true })).not.toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.blocked).toEqual([]);
  expect(state.errors).toEqual([]);
});
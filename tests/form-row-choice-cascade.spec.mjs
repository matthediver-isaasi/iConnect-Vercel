import { test, expect } from "@playwright/test";

const id = {
  form: "10000000-0000-4000-8000-000000000001",
  rows: "10000000-0000-4000-8000-000000000002",
  a: "10000000-0000-4000-8000-000000000003",
  b: "10000000-0000-4000-8000-000000000004",
  c: "10000000-0000-4000-8000-000000000005",
  typesObject: "20000000-0000-4000-8000-000000000001",
  modelsObject: "20000000-0000-4000-8000-000000000002",
  typeLabel: "30000000-0000-4000-8000-000000000001",
  modelLabel: "30000000-0000-4000-8000-000000000004",
  model: "30000000-0000-4000-8000-000000000002",
  trim: "30000000-0000-4000-8000-000000000003",
  relation: "40000000-0000-4000-8000-000000000001",
};
const recordId = number => `60000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const optionSource = (kind, customObjectId, primaryDisplayFieldId, extra = {}) => ({
  version: 1,
  kind,
  custom_object_id: customObjectId,
  primary_display_field_id: primaryDisplayFieldId,
  filters: [],
  ...extra,
});

function formFixture(fromScratch = false) {
  const relation = {
    parent_field_id: id.a,
    parent_field_scope: "row",
    relationship_definition_id: id.relation,
    relationship_parent_kind: "custom_object",
    relationship_parent_custom_object_id: id.typesObject,
  };
  return {
    id: id.form,
    slug: "task-4364-browser",
    name: "Vehicle choices",
    title: "Vehicle choices",
    status: "published",
    is_active: true,
    access_level: "public",
    settings: {},
    fields: [{
      id: id.rows,
      type: "repeatable_rows",
      label: "Vehicles",
      min_rows: 0,
      max_rows: 3,
      repeatable_rows_version: 1,
      children: [{
        id: id.a,
        type: fromScratch ? "text" : "relationship_dropdown",
        label: "Manufacturer",
        ...(fromScratch ? {} : { option_source: optionSource("records", id.typesObject, id.typeLabel) }),
      }, {
        id: id.b,
        type: fromScratch ? "text" : "relationship_dropdown",
        label: "Model",
        ...(fromScratch ? {} : relation),
        ...(fromScratch ? {} : { option_source: optionSource("distinct", id.modelsObject, id.modelLabel, { value_field_id: id.model }) }),
      }, {
        id: id.c,
        type: fromScratch ? "text" : "relationship_dropdown",
        label: "Trim",
        ...(fromScratch ? {} : relation),
        ...(fromScratch ? {} : { option_source: optionSource("records", id.modelsObject, id.modelLabel, {
          filters: [{ field_id: id.model, source_field_id: id.b }],
        }) }),
      }],
    }],
  };
}

async function harness(page, authenticated = false, fromScratch = false) {
  const state = {
    form: formFixture(fromScratch),
    posts: [],
    saves: [],
    cFailures: 10,
    delayA1: true,
    pageErrors: [],
  };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const user = {
      id: "50000000-0000-4000-8000-000000000001",
      tenant_id: "50000000-0000-4000-8000-000000000002",
      role_id: "50000000-0000-4000-8000-000000000003",
      email: "browser@example.invalid",
    };
    if (path === "/api/auth/me") return json(route, authenticated ? user : null);
    if (path === "/api/auth/tenant-user-me" && authenticated) {
      return json(route, { user, tenant: { id: user.tenant_id } });
    }
    if (path === `/api/public/form/${state.form.slug}`) return json(route, state.form);
    if (path === `/api/public/form/${state.form.slug}/relationship-options`) {
      const body = request.postDataJSON();
      state.posts.push(body);
      const answers = body.dependencyAnswers || {};
      if (body.fieldId === id.a) {
        const options = Array.from({ length: 125 }, (_, index) => ({
          id: recordId(index + 1),
          label: index < 2 ? "Acme" : `Manufacturer ${index + 1}`,
        }));
        if (body.all) return json(route, { data: options, total: options.length });
        const pageNumber = Number(body.page) || 1;
        return json(route, {
          data: options.slice((pageNumber - 1) * 100, pageNumber * 100),
          total: options.length,
        });
      }
      if (body.fieldId === id.b) {
        if (answers[id.a] === recordId(1) && state.delayA1) {
          state.delayA1 = false;
          await new Promise(resolve => setTimeout(resolve, 700));
        }
        const suffix = answers[id.a] === recordId(2) ? 2 : 1;
        return json(route, { data: [{ id: recordId(200 + suffix), label: "Roadster" }], total: 1 });
      }
      if (body.fieldId === id.c) {
        if (answers[id.b] === recordId(202) && state.cFailures > 0) {
          state.cFailures -= 1;
          return json(route, { error: "temporary" }, 500);
        }
        const suffix = answers[id.b] === recordId(202) ? 2 : 1;
        return json(route, {
          data: answers[id.a] && answers[id.b]
            ? [{ id: recordId(300 + suffix), label: `Sport model-${suffix}` }]
            : [],
          total: answers[id.a] && answers[id.b] ? 1 : 0,
        });
      }
    }
    if (path === `/api/forms/${id.form}/relationship-definitions`) {
      return json(route, {
        data: [{
          id: id.relation,
          status: "active",
          relationship_parent_side: "target",
          relationship_parent_kind: "custom_object",
          relationship_parent_custom_object_id: id.typesObject,
          related_kind: "custom_object",
          related_custom_object_id: id.modelsObject,
          related_primary_display_field_id: id.modelLabel,
          parent_object: { id: id.typesObject, plural_label: "Parent Types", primary_display_field_id: id.typeLabel },
          related_object: { id: id.modelsObject, plural_label: "Models", primary_display_field_id: id.modelLabel },
          related: { label: "Models" },
        }, {
          id: id.relation,
          status: "active",
          relationship_parent_side: "source",
          relationship_parent_kind: "custom_object",
          relationship_parent_custom_object_id: id.modelsObject,
          related_kind: "custom_object",
          related_custom_object_id: id.typesObject,
          related_primary_display_field_id: id.typeLabel,
          parent_object: { id: id.modelsObject, plural_label: "Models", primary_display_field_id: id.modelLabel },
          related_object: { id: id.typesObject, plural_label: "Parent Types", primary_display_field_id: id.typeLabel },
          related: { label: "Parent Types" },
        }],
        custom_objects: [{
          id: id.typesObject,
          plural_label: "Parent Types",
          primary_display_field_id: id.typeLabel,
          fields: [
            { id: id.typeLabel, label: "Type name", field_type: "text" },
          ],
        }, {
          id: id.modelsObject,
          plural_label: "Models",
          primary_display_field_id: id.modelLabel,
          fields: [
            { id: id.modelLabel, label: "Model name", field_type: "text" },
            { id: id.model, label: "Model", field_type: "text" },
            { id: id.trim, label: "Trim", field_type: "text" },
          ],
        }],
      });
    }
    if (path === "/api/entities/Form" && request.method() === "GET") return json(route, [state.form]);
    if (path === `/api/entities/Form/${id.form}` && request.method() === "PATCH") {
      const patch = request.postDataJSON();
      state.form = { ...state.form, ...patch };
      state.saves.push(patch);
      return json(route, state.form);
    }
    if (path === "/api/entities/Role") return json(route, authenticated ? [{
      id: user.role_id,
      name: "Administrator",
      excluded_features: [],
    }] : []);
    if (path === "/api/public/resource-categories") return json(route, []);
    if (["POST", "PATCH", "DELETE"].includes(request.method())) {
      return json(route, { error: `Unexpected write ${request.method()} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

async function choose(page, fieldId, optionId, row = 0) {
  const container = page.getByTestId(`repeatable-row-${id.rows}-${row}`);
  await container.getByTestId(`select-relationship-${fieldId}`).click();
  await page.getByTestId(`option-relationship-${fieldId}-${optionId}`).click();
}

test("A to distinct B to relation-and-scalar-filtered C isolates rows and async states", async ({ page }, testInfo) => {
  const state = await harness(page);
  await page.goto(`/FormView?slug=${state.form.slug}`);
  await page.getByTestId(`button-add-repeatable-row-${id.rows}`).click();
  await choose(page, id.a, recordId(1));
  await choose(page, id.a, recordId(2));
  await choose(page, id.b, recordId(202));
  await expect(page.getByTestId(`retry-relationship-${id.c}`)).toBeVisible();
  state.cFailures = 0;
  await page.getByTestId(`retry-relationship-${id.c}`).click();
  await choose(page, id.c, recordId(302));

  await page.getByTestId(`button-add-repeatable-row-${id.rows}`).click();
  await choose(page, id.a, recordId(1), 1);
  await choose(page, id.b, recordId(201), 1);
  await choose(page, id.c, recordId(301), 1);
  await expect(page.getByTestId(`repeatable-row-${id.rows}-0`).getByText("Sport model-2")).toBeVisible();
  await expect(page.getByTestId(`repeatable-row-${id.rows}-1`).getByText("Sport model-1")).toBeVisible();

  await choose(page, id.a, recordId(2), 1);
  await expect(page.getByTestId(`repeatable-row-${id.rows}-1`).getByTestId(`select-relationship-${id.b}`))
    .toContainText("Select an option");
  await expect(page.getByTestId(`repeatable-row-${id.rows}-0`).getByText("Roadster")).toBeVisible();

  const cPosts = state.posts.filter(post => post.fieldId === id.c);
  expect(cPosts.every(post => Object.keys(post.dependencyAnswers).sort().join(",")
    === [id.a, id.b].sort().join(","))).toBe(true);
  const aPosts = state.posts.filter(post => post.fieldId === id.a);
  expect(aPosts.some(post => post.all === true)).toBe(true);
  expect(aPosts.some(post => post.page === 2)).toBe(false);
  await page.waitForTimeout(800);
  await page.getByTestId(`repeatable-row-${id.rows}-0`).getByTestId(`select-relationship-${id.b}`).click();
  await expect(page.getByTestId(`option-relationship-${id.b}-${recordId(202)}`)).toBeVisible();
  await expect(page.getByTestId(`option-relationship-${id.b}-${recordId(201)}`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(state.pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("cascade.png"), fullPage: true });
});

test("builder authors generic A, distinct B, and relationship-plus-scalar C from plain fields", async ({ page }, testInfo) => {
  const state = await harness(page, true, true);
  await page.goto(`/FormBuilder?formId=${id.form}`);
  await page.getByTestId(`button-configure-field-${id.rows}`).click();

  // A: an unconstrained record picker for Parent Types.
  await page.getByTestId(`select-repeatable-child-type-${id.rows}-${id.a}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${id.rows}-${id.a}`).click();
  await page.getByRole("option", { name: "Records from a custom object" }).click();
  await page.getByTestId(`select-row-source-object-${id.rows}-${id.a}`).click();
  await page.getByRole("option", { name: "Parent Types" }).click();
  await expect(page.getByTestId(`row-source-primary-label-${id.rows}-${id.a}`)).toContainText("Type name");
  await expect(page.getByTestId(`select-row-relationship-parent-${id.rows}-${id.a}`)).toContainText("No relationship constraint");

  // B: distinct Model values, constrained through Models -> Parent Types.
  await page.getByTestId(`select-repeatable-child-type-${id.rows}-${id.b}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${id.rows}-${id.b}`).click();
  await page.getByRole("option", { name: "Distinct related field values" }).click();
  await page.getByTestId(`select-row-source-object-${id.rows}-${id.b}`).click();
  await page.getByRole("option", { name: "Models" }).click();
  await page.getByTestId(`select-row-relationship-parent-${id.rows}-${id.b}`).click();
  await page.getByRole("option", { name: "Manufacturer" }).click();
  await page.getByTestId(`select-row-relationship-definition-${id.rows}-${id.b}`).click();
  await page.getByRole("option", { name: /Models/ }).click();
  await page.getByTestId(`select-row-source-value-${id.rows}-${id.b}`).click();
  await page.getByRole("option", { name: "Model", exact: true }).click();

  // C: Models records constrained by the same A relationship and by B's
  // projected scalar value.
  await page.getByTestId(`select-repeatable-child-type-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: "Records from a custom object" }).click();
  await page.getByTestId(`select-row-source-object-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: "Models" }).click();
  await page.getByTestId(`select-row-relationship-parent-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: "Manufacturer" }).click();
  await page.getByTestId(`select-row-relationship-definition-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: /Models/ }).click();
  await page.getByTestId(`add-row-source-filter-${id.rows}-${id.c}`).click();
  await page.getByTestId(`select-row-filter-target-${id.rows}-${id.c}-0`).click();
  await page.getByRole("option", { name: "Model", exact: true }).click();
  await expect(page.getByTestId(`select-row-filter-input-${id.rows}-${id.c}-0`)).toContainText("Model");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);
  const savedChildren = state.saves.at(-1).fields[0].children;
  const savedA = savedChildren.find(child => child.id === id.a);
  const savedB = savedChildren.find(child => child.id === id.b);
  const savedC = savedChildren.find(child => child.id === id.c);
  expect(savedA.option_source).toMatchObject({
    kind: "records",
    custom_object_id: id.typesObject,
    primary_display_field_id: id.typeLabel,
    filters: [],
  });
  expect(savedA.parent_field_id).toBeUndefined();
  expect(savedB.option_source).toMatchObject({
    kind: "distinct",
    custom_object_id: id.modelsObject,
    primary_display_field_id: id.modelLabel,
    value_field_id: id.model,
  });
  expect(savedB).toMatchObject({
    parent_field_id: id.a,
    parent_field_scope: "row",
    relationship_definition_id: id.relation,
    relationship_parent_custom_object_id: id.typesObject,
    related_custom_object_id: id.modelsObject,
  });
  expect(savedC.option_source).toMatchObject({
    kind: "records",
    custom_object_id: id.modelsObject,
    primary_display_field_id: id.modelLabel,
    filters: [{ field_id: id.model, source_field_id: id.b }],
  });
  expect(savedC).toMatchObject({
    parent_field_id: id.a,
    parent_field_scope: "row",
    relationship_definition_id: id.relation,
    relationship_parent_custom_object_id: id.typesObject,
    related_custom_object_id: id.modelsObject,
  });

  await page.reload();
  await page.getByTestId(`button-configure-field-${id.rows}`).click();
  await expect(page.getByTestId(`select-row-source-value-${id.rows}-${id.b}`)).toContainText("Model");
  await expect(page.getByText("equals", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`select-row-relationship-parent-${id.rows}-${id.c}`)).toContainText("Manufacturer");
  await page.getByTestId(`select-row-option-source-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: "Related records (legacy)" }).click();
  await expect(page.getByTestId(`select-repeatable-relationship-mode-${id.rows}-${id.c}`)).toBeVisible();
  await page.getByTestId(`select-row-option-source-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: "Records from a custom object" }).click();
  await expect(page.getByTestId(`select-repeatable-relationship-mode-${id.rows}-${id.c}`)).toHaveCount(0);
  await expect(page.getByTestId(`select-row-relationship-parent-${id.rows}-${id.c}`)).toContainText("Manufacturer");
  await page.keyboard.press("Escape");

  // The public form is the exact form persisted by the builder, not a second
  // injected completed fixture.
  state.cFailures = 0;
  await page.goto(`/FormView?slug=${state.form.slug}`);
  await page.getByTestId(`button-add-repeatable-row-${id.rows}`).click();
  await choose(page, id.a, recordId(2));
  await choose(page, id.b, recordId(202));
  await choose(page, id.c, recordId(302));
  const authoredCRequest = state.posts.find(post => post.fieldId === id.c);
  expect(authoredCRequest.dependencyAnswers).toMatchObject({
    [id.a]: recordId(2),
    [id.b]: recordId(202),
  });
  await expect(page.getByTestId(`repeatable-row-${id.rows}-0`).getByText("Sport model-2")).toBeVisible();

  // Regress clearing all now-hidden source and relationship metadata on type
  // change without affecting the persisted cascade exercised above.
  await page.goto(`/FormBuilder?formId=${id.form}`);
  await page.getByTestId(`button-configure-field-${id.rows}`).click();
  await page.getByTestId(`select-repeatable-child-type-${id.rows}-${id.c}`).click();
  await page.getByRole("option", { name: "Text (Single Line)" }).click();
  await page.keyboard.press("Escape");
  const previousSaves = state.saves.length;
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(previousSaves);
  const clearedC = state.saves.at(-1).fields[0].children.find(child => child.id === id.c);
  expect(clearedC.type).toBe("text");
  expect(clearedC.option_source).toBeUndefined();
  expect(clearedC.relationship_definition_id).toBeUndefined();
  expect(clearedC.parent_field_id).toBeUndefined();
  await page.reload();
  await page.getByTestId(`button-configure-field-${id.rows}`).click();
  await expect(page.getByTestId(`select-repeatable-child-type-${id.rows}-${id.c}`)).toContainText("Text (Single Line)");
  await page.screenshot({ path: testInfo.outputPath("builder-type-change.png"), fullPage: true });
});
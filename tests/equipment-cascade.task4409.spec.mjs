import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "@playwright/test";
import { createFormRelationshipService } from "../api/_lib/formRelationshipOptions.js";

// Task 4409 is deliberately destination-backed.  The browser still uses a
// synthetic session and a local preview route, but both the form payload and
// every option response come from the saved DEST form/configuration.  This is
// not a published user-authentication test and never submits the form.
const TENANT_ID = "ff2df806-b321-4254-b651-3af11fccf1db";
const FORM_ID = "8b6f44d3-83f8-449e-9496-b10b1dc28e5f";
const TYPE_OBJECT_ID = "3dae6022-c7e3-4ca9-b9d8-3676cb0e2173";
const TYPE_DISPLAY_FIELD_ID = "b8f21759-ec01-4e7c-81a7-ea122499e66f";
const MODEL_OBJECT_ID = "633d90fa-aa52-4d1b-9a1d-ffd0e6e9c42a";
const MODEL_DISPLAY_FIELD_ID = "4339b11e-e53e-44be-b7c2-cbd9279e3257";
const MANUFACTURER_VALUE_FIELD_ID = "b58e5c2f-9b2e-4c19-b54c-c382f732af59";
const RESULTS_DIR = "/tmp/equipment-cascade-results";

if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
  throw new Error("Task 4409 requires DEST_SUPABASE_URL and DEST_SUPABASE_KEY");
}

const db = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false } },
);

const previewMember = {
  id: "equipment-cascade-preview-member",
  tenant_id: TENANT_ID,
  role_id: "equipment-cascade-preview-role",
  email: "equipment-cascade-preview@example.invalid",
  first_name: "Equipment",
  last_name: "Cascade",
  is_team_member: true,
  member_excluded_features: [],
};

const previewRole = {
  id: previewMember.role_id,
  name: "Task 4409 preview",
  excluded_features: [],
};

function childrenOf(field) {
  return field?.children || field?.child_fields || field?.fields || [];
}

function formContainer(form) {
  const container = (form.fields || []).find(field => (
    field.id === "field_1789479861104" || field.label === "Equipment"
  ));
  if (!container) throw new Error("DEST form does not contain the Equipment repeatable field");
  const children = childrenOf(container);
  if (children.length !== 3) {
    throw new Error(`DEST Equipment field has ${children.length} children; expected Type, Manufacturer, Model`);
  }
  return { container, children };
}

function assertSavedEquipmentConfiguration(form) {
  const { container, children } = formContainer(form);
  const [typeField, manufacturerField, modelField] = children;
  const labels = children.map(field => String(field.label || "").trim());
  expect(labels[0].toLowerCase()).toContain("type");
  expect(labels[1].toLowerCase()).toContain("manufacturer");
  expect(labels[2].toLowerCase()).toContain("model");
  expect(labels.every(label => label && label.toLowerCase() !== "new row field")).toBe(true);

  expect(typeField.type).toBe("relationship_dropdown");
  expect(typeField.option_source).toMatchObject({
    kind: "records",
    custom_object_id: TYPE_OBJECT_ID,
    primary_display_field_id: TYPE_DISPLAY_FIELD_ID,
    filters: [],
  });

  expect(manufacturerField.type).toBe("relationship_dropdown");
  expect(manufacturerField.option_source).toMatchObject({
    kind: "distinct",
    custom_object_id: MODEL_OBJECT_ID,
    primary_display_field_id: MODEL_DISPLAY_FIELD_ID,
    value_field_id: MANUFACTURER_VALUE_FIELD_ID,
    filters: [],
  });
  expect(manufacturerField.parent_field_id).toBe(typeField.id);
  expect(manufacturerField.parent_field_scope).toBe("row");
  expect(manufacturerField.relationship_definition_id).toEqual(expect.any(String));

  // The regression under test is specifically that Model is a record source
  // filtered by the saved Manufacturer column, not an unfiltered distinct
  // source.  The related object/display IDs remain those persisted by DEST.
  expect(modelField.type).toBe("relationship_dropdown");
  expect(modelField.option_source).toMatchObject({
    kind: "records",
    custom_object_id: MODEL_OBJECT_ID,
    primary_display_field_id: MODEL_DISPLAY_FIELD_ID,
    filters: [{
      field_id: MANUFACTURER_VALUE_FIELD_ID,
      source_field_id: manufacturerField.id,
    }],
  });
  expect(modelField.parent_field_id).toBe(typeField.id);
  expect(modelField.parent_field_scope).toBe("row");
  expect(modelField.relationship_definition_id).toBe(manufacturerField.relationship_definition_id);
  expect(modelField.relationship_parent_custom_object_id)
    .toBe(manufacturerField.relationship_parent_custom_object_id);

  return { container, typeField, manufacturerField, modelField };
}

async function loadDestinationForm() {
  const result = await db
    .from("form")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("id", FORM_ID)
    .maybeSingle();
  if (result.error) throw new Error(`Unable to read DEST form: ${result.error.message}`);
  if (!result.data) throw new Error(`DEST form ${FORM_ID} was not found`);
  const form = structuredClone(result.data);
  const configuration = assertSavedEquipmentConfiguration(form);
  return { form, configuration };
}

async function optionResponse(service, form, container, field, dependencyAnswers = {}) {
  const response = await service.relationshipOptions({
    formId: form.id,
    slug: form.slug,
    form,
    rootForm: form,
    containerFieldId: container.id,
    fieldId: field.id,
    dependencyAnswers,
    query: { all: true },
    activeOnly: true,
  });
  if (!response || !Array.isArray(response.data)) {
    throw new Error(`DEST service returned no option data for ${field.id}`);
  }
  return response;
}

async function findTwoUsableRows(service, form, configuration) {
  const { container, typeField, manufacturerField, modelField } = configuration;
  const typeResponse = await optionResponse(service, form, container, typeField);
  if (typeResponse.data.length < 2) {
    throw new Error("DEST Equipment Type source needs at least two options for independent rows");
  }

  const combinations = [];
  for (const typeOption of typeResponse.data) {
    const manufacturerResponse = await optionResponse(
      service,
      form,
      container,
      manufacturerField,
      { [typeField.id]: typeOption.id },
    );
    for (const manufacturerOption of manufacturerResponse.data) {
      const modelResponse = await optionResponse(
        service,
        form,
        container,
        modelField,
        {
          [typeField.id]: typeOption.id,
          [manufacturerField.id]: manufacturerOption.id,
        },
      );
      if (modelResponse.data.length === 0) continue;
      combinations.push({
        type: typeOption,
        manufacturer: manufacturerOption,
        model: modelResponse.data[0],
      });
      const first = combinations[0];
      const second = combinations.find(candidate => (
        candidate.type.id !== first.type.id
        && candidate.model.id !== first.model.id
      ));
      if (second) {
        return {
          typeResponse,
          combinations: [first, second],
        };
      }
    }
  }
  throw new Error("DEST Equipment sources did not provide two distinct usable Type/Manufacturer/Model rows");
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installDestinationPreview(page, fixture) {
  const { form } = fixture;
  const service = createFormRelationshipService({ db, tenantId: TENANT_ID });
  const discovery = await service.eligibleDefinitions(form.id, {
    isTenantUser: true,
    tenantId: TENANT_ID,
    roleId: null,
  });
  const state = {
    optionPosts: [],
    discoveryRequests: [],
    unexpectedWrites: [],
    pageErrors: [],
  };
  page.on("pageerror", error => state.pageErrors.push(error.message));

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    // Vite source modules can contain /api/ in their URL.  Only intercept
    // requests whose URL path actually starts with /api/.
    if (!path.startsWith("/api/")) return route.continue();
    const method = request.method();
    const optionsPath = `/api/public/form/${encodeURIComponent(form.slug)}/relationship-options`;

    if (path === "/api/auth/me" && method === "GET") return json(route, previewMember);
    if (path === "/api/auth/tenant-user-me" && method === "GET") {
      return json(route, {
        authenticated: false,
        user: null,
        tenant: null,
        tenantUser: null,
      });
    }
    if (path === `/api/entities/Member/${previewMember.id}` && method === "GET") {
      return json(route, previewMember);
    }
    if (path === `/api/entities/Role/${previewRole.id}` && method === "GET") {
      return json(route, previewRole);
    }
    if (path === "/api/entities/Role" && method === "GET") return json(route, [previewRole]);

    if (path === `/api/public/form/${form.slug}` && method === "GET") {
      // Keep the exact saved DEST payload.  No browser-side fixture config is
      // injected, and this preview is intentionally not a published-user test.
      return json(route, form);
    }
    if (path === optionsPath && method === "POST") {
      const body = request.postDataJSON();
      state.optionPosts.push({
        fieldId: body?.fieldId,
        containerFieldId: body?.containerFieldId,
        dependencyAnswers: body?.dependencyAnswers || {},
        all: body?.all === true,
      });
      try {
        const response = await service.relationshipOptions({
          formId: form.id,
          slug: form.slug,
          form,
          rootForm: form,
          fieldId: body?.fieldId,
          containerFieldId: body?.containerFieldId,
          dependencyAnswers: body?.dependencyAnswers || {},
          query: body || {},
          activeOnly: true,
        });
        return json(route, response);
      } catch (error) {
        return json(route, { error: error.message || "DEST option lookup failed" }, error.status || 500);
      }
    }

    if (path === `/api/forms/${form.id}/relationship-definitions` && method === "GET") {
      state.discoveryRequests.push({ formId: form.id });
      return json(route, discovery);
    }
    if (path === "/api/entities/Form" && method === "GET") return json(route, [form]);
    if (path === `/api/entities/Form/${form.id}` && method === "GET") return json(route, form);

    if (path === "/api/custom-objects" && method === "GET") {
      return json(route, {
        data: discovery.custom_objects || [],
        total: (discovery.custom_objects || []).length,
        page: 1,
        pageSize: 100,
      });
    }
    const objectFieldsMatch = path.match(/^\/api\/custom-objects\/([^/]+)\/fields$/);
    if (objectFieldsMatch && method === "GET") {
      const object = (discovery.custom_objects || []).find(candidate => (
        String(candidate.id) === decodeURIComponent(objectFieldsMatch[1])
      ));
      return json(route, { data: object?.fields || [] });
    }
    if (path.match(/^\/api\/custom-objects\/[^/]+\/relationship-definitions$/) && method === "GET") {
      return json(route, { data: discovery.data || [] });
    }

    if (path === "/api/public/tenant-branding" && method === "GET") {
      return json(route, { success: true, branding: {} });
    }
    if (path === "/api/public/resource-categories" && method === "GET") return json(route, []);
    if (path === "/api/public/form-consent-message" && method === "GET") return json(route, {});
    if (path === "/api/admin/integrations" && method === "GET") {
      return json(route, { integrations: [] });
    }

    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      state.unexpectedWrites.push({ method, path });
      return json(route, { error: `Read-only task 4409 preview blocked ${method} ${path}` }, 599);
    }
    return json(route, []);
  });

  return { state, service };
}

async function choose(page, container, field, option, rowIndex) {
  const row = page.getByTestId(`repeatable-row-${container.id}-${rowIndex}`);
  const trigger = row.getByTestId(`select-relationship-${field.id}`);
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const item = page.getByTestId(`option-relationship-${field.id}-${option.id}`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(trigger).toContainText(String(option.label));
}

test("DEST Equipment cascade renders, isolates rows, clears downstream values, and handles empty Type", async ({
  page,
}, testInfo) => {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fixture = await loadDestinationForm();
  const { form, configuration } = fixture;
  const { container, typeField, manufacturerField, modelField } = configuration;
  const service = createFormRelationshipService({ db, tenantId: TENANT_ID });

  const emptyManufacturer = await optionResponse(
    service,
    form,
    container,
    manufacturerField,
    { [typeField.id]: "" },
  );
  const emptyModel = await optionResponse(
    service,
    form,
    container,
    modelField,
    {
      [typeField.id]: "",
      [manufacturerField.id]: "",
    },
  );
  expect(emptyManufacturer.data).toEqual([]);
  expect(emptyModel.data).toEqual([]);

  const { state } = await installDestinationPreview(page, fixture);
  const { combinations } = await findTwoUsableRows(service, form, configuration);
  const first = combinations[0];
  const second = combinations[1];

  await page.goto(`/FormView?slug=${encodeURIComponent(form.slug)}`);
  await expect(page.getByText("Equipment", { exact: true })).toBeVisible();
  await page.getByTestId(`button-add-repeatable-row-${container.id}`).click();
  await choose(page, container, typeField, first.type, 0);
  await choose(page, container, manufacturerField, first.manufacturer, 0);
  await choose(page, container, modelField, first.model, 0);

  await page.getByTestId(`button-add-repeatable-row-${container.id}`).click();
  await choose(page, container, typeField, second.type, 1);
  await choose(page, container, manufacturerField, second.manufacturer, 1);
  await choose(page, container, modelField, second.model, 1);
  await expect(page.getByTestId(`repeatable-row-${container.id}-0`)).toContainText(String(first.model.label));
  await expect(page.getByTestId(`repeatable-row-${container.id}-1`)).toContainText(String(second.model.label));
  await page.screenshot({
    path: `${RESULTS_DIR}/equipment-cascade-selected.png`,
    fullPage: true,
  });

  // Changing Type in row 0 clears only that row's Manufacturer and Model.
  // Row 1 remains selected and its option request still carries its own
  // dependency answers.
  const row0 = page.getByTestId(`repeatable-row-${container.id}-0`);
  await row0.getByTestId(`select-relationship-${typeField.id}`).click();
  const replacementType = second.type;
  await page.getByTestId(`option-relationship-${typeField.id}-${replacementType.id}`).click();
  await expect(row0.getByTestId(`select-relationship-${manufacturerField.id}`))
    .toContainText("Select an option");
  await expect(row0.getByTestId(`select-relationship-${modelField.id}`))
    .toContainText("Select an option");
  await expect(page.getByTestId(`repeatable-row-${container.id}-1`)
    .getByTestId(`select-relationship-${modelField.id}`)).toContainText(String(second.model.label));

  // A newly added row starts with an empty Type; downstream controls stay
  // disabled and no empty dependency is sent as an option selection.
  await page.getByTestId(`button-add-repeatable-row-${container.id}`).click();
  const emptyRow = page.getByTestId(`repeatable-row-${container.id}-2`);
  await expect(emptyRow.getByTestId(`select-relationship-${manufacturerField.id}`))
    .toContainText("Select the previous column first");
  await expect(emptyRow.getByTestId(`select-relationship-${modelField.id}`))
    .toContainText("Select the previous column first");
  await expect(emptyRow.getByTestId(`select-relationship-${manufacturerField.id}`)).toBeDisabled();
  await expect(emptyRow.getByTestId(`select-relationship-${modelField.id}`)).toBeDisabled();

  await page.screenshot({
    path: `${RESULTS_DIR}/equipment-cascade-browser.png`,
    fullPage: true,
  });
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(state.optionPosts.length).toBeGreaterThan(0);
  expect(state.optionPosts.every(post => post.containerFieldId === container.id)).toBe(true);
  expect(state.optionPosts.every(post => post.fieldId !== modelField.id
    || Object.prototype.hasOwnProperty.call(post.dependencyAnswers, typeField.id))).toBe(true);
  await testInfo.attach("equipment-cascade-safe-summary.json", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({
      harness: "synthetic auth/chrome with exact DEST form and DEST relationship service",
      formId: form.id,
      tenantId: TENANT_ID,
      screenshots: [
        `${RESULTS_DIR}/equipment-cascade-selected.png`,
        `${RESULTS_DIR}/equipment-cascade-browser.png`,
      ],
      emptyTypeResponses: {
        manufacturer: emptyManufacturer.data.length,
        model: emptyModel.data.length,
      },
      browserOptionPosts: state.optionPosts.length,
      liveWrites: 0,
    }, null, 2)),
  });
});

test("DEST Equipment saved source/filter labels reopen in the builder without saving", async ({ page }) => {
  const fixture = await loadDestinationForm();
  const { form, configuration } = fixture;
  const { container, typeField, manufacturerField, modelField } = configuration;
  const { state } = await installDestinationPreview(page, fixture);

  await page.goto(`/FormBuilder?formId=${encodeURIComponent(form.id)}`);
  await expect(page.getByRole("heading", { name: form.name })).toBeVisible();
  await expect.poll(() => state.discoveryRequests.length).toBeGreaterThan(0);
  await page.getByTestId(`button-configure-field-${container.id}`).click();

  await expect(page.getByTestId(`select-row-option-source-${container.id}-${typeField.id}`))
    .toContainText("Records from a custom object");
  await expect(page.getByTestId(`select-row-option-source-${container.id}-${manufacturerField.id}`))
    .toContainText("Distinct related field values");
  await expect(page.getByTestId(`select-row-source-value-${container.id}-${manufacturerField.id}`))
    .toContainText("Manufacturer");
  await expect(page.getByTestId(`select-row-option-source-${container.id}-${modelField.id}`))
    .toContainText("Records from a custom object");
  await expect(page.getByTestId(`select-row-filter-target-${container.id}-${modelField.id}-0`))
    .toContainText("Manufacturer");
  await expect(page.getByTestId(`select-row-filter-input-${container.id}-${modelField.id}-0`))
    .toContainText(String(manufacturerField.label));

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
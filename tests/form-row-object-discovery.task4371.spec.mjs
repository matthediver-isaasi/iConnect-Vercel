import { test, expect } from "@playwright/test";

// Task 4371 deliberately keeps every response in this file local to the
// browser route harness.  In particular, no Form, Custom Object, or record
// writes are allowed through the harness unless a test is explicitly checking
// the FormBuilder save-first flow.

const id = {
  alphaForm: "71000000-0000-4000-8000-000000000001",
  betaForm: "71000000-0000-4000-8000-000000000002",
  alphaRows: "71000000-0000-4000-8000-000000000011",
  betaRows: "71000000-0000-4000-8000-000000000012",
  alphaParent: "71000000-0000-4000-8000-000000000021",
  betaParent: "71000000-0000-4000-8000-000000000022",
  alphaDirect: "71000000-0000-4000-8000-000000000031",
  betaDirect: "71000000-0000-4000-8000-000000000032",
  alphaDistinct: "71000000-0000-4000-8000-000000000041",
  betaDistinct: "71000000-0000-4000-8000-000000000042",
  parentObject: "72000000-0000-4000-8000-000000000001",
  alphaChildObject: "72000000-0000-4000-8000-000000000011",
  betaChildObject: "72000000-0000-4000-8000-000000000012",
  parentLabel: "73000000-0000-4000-8000-000000000001",
  alphaChildLabel: "73000000-0000-4000-8000-000000000011",
  betaChildLabel: "73000000-0000-4000-8000-000000000012",
  childValue: "73000000-0000-4000-8000-000000000020",
  relation: "74000000-0000-4000-8000-000000000001",
};

const recordId = number => `75000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

const tenants = {
  alpha: {
    id: "76000000-0000-4000-8000-000000000001",
    slug: "task4371-alpha",
    name: "Alpha fixture tenant",
  },
  beta: {
    id: "76000000-0000-4000-8000-000000000002",
    slug: "task4371-beta",
    name: "Beta fixture tenant",
  },
};

const optionSource = (kind, customObjectId, primaryDisplayFieldId, extra = {}) => ({
  version: 1,
  kind,
  custom_object_id: customObjectId,
  primary_display_field_id: primaryDisplayFieldId,
  filters: [],
  ...extra,
});

function objectFixture(objectId, label, fields) {
  return {
    id: objectId,
    name: label,
    singular_label: label,
    plural_label: label,
    primary_display_field_id: fields[0]?.id,
    status: "active",
    fields,
  };
}

function discoveryFixture({ tenantKey = "alpha", formId, rowsId, parentId, directId, distinctId }) {
  const tenant = tenants[tenantKey];
  const childObjectId = tenantKey === "beta" ? id.betaChildObject : id.alphaChildObject;
  const childLabelId = tenantKey === "beta" ? id.betaChildLabel : id.alphaChildLabel;
  const objectLabel = `${tenantKey === "beta" ? "Beta" : "Alpha"} Models`;
  const parentLabel = `${tenantKey === "beta" ? "Beta" : "Alpha"} Manufacturers`;
  const valueLabel = tenantKey === "beta" ? "Beta model value" : "Alpha model value";
  const parentObject = objectFixture(id.parentObject, parentLabel, [
    { id: id.parentLabel, label: "Manufacturer name", field_type: "text" },
  ]);
  const childObject = objectFixture(childObjectId, objectLabel, [
    { id: childLabelId, label: "Model name", field_type: "text" },
    { id: id.childValue, label: valueLabel, field_type: "text" },
  ]);
  const relationship = {
    id: id.relation,
    status: "active",
    relationship_parent_side: "target",
    relationship_parent_kind: "custom_object",
    relationship_parent_custom_object_id: id.parentObject,
    related_kind: "custom_object",
    related_custom_object_id: childObjectId,
    related_primary_display_field_id: childLabelId,
    parent_object: parentObject,
    related_object: childObject,
    related: { label: objectLabel },
  };
  return {
    data: [relationship],
    custom_objects: [parentObject, childObject],
    formId,
    rowsId,
    parentId,
    directId,
    distinctId,
    tenant: tenant.slug,
  };
}

function builderForm({
  tenantKey = "alpha",
  formId = id.alphaForm,
  rowsId = id.alphaRows,
  parentId = id.alphaParent,
  directId = id.alphaDirect,
  distinctId = id.alphaDistinct,
  fromScratch = false,
  name = tenantKey === "beta" ? "Beta builder form" : "Alpha builder form",
} = {}) {
  const tenant = tenants[tenantKey];
  const childObjectId = tenantKey === "beta" ? id.betaChildObject : id.alphaChildObject;
  const childLabelId = tenantKey === "beta" ? id.betaChildLabel : id.alphaChildLabel;
  const relation = {
    parent_field_id: parentId,
    parent_field_scope: "row",
    relationship_definition_id: id.relation,
    relationship_parent_side: "target",
    relationship_parent_kind: "custom_object",
    relationship_parent_custom_object_id: id.parentObject,
    related_kind: "custom_object",
    related_custom_object_id: childObjectId,
    related_primary_display_field_id: childLabelId,
  };
  return {
    id: formId,
    tenant_id: tenant.id,
    slug: `${tenant.slug}-builder`,
    name,
    title: name,
    description: "",
    status: "published",
    is_active: true,
    access_level: "public",
    settings: {},
    fields: [{
      id: rowsId,
      type: "repeatable_rows",
      label: "Vehicles",
      min_rows: 0,
      max_rows: 3,
       repeatable_rows_version: 1,
       children: [{
        id: parentId,
        type: fromScratch ? "text" : "relationship_dropdown",
        label: "Manufacturer",
        ...(fromScratch ? {} : {
          option_source: optionSource("records", id.parentObject, id.parentLabel),
        }),
      }, {
        id: directId,
        type: fromScratch ? "text" : "relationship_dropdown",
        label: "Direct model",
        ...(fromScratch ? {} : {
          ...relation,
          option_source: optionSource("records", childObjectId, childLabelId, {
            filters: [{ field_id: id.childValue, source_field_id: parentId }],
          }),
        }),
      }, {
        id: distinctId,
        type: fromScratch ? "text" : "relationship_dropdown",
        label: "Distinct model value",
        ...(fromScratch ? {} : {
          ...relation,
          option_source: optionSource("distinct", childObjectId, childLabelId, {
            value_field_id: id.childValue,
          }),
        }),
      }],
    }],
    pages: [],
    form_type: "standard",
    survey_settings: {},
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
  };
}

function publicForm({ tenantKey = "alpha", slug = `${tenants[tenantKey].slug}-public` } = {}) {
  const tenant = tenants[tenantKey];
  const childObjectId = tenantKey === "beta" ? id.betaChildObject : id.alphaChildObject;
  const childLabelId = tenantKey === "beta" ? id.betaChildLabel : id.alphaChildLabel;
  const tenantLabel = tenantKey === "beta" ? "Beta" : "Alpha";
  const relation = {
    parent_field_id: `public-${tenantKey}-parent`,
    parent_field_scope: "form",
    relationship_definition_id: id.relation,
    relationship_parent_side: "target",
    relationship_parent_kind: "custom_object",
    relationship_parent_custom_object_id: id.parentObject,
    related_kind: "custom_object",
    related_custom_object_id: childObjectId,
    related_primary_display_field_id: childLabelId,
  };
  const parentId = `public-${tenantKey}-parent`;
  return {
    id: `public-${tenantKey}-form`,
    tenant_id: tenant.id,
    slug,
    name: `${tenantLabel} public discovery form`,
    title: `${tenantLabel} public discovery form`,
    description: "",
    status: "published",
    is_active: true,
    access_level: "public",
    pages: [],
    fields: [{
      id: parentId,
      type: "relationship_dropdown",
      label: `${tenantLabel} manufacturer`,
      option_source: optionSource("records", id.parentObject, id.parentLabel),
    }, {
      id: `public-${tenantKey}-failure`,
      type: "relationship_dropdown",
      label: `${tenantLabel} direct model`,
      ...relation,
      option_source: optionSource("records", childObjectId, childLabelId, {
        filters: [{ field_id: id.childValue, source_field_id: parentId }],
      }),
    }, {
      id: `public-${tenantKey}-empty`,
      type: "relationship_dropdown",
      label: `${tenantLabel} empty model`,
      no_relationship_found_label: "No matching models for this manufacturer.",
      ...relation,
      option_source: optionSource("records", childObjectId, childLabelId, {
        filters: [{ field_id: id.childValue, source_field_id: parentId }],
      }),
    }, {
      id: `public-${tenantKey}-distinct`,
      type: "relationship_dropdown",
      label: `${tenantLabel} distinct model value`,
      ...relation,
      option_source: optionSource("distinct", childObjectId, childLabelId, {
        value_field_id: id.childValue,
      }),
    }],
    form_type: "standard",
    survey_settings: {},
  };
}

function allObjects(forms) {
  const objects = new Map();
  for (const form of forms) {
    const tenantKey = form.tenant_id === tenants.beta.id ? "beta" : "alpha";
    const payload = discoveryFixture({
      tenantKey,
      formId: form.id,
      rowsId: form.fields[0]?.id,
      parentId: form.fields[0]?.children?.[0]?.id,
      directId: form.fields[0]?.children?.[1]?.id,
      distinctId: form.fields[0]?.children?.[2]?.id,
    });
    for (const object of payload.custom_objects) objects.set(object.id, object);
  }
  return [...objects.values()];
}

async function installHarness(page, {
  authenticated = false,
  forms = [],
  discoveryModeByForm = {},
  discoveryTenantByForm = {},
  discoveryDelay = 0,
} = {}) {
  const state = {
    forms: [...forms],
    creates: [],
    saves: [],
    discoveryRequests: [],
    optionRequests: [],
    unexpectedWrites: [],
    pageErrors: [],
    retryAllowed: false,
    parentOptionsLoaded: false,
    discoveryModeByForm,
    discoveryTenantByForm,
    discoveryDelay,
    tenantUserTenant: null,
  };
  const objects = allObjects(forms);
  const authUser = {
    id: "77000000-0000-4000-8000-000000000001",
    tenant_id: tenants.alpha.id,
    role_id: "77000000-0000-4000-8000-000000000003",
    email: "task4371@example.invalid",
  };
  page.on("pageerror", error => {
    state.pageErrors.push(error.message);
    console.error("Browser page error:", error.message);
  });
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const method = request.method();
    const queryTenant = requestUrl.searchParams.get("tenant");
    const queryTenantKey = queryTenant === tenants.beta.slug ? "beta" : "alpha";
    const tenantHeader = request.headers()["x-tenant-id"];
    const headerTenantKey = tenantHeader === tenants.beta.id ? "beta"
      : tenantHeader === tenants.alpha.id ? "alpha"
        : null;
    // Authenticated tenant headers are authoritative over a stale public URL
    // query. This is intentional: otherwise a test could pass while the
    // discovery request still belonged to the previous tenant.
    const requestedTenantKey = headerTenantKey || (queryTenant ? queryTenantKey : "alpha");
    const requestedTenant = tenants[requestedTenantKey].slug;

    if (path === "/api/auth/me") return json(route, authenticated ? authUser : null);
    if (path === "/api/auth/tenant-user-me") {
      // The direct query is used only by the fixture to model a tenant
      // switch. Subsequent requests must use the X-Tenant-Id header above.
      const authTenantKey = queryTenant ? queryTenantKey : requestedTenantKey;
      state.tenantUserTenant = authTenantKey;
      const tenant = tenants[authTenantKey];
      return json(route, authenticated
        ? {
          authenticated: true,
          user: { ...authUser, tenant_id: tenant.id },
          tenant,
          tenantUser: { id: authUser.id, tenant_id: tenant.id },
        }
        : { authenticated: false, user: null, tenant: null, tenantUser: null });
    }

    const publicFormMatch = path.match(/^\/api\/public\/form\/([^/]+)$/);
    if (publicFormMatch && method === "GET") {
      const slug = decodeURIComponent(publicFormMatch[1]);
      const form = state.forms.find(candidate => (
        candidate.slug === slug
        && (!candidate.tenant_id || candidate.tenant_id === tenants[requestedTenantKey].id)
      ));
      return form ? json(route, form) : json(route, { error: "Form not found" }, 404);
    }

    if (path.endsWith("/relationship-options")) {
      let body = {};
      try {
        body = request.postDataJSON() || {};
      } catch {
        body = {};
      }
      const slug = decodeURIComponent(path.split("/")[4] || "");
      const form = state.forms.find(candidate => candidate.slug === slug);
      const fieldId = body.fieldId || requestUrl.searchParams.get("fieldId");
      state.optionRequests.push({
        tenant: requestedTenant,
        queryTenant,
        headerTenant: headerTenantKey ? tenants[headerTenantKey].slug : null,
        slug,
        fieldId,
        dependencyAnswers: body.dependencyAnswers || {},
      });
      const tenantKey = form?.tenant_id === tenants.beta.id ? "beta" : requestedTenantKey;
      const tenantLabel = tenantKey === "beta" ? "Beta" : "Alpha";
      const parentId = `public-${tenantKey}-parent`;
      if (fieldId === parentId) {
        if (!state.parentOptionsLoaded) {
          state.parentOptionsLoaded = true;
          await delay(700);
        }
        return json(route, {
          data: [
            { id: recordId(1), label: `${tenantLabel} manufacturer one` },
            { id: recordId(2), label: `${tenantLabel} manufacturer two` },
          ],
          total: 2,
        });
      }
      if (fieldId === `public-${tenantKey}-failure`) {
        if (!state.retryAllowed) return json(route, { error: "temporary fixture failure" }, 503);
        return json(route, {
          data: [{ id: recordId(201), label: `${tenantLabel} direct model` }],
          total: 1,
        });
      }
      if (fieldId === `public-${tenantKey}-empty`) {
        return json(route, { data: [], total: 0 });
      }
      if (fieldId === `public-${tenantKey}-distinct`) {
        return json(route, {
          data: [
            { id: recordId(301), label: `${tenantLabel} model value one` },
            { id: recordId(302), label: `${tenantLabel} model value two` },
          ],
          total: 2,
        });
      }
      return json(route, { data: [], total: 0 });
    }

    const relationshipDefinitionMatch = path.match(/^\/api\/forms\/([^/]+)\/relationship-definitions$/);
    if (relationshipDefinitionMatch && method === "GET") {
      const formId = decodeURIComponent(relationshipDefinitionMatch[1]);
      state.discoveryRequests.push({
        tenant: requestedTenant,
        queryTenant,
        headerTenant: headerTenantKey ? tenants[headerTenantKey].slug : null,
        formId,
      });
      const mode = state.discoveryModeByForm[formId] || "ok";
      if (mode === "loading") await delay(state.discoveryDelay || 800);
      if (mode === "error") return json(route, { error: "discovery fixture failure" }, 503);
      if (mode === "empty") return json(route, { data: [], custom_objects: [] });
      const form = state.forms.find(candidate => candidate.id === formId);
      const children = form?.fields?.[0]?.children || [];
      const tenantKey = state.discoveryTenantByForm[formId]
        || (form?.tenant_id === tenants.beta.id ? "beta" : requestedTenantKey);
      return json(route, discoveryFixture({
        tenantKey,
        formId,
        rowsId: form?.fields?.[0]?.id,
        parentId: children[0]?.id,
        directId: children[2]?.id,
        distinctId: children[1]?.id,
      }));
    }

    if (path === "/api/entities/Form" && method === "GET") {
      return json(route, state.forms.filter(form => (
        !form.tenant_id || form.tenant_id === tenants[requestedTenantKey].id
      )));
    }
    if (path === "/api/entities/Form" && method === "POST") {
      const form = request.postDataJSON();
      const created = {
        ...form,
        id: "78000000-0000-4000-8000-000000000001",
        tenant_id: tenants.alpha.id,
      };
      state.creates.push(form);
      state.forms.push(created);
      return json(route, created);
    }
    const formPatchMatch = path.match(/^\/api\/entities\/Form\/([^/]+)$/);
    if (formPatchMatch && method === "PATCH") {
      const formId = decodeURIComponent(formPatchMatch[1]);
      const patch = request.postDataJSON();
      const index = state.forms.findIndex(form => form.id === formId);
      if (index >= 0) state.forms[index] = { ...state.forms[index], ...patch };
      state.saves.push(patch);
      return json(route, state.forms[index] || { ...patch, id: formId });
    }

    if (path === "/api/custom-objects" && method === "GET") {
      return json(route, { data: objects });
    }
    const objectFieldsMatch = path.match(/^\/api\/custom-objects\/([^/]+)\/fields$/);
    if (objectFieldsMatch && method === "GET") {
      const object = objects.find(candidate => candidate.id === decodeURIComponent(objectFieldsMatch[1]));
      return json(route, { data: object?.fields || [] });
    }
    const objectRelationshipsMatch = path.match(/^\/api\/custom-objects\/([^/]+)\/relationship-definitions$/);
    if (objectRelationshipsMatch && method === "GET") {
      return json(route, { data: [discoveryFixture({ tenantKey: "alpha" }).data[0]] });
    }

    if (path === "/api/entities/Role" && method === "GET") {
      return json(route, [{
        id: authUser.role_id,
        name: "Administrator",
        excluded_features: [],
      }]);
    }
    if (path.startsWith("/api/entities/Role/") && method === "GET") {
      return json(route, { id: authUser.role_id, name: "Administrator", excluded_features: [] });
    }
    if (path === "/api/admin/integrations" && method === "GET") return json(route, { integrations: [] });
    if (path === "/api/public/resource-categories" && method === "GET") return json(route, []);
    if (path === "/api/public/tenant-branding" && method === "GET") {
      return json(route, { success: true, branding: {} });
    }
    if (path === "/api/public/form-consent-message" && method === "GET") return json(route, {});
    if (method === "GET") return json(route, []);

    // Relationship option POSTs are the only public POSTs in this harness.
    if (["POST", "PATCH", "DELETE"].includes(method)) {
      state.unexpectedWrites.push({
        method,
        path,
        body: request.postData(),
      });
      return json(route, { error: `Unexpected fixture write ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

async function chooseRelationship(page, fieldId, optionId) {
  await page.getByTestId(`select-relationship-${fieldId}`).click();
  await page.getByTestId(`option-relationship-${fieldId}-${optionId}`).click();
}

async function configureDirectAndDistinct(page, form) {
  const children = form.fields[0].children;
  const parentChild = children[0];
  const distinctChild = children[1];
  const directChild = children[2];
  await page.getByTestId(`button-configure-field-${form.fields[0].id}`).click();

  // The first child is the parent record source used by both later
  // configurations.
  await page.getByTestId(`select-repeatable-child-type-${form.fields[0].id}-${parentChild.id}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${form.fields[0].id}-${parentChild.id}`).click();
  await page.getByRole("option", { name: "Records from a custom object" }).click();
  const parentObjectSelect = page.getByTestId(`select-row-source-object-${form.fields[0].id}-${parentChild.id}`);
  await expect(parentObjectSelect).toBeEnabled();
  await parentObjectSelect.click();
  await page.getByRole("option", { name: /Manufacturers/ }).click();

  // Distinct values provide the scalar used by the later direct-record
  // filter. This mirrors the public cascade's dependency order.
  await page.getByTestId(`select-repeatable-child-type-${form.fields[0].id}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${form.fields[0].id}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Distinct related field values" }).click();
  const distinctObjectSelect = page.getByTestId(`select-row-source-object-${form.fields[0].id}-${distinctChild.id}`);
  await expect(distinctObjectSelect).toBeEnabled();
  await distinctObjectSelect.click();
  await page.getByRole("option", { name: /Models/ }).click();
  await page.getByTestId(`select-row-relationship-parent-${form.fields[0].id}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Manufacturer" }).click();
  const distinctRelationshipSelect = page.getByTestId(`select-row-relationship-definition-${form.fields[0].id}-${distinctChild.id}`);
  await expect(distinctRelationshipSelect).toBeEnabled();
  await distinctRelationshipSelect.click();
  await page.getByRole("option", { name: /Models/ }).click();
  await page.getByTestId(`select-row-source-value-${form.fields[0].id}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Model value", exact: false }).click();

  // Direct records: constrain the child object by the earlier manufacturer
  // selection, then select the distinct value as its equality filter.
  await page.getByTestId(`select-repeatable-child-type-${form.fields[0].id}-${directChild.id}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${form.fields[0].id}-${directChild.id}`).click();
  await page.getByRole("option", { name: "Records from a custom object" }).click();
  const childObjectSelect = page.getByTestId(`select-row-source-object-${form.fields[0].id}-${directChild.id}`);
  await expect(childObjectSelect).toBeEnabled();
  await childObjectSelect.click();
  await page.getByRole("option", { name: /Models/ }).click();
  await page.getByTestId(`select-row-relationship-parent-${form.fields[0].id}-${directChild.id}`).click();
  await page.getByRole("option", { name: "Manufacturer" }).click();
  const relationshipSelect = page.getByTestId(`select-row-relationship-definition-${form.fields[0].id}-${directChild.id}`);
  await expect(relationshipSelect).toBeEnabled();
  await relationshipSelect.click();
  await page.getByRole("option", { name: /Models/ }).click();
  await page.getByTestId(`add-row-source-filter-${form.fields[0].id}-${directChild.id}`).click();
  await page.getByTestId(`select-row-filter-target-${form.fields[0].id}-${directChild.id}-0`).click();
  await page.getByRole("option", { name: "Model value", exact: false }).click();
  await page.getByTestId(`select-row-filter-input-${form.fields[0].id}-${directChild.id}-0`).click();
  await page.getByRole("option", { name: distinctChild.label, exact: true }).click();
}

test("an unsaved builder does not discover objects and saves a field before discovery can start", async ({ page }) => {
  const state = await installHarness(page, {
    authenticated: true,
    forms: [builderForm()],
  });
  await page.goto(`/FormBuilder?tenant=${tenants.alpha.slug}`);
  await expect(page.getByRole("heading", { name: "Create Form" })).toBeVisible();
  expect(state.discoveryRequests).toEqual([]);

  await page.getByTestId("tab-settings").click();
  await page.locator("#name").fill("Task 4371 save-first form");
  await page.locator("#slug").fill("task-4371-save-first");
  await page.getByTestId("tab-builder").click();
  await page.getByRole("button", { name: "Add Field" }).first().click();
  await page.getByRole("button", { name: "Save Form" }).click();

  await expect.poll(() => state.creates.length).toBe(1);
  expect(state.creates[0].fields).toHaveLength(1);
  expect(state.creates[0].fields[0].option_source).toBeUndefined();
  expect(state.unexpectedWrites).toEqual([]);
  await expect(page).toHaveURL(/\/FormManagement/);
});

test("builder discovery exposes loading, failure, and confirmed-empty states", async ({ page }) => {
  const modes = [
    { name: "loading", mode: "loading", delay: 2_500, expected: /Loading eligible Custom Objects/ },
    { name: "failure", mode: "error", delay: 0, expected: /Unable to load eligible Custom Objects/ },
    { name: "empty", mode: "empty", delay: 0, expected: /No eligible Custom Objects are available/ },
  ];

  for (const scenario of modes) {
    await test.step(`builder discovery ${scenario.name}`, async () => {
      const form = builderForm({
        formId: `${id.alphaForm}-${scenario.name}`,
        rowsId: `${id.alphaRows}-${scenario.name}`,
        parentId: `${id.alphaParent}-${scenario.name}`,
        directId: `${id.alphaDirect}-${scenario.name}`,
        distinctId: `${id.alphaDistinct}-${scenario.name}`,
      });
      const state = await installHarness(page, {
        authenticated: true,
        forms: [form],
        discoveryDelay: scenario.delay,
        discoveryModeByForm: { [form.id]: scenario.mode },
      });
      await page.goto(`/FormBuilder?tenant=${tenants.alpha.slug}&formId=${form.id}`);
      await expect(page.getByTestId(`button-configure-field-${form.fields[0].id}`)).toBeVisible();
      await page.getByTestId(`button-configure-field-${form.fields[0].id}`).click();
      await expect(page.getByTestId(`repeatable-row-source-${scenario.name === "empty" ? "empty" : scenario.name === "failure" ? "error" : "loading"}-${form.fields[0].id}-${form.fields[0].children[1].id}`))
        .toContainText(scenario.expected);
      if (scenario.mode === "error") {
        state.discoveryModeByForm[form.id] = "ok";
        await page.getByTestId(`repeatable-row-source-error-${form.fields[0].id}-${form.fields[0].children[1].id}`)
          .getByRole("button", { name: "Retry" }).click();
        await expect(page.getByTestId(`select-row-source-object-${form.fields[0].id}-${form.fields[0].children[1].id}`))
          .toBeEnabled();
         await page.screenshot({ path: "screenshots/discovery-builder.png", fullPage: true });
      }
      expect(state.unexpectedWrites).toEqual([]);
      expect(state.pageErrors).toEqual([]);
      await page.keyboard.press("Escape");
    });
  }
});

test("public object options stay loading, support retry, and distinguish confirmed empty", async ({ page }) => {
  const form = publicForm({ tenantKey: "alpha" });
  const state = await installHarness(page, { forms: [form] });
  const parentId = "public-alpha-parent";
  const failureId = "public-alpha-failure";
  const emptyId = "public-alpha-empty";
  const distinctId = "public-alpha-distinct";

  await page.goto(`/FormView?tenant=${tenants.alpha.slug}&slug=${form.slug}`);
  await expect(page.getByTestId(`select-relationship-${parentId}`)).toBeVisible();
  await expect(page.getByText("Loading related records…")).toBeVisible();
  await expect(page.getByTestId(`select-relationship-${parentId}`)).toBeEnabled();

  await chooseRelationship(page, parentId, recordId(1));
  await expect(page.getByTestId(`retry-relationship-${failureId}`)).toBeVisible();

  // The first request and any query-library retries remain failed until this
  // explicit state change, so the test proves the visible Retry path rather
  // than accidentally passing on an automatic retry.
  state.retryAllowed = true;
  await page.getByTestId(`retry-relationship-${failureId}`).click();
  await chooseRelationship(page, failureId, recordId(201));

  await expect(page.getByTestId(`relationship-empty-message-${emptyId}`))
    .toHaveText("No matching models for this manufacturer.");
  await expect(page.getByTestId(`select-relationship-${emptyId}`)).toBeDisabled();

  await chooseRelationship(page, distinctId, recordId(301));
  expect(state.optionRequests.some(request => (
    request.slug === form.slug
    && request.tenant === tenants.alpha.slug
    && request.fieldId === distinctId
    && request.dependencyAnswers[parentId] === recordId(1)
  ))).toBe(true);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("discovery cache isolates the tenant and form when the builder navigates between them", async ({ page }) => {
  const alpha = builderForm({ tenantKey: "alpha" });
  const beta = builderForm({
    tenantKey: "beta",
    formId: id.betaForm,
    rowsId: id.betaRows,
    parentId: id.betaParent,
    directId: id.betaDirect,
    distinctId: id.betaDistinct,
  });
  const state = await installHarness(page, {
    authenticated: true,
    forms: [alpha, beta],
    discoveryTenantByForm: {
      [alpha.id]: "alpha",
      [beta.id]: "beta",
    },
  });

  await page.goto(`/FormBuilder?tenant=${tenants.alpha.slug}&formId=${alpha.id}`);
  await expect(page.getByTestId(`button-configure-field-${alpha.fields[0].id}`)).toBeVisible();
  await page.getByTestId(`button-configure-field-${alpha.fields[0].id}`).click();
  await expect(page.getByTestId(`select-row-source-object-${alpha.fields[0].id}-${alpha.fields[0].children[0].id}`))
    .toContainText("Alpha Manufacturers");
  await page.keyboard.press("Escape");

  // Change the active tenant while preserving the QueryClient. The URL is
  // deliberately left with the old tenant query below, but the discovery
  // client intentionally omits that stale public slug and sends only the
  // explicit active-tenant header.
  await page.evaluate(async () => {
    await fetch("/api/auth/tenant-user-me?tenant=task4371-beta", { credentials: "include" });
  });
  await expect.poll(() => state.tenantUserTenant).toBe("beta");

  await page.evaluate(({ formId, tenant }) => {
    window.history.pushState({}, "", `/FormBuilder?tenant=${tenant}&formId=${formId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, { formId: beta.id, tenant: tenants.alpha.slug });

  await expect(page.getByRole("heading", { name: beta.name })).toBeVisible();
  await page.getByTestId(`button-configure-field-${beta.fields[0].id}`).click();
  await expect(page.getByTestId(`select-row-source-object-${beta.fields[0].id}-${beta.fields[0].children[0].id}`))
    .toContainText("Beta Manufacturers");
  expect(state.discoveryRequests.some(request => (
    request.formId === beta.id && request.tenant === tenants.beta.slug
    && request.queryTenant === null
    && request.headerTenant === tenants.beta.slug
  ))).toBe(true);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("an unsaved repeatable row source disables custom-object source kinds", async ({ page }) => {
  const state = await installHarness(page, {
    authenticated: true,
    forms: [builderForm()],
  });
  await page.goto(`/FormBuilder?tenant=${tenants.alpha.slug}`);
  await expect(page.getByRole("heading", { name: "Create Form" })).toBeVisible();
  await page.getByRole("button", { name: "Add Field" }).first().click();

  const configureButton = page.locator('[data-testid^="button-configure-field-"]').last();
  const configureTestId = await configureButton.getAttribute("data-testid");
  const fieldId = configureTestId.replace("button-configure-field-", "");
  await configureButton.click();
  await page.getByTestId(`select-standard-type-${fieldId}`).click();
  await page.getByRole("option", { name: "Repeatable Rows" }).click();
  await page.getByRole("button", { name: "Add field", exact: true }).click();

  const childType = page.locator(`[data-testid^="select-repeatable-child-type-${fieldId}-"]`).first();
  const childTypeId = await childType.getAttribute("data-testid");
  const childId = childTypeId.replace(`select-repeatable-child-type-${fieldId}-`, "");
  await childType.click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  const sourceSelect = page.getByTestId(`select-row-option-source-${fieldId}-${childId}`);
  await sourceSelect.click();
  const recordsOption = page.getByRole("option", { name: "Records from a custom object" });
  const distinctOption = page.getByRole("option", { name: "Distinct related field values" });
  await expect(recordsOption).toHaveAttribute("aria-disabled", "true");
  await expect(distinctOption).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  expect(state.discoveryRequests).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("repeatable-row object direct and distinct sources survive save and reopen", async ({ page }) => {
  const form = builderForm({
    formId: `${id.alphaForm}-from-scratch`,
    rowsId: `${id.alphaRows}-from-scratch`,
    parentId: `${id.alphaParent}-from-scratch`,
    directId: `${id.alphaDirect}-from-scratch`,
    distinctId: `${id.alphaDistinct}-from-scratch`,
    fromScratch: true,
  });
  const state = await installHarness(page, {
    authenticated: true,
    forms: [form],
  });

  await page.goto(`/FormBuilder?tenant=${tenants.alpha.slug}&formId=${form.id}`);
  await configureDirectAndDistinct(page, form);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);

  const savedChildren = state.saves.at(-1).fields[0].children;
  const parentChild = form.fields[0].children[0];
  const distinctChild = form.fields[0].children[1];
  const directChild = form.fields[0].children[2];
  const savedDirect = savedChildren.find(child => child.id === directChild.id);
  const savedDistinct = savedChildren.find(child => child.id === distinctChild.id);
  expect(savedDirect.option_source).toMatchObject({
    kind: "records",
    custom_object_id: id.alphaChildObject,
    primary_display_field_id: id.alphaChildLabel,
    filters: [{
      field_id: id.childValue,
      source_field_id: distinctChild.id,
    }],
  });
  expect(savedDirect).toMatchObject({
    parent_field_id: parentChild.id,
    relationship_definition_id: id.relation,
  });
  expect(savedDistinct.option_source).toMatchObject({
    kind: "distinct",
    value_field_id: id.childValue,
  });
  expect(savedDistinct).toMatchObject({
    parent_field_id: parentChild.id,
    relationship_definition_id: id.relation,
  });

  await page.reload();
  await page.getByTestId(`button-configure-field-${form.fields[0].id}`).click();
  await expect(page.getByTestId(`select-row-option-source-${form.fields[0].id}-${parentChild.id}`))
    .toContainText("Records from a custom object");
  await expect(page.getByTestId(`select-row-option-source-${form.fields[0].id}-${directChild.id}`))
    .toContainText("Records from a custom object");
  await expect(page.getByTestId(`select-row-filter-target-${form.fields[0].id}-${directChild.id}-0`))
    .toContainText("Alpha model value");
  await expect(page.getByTestId(`select-row-filter-input-${form.fields[0].id}-${directChild.id}-0`))
    .toContainText(distinctChild.label);
  await expect(page.getByTestId(`select-row-option-source-${form.fields[0].id}-${distinctChild.id}`))
    .toContainText("Distinct related field values");
  await expect(page.getByTestId(`select-row-source-value-${form.fields[0].id}-${distinctChild.id}`))
    .toContainText("Alpha model value");
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

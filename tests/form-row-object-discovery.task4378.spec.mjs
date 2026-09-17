import { test, expect } from "@playwright/test";
import {
  createFormRelationshipDiscoveryHandler,
} from "../api/_lib/formRelationshipRoutes.js";
import {
  createFormRelationshipService,
} from "../api/_lib/formRelationshipOptions.js";
import {
  validateFormRowSourceConfiguration,
} from "../api/_lib/formRowSourceConfiguration.js";
import {
  resolveTrustedSchemaCapabilities,
} from "../api/_lib/customObjectSchemaAccess.js";
import {
  validateRowSourceConfiguration,
} from "../shared/formCustomObjectRowSources.js";

// This suite is deliberately a browser-level harness, but discovery itself is
// not stubbed. Each discovery request is dispatched through the production
// route factory and the production relationship service against the fixture DB
// below. The other FormBuilder requests remain local and read-only apart from
// the form POST/PATCH used to prove create/save and update/reopen.

const id = {
  tenant: "81000000-0000-4000-8000-000000000001",
  form: "81000000-0000-4000-8000-000000000002",
  rows: "81000000-0000-4000-8000-000000000003",
  parent: "81000000-0000-4000-8000-000000000004",
  distinct: "81000000-0000-4000-8000-000000000005",
  direct: "81000000-0000-4000-8000-000000000006",
  relation: "82000000-0000-4000-8000-000000000001",
  parentObject: "82000000-0000-4000-8000-000000000002",
  childObject: "82000000-0000-4000-8000-000000000003",
  hiddenObject: "82000000-0000-4000-8000-000000000004",
  parentLabel: "83000000-0000-4000-8000-000000000001",
  childLabel: "83000000-0000-4000-8000-000000000002",
  childValue: "83000000-0000-4000-8000-000000000003",
  hiddenLabel: "83000000-0000-4000-8000-000000000004",
  member: "84000000-0000-4000-8000-000000000001",
  role: "84000000-0000-4000-8000-000000000002",
};

const tenant = {
  id: id.tenant,
  slug: "task4378-schema-author",
  name: "Task 4378 schema-author fixture",
};

function objectDefinition(objectId, objectKey, singularLabel, pluralLabel, primaryDisplayFieldId) {
  return {
    id: objectId,
    tenant_id: tenant.id,
    object_key: objectKey,
    singular_label: singularLabel,
    plural_label: pluralLabel,
    primary_display_field_id: primaryDisplayFieldId,
    status: "active",
    archived_at: null,
  };
}

function objectField(fieldId, objectId, name, label, fieldType = "text") {
  return {
    id: fieldId,
    tenant_id: tenant.id,
    custom_object_id: objectId,
    entity_scope: "custom_object",
    name,
    label,
    field_type: fieldType,
    is_active: true,
    display_order: 0,
  };
}

function schemaAuthorForm() {
  return {
    id: id.form,
    tenant_id: tenant.id,
    slug: "task-4378-schema-author-form",
    name: "Task 4378 schema-author form",
    title: "Task 4378 schema-author form",
    description: "",
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
      children: [
        { id: id.parent, type: "text", label: "Manufacturer" },
        { id: id.distinct, type: "text", label: "Model value" },
        { id: id.direct, type: "text", label: "Direct model" },
      ],
    }],
    pages: [],
    form_type: "standard",
    survey_settings: {},
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
  };
}

function fixtureSeed(form) {
  const parent = objectDefinition(
    id.parentObject,
    "manufacturer",
    "Manufacturer",
    "Manufacturers",
    id.parentLabel,
  );
  const child = objectDefinition(
    id.childObject,
    "vehicle_model",
    "Vehicle model",
    "Vehicle models",
    id.childLabel,
  );
  const hidden = objectDefinition(
    id.hiddenObject,
    "ungranted_model",
    "Unrestricted model",
    "Unrestricted models",
    id.hiddenLabel,
  );
  return {
    form: [form],
    custom_object_relationship_definition: [{
      id: id.relation,
      tenant_id: tenant.id,
      relationship_key: "manufacturer_models",
      status: "active",
      archived_at: null,
      source_kind: "custom_object",
      source_custom_object_id: id.parentObject,
      target_kind: "custom_object",
      target_custom_object_id: id.childObject,
      source_label: "Manufacturers",
      target_label: "Vehicle models",
      show_on_source: true,
      show_on_target: true,
    }],
    custom_object_definition: [parent, child, hidden],
    preference_field: [
      objectField(id.parentLabel, id.parentObject, "manufacturer_name", "Manufacturer name"),
      objectField(id.childLabel, id.childObject, "model_name", "Model name"),
      objectField(id.childValue, id.childObject, "model_value", "Model value"),
      objectField(id.hiddenLabel, id.hiddenObject, "model_name", "Hidden model name"),
    ],
    // This is deliberately empty. A schema-authorized member receives the
    // catalogue from the trusted schema capabilities, not from record grants.
    // Keeping the grant table empty prevents this representative test from
    // accidentally proving the ordinary member-grant path instead.
    custom_object_role_permission: [],
    custom_object_field_role_permission: [],
  };
}

/**
 * Small Supabase-shaped fixture DB. It intentionally implements the query
 * operations used by createFormRelationshipService rather than returning a
 * precomputed discovery envelope.
 */
function fixtureDb(seed) {
  const tables = structuredClone(seed);
  const queries = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
      this.rangeBounds = null;
    }

    select(projection) {
      queries.push({ table: this.table, projection });
      return this;
    }

    eq(column, value) {
      this.filters.push(row => row[column] === value);
      return this;
    }

    is(column, value) {
      this.filters.push(row => (
        value === null ? row[column] == null : row[column] === value
      ));
      return this;
    }

    in(column, values) {
      this.filters.push(row => values.includes(row[column]));
      return this;
    }

    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      queries.push({ table: this.table, order: { column, ascending } });
      return this;
    }

    range(from, to) {
      this.rangeBounds = [from, to + 1];
      queries.push({ table: this.table, range: [from, to] });
      return this;
    }

    execute() {
      let rows = (tables[this.table] || [])
        .filter(row => this.filters.every(filter => filter(row)));
      rows = [...rows].sort((left, right) => {
        for (const order of this.orders) {
          if (left[order.column] === right[order.column]) continue;
          const result = left[order.column] < right[order.column] ? -1 : 1;
          return order.ascending ? result : -result;
        }
        return 0;
      });
      if (this.rangeBounds) rows = rows.slice(...this.rangeBounds);
      return { data: structuredClone(rows), error: null };
    }

    async maybeSingle() {
      const result = this.execute();
      return { ...result, data: result.data[0] || null };
    }

    then(resolve, reject) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }

  return {
    queries,
    from: table => new Query(table),
  };
}

function objectFields(seed, objectId) {
  return seed.preference_field.filter(field => field.custom_object_id === objectId);
}

async function installSchemaAuthorHarness(page, form) {
  const seed = fixtureSeed(form);
  const db = fixtureDb(seed);
  const state = {
    // The browser first creates the form, then reopens the returned ID for
    // the schema-author configuration/update pass. The discovery service gets
    // the same synthetic form from its fixture DB below.
    forms: [],
    creates: [],
    saves: [],
    discoveryRequests: [],
    discoveryResponses: [],
    authorAccess: [],
    contexts: [],
    adminChecks: [],
    featureChecks: [],
    validationResults: [],
    unexpectedWrites: [],
    pageErrors: [],
  };

  const member = {
    id: id.member,
    tenant_id: tenant.id,
    role_id: id.role,
    email: "task4378-schema-author@example.invalid",
    first_name: "Task",
    last_name: "4378",
    is_team_member: true,
    member_excluded_features: [],
  };
  const role = {
    id: id.role,
    name: "Schema Author",
    excluded_features: [],
  };
  const schemaFeatures = new Set([
    "admin.data-studio",
    "data.custom-objects.manage-data-model",
  ]);
  const hasFeatureAccess = async (roleId, feature) => {
    state.featureChecks.push({ roleId, feature });
    return roleId === id.role && schemaFeatures.has(feature);
  };
  const authorContext = {
    isAuthenticated: true,
    tenantId: tenant.id,
    tenantUserId: null,
    memberId: member.id,
    roleId: member.role_id,
    memberExcludedFeatures: [],
  };
  const validateForm = async candidate => {
    const schemaCapabilities = await resolveTrustedSchemaCapabilities(authorContext, {
      hasFeatureAccess,
    });
    const structuralResult = { ok: true };
    const validatorCandidate = structuredClone(candidate);
    for (const field of validatorCandidate.fields || []) {
      const childrenKey = Array.isArray(field.children)
        ? "children"
        : Array.isArray(field.child_fields)
          ? "child_fields"
          : Array.isArray(field.fields) ? "fields" : null;
      if (!childrenKey) continue;
      const children = field[childrenKey];
      for (const child of children) {
        if (child.option_source === undefined) continue;
        const structural = validateRowSourceConfiguration(child, children);
        if (!structural.valid) {
          structuralResult.ok = false;
          structuralResult.errors = structural.errors;
        }
      }
    }
    if (!structuralResult.ok) {
      const result = {
        ok: false,
        status: 422,
        code: "INVALID_ROW_OPTION_SOURCE",
        error: structuralResult.errors[0]?.message || "Invalid row source",
      };
      state.validationResults.push({ result, structuralResult, schemaCapabilities });
      return result;
    }
    const result = await validateFormRowSourceConfiguration({
      db,
      tenantId: tenant.id,
      form: validatorCandidate,
      canConfigure: true,
      isTenantUser: false,
      authorRoleId: member.role_id,
      ...schemaCapabilities,
    });
    state.validationResults.push({ result, structuralResult, schemaCapabilities });
    return result;
  };

  const discoveryHandler = createFormRelationshipDiscoveryHandler({
    db,
    getTenantContext: async request => {
      const context = {
        isAuthenticated: true,
        tenantId: request.headers?.["x-tenant-id"] || tenant.id,
        tenantUserId: null,
        memberId: member.id,
        roleId: member.role_id,
        memberExcludedFeatures: [],
      };
      state.contexts.push(context);
      return context;
    },
    hasAdminAccess: async context => {
      state.adminChecks.push(context);
      return context.roleId === id.role && !context.tenantUserId;
    },
    hasFeatureAccess,
    createService: options => {
      const service = createFormRelationshipService(options);
      return {
        ...service,
        eligibleDefinitions: async (formId, authorAccess) => {
          state.authorAccess.push(authorAccess);
          return service.eligibleDefinitions(formId, authorAccess);
        },
      };
    },
  });

  page.on("pageerror", error => {
    state.pageErrors.push(error.message);
    console.error("Browser page error:", error.message);
  });

  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const method = request.method();

    if (path === "/api/auth/me") return json(route, member);
    if (path === "/api/auth/tenant-user-me") {
      // This is a portal/member session, not a tenant-user dashboard
      // session. In particular, do not return a tenantUser or let the
      // interceptor establish a tenant-user context.
      return json(route, {
        authenticated: false,
        user: null,
        tenant: null,
        tenantUser: null,
      });
    }
    if (path === `/api/entities/Role/${id.role}` && method === "GET") {
      return json(route, role);
    }
    if (path === "/api/entities/Role" && method === "GET") {
      return json(route, [role]);
    }

    const relationshipDefinitionMatch = path.match(
      /^\/api\/forms\/([^/]+)\/relationship-definitions$/,
    );
    if (relationshipDefinitionMatch && method === "GET") {
      const formId = decodeURIComponent(relationshipDefinitionMatch[1]);
      state.discoveryRequests.push({
        formId,
        tenantHeader: request.headers()["x-tenant-id"] || null,
      });
      const response = {
        statusCode: 200,
        payload: null,
        status(statusCode) {
          this.statusCode = statusCode;
          return this;
        },
        json(payload) {
          this.payload = payload;
          return this;
        },
      };
      await discoveryHandler({
        method: "GET",
        query: { formId },
        headers: request.headers(),
      }, response);
      state.discoveryResponses.push(response.payload);
      return json(route, response.payload, response.statusCode);
    }

    if (path === "/api/entities/Form" && method === "GET") {
      return json(route, state.forms);
    }
    if (path === "/api/entities/Form" && method === "POST") {
      const draft = request.postDataJSON();
      const created = {
        ...draft,
        id: id.form,
        tenant_id: tenant.id,
      };
      const validation = await validateForm(created);
      if (!validation.ok) return json(route, validation, validation.status);
      state.creates.push(structuredClone(draft));
      state.forms.push(structuredClone(created));
      return json(route, created);
    }
    const formPatchMatch = path.match(/^\/api\/entities\/Form\/([^/]+)$/);
    if (formPatchMatch && method === "PATCH") {
      const formId = decodeURIComponent(formPatchMatch[1]);
      const patch = request.postDataJSON();
      const index = state.forms.findIndex(candidate => candidate.id === formId);
      const candidate = index >= 0 ? { ...state.forms[index], ...patch } : { ...patch, id: formId };
      const validation = await validateForm(candidate);
      if (!validation.ok) return json(route, validation, validation.status);
      if (index >= 0) state.forms[index] = candidate;
      state.saves.push(structuredClone(patch));
      return json(route, state.forms[index] || { ...patch, id: formId });
    }

    if (path === "/api/custom-objects" && method === "GET") {
      const objects = seed.custom_object_definition
        .filter(object => [id.parentObject, id.childObject].includes(object.id))
        .map(object => ({
          ...object,
          fields: objectFields(seed, object.id),
        }));
      return json(route, { data: objects, total: objects.length, page: 1, pageSize: 100 });
    }
    const objectFieldsMatch = path.match(/^\/api\/custom-objects\/([^/]+)\/fields$/);
    if (objectFieldsMatch && method === "GET") {
      return json(route, {
        data: objectFields(seed, decodeURIComponent(objectFieldsMatch[1])),
      });
    }
    const objectRelationshipsMatch = path.match(
      /^\/api\/custom-objects\/([^/]+)\/relationship-definitions$/,
    );
    if (objectRelationshipsMatch && method === "GET") {
      return json(route, {
        data: seed.custom_object_relationship_definition,
      });
    }

    if (path === "/api/public/tenant-branding" && method === "GET") {
      return json(route, { success: true, branding: {} });
    }
    if (path === "/api/public/resource-categories" && method === "GET") {
      return json(route, []);
    }
    if (path === "/api/admin/integrations" && method === "GET") {
      return json(route, { integrations: [] });
    }
    if (path === "/api/public/form-consent-message" && method === "GET") {
      return json(route, {});
    }
    if (method === "GET") return json(route, []);

    if (["POST", "PATCH", "DELETE", "PUT"].includes(method)) {
      state.unexpectedWrites.push({
        method,
        path,
        body: request.postData(),
      });
      return json(route, { error: `Unexpected fixture write ${method} ${path}` }, 599);
    }
    return json(route, []);
  });

  return { state, seed, db };
}

async function createFormBeforeDiscovery(page, state) {
  await page.goto(`/FormBuilder?tenant=${tenant.slug}`);
  await expect(page.getByRole("heading", { name: "Create Form" })).toBeVisible();

  await page.getByTestId("tab-settings").click();
  await page.locator("#name").fill("Task 4378 schema-author form");
  await page.locator("#slug").fill("task-4378-schema-author-form");
  await page.getByTestId("tab-builder").click();

  await page.getByRole("button", { name: "Add Field" }).first().click();
  const configureButton = page.locator('[data-testid^="button-configure-field-"]').last();
  const fieldTestId = await configureButton.getAttribute("data-testid");
  const fieldId = fieldTestId.replace("button-configure-field-", "");
  await configureButton.click();
  await page.getByTestId(`select-standard-type-${fieldId}`).click();
  await page.getByRole("option", { name: "Repeatable Rows" }).click();

  const addRowField = page.getByRole("button", { name: "Add field", exact: true });
  await expect(addRowField).toBeVisible();
  await addRowField.click();
  await addRowField.click();
  await addRowField.click();

  const childTypeSelects = page.locator(
    `[data-testid^="select-repeatable-child-type-${fieldId}-"]`,
  );
  await expect(childTypeSelects).toHaveCount(3);
  for (const [index, label] of ["Manufacturer", "Model value", "Direct model"].entries()) {
    await page.getByTestId(`repeatable-child-${fieldId}-${index}`)
      .locator("input")
      .first()
      .fill(label);
  }

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.creates.length).toBe(1);
  await expect(page).toHaveURL(/\/FormManagement/);

  const created = state.forms.find(candidate => candidate.id === id.form);
  expect(created).toBeTruthy();
  expect(created.fields).toHaveLength(1);
  const createdChildren = created.fields[0].children
    || created.fields[0].child_fields
    || created.fields[0].fields;
  expect(createdChildren.map(child => child.label)).toEqual([
    "Manufacturer",
    "Model value",
    "Direct model",
  ]);
  return created;
}

async function configureDirectAndDistinct(page, form) {
  const children = form.fields[0].children
    || form.fields[0].child_fields
    || form.fields[0].fields;
  const parentChild = children[0];
  const distinctChild = children[1];
  const directChild = children[2];
  const containerId = form.fields[0].id;

  await page.getByTestId(`button-configure-field-${containerId}`).click();

  await page.getByTestId(`select-repeatable-child-type-${containerId}-${parentChild.id}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${containerId}-${parentChild.id}`).click();
  await page.getByRole("option", { name: "Records from a custom object" }).click();
  const parentObjectSelect = page.getByTestId(`select-row-source-object-${containerId}-${parentChild.id}`);
  await expect(parentObjectSelect).toBeEnabled();
  await parentObjectSelect.click();
  await page.getByRole("option", { name: "Manufacturers", exact: true }).click();
  await expect(page.getByTestId(`row-source-primary-label-${containerId}-${parentChild.id}`))
    .toHaveText("Manufacturer name");

  await page.getByTestId(`select-repeatable-child-type-${containerId}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${containerId}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Distinct related field values" }).click();
  const distinctObjectSelect = page.getByTestId(`select-row-source-object-${containerId}-${distinctChild.id}`);
  await expect(distinctObjectSelect).toBeEnabled();
  await distinctObjectSelect.click();
  await page.getByRole("option", { name: "Vehicle models", exact: true }).click();
  await expect(page.getByTestId(`row-source-primary-label-${containerId}-${distinctChild.id}`))
    .toHaveText("Model name");
  await page.getByTestId(`select-row-relationship-parent-${containerId}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Manufacturer", exact: true }).click();
  const distinctRelationshipSelect = page.getByTestId(
    `select-row-relationship-definition-${containerId}-${distinctChild.id}`,
  );
  await expect(distinctRelationshipSelect).toBeEnabled();
  await distinctRelationshipSelect.click();
  await page.getByRole("option", { name: /Vehicle models/ }).click();
  await page.getByTestId(`select-row-source-value-${containerId}-${distinctChild.id}`).click();
  await page.getByRole("option", { name: "Model value", exact: true }).click();

  await page.getByTestId(`select-repeatable-child-type-${containerId}-${directChild.id}`).click();
  await page.getByRole("option", { name: "Relationship Dropdown" }).click();
  await page.getByTestId(`select-row-option-source-${containerId}-${directChild.id}`).click();
  await page.getByRole("option", { name: "Records from a custom object" }).click();
  const childObjectSelect = page.getByTestId(`select-row-source-object-${containerId}-${directChild.id}`);
  await expect(childObjectSelect).toBeEnabled();
  await childObjectSelect.click();
  await page.getByRole("option", { name: "Vehicle models", exact: true }).click();
  await expect(page.getByTestId(`row-source-primary-label-${containerId}-${directChild.id}`))
    .toHaveText("Model name");
  await page.getByTestId(`select-row-relationship-parent-${containerId}-${directChild.id}`).click();
  await page.getByRole("option", { name: "Manufacturer", exact: true }).click();
  const relationshipSelect = page.getByTestId(
    `select-row-relationship-definition-${containerId}-${directChild.id}`,
  );
  await expect(relationshipSelect).toBeEnabled();
  await relationshipSelect.click();
  await page.getByRole("option", { name: /Vehicle models/ }).click();
  await page.getByTestId(`add-row-source-filter-${containerId}-${directChild.id}`).click();
  await page.getByTestId(`select-row-filter-target-${containerId}-${directChild.id}-0`).click();
  await page.getByRole("option", { name: "Model value", exact: true }).click();
  await page.getByTestId(`select-row-filter-input-${containerId}-${directChild.id}-0`).click();
  await page.getByRole("option", { name: distinctChild.label, exact: true }).click();

  return { parentChild, distinctChild, directChild };
}

test("schema-author member creates, saves, updates record pickers, and reopens distinct filters", async ({ page }) => {
  const discoveryFixtureForm = schemaAuthorForm();
  const { state, seed, db } = await installSchemaAuthorHarness(page, discoveryFixtureForm);
  const form = await createFormBeforeDiscovery(page, state);

  // Creation is intentionally separate from discovery. The builder disables
  // custom-object source kinds until the form has an ID; this second visit is
  // the update/reopen path exercised by the representative member author.
  await page.goto(`/FormBuilder?tenant=${tenant.slug}&formId=${form.id}`);
  await expect(page.getByRole("heading", { name: form.name })).toBeVisible();

  const { parentChild, distinctChild, directChild } = await configureDirectAndDistinct(page, form);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);
  expect(state.creates).toHaveLength(1);

  const savedRow = state.saves.at(-1).fields[0];
  const savedChildren = savedRow.children || savedRow.child_fields || savedRow.fields;
  const savedParent = savedChildren.find(child => child.id === parentChild.id);
  const savedDistinct = savedChildren.find(child => child.id === distinctChild.id);
  const savedDirect = savedChildren.find(child => child.id === directChild.id);
  expect(savedParent.option_source).toMatchObject({
    kind: "records",
    custom_object_id: id.parentObject,
    primary_display_field_id: id.parentLabel,
    filters: [],
  });
  expect(savedDistinct.option_source).toMatchObject({
    kind: "distinct",
    custom_object_id: id.childObject,
    primary_display_field_id: id.childLabel,
    value_field_id: id.childValue,
  });
  expect(savedDirect.option_source).toMatchObject({
    kind: "records",
    custom_object_id: id.childObject,
    primary_display_field_id: id.childLabel,
    filters: [{
      field_id: id.childValue,
      source_field_id: distinctChild.id,
    }],
  });
  expect(savedDirect).toMatchObject({
    parent_field_id: parentChild.id,
    relationship_definition_id: id.relation,
    relationship_parent_kind: "custom_object",
    relationship_parent_custom_object_id: id.parentObject,
    related_custom_object_id: id.childObject,
    related_primary_display_field_id: id.childLabel,
  });
  expect(savedDistinct).toMatchObject({
    parent_field_id: parentChild.id,
    relationship_definition_id: id.relation,
    relationship_parent_kind: "custom_object",
    relationship_parent_custom_object_id: id.parentObject,
    related_custom_object_id: id.childObject,
    related_primary_display_field_id: id.childLabel,
  });

  expect(state.discoveryRequests.length).toBeGreaterThan(0);
  expect(state.discoveryResponses.length).toBe(state.discoveryRequests.length);
  expect(state.discoveryResponses.every(response => (
    Array.isArray(response?.data) && Array.isArray(response?.custom_objects)
  ))).toBe(true);
  expect(state.discoveryResponses.every(response => (
    response.custom_objects.some(object => object.id === id.parentObject)
    && response.custom_objects.some(object => object.id === id.childObject)
    && response.custom_objects.some(object => object.id === id.hiddenObject)
    && response.custom_objects.every(object => (
      [id.parentObject, id.childObject, id.hiddenObject].includes(object.id)
    ))
  ))).toBe(true);
  expect(state.contexts.every(context => (
    context.tenantId === tenant.id
    && context.tenantUserId === null
    && context.roleId === id.role
  ))).toBe(true);
  expect(state.adminChecks.every(context => context.tenantUserId === null)).toBe(true);
  expect(state.featureChecks).toEqual(expect.arrayContaining([
    { roleId: id.role, feature: "admin.data-studio" },
    { roleId: id.role, feature: "data.custom-objects.manage-data-model" },
  ]));
  expect(state.authorAccess).toEqual(expect.arrayContaining([
    expect.objectContaining({
      isTenantUser: false,
      roleId: id.role,
      canViewSchema: true,
      canManageSchema: true,
    }),
  ]));
  // Schema capabilities are resolved by the production discovery route. No
  // object-level record grants or live roles/data are needed in this fixture.
  expect(state.authorAccess.every(access => (
    access.isTenantUser === false
    && access.roleId === id.role
    && access.canViewSchema === true
    && access.canManageSchema === true
  ))).toBe(true);
  expect(state.discoveryResponses.every(response => (
    response.custom_objects.every(object => (
      [id.parentObject, id.childObject, id.hiddenObject].includes(object.id)
    ))
  ))).toBe(true);
  expect(state.validationResults).toHaveLength(2);
  expect(state.validationResults.every(({ result, structuralResult, schemaCapabilities }) => (
    result.ok === true
    && structuralResult.ok === true
    && schemaCapabilities.canViewSchema === true
    && schemaCapabilities.canManageSchema === true
  ))).toBe(true);
  expect(db.queries.some(query => query.table === "custom_object_role_permission")).toBe(false);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);

  await page.reload();
  await page.getByTestId(`button-configure-field-${form.fields[0].id}`).click();
  await expect(page.getByTestId(`select-row-option-source-${form.fields[0].id}-${parentChild.id}`))
    .toContainText("Records from a custom object");
  await expect(page.getByTestId(`row-source-primary-label-${form.fields[0].id}-${parentChild.id}`))
    .toHaveText("Manufacturer name");
  await expect(page.getByTestId(`select-row-option-source-${form.fields[0].id}-${distinctChild.id}`))
    .toContainText("Distinct related field values");
  await expect(page.getByTestId(`row-source-primary-label-${form.fields[0].id}-${distinctChild.id}`))
    .toHaveText("Model name");
  await expect(page.getByTestId(`select-row-source-value-${form.fields[0].id}-${distinctChild.id}`))
    .toContainText("Model value");
  await expect(page.getByTestId(`select-row-option-source-${form.fields[0].id}-${directChild.id}`))
    .toContainText("Records from a custom object");
  await expect(page.getByTestId(`row-source-primary-label-${form.fields[0].id}-${directChild.id}`))
    .toHaveText("Model name");
  await expect(page.getByTestId(`select-row-filter-target-${form.fields[0].id}-${directChild.id}-0`))
    .toContainText("Model value");
  await expect(page.getByTestId(`select-row-filter-input-${form.fields[0].id}-${directChild.id}-0`))
    .toContainText(distinctChild.label);

  await page.screenshot({
    path: "screenshots/task4378-schema-author-discovery.png",
    fullPage: true,
  });
  expect(seed.custom_object_role_permission).toHaveLength(0);
});

test("repeatable static options preserve drafts, normalize choices, and reopen after editing", async ({ page }) => {
  const discoveryFixtureForm = schemaAuthorForm();
  const { state } = await installSchemaAuthorHarness(page, discoveryFixtureForm);
  const form = await createFormBeforeDiscovery(page, state);
  const containerId = form.fields[0].id;
  const children = form.fields[0].children
    || form.fields[0].child_fields
    || form.fields[0].fields;
  const [selectChild, radioChild, checkboxChild] = children;

  // Reopen one persisted legacy row using the historical `dropdown` alias;
  // it must still expose the same static editor before the modern `select`
  // type is selected below.
  const persistedChildren = state.forms[0].fields[0].children
    || state.forms[0].fields[0].child_fields
    || state.forms[0].fields[0].fields;
  persistedChildren[0].type = "dropdown";
  await page.goto(`/FormBuilder?tenant=${tenant.slug}&formId=${form.id}`);
  await expect(page.getByRole("heading", { name: form.name })).toBeVisible();
  await page.getByTestId(`button-configure-field-${containerId}`).click();
  await expect(page.getByTestId(
    `textarea-repeatable-child-options-${containerId}-${selectChild.id}`,
  )).toBeVisible();

  for (const [child, typeLabel] of [
    [selectChild, "Dropdown"],
    [radioChild, "Radio Buttons"],
    [checkboxChild, "Checkboxes"],
  ]) {
    await page.getByTestId(`select-repeatable-child-type-${containerId}-${child.id}`).click();
    await page.getByRole("option", { name: typeLabel, exact: true }).click();
  }

  const selectOptions = page.getByTestId(
    `textarea-repeatable-child-options-${containerId}-${selectChild.id}`,
  );
  const radioOptions = page.getByTestId(
    `textarea-repeatable-child-options-${containerId}-${radioChild.id}`,
  );
  const checkboxOptions = page.getByTestId(
    `textarea-repeatable-child-options-${containerId}-${checkboxChild.id}`,
  );
  await expect(selectOptions).toHaveAccessibleName("Options (one per line)");
  await expect(radioOptions).toBeVisible();
  await expect(checkboxOptions).toBeVisible();

  // fill exercises pasted multiline input, including blank and whitespace-only
  // lines; the parent receives normalized values while the local draft keeps
  // exactly what the user typed until blur.
  await selectOptions.fill("  Sedan  \n\n  Hatchback\n   \n Coupe  ");
  await expect(selectOptions).toHaveValue("  Sedan  \n\n  Hatchback\n   \n Coupe  ");

  // Use real key events for an incomplete line and verify blur resets the
  // local draft to the normalized parent options.
  await radioOptions.click();
  await radioOptions.pressSequentially("First  ");
  await radioOptions.press("Enter");
  await expect(radioOptions).toHaveValue("First  \n");
  await radioOptions.pressSequentially("Second   ");
  await expect(radioOptions).toHaveValue("First  \nSecond   ");
  await radioOptions.press("Tab");
  await expect(radioOptions).toHaveValue("First\nSecond");

  // Removing an option and entering another blank line must not persist an
  // empty choice.
  await checkboxOptions.fill("Keep\nRemove\n\n   ");
  await checkboxOptions.fill("Keep\n\n  ");
  await checkboxOptions.press("Tab");
  await expect(checkboxOptions).toHaveValue("Keep");

  // The user-defined list type is deliberately not a static-options editor.
  await page.getByTestId(`select-repeatable-child-type-${containerId}-${checkboxChild.id}`).click();
  await page.getByRole("option", { name: "List (User-Defined Values)", exact: true }).click();
  await expect(checkboxOptions).toBeHidden();
  await page.getByTestId(`select-repeatable-child-type-${containerId}-${checkboxChild.id}`).click();
  await page.getByRole("option", { name: "Checkboxes", exact: true }).click();
  await expect(checkboxOptions).toBeVisible();

  // Reordering the row children must move their settings with the child.
  await page.getByTestId(`repeatable-child-${containerId}-0`)
    .getByRole("button", { name: "Move row field right" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);

  const savedRow = state.saves.at(-1).fields[0];
  const savedChildren = savedRow.children || savedRow.child_fields || savedRow.fields;
  expect(savedChildren.map(child => child.id)).toEqual([
    radioChild.id,
    selectChild.id,
    checkboxChild.id,
  ]);
  expect(savedChildren.find(child => child.id === selectChild.id).options)
    .toEqual(["Sedan", "Hatchback", "Coupe"]);
  expect(savedChildren.find(child => child.id === radioChild.id).options)
    .toEqual(["First", "Second"]);
  expect(savedChildren.find(child => child.id === checkboxChild.id).options)
    .toEqual(["Keep"]);

  await page.reload();
  await page.getByTestId(`button-configure-field-${containerId}`).click();
  await expect(page.getByTestId(
    `textarea-repeatable-child-options-${containerId}-${selectChild.id}`,
  )).toHaveValue("Sedan\nHatchback\nCoupe");
  await expect(page.getByTestId(
    `textarea-repeatable-child-options-${containerId}-${radioChild.id}`,
  )).toHaveValue("First\nSecond");
  await expect(page.getByTestId(
    `textarea-repeatable-child-options-${containerId}-${checkboxChild.id}`,
  )).toHaveValue("Keep");

  // Continue editing after a real reload; closing the dialog while a draft is
  // focused must not discard the final input or save its empty trailing line.
  await checkboxOptions.fill("");
  await expect(checkboxOptions).toHaveValue("");
  await radioOptions.click();
  await radioOptions.press("End");
  await radioOptions.press("Enter");
  await expect(radioOptions).toHaveValue("First\nSecond\n");
  await radioOptions.pressSequentially("Third");
  await radioOptions.press("Enter");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form" }).click();
  await expect.poll(() => state.saves.length).toBe(2);
  const updatedRow = state.saves.at(-1).fields[0];
  const updatedChildren = updatedRow.children || updatedRow.child_fields || updatedRow.fields;
  expect(updatedChildren.find(child => child.id === radioChild.id).options)
    .toEqual(["First", "Second", "Third"]);
  expect(updatedChildren.find(child => child.id === checkboxChild.id).options).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

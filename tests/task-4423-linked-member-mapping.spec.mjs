import { test, expect } from "@playwright/test";

const FORM_ID = "task-4423-linked-member-form";
const CONFIG_ID = "task-4423-linked-member-config";
const STAGE_ID = "task-4423-review-stage";
const MEMBER_ACTION_ID = "task-4423-create-member";
const ORGANIZATION_MAPPING_ID = "task-4423-organization-mapping";
const MEMBER_MAPPING_ID = "task-4423-member-mapping";
const MEMBER_FIELD_ID = "task-4423-member-preference";

const adminMember = {
  id: "task-4423-admin",
  tenant_id: "task-4423-tenant",
  organization_id: "task-4423-organization",
  role_id: "task-4423-admin-role",
  email: "task-4423-admin@example.invalid",
  first_name: "Task",
  last_name: "4423",
  member_excluded_features: [],
};

const adminRole = {
  id: adminMember.role_id,
  name: "Administrator",
  excluded_features: [],
};

const form = {
  id: FORM_ID,
  name: "Task 4423 linked member fixture",
  description: "Mounted configuration fixture",
  due_diligence_required: true,
  fields: [
    { id: "source-first", name: "source_first", label: "First name", type: "text" },
    { id: "source-last", name: "source_last", label: "Last name", type: "text" },
    { id: "source-email", name: "source_email", label: "Email", type: "email" },
  ],
};

const config = {
  id: CONFIG_ID,
  form_id: FORM_ID,
  scoring_approach: "dynamic",
  default_review_state: "amended",
  scoring_rules: { rules: [], risk_thresholds: {} },
  static_questions: [],
  custom_risk_levels: [],
  status_change_webhooks: [],
  owner_role_ids: [],
  workflow_stages: [{
    id: STAGE_ID,
    label: "Review",
    color: "#f97316",
    is_initial: true,
    order: 0,
    allow_swap: true,
    selection_conditions: {},
    stage_actions: {},
  }],
};

const createMemberAction = {
  id: MEMBER_ACTION_ID,
  due_diligence_stage_id: STAGE_ID,
  first_name_field: "source-first",
  last_name_field: "source-last",
  email_field: "source-email",
  role_id: null,
  welcome_email_template_id: null,
  field_mappings: { core: {}, custom: {} },
  login_enabled: false,
  is_active: true,
  sort_order: 0,
};

const organizationMappingAction = {
  id: ORGANIZATION_MAPPING_ID,
  due_diligence_stage_id: STAGE_ID,
  // Deliberately omit target_entity: old records must stay organization actions.
  field_mappings: [{
    source_type: "field",
    source_field_id: "source-first",
    target_type: "core",
    target_field: "name",
    transformation: "none",
  }],
  is_active: true,
};

const memberCustomField = {
  id: MEMBER_FIELD_ID,
  name: "member_segment",
  label: "Member segment",
  field_type: "text",
  entity_scope: "member",
  is_active: true,
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function installDueDiligenceConfigFixture(page, { failMemberMappingSave = false } = {}) {
  const state = {
    fieldActions: [clone(organizationMappingAction)],
    memberActions: [clone(createMemberAction)],
    writes: [],
    unexpectedWrites: [],
    pageErrors: [],
  };

  page.on("pageerror", error => state.pageErrors.push(error.message));

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() || null;

    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me" && method === "GET") return json(route, adminMember);
    if (path === "/api/auth/tenant-user-me" && method === "GET") {
      return json(route, {
        user: adminMember,
        tenant: { id: adminMember.tenant_id, slug: "task-4423" },
      });
    }
    if (path === `/api/entities/Member/${adminMember.id}` && method === "GET") {
      return json(route, adminMember);
    }
    if (path === `/api/entities/Organization/${adminMember.organization_id}` && method === "GET") {
      return json(route, {
        id: adminMember.organization_id,
        tenant_id: adminMember.tenant_id,
        name: "Task 4423 Organisation",
      });
    }
    if (path === `/api/entities/Role/${adminRole.id}` && method === "GET") {
      return json(route, adminRole);
    }
    if (path === "/api/entities/Role" && method === "GET") return json(route, [adminRole]);
    if (path === "/api/entities/Form" && method === "GET") return json(route, [clone(form)]);
    if (path === "/api/entities/FormDueDiligenceConfig" && method === "GET") {
      return json(route, [clone(config)]);
    }
    if (path === "/api/entities/PreferenceField" && method === "GET") {
      return json(route, [
        clone(memberCustomField),
        {
          id: "task-4423-inactive-member-preference",
          name: "inactive",
          label: "Inactive member field",
          field_type: "text",
          entity_scope: "member",
          is_active: false,
        },
        {
          id: "task-4423-organization-preference",
          name: "organization_only",
          label: "Organization only",
          field_type: "text",
          entity_scope: "organization",
          is_active: true,
        },
        {
          id: "task-4423-unsupported-member-preference",
          name: "unsupported_member",
          label: "Unsupported member field",
          field_type: "object",
          entity_scope: "member",
          is_active: true,
        },
      ]);
    }
    if (path === "/api/entities/EmailTemplate" && method === "GET") return json(route, []);

    if (path === "/api/stage-field-mapping-actions" && method === "GET") {
      return json(route, { field_mapping_actions: clone(state.fieldActions) });
    }
    if (path === "/api/stage-field-mapping-actions" && method === "POST") {
      if (failMemberMappingSave) {
        return json(route, {
          error: "Member mapping rejected by fixture: source field unavailable",
        }, 422);
      }
      const action = {
        id: MEMBER_MAPPING_ID,
        due_diligence_stage_id: body.due_diligence_stage_id,
        field_mappings: clone(body.field_mappings),
        target_entity: body.target_entity,
        is_active: true,
      };
      state.fieldActions.push(action);
      state.writes.push({ method, path, body: clone(body) });
      return json(route, clone(action), 201);
    }
    const mappingMatch = path.match(/^\/api\/stage-field-mapping-actions\/([^/]+)$/);
    if (mappingMatch && method === "PUT") {
      if (failMemberMappingSave) {
        return json(route, {
          error: "Member mapping rejected by fixture: source field unavailable",
        }, 422);
      }
      const action = state.fieldActions.find(item => item.id === mappingMatch[1]);
      if (!action) return json(route, { error: "mapping not found" }, 404);
      Object.assign(action, {
        field_mappings: clone(body.field_mappings),
        target_entity: body.target_entity,
        ...(body.is_active === undefined ? {} : { is_active: body.is_active }),
      });
      state.writes.push({ method, path, body: clone(body) });
      return json(route, clone(action));
    }
    if (mappingMatch && method === "DELETE") {
      state.fieldActions = state.fieldActions.filter(item => item.id !== mappingMatch[1]);
      state.writes.push({ method, path, body });
      return json(route, { success: true });
    }

    if (path === "/api/stage-member-actions" && method === "GET") return json(route, state.memberActions);
    if (path === "/api/meeting-templates" && method === "GET") return json(route, { templates: [] });
    if (path === "/api/stage-meeting-requests" && method === "GET") return json(route, { meeting_requests: [] });
    if (path === "/api/entities/EmailTemplate" && method === "GET") return json(route, []);
    if (path === "/api/stage-email-actions" && method === "GET") return json(route, { email_actions: [] });
    if (path === "/api/stage-zoho-crm-actions" && method === "GET") return json(route, { actions: [] });
    if (path === "/api/zoho-campaigns/oauth" && method === "GET") {
      return json(route, { connected: false });
    }
    if (path === "/api/public/tenant-branding" && method === "GET") {
      return json(route, { success: true, branding: null });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected fixture mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });

  return state;
}

async function openActions(page) {
  await page.getByTestId("tab-workflow").click();
  const organizationHeading = page.getByText("Update Organisation Fields", { exact: true });
  if (!(await organizationHeading.isVisible().catch(() => false))) {
    await page.getByTestId("button-toggle-actions-0").click();
  }
  await expect(organizationHeading).toBeVisible();
  await expect(page.getByText("Create Member Record", { exact: true })).toBeVisible();
  await expect(page.getByText("Update Member Fields", { exact: true })).toBeVisible();
}

test("mounted member mapping editor adds, edits, reorders, disables, and reloads without changing org/create actions", async ({ page }, testInfo) => {
  const state = await installDueDiligenceConfigFixture(page);
  await page.goto(`/DueDiligenceConfig?formId=${FORM_ID}`);

  await expect(page.getByText("Due Diligence Configuration", { exact: true })).toBeVisible();
  const cookieBanner = page.getByTestId("banner-cookie-consent");
  if (await cookieBanner.isVisible().catch(() => false)) {
    await cookieBanner.getByRole("button", { name: "Accept", exact: true }).click();
  }
  await openActions(page);

  await page.getByTestId("button-add-member-field-mapping-0").click();
  await page.getByTestId("button-add-member-mapping-row-0").click();
  await expect(page.getByTestId("member-field-mapping-row-0")).toBeVisible();

  // Row 0: a reviewed form value mapped to the safe member first-name core field.
  await page.getByTestId("select-member-source-field-0").click();
  await page.getByRole("option", { name: "First name", exact: true }).click();
  await page.getByTestId("select-member-target-type-0").click();
  await page.getByRole("option", { name: "Custom field", exact: true }).click();
  await page.getByTestId("select-member-custom-target-0").click();
  await expect(page.getByRole("option", { name: "Member segment", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Inactive member field", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Organization only", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Unsupported member field", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("select-member-target-type-0").click();
  await page.getByRole("option", { name: "Core field", exact: true }).click();
  await page.getByTestId("select-member-core-target-0").click();
  await expect(page.getByRole("option", { name: "Job title", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Mobile", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Email", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Organization ID", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "First name", exact: true }).click();

  await page.getByTestId("button-add-member-mapping-row-0").click();
  await expect(page.getByTestId("member-field-mapping-row-1")).toBeVisible();

  // Row 1: a static value mapped to last name, then reorder it before row 0.
  await page.getByTestId("select-member-source-type-1").click();
  await page.getByRole("option", { name: "Static value", exact: true }).click();
  await page.getByTestId("select-member-target-type-1").click();
  await page.getByRole("option", { name: "Core field", exact: true }).click();
  await page.getByTestId("select-member-core-target-1").click();
  await page.getByRole("option", { name: "Last name", exact: true }).click();
  await page.getByTestId("input-member-static-value-1").fill("Updated by review");
  await page.getByTestId("button-move-member-mapping-down-0").click();

  await page.getByTestId("button-confirm-member-field-mapping-0").click();
  await expect.poll(() => state.writes.filter(write => write.method === "POST")).toHaveLength(1);
  const addWrite = state.writes.find(write => write.method === "POST");
  expect(addWrite.body).toEqual(expect.objectContaining({
    due_diligence_stage_id: STAGE_ID,
    target_entity: "member",
  }));
  expect(addWrite.body.field_mappings[1].source_type).toBe("form_field");
  expect(addWrite.body.field_mappings.map(mapping => mapping.target_field)).toEqual(["last_name", "first_name"]);

  await openActions(page);
  const memberAction = page.getByTestId(`member-field-mapping-action-${MEMBER_MAPPING_ID}`);
  await expect(memberAction).toBeVisible();
  await memberAction.getByTestId(`button-edit-member-field-mapping-${MEMBER_MAPPING_ID}`).click();
  await page.getByTestId("input-member-static-value-0").fill("Edited after add");
  await page.getByTestId("select-member-target-type-1").click();
  await page.getByRole("option", { name: "Custom field", exact: true }).click();
  await page.getByTestId("select-member-custom-target-1").click();
  await page.getByRole("option", { name: "Member segment", exact: true }).click();
  await page.getByTestId("button-confirm-member-field-mapping-0").click();
  await expect.poll(() => state.writes.filter(write => write.method === "PUT")).toHaveLength(1);
  const editWrite = state.writes.find(write => write.method === "PUT");
  expect(editWrite.body).toEqual(expect.objectContaining({ target_entity: "member" }));
  expect(editWrite.body.field_mappings[0].static_value).toBe("Edited after add");
  expect(editWrite.body.field_mappings[1].target_field).toBe(MEMBER_FIELD_ID);

  await openActions(page);
  await memberAction.getByTestId(`switch-toggle-member-field-mapping-${MEMBER_MAPPING_ID}`).click();
  await expect.poll(() => state.writes.filter(write => (
    write.method === "PUT" && write.body.is_active === false
  ))).toHaveLength(1);

  await page.reload();
  await openActions(page);
  await expect(page.getByTestId(`member-field-mapping-action-${MEMBER_MAPPING_ID}`)).toContainText("Disabled");
  await memberAction.getByTestId(`button-edit-member-field-mapping-${MEMBER_MAPPING_ID}`).click();
  await expect(page.getByTestId("select-member-custom-target-1")).toContainText("Member segment");
  expect(state.fieldActions.find(action => action.id === MEMBER_MAPPING_ID).field_mappings)
    .toEqual(editWrite.body.field_mappings);
  await expect(page.getByText("Update Organisation Fields", { exact: true })).toBeVisible();
  await expect(page.getByText("Create Member Record", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("task-4423-linked-member-mapping.png"),
    fullPage: true,
  });

  const preservedOrganizationAction = state.fieldActions.find(action => action.id === ORGANIZATION_MAPPING_ID);
  expect(preservedOrganizationAction).toBeDefined();
  expect(preservedOrganizationAction.target_entity).toBeUndefined();
  expect(state.fieldActions).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: MEMBER_MAPPING_ID,
      target_entity: "member",
      is_active: false,
    }),
  ]));
  expect(state.memberActions).toEqual([
    expect.objectContaining({
      id: MEMBER_ACTION_ID,
      is_active: true,
    }),
  ]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("preserves member mapping draft and shows server error when save fails", async ({ page }) => {
  const state = await installDueDiligenceConfigFixture(page, { failMemberMappingSave: true });
  await page.goto(`/DueDiligenceConfig?formId=${FORM_ID}`);

  await expect(page.getByText("Due Diligence Configuration", { exact: true })).toBeVisible();
  const cookieBanner = page.getByTestId("banner-cookie-consent");
  if (await cookieBanner.isVisible().catch(() => false)) {
    await cookieBanner.getByRole("button", { name: "Accept", exact: true }).click();
  }
  await openActions(page);

  await page.getByTestId("button-add-member-field-mapping-0").click();
  await page.getByTestId("button-add-member-mapping-row-0").click();
  await page.getByTestId("select-member-source-field-0").click();
  await page.getByRole("option", { name: "First name", exact: true }).click();
  await page.getByTestId("select-member-target-type-0").click();
  await page.getByRole("option", { name: "Core field", exact: true }).click();
  await page.getByTestId("select-member-core-target-0").click();
  await page.getByRole("option", { name: "First name", exact: true }).click();
  await page.getByTestId("button-confirm-member-field-mapping-0").click();

  await expect(page.getByText("Member mapping rejected by fixture: source field unavailable", { exact: true })).toBeVisible();
  await expect(page.getByTestId("button-confirm-member-field-mapping-0")).toBeVisible();
  await expect(page.getByTestId("select-member-core-target-0")).toContainText("First name");
  expect(state.writes).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("preserves edited member mapping draft when update fails", async ({ page }) => {
  const state = await installDueDiligenceConfigFixture(page, { failMemberMappingSave: true });
  state.fieldActions.push({
    id: MEMBER_MAPPING_ID,
    due_diligence_stage_id: STAGE_ID,
    target_entity: "member",
    field_mappings: [{
      source_type: "static",
      source_field_id: "",
      static_value: "Original value",
      target_type: "core",
      target_field: "last_name",
      transformation: "none",
    }],
    is_active: true,
  });
  await page.goto(`/DueDiligenceConfig?formId=${FORM_ID}`);

  await expect(page.getByText("Due Diligence Configuration", { exact: true })).toBeVisible();
  const cookieBanner = page.getByTestId("banner-cookie-consent");
  if (await cookieBanner.isVisible().catch(() => false)) {
    await cookieBanner.getByRole("button", { name: "Accept", exact: true }).click();
  }
  await openActions(page);

  const memberAction = page.getByTestId(`member-field-mapping-action-${MEMBER_MAPPING_ID}`);
  await memberAction.getByTestId(`button-edit-member-field-mapping-${MEMBER_MAPPING_ID}`).click();
  await page.getByTestId("input-member-static-value-0").fill("Edited but rejected");
  await page.getByTestId("button-confirm-member-field-mapping-0").click();

  await expect(page.getByText("Member mapping rejected by fixture: source field unavailable", { exact: true })).toBeVisible();
  await expect(page.getByTestId("button-confirm-member-field-mapping-0")).toBeVisible();
  await expect(page.getByTestId("input-member-static-value-0")).toHaveValue("Edited but rejected");
  expect(state.fieldActions.find(action => action.id === MEMBER_MAPPING_ID).field_mappings[0].static_value)
    .toBe("Original value");
  expect(state.writes).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

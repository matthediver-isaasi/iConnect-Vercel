import { test, expect } from "@playwright/test";

const formId = "member-organisation-group-form";
const formSlug = "member-organisation-group-browser-regression";
const groupId = "organisation-group-1";
const memberId = "member-without-organisation";

const group = {
  id: groupId,
  name: "Community Organisations",
  description: "Browser fixture group",
};

const groupField = {
  id: "organisation-group-field",
  type: "organisation_group_dropdown",
  label: "Application group",
  required: false,
  options: [],
};

const emailField = {
  id: "member-email-field",
  type: "email",
  label: "Email",
  required: true,
  options: [],
};

const browserUser = {
  id: "member-group-browser-user",
  tenant_id: "member-group-browser-tenant",
  organization_id: "member-group-browser-org",
  role_id: "member-group-browser-role",
  email: "admin@example.invalid",
  first_name: "Group",
  last_name: "Tester",
  member_excluded_features: [],
  is_team_member: true,
};

const adminRole = {
  id: browserUser.role_id,
  name: "Administrator",
  excluded_features: [],
};

function makeForm() {
  return {
    id: formId,
    tenant_id: browserUser.tenant_id,
    name: "Member Organisation Group browser regression",
    slug: formSlug,
    description: "Mocked form for the member group mapping editor",
    form_type: "standard",
    layout_type: "standard",
    submit_button_text: "Submit",
    success_message: "Submitted",
    is_active: true,
    access_level: "public",
    application_level: "member",
    is_application_form: true,
    fields: [emailField, groupField],
    pages: [],
    logic_rules: [],
    conditional_actions: [],
    field_mappings: [],
    structured_actions: { version: 1, actions: [] },
    entity_pipelines: {
      members: [{
        id: "primary-member",
        label: "Primary member",
        isPrimary: true,
        mappings: [{
          id: "member-email-mapping",
          source_type: "field",
          source_field_id: emailField.id,
          target_type: "core",
          target_entity: "member",
          target_field: "email",
          transformation: "none",
        }, {
          id: "member-group-mapping",
          source_type: "field",
          source_field_id: "",
          target_type: "core",
          target_entity: "member",
          target_field: "organization_group_id",
          transformation: "none",
        }],
      }],
      organisations: [],
    },
  };
}

function memberFixture() {
  return {
    id: memberId,
    tenant_id: browserUser.tenant_id,
    organization_id: null,
    organization_group_id: groupId,
    role_id: browserUser.role_id,
    email: "stored-group-member@example.invalid",
    first_name: "Stored",
    last_name: "Group Member",
    login_enabled: true,
    show_in_directory: true,
    member_excluded_features: [],
  };
}

async function installMocks(page, state) {
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") return json(route, browserUser);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: browserUser, tenant: { id: browserUser.tenant_id } });
    }

    if (path === "/api/entities/Form" && method === "GET") return json(route, [state.form]);
    if (path === `/api/entities/Form/${formId}` && method === "PATCH") {
      const patch = request.postDataJSON();
      state.form = { ...state.form, ...patch };
      state.formWrites.push(patch);
      return json(route, state.form);
    }
    if (path === `/api/entities/Member/${memberId}`) return json(route, memberFixture());
    if (path === "/api/entities/Member") return json(route, [memberFixture()]);
    if (path === "/api/entities/OrganizationGroup") return json(route, [group]);
    if (path === "/api/entities/Role") return json(route, [adminRole]);
    if (path === `/api/entities/Role/${browserUser.role_id}`) return json(route, adminRole);
    if (path === "/api/entities/PreferenceField") return json(route, []);
    if (path === "/api/admin/organizations/paginated") {
      return json(route, {
        organizations: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    }
    if (path === "/api/public/resource-categories") return json(route, []);
    if (path === "/api/admin/integrations") return json(route, { integrations: [] });
    if (path === "/api/custom-objects/core/relationship-definitions") {
      return json(route, { data: [], total: 0 });
    }
    if (path === "/api/custom-objects") return json(route, { data: [] });
    if (path === `/api/public/form/${formSlug}` && method === "GET") return json(route, state.form);
    if (path === "/api/public/organisation-groups" && method === "POST") return json(route, [group]);
    if (path === "/api/public/form-submission" && method === "POST") {
      state.submissions.push(request.postDataJSON());
      return json(route, { id: "member-group-browser-submission" });
    }
    if (path === "/api/forms/send-submission-email" && method === "POST") {
      return json(route, { success: true });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
}

async function selectRadixOption(page, triggerTestId, optionName) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test("builder saves, reloads, and keeps Organisation Group dropdown IDs", async ({ page }) => {
  const state = {
    form: makeForm(),
    formWrites: [],
    escapedWrites: [],
  };
  await installMocks(page, state);

  await page.goto(`/FormBuilder?formId=${formId}`);
  await page.getByTestId("tab-submission").click();
  await expect(page.getByTestId("member-pipeline-0")).toBeVisible();
  await expect(page.getByTestId("member-organization-group-guidance-1")).toContainText(
    "persisted Organisation Group ID",
  );

  await selectRadixOption(page, "select-source-1", groupField.label);
  await page.getByRole("button", { name: "Save Form", exact: true }).first().click();
  await expect.poll(() => state.formWrites.length).toBe(1);

  const savedMemberMappings = state.formWrites[0].entity_pipelines.members[0].mappings;
  expect(savedMemberMappings).toContainEqual(expect.objectContaining({
    source_field_id: groupField.id,
    target_type: "core",
    target_field: "organization_group_id",
  }));
  expect(savedMemberMappings).not.toContainEqual(expect.objectContaining({
    target_field: "organization_group_id",
    static_value: group.name,
  }));

  await page.reload();
  await page.getByTestId("tab-submission").click();
  await expect(page.getByTestId("select-source-1")).toContainText(groupField.label);
  await expect(page.getByTestId("select-target-field-1")).toContainText("Organisation Group");
});

test("member detail reload renders the stored Organisation Group", async ({ page }) => {
  const state = {
    form: makeForm(),
    formWrites: [],
    escapedWrites: [],
  };
  await installMocks(page, state);

  await page.goto(`/members/${memberId}`);
  await expect(page.getByText("Stored Group Member", { exact: true })).toBeVisible();
  await expect(page.getByText(group.name, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText(group.name, { exact: true })).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
});

test("FormView stores the selected Organisation Group ID", async ({ page }) => {
  const state = {
    form: makeForm(),
    formWrites: [],
    submissions: [],
    escapedWrites: [],
  };
  await installMocks(page, state);

  await page.goto(`/FormView?slug=${formSlug}`);
  const groupSelect = page.getByTestId(`select-organisation-group-${groupField.id}`);
  await expect(groupSelect).toBeVisible();
  await selectRadixOption(page, `select-organisation-group-${groupField.id}`, group.name);
  await expect(groupSelect).toContainText(group.name);
  await page.getByTestId(`input-email-${emailField.id}`).fill("form-view-group@example.invalid");
  await page.getByRole("button", { name: "Submit", exact: true }).click();

  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data[groupField.id]).toBe(groupId);
  await expect(page.getByText("Submitted", { exact: true })).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
});
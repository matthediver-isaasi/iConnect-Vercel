import { test, expect } from "@playwright/test";

// Real FormBuilder/FormView routes, with the same in-memory route-mock pattern
// as member-organisation-group.spec.mjs. No server or tenant writes are allowed.
const FORM_ID = "49120000-0000-4000-8000-000000000001";
const FORM_SLUG = "group-initial-selection-browser-regression";
const GROUP_FIELD_ID = "initial-group";
const ORG_FIELD_ID = "dependent-organisation";
const EMAIL_FIELD_ID = "initial-selection-email";
const UNKNOWN_GROUP_ID = "49120000-0000-4000-8000-000000000099";
const groups = [
  { id: "49120000-0000-4000-8000-000000000011", name: "North Community Group" },
  { id: "49120000-0000-4000-8000-000000000012", name: "South Community Group" },
  { id: "49120000-0000-4000-8000-000000000013", name: "Excluded Community Group" },
];
const allowedGroups = groups.slice(0, 2);
const organisations = [
  { id: "49120000-0000-4000-8000-000000000021", name: "North Community Organisation", organization_group_id: groups[0].id },
  { id: "49120000-0000-4000-8000-000000000022", name: "South Community Organisation", organization_group_id: groups[1].id },
  { id: "49120000-0000-4000-8000-000000000023", name: "Excluded Community Organisation", organization_group_id: groups[2].id },
];
const user = {
  id: "49120000-0000-4000-8000-000000000031",
  tenant_id: "49120000-0000-4000-8000-000000000032",
  organization_id: "49120000-0000-4000-8000-000000000033",
  role_id: "49120000-0000-4000-8000-000000000034",
  email: "group-initial-selection@example.invalid",
  first_name: "Initial",
  last_name: "Selection",
  member_excluded_features: [],
  is_team_member: true,
};
const role = { id: user.role_id, name: "Administrator", excluded_features: [] };
const states = new WeakMap();

function formFixture(initialSelection) {
  const groupField = {
    id: GROUP_FIELD_ID,
    type: "organisation_group_dropdown",
    label: "Application group",
    required: false,
    options: [],
    ...(initialSelection === undefined ? {} : { group_initial_selection: initialSelection }),
  };
  return {
    id: FORM_ID,
    tenant_id: user.tenant_id,
    name: "Group initial selection regression",
    slug: FORM_SLUG,
    description: "Isolated Group initial selection fixture",
    form_type: "standard",
    layout_type: "standard",
    access_level: "public",
    is_active: true,
    blank_layout: true,
    require_authentication: false,
    prefill_source: "none",
    allow_save_continue_later: false,
    submit_button_text: "Submit fixture",
    success_message: "Group selection fixture submitted.",
    fields: [
      groupField,
      {
        id: ORG_FIELD_ID,
        type: "organisation_dropdown",
        label: "Application organisation",
        required: false,
        options: [],
        organisation_group_parent_field_id: GROUP_FIELD_ID,
      },
      { id: EMAIL_FIELD_ID, type: "email", label: "Email", required: true, options: [] },
    ],
    pages: [],
    logic_rules: [],
    conditional_actions: [],
    field_mappings: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
  };
}

async function installMocks(page, initialSelection, { deferGroupOptions = false } = {}) {
  const state = {
    form: formFixture(initialSelection),
    formWrites: [],
    submissionCountWrites: [],
    submissions: [],
    groupRequests: [],
    organisationRequests: [],
    blockedRequests: [],
    pageErrors: [],
  };
  states.set(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("cookie-consent", "declined");
  });
  page.on("pageerror", error => state.pageErrors.push(error.message));
  let releaseGroups;
  const groupGate = new Promise(resolve => { releaseGroups = resolve; });
  state.releaseGroups = releaseGroups;
  if (!deferGroupOptions) releaseGroups();

  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const previewOrigin = new URL(test.info().project.use.baseURL).origin;

  // Catch all requests, not just /api/. This also blocks direct Supabase
  // mutations, external services and unknown writes before they hit a server.
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const readOnly = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (path.startsWith("/rest/v1/")) {
      if (!readOnly) state.blockedRequests.push(`${method} ${path}`);
      return json(route, readOnly ? [] : { error: "Direct database writes are forbidden" }, readOnly ? 200 : 599);
    }
    if (url.origin !== previewOrigin) {
      // Fonts, analytics scripts and branding assets are intentionally not
      // loaded. Their read-only requests are not application mutations.
      if (!readOnly || path.startsWith("/api/")) {
        state.blockedRequests.push(`${method} ${url.origin}${path}`);
      }
      return route.abort("blockedbyclient");
    }
    if (!path.startsWith("/api/")) {
      if (readOnly) return route.continue();
      state.blockedRequests.push(`${method} ${path}`);
      return json(route, { error: "Unmocked mutation is forbidden" }, 599);
    }

    if (path === "/api/auth/me" && method === "GET") return json(route, user);
    if (path === "/api/auth/tenant-user-me" && method === "GET") {
      return json(route, { user, tenant: { id: user.tenant_id } });
    }
    if (path === "/api/entities/Role" && method === "GET") return json(route, [role]);
    if (path === `/api/entities/Role/${role.id}` && method === "GET") return json(route, role);
    if (path === "/api/entities/OrganizationGroup" && method === "GET") return json(route, groups);
    if (path === "/api/entities/Organization" && method === "GET") return json(route, organisations);
    if (path === "/api/entities/Form" && method === "GET") return json(route, [state.form]);
    if (path === `/api/entities/Form/${FORM_ID}` && method === "GET") return json(route, state.form);
    if (path === `/api/entities/Form/${FORM_ID}` && method === "PATCH") {
      const patch = request.postDataJSON();
      // FormView's existing submission-count bookkeeping is also local.
      // Keep it separate so runtime tests detect configuration mutations.
      if (Object.keys(patch).length === 1 && "submission_count" in patch) {
        state.submissionCountWrites.push(patch);
      } else {
        state.formWrites.push(patch);
      }
      state.form = { ...state.form, ...patch };
      return json(route, state.form);
    }
    if (path === `/api/public/form/${FORM_SLUG}` && method === "GET") return json(route, state.form);
    if (path === "/api/public/organisation-groups" && method === "POST") {
      state.groupRequests.push(request.postDataJSON());
      await groupGate;
      // Public persisted-field options are authoritative. The third group
      // exists in the builder's tenant list but is unavailable to this field.
      return json(route, allowedGroups);
    }
    if (path === "/api/public/organisations" && method === "POST") {
      const payload = request.postDataJSON();
      state.organisationRequests.push(payload);
      if (payload.fieldId !== ORG_FIELD_ID) {
        state.blockedRequests.push(`Unexpected organisation field ${payload.fieldId}`);
        return json(route, { error: "Unexpected organisation field" }, 599);
      }
      const selectedGroup = payload.sourceAnswers?.[GROUP_FIELD_ID];
      return json(route, allowedGroups.some(group => group.id === selectedGroup)
        ? organisations.filter(org => org.organization_group_id === selectedGroup)
        : []);
    }
    if (path === "/api/public/form-submission" && method === "POST") {
      state.submissions.push(request.postDataJSON());
      return json(route, { id: "group-initial-selection-submission" });
    }
    if (path === "/api/forms/send-submission-email" && method === "POST") {
      return json(route, { success: true });
    }
    if (path === "/api/admin/integrations" && method === "GET") return json(route, { integrations: [] });
    if (path === "/api/custom-objects/core/relationship-definitions" && method === "GET") {
      return json(route, { data: [], total: 0 });
    }
    if (path === "/api/custom-objects" && method === "GET") return json(route, { data: [] });
    if (!readOnly) {
      state.blockedRequests.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

test.afterEach(async ({ page }) => {
  const state = states.get(page);
  if (!state) return;
  // Release any deferred route even when an assertion fails.
  state.releaseGroups();
  expect(state.blockedRequests, "No unmocked requests or live writes").toEqual([]);
  expect(state.pageErrors, "Real components must render without uncaught exceptions").toEqual([]);
});

async function selectOption(page, testId, name) {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name, exact: true }).click();
}

const groupSelect = page => page.getByTestId(`select-organisation-group-${GROUP_FIELD_ID}`);
const organisationSelect = page => page.getByTestId(`select-organisation-${ORG_FIELD_ID}`);

async function openForm(page, groupId) {
  const params = new URLSearchParams({ slug: FORM_SLUG });
  if (groupId !== undefined) params.set("group_id", groupId);
  await page.goto(`/FormView?${params}`);
}

async function submit(page, state) {
  await page.getByTestId(`input-email-${EMAIL_FIELD_ID}`).fill("respondent@example.invalid");
  await page.getByRole("button", { name: "Submit fixture", exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  await expect(page.getByText(state.form.success_message, { exact: true })).toBeVisible();
  return state.submissions[0].submission_data;
}

async function assertGroupOptions(page) {
  await groupSelect(page).click();
  await expect(page.getByRole("option")).toHaveCount(allowedGroups.length);
  for (const group of allowedGroups) {
    await expect(page.getByRole("option", { name: group.name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("option", { name: groups[2].name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function assertOrganisationOptions(page, state, group) {
  await expect.poll(() => state.organisationRequests.some(
    payload => payload.sourceAnswers?.[GROUP_FIELD_ID] === group.id,
  )).toBe(true);
  await expect(organisationSelect(page)).toBeVisible();
  await organisationSelect(page).click();
  const expected = organisations.filter(org => org.organization_group_id === group.id);
  await expect(page.getByRole("option")).toHaveCount(expected.length);
  for (const org of organisations) {
    await expect(page.getByRole("option", { name: org.name, exact: true })).toHaveCount(
      org.organization_group_id === group.id ? 1 : 0,
    );
  }
  await page.keyboard.press("Escape");
}

for (const choice of [
  { mode: "specific", label: "Specific group", saved: { mode: "specific", group_id: groups[0].id } },
  { mode: "url", label: "From URL parameter", saved: { mode: "url" } },
  { mode: "none", label: "None", saved: { mode: "none" } },
]) {
  test(`builder: ${choice.label} persists on save/reopen without stray group IDs`, async ({ page }) => {
    // Start non-specific modes from a saved specific choice to exercise
    // removal of group_id; start specific from None to exercise the picker.
    const initial = choice.mode === "specific" ? { mode: "none" } : { mode: "specific", group_id: groups[1].id };
    const state = await installMocks(page, initial);
    await page.goto(`/FormBuilder?formId=${FORM_ID}`);
    await page.getByTestId(`button-configure-field-${GROUP_FIELD_ID}`).click();
    const modeId = `select-group-initial-selection-mode-${GROUP_FIELD_ID}`;
    const pickerId = `select-group-initial-selection-group-${GROUP_FIELD_ID}`;
    await page.getByTestId(modeId).click();
    for (const label of ["None", "Specific group", "From URL parameter"]) {
      await expect(page.getByRole("option", { name: label, exact: true })).toBeVisible();
    }
    await page.getByRole("option", { name: choice.label, exact: true }).click();
    if (choice.mode === "specific") {
      await selectOption(page, pickerId, groups[0].name);
      await expect(page.getByTestId(pickerId)).toContainText(groups[0].name);
      await page.screenshot({
        path: "tests/fixtures/group-initial-selection-builder.png",
        fullPage: true,
        animations: "disabled",
      });
    } else {
      await expect(page.getByTestId(pickerId)).toHaveCount(0);
      if (choice.mode === "url") {
        await expect(page.getByTestId(`group-initial-selection-config-${GROUP_FIELD_ID}`)).toContainText("group_id");
      }
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save Form", exact: true }).first().click();
    await expect.poll(() => state.formWrites.length).toBe(1);
    expect(state.formWrites[0].fields.find(field => field.id === GROUP_FIELD_ID).group_initial_selection).toEqual(choice.saved);

    await page.reload();
    await page.getByTestId(`button-configure-field-${GROUP_FIELD_ID}`).click();
    await expect(page.getByTestId(modeId)).toContainText(choice.label);
    if (choice.mode === "specific") {
      await expect(page.getByTestId(pickerId)).toContainText(groups[0].name);
    } else {
      await expect(page.getByTestId(pickerId)).toHaveCount(0);
    }

    // The saved payload is also consumed by the real respondent component.
    await openForm(page, groups[1].id);
    await expect(groupSelect(page)).toBeVisible();
    if (choice.mode === "none") {
      await expect(groupSelect(page)).toHaveText("Select an organisation group");
    } else {
      await expect(groupSelect(page)).toContainText(choice.mode === "specific" ? groups[0].name : groups[1].name);
    }
  });
}

for (const mode of ["specific", "url"]) {
  test(`FormView: ${mode} initial selection waits for allowed options, filters organisations, and remains editable`, async ({ page }) => {
    const initial = mode === "specific" ? { mode, group_id: groups[0].id } : { mode };
    const state = await installMocks(page, initial, { deferGroupOptions: true });
    await openForm(page, mode === "url" ? groups[0].id : groups[1].id);
    await expect.poll(() => state.groupRequests.length).toBeGreaterThan(0);
    state.releaseGroups();
    await expect(groupSelect(page)).toContainText(groups[0].name);
    await assertGroupOptions(page);
    await assertOrganisationOptions(page, state, groups[0]);
    if (mode === "specific") {
      await organisationSelect(page).click();
      await page.screenshot({
        path: "tests/fixtures/group-initial-selection-formview.png",
        fullPage: true,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
    }
    await selectOption(page, `select-organisation-${ORG_FIELD_ID}`, organisations[0].name);
    await expect(organisationSelect(page)).toContainText(organisations[0].name);

    // Changing the group must not reapply the initial value or leave an
    // organisation from the old group selected.
    await selectOption(page, `select-organisation-group-${GROUP_FIELD_ID}`, groups[1].name);
    await expect(groupSelect(page)).toContainText(groups[1].name);
    await assertOrganisationOptions(page, state, groups[1]);
    await expect(organisationSelect(page)).toHaveText("Select an organisation");
    await selectOption(page, `select-organisation-${ORG_FIELD_ID}`, organisations[1].name);
    const data = await submit(page, state);
    expect(data[GROUP_FIELD_ID]).toBe(groups[1].id);
    expect(data[ORG_FIELD_ID]).toBe(organisations[1].id);
    expect(state.formWrites).toEqual([]);
    expect(state.groupRequests[0]).toEqual(expect.objectContaining({ fieldId: GROUP_FIELD_ID }));
  });
}

for (const initial of [undefined, { mode: "none" }]) {
  test(`FormView: ${initial ? "explicit None" : "legacy unset"} ignores group_id and leaves downstream unavailable until manual selection`, async ({ page }) => {
    const state = await installMocks(page, initial);
    await openForm(page, groups[0].id);
    await expect(groupSelect(page)).toHaveText("Select an organisation group");
    await assertGroupOptions(page);
    await expect(organisationSelect(page)).toHaveCount(0);
    await expect(page.getByText("No organisations are available.", { exact: true })).toBeVisible();
    expect(state.organisationRequests.some(payload => payload.sourceAnswers?.[GROUP_FIELD_ID])).toBe(false);

    await selectOption(page, `select-organisation-group-${GROUP_FIELD_ID}`, groups[1].name);
    await assertOrganisationOptions(page, state, groups[1]);
    await selectOption(page, `select-organisation-${ORG_FIELD_ID}`, organisations[1].name);
    const data = await submit(page, state);
    expect(data[GROUP_FIELD_ID]).toBe(groups[1].id);
    expect(data[ORG_FIELD_ID]).toBe(organisations[1].id);
  });
}

for (const candidate of [
  { name: "missing parameter", value: undefined },
  { name: "empty parameter", value: "" },
  { name: "malformed group ID", value: "not-a-group-uuid" },
  { name: "unknown valid UUID", value: UNKNOWN_GROUP_ID },
  { name: "existing but unavailable group", value: groups[2].id },
]) {
  test(`FormView: URL initial selection rejects ${candidate.name}`, async ({ page }) => {
    const state = await installMocks(page, { mode: "url" });
    await openForm(page, candidate.value);
    await expect(groupSelect(page)).toHaveText("Select an organisation group");
    await assertGroupOptions(page);
    await expect(organisationSelect(page)).toHaveCount(0);
    await expect(page.getByText("No organisations are available.", { exact: true })).toBeVisible();
    const data = await submit(page, state);
    expect([undefined, null, ""]).toContain(data[GROUP_FIELD_ID]);
    expect([undefined, null, ""]).toContain(data[ORG_FIELD_ID]);
    expect(state.organisationRequests.some(payload => payload.sourceAnswers?.[GROUP_FIELD_ID])).toBe(false);
    expect(state.formWrites).toEqual([]);
  });
}

for (const candidate of [
  { name: "unknown UUID", value: UNKNOWN_GROUP_ID },
  { name: "unavailable group", value: groups[2].id },
]) {
  test(`FormView: specific initial selection rejects ${candidate.name} rather than using the URL`, async ({ page }) => {
    const state = await installMocks(page, { mode: "specific", group_id: candidate.value });
    await openForm(page, groups[0].id);
    await expect(groupSelect(page)).toHaveText("Select an organisation group");
    await assertGroupOptions(page);
    await expect(organisationSelect(page)).toHaveCount(0);
    const data = await submit(page, state);
    expect([undefined, null, ""]).toContain(data[GROUP_FIELD_ID]);
    expect(state.organisationRequests.some(payload => payload.sourceAnswers?.[GROUP_FIELD_ID])).toBe(false);
  });
}
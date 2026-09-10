import { test, expect } from "@playwright/test";

const sourceKey =
  "object-field:11111111-1111-4111-8111-111111111111:source:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333";
const source = {
  key: sourceKey,
  label: "Accreditations",
  object_id: "22222222-2222-4222-8222-222222222222",
  field_id: "33333333-3333-4333-8333-333333333333",
  relationship_id: "11111111-1111-4111-8111-111111111111",
  direction: "source",
  field: {
    id: "33333333-3333-4333-8333-333333333333",
    label: "Accreditation status",
    field_type: "text",
  },
};
const member = {
  id: "smoke-member",
  tenant_id: "smoke-tenant",
  organization_id: "smoke-org",
  role_id: "smoke-role",
  email: "browser-smoke@example.invalid",
  first_name: "Browser",
  last_name: "Smoke",
  is_team_member: false,
  member_excluded_features: [],
};
const role = {
  id: "smoke-role",
  name: "Smoke administrator",
  excluded_features: [],
  show_bookmarks: false,
};
const organization = {
  id: "smoke-org",
  name: "Alpha Smoke Org",
  domain: "smoke.invalid",
  logo_url: null,
  member_count: 1,
};
const preferenceField = {
  id: "org-field",
  name: "service_region",
  label: "Service region",
  field_type: "dropdown",
  options: [{ value: "Europe", label: "Europe" }],
  entity_scope: "organization",
  is_active: true,
  is_filterable: true,
  show_in_directory_card: true,
  display_order: 1,
  directory_visibility: {
    ids: ["main", "smoke-directory-id"],
    labels: {},
    display: {
      main: { back: true, order: 1 },
      "smoke-directory-id": { back: true, order: 1 },
    },
  },
};
const standardOrder = [
  "org_member_count",
  "custom:org-field",
  sourceKey,
  "org_members_list",
];
const dynamicOrder = [
  sourceKey,
  "custom:org-field",
  "org_member_count",
  "org_members_list",
];
const directoryFilterFields = [
  {
    key: "org_member_count",
    label: "Member count",
    field_type: "number",
    control: "number",
    options: [],
    multi_select: false,
  },
  {
    key: "custom:org-field",
    label: "Service region",
    field_type: "dropdown",
    control: "choice",
    options: [
      { value: "Europe", label: "Europe" },
      { value: "Americas", label: "Americas" },
    ],
    multi_select: true,
  },
  {
    key: sourceKey,
    label: "Accreditations",
    field_type: "text",
    control: "text",
    options: [],
    multi_select: false,
  },
  {
    key: "fixture:renewal_date",
    label: "Renewal date",
    field_type: "date",
    control: "date",
    options: [],
    multi_select: false,
  },
  {
    key: "fixture:has_contact",
    label: "Has directory contact",
    field_type: "presence",
    control: "presence",
    options: [],
    multi_select: false,
  },
  {
    key: "fixture:hidden",
    label: "Internal fixture field",
    field_type: "text",
    control: "text",
    options: [],
    multi_select: false,
  },
];

function initialFilterOverrides() {
  return {
    ...Object.fromEntries(directoryFilterFields.map(field => [field.key, true])),
    "fixture:hidden": false,
  };
}

function initialSettings() {
  const values = {
    org_directory_header: "Smoke Organisation Directory",
    org_directory_show_logo: "false",
    org_directory_show_title: "true",
    org_directory_show_domains: "true",
    org_directory_show_member_count: "true",
    org_directory_show_name_tooltip: "false",
    org_directory_cards_per_row: "3",
    org_directory_excluded_orgs: "[]",
    org_directory_allowed_application_statuses: "[]",
    org_directory_visible_org_types: "[]",
    org_directory_reverse_card_role_ids: JSON.stringify(["smoke-role"]),
    org_directory_view_members_role_ids: JSON.stringify(["smoke-role"]),
    org_directory_back_field_order: JSON.stringify(standardOrder),
    org_directory_custom_fields_label: "Organisation details",
    org_directory_filterable_back_fields: JSON.stringify(initialFilterOverrides()),
  };
  return Object.entries(values).map(([setting_key, setting_value], index) => ({
    id: `setting-${index}`,
    setting_key,
    setting_value,
  }));
}

async function installFixtures(page, { failFirstValues = false } = {}) {
  const state = {
    settings: initialSettings(),
    dynamicDirectory: {
      id: "smoke-directory-id",
      slug: "smoke-directory",
      name: "Smoke Dynamic Directory",
      entity_type: "organization",
      is_active: true,
      is_public: false,
      filter_field_id: "org-field",
      filter_value: "Europe",
      back_field_order: dynamicOrder,
      selected_filter_fields: [],
      core_field_visibility: {},
    },
    object: {
      id: "smoke-object",
      object_key: "accreditation",
      singular_label: "Accreditation",
      plural_label: "Accreditations",
      description: "Browser smoke fixture",
      status: "active",
      configuration: { views: {} },
    },
    writes: [],
    requests: [],
    directoryPosts: [],
    filterOverrides: initialFilterOverrides(),
    valuesAttempts: 0,
  };
  const customField = {
    id: source.field_id,
    label: "Accreditation status",
    field_key: "accreditation_status",
    field_type: "text",
    is_active: true,
  };
  const relationship = {
    id: source.relationship_id,
    status: "active",
    archived_at: null,
    relationship_key: "organisation_accreditations",
    source_kind: "organization",
    target_kind: "custom_object",
    target_custom_object_id: "smoke-object",
    source_label: "Accreditations",
    target_label: "Organisation",
  };
  await page.context().route("**/rest/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    state.requests.push(`${method} ${url.pathname}${url.search} [mocked Supabase]`);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push({ method, path: url.pathname, escaped: true });
      return route.fulfill({
        status: 599,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unexpected direct data mutation" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/0" },
      body: "[]",
    });
  });
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push(`${method} ${path}${url.search}`);
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me") return json(member);
    if (path === "/api/auth/tenant-user-me") return json({ user: member, tenant: { id: "smoke-tenant" } });
    if (path === "/api/auth/logout") return json({ ok: true });

    if (path === "/api/organisation-directory/custom-object-fields") {
      if (!url.searchParams.has("organization_id")) return json({ sources: [source] });
      state.valuesAttempts += 1;
      if (failFirstValues && state.valuesAttempts === 1) return json({ error: "fixture retry" }, 500);
      const cursor = url.searchParams.get("cursor");
      return json({
        source,
        items: cursor
          ? [{ record_id: "record-3", label: "Record Gamma", value: "Renewal pending" }]
          : [
              { record_id: "record-1", label: "Record Alpha", value: "Approved" },
              { record_id: "record-2", label: "Record Beta", value: "In review" },
            ],
        nextCursor: cursor ? null : "fixture-page-2",
      });
    }
    if (path === "/api/organisation-directory/filters") {
      if (url.searchParams.get("settings") === "true") {
        if (method === "GET") return json({ overrides: state.filterOverrides });
        if (method === "PUT") {
          const { changes } = request.postDataJSON();
          state.filterOverrides = { ...state.filterOverrides, ...changes };
          const persisted = state.settings.find(setting =>
            setting.setting_key === "org_directory_filterable_back_fields"
          );
          persisted.setting_value = JSON.stringify(state.filterOverrides);
          state.writes.push({ method, path: `${path}?settings=true`, body: { changes } });
          return json({ overrides: state.filterOverrides });
        }
      }
      const fields = directoryFilterFields.filter(field => state.filterOverrides[field.key] === true);
      if (method === "GET") return json({ fields });
      if (method === "POST") {
        const body = request.postDataJSON();
        state.directoryPosts.push(body);
        return json({
          organizations: [organization],
          total: 1,
          page: body.page,
          pageSize: body.pageSize,
          fields,
        });
      }
    }

    if (path === "/api/entities/SystemSettings" && method === "GET") return json(state.settings);
    if (path.startsWith("/api/entities/SystemSettings/") && method === "PATCH") {
      const id = decodeURIComponent(path.split("/").pop());
      const patch = request.postDataJSON();
      const row = state.settings.find((item) => item.id === id);
      Object.assign(row, patch);
      state.writes.push({ method, path, body: patch });
      return json(row);
    }
    if (path === "/api/entities/SystemSettings" && method === "POST") {
      const body = request.postDataJSON();
      const row = { id: `setting-${state.settings.length}`, ...body };
      state.settings.push(row);
      state.writes.push({ method, path, body });
      return json(row);
    }

    if (path === "/api/entities/Organization") return json([organization]);
    if (path === "/api/entities/Organization/smoke-org") return json(organization);
    if (path === "/api/entities/Member") return json([member]);
    if (path === "/api/entities/Member/smoke-member") return json(member);
    if (path === "/api/entities/Role") return json([role]);
    if (path === "/api/entities/Role/smoke-role") return json(role);
    if (path === "/api/entities/PreferenceField") return json([preferenceField]);
    if (path === "/api/entities/OrganizationPreferenceValue") {
      return json([{ id: "pref-value", organization_id: "smoke-org", field_id: "org-field", value: "Europe" }]);
    }
    if (path === "/api/entities/DynamicDirectory") {
      return json([state.dynamicDirectory]);
    }
    if (path === "/api/entities/DynamicDirectory/smoke-directory-id" && method === "PATCH") {
      const body = request.postDataJSON();
      state.dynamicDirectory = {
        id: "smoke-directory-id",
        slug: "smoke-directory",
        name: "Smoke Dynamic Directory",
        entity_type: "organization",
        is_active: true,
        filter_field_id: "org-field",
        filter_value: "Europe",
        ...body,
      };
      state.writes.push({ method, path, body });
      return json(state.dynamicDirectory);
    }

    if (path === "/api/custom-objects/smoke-object" && method === "GET") return json(state.object);
    if (path === "/api/custom-objects/smoke-object" && method === "PATCH") {
      const body = request.postDataJSON();
      state.object = {
        ...state.object,
        ...body,
        configuration: { ...(state.object.configuration || {}), ...(body.configuration || {}) },
      };
      state.writes.push({ method, path, body });
      return json(state.object);
    }
    if (path === "/api/custom-objects/smoke-object/fields") {
      return json({ data: [customField], total: 1 });
    }
    if (path === "/api/custom-objects/smoke-object/relationship-definitions") {
      return json({ data: [relationship], total: 1 });
    }
    if (path === "/api/custom-objects/smoke-object/relationship-definition-graph") {
      return json({ nodes: [], edges: [] });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push({ method, path, escaped: true, body: request.postDataJSON?.() });
      return json({ error: `Unexpected mutating request: ${method} ${path}` }, 599);
    }
    return json([]);
  });
  return state;
}

function textTop(page, text) {
  return page.getByRole("dialog").getByText(text, { exact: true }).first()
    .evaluate((element) => element.getBoundingClientRect().top);
}

async function attachNetworkRecord(testInfo, state) {
  await testInfo.attach("mocked-network.json", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ requests: state.requests, writes: state.writes }, null, 2)),
  });
}

test("standard settings save/reload keeps custom object fields interleaved", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.goto("/OrganisationDirectorySettings");
  await expect(page.getByRole("heading", { name: "Organisation Directory Settings" })).toBeVisible();
  const rows = [
    "row-back-order-org_member_count",
    "row-back-order-custom:org-field",
    `row-back-order-${sourceKey}`,
    "row-back-order-org_members_list",
  ];
  for (const id of rows) await expect(page.getByTestId(id)).toBeVisible();
  const tops = await Promise.all(rows.map((id) => page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().top)));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));

  await page.getByTestId("button-save-back-order").click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();
  const orderWrite = state.writes.find((write) => {
    if (!write.path.startsWith("/api/entities/SystemSettings/")) return false;
    const row = state.settings.find((setting) => setting.id === write.path.split("/").pop());
    return row?.setting_key === "org_directory_back_field_order";
  });
  expect(JSON.parse(orderWrite.body.setting_value)).toEqual(standardOrder);

  await page.reload();
  await expect(page.getByTestId(`row-back-order-${sourceKey}`)).toBeVisible();
  const reloadTops = await Promise.all(rows.map((id) => page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().top)));
  expect(reloadTops).toEqual([...reloadTops].sort((a, b) => a - b));
  expect(state.writes.some((write) => write.escaped)).toBeFalsy();
  await attachNetworkRecord(testInfo, state);
});

test("filter settings persist core, custom, and Data Studio toggles without changing field order", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.goto("/OrganisationDirectorySettings");
  await expect(page.getByRole("heading", { name: "Organisation Directory Settings" })).toBeVisible();

  const rows = [
    "row-back-order-org_member_count",
    "row-back-order-custom:org-field",
    `row-back-order-${sourceKey}`,
    "row-back-order-org_members_list",
  ];
  const switches = [
    page.getByRole("switch", { name: "Use Member count as filter" }),
    page.getByRole("switch", { name: "Use Service region as filter" }),
    page.getByRole("switch", { name: "Use Accreditations as filter" }),
  ];
  for (const filterSwitch of switches) {
    await expect(filterSwitch).toBeChecked();
    await filterSwitch.click();
  }
  await page.screenshot({ path: "/tmp/task-4354-settings-filter-toggles.png", fullPage: true });
  const before = await Promise.all(rows.map(id =>
    page.getByTestId(id).evaluate(element => element.getBoundingClientRect().top)
  ));

  await page.getByTestId("button-save-back-order").click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();
  const filterWrite = state.writes.find(write =>
    write.method === "PUT" && write.path === "/api/organisation-directory/filters?settings=true"
  );
  expect(filterWrite.body.changes).toEqual({
    org_member_count: false,
    "custom:org-field": false,
    [sourceKey]: false,
  });

  await page.reload();
  for (const filterSwitch of switches) await expect(filterSwitch).not.toBeChecked();
  const after = await Promise.all(rows.map(id =>
    page.getByTestId(id).evaluate(element => element.getBoundingClientRect().top)
  ));
  expect(before).toEqual([...before].sort((a, b) => a - b));
  expect(after).toEqual([...after].sort((a, b) => a - b));
  expect(JSON.parse(state.settings.find(setting =>
    setting.setting_key === "org_directory_filterable_back_fields"
  ).setting_value)).toMatchObject(filterWrite.body.changes);
  expect(state.writes.some(write => write.escaped)).toBeFalsy();
  await attachNetworkRecord(testInfo, state);
});

test("main directory renders enabled type-specific filters, submits selections, and clears them", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.goto("/OrganisationDirectory");
  await expect(page.getByTestId("card-organisation-smoke-org")).toBeVisible();

  await expect(page.getByTestId("filter-custom:org-field")).toBeVisible();
  await expect(page.getByLabel("Accreditations", { exact: true })).toHaveJSProperty("type", "text");
  await expect(page.getByLabel("Member count", { exact: true })).toHaveAttribute("type", "number");
  await expect(page.getByLabel("Renewal date", { exact: true })).toHaveAttribute("type", "date");
  await expect(page.getByLabel("Has directory contact", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Internal fixture field", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/task-4354-directory-filter-controls.png", fullPage: true });

  await page.getByTestId("filter-custom:org-field").click();
  await page.getByTestId("filter-custom:org-field-option-Europe").click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Member count", { exact: true }).fill("25");
  await page.getByLabel("Renewal date", { exact: true }).fill("2027-06-30");
  await page.getByLabel("Has directory contact", { exact: true }).selectOption("present");
  await page.getByLabel("Accreditations", { exact: true }).fill("approved");

  await expect.poll(() => state.directoryPosts.at(-1)?.filters).toEqual({
    "custom:org-field": { operator: "eq", value: ["Europe"] },
    org_member_count: { operator: "eq", value: "25" },
    "fixture:renewal_date": { operator: "eq", value: "2027-06-30" },
    "fixture:has_contact": { operator: "present", value: true },
    [sourceKey]: { operator: "contains", value: "approved" },
  });

  // Clear while a new text draft is pending: its timer must not restore it.
  await page.getByLabel("Accreditations", { exact: true }).fill("pending draft");
  await page.getByRole("button", { name: "Clear all" }).click();
  await page.waitForTimeout(400);
  await expect(page.getByLabel("Accreditations", { exact: true })).toHaveValue("");
  await expect.poll(() => state.directoryPosts.at(-1)?.filters).toEqual({});
  await expect(page.getByTestId("filter-custom:org-field")).toContainText("All Service region");
  expect(state.writes.some(write => write.escaped)).toBeFalsy();
  await attachNetworkRecord(testInfo, state);
});

test("main directory filters wrap without overlap on a mobile viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await installFixtures(page);
  await page.goto("/OrganisationDirectory");
  await expect(page.getByLabel("Renewal date", { exact: true })).toBeVisible();

  const layout = await page.locator("label", { hasText: "Service region" }).evaluate(label => {
    const container = label.parentElement?.parentElement;
    const groups = [...(container?.children || [])]
      .filter(element => element.querySelector("label"))
      .map(element => element.getBoundingClientRect());
    const overlap = groups.some((a, index) => groups.slice(index + 1).some(b =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    ));
    return {
      overlap,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      groupsInsideViewport: groups.every(rect => rect.left >= 0 && rect.right <= window.innerWidth),
    };
  });
  expect(layout.overlap).toBe(false);
  expect(layout.groupsInsideViewport).toBe(true);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  await expect.poll(() => state.directoryPosts.at(-1)).toMatchObject({
    filters: {},
    page: 1,
    pageSize: 12,
  });
  await attachNetworkRecord(testInfo, state);
});

test("standard directory retries, renders multiple records, and paginates", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { failFirstValues: true });
  await page.goto("/OrganisationDirectory");
  await page.getByTestId("card-organisation-smoke-org").click();
  await expect(page.getByText("Values unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Record Alpha", { exact: true })).toBeVisible();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await expect(page.getByText("Record Beta", { exact: true })).toBeVisible();

  const memberTop = await textTop(page, "1 members");
  const customTop = await textTop(page, "Service region");
  const objectTop = await textTop(page, "Accreditations");
  expect(memberTop).toBeLessThan(customTop);
  expect(customTop).toBeLessThan(objectTop);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Record Gamma", { exact: true })).toBeVisible();
  expect(state.requests.some((item) =>
    item.includes("organization_id=smoke-org")
    && item.includes(`source_key=${encodeURIComponent(sourceKey)}`)
    && item.includes("cursor=fixture-page-2")
  )).toBeTruthy();
  expect(state.writes.some((write) => write.escaped)).toBeFalsy();
  await attachNetworkRecord(testInfo, state);
});

test("dynamic directory uses per-directory interleaving and scoped values", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.goto("/directory/smoke-directory");
  await page.getByTestId("card-organisation-smoke-org").click();
  await expect(page.getByText("Record Alpha", { exact: true })).toBeVisible();
  const objectTop = await textTop(page, "Accreditations");
  const customTop = await textTop(page, "Service region");
  const memberTop = await textTop(page, "1 members");
  expect(objectTop).toBeLessThan(customTop);
  expect(customTop).toBeLessThan(memberTop);
  expect(state.requests.some((item) =>
    item.includes("/api/organisation-directory/custom-object-fields?")
    && item.includes("organization_id=smoke-org")
    && item.includes("directory_id=smoke-directory-id")
    && item.includes(`source_key=${encodeURIComponent(sourceKey)}`)
  )).toBeTruthy();
  expect(state.writes.some((write) => write.escaped)).toBeFalsy();
  await attachNetworkRecord(testInfo, state);
});

test("dynamic directory settings save and reload the object-field override", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.goto("/DynamicDirectoryManagement");
  await page.getByTestId("button-edit-directory-smoke-directory-id").click();
  await expect(page.getByTestId("dialog-title")).toHaveText("Edit Dynamic Directory");
  await expect(page.getByTestId(`row-back-order-${sourceKey}`)).toBeVisible();
  await page.getByTestId("button-submit").click();
  await expect(page.getByText("Dynamic directory updated successfully")).toBeVisible();
  const write = state.writes.find(
    (item) => item.path === "/api/entities/DynamicDirectory/smoke-directory-id" && item.method === "PATCH",
  );
  expect(write.body.back_field_order).toEqual(dynamicOrder);

  await page.reload();
  await page.getByTestId("button-edit-directory-smoke-directory-id").click();
  await expect(page.getByTestId(`row-back-order-${sourceKey}`)).toBeVisible();
  const rows = [
    `row-back-order-${sourceKey}`,
    "row-back-order-custom:org-field",
    "row-back-order-org_member_count",
    "row-back-order-org_members_list",
  ];
  const tops = await Promise.all(rows.map((id) =>
    page.getByTestId(id).evaluate((element) => element.getBoundingClientRect().top)
  ));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
  expect(state.writes.some((item) => item.escaped)).toBeFalsy();
  await attachNetworkRecord(testInfo, state);
});

test("Custom Objects presentation opt-in persists through mocked write and reload", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.goto("/CustomObjectsAdmin/smoke-object#presentation");
  await expect(page.getByRole("heading", { name: "Organisation directories" })).toBeVisible();
  await page.getByRole("switch", { name: "Allow in organisation directories" }).click();
  await page.getByText("Accreditations", { exact: true }).last().click();
  await page.getByText("Accreditation status", { exact: true }).last().click();
  await page.getByRole("button", { name: "Save presentation" }).click();
  await expect(page.getByText("Shared record presentation saved")).toBeVisible();

  const presentationWrite = state.writes.find(
    (write) => write.path === "/api/custom-objects/smoke-object" && write.method === "PATCH",
  );
  expect(presentationWrite.body.configuration.views.organisation_directory).toEqual({
    enabled: true,
    relationships: [{ relationship_id: source.relationship_id, direction: "source" }],
    field_ids: [source.field_id],
  });

  await page.reload();
  await expect(page.getByRole("switch", { name: "Allow in organisation directories" })).toBeChecked();
  const saved = state.object.configuration.views.organisation_directory;
  expect(saved.enabled).toBe(true);
  expect(saved.relationships).toHaveLength(1);
  expect(saved.field_ids).toEqual([source.field_id]);
  expect(state.writes.some((write) => write.escaped)).toBeFalsy();
  await attachNetworkRecord(testInfo, state);
});
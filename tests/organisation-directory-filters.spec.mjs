import { test, expect } from "@playwright/test";
import { createOrganisationDirectoryFilters } from "../api/_lib/organisationDirectoryFilters.js";

const TENANT_ONE = "directory-filter-tenant-one";
const TENANT_TWO = "directory-filter-tenant-two";

const ORGANISATIONS = [
  {
    id: "directory-filter-t1-own",
    tenant_id: TENANT_ONE,
    name: "Tenant One Own Organisation",
    logo_url: null,
  },
  {
    id: "directory-filter-t1-hidden",
    tenant_id: TENANT_ONE,
    name: "Tenant One Hidden Organisation",
    logo_url: null,
  },
  {
    id: "directory-filter-t1-visible",
    tenant_id: TENANT_ONE,
    name: "Tenant One Visible Organisation",
    logo_url: null,
  },
  {
    id: "directory-filter-t2-own",
    tenant_id: TENANT_TWO,
    name: "Tenant Two Own Organisation",
    logo_url: null,
  },
  {
    id: "directory-filter-t2-hidden",
    tenant_id: TENANT_TWO,
    name: "Tenant Two Hidden Organisation",
    logo_url: null,
  },
  {
    id: "directory-filter-t2-visible",
    tenant_id: TENANT_TWO,
    name: "Tenant Two Visible Organisation",
    logo_url: null,
  },
];

const ADMIN_ONE = {
  id: "directory-filter-admin-one",
  tenant_id: TENANT_ONE,
  role_id: "directory-filter-admin-role",
  email: "directory-filter-admin-one@example.invalid",
  first_name: "Tenant",
  last_name: "One Admin",
  member_excluded_features: [],
  is_team_member: true,
  viewer_kind: "administrator",
};

const ADMIN_TWO = {
  id: "directory-filter-admin-two",
  tenant_id: TENANT_TWO,
  role_id: "directory-filter-admin-role",
  email: "directory-filter-admin-two@example.invalid",
  first_name: "Tenant",
  last_name: "Two Admin",
  member_excluded_features: [],
  is_team_member: true,
  viewer_kind: "administrator",
};

const MEMBER_ONE = {
  id: "directory-filter-member-one",
  tenant_id: TENANT_ONE,
  role_id: "directory-filter-member-role",
  organization_id: "directory-filter-t1-own",
  email: "directory-filter-member-one@example.invalid",
  first_name: "Tenant",
  last_name: "One Member",
  member_excluded_features: [],
  is_team_member: false,
  viewer_kind: "member",
};

const ROLE_BY_ID = {
  "directory-filter-admin-role": {
    id: "directory-filter-admin-role",
    name: "Directory administrator",
    excluded_features: [],
  },
  "directory-filter-member-role": {
    id: "directory-filter-member-role",
    name: "Directory member",
    excluded_features: [],
  },
};

const DIRECTORY_SETTINGS = [
  ["org_directory_header", "Regression Organisation Directory"],
  ["org_directory_show_logo", "false"],
  ["org_directory_show_title", "true"],
  ["org_directory_show_domains", "false"],
  ["org_directory_show_member_count", "false"],
  ["org_directory_show_name_tooltip", "false"],
  ["org_directory_cards_per_row", "3"],
  ["org_directory_excluded_orgs", "[]"],
  ["org_directory_allowed_application_statuses", "[]"],
  ["org_directory_visible_org_types", "[]"],
  ["org_directory_reverse_card_role_ids", "[]"],
  ["org_directory_view_members_role_ids", "[]"],
  ["org_directory_back_field_order", JSON.stringify(["org_member_count", "org_members_list"])],
  ["org_directory_custom_fields_label", "Organisation details"],
  ["org_directory_filterable_back_fields", JSON.stringify({
    org_member_count: false,
    org_members_list: false,
  })],
].map(([setting_key, setting_value], index) => ({
  id: `directory-filter-setting-${index}`,
  setting_key,
  setting_value,
  description: "",
}));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * A deliberately small in-memory PostgREST-like query builder. The browser
 * fixture still exercises createOrganisationDirectoryFilters, including its
 * saved setting and tenant/own-organisation policy, instead of duplicating
 * that policy in the route handler.
 */
function createFixtureDatabase() {
  const tables = {
    organization: clone(ORGANISATIONS),
    system_settings: [
      ...DIRECTORY_SETTINGS.flatMap((setting) => [
        { ...clone(setting), tenant_id: TENANT_ONE },
        { ...clone(setting), id: `${setting.id}-two`, tenant_id: TENANT_TWO },
      ]),
    ],
    preference_field: [],
    organization_preference_value: [],
    custom_object_definition: [],
    custom_object_relationship_definition: [],
    custom_object_role_permission: [],
    custom_object_field_role_permission: [],
    dynamic_directory: [],
    member: [],
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.columns = "*";
      this.filters = [];
      this.orders = [];
      this.maxRows = null;
      this.rangeStart = null;
      this.rangeEnd = null;
    }

    select(columns = "*") {
      this.columns = columns;
      return this;
    }

    eq(column, value) {
      this.filters.push(row => row[column] === value);
      return this;
    }

    neq(column, value) {
      this.filters.push(row => row[column] !== value);
      return this;
    }

    in(column, values) {
      const allowed = new Set(values || []);
      this.filters.push(row => allowed.has(row[column]));
      return this;
    }

    is(column, value) {
      this.filters.push(row => value === null
        ? row[column] === null || row[column] === undefined
        : row[column] === value);
      return this;
    }

    not(column, operator, value) {
      if (operator === "is" && value === null) {
        this.filters.push(row => row[column] !== null && row[column] !== undefined);
      } else if (operator === "ilike") {
        const needle = String(value || "").replaceAll("%", "").toLowerCase();
        this.filters.push(row => !String(row[column] || "").toLowerCase().includes(needle));
      }
      return this;
    }

    or(expression) {
      const clauses = String(expression || "").split(",");
      this.filters.push(row => clauses.some(clause => {
        const [column, operator, rawValue] = clause.split(".");
        if (operator === "eq") return String(row[column]) === rawValue;
        if (operator === "neq") return String(row[column]) !== rawValue;
        return true;
      }));
      return this;
    }

    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      return this;
    }

    limit(value) {
      this.maxRows = Number(value);
      return this;
    }

    range(start, end) {
      this.rangeStart = Number(start);
      this.rangeEnd = Number(end);
      return this;
    }

    maybeSingle() {
      return this.execute(true);
    }

    single() {
      return this.execute(true);
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    async execute(single = false) {
      let rows = (tables[this.table] || []).filter(row =>
        this.filters.every(filter => filter(row)));
      for (const { column, ascending } of this.orders) {
        rows = [...rows].sort((left, right) => {
          const comparison = String(left[column] ?? "").localeCompare(
            String(right[column] ?? ""),
          );
          return ascending ? comparison : -comparison;
        });
      }
      if (this.rangeStart !== null) {
        rows = rows.slice(this.rangeStart, this.rangeEnd + 1);
      }
      if (this.maxRows !== null) rows = rows.slice(0, this.maxRows);

      if (this.columns !== "*") {
        const columns = String(this.columns).split(",").map(column => column.trim());
        rows = rows.map(row => Object.fromEntries(
          columns.map(column => [column, row[column]]),
        ));
      } else {
        rows = rows.map(row => clone(row));
      }

      return {
        data: single ? (rows[0] || null) : rows,
        error: null,
      };
    }
  }

  return {
    tables,
    from(table) {
      return new Query(table);
    },
  };
}

function settingsForTenant(db, tenantId) {
  return db.tables.system_settings
    .filter(row => row.tenant_id === tenantId)
    .map(row => clone(row));
}

function settingForTenant(db, tenantId, key) {
  return db.tables.system_settings.find(row =>
    row.tenant_id === tenantId && row.setting_key === key);
}

function viewerContext(viewer) {
  return {
    tenantId: viewer.tenant_id,
    tenantUserId: viewer.is_team_member ? viewer.id : null,
    roleId: viewer.role_id,
    organizationId: viewer.organization_id || null,
  };
}

async function installFixtures(page, { viewer = ADMIN_ONE, excluded = {} } = {}) {
  const db = createFixtureDatabase();
  for (const [tenantId, organizationIds] of Object.entries(excluded)) {
    const setting = settingForTenant(db, tenantId, "org_directory_excluded_orgs");
    setting.setting_value = JSON.stringify(organizationIds);
  }

  const state = {
    viewer,
    db,
    directoryRequests: [],
    writes: [],
    unexpectedMutations: [],
    setViewer(nextViewer) {
      this.viewer = nextViewer;
    },
    setExcluded(tenantId, organizationIds) {
      const setting = settingForTenant(this.db, tenantId, "org_directory_excluded_orgs");
      setting.setting_value = JSON.stringify(organizationIds);
    },
  };

  await page.context().route("**/rest/v1/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": "0-0/0" },
    body: "[]",
  }));

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    const currentViewer = state.viewer;
    const tenantId = currentViewer.tenant_id;

    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (path === "/api/auth/me") return json(currentViewer);
    if (path === "/api/auth/tenant-user-me") {
      return json({ user: currentViewer, tenant: { id: tenantId } });
    }
    if (path === "/api/auth/logout") return json({ ok: true });

    if (path === "/api/organisation-directory/filters") {
      const service = createOrganisationDirectoryFilters({
        db,
        context: viewerContext(currentViewer),
        isAdmin: currentViewer.viewer_kind === "administrator",
      });
      if (url.searchParams.get("settings") === "true") {
        if (method === "GET") {
          return json(await service.metadata({ settings: true }));
        }
        if (method === "PUT") {
          const body = request.postDataJSON();
          const setting = settingForTenant(
            db,
            tenantId,
            "org_directory_filterable_back_fields",
          );
          const current = JSON.parse(setting?.setting_value || "{}");
          const next = { ...current, ...(body.changes || {}) };
          if (setting) setting.setting_value = JSON.stringify(next);
          return json({ overrides: next });
        }
      }
      if (method === "GET") return json(await service.metadata());
      if (method === "POST") {
        const body = request.postDataJSON();
        state.directoryRequests.push({
          viewerId: currentViewer.id,
          tenantId,
          body,
        });
        if (body.action === "options") return json(await service.options(body));
        return json(await service.search(body));
      }
    }

    if (path === "/api/organisation-directory/custom-object-fields") {
      return json({ sources: [] });
    }
    if (path === "/api/organisation-directory/csv-settings") {
      if (method === "GET") return json({ allowCsvDownload: false });
      if (method === "PUT") return json({ allowCsvDownload: false });
    }

    if (path === "/api/entities/SystemSettings") {
      if (method === "GET") return json(settingsForTenant(db, tenantId));
      if (method === "POST") {
        const body = request.postDataJSON();
        const row = {
          id: `directory-filter-created-${db.tables.system_settings.length}`,
          tenant_id: tenantId,
          ...body,
        };
        db.tables.system_settings.push(row);
        state.writes.push({ method, path, body });
        return json(row);
      }
    }
    if (path.startsWith("/api/entities/SystemSettings/")) {
      if (["PATCH", "PUT"].includes(method)) {
        const id = decodeURIComponent(path.split("/").pop());
        const patch = request.postDataJSON();
        const setting = db.tables.system_settings.find(row => row.id === id);
        if (setting) Object.assign(setting, patch);
        state.writes.push({ method, path, body: patch });
        return json(setting || { id, ...patch });
      }
    }

    if (path === "/api/entities/Organization" && method === "GET") {
      // This is the CRM/admin list path. It must receive every tenant
      // organisation, including saved directory exclusions.
      state.crmListRequests = state.crmListRequests || [];
      state.crmListRequests.push({
        query: Object.fromEntries(url.searchParams.entries()),
        tenantId,
      });
      return json(db.tables.organization.filter(row => row.tenant_id === tenantId));
    }
    if (path === "/api/entities/PreferenceField" && method === "GET") return json([]);
    if (path === "/api/entities/Role" && method === "GET") {
      return json(Object.values(ROLE_BY_ID));
    }
    if (path.startsWith("/api/entities/Role/") && method === "GET") {
      const roleId = decodeURIComponent(path.split("/").pop());
      return json(ROLE_BY_ID[roleId] || null);
    }
    if (path === "/api/entities/Member" && method === "GET") {
      // Layout's activity refresh asks for a member by email. Returning no
      // match for that filtered request avoids an incidental mutation.
      return json(url.searchParams.has("filter") ? [] : [currentViewer]);
    }
    if (path.startsWith("/api/entities/Member/") && method === "GET") {
      return json(currentViewer);
    }
    if (path === "/api/entities/OrganizationPreferenceValue" && method === "GET") {
      return json([]);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const mutation = { method, path };
      state.unexpectedMutations.push(mutation);
      return json({ error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json([]);
  });

  return state;
}

async function expectDirectoryCards(page, { visible, hidden }) {
  await expect(page.getByTestId(`card-organisation-${visible.id}`)).toBeVisible();
  await expect(page.getByTestId(`card-organisation-${hidden.id}`)).toHaveCount(0);
}

for (const width of [1440, 390]) {
  test(`mixed-height filters stay top-aligned and clear selections at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await installFixtures(page);
    const fields = [
      { key: "region", label: "Region", control: "choice", options: [{ value: "north", label: "North" }] },
      { key: "department", label: "Organisation department", control: "source-choice", multi_select: true },
    ];
    const requests = [];
    await page.route("**/api/organisation-directory/filters", async route => {
      const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
      if (body) requests.push(body);
      const options = ["Cardiology", "Radiology", "Oncology"].map(value => ({ value, label: value }));
      await route.fulfill({
        json: body?.action === "options"
          ? { options, selectedOptions: options.filter(option => body.selected.includes(option.value)), unavailableSelected: [], total: 3, page: 1, pageSize: 50 }
          : body
            ? { fields, organizations: [], total: 0, page: 1, pageSize: 12 }
            : { fields },
      });
    });
    await page.goto("/OrganisationDirectory");
    const region = page.getByRole("combobox", { name: "Region", exact: true });
    const department = page.getByRole("group", { name: "Organisation department options" });
    await expect(department).toBeVisible();
    const regionLabel = page.locator("label").filter({ hasText: /^Region$/ });
    const departmentLabel = page.locator("label").filter({ hasText: /^Organisation department$/ });
    const row = region.locator("../..");
    await expect(row).toHaveCSS("align-items", "flex-start");
    await expect(row).toHaveCSS("flex-wrap", "wrap");
    const regionBox = await regionLabel.boundingBox();
    const departmentBox = await departmentLabel.boundingBox();
    if (width === 1440) {
      expect(Math.abs(regionBox.y - departmentBox.y)).toBeLessThan(1);
    } else {
      expect(departmentBox.y).toBeGreaterThan(regionBox.y + regionBox.height);
      expect(Math.abs(regionBox.x - departmentBox.x)).toBeLessThan(1);
    }
    expect((await department.boundingBox()).height).toBeGreaterThan((await region.boundingBox()).height);
    await region.selectOption("north");
    await department.getByRole("checkbox", { name: "Cardiology" }).check();
    await expect.poll(() => requests.filter(body => body.action !== "options").at(-1)?.filters).toEqual({
      region: { operator: "eq", value: ["north"] },
      department: { operator: "eq", value: ["Cardiology"] },
    });
    await page.getByRole("button", { name: "Clear all", exact: true }).click();
    await expect(region).toHaveValue("");
    await expect(department.getByRole("checkbox", { name: "Cardiology" })).not.toBeChecked();
    await expect.poll(() => requests.filter(body => body.action !== "options").at(-1)?.filters).toEqual({});
    await expect(page.getByRole("button", { name: "Clear all", exact: true })).toHaveCount(0);
  });
}

test("administrator saves an organisation exclusion and the mounted directory enforces it", async ({ page }) => {
  const state = await installFixtures(page, {
    viewer: ADMIN_ONE,
    excluded: { [TENANT_ONE]: [] },
  });
  const hidden = ORGANISATIONS.find(org => org.id === "directory-filter-t1-hidden");
  const visible = ORGANISATIONS.find(org => org.id === "directory-filter-t1-visible");

  await page.goto("/OrganisationDirectorySettings");
  await expect(page.getByText("Exclude Organisations", { exact: true })).toBeVisible();

  const hiddenRow = page.getByText(hidden.name, { exact: true })
    .locator("..")
    .locator("..")
    .locator("..");
  const hiddenToggle = hiddenRow.locator('input[type="checkbox"]');
  await expect(hiddenToggle).toBeVisible();
  await expect(hiddenToggle).toBeChecked();
  await hiddenToggle.uncheck();
  await page.getByRole("button", { name: "Save Settings", exact: true }).last().click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();
  await expect.poll(() =>
    JSON.parse(settingForTenant(state.db, TENANT_ONE, "org_directory_excluded_orgs").setting_value),
  ).toEqual([hidden.id]);

  expect(state.crmListRequests?.some(request =>
    request.tenantId === TENANT_ONE
    && request.query.skipDirectoryFilters === "true",
  )).toBe(true);

  await page.goto("/OrganisationDirectory");
  await expectDirectoryCards(page, { visible, hidden });
  expect(state.directoryRequests.some(request =>
    request.tenantId === TENANT_ONE
    && request.body.filters
    && request.body.filters.constructor === Object,
  )).toBe(true);
  expect(state.unexpectedMutations).toEqual([]);
});

test("member viewers enforce saved exclusions for their own organisation after remount", async ({ page }) => {
  const state = await installFixtures(page, {
    viewer: MEMBER_ONE,
    excluded: {
      [TENANT_ONE]: ["directory-filter-t1-own", "directory-filter-t1-hidden"],
    },
  });
  const own = ORGANISATIONS.find(org => org.id === "directory-filter-t1-own");
  const hidden = ORGANISATIONS.find(org => org.id === "directory-filter-t1-hidden");
  const visible = ORGANISATIONS.find(org => org.id === "directory-filter-t1-visible");

  await page.goto("/OrganisationDirectory");
  await expectDirectoryCards(page, { visible, hidden });
  await expect(page.getByTestId(`card-organisation-${own.id}`)).toHaveCount(0);

  // Directory pages are unmounted while the layout remains alive. Changing
  // the persisted setting before remounting catches stale React Query data.
  state.setExcluded(TENANT_ONE, []);
  await page.goto("/Events");
  await page.goto("/OrganisationDirectory");
  await expect(page.getByTestId(`card-organisation-${hidden.id}`)).toBeVisible();
  await expect(page.getByTestId(`card-organisation-${own.id}`)).toBeVisible();
  expect(state.directoryRequests.at(-1)?.tenantId).toBe(TENANT_ONE);
  expect(state.unexpectedMutations).toEqual([]);
});

test("remounted directory scopes results to the current tenant without stale cross-tenant cards", async ({ page }) => {
  const state = await installFixtures(page, {
    viewer: ADMIN_ONE,
    excluded: {
      [TENANT_ONE]: ["directory-filter-t1-hidden"],
      [TENANT_TWO]: ["directory-filter-t2-hidden"],
    },
  });
  const t1Visible = ORGANISATIONS.find(org => org.id === "directory-filter-t1-visible");
  const t2Visible = ORGANISATIONS.find(org => org.id === "directory-filter-t2-visible");
  const t1Hidden = ORGANISATIONS.find(org => org.id === "directory-filter-t1-hidden");
  const t2Hidden = ORGANISATIONS.find(org => org.id === "directory-filter-t2-hidden");

  await page.goto("/OrganisationDirectory");
  await expectDirectoryCards(page, { visible: t1Visible, hidden: t1Hidden });

  // Keep the app/layout mounted while the authenticated tenant changes, then
  // remount the page. The page's tenant/member query dimensions must prevent
  // the first tenant's cards from appearing in the second tenant.
  state.setViewer(ADMIN_TWO);
  await page.goto("/Events");
  await page.goto("/OrganisationDirectory");
  await expect(page.getByTestId(`card-organisation-${t2Visible.id}`)).toBeVisible();
  await expect(page.getByTestId(`card-organisation-${t2Hidden.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`card-organisation-${t1Visible.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`card-organisation-${t1Hidden.id}`)).toHaveCount(0);

  const latest = state.directoryRequests.at(-1);
  expect(latest.tenantId).toBe(TENANT_TWO);
  expect(latest.viewerId).toBe(ADMIN_TWO.id);
  expect(state.unexpectedMutations).toEqual([]);
});
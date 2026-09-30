const TENANTS = {
  one: { id: "task4507-tenant-one", slug: "task4507-one" },
  two: { id: "task4507-tenant-two", slug: "task4507-two" },
};

const ADMIN = {
  id: "task4507-admin-one",
  tenant_id: TENANTS.one.id,
  role_id: "task4507-admin-role",
  email: "task4507-admin@example.invalid",
  first_name: "Browser",
  last_name: "Administrator",
  is_team_member: true,
  viewer_kind: "administrator",
  member_excluded_features: [],
};

const ORGANISATIONS = [
  ["one-alpha", TENANTS.one.id, "Alpha Association", "111 Alpha Way"],
  ["one-beta", TENANTS.one.id, "Beta Bureau", "222 Beta Road"],
  ["one-empty", TENANTS.one.id, "No Phone Network", "333 Empty Street"],
  ["two-only", TENANTS.two.id, "Tenant Two Organisation", "2 Isolation Lane"],
].map(([id, tenant_id, name, invoicing_address], index) => ({
  id: `task4507-org-${id}`,
  tenant_id,
  name,
  phone: index === 2 ? null : `020 7000 00${index}`,
  invoicing_email: `${id}@example.invalid`,
  website_url: `https://${id}.example.invalid`,
  invoicing_address,
  logo_url: null,
  created_date: "2026-01-01T00:00:00.000Z",
}));

const MEMBERS = [
  ["one-alice", TENANTS.one.id, "Alice", "Alpha", ORGANISATIONS[0].id, "Engineer", false],
  ["one-bob", TENANTS.one.id, "Bob", "Beta", ORGANISATIONS[1].id, "Manager", false],
  ["one-empty", TENANTS.one.id, "Empty", "Title", ORGANISATIONS[2].id, null, true],
  ["two-only", TENANTS.two.id, "Tenant", "Two", ORGANISATIONS[3].id, "Isolated", false],
].map(([id, tenant_id, first_name, last_name, organization_id, job_title, disabled], index) => ({
  id: `task4507-member-${id}`,
  tenant_id,
  first_name,
  last_name,
  email: `${id}@example.invalid`,
  mobile: `07000 000 00${index}`,
  organization_id,
  role_id: ADMIN.role_id,
  job_title,
  disabled,
  created_date: "2026-01-01T00:00:00.000Z",
  member_excluded_features: [],
}));

const CUSTOM_FIELDS = [
  {
    id: "task4507-member-note",
    tenant_id: TENANTS.one.id,
    entity_scope: "member",
    label: "Member note",
    field_type: "text",
    type: "text",
    is_active: true,
    show_in_member_admin_column: true,
    show_in_member_admin_filter: true,
    display_order: 1,
  },
  {
    id: "task4507-org-sector",
    tenant_id: TENANTS.one.id,
    entity_scope: "organization",
    label: "Organisation sector",
    field_type: "text",
    type: "text",
    is_active: true,
    show_in_admin_column: true,
    show_in_admin_filter: true,
    display_order: 1,
  },
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release, pending: true };
}

function matchesText(row, text) {
  const needle = String(text || "").trim().toLowerCase();
  return !needle || Object.values(row).some(value =>
    typeof value === "string" && value.toLowerCase().includes(needle));
}

function parseJsonParam(url, name) {
  try {
    return JSON.parse(url.searchParams.get(name) || "{}");
  } catch {
    return {};
  }
}

function applyWireFilters(rows, filters) {
  return rows.filter(row => Object.entries(filters).every(([column, spec]) => {
    const value = row[column];
    if (spec?.op === "empty") return value == null || String(value).trim() === "";
    if (spec?.op === "not_empty") return value != null && String(value).trim() !== "";
    const expected = Array.isArray(spec?.value) ? spec.value : [spec?.value];
    if (spec?.op === "none_of") return !expected.includes(value);
    if (spec?.op === "any_of") return expected.includes(value);
    const actual = String(value || "").toLowerCase();
    const wanted = String(spec?.value || "").toLowerCase();
    if (spec?.op === "equals") return actual === wanted;
    if (spec?.op === "not_contains") return !actual.includes(wanted);
    return actual.includes(wanted);
  }));
}

function savedSetting(page, adminId, view) {
  return {
    id: `task4507-${page}-views-row`,
    tenant_id: TENANTS.one.id,
    setting_key: page === "members"
      ? `crm_member_views_${adminId}`
      : `crm_org_views_${adminId}`,
    setting_value: JSON.stringify({ views: view ? [view] : [] }),
    description: "Task 4507 browser fixture",
  };
}

export function defaultSavedView(page, overrides = {}) {
  const filters = page === "members"
    ? {
        searchQuery: "Alice",
        statusFilter: "active",
        orgFilter: "all",
        departmentFilter: [],
        roleFilter: [],
        coreFieldFilters: { job_title: "" },
        customFieldFilters: {},
        organizationFieldFilters: {},
        filterOps: {},
        sortField: "created_on",
        sortDir: "desc",
      }
    : {
        searchQuery: "Alpha",
        coreFieldFilters: { phone: "", website_url: "", invoicing_email: "", invoicing_address: "" },
        customFieldFilters: {},
        filterOps: {},
        sortField: "name",
        sortDir: "asc",
      };
  const { filters: filterOverrides = {}, ...viewOverrides } = overrides;
  return {
    id: `task4507-${page}-default`,
    name: "Fixture default",
    isDefault: true,
    columns: null,
    filters: { ...filters, ...filterOverrides },
    ...viewOverrides,
  };
}

export function createListFixture(options = {}) {
  const state = {
    viewer: clone(options.viewer || ADMIN),
    organisations: clone(ORGANISATIONS),
    members: clone(MEMBERS),
    customFields: clone(options.customFields ?? CUSTOM_FIELDS),
    unrelatedSettings: Array.from({ length: options.unrelatedSettings ?? 1200 }, (_, index) => ({
      id: `task4507-unrelated-${index}`,
      tenant_id: TENANTS.one.id,
      setting_key: `unrelated_task4507_${String(index).padStart(4, "0")}`,
      setting_value: `"value-${index}"`,
    })),
    savedView: options.savedView === undefined ? null : clone(options.savedView),
    invalidSavedSetting: Boolean(options.invalidSavedSetting),
    requests: [],
    settingsReads: [],
    listReads: [],
    unexpectedWrites: [],
    failures: { settings: 0, metadata: 0, list: 0, ...(options.failures || {}) },
    gates: {},
    responseDelays: [...(options.responseDelays || [])],
    defer(name) {
      const gate = deferred();
      this.gates[name] = gate;
      return () => {
        gate.pending = false;
        gate.release();
      };
    },
    setViewer(viewer) {
      this.viewer = clone(viewer);
    },
  };
  return state;
}

export async function installListFixture(page, state) {
  const context = page.context();
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const waitGate = async name => {
    const gate = state.gates[name];
    if (gate?.pending) await gate.promise;
  };

  await page.addInitScript(() => {
    class FixtureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = FixtureWebSocket.CLOSED;
        this.protocol = "";
        this.extensions = "";
        queueMicrotask(() => this.onclose?.({ code: 1000, reason: "fixture transport blocked" }));
      }
      addEventListener() {}
      removeEventListener() {}
      send() { throw new Error("Fixture WebSocket transport is blocked"); }
      close() {}
    }
    window.WebSocket = FixtureWebSocket;
  });

  await context.route("**/rest/v1/**", route => json(route, []));
  await context.route("**/realtime/v1/**", route => route.abort("blockedbyclient"));
  await context.route("**/auth/v1/**", route => route.abort("blockedbyclient"));
  await context.route("**/storage/v1/**", route => route.abort("blockedbyclient"));

  await context.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push({ method, path, query: Object.fromEntries(url.searchParams), at: Date.now() });

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push({ method, path, body: request.postData() });
      return json(route, { error: `Unexpected fixture write: ${method} ${path}` }, 599);
    }

    const viewer = state.viewer;
    const tenantId = viewer.tenant_id;
    if (path === "/api/auth/me") return json(route, viewer);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: viewer, tenant: { id: tenantId, slug: tenantId === TENANTS.one.id ? TENANTS.one.slug : TENANTS.two.slug } });
    }
    if (path === `/api/entities/Role/${viewer.role_id}`) {
      return json(route, { id: viewer.role_id, name: "Administrator", excluded_features: [] });
    }
    if (path === "/api/entities/Role") {
      return json(route, [{ id: viewer.role_id, tenant_id: tenantId, name: "Administrator", excluded_features: [] }]);
    }
    if (path === "/api/entities/Member") {
      if (url.searchParams.has("filter")) return json(route, []);
      return json(route, state.members.filter(row => row.tenant_id === tenantId));
    }
    if (path === "/api/entities/Organization") {
      return json(route, state.organisations.filter(row => row.tenant_id === tenantId));
    }
    if (path === "/api/entities/OrganizationGroup") return json(route, []);
    if (path === "/api/admin/members/departments") return json(route, { departments: [] });

    if (path === "/api/entities/SystemSettings") {
      await waitGate("settings");
      const rawFilter = parseJsonParam(url, "filter");
      const keys = rawFilter.setting_key?.in || rawFilter.setting_key?.$in || rawFilter.setting_key;
      const wanted = Array.isArray(keys) ? new Set(keys) : (typeof keys === "string" ? new Set([keys]) : null);
      const isSavedViewRead = !wanted || [...wanted].some(key => /crm_(member|org)_views_/.test(key));
      if (isSavedViewRead && state.failures.settings-- > 0) {
        return json(route, { error: "Synthetic saved-view failure" }, 503);
      }
      const ownRows = [
        savedSetting(url.searchParams.get("page") || state.page || "members", viewer.id, state.savedView),
        ...state.unrelatedSettings,
      ].filter(row => row.tenant_id === tenantId && (!wanted || wanted.has(row.setting_key)));
      if (state.invalidSavedSetting) {
        const row = ownRows.find(candidate => /crm_(member|org)_views_/.test(candidate.setting_key));
        if (row) row.setting_value = "{malformed fixture json";
      }
      state.settingsReads.push({
        at: Date.now(),
        query: Object.fromEntries(url.searchParams),
        returnedRows: ownRows.length,
      });
      return json(route, ownRows);
    }

    if (path === "/api/entities/PreferenceField") {
      await waitGate("metadata");
      if (state.failures.metadata-- > 0) return json(route, { error: "Synthetic metadata failure" }, 503);
      const filter = parseJsonParam(url, "filter");
      return json(route, state.customFields.filter(field =>
        field.tenant_id === tenantId && (!filter.entity_scope || field.entity_scope === filter.entity_scope)));
    }

    if (path === "/api/admin/members/paginated" || path === "/api/admin/organizations/paginated") {
      await waitGate("list");
      if (state.failures.list-- > 0) return json(route, { error: "Synthetic list failure" }, 503);
      const delay = Number(state.responseDelays.shift() || 0);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const isMembers = path.includes("/members/");
      let rows = (isMembers ? state.members : state.organisations).filter(row => row.tenant_id === tenantId);
      rows = rows.filter(row => matchesText(row, url.searchParams.get("search")));
      rows = applyWireFilters(rows, parseJsonParam(url, "coreFilters"));
      if (isMembers) {
        const orgId = url.searchParams.get("organizationId");
        const status = url.searchParams.get("status");
        if (orgId && orgId !== "all") rows = rows.filter(row => row.organization_id === orgId);
        if (status === "active") rows = rows.filter(row => !row.disabled);
        if (status === "disabled") rows = rows.filter(row => row.disabled);
      }
      const custom = parseJsonParam(url, "customFilters");
      if (custom["task4507-member-note"]?.op === "empty") {
        rows = rows.filter(row => row.id.endsWith("empty"));
      }
      if (custom["task4507-org-sector"]?.op === "empty") {
        rows = rows.filter(row => row.id.endsWith("empty"));
      }
      const record = {
        at: Date.now(),
        tenantId,
        path,
        query: Object.fromEntries(url.searchParams),
        resultIds: rows.map(row => row.id),
      };
      state.listReads.push(record);
      const pageNumber = Number(url.searchParams.get("page") || 1);
      const limit = Number(url.searchParams.get("limit") || (isMembers ? 50 : 20));
      return json(route, {
        [isMembers ? "members" : "organizations"]: rows,
        pagination: { page: pageNumber, limit, total: rows.length, totalPages: rows.length ? 1 : 0, selectableTotal: rows.length },
      });
    }

    return json(route, []);
  });
}

export const task4507Fixtures = {
  ADMIN,
  TENANTS,
  MEMBERS,
  ORGANISATIONS,
  CUSTOM_FIELDS,
};
const PAGE_PATH = "/CommunicationsManagement";

export const viewer = {
  id: "status-report-admin",
  tenant_id: "status-report-tenant",
  organization_id: "org-north",
  role_id: "role-admin",
  email: "admin@example.invalid",
  first_name: "Report",
  last_name: "Administrator",
  member_excluded_features: [],
};

export const categories = [
  {
    id: "category-news-active",
    name: "News",
    displayOrder: 1,
    active: true,
    publicOnly: false,
    roleIds: [],
  },
  {
    id: "category-news-inactive",
    name: "News",
    displayOrder: 2,
    active: false,
    publicOnly: false,
    roleIds: [],
  },
  {
    id: "category-public",
    name: "Public bulletin",
    displayOrder: 3,
    active: true,
    publicOnly: true,
    roleIds: [],
  },
  {
    id: "category-role-limited",
    name: "Role updates",
    displayOrder: 4,
    active: true,
    publicOnly: false,
    roleIds: ["role-admin"],
  },
];

const organizations = [
  { id: "org-north", name: "North Association" },
  { id: "org-south", name: "South Society" },
];
const roles = [
  { id: "role-admin", name: "Administrator" },
  { id: "role-member", name: "Member" },
];

const makeMember = (index) => {
  const number = String(index + 1).padStart(2, "0");
  const north = index % 2 === 0;
  const optedIn = index % 3 === 0;
  return {
    memberId: `member-${number}`,
    firstName: index === 0 ? "Disabled" : "Member",
    lastName: number,
    name: `${index === 0 ? "Disabled" : "Member"} ${number}`,
    email: index === 2 ? "" : `member-${number}@example.invalid`,
    organizationId: north ? "org-north" : "org-south",
    organizationName: north ? "North Association" : "South Society",
    roleId: north ? "role-admin" : "role-member",
    roleName: north ? "Administrator" : "Member",
    loginEnabled: index !== 0,
    globalOptOut: index % 5 === 0,
    categoryStatuses: {
      "category-news-active": {
        optedIn,
        available: true,
        unavailableReason: null,
      },
      "category-news-inactive": {
        // Stored consent remains visible even though the category is unavailable.
        optedIn: index === 0,
        available: false,
        unavailableReason: "inactive",
      },
      "category-public": {
        optedIn: index === 0,
        available: false,
        unavailableReason: "public_only",
      },
      "category-role-limited": {
        optedIn: index === 1,
        available: north,
        unavailableReason: north ? null : "role_ineligible",
      },
    },
  };
};

const allMembers = Array.from({ length: 53 }, (_, index) => makeMember(index));

function json(route, body, status = 200, headers = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

function reportFor(url, state) {
  const query = Object.fromEntries(url.searchParams);
  let rows = [...allMembers];
  if (query.search) {
    const search = query.search.toLowerCase();
    rows = rows.filter((row) =>
      row.name.toLowerCase().includes(search)
      || row.email.toLowerCase().includes(search));
  }
  if (query.organizationId) rows = rows.filter((row) => row.organizationId === query.organizationId);
  if (query.roleId) rows = rows.filter((row) => row.roleId === query.roleId);
  if (query.globalOptOut === "yes") rows = rows.filter((row) => row.globalOptOut);
  if (query.globalOptOut === "no") rows = rows.filter((row) => !row.globalOptOut);
  if (query.categoryId && query.categoryStatus) {
    const optedIn = query.categoryStatus === "opted_in";
    rows = rows.filter((row) => row.categoryStatuses[query.categoryId]?.optedIn === optedIn);
  }

  if (state.forceEmpty) rows = [];
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.max(1, Number(query.limit || 50));
  const total = state.exportScale ? 1005 : rows.length;
  const visibleRows = state.exportScale ? rows.slice(0, Math.min(limit, rows.length)) : rows.slice((page - 1) * limit, page * limit);
  return {
    filters: query,
    categories: state.noCategories ? [] : categories,
    rows: visibleRows,
    options: { organizations, roles },
    summary: {
      filteredMembers: total,
      globallyOptedOut: state.exportScale ? 201 : rows.filter((row) => row.globalOptOut).length,
      notGloballyOptedOut: state.exportScale ? 804 : rows.filter((row) => !row.globalOptOut).length,
      anyExplicitCategoryOptIn: state.exportScale
        ? 335
        : rows.filter((row) => Object.values(row.categoryStatuses).some((item) => item.optedIn)).length,
    },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function installCommunicationReportFixture(page, baseURL, options = {}) {
  const origin = new URL(baseURL).origin;
  const state = {
    reportReads: [],
    exportRequests: [],
    unexpectedWrites: [],
    unexpectedRequests: [],
    wholeTenantReads: [],
    reportFailures: options.reportFailures || 0,
    forceEmpty: options.forceEmpty || false,
    noCategories: options.noCategories || false,
    exportScale: options.exportScale || false,
    holdExport: options.holdExport || false,
    exportFailure: options.exportFailure || false,
    releaseExport: null,
  };

  await page.addInitScript(() => {
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.context().routeWebSocket("**/*", (socket) => socket.close());
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const description = `${method} ${path}${url.search}`;

    if (path.startsWith("/api/")) {
      if (url.origin !== origin) {
        state.unexpectedRequests.push(description);
        return json(route, { error: "Cross-origin API blocked" }, 599);
      }

      if (path === "/api/admin/communications/status-report" && method === "GET") {
        state.reportReads.push(Object.fromEntries(url.searchParams));
        if (state.reportFailures > 0) {
          state.reportFailures -= 1;
          return json(route, { error: "Fixture report failure" }, 500);
        }
        return json(route, reportFor(url, state));
      }
      if (path === "/api/admin/communications/status-report/options" && method === "GET") {
        return json(route, { organizations, roles });
      }
      if (path === "/api/admin/communications/status-report-export" && method === "POST") {
        const body = request.postDataJSON();
        state.exportRequests.push(body);
        if (state.exportFailure) return json(route, { error: "Fixture export failure" }, 500);
        if (state.holdExport) {
          await new Promise((resolve) => { state.releaseExport = resolve; });
        }
        const rowCount = state.exportScale ? 1005 : allMembers.length;
        const lines = ["member_id,first_name,last_name,email,organisation,News [category-news-active],global_opt_out"];
        for (let index = 0; index < rowCount; index += 1) {
          lines.push(`export-${index + 1},Member,${index + 1},member-${index + 1}@example.invalid,North Association,Opted in,No`);
        }
        return route.fulfill({
          status: 200,
          contentType: "text/csv; charset=utf-8",
          headers: {
            "content-disposition": 'attachment; filename="member_communication_status_fixture.csv"',
            "x-export-row-count": String(rowCount),
          },
          body: `\ufeff${lines.join("\r\n")}`,
        });
      }

      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        state.unexpectedWrites.push(description);
        return json(route, { error: "Unexpected fixture write blocked" }, 599);
      }
      if (path === "/api/auth/me") return json(route, viewer);
      if (path === "/api/auth/tenant-user-me") return json(route, {
        authenticated: true,
        user: viewer,
        tenant: { id: viewer.tenant_id, slug: "communication-report-fixture" },
        tenantId: viewer.tenant_id,
        memberId: viewer.id,
      });
      if (path === `/api/entities/Role/${viewer.role_id}`) {
        return json(route, { id: viewer.role_id, name: "Administrator", excluded_features: [] });
      }
      if (path === "/api/entities/Role") return json(route, roles);
      if (path === `/api/entities/Member/${viewer.id}`) return json(route, viewer);
      if (path === "/api/entities/Member" || path === "/api/entities/MemberCommunicationPreference") {
        state.wholeTenantReads.push(description);
        return json(route, []);
      }
      if (path === "/api/entities/Organization") return json(route, organizations);
      if (path === "/api/zoho-campaigns/oauth") return json(route, { connected: false, credentialsConfigured: false });
      if (path === "/api/communication/inbox/unread-count") return json(route, { count: 0 });
      if (path === "/api/admin/form-submissions/stats") return json(route, { total: 0, pending: 0 });
      if ([
        "/api/public/favicon-url", "/api/public/portal-branding",
        "/api/public/tenant-branding", "/api/public/ai-help-persona",
        "/api/public/form-consent-message",
      ].includes(path)) return json(route, {});
      return json(route, []);
    }

    if (url.origin !== origin) return route.fulfill({ status: 204, body: "" });
    if (
      path === PAGE_PATH
      || path.startsWith("/src/")
      || path.startsWith("/@")
      || path.startsWith("/node_modules/")
      || path.startsWith("/assets/")
      || path === "/favicon.ico"
    ) return route.continue();

    state.unexpectedRequests.push(description);
    return route.fulfill({ status: 599, contentType: "text/plain", body: "Unexpected fixture request" });
  });
  return state;
}
export const TENANT = {
  id: "tenant-member-text-fixture",
  name: "Member Text Fixture Tenant",
  slug: "member-text-fixture",
};

export const TOKENS = [
  { label: "First name", token: "{{member.first_name}}" },
  { label: "Last name", token: "{{member.last_name}}" },
  { label: "Job title", token: "{{member.job_title}}" },
  { label: "Linked organisation name", token: "{{member.organization.name}}" },
];

export const VIEWER_A = {
  id: "member-text-a",
  tenant_id: TENANT.id,
  organization_id: "organization-text-a",
  role_id: "role-member-text",
  email: "member-text-a@example.invalid",
  first_name: "Amelia",
  last_name: "Archer",
  job_title: "Director of Learning",
  organization_name: "Acorn Association",
  member_excluded_features: [],
};

export const VIEWER_B = {
  ...VIEWER_A,
  id: "member-text-b",
  organization_id: "organization-text-b",
  email: "member-text-b@example.invalid",
  first_name: "Basil",
  last_name: "Brooks",
  job_title: "Programme Manager",
  organization_name: "Birch Society",
};

export const TEMPLATE_HTML = [
  "<p>Welcome <strong>{{member.first_name}}</strong> <em>{{member.last_name}}</em>.</p>",
  "<p>Role: <u>{{member.job_title}}</u>.</p>",
  "<p>Organisation: {{member.organization.name}}.</p>",
  "<p>Unknown: {{member.secret}}.</p>",
].join("");

export function canvasPage(version, html = TEMPLATE_HTML) {
  const id = `canvas-member-text-v${version}`;
  const geom = { x: 24, y: 24, w: 640, h: 240 };
  const text = {
    id: `member-text-${version}`,
    type: "text",
    name: "Member greeting",
    geom,
    bp: {
      desktop: geom,
      tablet: { ...geom, w: 620 },
      mobile: { ...geom, x: 12, w: 345 },
    },
    style: { background: "transparent", opacity: 1 },
    content: { html, fontSize: 20, color: "#111827" },
  };
  const children = [version === 2 ? {
    ...text,
    layoutMode: "flow",
    flow: { heightMode: "auto", flex: "none" },
  } : text];
  return {
    id,
    title: `Member greeting V${version}`,
    slug: id,
    status: "published",
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: "none",
    tenant_id: TENANT.id,
    canvas_design: {
      version,
      root: {
        background: null,
        groups: [],
        guides: { vertical: [], horizontal: [] },
        ...(version === 2 ? { layout: "flow" } : {}),
        sections: [{
          id: `member-section-${version}`,
          ...(version === 2 ? {
            type: "section",
            layoutMode: "flow",
            flow: { direction: "column", gap: 16, align: "stretch" },
          } : {}),
          children,
        }],
      },
    },
  };
}

function authMember(viewer) {
  if (!viewer) return null;
  // This is the /auth/me projection, not an arbitrary Organization collection
  // response. The deliberately stale collection below must never supply tokens.
  return {
    ...viewer,
    canvasMemberSnapshot: {
      memberId: viewer.id,
      tenantId: viewer.tenant_id,
      organizationId: viewer.organization_id || null,
      values: {
        "member.first_name": viewer.first_name || "",
        "member.last_name": viewer.last_name || "",
        "member.job_title": viewer.job_title || "",
        "member.organization.name": viewer.organization_id ? viewer.organization_name || "" : "",
      },
    },
  };
}

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * All persistence happens inside this fixture. Only the exact Canvas PUT
 * contract is accepted; unexpected mutations and direct Supabase writes fail.
 * A shared state object lets multiple isolated contexts see one saved template.
 */
export async function installMemberTextFixture(page, {
  version = 1,
  viewer = VIEWER_A,
  state = { page: canvasPage(version), writes: [], unexpectedWrites: [] },
  holdAuth = false,
} = {}) {
  const pageErrors = [];
  let releaseAuth;
  const authGate = new Promise((resolve) => { releaseAuth = resolve; });
  if (!holdAuth) releaseAuth();
  await page.addInitScript(({ cached }) => {
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
    localStorage.clear();
    sessionStorage.clear();
    // Even guest tests carry a stale previous viewer's cache. Only /auth/me
    // validation may authorize personalisation.
    localStorage.setItem("agcas_member", JSON.stringify(cached));
  }, { cached: VIEWER_A });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.context().routeWebSocket("**/realtime/v1/websocket*", (socket) => {
    socket.onMessage(() => {});
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path.startsWith("/rest/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        state.unexpectedWrites.push({ path, method });
        return json(route, { error: "Unexpected Supabase fixture mutation" }, 405);
      }
      return json(route, []);
    }
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/me") {
      await authGate;
      return json(route, authMember(viewer));
    }
    if (path === "/api/auth/tenant-user-me") {
      return json(route, viewer ? {
        ...authMember(viewer),
        tenant: TENANT,
        tenantId: TENANT.id,
        memberId: viewer.id,
      } : null);
    }
    const role = { id: VIEWER_A.role_id, name: "Fixture editor", excluded_features: [] };
    if (path === `/api/entities/Role/${role.id}`) return json(route, role);
    if (path === "/api/entities/Role") return json(route, [role]);
    if (path === "/api/entities/Member") return json(route, viewer ? [authMember(viewer)] : []);
    if (path === `/api/entities/Member/${viewer?.id}`) return json(route, authMember(viewer));
    const staleOrg = {
      id: VIEWER_A.organization_id,
      tenant_id: "wrong-tenant",
      name: "STALE ORGANISATION MUST NOT RENDER",
      program_ticket_balances: {},
      training_fund_balance: 0,
    };
    if (path === "/api/entities/Organization") return json(route, [staleOrg]);
    if (path.startsWith("/api/entities/Organization/")) return json(route, staleOrg);
    if (path === "/api/entities/IEditPage") return json(route, [state.page]);
    if (path === `/api/entities/IEditPage/${state.page.id}`) return json(route, state.page);
    if (path === `/api/public/page/${state.page.slug}`) {
      return json(route, { success: true, page: state.page, elements: [], symbols: [] });
    }
    if (path === `/api/canvas-design/${state.page.id}`) {
      if (method === "GET") return json(route, { page: state.page });
      if (method === "PUT") {
        const body = request.postDataJSON();
        if (!body || !body.canvas_design || Object.keys(body).length !== 1) {
          state.unexpectedWrites.push({ path, method, body });
          return json(route, { error: "Invalid Canvas save contract" }, 400);
        }
        state.writes.push({ path, method, body });
        state.page.canvas_design = structuredClone(body.canvas_design);
        return json(route, { page: state.page });
      }
    }
    if (path === `/api/canvas-versions/${state.page.id}` && method === "POST") {
      const body = request.postDataJSON();
      // Saving also records a version. Accept only that exact immutable
      // template snapshot, never an arbitrary mutation or personalised design.
      if (body?.source !== "saved" || body?.label !== "Saved"
        || JSON.stringify(body.design) !== JSON.stringify(state.page.canvas_design)) {
        state.unexpectedWrites.push({ path, method, body });
        return json(route, { error: "Invalid Canvas version contract" }, 400);
      }
      state.versionWrites ||= [];
      state.versionWrites.push({ path, method, body });
      return json(route, { version: { id: "fixture-saved-version", ...body } });
    }
    if (method === "GET") {
      if (path.includes("/branding") || path.includes("/settings")) {
        return json(route, { tenant: TENANT, branding: {} });
      }
      return json(route, []);
    }
    state.unexpectedWrites.push({ path, method, body: request.postData() });
    return json(route, { error: "Unexpected fixture mutation" }, 405);
  });
  return { state, pageErrors, releaseAuth };
}
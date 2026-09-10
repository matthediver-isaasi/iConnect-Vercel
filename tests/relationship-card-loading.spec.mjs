import { test, expect } from "@playwright/test";

const definition = {
  id: "smoke-relationship",
  status: "active",
  cardinality: "many_to_many",
  source_kind: "organization",
  target_kind: "member",
  source_label: "Team members",
  target_label: "Organisations",
  show_on_source: true,
  show_on_target: true,
  edit_from_source: true,
  edit_from_target: true,
  can_edit: true,
};

const viewer = {
  id: "smoke-viewer",
  tenant_id: "smoke-tenant",
  organization_id: "smoke-org",
  role_id: "smoke-role",
  email: "viewer@example.invalid",
  first_name: "Smoke",
  last_name: "Viewer",
  member_excluded_features: [],
};
const member = {
  id: "smoke-member",
  tenant_id: "smoke-tenant",
  organization_id: "smoke-org",
  role_id: "smoke-role",
  email: "member@example.invalid",
  first_name: "Browser",
  last_name: "Member",
  login_enabled: true,
  member_excluded_features: [],
};
const organization = {
  id: "smoke-org",
  tenant_id: "smoke-tenant",
  name: "Browser Smoke Organisation",
  email: "org@example.invalid",
  invoicing_email: "accounts@example.invalid",
  phone: "01234 567890",
};
const role = { id: "smoke-role", name: "Administrator", excluded_features: [] };

const memberLayout = {
  cards: [{
    id: "member-relationship-card",
    title: "Data Studio links",
    columns: 1,
    fields: [{
      id: "relationship:smoke-relationship:target",
      type: "relationship",
      definitionId: definition.id,
      side: "target",
      displayMode: "columns",
      columnIndex: 0,
    }],
  }],
};
const organizationLayout = {
  cards: [{
    id: "organisation-relationship-card",
    title: "Data Studio links",
    columns: 1,
    fields: [{
      id: "relationship:smoke-relationship:source",
      type: "relationship",
      definitionId: definition.id,
      side: "source",
      displayMode: "cards",
      columnIndex: 0,
    }],
  }],
};

const rowFor = (kind) => kind === "member"
  ? {
      relationship_id: "edge-member-org",
      related_kind: "organization",
      related_record_id: organization.id,
      related: { id: organization.id, kind: "organization", primary_label: organization.name },
    }
  : {
      relationship_id: "edge-org-member",
      related_kind: "member",
      related_record_id: member.id,
      related: { id: member.id, kind: "member", primary_label: "Browser Member" },
    };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function installFixtures(page, {
  definitionGate,
  rowsGate,
  failDefinitions = 0,
  failRows = 0,
  holdRowError = false,
} = {}) {
  const state = {
    requests: [],
    escapedWrites: [],
    definitionCalls: 0,
    rowCalls: 0,
    allowRows: !holdRowError,
  };
  const settings = [
    {
      id: "member-layout",
      setting_key: "member_detail_layout_config",
      setting_value: JSON.stringify(memberLayout),
    },
    {
      id: "org-layout",
      setting_key: "org_detail_layout_config",
      setting_value: JSON.stringify(organizationLayout),
    },
  ];
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.context().route("**/rest/v1/**", async (route) => {
    const method = route.request().method();
    state.requests.push(`${method} ${route.request().url()} [mocked Supabase]`);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: "Unexpected direct data mutation" }, 599);
    }
    return json(route, []);
  });
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me") return json(route, viewer);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: viewer, tenant: { id: "smoke-tenant", slug: "smoke" } });
    }
    if (path === "/api/entities/Role/smoke-role") return json(route, role);
    if (path === "/api/entities/Role") return json(route, [role]);
    if (path === "/api/entities/Member/smoke-member") return json(route, member);
    if (path === "/api/entities/Member/smoke-viewer") return json(route, viewer);
    if (path === "/api/entities/Member") return json(route, [member, viewer]);
    if (path === "/api/entities/Organization/smoke-org") return json(route, organization);
    if (path === "/api/entities/Organization") return json(route, [organization]);
    if (path === "/api/entities/SystemSettings") return json(route, settings);
    if (path === "/api/admin/organizations/paginated") {
      return json(route, {
        organizations: [organization],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });
    }

    if (path === "/api/custom-objects/core/relationship-definitions") {
      state.definitionCalls += 1;
      if (definitionGate) await definitionGate.promise;
      if (state.definitionCalls <= failDefinitions) {
        return json(route, { error: "Definition fixture unavailable" }, 503);
      }
      const kind = url.searchParams.get("kind");
      const side = kind === "member" ? "target" : "source";
      return json(route, { data: [{ definition, side, count: 1 }], total: 1 });
    }
    if (path === "/api/custom-objects/core/relationships") {
      state.rowCalls += 1;
      if (rowsGate) await rowsGate.promise;
      if (!state.allowRows || state.rowCalls <= failRows) {
        return json(route, { error: "Rows fixture unavailable" }, 503);
      }
      const kind = url.searchParams.get("kind");
      return json(route, { data: [rowFor(kind)], total: 1, pageSize: 10 });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

function loadingSurface(page) {
  return page.locator('[data-testid="related-records-loading"]:visible');
}

async function assertLoadingSemantics(page) {
  await expect(loadingSurface(page)).toBeVisible();
  await expect(loadingSurface(page).getByRole("status")).toHaveText(/Loading records/);
  const content = page.locator("[data-related-records-content][inert]").first();
  await expect(content).toHaveAttribute("aria-busy", "true");
  await expect(content).toHaveAttribute("aria-hidden", "true");
  await expect(content).toHaveCSS("pointer-events", "none");
  await expect(content.getByRole("status")).toHaveCount(0);
}

test("member columns layout keeps definitions and relationship rows safely loading", async ({ page }) => {
  const definitions = deferred();
  const rows = deferred();
  const state = await installFixtures(page, { definitionGate: definitions, rowsGate: rows });
  await page.goto("/members/smoke-member");

  await expect(page.getByText("Browser Member", { exact: true }).first()).toBeVisible();
  await assertLoadingSemantics(page);
  await expect(page.getByText("Data Studio links")).toBeVisible();
  definitions.resolve();

  const tab = page.getByTestId("tab-relationship-smoke-relationship-target");
  await expect(tab).toBeVisible();
  await tab.click();
  await assertLoadingSemantics(page);

  const inertContent = page.locator("[data-related-records-content][inert]:visible");
  const addLink = inertContent.locator("button", { hasText: "Add link" });
  await expect(addLink).toBeVisible();
  await expect(inertContent.getByRole("button", { name: "Add link" })).toHaveCount(0);
  await addLink.focus();
  await expect(addLink).not.toBeFocused();
  const box = await addLink.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole("dialog", { name: /Add Organisations/ })).toHaveCount(0);

  const edit = page.getByTestId("button-edit-member");
  await edit.click();
  await expect(page.getByTestId("button-save-member")).toBeVisible();
  rows.resolve();
  await expect(loadingSurface(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: organization.name })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  expect(state.escapedWrites).toEqual([]);
});

test("organisation cards layout retries a row error and renders cards", async ({ page }) => {
  const state = await installFixtures(page, { holdRowError: true });
  await page.goto("/organisations/smoke-org");
  const tab = page.getByTestId("tab-relationship-smoke-relationship-source");
  await expect(tab).toBeVisible();
  await tab.click();

  const alert = page.getByRole("alert").filter({ hasText: "Rows fixture unavailable" });
  await expect(alert).toBeVisible();
  state.allowRows = true;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Browser Member", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  const configured = page.getByTestId("organisation-layout-relationship:smoke-relationship:source");
  await expect(configured.locator("article")).toHaveCount(1);
  await expect(configured.getByText("Browser Member", { exact: true })).toBeVisible();
  await page.screenshot({ path: "screenshots/relationship-card-loading.png", fullPage: false });
  expect(state.rowCalls).toBeGreaterThanOrEqual(2);
  expect(state.escapedWrites).toEqual([]);
});

test("definition error retries without blocking the normal member page", async ({ page }) => {
  const state = await installFixtures(page, { failDefinitions: 1 });
  await page.goto("/members/smoke-member");
  await expect(page.getByText("Browser Member", { exact: true }).first()).toBeVisible();
  const alert = page.getByRole("alert").filter({ hasText: "Records could not be loaded" }).first();
  await expect(alert).toBeVisible();
  await page.getByTestId("button-edit-member").click();
  await expect(page.getByTestId("button-save-member")).toBeVisible();
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("tab-relationship-smoke-relationship-target")).toBeVisible();
  expect(state.definitionCalls).toBeGreaterThanOrEqual(2);
  expect(state.escapedWrites).toEqual([]);
});

test("mobile member and organisation relationship overlays stay inside the viewport", async ({ browser }) => {
  const cases = [{
    name: "member",
    path: "/members/smoke-member",
    layoutTestId: "member-layout-relationship:smoke-relationship:target",
    tabTestId: "tab-relationship-smoke-relationship-target",
    resultName: organization.name,
  }, {
    name: "organisation",
    path: "/organisations/smoke-org",
    layoutTestId: "organisation-layout-relationship:smoke-relationship:source",
    tabTestId: "tab-relationship-smoke-relationship-source",
    resultName: "Browser Member",
  }];

  for (const item of cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      const rows = deferred();
      const state = await installFixtures(page, { rowsGate: rows });
      await page.goto(item.path);
      const configured = page.getByTestId(item.layoutTestId);
      await expect(configured).toBeVisible();
      await assertLoadingSemantics(page);
      await page.getByTestId(item.tabTestId).click();
      await assertLoadingSemantics(page);
      const activePanel = loadingSurface(page);
      const geometry = await activePanel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          viewport: window.innerWidth,
        };
      });
      expect(geometry.left, `${item.name} overlay left edge`).toBeGreaterThanOrEqual(0);
      expect(geometry.right, `${item.name} overlay right edge`).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.width, `${item.name} overlay width`).toBeLessThanOrEqual(geometry.viewport);
      await page.screenshot({
        path: `screenshots/relationship-card-loading-overlay-${item.name}.png`,
        fullPage: false,
      });
      rows.resolve();
      await expect(page.getByRole("link", { name: item.resultName }).first()).toBeVisible();
      expect(state.escapedWrites).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
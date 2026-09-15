import { test, expect } from "@playwright/test";

const organisation = {
  id: "login-access-org",
  tenant_id: "login-access-tenant",
  name: "Login Access Fixture Organisation",
  email: "organisation@example.invalid",
  invoicing_email: "accounts@example.invalid",
  phone: "01234 567890",
  description: "Browser regression organisation",
  status: "active",
};

const viewer = {
  id: "login-access-viewer",
  tenant_id: organisation.tenant_id,
  organization_id: organisation.id,
  role_id: "login-access-role",
  email: "admin@example.invalid",
  first_name: "Login",
  last_name: "Access Tester",
  member_excluded_features: [],
  is_team_member: true,
};

const member = {
  id: "login-access-member",
  tenant_id: organisation.tenant_id,
  organization_id: organisation.id,
  role_id: "login-access-role",
  email: "member@example.invalid",
  first_name: "Linked",
  last_name: "Member",
  login_enabled: true,
  member_excluded_features: [],
};

const customField = {
  id: "login-access-custom-field",
  name: "review_status",
  label: "Review status",
  entity_scope: "organization",
  field_type: "text",
  is_active: true,
  show_in_admin_column: true,
  show_in_admin_filter: true,
  display_order: 1,
};

const adminRole = {
  id: viewer.role_id,
  name: "Administrator",
  excluded_features: [],
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function accessPayload({ manualBlocked = false, gateBlocked = false, updatedBy = "audit-user" } = {}) {
  return {
    manualBlocked,
    gateBlocked,
    blocked: manualBlocked || gateBlocked,
    causes: [
      ...(manualBlocked ? ["manual"] : []),
      ...(gateBlocked ? ["gate"] : []),
    ],
    updatedAt: "2026-09-15T10:20:00.000Z",
    updatedBy,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function installFixtures(page, {
  access = accessPayload(),
  admin = true,
  loginAccessStatus = 200,
  authMeStatus = 200,
  patchFailures = 0,
  getFailures = 0,
  patchGate = null,
} = {}) {
  const state = {
    access: { ...access },
    organization: { ...organisation },
    admin,
    loginAccessStatus,
    authMeStatus,
    patchFailures,
    getFailures,
    patchGate,
    loginAccessCalls: 0,
    patchBodies: [],
    organizationWrites: [],
    customWrites: [],
    escapedWrites: [],
  };
  const settings = [{
    id: "date-format",
    setting_key: "date_display_format",
    setting_value: "dd MMM yyyy",
  }];

  await page.context().route("**/rest/v1/**", (route) => json(route, []));
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") {
      return json(route, authMeStatus === 200 ? viewer : { error: "Authentication required" }, authMeStatus);
    }
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: viewer, tenant: { id: organisation.tenant_id } });
    }
    if (path === `/api/entities/Role/${viewer.role_id}`) {
      return json(route, state.admin ? adminRole : { ...adminRole, excluded_features: ["admin.role-management"] });
    }
    if (path === "/api/entities/Role") return json(route, [state.admin ? adminRole : { ...adminRole, excluded_features: ["admin.role-management"] }]);
    if (path === `/api/entities/Member/${viewer.id}`) return json(route, viewer);
    if (path === `/api/entities/Member/${member.id}`) return json(route, member);
    if (path === "/api/entities/Member") return json(route, [member, viewer]);
    if (path === `/api/entities/Organization/${organisation.id}`) {
      if (method === "PATCH") {
        const patch = request.postDataJSON();
        state.organization = { ...state.organization, ...patch };
        state.organizationWrites.push(patch);
      }
      return json(route, state.organization);
    }
    if (path === "/api/entities/Organization") return json(route, [state.organization]);
    if (path === "/api/entities/OrganizationGroup") return json(route, []);
    if (path === "/api/entities/PreferenceField") return json(route, [customField]);
    if (path === "/api/entities/OrganizationPreferenceValue") return json(route, []);
    if (path === "/api/entities/SystemSettings") return json(route, settings);

    if (path === "/api/entities/organization-preference-value/upsert" && method === "POST") {
      state.customWrites.push(request.postDataJSON());
      return json(route, { id: "login-access-preference-value", ...request.postDataJSON() });
    }

    if (path === "/api/admin/organizations/paginated") {
      return json(route, {
        organizations: [state.organization],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });
    }

    if (path === `/api/admin/organizations/${organisation.id}/login-access`) {
      state.loginAccessCalls += 1;
      if (method === "GET") {
        if (state.getFailures > 0) {
          state.getFailures -= 1;
          return json(route, { error: "Login access fixture unavailable" }, 500);
        }
        return json(route, state.access, state.loginAccessStatus);
      }
      if (method === "PATCH") {
        const body = request.postDataJSON();
        state.patchBodies.push(body);
        if (state.patchGate) {
          await state.patchGate.promise;
          state.patchGate = null;
        }
        if (state.patchFailures > 0) {
          state.patchFailures -= 1;
          return json(route, { error: "Session cleanup failed" }, 503);
        }
        const manualBlocked = !!body.blocked;
        // Keep the gate independently controlled. This makes it possible to
        // verify that removing a manual block does not claim to restore access
        // while the gate is still blocking the organisation.
        state.access = accessPayload({
          manualBlocked,
          gateBlocked: state.access.gateBlocked,
        });
        return json(route, state.access);
      }
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });

  return state;
}

async function openOrganisation(page, options) {
  const state = await installFixtures(page, options);
  await page.goto(`/organisations/${organisation.id}`);
  await expect(page.getByText(organisation.name, { exact: true }).first()).toBeVisible();
  return state;
}

test("organisation login access card shows independent manual and gate causes, confirmation, audit, and accurate success", async ({ page }) => {
  const state = await openOrganisation(page, {
    access: accessPayload({ gateBlocked: true, updatedBy: "gate-auditor" }),
  });
  const card = page.getByTestId("card-organisation-login-access");
  await expect(card).toBeVisible();
  await expect(card.getByText("Not manually blocked", { exact: true })).toBeVisible();
  await expect(card.getByText("Effective member login status", { exact: true })).toBeVisible();
  await expect(card.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(card.getByText(/Organisation login gate: blocking/)).toBeVisible();
  await expect(card.getByTestId("organisation-login-access-causes")).toContainText("gate");
  await expect(card.getByTestId("organisation-login-access-audit")).toContainText("gate-auditor");

  await card.getByTestId("switch-organisation-login-manual-block").click();
  const confirmation = page.getByRole("alertdialog", { name: "Block member login access?" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("cookie/mobile sessions will end");
  await expect(confirmation).toContainText("audit history");
  await confirmation.getByTestId("button-confirm-organisation-login-block").click();
  await expect.poll(() => state.patchBodies).toHaveLength(1);
  expect(state.patchBodies[0]).toEqual({ blocked: true });
  await expect(card.getByText("Blocked manually", { exact: true })).toBeVisible();
  await expect(card.getByTestId("organisation-login-access-causes")).toContainText("manual");
  await expect(card.getByTestId("organisation-login-access-causes")).toContainText("gate");
  await expect(page.getByText("Member login access is restored.", { exact: true })).toHaveCount(0);

  // Turning off only the manual flag preserves the gate's effective block and
  // must never show an access-restored success message.
  await card.getByTestId("switch-organisation-login-manual-block").click();
  await expect.poll(() => state.patchBodies).toHaveLength(2);
  expect(state.patchBodies[1]).toEqual({ blocked: false });
  await expect(card.getByText("Not manually blocked", { exact: true })).toBeVisible();
  await expect(page.getByText("Manual member login block removed, but access remains blocked by the organisation login gate.", { exact: true })).toBeVisible();
  await expect(page.getByText("Member login access is restored.", { exact: true })).toHaveCount(0);
  expect(state.escapedWrites).toEqual([]);
});

test("organisation login access card keeps state pending and surfaces GET/PATCH failures", async ({ page }) => {
  const patchGate = deferred();
  const state = await openOrganisation(page, {
    access: accessPayload(),
    patchGate,
  });
  const card = page.getByTestId("card-organisation-login-access");
  const toggle = card.getByTestId("switch-organisation-login-manual-block");
  await toggle.click();
  await page.getByTestId("button-confirm-organisation-login-block").click();
  await expect(card.getByTestId("status-organisation-login-access-pending")).toBeVisible();
  await expect(toggle).toBeDisabled();
  patchGate.resolve();
  await expect.poll(() => state.patchBodies).toHaveLength(1);
  await expect(toggle).toBeChecked();

  state.patchFailures = 1;
  await toggle.click();
  await expect(card.getByTestId("status-organisation-login-access-mutation-error")).toContainText("Session cleanup failed");
  await expect(toggle).toBeChecked();
  expect(state.patchBodies).toEqual([{ blocked: true }, { blocked: false }]);

  // Force all automatic GET retries to fail, then prove the protected state is
  // replaced by an actionable error rather than retaining the old status.
  state.getFailures = 3;
  await page.reload();
  await expect(page.getByTestId("status-organisation-login-access-error")).toBeVisible();
  await expect(page.getByTestId("status-organisation-login-access-error")).toContainText("Login access fixture unavailable");
  state.getFailures = 0;
  await page.getByTestId("button-retry-organisation-login-access").click();
  await expect(page.getByTestId("switch-organisation-login-manual-block")).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
});

test("organisation login access is hidden from non-admins and org/custom saves refresh it", async ({ page }) => {
  const nonAdminState = await openOrganisation(page, { admin: false });
  await expect(page.getByTestId("card-organisation-login-access")).toHaveCount(0);
  expect(nonAdminState.loginAccessCalls).toBe(0);

  await page.context().unroute("**/api/**");
  const state = await openOrganisation(page, { access: accessPayload() });
  const card = page.getByTestId("card-organisation-login-access");
  const initialCalls = state.loginAccessCalls;

  await page.getByTestId("button-edit-org").click();
  await page.getByTestId("input-name").fill("Updated Login Access Organisation");
  await page.getByTestId("button-save-org").click();
  await expect.poll(() => state.organizationWrites.length).toBe(1);
  await expect.poll(() => state.loginAccessCalls).toBeGreaterThan(initialCalls);

  const callsAfterOrganisationSave = state.loginAccessCalls;
  await page.getByTestId("button-edit-org").click();
  await page.getByTestId(`input-custom-${customField.id}`).fill("Reviewed");
  await page.getByTestId("button-save-org").click();
  await expect.poll(() => state.customWrites.length).toBe(1);
  await expect.poll(() => state.loginAccessCalls).toBeGreaterThan(callsAfterOrganisationSave);
  await expect(card).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
});

test("admin login-access 403 clears the protected card without exposing stale state", async ({ page }) => {
  const state = await openOrganisation(page, {
    loginAccessStatus: 403,
    access: accessPayload({ manualBlocked: true }),
  });
  await expect(page.getByTestId("card-organisation-login-access")).toHaveCount(0);
  expect(state.loginAccessCalls).toBeGreaterThan(0);
});

test("existing auth 401 handling clears the cached member and redirects to login", async ({ page }) => {
  await installFixtures(page, { authMeStatus: 401 });
  await page.goto(`/organisations/${organisation.id}`);
  await expect.poll(() => page.url()).toContain("/login");
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("agcas_member"))).toBeNull();
});
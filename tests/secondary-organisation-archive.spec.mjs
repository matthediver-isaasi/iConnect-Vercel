import { test, expect } from "@playwright/test";

const memberId = "archive-member";
const viewerId = "archive-viewer";
const secondaryObjectId = "secondary-organisation-object";
const secondaryRecordId = "secondary-organisation-record";
const departmentObjectId = "department-object";
const departmentRecordId = "department-record";
const secondaryDefinitionId = "secondary-organisation-assignment";
const departmentDefinitionId = "department-assignment";
const secondaryLabel = "Northside Trading";
const departmentLabel = "Membership Services";
const memberPath = `/members/${memberId}`;

const viewer = {
  id: viewerId,
  tenant_id: "archive-tenant",
  organization_id: "primary-organisation",
  role_id: "archive-role",
  email: "archive-viewer@example.invalid",
  first_name: "Archive",
  last_name: "Viewer",
  member_excluded_features: [],
};

const member = {
  id: memberId,
  tenant_id: viewer.tenant_id,
  organization_id: "primary-organisation",
  role_id: viewer.role_id,
  email: "member@example.invalid",
  first_name: "Alex",
  last_name: "Member",
  login_enabled: true,
  member_excluded_features: [],
};

const makeDefinition = ({
  id,
  objectId,
  targetLabel,
  editable,
}) => ({
  id,
  status: "active",
  cardinality: "many_to_many",
  source_kind: "custom_object",
  source_custom_object_id: objectId,
  target_kind: "member",
  source_label: "Assigned members",
  target_label: targetLabel,
  show_on_source: true,
  show_on_target: true,
  edit_from_source: true,
  edit_from_target: editable,
  can_edit: editable,
});

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page, baseURL, {
  archiveRecords = true,
  editable = false,
  requiredConflict = false,
} = {}) {
  const origin = new URL(baseURL).origin;
  const secondaryDefinition = makeDefinition({
    id: secondaryDefinitionId,
    objectId: secondaryObjectId,
    targetLabel: "Secondary organisations",
    editable,
  });
  const departmentDefinition = makeDefinition({
    id: departmentDefinitionId,
    objectId: departmentObjectId,
    targetLabel: "Departments",
    editable: false,
  });
  const state = {
    secondaryPresent: true,
    requests: [],
    mutations: [],
    unexpected: [],
    relationshipCalls: {
      [secondaryDefinitionId]: 0,
      [departmentDefinitionId]: 0,
    },
  };
  const settings = [{
    id: "member-layout",
    setting_key: "member_detail_layout_config",
    setting_value: JSON.stringify({
      cards: [{
        id: "archive-related-records",
        title: "Organisation assignments",
        columns: 1,
        fields: [{
          id: `relationship:${secondaryDefinitionId}:target`,
          type: "relationship",
          definitionId: secondaryDefinitionId,
          side: "target",
          displayMode: "columns",
          columnIndex: 0,
        }, {
          id: `relationship:${departmentDefinitionId}:target`,
          type: "relationship",
          definitionId: departmentDefinitionId,
          side: "target",
          displayMode: "columns",
          columnIndex: 0,
        }],
      }],
    }),
  }];

  const secondaryRow = {
    relationship_id: "secondary-edge",
    related_kind: "custom_object",
    related_custom_object_id: secondaryObjectId,
    related_record_id: secondaryRecordId,
    related: {
      id: secondaryRecordId,
      kind: "custom_object",
      custom_object_id: secondaryObjectId,
      record_id: secondaryRecordId,
      primary_label: secondaryLabel,
      secondary_text: "Secondary organisation",
    },
  };
  const departmentRow = {
    relationship_id: "department-edge",
    related_kind: "custom_object",
    related_custom_object_id: departmentObjectId,
    related_record_id: departmentRecordId,
    related: {
      id: departmentRecordId,
      kind: "custom_object",
      custom_object_id: departmentObjectId,
      record_id: departmentRecordId,
      primary_label: departmentLabel,
      secondary_text: "Department",
    },
  };

  await page.addInitScript(() => {
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.context().routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.pathname !== "/realtime/v1/websocket"
      && !(url.hostname === new URL(origin).hostname && url.pathname === "/")) {
      state.unexpected.push(`WEBSOCKET ${url.origin}${url.pathname}`);
    }
    socket.onMessage(() => {});
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const description = `${method} ${url.origin}${path}`;
    const reject = () => {
      state.unexpected.push(description);
      return json(route, { error: `Unexpected fixture request: ${description}` }, 599);
    };

    if (path.startsWith("/api/")) {
      if (url.origin !== origin) return reject();
      state.requests.push(`${method} ${path}${url.search}`);

      if (path === `/api/custom-objects/${secondaryObjectId}/records/${secondaryRecordId}`
        && method === "DELETE") {
        state.mutations.push({
          method,
          path,
          body: request.postDataJSON(),
        });
        state.secondaryPresent = false;
        return json(route, { id: secondaryRecordId, archived_at: "2026-09-19T12:00:00.000Z" });
      }
      if (path === `/api/custom-objects/core/relationships/secondary-edge`
        && method === "DELETE") {
        state.mutations.push({
          method,
          path,
          body: request.postDataJSON(),
        });
        if (requiredConflict) {
          return json(route, {
            error: "This relationship is required",
            details: {
              code: "REQUIRED_RELATIONSHIP",
              archive_record: {
                object_id: secondaryObjectId,
                record_id: secondaryRecordId,
                label: secondaryLabel,
              },
            },
          }, 409);
        }
        state.secondaryPresent = false;
        return json(route, { success: true });
      }
      if (!["GET", "HEAD"].includes(method)) return reject();

      if (path === "/api/auth/me") return json(route, viewer);
      if (path === "/api/auth/tenant-user-me") return json(route, {
        authenticated: true,
        user: viewer,
        tenant: { id: viewer.tenant_id, slug: "fixture" },
        tenantId: viewer.tenant_id,
        memberId: viewer.id,
      });
      if (path === `/api/entities/Role/${viewer.role_id}`) {
        return json(route, { id: viewer.role_id, name: "Administrator", excluded_features: [] });
      }
      if (path === "/api/entities/Role") {
        return json(route, [{ id: viewer.role_id, name: "Administrator", excluded_features: [] }]);
      }
      if (path === `/api/entities/Member/${viewer.id}`) return json(route, viewer);
      if (path === `/api/entities/Member/${memberId}`) {
        return json(route, {
          ...member,
          capabilities: { edit_records: editable },
        });
      }
      // Keep the shell's optional last-activity lookup empty so it does not
      // issue its unrelated navigation-time PATCH.
      if (path === "/api/entities/Member") return json(route, []);
      if (path === "/api/entities/SystemSettings") return json(route, settings);
      if (path === "/api/entities/Organization") {
        return json(route, [{
          id: member.organization_id,
          tenant_id: viewer.tenant_id,
          name: "Primary Organisation",
        }]);
      }
      if (path === `/api/entities/Organization/${member.organization_id}`) {
        return json(route, {
          id: member.organization_id,
          tenant_id: viewer.tenant_id,
          name: "Primary Organisation",
        });
      }
      if (path === "/api/admin/organizations/paginated") {
        return json(route, {
          organizations: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        });
      }
      if (path === "/api/custom-objects") return json(route, { data: [], total: 0 });
      if (path === `/api/custom-objects/${secondaryObjectId}`) {
        return json(route, {
          id: secondaryObjectId,
          singular_label: "Secondary organisation",
          plural_label: "Secondary organisations",
          status: "active",
          capabilities: { archive_records: archiveRecords, edit_records: false },
        });
      }
      if (path === `/api/custom-objects/${departmentObjectId}`) {
        return json(route, {
          id: departmentObjectId,
          singular_label: "Department",
          plural_label: "Departments",
          status: "active",
          capabilities: { archive_records: false, edit_records: false },
        });
      }
      if (path === "/api/custom-objects/core/relationship-definitions") {
        return json(route, {
          data: [
            { definition: secondaryDefinition, side: "target", count: state.secondaryPresent ? 1 : 0 },
            { definition: departmentDefinition, side: "target", count: 1 },
          ],
          total: 2,
        });
      }
      if (path === "/api/custom-objects/core/relationships") {
        const definitionId = url.searchParams.get("definitionId");
        expect(url.searchParams.get("kind")).toBe("member");
        expect(url.searchParams.get("recordId")).toBe(memberId);
        expect(url.searchParams.get("side")).toBe("target");
        state.relationshipCalls[definitionId] += 1;
        const rows = definitionId === secondaryDefinitionId
          ? (state.secondaryPresent ? [secondaryRow] : [])
          : definitionId === departmentDefinitionId ? [departmentRow] : [];
        return json(route, { data: rows, total: rows.length, pageSize: 10 });
      }
      if (path === "/api/custom-objects/core/relationship-panel-preference") {
        return json(route, { preference: null });
      }
      if (path === "/api/communication/inbox/unread-count") return json(route, { count: 0 });
      if (path === "/api/admin/form-submissions/stats") return json(route, { total: 0, pending: 0 });
      if ([
        "/api/public/favicon-url", "/api/public/portal-branding",
        "/api/public/tenant-branding", "/api/public/ai-help-persona",
        "/api/public/form-consent-message",
      ].includes(path)) return json(route, {});
      if ([
        "/api/entities/PreferenceField", "/api/entities/RoleAccessItem",
        "/api/entities/MemberGroupAssignment", "/api/entities/PortalMenu",
        "/api/entities/Booking", "/api/entities/OrganizationGroup",
        "/api/entities/MemberType", "/api/entities/MemberStatus",
        "/api/public/system-settings", "/api/public/microsites",
        "/api/public/installed-fonts", "/api/bookmarks/enriched",
        "/api/bookmarks", "/api/zoom/webinars",
      ].includes(path)) return json(route, []);
      return json(route, []);
    }

    if (url.hostname.endsWith(".supabase.co")
      && ["/rest/v1/member", "/rest/v1/floater", "/rest/v1/form"].includes(path)) {
      return json(route, []);
    }
    if ((url.hostname === "fonts.googleapis.com" && path === "/css2")
      || (url.hostname === "cdnjs.cloudflare.com"
        && path === "/ajax/libs/font-awesome/6.5.2/css/all.min.css")) {
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    }
    if ((url.hostname === "js.stripe.com" && path === "/clover/stripe.js")
      || (url.hostname === "va.vercel-scripts.com" && path === "/v1/script.debug.js")) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    }
    if ((url.hostname === "teeone.pythonanywhere.com"
        && path === "/font-assets/Degular-Medium.woff")
      || (url.hostname === "qtrypzzcjebvfcihiynt.supabase.co"
        && path === "/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/fe03f7c5e_linked-aa.png")) {
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.origin === origin && (
      path === memberPath || path.startsWith("/src/") || path.startsWith("/@")
      || path.startsWith("/node_modules/") || path.startsWith("/assets/")
      || path === "/favicon.ico"
    )) return route.continue();
    return reject();
  });
  return state;
}

function panel(page, heading) {
  return page.getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
}

async function openMemberFixture(page) {
  await page.goto(memberPath);
  await expect(page.getByText("Alex Member", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(secondaryLabel, { exact: true })).toBeVisible();
  await expect(page.getByText(departmentLabel, { exact: true })).toBeVisible();
}

test("member archive confirmation can be cancelled without any mutation", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL);
  try {
    await openMemberFixture(page);
    await page.getByRole("button", { name: `Archive ${secondaryLabel}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Archive ${secondaryLabel}?`, exact: true });
    await expect(dialog).toContainText("separate from removing only this link");
    await expect(dialog).toContainText("relationships between other records");
    await page.screenshot({
      path: "screenshots/secondary-organisation-archive-confirmation.png",
      fullPage: false,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(secondaryLabel, { exact: true })).toBeVisible();
    await expect(page.getByText(departmentLabel, { exact: true })).toBeVisible();
    expect(state.mutations).toEqual([]);
  } finally {
    expect(state.unexpected, "Every unexpected request is blocked").toEqual([]);
  }
});

test("confirmed archive uses the record DELETE endpoint and refreshes row and count", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL);
  try {
    await openMemberFixture(page);
    const secondaryPanel = panel(page, "Secondary organisations");
    await expect(secondaryPanel.getByText("1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Archive ${secondaryLabel}`, exact: true }).click();
    await page.getByRole("dialog", { name: `Archive ${secondaryLabel}?`, exact: true })
      .getByRole("button", { name: "Archive record", exact: true }).click();

    await expect.poll(() => state.mutations).toEqual([{
      method: "DELETE",
      path: `/api/custom-objects/${secondaryObjectId}/records/${secondaryRecordId}`,
      body: { archive_reason: null },
    }]);
    await expect(secondaryPanel.getByText(secondaryLabel, { exact: true })).toHaveCount(0);
    await expect(secondaryPanel.getByText("0", { exact: true })).toBeVisible();
    await expect(secondaryPanel).toContainText("No secondary organisations linked yet.");
    await expect(page.getByText(departmentLabel, { exact: true })).toBeVisible();
    expect(state.relationshipCalls[secondaryDefinitionId]).toBeGreaterThan(1);
  } finally {
    expect(state.unexpected, "Every unexpected request is blocked").toEqual([]);
  }
});

test("object archive permission is fail-closed and independent of edit rights", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL, { archiveRecords: false, editable: true });
  try {
    await openMemberFixture(page);
    await expect(page.getByRole("button", { name: `Archive ${secondaryLabel}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Remove link to ${secondaryLabel}`, exact: true })).toBeVisible();
    await expect(page.getByText(departmentLabel, { exact: true })).toBeVisible();
    expect(state.mutations).toEqual([]);
  } finally {
    expect(state.unexpected, "Every unexpected request is blocked").toEqual([]);
  }
});

test("required unlink explains the conflict before an explicit separate archive", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL, { editable: true, requiredConflict: true });
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await openMemberFixture(page);
    await page.getByRole("button", { name: `Remove link to ${secondaryLabel}`, exact: true }).click();
    const required = page.getByRole("dialog", { name: "This link is required", exact: true });
    await expect(required).toContainText("No records have been changed");
    await expect(required).toContainText("archive the related record");
    await expect(page.getByText(secondaryLabel, { exact: true })).toBeVisible();
    await expect(page.getByText(departmentLabel, { exact: true })).toBeVisible();
    expect(state.mutations).toHaveLength(1);
    expect(state.mutations[0].path).toBe("/api/custom-objects/core/relationships/secondary-edge");

    await required.getByRole("button", { name: "Review archive option", exact: true }).click();
    const archive = page.getByRole("dialog", { name: `Archive ${secondaryLabel}?`, exact: true });
    await expect(archive).toBeVisible();
    await expect(page.getByText(departmentLabel, { exact: true })).toBeVisible();
    await archive.getByRole("button", { name: "Archive record", exact: true }).click();

    await expect.poll(() => state.mutations.length).toBe(2);
    expect(state.mutations[1]).toEqual({
      method: "DELETE",
      path: `/api/custom-objects/${secondaryObjectId}/records/${secondaryRecordId}`,
      body: { archive_reason: null },
    });
    await expect(page.getByText(secondaryLabel, { exact: true })).toHaveCount(0);
    await expect(page.getByText(departmentLabel, { exact: true })).toBeVisible();
  } finally {
    expect(state.unexpected, "Every unexpected request is blocked").toEqual([]);
  }
});
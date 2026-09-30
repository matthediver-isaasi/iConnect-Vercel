import { test, expect } from "@playwright/test";

// Transport-contract regression for the EXISTING record page, not a replacement
// component. These are the service's post-filter response fixtures. Backend
// service tests separately prove which database members are filtered; this suite
// deliberately does not implement a second deletion predicate in its mocks.
const objectId = "deleted-members-object";
const recordId = "deleted-members-record";
const definitionId = "deleted-members-relationship";
const recordPath = `/CustomObjectsAdmin/${objectId}/records/${recordId}`;
const definition = {
  id: definitionId,
  status: "active",
  cardinality: "many_to_many",
  source_kind: "custom_object",
  source_custom_object_id: objectId,
  target_kind: "member",
  source_label: "Team members",
  target_label: "Projects",
  show_on_source: true,
  show_on_target: true,
  edit_from_source: true,
  edit_from_target: true,
  can_edit: true,
};
const viewer = {
  id: "deleted-members-viewer",
  tenant_id: "deleted-members-tenant",
  organization_id: "deleted-members-org",
  role_id: "deleted-members-role",
  email: "viewer@example.invalid",
  first_name: "Regression",
  last_name: "Viewer",
  member_excluded_features: [],
};
const eligibleMembers = [
  { id: "active-member", primary_label: "Alice Active", secondary_text: "alice@example.invalid", login_enabled: true },
  { id: "ordinary-deleted-name", primary_label: "Deleted Member", secondary_text: "ordinary@example.invalid", login_enabled: true },
  { id: "disabled-member", primary_label: "Diana Disabled", secondary_text: "disabled@example.invalid", login_enabled: false },
  { id: "null-email-member", primary_label: "No Email", secondary_text: null, email: null, login_enabled: true },
  { id: "disabled-null-email-member", primary_label: "Disabled No Email", secondary_text: null, email: null, login_enabled: false },
].map((member) => ({ kind: "member", ...member }));
const forbiddenIdentities = [
  "anonymized-member",
  "deleted_anonymized-member@deleted.local",
  "soft-deleted-member",
  "soft-deleted@example.invalid",
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixtures(page, baseURL, { displayMode = "columns", allDeleted = false } = {}) {
  const origin = new URL(baseURL).origin;
  const state = { unexpected: [], requests: [], pickerSearches: [], relationshipCalls: 0 };
  const capabilities = {
    view: true, can_view_records: true, can_create_records: true,
    can_edit_records: true, can_archive_records: true,
  };
  const object = {
    id: objectId,
    tenant_id: viewer.tenant_id,
    object_key: "deleted_member_regression",
    singular_label: "Project",
    plural_label: "Projects",
    status: "active",
    capabilities,
    presentation: {
      detail: {
        cards: [{
          id: "team-card",
          title: "Project team",
          columns: 1,
          fields: [{
            id: `relationship:${definitionId}:source`,
            type: "relationship",
            definitionId,
            side: "source",
            displayMode,
            columnIndex: 0,
          }],
        }],
      },
    },
  };
  const record = {
    id: recordId, display_value: "Member visibility regression",
    updated_at: "2026-09-18T10:00:00.000Z", archived_at: null,
    data: {}, capabilities,
  };
  const members = allDeleted ? [] : eligibleMembers;
  const role = { id: viewer.role_id, name: "Administrator", excluded_features: [] };
  await page.addInitScript(() => {
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
    localStorage.clear();
    sessionStorage.clear();
  });
  // Never connect a routed websocket to a server. Realtime and Vite are
  // explicitly inert in this fixture; any other socket fails the test.
  await page.context().routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.pathname !== "/realtime/v1/websocket"
      && !((url.hostname === new URL(origin).hostname) && url.pathname === "/")) {
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
      return json(route, { error: `Unexpected fixture network request: ${description}` }, 599);
    };
    // Check the verb BEFORE dispatch: not even an otherwise-known route can
    // accidentally turn into a live or fabricated successful write.
    if (method !== "GET" && method !== "HEAD") return reject();
    if (path.startsWith("/api/")) {
      if (url.origin !== origin) return reject();
      state.requests.push(`${method} ${path}${url.search}`);
      if (path === "/api/auth/me") return json(route, viewer);
      if (path === "/api/auth/tenant-user-me") return json(route, {
        authenticated: true, user: viewer,
        tenant: { id: viewer.tenant_id, slug: "fixture" },
        tenantId: viewer.tenant_id, memberId: viewer.id,
      });
      if (path === `/api/entities/Role/${role.id}`) return json(route, role);
      if (path === `/api/entities/Member/${viewer.id}`) return json(route, viewer);
      // This is the shell's optional last-activity lookup, not the relationship
      // picker. An empty fixture avoids the unrelated navigation-time PATCH;
      // all writes remain forbidden rather than fabricated successful writes.
      if (path === "/api/entities/Member") return json(route, []);
      if (path === "/api/communication/inbox/unread-count") return json(route, { count: 0 });
      if (path === "/api/admin/form-submissions/stats") return json(route, { total: 0, pending: 0 });
      if ([
        "/api/public/favicon-url", "/api/public/portal-branding",
        "/api/public/tenant-branding", "/api/public/ai-help-persona",
        "/api/public/form-consent-message",
      ].includes(path)) return json(route, {});
      if ([
        "/api/public/system-settings", "/api/public/microsites", "/api/public/installed-fonts",
        "/api/entities/Organization", "/api/entities/SystemSettings",
        "/api/entities/RoleAccessItem", "/api/entities/MemberGroupAssignment",
        "/api/entities/PortalMenu", "/api/entities/Booking",
        "/api/bookmarks/enriched", "/api/bookmarks", "/api/zoom/webinars",
      ].includes(path)) return json(route, []);
      if (path === "/api/custom-objects") return json(route, { data: [object], total: 1 });
      if (path === `/api/custom-objects/${objectId}`) return json(route, object);
      if (path === `/api/custom-objects/${objectId}/fields`) return json(route, { data: [], total: 0 });
      if (path === `/api/custom-objects/${objectId}/records/${recordId}`) return json(route, record);
      if (path === `/api/custom-objects/${objectId}/relationship-definitions`) {
        return json(route, { data: [{ definition, side: "source" }], total: 1 });
      }
      if (path === "/api/custom-objects/core/relationship-panel-preference") {
        return json(route, { preference: null });
      }
      if (path === `/api/custom-objects/${objectId}/relationships`
        || path === `/api/custom-objects/${objectId}/entity-picker`) {
        expect(url.searchParams.get("recordId")).toBe(recordId);
        expect(url.searchParams.get("definitionId")).toBe(definitionId);
        expect(url.searchParams.get("side")).toBe("source");
        expect(url.searchParams.get("page")).toBe("1");
        expect(url.searchParams.get("pageSize")).toBe("10");
        if (path.endsWith("/relationships")) {
          state.relationshipCalls += 1;
          return json(route, {
            data: members.map((member) => ({
              relationship_id: `edge-${member.id}`,
              related_kind: "member",
              related_record_id: member.id,
              related: member,
            })),
            total: members.length, pageSize: 10, definition,
          });
        }
        const search = url.searchParams.get("search") || "";
        state.pickerSearches.push(search);
        const data = members.filter((member) =>
          `${member.primary_label} ${member.secondary_text || ""}`.toLowerCase().includes(search.toLowerCase()));
        return json(route, { data, total: data.length, pageSize: 10 });
      }
      return reject();
    }
    // The real portal shell imports these optional providers/assets. Supply
    // inert local responses rather than allowing a network escape. No Stripe,
    // analytics, font host, storage host or Supabase connection is made.
    if (url.hostname.endsWith(".supabase.co")
      && ["/rest/v1/member", "/rest/v1/floater", "/rest/v1/form"].includes(path)) {
      return json(route, []);
    }
    if ((url.hostname === "fonts.googleapis.com" && path === "/css2")
      || (url.hostname === "cdnjs.cloudflare.com" && path === "/ajax/libs/font-awesome/6.5.2/css/all.min.css")) {
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    }
    if ((url.hostname === "js.stripe.com" && path === "/clover/stripe.js")
      || (url.hostname === "va.vercel-scripts.com" && path === "/v1/script.debug.js")) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    }
    if ((url.hostname === "teeone.pythonanywhere.com" && path === "/font-assets/Degular-Medium.woff")
      || (url.hostname === "qtrypzzcjebvfcihiynt.supabase.co"
        && path === "/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/fe03f7c5e_linked-aa.png")) {
      return route.fulfill({ status: 204, body: "" });
    }
    // Only local development assets and the exact document route may reach
    // the preview server. All API, Supabase, external fetch and mutations are
    // intercepted above or rejected below.
    if (url.origin === origin && (
      path === recordPath || path.startsWith("/src/") || path.startsWith("/@")
      || path.startsWith("/node_modules/") || path.startsWith("/assets/")
      || path === "/favicon.ico"
    )) return route.continue();
    return reject();
  });
  return state;
}

function panel(page) {
  return page.getByRole("heading", { name: "Team members", exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
}

async function assertNoDeletedIdentity(locator) {
  for (const identity of forbiddenIdentities) {
    await expect(locator).not.toContainText(identity);
    await expect(locator.locator(`a[href*="${identity}"]`)).toHaveCount(0);
  }
  await expect(locator).not.toContainText(/deleted_.*@deleted\.local/i);
}

for (const displayMode of ["columns", "cards"]) {
  test(`${displayMode}: five eligible members, accurate badge and filtered Add link search`, async ({ page, baseURL }) => {
    const state = await installFixtures(page, baseURL, { displayMode });
    try {
      await page.goto(recordPath);
      await expect(page.getByRole("heading", { name: "Member visibility regression", exact: true })).toBeVisible();
      const team = panel(page);
      await expect(team).toBeVisible();
      await expect(team.getByRole("heading", { name: "Team members" }).locator("..").getByText("5", { exact: true })).toBeVisible();
      await expect(team.locator(displayMode === "cards" ? "article" : "tbody tr")).toHaveCount(5);
      for (const member of eligibleMembers) {
        await expect(team.getByText(member.primary_label, { exact: true })).toBeVisible();
        await expect(team.locator(`a[href="/members/${member.id}"]`)).toHaveCount(1);
      }
      await assertNoDeletedIdentity(team);
      await page.screenshot({ path: `screenshots/hide-deleted-member-relationships-${displayMode}.png`, fullPage: true });
      await team.getByRole("button", { name: "Add link", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "Add Team members" });
      await expect(picker.getByText("5 available", { exact: true })).toBeVisible();
      for (const member of eligibleMembers) {
        await expect(picker.getByText(member.primary_label, { exact: true })).toBeVisible();
      }
      await assertNoDeletedIdentity(picker);
      for (const [search, names] of [
        ["Deleted", ["Deleted Member"]],
        ["Disabled", ["Diana Disabled", "Disabled No Email"]],
        ["No Email", ["No Email", "Disabled No Email"]],
        ["deleted_anonymized-member@deleted.local", []],
        ["soft-deleted@example.invalid", []],
      ]) {
        await picker.getByPlaceholder("Search records").fill(search);
        await picker.getByRole("button", { name: "Search", exact: true }).click();
        await expect.poll(() => state.pickerSearches.at(-1)).toBe(search);
        await expect(picker.getByText(`${names.length} available`, { exact: true })).toBeVisible();
        for (const name of names) await expect(picker.getByText(name, { exact: true })).toBeVisible();
        if (!names.length) await expect(picker.getByText("No matching records found.")).toBeVisible();
        await assertNoDeletedIdentity(picker);
        if (search === "Deleted") {
          await page.screenshot({
            path: `screenshots/hide-deleted-member-relationships-picker-${displayMode}.png`,
            fullPage: true,
          });
        }
      }
      expect(state.relationshipCalls).toBeGreaterThan(0);
    } finally {
      expect(state.unexpected, "Every unexpected network request is blocked and fails the test").toEqual([]);
    }
  });

  test(`${displayMode}: all deleted relationships show empty state and badge zero`, async ({ page, baseURL }) => {
    const state = await installFixtures(page, baseURL, { displayMode, allDeleted: true });
    try {
      await page.goto(recordPath);
      const team = panel(page);
      await expect(team.getByText("No team members linked yet.", { exact: true })).toBeVisible();
      await expect(team.getByRole("heading", { name: "Team members" }).locator("..").getByText("0", { exact: true })).toBeVisible();
      await expect(team.locator("tbody tr, article")).toHaveCount(0);
      await assertNoDeletedIdentity(team);
      await page.screenshot({ path: `screenshots/hide-deleted-member-relationships-empty-${displayMode}.png`, fullPage: true });
      await team.getByRole("button", { name: "Add link", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "Add Team members" });
      await expect(picker.getByText("0 available", { exact: true })).toBeVisible();
      await expect(picker.getByText("No matching records found.", { exact: true })).toBeVisible();
      await assertNoDeletedIdentity(picker);
      expect(state.relationshipCalls).toBeGreaterThan(0);
    } finally {
      expect(state.unexpected, "Every unexpected network request is blocked and fails the test").toEqual([]);
    }
  });
}
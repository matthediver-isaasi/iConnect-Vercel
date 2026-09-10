import assert from "node:assert/strict";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createOrganisationDirectoryFilters } from "../api/_lib/organisationDirectoryFilters.js";

const TENANT_ID = "ff2df806-b321-4254-b651-3af11fccf1db";
const OBJECT_ID = "cd1ebfd3-3e16-4091-be5a-99992d926f2f";
const FIELD_KEY = "object-field:30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e:target:cd1ebfd3-3e16-4091-be5a-99992d926f2f:35e4f2dd-6f22-4875-8d2f-4ffb05b1980f";
const FIELD_LABEL = "Organisation department: Name (Departments)";

const db = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false } },
);

async function rows(query, message) {
  const result = await query;
  if (result.error) throw new Error(`${message}: ${result.error.message}`);
  return result.data || [];
}

async function realAllowedContext() {
  // BNMS intentionally has no member-role Custom Object grant for this
  // Department source. Its configured directory is managed/viewed through the
  // tenant-admin path, so use an existing tenant_user ID without reading any
  // identity/contact columns or fabricating a member grant.
  const tenantUsers = await rows(
    db.from("tenant_user")
      .select("id")
      .eq("tenant_id", TENANT_ID)
      .order("id", { ascending: true })
      .limit(1),
    "Role-appropriate tenant administrator",
  );
  assert.equal(tenantUsers.length, 1, "A real BNMS tenant administrator context is required");
  return {
    tenantId: TENANT_ID,
    roleId: null,
    organizationId: null,
    tenantUserId: tenantUsers[0].id,
    isAuthenticated: true,
  };
}

test("destination-backed directory source filter renders, selects, sorts, pages, and clears", async ({
  page,
}, testInfo) => {
  const realContext = await realAllowedContext();
  const service = createOrganisationDirectoryFilters({
    db,
    context: realContext,
    isAdmin: true,
  });
  const direct = { selectionTotals: [] };

  const metadata = await service.metadata();
  assert.deepEqual(metadata.fields, [{
    key: FIELD_KEY,
    label: FIELD_LABEL,
    field_type: "text",
    control: "source-choice",
    options: [],
    multi_select: false,
  }]);
  const allOptions = await service.options({
    action: "options",
    fieldKey: FIELD_KEY,
    search: "",
    page: 1,
    pageSize: 50,
    selected: [],
  });
  assert.equal(allOptions.total, 7);
  const search = (filters = {}, extra = {}) => service.search({
    filters,
    search: "",
    sort: "asc",
    page: 1,
    pageSize: 12,
    ...extra,
  });
  const initial = await search();
  assert.equal(initial.total, 279);
  assert.deepEqual(Object.keys(initial).sort(), [
    "fields", "organizations", "page", "pageSize", "total",
  ]);
  assert.ok(initial.organizations.every((organization) =>
    Object.keys(organization).sort().join(",") === "id,name"));
  for (const [index, option] of allOptions.options.entries()) {
    const selected = await search({ [FIELD_KEY]: { operator: "eq", value: option.value } });
    assert.ok(selected.total > 0);
    direct.selectionTotals.push({ option: index + 1, total: selected.total });
  }
  assert.deepEqual(await search(), initial);
  const descendingOne = await search({}, { sort: "desc", page: 1, pageSize: 5 });
  const descendingTwo = await search({}, { sort: "desc", page: 2, pageSize: 5 });
  const ascendingTail = await search({}, { sort: "asc", page: 3, pageSize: 100 });
  assert.equal(descendingOne.total, 279);
  assert.equal(descendingTwo.total, 279);
  assert.equal(new Set(
    [...descendingOne.organizations, ...descendingTwo.organizations].map(({ id }) => id),
  ).size, 10);
  assert.deepEqual(
    descendingOne.organizations.map(({ id }) => id),
    ascendingTail.organizations.slice(-5).reverse().map(({ id }) => id),
  );

  const state = { filterPosts: [], blockedWrites: [] };
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const harnessMember = {
    id: "directory-destination-harness-member",
    tenant_id: TENANT_ID,
    role_id: "directory-destination-harness-role",
    organization_id: "directory-destination-harness-organization",
    email: "directory-destination-harness@example.invalid",
    first_name: "Destination",
    last_name: "Harness",
    member_excluded_features: [],
  };
  const harnessRole = {
    id: harnessMember.role_id,
    name: "Directory harness",
    excluded_features: [],
  };
  await page.context().route("**/rest/v1/**", (route) => {
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) state.blockedWrites.push(method);
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    // Vite source modules also contain /api/ in their paths; those are not API
    // requests and must be served unchanged.
    if (!path.startsWith("/api/")) return route.continue();
    const method = request.method();
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") {
      return json(harnessMember);
    }
    if (path === "/api/auth/tenant-user-me") {
      return json({
        user: harnessMember,
        tenant: { id: TENANT_ID, slug: "bnms" },
      });
    }
    if (path === "/api/organisation-directory/filters") {
      if (method === "GET") return json(await service.metadata());
      const body = request.postDataJSON();
      state.filterPosts.push(body);
      return json(body?.action === "options"
        ? await service.options(body)
        : await service.search(body));
    }
    if (path === "/api/organisation-directory/custom-object-fields") return json({ sources: [] });
    if (path === "/api/entities/SystemSettings") {
      return json([
        { setting_key: "org_directory_header", setting_value: "Organisation Directory" },
        { setting_key: "org_directory_show_logo", setting_value: "false" },
        { setting_key: "org_directory_show_domains", setting_value: "false" },
        { setting_key: "org_directory_show_member_count", setting_value: "false" },
        { setting_key: "org_directory_cards_per_row", setting_value: "3" },
      ]);
    }
    if (path === "/api/entities/Member") return json([]);
    if (path === `/api/entities/Member/${harnessMember.id}`) return json(harnessMember);
    if (path === "/api/entities/Role") return json([harnessRole]);
    if (path === `/api/entities/Role/${harnessRole.id}`) return json(harnessRole);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.blockedWrites.push(`${method} ${path}`);
      return json({ error: "Mutation blocked by read-only harness" }, 599);
    }
    return json([]);
  });

  await page.goto("/OrganisationDirectory");
  await expect(page.getByText("279 organisations", { exact: true }), pageErrors.join("; ")).toBeVisible();
  const choices = page.getByRole("radiogroup", { name: `${FIELD_LABEL} options` });
  await expect(choices.locator('input[type="radio"]')).toHaveCount(7);
  await choices.locator('input[type="radio"]').first().check();
  await expect.poll(() => state.filterPosts.at(-1)?.filters?.[FIELD_KEY]?.operator).toBe("eq");
  await expect(page.getByText("279 organisations", { exact: true })).not.toBeVisible();
  await page.getByTestId("select-sort-order").click();
  await page.getByText("Z-A", { exact: true }).click();
  await expect.poll(() => state.filterPosts.at(-1)?.sort).toBe("desc");
  await page.getByRole("button", { name: `Clear ${FIELD_LABEL}` }).click();
  await expect(page.getByText("279 organisations", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "/tmp/directory-source-values-destination.png",
    fullPage: true,
  });
  expect(state.blockedWrites).toEqual([]);
  await testInfo.attach("task-4360-safe-summary.json", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({
      harness: "local fixture identity; real role permissions and DEST service reads",
      unfilteredTotal: initial.total,
      optionsTotal: allOptions.total,
      selectionTotals: direct.selectionTotals,
      metadataFields: metadata.fields,
      clearVerified: true,
      sortAndPagesVerified: true,
      liveWrites: 0,
    }, null, 2)),
  });
});
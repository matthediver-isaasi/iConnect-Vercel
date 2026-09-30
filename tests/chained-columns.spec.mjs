import { test, expect } from "@playwright/test";

const OBJECT_ID = "chained-columns-object";
const CHAIN_ID = "chain-example";
const TENANT_ID = "chained-columns-tenant";
const MEMBER_ID = "chained-columns-member";
const SETTINGS_KEY = `crm_custom_object_views_${MEMBER_ID}_${OBJECT_ID}`;

const member = {
  id: MEMBER_ID,
  tenant_id: TENANT_ID,
  organization_id: null,
  role_id: "chained-columns-role",
  email: "chained-columns@example.invalid",
  first_name: "Chained",
  last_name: "Columns",
  member_excluded_features: [],
};

const role = {
  id: member.role_id,
  name: "Chained columns browser role",
  excluded_features: [],
  default_landing_page: "CustomObjectsAdmin",
};

const chainedColumn = {
  id: CHAIN_ID,
  kind: "chained",
  version: 1,
  path: [{ relationship_definition_id: "dept-org", from_side: "source" }],
  endpoint: { kind: "organization", custom_object_id: null },
  terminal: { kind: "label" },
  label: "Department → Organisation",
  sortable: false,
  filterable: false,
};

const record = (id, display_value, values, count = values.length) => ({
  id,
  custom_object_id: OBJECT_ID,
  display_value,
  data: {},
  chained_values: {
    [CHAIN_ID]: { records: values.map((label) => ({ label })), count },
  },
  updated_at: "2026-01-01T00:00:00.000Z",
});

const records = [
  record("department-1", "First department", ["Example Org"]),
  record("department-2", "Second department", ["Alpha", "Beta", "Gamma"], 5),
  record("department-3", "Third department", []),
];

function json(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function installFixtures(page, { noRootFields = false } = {}) {
  const requests = [];
  let settings = [];
  let nextSettingsId = 1;
  let chainUnavailable = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname, searchParams } = url;
    if (!pathname.startsWith("/api/")) return route.continue();
    requests.push({ pathname, search: url.search });

    if (pathname === "/api/auth/me") return json(route, member);
    if (pathname === "/api/public/portal-branding") {
      return json(route, {
        logoUrl: "", logoHeight: "medium", logoLink: "", homePageSlug: "",
        faviconUrl: "", tenantName: "Chained columns fixture",
      });
    }
    if (pathname === "/api/public/system-settings") return json(route, []);
    if (pathname === "/api/public/navigation-items"
      || pathname === "/api/public/banners"
      || pathname === "/api/public/resource-categories") return json(route, []);
    if (pathname === "/api/public/ai-help-persona") return json(route, { name: "Fixture helper" });
    if (pathname === `/api/entities/Role/${role.id}`) return json(route, role);
    if (pathname === `/api/entities/Member/${member.id}`) return json(route, member);
    if (pathname === "/api/entities/SystemSettings") {
      if (request.method() === "GET") return json(route, settings);
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() || "{}");
        const row = { id: `settings-${nextSettingsId++}`, ...body };
        settings = [...settings.filter((item) => item.setting_key !== body.setting_key), row];
        return json(route, row, 201);
      }
    }
    const settingId = pathname.match(/^\/api\/entities\/SystemSettings\/([^/]+)$/);
    if (settingId && ["PATCH", "PUT"].includes(request.method())) {
      const body = JSON.parse(request.postData() || "{}");
      settings = settings.map((item) => item.id === settingId[1] ? { ...item, ...body } : item);
      return json(route, settings.find((item) => item.id === settingId[1]) || {});
    }

    if (pathname === `/api/custom-objects/${OBJECT_ID}` && request.method() === "GET") {
      return json(route, {
        id: OBJECT_ID,
        object_key: "departments",
        singular_label: "Department",
        plural_label: "Departments",
        primary_display_field_id: "department-name",
        status: "active",
        capabilities: { view_records: true, export_records: true },
      });
    }
    if (pathname === `/api/custom-objects/${OBJECT_ID}/fields`) {
      return json(route, {
        data: noRootFields ? [] : [{
          id: "department-name",
          name: "name",
          label: "Name",
          field_type: "text",
          is_active: true,
          field_access: "read",
          display_order: 1,
        }],
      });
    }
    if (pathname === `/api/custom-objects/${OBJECT_ID}/records`
      || pathname === `/api/custom-objects/${OBJECT_ID}/export`) {
      const chainedColumns = JSON.parse(searchParams.get("chainedColumns") || "[]");
      expect(chainedColumns).toEqual(chainedColumns.filter((id) => id === CHAIN_ID));
      if (chainUnavailable && chainedColumns.includes(CHAIN_ID)) {
        return json(route, { error: "The selected chained path is no longer available." }, 409);
      }
      const payload = {
        data: records,
        total: records.length,
        metadata: {
          fields: noRootFields ? [] : [{
            id: "department-name", name: "name", label: "Name",
            field_type: "text", is_active: true, field_access: "read", sortable: true,
          }],
          relationships: [],
          chained_columns: [chainedColumn],
        },
      };
      return json(route, payload);
    }

    // The layout makes several unrelated background requests. Returning an
    // empty JSON collection keeps this browser harness isolated and read-only.
    return json(route, []);
  });

  return {
    requests,
    getSettings: () => settings,
    setChainUnavailable: (value) => { chainUnavailable = value; },
  };
}

async function waitForList(page) {
  await expect(page.getByRole("heading", { name: "Departments" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Department", exact: true })).toBeVisible();
  await expect(page.getByText("First department")).toBeVisible();
}

async function toggleChainedColumn(page, checked) {
  await page.getByRole("button", { name: /Columns/ }).click();
  const row = page.locator('[role="dialog"]').getByText(chainedColumn.label).locator("..");
  const checkbox = row.getByRole("checkbox");
  if ((await checkbox.getAttribute("aria-checked")) !== String(checked)) await checkbox.click();
  await page.getByRole("button", { name: "Done" }).click();
}

test("chained columns can be selected, persisted, saved, and exported with bounded summaries", async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto(`/CustomObjectsAdmin/${OBJECT_ID}/records`);
  await waitForList(page);

  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toHaveCount(0);
  await toggleChainedColumn(page, true);
  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toBeVisible();
  await expect(page.getByText("Example Org")).toBeVisible();
  await expect(page.getByText("Alpha, Beta, Gamma +2 more")).toBeVisible();
  await expect(page.locator("table tbody tr").nth(2).locator("td").nth(2))
    .toHaveText("—");

  const listRequest = fixture.requests.find(({ pathname, search }) =>
    pathname === `/api/custom-objects/${OBJECT_ID}/records`
    && JSON.parse(new URLSearchParams(search).get("chainedColumns") || "[]").includes(CHAIN_ID));
  expect(listRequest).toBeTruthy();

  // Reorder and verify the displayed table follows the personal column order.
  await page.getByRole("button", { name: /Columns/ }).click();
  const dialog = page.locator('[role="dialog"]');
  const chainedRow = dialog.getByText(chainedColumn.label).locator("..");
  await chainedRow.dragTo(dialog.getByText("Name").locator(".."));
  await page.getByRole("button", { name: "Done" }).click();
  const headers = page.locator("table thead th");
  await expect(headers.nth(1)).toHaveText(chainedColumn.label);

  // The personal layout survives a reload without server persistence.
  await page.reload();
  await waitForList(page);
  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toBeVisible();
  await expect(page.locator("table thead th").nth(1)).toHaveText(chainedColumn.label);

  // Named saved views include the chained column and can restore it after it
  // is hidden. The fixture captures the exact opaque ID sent to the API.
  await page.getByTestId("button-custom-object-view-switcher").click();
  await page.getByText("Save current as new view...").click();
  await page.getByLabel("View name").fill("Chained departments");
  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page.getByTestId("button-custom-object-view-switcher"))
    .toContainText("Chained departments");
  await toggleChainedColumn(page, false);
  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toHaveCount(0);
  await page.getByTestId("button-custom-object-view-switcher").click();
  await page.getByTestId(/menuitem-custom-object-view-apply-/).click();
  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Export$/ }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv).toContain('"Department → Organisation"');
  expect(csv).toContain('"Example Org"');
  expect(csv).toContain('"Alpha, Beta, Gamma +2 more"');
  expect(csv).toContain('"—"');
  const exportRequest = fixture.requests.find(({ pathname, search }) =>
    pathname === `/api/custom-objects/${OBJECT_ID}/export`
    && JSON.parse(new URLSearchParams(search).get("chainedColumns") || "[]").includes(CHAIN_ID));
  expect(exportRequest).toBeTruthy();
});

test("an unavailable selected chain remains hideable and rows recover", async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto(`/CustomObjectsAdmin/${OBJECT_ID}/records`);
  await waitForList(page);
  fixture.setChainUnavailable(true);

  await toggleChainedColumn(page, true);
  await expect(page.getByText("Records could not be loaded")).toBeVisible();
  await expect(page.getByRole("button", { name: /Columns/ })).toBeVisible();

  // The unavailable selection is deliberately retained in the column list so
  // a user can remove it rather than being trapped on an error state.
  await page.getByRole("button", { name: /Columns/ }).click();
  const dialog = page.locator('[role="dialog"]');
  const chainRow = dialog.getByText(chainedColumn.label).locator("..");
  await expect(chainRow.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  await chainRow.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Done" }).click();

  await expect(page.getByText("First department")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/chained-columns-workspace.png" });
  const failedRequest = fixture.requests.find(({ pathname, search }) =>
    pathname === `/api/custom-objects/${OBJECT_ID}/records`
    && JSON.parse(new URLSearchParams(search).get("chainedColumns") || "[]").includes(CHAIN_ID));
  const recoveryRequest = fixture.requests.find(({ pathname, search }) =>
    pathname === `/api/custom-objects/${OBJECT_ID}/records`
    && JSON.parse(new URLSearchParams(search).get("chainedColumns") || "[]").length === 0);
  expect(failedRequest).toBeTruthy();
  expect(recoveryRequest).toBeTruthy();
});

test("personal chained-column preferences persist when the root has no readable fields", async ({ page }) => {
  const fixture = await installFixtures(page, { noRootFields: true });
  await page.goto(`/CustomObjectsAdmin/${OBJECT_ID}/records`);
  await waitForList(page);
  await toggleChainedColumn(page, true);
  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toBeVisible();

  const storageKey = `custom-object-list:${TENANT_ID}:${MEMBER_ID}:${OBJECT_ID}`;
  await expect.poll(async () => page.evaluate(([key, chainId]) => {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value?.columns?.find((column) => column.id === chainId)?.visible === true;
  }, [storageKey, CHAIN_ID])).toBe(true);

  await page.reload();
  await waitForList(page);
  await expect(page.getByRole("columnheader", { name: chainedColumn.label })).toBeVisible();
  expect(fixture.requests.some(({ pathname, search }) =>
    pathname === `/api/custom-objects/${OBJECT_ID}/records`
    && JSON.parse(new URLSearchParams(search).get("chainedColumns") || "[]").includes(CHAIN_ID))).toBe(true);
});
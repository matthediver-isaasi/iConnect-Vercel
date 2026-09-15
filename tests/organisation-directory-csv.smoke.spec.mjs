import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { projectOrganisationDirectoryCsv } from "../api/_lib/organisationDirectoryCsv.js";

const member = {
  id: "csv-smoke-member",
  tenant_id: "csv-smoke-tenant",
  role_id: "csv-smoke-role",
  email: "csv-smoke@example.invalid",
  first_name: "CSV",
  last_name: "Smoke",
  member_excluded_features: [],
  is_team_member: false,
};

const role = {
  id: member.role_id,
  name: "CSV smoke administrator",
  excluded_features: [],
};

const organisation = {
  id: "csv-smoke-organisation",
  name: "CSV Smoke Organisation",
  domain: "csv-smoke.invalid",
  logo_url: null,
  member_count: 2,
};

const organizations = [organisation];

const departmentField = {
  key: "object:department",
  label: "Department",
  field_type: "text",
  _kind: "object",
  _source: {
    relationship_id: "csv-smoke-departments",
    direction: "source",
    object_id: "csv-smoke-department",
    cardinality: "one_to_many",
  },
};

const officeField = {
  key: "object:office",
  label: "Office",
  field_type: "text",
  _kind: "object",
  _source: {
    relationship_id: "csv-smoke-offices",
    direction: "source",
    object_id: "csv-smoke-office",
    cardinality: "one_to_many",
  },
};

const csvFields = [
  { key: "org_member_count", label: "Member count", _kind: "core" },
  departmentField,
  officeField,
  { key: "org_members_list", label: "Members / contacts list", _kind: "core" },
];

const csvObjectValues = new Map([
  [
    departmentField.key,
    new Map([
      [
        organisation.id,
        [
          { recordId: "department-1", label: "Department", value: "Design" },
          { recordId: "department-2", label: "Department", value: "Engineering" },
        ],
      ],
    ]),
  ],
  [
    officeField.key,
    new Map([
      [
        organisation.id,
        [
          { recordId: "office-1", label: "Office", value: "Aarhus" },
          { recordId: "office-2", label: "Office", value: "Copenhagen" },
          { recordId: "office-3", label: "Office", value: "Odense" },
        ],
      ],
    ]),
  ],
]);

const csvMemberValues = {
  counts: new Map([[organisation.id, 2]]),
  recordCounts: new Map([
    [`${organisation.id}:${departmentField._source.object_id}:department-1`, 1],
    [`${organisation.id}:${departmentField._source.object_id}:department-2`, 1],
    [`${organisation.id}:${officeField._source.object_id}:office-1`, 1],
    [`${organisation.id}:${officeField._source.object_id}:office-2`, 1],
    [`${organisation.id}:${officeField._source.object_id}:office-3`, 0],
  ]),
};

const filterFields = [
  {
    key: "org_member_count",
    label: "Member count",
    field_type: "number",
    control: "number",
    options: [],
    multi_select: false,
  },
];

function settingsRows() {
  return [
    ["org_directory_header", "Smoke Organisation Directory"],
    ["org_directory_show_logo", "false"],
    ["org_directory_show_title", "true"],
    ["org_directory_show_domains", "true"],
    ["org_directory_show_member_count", "true"],
    ["org_directory_show_name_tooltip", "false"],
    ["org_directory_cards_per_row", "3"],
    ["org_directory_excluded_orgs", "[]"],
    ["org_directory_allowed_application_statuses", "[]"],
    ["org_directory_visible_org_types", "[]"],
    ["org_directory_reverse_card_role_ids", JSON.stringify([role.id])],
    ["org_directory_view_members_role_ids", JSON.stringify([role.id])],
    ["org_directory_back_field_order", JSON.stringify(["org_member_count", "org_members_list"])],
    ["org_directory_custom_fields_label", "Organisation details"],
  ].map(([setting_key, setting_value], index) => ({
    id: `csv-setting-${index}`,
    setting_key,
    setting_value,
  }));
}

async function installFixtures(page, {
  allowCsvDownload = false,
  csvSettingsFailure = false,
  exportMode = "success",
} = {}) {
  const state = {
    allowCsvDownload,
    csvSettingsFailure,
    exportMode,
    settings: settingsRows(),
    directoryPosts: [],
    exportRequests: [],
    writes: [],
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

    const json = (body, status = 200, headers = {}) => route.fulfill({
      status,
      contentType: "application/json",
      headers,
      body: JSON.stringify(body),
    });

    if (path === "/api/auth/me") return json(member);
    if (path === "/api/auth/tenant-user-me") {
      return json({ user: member, tenant: { id: member.tenant_id } });
    }
    if (path === "/api/auth/logout") return json({ ok: true });

    if (path === "/api/organisation-directory/csv-settings") {
      if (method === "GET") {
        if (state.csvSettingsFailure) return json({ error: "CSV settings unavailable" }, 503);
        return json({ allowCsvDownload: state.allowCsvDownload });
      }
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.allowCsvDownload = body.allowCsvDownload === true;
        state.writes.push({ method, path, body });
        return json({ allowCsvDownload: state.allowCsvDownload });
      }
    }

    if (path === "/api/organisation-directory/filters") {
      if (url.searchParams.get("settings") === "true") {
        if (method === "GET") return json({ overrides: {} });
        if (method === "PUT") return json({ overrides: request.postDataJSON().changes || {} });
      }
      if (method === "GET") {
        return json({ fields: filterFields, allowCsvDownload: state.allowCsvDownload });
      }
      if (method === "POST") {
        const body = request.postDataJSON();
        state.directoryPosts.push(body);
        return json({
          organizations,
          total: organizations.length,
          page: body.page,
          pageSize: body.pageSize,
          fields: filterFields,
        });
      }
    }

    if (path === "/api/organisation-directory/export-csv" && method === "GET") {
      state.exportRequests.push(request.url());
      if (state.exportMode === "failure") return json({ error: "Export service unavailable" }, 503);
      if (state.exportMode === "content-type") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html>not a CSV</html>",
        });
      }
      if (state.exportMode === "slow") {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      const csv = projectOrganisationDirectoryCsv({
        organizations,
        fields: csvFields,
        preferences: new Map(),
        objectValues: csvObjectValues,
        memberValues: csvMemberValues,
        includeLogo: false,
        includeOrganisation: true,
      });
      return route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": 'attachment; filename="full-directory.csv"' },
        body: csv,
      });
    }

    if (path === "/api/organisation-directory/custom-object-fields") {
      return json({ sources: [] });
    }
    if (path === "/api/entities/SystemSettings" && method === "GET") {
      return json(state.settings);
    }
    if (path.startsWith("/api/entities/SystemSettings/") && method === "PATCH") {
      const id = decodeURIComponent(path.split("/").pop());
      const patch = request.postDataJSON();
      const setting = state.settings.find(row => row.id === id);
      if (setting) Object.assign(setting, patch);
      state.writes.push({ method, path, body: patch });
      return json(setting || { id, ...patch });
    }
    if (path === "/api/entities/Organization") return json(organizations);
    if (path === "/api/entities/Member") return json([member]);
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path === "/api/entities/Role") return json([role]);
    if (path === `/api/entities/Role/${role.id}`) return json(role);
    if (path === "/api/entities/PreferenceField") return json([]);

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push({ method, path, escaped: true });
      return json({ error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json([]);
  });

  return state;
}

test("settings toggle defaults off, persists through dedicated API, and fails closed", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto("/OrganisationDirectorySettings");

  const toggle = page.getByRole("switch", {
    name: "Allow members to download directory as CSV",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.getByRole("button", { name: "Save Settings", exact: true }).first().click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();
  expect(state.writes.some(write =>
    write.method === "PUT"
    && write.path === "/api/organisation-directory/csv-settings"
    && write.body.allowCsvDownload === true
  )).toBe(true);
  await expect.poll(() => state.allowCsvDownload).toBe(true);

  state.csvSettingsFailure = true;
  await page.reload();
  await expect(toggle).toBeDisabled();
  await expect(page.getByText("CSV download setting could not be loaded. Saving is unavailable until it loads.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Settings", exact: true }).first()).toBeDisabled();
});

test("directory downloads a real full CSV without filter query parameters", async ({ page }) => {
  const state = await installFixtures(page, { allowCsvDownload: true });
  await page.goto("/OrganisationDirectory");
  await expect(page.getByTestId("card-organisation-csv-smoke-organisation")).toBeVisible();

  await page.getByLabel("Member count", { exact: true }).fill("2");
  await expect.poll(() => state.directoryPosts.at(-1)?.filters).toEqual({
    org_member_count: { operator: "eq", value: "2" },
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download full directory CSV", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("full-directory.csv");
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  if (!downloadPath) throw new Error("CSV download did not produce a file");
  const downloadedBytes = await readFile(downloadPath);
  expect(downloadedBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const rows = downloadedBytes.toString("utf8").replace(/^\ufeff/, "").split("\r\n");
  expect(rows[0]).toBe("Organisation,Number of members,Department,Office");
  expect(rows.slice(1)).toHaveLength(5);
  expect(rows.slice(1).filter(row => row.includes("Department:"))).toHaveLength(2);
  expect(rows.slice(1).filter(row => row.includes("Office:"))).toHaveLength(3);
  expect(rows.slice(1).map(row => row.split(",")[1])).toEqual(["1", "1", "1", "1", "0"]);
  const memberNameCell = new RegExp(`(?:^|,)${member.first_name} ${member.last_name}(?:,|$)`);
  expect(rows.slice(1).every(row => !memberNameCell.test(row))).toBe(true);
  expect(state.exportRequests).toEqual([
    `${await page.evaluate(() => window.location.origin)}/api/organisation-directory/export-csv`,
  ]);
  await expect(page.getByRole("button", { name: "Download full directory CSV", exact: true })).toBeVisible();
});

test("CSV export prevents duplicate clicks and reports HTTP/content-type failures", async ({ page }) => {
  const state = await installFixtures(page, { allowCsvDownload: true, exportMode: "slow" });
  await page.goto("/OrganisationDirectory");
  const button = page.getByTestId("button-download-full-directory-csv");
  await expect(button).toBeVisible();

  await button.click();
  await expect(button).toBeDisabled();
  await button.dispatchEvent("click");
  await expect(button).toBeEnabled();
  expect(state.exportRequests).toHaveLength(1);

  state.exportMode = "content-type";
  await button.click();
  await expect(page.getByText("Directory CSV export returned an unexpected content type")).toBeVisible();

  state.exportMode = "failure";
  await button.click();
  await expect(page.getByText("Export service unavailable")).toBeVisible();
  expect(state.exportRequests).toHaveLength(3);
});
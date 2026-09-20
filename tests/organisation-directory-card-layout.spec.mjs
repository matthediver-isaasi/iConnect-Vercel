import { test, expect } from "@playwright/test";

const TENANT_ID = "task-4595-tenant";
const ORGANISATION_ID = "task-4595-organisation";
const VIEWER = {
  id: "task-4595-viewer",
  tenant_id: TENANT_ID,
  role_id: "task-4595-role",
  organization_id: ORGANISATION_ID,
  email: "directory.viewer@example.invalid",
  first_name: "Directory",
  last_name: "Viewer",
  is_team_member: false,
  viewer_kind: "member",
  member_excluded_features: [],
};
const ORGANISATION = {
  id: ORGANISATION_ID,
  tenant_id: TENANT_ID,
  name: "Barnsley Hospital",
  domain: "barnsley-hospital.example.invalid",
  // This is the real organisation-core shape supplied by the import. The
  // remaining postal components below are authorised organisation custom
  // fields; no synthetic address-line preference fields are introduced.
  invoicing_address: "Gawber Road\nS75 2EP",
  logo_url: null,
  member_count: 0,
};
const RELATIONSHIP_ID = "task-4595-organisation-departments";
const OBJECT_ID = "task-4595-department-object";
const sourceKey = (fieldId) =>
  `object-field:${RELATIONSHIP_ID}:source:${OBJECT_ID}:${fieldId}`;
const SOURCE_FIELDS = [
  ["department-name", "Name", "name"],
  ["department-address-one", "Address line 1", "address_line_1"],
  ["department-address-two", "Address line 2", "address_line_2"],
  ["department-county", "Address county", "address_county"],
  ["department-postcode", "Address post code", "address_post_code"],
  ["department-town", "Address Town/City", "address_town_city"],
].map(([id, label, field_key]) => ({
  key: sourceKey(id),
  label,
  field_label: label,
  object_label: "Department",
  relationship_label: "Organisation departments",
  relationship_id: RELATIONSHIP_ID,
  object_id: OBJECT_ID,
  direction: "source",
  field_id: id,
  is_primary_display_field: id === "department-name",
  field: {
    id,
    label,
    field_key,
    field_type: "text",
  },
}));

const DEPARTMENTS = [
  {
    record_id: "nuclear-medicine-stand-alone",
    label: "Nuclear Medicine Stand Alone",
    values: {
      "department-name": "Nuclear Medicine Stand Alone",
      "department-address-one": "Gawber Road",
      "department-address-two": "Nuclear Medicine Department",
      "department-county": "South Yorkshire",
      "department-postcode": "S75 2EP",
      "department-town": "Barnsley",
    },
  },
  {
    record_id: "radiopharmacy",
    label: "Radiopharmacy",
    values: {
      "department-name": "Radiopharmacy",
      "department-address-one":
        "Radiopharmacy Manufacturing Unit, Kendray Hospital, Doncaster Road",
      // Deliberately absent: missing values must not shift another record's
      // address into this department or leave an empty labelled row.
      "department-county": "South Yorkshire",
      "department-postcode": "S70 3RD",
      "department-town": "Barnsley",
    },
  },
];

const ORG_FIELDS = [
  ["organisation-town", "Town / city", "town_city", 1],
  ["organisation-region", "Region", "region", 2],
  ["organisation-country", "Country", "country", 3],
].map(([id, label, name, display_order]) => ({
  id,
  tenant_id: TENANT_ID,
  label,
  name,
  field_type: "text",
  entity_scope: "organization",
  is_active: true,
  show_in_directory_card: true,
  display_order,
  directory_visibility: {
    ids: ["main"],
    labels: {},
    display: { main: { back: true, order: display_order } },
  },
}));
const ORG_VALUES = [
  ["organisation-town", "Barnsley"],
  ["organisation-region", "Yorkshire and the Humber"],
  ["organisation-country", "United Kingdom"],
].map(([field_id, value], index) => ({
  id: `task-4595-org-value-${index}`,
  organization_id: ORGANISATION_ID,
  field_id,
  value,
}));

const SETTINGS = [
  ["org_directory_header", "Organisation Directory"],
  ["org_directory_show_logo", "false"],
  ["org_directory_show_title", "true"],
  ["org_directory_show_domains", "false"],
  ["org_directory_show_member_count", "false"],
  ["org_directory_show_name_tooltip", "false"],
  ["org_directory_cards_per_row", "3"],
  ["org_directory_excluded_orgs", "[]"],
  ["org_directory_allowed_application_statuses", "[]"],
  ["org_directory_visible_org_types", "[]"],
  ["org_directory_reverse_card_role_ids", "[]"],
  ["org_directory_view_members_role_ids", "[]"],
  [
    "org_directory_back_field_order",
    JSON.stringify([
      ...ORG_FIELDS.map((field) => `custom:${field.id}`),
      ...SOURCE_FIELDS.map((source) => source.key),
      "org_member_count",
      "org_members_list",
    ]),
  ],
  ["org_directory_custom_fields_label", "Organisation details"],
].map(([setting_key, setting_value], index) => ({
  id: `task-4595-setting-${index}`,
  tenant_id: TENANT_ID,
  setting_key,
  setting_value,
}));

async function installFixture(page) {
  const state = { requests: [], unexpectedWrites: [] };
  await page.addInitScript(() => {
    localStorage.removeItem("agcas_member");
    localStorage.removeItem("agcas_organization");
    class FixtureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = FixtureWebSocket.CLOSED;
        queueMicrotask(() =>
          this.onclose?.({ code: 1000, reason: "fixture transport blocked" }));
      }
      addEventListener() {}
      removeEventListener() {}
      send() { throw new Error("Fixture WebSocket transport is blocked"); }
      close() {}
    }
    window.WebSocket = FixtureWebSocket;
  });
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.context().route("**/rest/v1/**", (route) => json(route, []));
  await page.context().route("**/realtime/v1/**", (route) => route.abort("blockedbyclient"));
  await page.context().route("**/auth/v1/**", (route) => route.abort("blockedbyclient"));
  await page.context().route("**/storage/v1/**", (route) => route.abort("blockedbyclient"));
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push({ method, path, search: url.search });

    if (!["GET", "HEAD", "OPTIONS"].includes(method)
      && !(path === "/api/organisation-directory/filters" && method === "POST")) {
      state.unexpectedWrites.push({ method, path, body: request.postData() });
      return json(route, { error: `Unexpected fixture write: ${method} ${path}` }, 599);
    }
    if (path === "/api/auth/me") return json(route, VIEWER);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        authenticated: true,
        user: VIEWER,
        tenantUser: VIEWER,
        tenant: { id: TENANT_ID, slug: "task-4595" },
      });
    }
    if (path === "/api/auth/logout") return json(route, { ok: true });
    if (path === "/api/entities/SystemSettings") return json(route, SETTINGS);
    if (path === "/api/entities/PreferenceField") return json(route, ORG_FIELDS);
    if (path === "/api/entities/OrganizationPreferenceValue") return json(route, ORG_VALUES);
    if (path === "/api/entities/Organization") return json(route, [ORGANISATION]);
    if (path === `/api/entities/Organization/${ORGANISATION_ID}`) {
      return json(route, ORGANISATION);
    }
    if (path === "/api/entities/Member") {
      return json(route, url.searchParams.has("filter") ? [] : [VIEWER]);
    }
    if (path === `/api/entities/Member/${VIEWER.id}`) return json(route, VIEWER);
    if (path === "/api/entities/Role") {
      return json(route, [{ id: VIEWER.role_id, name: "Member", excluded_features: [] }]);
    }
    if (path === `/api/entities/Role/${VIEWER.role_id}`) {
      return json(route, { id: VIEWER.role_id, name: "Member", excluded_features: [] });
    }
    if (path === "/api/organisation-directory/filters") {
      if (method === "GET") return json(route, { fields: [], allowCsvDownload: false });
      const body = request.postDataJSON();
      return json(route, {
        fields: [],
        organizations: [ORGANISATION],
        total: 1,
        page: body.page,
        pageSize: body.pageSize,
      });
    }
    if (path === "/api/organisation-directory/custom-object-fields") {
      if (!url.searchParams.has("organization_id")) {
        return json(route, { sources: SOURCE_FIELDS });
      }
      const source = SOURCE_FIELDS.find((item) =>
        item.key === url.searchParams.get("source_key"));
      const items = DEPARTMENTS
        .filter((record) =>
          Object.prototype.hasOwnProperty.call(record.values, source?.field_id))
        .map((record) => ({
          record_id: record.record_id,
          label: record.label,
          value: record.values[source.field_id],
        }));
      return json(route, {
        source,
        values: { has_multiple_records: true },
        has_multiple_records: true,
        items,
        nextCursor: null,
      });
    }
    if (path === "/api/organisation-directory/csv-settings") {
      return json(route, { allowCsvDownload: false });
    }
    return json(route, []);
  });
  return state;
}

async function settleDialogAnimation(dialog) {
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) =>
      animation.finished.catch(() => undefined)));
  });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`standalone organisation card keeps postal and department addresses associated on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const state = await installFixture(page);
    await page.goto("/OrganisationDirectory");
    const acceptCookies = page.getByRole("button", { name: "Accept", exact: true });
    if (await acceptCookies.isVisible()) await acceptCookies.click();
    await page.getByTestId(`card-organisation-${ORGANISATION_ID}`).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await settleDialogAnimation(dialog);
    const postal = dialog.getByTestId("organisation-postal-address");
    await expect(postal.getByText("Gawber Road", { exact: true })).toBeVisible();
    await expect(postal.getByText("S75 2EP", { exact: true })).toBeVisible();
    await expect(postal.getByText("Barnsley", { exact: true })).toBeVisible();
    await expect(postal.getByText("Yorkshire and the Humber", { exact: true })).toBeVisible();
    await expect(postal.getByText("United Kingdom", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Nuclear Medicine Stand Alone", { exact: true }))
      .toBeVisible();
    await expect(dialog.getByText("Radiopharmacy", { exact: true })).toBeVisible();
    await expect(dialog.getByText(
      "Radiopharmacy Manufacturing Unit, Kendray Hospital, Doncaster Road",
      { exact: true },
    )).toBeVisible();
    await expect(dialog.getByText("Address line 2", { exact: true })).toHaveCount(1);
    await expect(dialog.getByTestId("button-view-members")).toHaveCount(0);
    await expect(dialog.getByText("Nuclear Medicine Stand Alone", { exact: true })).toHaveCount(1);
    await expect(dialog.getByText("Radiopharmacy", { exact: true })).toHaveCount(1);

    const nuclearRecord = dialog.getByTestId("directory-object-record-nuclear-medicine-stand-alone");
    const radiopharmacyRecord = dialog.getByTestId("directory-object-record-radiopharmacy");
    await expect(nuclearRecord).toContainText("Gawber Road");
    await expect(nuclearRecord).toContainText("S75 2EP");
    await expect(nuclearRecord).not.toContainText("Kendray Hospital");
    await expect(radiopharmacyRecord).toContainText(
      "Radiopharmacy Manufacturing Unit, Kendray Hospital, Doncaster Road",
    );
    await expect(radiopharmacyRecord).toContainText("S70 3RD");
    await expect(radiopharmacyRecord).not.toContainText("Nuclear Medicine Department");

    const order = await dialog.evaluate((element) => {
      const textTop = (text) => [...element.querySelectorAll("*")]
        .find((node) => node.children.length === 0 && node.textContent?.trim() === text)
        ?.getBoundingClientRect().top;
      return {
        postal: textTop("Gawber Road"),
        nuclear: textTop("Nuclear Medicine Stand Alone"),
        radiopharmacy: textTop("Radiopharmacy"),
      };
    });
    expect(order.postal).toBeLessThan(order.nuclear);
    expect(order.nuclear).toBeLessThan(order.radiopharmacy);

    const geometry = await dialog.evaluate((element) => {
      const dialogRect = element.getBoundingClientRect();
      const descendants = [...element.querySelectorAll("*")];
      const overflowing = descendants
        .filter((node) => {
          const style = getComputedStyle(node);
          if (style.position === "fixed" || style.position === "absolute") return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0
            && (rect.left < dialogRect.left - 1 || rect.right > dialogRect.right + 1);
        })
        .map((node) => ({
          tag: node.tagName,
          text: node.textContent?.trim().slice(0, 80),
          left: node.getBoundingClientRect().left,
          right: node.getBoundingClientRect().right,
        }));
      return {
        overflowing,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        dialogLeft: dialogRect.left,
        dialogRight: dialogRect.right,
      };
    });
    expect(geometry.overflowing).toEqual([]);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.dialogLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.dialogRight).toBeLessThanOrEqual(viewport.width + 1);
    expect(state.unexpectedWrites).toEqual([]);

    const screenshotPath = testInfo.outputPath(`task-4595-${viewport.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach(`${viewport.name}-organisation-card`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });
}
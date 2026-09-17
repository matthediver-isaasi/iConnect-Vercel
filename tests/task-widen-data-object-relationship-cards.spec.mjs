import { test, expect } from "@playwright/test";

const objectId = "widen-object";
const recordId = "widen-record";
const targetFieldIds = Array.from({ length: 8 }, (_, index) => `target-field-${index + 1}`);

const definitions = [
  {
    id: "widen-limit",
    status: "active",
    cardinality: "one_to_one",
    source_kind: "custom_object",
    source_custom_object_id: objectId,
    target_kind: "member",
    source_label: "Limited links",
    target_label: "Limited records",
    show_on_source: true,
    show_on_target: true,
    edit_from_source: true,
    edit_from_target: false,
    can_edit: true,
    configuration: {
      compact_preview: {
        target_columns: targetFieldIds.slice(0, 4).map((fieldId, index) => ({
          type: "field",
          field_id: fieldId,
          label: `Limit column ${index + 1}`,
        })),
      },
    },
  },
  {
    id: "widen-wide",
    status: "active",
    cardinality: "many_to_many",
    source_kind: "custom_object",
    source_custom_object_id: objectId,
    target_kind: "member",
    source_label: "Wide links",
    target_label: "Wide records",
    show_on_source: true,
    show_on_target: true,
    edit_from_source: true,
    edit_from_target: false,
    can_edit: true,
    configuration: {
      compact_preview: {
        target_columns: targetFieldIds.map((fieldId, index) => ({
          type: "field",
          field_id: fieldId,
          label: `Wide column ${index + 1}`,
        })),
      },
    },
  },
  {
    id: "widen-embedded",
    status: "active",
    cardinality: "many_to_many",
    source_kind: "custom_object",
    source_custom_object_id: objectId,
    target_kind: "member",
    source_label: "Embedded links",
    target_label: "Embedded records",
    show_on_source: true,
    show_on_target: true,
    edit_from_source: true,
    edit_from_target: false,
    can_edit: true,
    configuration: {
      compact_preview: {
        target_columns: targetFieldIds.slice(0, 2).map((fieldId, index) => ({
          type: "field",
          field_id: fieldId,
          label: `Embedded column ${index + 1}`,
        })),
      },
    },
  },
];

const viewer = {
  id: "widen-viewer",
  tenant_id: "widen-tenant",
  organization_id: "widen-org",
  role_id: "widen-role",
  email: "widen-viewer@example.invalid",
  first_name: "Layout",
  last_name: "Viewer",
  member_excluded_features: [],
};
const role = { id: "widen-role", name: "Administrator", excluded_features: [] };

const object = {
  id: objectId,
  tenant_id: "widen-tenant",
  object_key: "widened_data",
  singular_label: "Widened Data",
  plural_label: "Widened Data",
  status: "active",
  capabilities: {
    can_view_records: true,
    can_create_records: true,
    can_edit_records: true,
    can_archive_records: true,
  },
  presentation: {
    detail: {
      cards: [{
        id: "configured-relationship-card",
        title: "Configured columns",
        columns: 2,
        fields: [
          {
            id: "custom:summary",
            type: "custom",
            fieldId: "summary",
            columnIndex: 0,
          },
          {
            id: `relationship:${definitions[2].id}:source`,
            type: "relationship",
            definitionId: definitions[2].id,
            side: "source",
            displayMode: "columns",
            columnIndex: 1,
          },
        ],
      }],
    },
  },
};

const fields = [
  {
    id: "summary",
    name: "summary",
    label: "Summary",
    field_type: "text",
    is_active: true,
    is_required: false,
  },
];

const record = {
  id: recordId,
  display_value: "Widened data record",
  updated_at: "2026-01-01T12:00:00.000Z",
  archived_at: null,
  data: { summary: "The configured relationship remains in its column." },
  capabilities: object.capabilities,
};

function relatedMember(definitionId, index) {
  const label = `${definitionId === "widen-wide" ? "Wide" : definitionId === "widen-limit" ? "Limited" : "Embedded"} member ${index + 1}`;
  return {
    relationship_id: `${definitionId}-edge-${index + 1}`,
    related_kind: "member",
    related_record_id: `${definitionId}-member-${index + 1}`,
    related: {
      id: `${definitionId}-member-${index + 1}`,
      kind: "member",
      primary_label: label,
      secondary_text: `${label} secondary text`,
      compact_fields: targetFieldIds.map((fieldId, fieldIndex) => ({
        field_id: fieldId,
        value: `${label} value ${fieldIndex + 1}`,
      })),
    },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page) {
  const state = {
    requests: [],
    interceptedWrites: [],
    unexpectedWrites: [],
  };

  await page.context().route("**/rest/v1/**", async (route) => {
    const method = route.request().method();
    state.requests.push(`${method} ${route.request().url()} [mocked Supabase]`);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: "Unexpected direct data mutation" }, 599);
    }
    return json(route, []);
  });

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const method = request.method();
    state.requests.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me") return json(route, viewer);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: viewer, tenant: { id: "widen-tenant", slug: "widen" } });
    }
    if (path === "/api/entities/Role/widen-role") return json(route, role);
    if (path === "/api/entities/Member/widen-viewer") return json(route, viewer);

    // Layout checks the portal catalogue before allowing a direct
    // CustomObjectsAdmin/:objectId route.  Include the object with the
    // explicit catalogue view capability so that this fixture exercises the
    // real Data Studio route guard rather than falling back to Preferences.
    if (path === "/api/custom-objects" && method === "GET")
      return json(route, {
        data: [{ ...object, capabilities: { ...object.capabilities, view: true } }],
        total: 1,
      });
    if (path === `/api/custom-objects/${objectId}` && method === "GET")
      return json(route, object);
    if (path === `/api/custom-objects/${objectId}/fields` && method === "GET")
      return json(route, { data: fields, total: fields.length });
    if (path === `/api/custom-objects/${objectId}/records/${recordId}` && method === "GET")
      return json(route, record);
    if (path === `/api/custom-objects/${objectId}/relationship-definitions` && method === "GET")
      return json(route, { data: definitions.map((definition) => ({ definition, side: "source" })), total: definitions.length });

    if (path === `/api/custom-objects/${objectId}/relationships` && method === "GET") {
      const definitionId = url.searchParams.get("definitionId");
      const definition = definitions.find((item) => item.id === definitionId);
      const pageNumber = Number(url.searchParams.get("page") || 1);
      const count = definitionId === "widen-wide" ? 11 : 1;
      const allRows = Array.from({ length: count }, (_, index) => relatedMember(definitionId, index));
      const pageSize = 10;
      return json(route, {
        data: allRows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
        total: count,
        pageSize,
        definition,
      });
    }

    if (path === "/api/custom-objects/core/relationship-panel-preference") {
      if (method === "PATCH") {
        state.interceptedWrites.push(`${method} ${path}`);
        return json(route, { preference: null });
      }
      return json(route, { preference: null });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });

  return state;
}

function panelCard(page, label) {
  return page
    .getByRole("heading", { name: label, exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
}

async function panelGeometry(panel) {
  return panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, top: rect.top };
  });
}

async function assertFullWidthPanels(page) {
  const limited = panelCard(page, "Limited links");
  const wide = panelCard(page, "Wide links");
  await expect(limited).toBeVisible();
  await expect(wide).toBeVisible();

  const [limitedBox, wideBox] = await Promise.all([
    panelGeometry(limited),
    panelGeometry(wide),
  ]);
  const sectionBox = await limited.locator("xpath=ancestor::section[2]").boundingBox();
  expect(Math.abs(limitedBox.width - sectionBox.width)).toBeLessThan(2);
  expect(Math.abs(limitedBox.width - wideBox.width)).toBeLessThan(2);
  expect(Math.abs(limitedBox.left - wideBox.left)).toBeLessThan(2);
  expect(limitedBox.width).toBeGreaterThan(300);
  expect(wideBox.top).toBeGreaterThan(limitedBox.top);
  return { limited, wide, limitedBox, wideBox };
}

test("desktop record detail stacks unplaced panels at full width and keeps configured relationship in its column", async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto(`/CustomObjectsAdmin/${objectId}/records/${recordId}`);

  await expect(page.getByRole("heading", { name: "Widened data record", exact: true })).toBeVisible();
  const { limited, wide } = await assertFullWidthPanels(page);
  const embedded = panelCard(page, "Embedded links");
  await expect(embedded).toBeVisible();

  const [wideBox, embeddedBox] = await Promise.all([
    panelGeometry(wide),
    panelGeometry(embedded),
  ]);
  expect(embeddedBox.width).toBeLessThan(wideBox.width * 0.75);
  expect(embeddedBox.width).toBeGreaterThan(300);

  await expect(limited.getByRole("button", { name: "Add link" })).toBeVisible();
  await expect(limited.getByRole("button", { name: "Add link" })).toBeDisabled();
  await expect(limited).toContainText("reached its configured relationship limit");
  await expect(wide.getByRole("button", { name: "Add link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset columns" })).toHaveCount(3);
  await expect(wide).toContainText("Page 1 of 2");

  await page.getByRole("button", { name: "Reset columns" }).first().click();
  await expect.poll(() => state.interceptedWrites.length).toBeGreaterThan(0);
  await page.screenshot({
    path: "screenshots/task-widen-data-object-relationship-cards.png",
    fullPage: false,
  });
  expect(state.unexpectedWrites).toEqual([]);
});

test("mobile full-width panels and wide tables stay bounded inside the viewport", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const state = await installFixtures(page);
    await page.goto(`/CustomObjectsAdmin/${objectId}/records/${recordId}`);

    const { limited, wide } = await assertFullWidthPanels(page);
    const [limitedBox, wideBox] = await Promise.all([
      panelGeometry(limited),
      panelGeometry(wide),
    ]);
    expect(limitedBox.width).toBeGreaterThan(340);
    expect(Math.abs(limitedBox.width - wideBox.width)).toBeLessThan(2);

    const tableViewport = wide.locator("div.overflow-x-auto").first();
    await expect(tableViewport).toBeVisible();
    const tableGeometry = await tableViewport.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(tableGeometry.scrollWidth).toBeGreaterThan(tableGeometry.clientWidth);

    const documentGeometry = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(documentGeometry.bodyScrollWidth).toBeLessThanOrEqual(documentGeometry.viewport);
    expect(documentGeometry.documentScrollWidth).toBeLessThanOrEqual(documentGeometry.viewport);
    const scrolled = await tableViewport.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    });
    expect(scrolled).toBeGreaterThan(0);
    await expect(limited.getByRole("button", { name: "Add link" })).toBeVisible();
    await expect(wide.getByRole("button", { name: "Add link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset columns" })).toHaveCount(3);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {
    await context.close();
  }
});
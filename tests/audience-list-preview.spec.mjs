import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const pagePath = "/CommunicationsManagement";
const populatedListId = "preview-populated-list";
const emptyListId = "preview-empty-list";
const reviewListId = "preview-review-required-list";
const reviewError = "This campaign references an audience list affected by a deleted communication category. Replace every disabled list with a new reviewed list before previewing, saving, scheduling, resuming, or sending.";

const viewer = {
  id: "audience-preview-viewer",
  tenant_id: "audience-preview-tenant",
  organization_id: "audience-preview-organisation",
  role_id: "audience-preview-role",
  email: "audience-preview@example.invalid",
  first_name: "Audience",
  last_name: "Previewer",
  member_excluded_features: [],
};

const audienceLists = [{
  id: populatedListId,
  name: "Twenty-five newsletter recipients",
  target_audiences: [{ type: "role", ids: ["newsletter-role"] }],
  ignore_opt_outs: false,
}, {
  id: emptyListId,
  name: "Empty newsletter audience",
  target_audiences: [],
  ignore_opt_outs: false,
}, {
  id: reviewListId,
  name: "Audience requiring review",
  target_audiences: [{ type: "communication_category", ids: ["deleted-category"] }],
  ignore_opt_outs: false,
  category_review_required: true,
  deleted_category_name: "Deleted newsletter category",
}];

const recipients = Array.from({ length: 25 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    first_name: "Recipient",
    last_name: number,
    email: `recipient-${number}@example.invalid`,
  };
});

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page, baseURL, { previewResponder, categoryExport = false } = {}) {
  const origin = new URL(baseURL).origin;
  const state = {
    apiRequests: [],
    previewRequests: [],
    unexpectedWrites: [],
    unexpectedRequests: [],
    blockedExternal: [],
  };

  await page.addInitScript(() => {
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.context().routeWebSocket("**/*", socket => {
    state.blockedExternal.push(`WEBSOCKET ${socket.url()}`);
    socket.close();
  });

  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const description = `${method} ${url.origin}${path}${url.search}`;

    if (path.startsWith("/api/")) {
      if (url.origin !== origin) {
        state.unexpectedRequests.push(description);
        return json(route, { error: "Cross-origin API request blocked by fixture" }, 599);
      }
      state.apiRequests.push(`${method} ${path}${url.search}`);

      if (path === "/api/audience-lists/preview" && method === "POST") {
        const body = request.postDataJSON();
        state.previewRequests.push(body);
        if (previewResponder) {
          return previewResponder({ route, body, state });
        }
        if (body?.listId === populatedListId) {
          return json(route, {
            success: true,
            listName: audienceLists[0].name,
            totalCount: recipients.length,
            recipients,
          });
        }
        if (body?.listId === emptyListId) {
          return json(route, {
            success: true,
            listName: audienceLists[1].name,
            totalCount: 0,
            recipients: [],
          });
        }
        if (body?.listId === reviewListId) {
          return json(route, { error: reviewError }, 409);
        }
        state.unexpectedRequests.push(description);
        return json(route, { error: "Unknown fixture audience list" }, 599);
      }

      if (path === "/api/audience-lists/counts" && method === "POST") {
        return json(route, {
          counts: {
            [populatedListId]: 25,
            [emptyListId]: 0,
            [reviewListId]: 0,
          },
        });
      }

      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        state.unexpectedWrites.push(description);
        return json(route, { error: `Unexpected write blocked by fixture: ${description}` }, 599);
      }

      if (path === "/api/auth/me") return json(route, viewer);
      if (categoryExport) {
        if (path === "/api/entities/CommunicationCategory") return json(route, [{
          id: "category-export-regression", name: "Member & External News", is_active: true,
          member_enabled: true, is_public: true, display_order: 1,
        }]);
        if (path === "/api/entities/CommunicationCategoryRole") return json(route, []);
        if (path === "/api/entities/MemberCommunicationPreference") return json(route, [{
          id: "preference-export-regression", category_id: "category-export-regression",
          member_id: "subscribed-member", is_subscribed: true,
        }]);
        // The surrounding layout does an email-filtered member lookup for
        // last_activity; keep it empty so the fixture never triggers a PATCH.
        if (path === "/api/entities/Member" && url.searchParams.get("filter")?.includes("email")) {
          return json(route, []);
        }
        if (path === "/api/entities/Member") return json(route, [{
          id: "subscribed-member", first_name: 'Maya "MJ"', last_name: "Patel",
          email: "maya@example.invalid", organization_id: viewer.organization_id, role_id: viewer.role_id,
          login_enabled: true, communications_opted_out_all: false,
        }]);
        if (path === "/api/admin/external-subscribers") {
          if (!url.searchParams.has("category_id")) {
            return json(route, { counts: { "category-export-regression": 1 } });
          }
          if (url.searchParams.get("category_id") !== "category-export-regression"
            || url.searchParams.get("page") !== "1"
            || url.searchParams.get("per_page") !== "100") {
            state.unexpectedRequests.push(description);
            return json(route, { error: "Unexpected category export page" }, 599);
          }
          return json(route, {
            total: 1, page: 1, subscribers: [{
              id: "external-category-subscriber", first_name: "Elena", last_name: "López",
              email: "elena@example.invalid",
            }],
          });
        }
      }
      if (path === "/api/auth/tenant-user-me") return json(route, {
        authenticated: true,
        user: viewer,
        tenant: { id: viewer.tenant_id, slug: "audience-preview-fixture" },
        tenantId: viewer.tenant_id,
        memberId: viewer.id,
      });
      if (path === "/api/audience-lists") return json(route, audienceLists);
      if (path === `/api/entities/Role/${viewer.role_id}`) {
        return json(route, { id: viewer.role_id, name: "Administrator", excluded_features: [] });
      }
      if (path === "/api/entities/Role") {
        return json(route, [{ id: viewer.role_id, name: "Administrator", excluded_features: [] }]);
      }
      if (path === `/api/entities/Member/${viewer.id}`) return json(route, viewer);
      if (path === "/api/entities/Organization") {
        return json(route, [{ id: viewer.organization_id, name: "Preview Organisation" }]);
      }
      if (path === "/api/zoho-campaigns/oauth") {
        return json(route, { connected: false, credentialsConfigured: false });
      }
      if (path === "/api/communication/inbox/unread-count") return json(route, { count: 0 });
      if (path === "/api/admin/form-submissions/stats") return json(route, { total: 0, pending: 0 });
      if ([
        "/api/public/favicon-url", "/api/public/portal-branding",
        "/api/public/tenant-branding", "/api/public/ai-help-persona",
        "/api/public/form-consent-message",
      ].includes(path)) return json(route, {});

      // Every API call is fulfilled inside this fixture. Optional read-only
      // datasets used by the surrounding application shell are intentionally empty.
      return json(route, []);
    }

    if (url.origin !== origin) {
      state.blockedExternal.push(description);
      return route.fulfill({ status: 204, body: "" });
    }

    if (
      path === pagePath
      || path.startsWith("/src/")
      || path.startsWith("/@")
      || path.startsWith("/node_modules/")
      || path.startsWith("/assets/")
      || path === "/favicon.ico"
    ) {
      return route.continue();
    }

    state.unexpectedRequests.push(description);
    return route.fulfill({ status: 599, contentType: "text/plain", body: "Unexpected fixture request" });
  });

  return state;
}

async function openLists(page) {
  await page.goto(pagePath);
  await page.getByTestId("tab-lists").click();
  await expect(page.getByTestId("text-lists-heading")).toHaveText("Audience Lists");
}

function assertSafeFixture(state) {
  expect(state.unexpectedWrites, "Unexpected writes are blocked").toEqual([]);
  expect(state.unexpectedRequests, "Unexpected requests are blocked").toEqual([]);
}

test("saved-list eye preview shows totals, paginates 20 rows, handles empty and review-required results", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL);
  try {
    await page.goto(pagePath);
    await page.getByTestId("tab-lists").click();
    await expect(page.getByTestId("text-lists-heading")).toHaveText("Audience Lists");

    await page.getByTestId(`button-preview-list-${populatedListId}`).click();
    const populatedDialog = page.getByRole("dialog", { name: "Twenty-five newsletter recipients", exact: true });
    await expect(populatedDialog.getByTestId("text-preview-list-name"))
      .toHaveText("Twenty-five newsletter recipients");
    await expect(populatedDialog).toContainText("25 total recipients");
    await expect(populatedDialog.getByTestId("table-preview-recipients")).toBeVisible();
    await expect(populatedDialog.locator('[data-testid^="row-preview-recipient-"]')).toHaveCount(20);
    await expect(populatedDialog.getByTestId("text-recipient-email-0"))
      .toHaveText("recipient-01@example.invalid");
    await expect(populatedDialog.getByTestId("preview-pagination")).toContainText("Page 1 of 2");
    await expect(populatedDialog.getByTestId("button-preview-prev")).toBeDisabled();
    await expect(populatedDialog.getByTestId("button-preview-next")).toBeEnabled();

    await populatedDialog.getByTestId("button-preview-next").click();
    await expect(populatedDialog.getByTestId("preview-pagination")).toContainText("Page 2 of 2");
    await expect(populatedDialog.locator('[data-testid^="row-preview-recipient-"]')).toHaveCount(5);
    await expect(populatedDialog.getByText("21", { exact: true })).toBeVisible();
    await expect(populatedDialog.getByTestId("text-recipient-email-0"))
      .toHaveText("recipient-21@example.invalid");
    await expect(populatedDialog.getByTestId("button-preview-next")).toBeDisabled();
    await expect(populatedDialog.getByTestId("button-preview-prev")).toBeEnabled();

    await page.screenshot({
      path: "screenshots/audience-list-preview-pagination.png",
      fullPage: false,
    });

    await populatedDialog.getByTestId("button-preview-prev").click();
    await expect(populatedDialog.getByTestId("preview-pagination")).toContainText("Page 1 of 2");
    await expect(populatedDialog.locator('[data-testid^="row-preview-recipient-"]')).toHaveCount(20);
    await populatedDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(populatedDialog).toHaveCount(0);

    await page.getByTestId(`button-preview-list-${emptyListId}`).click();
    const emptyDialog = page.getByRole("dialog", { name: "Empty newsletter audience", exact: true });
    await expect(emptyDialog.getByTestId("text-preview-list-name")).toHaveText("Empty newsletter audience");
    await expect(emptyDialog).toContainText("0 total recipients");
    await expect(emptyDialog.getByTestId("preview-empty"))
      .toHaveText("No recipients found for this audience list.");
    await expect(emptyDialog.getByTestId("preview-pagination")).toHaveCount(0);
    await emptyDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(emptyDialog).toHaveCount(0);

    await page.getByTestId(`button-preview-list-${reviewListId}`).click();
    await expect(page.getByText(reviewError, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").filter({ has: page.getByTestId("text-preview-list-name") })).toHaveCount(0);

    expect(state.previewRequests).toEqual([
      { listId: populatedListId },
      { listId: emptyListId },
      { listId: reviewListId },
    ]);
    expect(state.unexpectedWrites, "Unexpected writes are blocked").toEqual([]);
    expect(state.unexpectedRequests, "Unexpected requests are blocked").toEqual([]);
  } finally {
    expect(state.unexpectedWrites, "Unexpected writes are blocked").toEqual([]);
    expect(state.unexpectedRequests, "Unexpected requests are blocked").toEqual([]);
  }
});

test("downloads the complete 25-row CSV with BOM, CRLF, Unicode, quoting and formula protection", async ({ page, baseURL }) => {
  const specialRecipients = [
    { first_name: "Zoë", last_name: "O'Neill, Jr.", email: "zoe@example.invalid" },
    { first_name: 'Ana "Ace"', last_name: "Niño", email: "ana@example.invalid" },
    { first_name: "Line\r\nBreak", last_name: "New\nLine", email: "lines@example.invalid" },
    { first_name: "=SUM(1,1)", last_name: " \t+cmd", email: "@danger@example.invalid" },
    { first_name: "\u0001-unsafe", last_name: "\t=HYPERLINK(1)", email: " formula@example.invalid" },
    { first_name: "東京", last_name: "Müller", email: "unicode@example.invalid" },
  ];
  const allRecipients = [...specialRecipients, ...recipients.slice(6)];
  const state = await installFixtures(page, baseURL, {
    previewResponder: ({ route, body, state: fixture }) => {
      if (body?.listId !== populatedListId) {
        fixture.unexpectedRequests.push(`POST preview ${JSON.stringify(body)}`);
        return json(route, { error: "Unknown list" }, 599);
      }
      return json(route, {
        success: true, listName: "Créme, Finance + News",
        totalCount: allRecipients.length, recipients: allRecipients,
      });
    },
  });
  const downloads = [];
  page.on("download", download => downloads.push(download));
  await openLists(page);
  const card = page.getByTestId(`card-list-${populatedListId}`);
  const button = card.getByTestId(`button-download-list-${populatedListId}`);
  await expect(button).toHaveAttribute("aria-label", `Download audience CSV for ${audienceLists[0].name}`);
  await expect(button).toHaveAttribute("title", "Download audience CSV");
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute("aria-busy", "false");
  const actionIds = await card.locator('[data-testid^="button-"]').evaluateAll(nodes => nodes.map(node => node.dataset.testid));
  const previewIndex = actionIds.indexOf(`button-preview-list-${populatedListId}`);
  expect(previewIndex).toBeGreaterThanOrEqual(0);
  expect(actionIds.slice(previewIndex, previewIndex + 4)).toEqual([
    `button-preview-list-${populatedListId}`,
    `button-download-list-${populatedListId}`,
    `button-edit-list-${populatedListId}`,
    `button-delete-list-${populatedListId}`,
  ]);
  await page.screenshot({ path: "/tmp/audience-list-download-action.png", fullPage: false });
  const beforeDate = new Date().toISOString().slice(0, 10);
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  const download = await downloadPromise;
  const afterDate = new Date().toISOString().slice(0, 10);
  expect([`audience-cr-me-finance-news-${beforeDate}.csv`, `audience-cr-me-finance-news-${afterDate}.csv`]).toContain(download.suggestedFilename());
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const csv = bytes.subarray(3).toString("utf8");
  const expectedLines = [
    "First name,Last name,Email",
    "Zoë,\"O'Neill, Jr.\",zoe@example.invalid",
    '"Ana ""Ace""",Niño,ana@example.invalid',
    "Line Break,New Line,lines@example.invalid",
    '"\'=SUM(1,1)",\' \t+cmd,\'@danger@example.invalid',
    "'\u0001-unsafe,'\t=HYPERLINK(1), formula@example.invalid",
    "東京,Müller,unicode@example.invalid",
    ...recipients.slice(6).map(person => `Recipient,${person.last_name},${person.email}`),
  ];
  expect(csv).toBe(expectedLines.join("\r\n"));
  expect(csv.split("\r\n")).toHaveLength(26);
  expect(downloads).toHaveLength(1);
  expect(state.previewRequests).toEqual([{ listId: populatedListId }]);
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute("aria-busy", "false");
  assertSafeFixture(state);
});

test("empty, review-required, HTTP error and incomplete preview responses never download", async ({ page, baseURL }) => {
  const failureCases = [
    { id: emptyListId, result: { success: true, listName: audienceLists[1].name, totalCount: 0, recipients: [] }, message: "No recipients found for this audience list." },
    { id: reviewListId, result: { error: reviewError }, status: 409, message: reviewError },
    { id: populatedListId, result: { error: "Preview service unavailable" }, status: 503, message: "Preview service unavailable" },
    { id: populatedListId, result: { success: true, totalCount: 25, recipients: recipients.slice(0, 20) }, message: "Unable to download the complete audience. Please try again." },
    { id: populatedListId, result: { success: false, totalCount: 25, recipients }, message: "Unable to download the complete audience. Please try again." },
    { id: populatedListId, result: { totalCount: 25, recipients }, message: "Unable to download the complete audience. Please try again." },
    { id: populatedListId, result: { success: true, totalCount: 1, recipients: [{ first_name: "Invalid", email: "" }] }, message: "Unable to download the complete audience. Please try again." },
  ];
  let currentCase;
  const state = await installFixtures(page, baseURL, {
    previewResponder: ({ route, body, state: fixture }) => {
      if (body?.listId !== currentCase?.id) {
        fixture.unexpectedRequests.push(`POST preview ${JSON.stringify(body)}`);
        return json(route, { error: "Unexpected list" }, 599);
      }
      return json(route, currentCase.result, currentCase.status || 200);
    },
  });
  const downloads = [];
  page.on("download", download => downloads.push(download));
  await openLists(page);
  for (const scenario of failureCases) {
    currentCase = scenario;
    await page.getByTestId(`button-download-list-${scenario.id}`).click();
    await expect.poll(() => state.previewRequests.length).toBe(failureCases.indexOf(scenario) + 1);
    await expect(page.getByText(scenario.message, { exact: true }).last()).toBeVisible();
    await expect(page.getByTestId(`button-download-list-${scenario.id}`)).toBeEnabled();
    expect(downloads, `No download for ${JSON.stringify(scenario.result)}`).toHaveLength(0);
  }
  expect(state.previewRequests).toEqual(failureCases.map(({ id }) => ({ listId: id })));
  assertSafeFixture(state);
});

test("duplicate clicks are fenced while export loads, and preview and other lists remain independent", async ({ page, baseURL }) => {
  let releaseExport;
  const pendingExport = new Promise(resolve => { releaseExport = resolve; });
  let exportCalls = 0;
  const state = await installFixtures(page, baseURL, {
    previewResponder: async ({ route, body, state: fixture }) => {
      if (body?.listId === populatedListId) {
        exportCalls++;
        if (exportCalls === 1) await pendingExport;
        return json(route, { success: true, listName: audienceLists[0].name, totalCount: 25, recipients });
      }
      if (body?.listId === emptyListId) {
        return json(route, { success: true, listName: audienceLists[1].name, totalCount: 0, recipients: [] });
      }
      fixture.unexpectedRequests.push(`POST preview ${JSON.stringify(body)}`);
      return json(route, { error: "Unexpected list" }, 599);
    },
  });
  const downloads = [];
  page.on("download", download => downloads.push(download));
  await openLists(page);
  const exportButton = page.getByTestId(`button-download-list-${populatedListId}`);
  const emptyExportButton = page.getByTestId(`button-download-list-${emptyListId}`);
  try {
    // Both clicks originate in one browser JS task, without awaiting a paint
    // or the first request (unlike clicking only after disabled is visible).
    await exportButton.evaluate(button => { button.click(); button.click(); });
    await expect(exportButton).toBeDisabled();
    await expect(exportButton).toHaveAttribute("aria-busy", "true");
    await expect(emptyExportButton).toBeEnabled();
    await expect(emptyExportButton).toHaveAttribute("aria-busy", "false");
    await page.getByTestId(`button-preview-list-${emptyListId}`).click();
    const dialog = page.getByRole("dialog", { name: audienceLists[1].name, exact: true });
    await expect(dialog.getByTestId("preview-empty")).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await emptyExportButton.click();
    await expect(page.getByText("No recipients found for this audience list.", { exact: true })).toBeVisible();
    expect(downloads).toHaveLength(0);
    expect(exportCalls).toBe(1);
    const downloadPromise = page.waitForEvent("download");
    releaseExport();
    await downloadPromise;
    expect(downloads).toHaveLength(1);
    await expect(exportButton).toBeEnabled();
    await expect(exportButton).toHaveAttribute("aria-busy", "false");
    expect(state.previewRequests).toEqual([
      { listId: populatedListId }, { listId: emptyListId }, { listId: emptyListId },
    ]);
    assertSafeFixture(state);
  } finally {
    releaseExport();
  }
});

test("export action coexists with edit and delete, and survives switching category tabs", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL);
  await openLists(page);
  const exportButton = page.getByTestId(`button-download-list-${populatedListId}`);
  await expect(exportButton).toBeVisible();
  await page.getByTestId(`button-edit-list-${populatedListId}`).click();
  const editDialog = page.getByRole("dialog", { name: "Edit List", exact: true });
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole("button", { name: "Close" }).click();
  await page.getByTestId(`button-delete-list-${populatedListId}`).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete Saved List" });
  await expect(deleteDialog).toContainText(audienceLists[0].name);
  await deleteDialog.getByTestId("button-cancel-delete-list").click();
  await page.getByTestId("tab-categories").click();
  await expect(exportButton).toBeHidden();
  await page.getByTestId("tab-lists").click();
  await expect(exportButton).toBeEnabled();
  await expect(page.getByTestId(`button-download-list-${reviewListId}`)).toBeVisible();
  expect(state.previewRequests).toEqual([]);
  assertSafeFixture(state);
});

test("existing category CSV export still includes member and external subscribers after audience-list export is added", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL, { categoryExport: true });
  await openLists(page);
  await expect(page.getByTestId(`button-download-list-${populatedListId}`)).toBeVisible();
  await page.getByTestId("tab-categories").click();
  const categoryId = "category-export-regression";
  const category = page.getByTestId(`card-category-${categoryId}`);
  await expect(category).toBeVisible();
  await category.getByTestId(`button-toggle-category-${categoryId}`).click();
  const button = category.getByTestId(`button-export-category-${categoryId}`);
  await expect(category.getByTestId(`button-view-subscribers-${categoryId}`)).toContainText("2 subscribers");
  await expect(button).toBeEnabled();
  const beforeDate = new Date().toISOString().slice(0, 10);
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  const download = await downloadPromise;
  const afterDate = new Date().toISOString().slice(0, 10);
  expect([
    `member___external_news_subscribers_${beforeDate}.csv`,
    `member___external_news_subscribers_${afterDate}.csv`,
  ]).toContain(download.suggestedFilename());
  const bytes = await readFile(await download.path());
  // This is the existing category format, deliberately distinct from the
  // audience-list CSV's BOM, CRLF, three-column and formula-safe format.
  expect(bytes.toString("utf8")).toBe([
    "Name,Organisation,Role,Email,Type",
    '"Maya ""MJ"" Patel","Preview Organisation","Administrator","maya@example.invalid","Member"',
    '"Elena López","N/A","N/A","elena@example.invalid","External"',
  ].join("\n"));
  expect(state.previewRequests).toEqual([]);
  expect(state.apiRequests.filter(request => request.startsWith("GET /api/admin/external-subscribers?")))
    .toHaveLength(1);
  assertSafeFixture(state);
});
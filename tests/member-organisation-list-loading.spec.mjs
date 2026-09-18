import { test, expect } from "@playwright/test";
import {
  createListFixture,
  defaultSavedView,
  installListFixture,
  task4507Fixtures,
} from "./member-organisation-list-loading.fixtures.mjs";

const PAGES = [
  {
    page: "members",
    path: "/members",
    searchId: "input-search-members",
    title: /^Members$/,
    alpha: "Alice Alpha",
    beta: "Bob Beta",
    empty: "Empty Title",
    coreId: "input-filter-member-job-title",
    coreValue: "Manager",
    resetId: "button-reset-member-filters",
    initializationErrorId: "member-list-initialization-error",
    retryInitializationId: "button-retry-member-list-initialization",
    metadataErrorId: "member-field-metadata-error",
    retryMetadataId: "button-retry-member-field-metadata",
    listErrorId: "member-list-error",
    retryListId: "button-retry-members",
  },
  {
    page: "organisations",
    path: "/organisations",
    searchId: "input-search-orgs",
    title: /^Organisations$/,
    alpha: "Alpha Association",
    beta: "Beta Bureau",
    empty: "No Phone Network",
    coreId: "input-filter-phone",
    coreValue: "001",
    resetId: "button-reset-filters",
    initializationErrorId: "org-list-initialization-error",
    retryInitializationId: "button-retry-org-list-initialization",
    metadataErrorId: "org-field-metadata-error",
    retryMetadataId: "button-retry-org-field-metadata",
    listErrorId: "org-list-error",
    retryListId: "button-retry-organisations",
  },
];

async function setup(page, cfg, options = {}) {
  const state = createListFixture(options);
  state.page = cfg.page;
  await installListFixture(page, state);
  return state;
}

async function openReady(page, cfg) {
  await page.goto(cfg.path);
  await expect(page.getByRole("heading", { name: cfg.title })).toBeVisible();
  await expect(page.getByTestId(cfg.searchId)).toBeEnabled();
}

for (const cfg of PAGES) {
  test(`${cfg.page}: initial saved-view restoration locks controls briefly and makes one authoritative request`, async ({ page }) => {
    const state = await setup(page, cfg);
    const releaseSettings = state.defer("settings");
    await page.goto(cfg.path);
    const search = page.getByTestId(cfg.searchId);
    await expect(search).toBeVisible();
    await expect(search).toBeDisabled();
    await expect(page.getByText(/loading (saved )?(filters|views)|restoring/i).first()).toBeVisible();
    expect(state.listReads).toHaveLength(0);
    releaseSettings();
    await expect(search).toBeEnabled();
    await expect.poll(() => state.listReads.length).toBe(1);
    expect(state.listReads[0].query.search).toBe("");
    expect(state.unexpectedWrites).toEqual([]);
  });

  test(`${cfg.page}: filters remain usable during slow rows and the latest search/core filters win`, async ({ page }) => {
    const state = await setup(page, cfg);
    await openReady(page, cfg);
    await expect.poll(() => state.listReads.length).toBe(1);

    const releaseList = state.defer("list");
    await page.getByTestId(cfg.searchId).fill("Alpha");
    await page.waitForTimeout(350);
    await expect(page.getByTestId(cfg.searchId)).toBeEnabled();
    await page.getByTestId(cfg.searchId).fill("Beta");
    await page.getByTestId(cfg.coreId).fill(cfg.coreValue);
    await page.waitForTimeout(350);
    releaseList();

    await expect.poll(() => state.listReads.at(-1)?.query.search).toBe("Beta");
    expect(JSON.parse(state.listReads.at(-1).query.coreFilters)).toEqual(
      expect.objectContaining(cfg.page === "members"
        ? { job_title: expect.objectContaining({ value: cfg.coreValue }) }
        : { phone: expect.objectContaining({ value: cfg.coreValue }) }),
    );
    await expect(page.getByText(cfg.beta, { exact: true })).toBeVisible();
    await expect(page.getByText(cfg.alpha, { exact: true })).toHaveCount(0);
    expect(state.unexpectedWrites).toEqual([]);
  });

  test(`${cfg.page}: saved default and custom empty operator wait for authoritative metadata`, async ({ page }) => {
    const customId = cfg.page === "members" ? "task4507-member-note" : "task4507-org-sector";
    const savedView = defaultSavedView(cfg.page, {
      filters: {
        searchQuery: "",
        ...(cfg.page === "members" ? { statusFilter: "all" } : {}),
        customFieldFilters: { [customId]: "" },
        filterOps: { [customId]: "empty" },
      },
    });
    const state = await setup(page, cfg, { savedView });
    const releaseMetadata = state.defer("metadata");
    await page.goto(cfg.path);
    await expect(page.getByTestId(cfg.searchId)).toBeDisabled();
    await page.waitForTimeout(500);
    expect(state.listReads).toHaveLength(0);
    releaseMetadata();
    await expect(page.getByTestId(cfg.searchId)).toBeEnabled();
    await expect.poll(() => state.listReads.length).toBe(1);
    expect(JSON.parse(state.listReads[0].query.customFilters)).toEqual({
      [customId]: { op: "empty" },
    });
    await expect(page.getByText(cfg.empty, { exact: true })).toBeVisible();
    await expect(page.getByText(cfg.alpha, { exact: true })).toHaveCount(0);
  });

  test(`${cfg.page}: saved-view, metadata, and list errors are distinct and retryable`, async ({ page }) => {
    const state = await setup(page, cfg, {
      invalidSavedSetting: true,
      failures: { metadata: 2, list: 1 },
    });
    await page.goto(cfg.path);
    await expect(page.getByTestId(cfg.initializationErrorId)).toBeVisible();
    state.invalidSavedSetting = false;
    await page.getByTestId(cfg.retryInitializationId).click();
    await expect(page.getByTestId(cfg.metadataErrorId)).toBeVisible();
    await page.getByTestId(cfg.retryMetadataId).click();
    await expect(page.getByTestId(cfg.listErrorId)).toBeVisible();
    await page.getByTestId(cfg.retryListId).click();
    await expect(page.getByTestId(cfg.searchId)).toBeEnabled();
    await expect.poll(() => state.listReads.length).toBeGreaterThan(0);
    expect(state.unexpectedWrites).toEqual([]);
  });

  test(`${cfg.page}: reversed responses cannot replace newer results and reset clears filters`, async ({ page }) => {
    const state = await setup(page, cfg, { responseDelays: [0, 900, 50, 0] });
    await openReady(page, cfg);
    await expect.poll(() => state.listReads.length).toBe(1);
    await page.getByTestId(cfg.searchId).fill("Alpha");
    await page.waitForTimeout(350);
    await page.getByTestId(cfg.searchId).fill("Beta");
    await page.waitForTimeout(350);
    await expect(page.getByText(cfg.beta, { exact: true })).toBeVisible();
    await page.waitForTimeout(750);
    await expect(page.getByText(cfg.beta, { exact: true })).toBeVisible();
    await expect(page.getByText(cfg.alpha, { exact: true })).toHaveCount(0);

    await page.getByTestId(cfg.resetId).click();
    await expect(page.getByTestId(cfg.searchId)).toHaveValue("");
    await expect(page.getByText(cfg.alpha, { exact: true })).toBeVisible();
    await expect(page.getByText(cfg.beta, { exact: true })).toBeVisible();
  });
}

test("warm remount and tenant switch do not reuse saved views or list data across tenants", async ({ page }) => {
  const cfg = PAGES[1];
  const state = await setup(page, cfg, { savedView: defaultSavedView("organisations") });
  await openReady(page, cfg);
  await expect(page.getByText("Alpha Association", { exact: true })).toBeVisible();
  await page.goto("/Events");

  state.setViewer({
    ...task4507Fixtures.ADMIN,
    id: "task4507-admin-two",
    tenant_id: task4507Fixtures.TENANTS.two.id,
    email: "task4507-admin-two@example.invalid",
  });
  state.savedView = null;
  await page.goto(cfg.path);
  await expect(page.getByText("Tenant Two Organisation", { exact: true })).toBeVisible();
  await expect(page.getByText("Alpha Association", { exact: true })).toHaveCount(0);
  expect(state.listReads.at(-1).tenantId).toBe(task4507Fixtures.TENANTS.two.id);
  expect(state.unexpectedWrites).toEqual([]);
});

test("large synthetic tenant uses targeted saved-view settings reads on the critical path", async ({ page }) => {
  const cfg = PAGES[0];
  const state = await setup(page, cfg, { unrelatedSettings: 1250 });
  const started = Date.now();
  await openReady(page, cfg);
  await expect.poll(() => state.listReads.length).toBe(1);
  const elapsedMs = Date.now() - started;
  expect(state.settingsReads.length).toBeGreaterThan(0);
  const targetedReads = state.settingsReads.filter(read => {
    const filter = JSON.parse(read.query.filter || "{}");
    return Array.isArray(filter.setting_key);
  });
  expect(targetedReads).toHaveLength(1);
  expect(targetedReads[0].returnedRows).toBeLessThanOrEqual(2);
  test.info().annotations.push({
    type: "synthetic-performance",
    description: `first authoritative fixture list in ${elapsedMs}ms; targeted saved-view rows ${targetedReads[0].returnedRows}; all settings responses ${state.settingsReads.map(read => read.returnedRows).join(",")}; fixture is synthetic, not production`,
  });
});

test("capture isolated fixture screenshots for both corrected CRM routes", async ({ page }) => {
  for (const cfg of PAGES) {
    const state = await setup(page, cfg);
    await openReady(page, cfg);
    await expect.poll(() => state.listReads.length).toBeGreaterThan(0);
    await page.screenshot({
      path: `/tmp/task4507-${cfg.page}.png`,
      fullPage: true,
    });
    expect(state.unexpectedWrites).toEqual([]);
    await page.unrouteAll({ behavior: "wait" });
  }
});
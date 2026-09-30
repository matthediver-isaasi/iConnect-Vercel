import { test, expect } from "@playwright/test";

const TENANT = { id: "guest-writer-fixture-tenant", slug: "guest-writer-fixture" };
const ADMIN = {
  id: "guest-writer-fixture-admin",
  tenant_id: TENANT.id,
  role_id: "guest-writer-fixture-role",
  email: "admin@guest-writer.example.invalid",
  first_name: "Fixture",
  last_name: "Administrator",
  is_team_member: true,
  member_excluded_features: [],
};

function writer(index, overrides = {}) {
  const number = String(index).padStart(2, "0");
  return {
    id: `fixture-writer-${number}`,
    tenant_id: TENANT.id,
    full_name: `Writer ${number} Fixture`,
    email: `writer${number}@example.invalid`,
    organization: `Fixture Organisation ${number}`,
    job_title: `Fixture Role ${number}`,
    biography: `Synthetic browser fixture writer ${number}.`,
    profile_photo_url: "",
    linkedin_url: "",
    is_active: true,
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installFixture(page, options = {}) {
  const state = {
    writers: clone(options.writers || Array.from({ length: 49 }, (_, index) => writer(index + 1))),
    reads: [],
    writes: [],
    failures: Number(options.failures || 0),
    searchDelays: { ...(options.searchDelays || {}) },
    nextId: 100,
    pageErrors: [],
  };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.addInitScript(member => {
    localStorage.setItem("agcas_member", JSON.stringify(member));
  }, ADMIN);

  await page.route("**/realtime/v1/**", route => route.abort("blockedbyclient"));
  await page.route("**/rest/v1/**", route => json(route, []));
  await page.route("**/storage/v1/**", route => route.abort("blockedbyclient"));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") return json(route, ADMIN);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        authenticated: true,
        user: ADMIN,
        member: ADMIN,
        tenant: TENANT,
        tenantId: TENANT.id,
        memberId: ADMIN.id,
      });
    }
    if (path === `/api/entities/Member/${ADMIN.id}`) return json(route, ADMIN);
    if (path === `/api/entities/Role/${ADMIN.role_id}`) {
      return json(route, { id: ADMIN.role_id, name: "Administrator", excluded_features: [] });
    }
    if (path === "/api/entities/Member") return json(route, [ADMIN]);
    if (path === "/api/entities/Role") {
      return json(route, [{ id: ADMIN.role_id, name: "Administrator", excluded_features: [] }]);
    }

    if (path === "/api/entities/GuestWriter" && method === "GET") {
      const search = (url.searchParams.get("search") || "").trim().toLowerCase();
      const limit = Number(url.searchParams.get("limit") || 12);
      const offset = Number(url.searchParams.get("offset") || 0);
      state.reads.push({ search, limit, offset, at: Date.now() });
      const delay = Number(state.searchDelays[search] || 0);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (state.failures > 0) {
        state.failures -= 1;
        return json(route, { error: "Synthetic guest writer list failure" }, 503);
      }
      const matching = state.writers
        .filter(row => !search || [
          row.full_name,
          row.email,
          row.organization,
          row.job_title,
        ].some(value => String(value || "").toLowerCase().includes(search)))
        .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));
      return json(route, {
        data: matching.slice(offset, offset + limit),
        count: matching.length,
      });
    }

    if (path === "/api/entities/GuestWriter" && method === "POST") {
      const body = request.postDataJSON();
      const created = {
        ...writer(state.nextId),
        ...body,
        id: `fixture-writer-${state.nextId++}`,
        tenant_id: TENANT.id,
      };
      state.writers.push(created);
      state.writes.push({ method, id: created.id, body });
      return json(route, created, 201);
    }

    const writerMatch = path.match(/^\/api\/entities\/GuestWriter\/([^/]+)$/);
    if (writerMatch && method === "PATCH") {
      const id = decodeURIComponent(writerMatch[1]);
      const body = request.postDataJSON();
      const index = state.writers.findIndex(row => row.id === id);
      if (index < 0) return json(route, { error: "Fixture writer not found" }, 404);
      state.writers[index] = { ...state.writers[index], ...body };
      state.writes.push({ method, id, body });
      return json(route, state.writers[index]);
    }
    if (writerMatch && method === "DELETE") {
      const id = decodeURIComponent(writerMatch[1]);
      state.writers = state.writers.filter(row => row.id !== id);
      state.writes.push({ method, id });
      return json(route, { success: true });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push({ method, path, unexpected: true });
      return json(route, { error: `Unexpected fixture write: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

async function openReady(page) {
  await page.goto("/GuestWriterManagement");
  await expect(page.getByRole("heading", { name: "Guest Writers" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search guest writers" })).toBeEnabled();
  await expect(page.getByText("Showing 1–12 of 49")).toBeVisible();
}

test("desktop and narrow layouts expose usable search, page size, cards, and pagination", async ({ browser }, testInfo) => {
  for (const viewport of [
    { name: "desktop", size: { width: 1440, height: 1000 } },
    { name: "narrow", size: { width: 390, height: 844 } },
  ]) {
    const context = await browser.newContext({ viewport: viewport.size });
    const page = await context.newPage();
    const state = await installFixture(page);
    await openReady(page);
    await expect(page.getByText("Writer 01 Fixture", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Guest Writer" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Guest writer pagination" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`guest-writers-${viewport.name}.png`),
      fullPage: true,
    });
    expect(state.pageErrors).toEqual([]);
    expect(state.writes).toEqual([]);
    await context.close();
  }
});

test("12, 24, and 48 page sizes send bounded ranges and navigate to shorter final pages", async ({ page }) => {
  const state = await installFixture(page);
  await openReady(page);

  for (const scenario of [
    { size: "12", first: "Showing 1–12 of 49", pages: "Page 1 of 5", last: "Showing 49–49 of 49", clicks: 4 },
    { size: "24", first: "Showing 1–24 of 49", pages: "Page 1 of 3", last: "Showing 49–49 of 49", clicks: 2 },
    { size: "48", first: "Showing 1–48 of 49", pages: "Page 1 of 2", last: "Showing 49–49 of 49", clicks: 1 },
  ]) {
    await page.getByLabel("Per page").selectOption(scenario.size);
    await expect(page.getByText(scenario.first)).toBeVisible();
    await expect(page.getByText(scenario.pages)).toBeVisible();
    for (let click = 0; click < scenario.clicks; click += 1) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await expect(page.getByText(scenario.last)).toBeVisible();
    await expect(page.getByText("Writer 49 Fixture", { exact: true })).toBeVisible();
  }

  expect(state.reads).toEqual(expect.arrayContaining([
    expect.objectContaining({ limit: 12, offset: 48 }),
    expect.objectContaining({ limit: 24, offset: 48 }),
    expect.objectContaining({ limit: 48, offset: 48 }),
  ]));
});

test("search is debounced, rapid stale responses cannot replace the latest result, and no-match clear restores all writers", async ({ page }) => {
  const state = await installFixture(page, {
    writers: [
      writer(1, { full_name: "Alpha Slow Writer" }),
      writer(2, { full_name: "Beta Latest Writer" }),
      writer(3, { full_name: "Gamma Writer" }),
    ],
    searchDelays: { alpha: 900, beta: 30 },
  });
  await page.goto("/GuestWriterManagement");
  const search = page.getByRole("searchbox", { name: "Search guest writers" });
  await expect(search).toBeEnabled();
  await expect(page.getByText("Showing 1–3 of 3")).toBeVisible();

  await search.fill("a");
  await page.waitForTimeout(100);
  await search.fill("al");
  await page.waitForTimeout(100);
  await search.fill("alpha");
  await page.waitForTimeout(350);
  await search.fill("beta");
  await page.waitForTimeout(350);
  await expect(page.getByText("Beta Latest Writer", { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByText("Beta Latest Writer", { exact: true })).toBeVisible();
  await expect(page.getByText("Alpha Slow Writer", { exact: true })).toHaveCount(0);
  expect(state.reads.filter(read => ["a", "al"].includes(read.search))).toHaveLength(0);

  await search.fill("no-result-fixture");
  await expect(page.getByRole("heading", { name: "No matching guest writers" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByText("Showing 1–3 of 3")).toBeVisible();
  await expect(page.getByText("Alpha Slow Writer", { exact: true })).toBeVisible();
});

test("list errors are explicit and retryable", async ({ page }) => {
  const state = await installFixture(page, { failures: 1 });
  await page.goto("/GuestWriterManagement");
  await expect(page.getByRole("heading", { name: "Guest writers could not be loaded" })).toBeVisible();
  await expect(page.getByText("Synthetic guest writer list failure")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Showing 1–12 of 49")).toBeVisible();
  expect(state.reads).toHaveLength(2);
});

test("create, edit, and deleting the only final-page writer refresh exact counts and recover the page", async ({ page }) => {
  const state = await installFixture(page);
  await openReady(page);

  await page.getByRole("button", { name: "Add Guest Writer" }).click();
  await page.getByLabel("Full Name *").fill("A Newly Created Writer");
  await page.getByLabel("Email *").fill("new.writer@example.invalid");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("A Newly Created Writer", { exact: true })).toBeVisible();
  await expect(page.getByText("Showing 1–12 of 50")).toBeVisible();

  const createdCard = page.getByText("A Newly Created Writer", { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-xl')]");
  await createdCard.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Full Name *").fill("A Edited Writer");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("A Edited Writer", { exact: true })).toBeVisible();

  await page.getByLabel("Per page").selectOption("48");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Showing 49–50 of 50")).toBeVisible();
  await page.getByRole("button", { name: "Delete Writer 49 Fixture" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Showing 49–49 of 49")).toBeVisible();
  await page.getByRole("button", { name: "Delete Writer 48 Fixture" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Showing 1–48 of 48")).toBeVisible();
  await expect(page.getByText("Page 1 of 1")).toBeVisible();

  expect(state.writes.map(write => write.method)).toEqual(["POST", "PATCH", "DELETE", "DELETE"]);
  expect(state.writes.some(write => write.unexpected)).toBe(false);
  expect(state.pageErrors).toEqual([]);
});
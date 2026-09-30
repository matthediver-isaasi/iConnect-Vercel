import { expect, test } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:5000";
const role = { id: "profile-save-role", tenant_id: "profile-save-tenant", name: "Member", excluded_features: [] };
const member = {
  id: "profile-save-member",
  tenant_id: role.tenant_id,
  role_id: role.id,
  email: "profile-save@example.invalid",
  first_name: "Ada",
  last_name: "Fixture",
  job_title: "Old title",
  mobile: "07000000000",
  landline: "02000000000",
  biography: "Original biography",
  show_in_directory: true,
  profile_photo_url: "",
  created_on: "2024-01-01T00:00:00Z",
  sessionExpiry: "2099-01-01T00:00:00Z",
  handle: "ada-fixture",
  sessionRole: {
    status: "ready", member_id: "profile-save-member",
    tenant_id: role.tenant_id, role_id: role.id,
    session_key: "profile-save-fixture", role,
  },
};
const profileKeys = [
  "first_name", "last_name", "job_title", "mobile", "landline",
  "biography", "profile_photo_url", "show_in_directory",
];

function json(route, body, status = 200) {
  return route.fulfill({
    status, contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(page) {
  const state = { updates: [], uploads: [], blocked: [], gate: null, failNext: false, saved: { ...member } };
  await page.addInitScript((cached) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("agcas_member", JSON.stringify(cached));
  }, member);
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path } = url;
    const method = request.method();
    const key = `${method} ${url.href}`;
    if (url.origin === ORIGIN && !path.startsWith("/api/")) return route.continue();

    // No request may reach a real provider. Only the actual profile table PATCH
    // can succeed; a fallback entity write must not make these tests pass.
    if (url.hostname.endsWith(".supabase.co") && path === "/rest/v1/member"
      && method === "PATCH" && url.searchParams.get("id") === `eq.${member.id}`) {
      const payload = request.postDataJSON();
      state.updates.push({ url: url.href, method, payload });
      const gate = state.gate;
      const fail = state.failNext;
      state.gate = null;
      state.failNext = false;
      if (gate) await gate.promise;
      if (fail) return json(route, { message: "Fixture save failed", code: "FIXTURE_ERROR" }, 400);
      state.saved = { ...state.saved, ...payload };
      return json(route, state.saved);
    }
    if (url.hostname.endsWith(".supabase.co")
      && method === "POST" && path.startsWith(`/storage/v1/object/member-photos/${member.id}/`)) {
      state.uploads.push({ method, path });
      return json(route, { Key: path.slice("/storage/v1/object/".length) });
    }
    if (url.hostname.endsWith(".supabase.co") && method === "GET"
      && path.startsWith("/storage/v1/object/public/member-photos/")) {
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.hostname.endsWith(".supabase.co") && path.startsWith("/rest/v1/")
      && method === "GET") return json(route, []);
    if (url.origin === ORIGIN && path.startsWith("/api/")) {
      if (method === "PATCH" && path === `/api/entities/Member/${member.id}`
        && Object.keys(request.postDataJSON() || {}).join() === "last_activity") {
        return json(route, member);
      }
      if (method !== "GET") {
        state.blocked.push(key);
        return json(route, { error: `Unexpected fixture mutation ${key}` }, 599);
      }
      if (path === "/api/auth/me") return json(route, state.saved);
      if (path === "/api/auth/tenant-user-me") return json(route, { authenticated: false }, 401);
      if (path === `/api/entities/Role/${role.id}`) return json(route, role);
      if (path === "/api/entities/Role") return json(route, [role]);
      if (path === "/api/entities/Member") return json(route, [member]);
      if (path === "/api/my-member-field-permissions") return json(route, {});
      if (path === "/api/member/communication-preferences") return json(route, { categories: [], preferences: [] });
      if (path === "/api/public/tenant-branding") {
        return json(route, { success: true, branding: { id: role.tenant_id, name: "Profile fixture", headerConfig: {}, footerConfig: {} } });
      }
      if (path === "/api/public/portal-branding") return json(route, { tenantName: "Profile fixture" });
      if (path === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
      if (path === "/api/custom-objects") return json(route, { objects: [], total: 0 });
      if (path === "/api/my-badges") return json(route, { badges: [] });
      return json(route, []);
    }
    // Block every external host (including scripts, fonts, storage and unknown
    // Supabase endpoints). None can read/write a live database.
    state.blocked.push(key);
    return route.abort("blockedbyclient");
  });
  await page.goto("/about-me");
  await expect(page.getByLabel("Job Title")).toHaveValue("Old title");
  return state;
}

function profile(page) {
  return {
    title: page.getByLabel("Job Title"),
    first: page.getByLabel("First Name"),
    last: page.getByLabel("Last Name"),
    mobile: page.getByLabel("Mobile", { exact: true }),
    landline: page.getByLabel("Landline"),
    biography: page.getByLabel("Your Biography"),
    directory: page.getByRole("switch", { name: "Show in Member Directory" }),
    save: page.getByRole("button", { name: "Save Profile" }),
  };
}

async function cached(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("agcas_member")));
}

async function seedSessionMetadata(page) {
  // The app's auth bootstrap refreshes sessionExpiry and may normalize
  // sessionRole; seed extra metadata only after it finishes initializing.
  await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("agcas_member"));
    localStorage.setItem("agcas_member", JSON.stringify({
      ...session, fixtureMetadata: { preserved: true, nested: ["a", "b"] },
    }));
  });
}

function assertSingleProfileUpdate(state, count = 1) {
  expect(state.blocked.filter((key) => /(?:PATCH|POST|PUT|DELETE) /.test(key))).toEqual([]);
  expect(state.updates).toHaveLength(count);
  for (const update of state.updates) {
    expect(update.method).toBe("PATCH");
    expect(Object.keys(update.payload).sort()).toEqual([...profileKeys].sort());
  }
}

test("populated session and fresh cache: job title saves through member update and survives reload", async ({ page }) => {
  const state = await fixture(page);
  const fields = profile(page);
  await seedSessionMetadata(page);
  await fields.title.fill("Careers Adviser");
  await fields.save.click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].payload.job_title).toBe("Careers Adviser");
  await expect.poll(async () => (await cached(page)).job_title).toBe("Careers Adviser");
  // Cache reconciliation must update the mounted form, not merely localStorage.
  await expect(fields.title).toHaveValue("Careers Adviser");
  await expect(fields.save).toBeHidden();
  expect((await cached(page)).fixtureMetadata).toEqual({ preserved: true, nested: ["a", "b"] });
  await page.reload();
  await expect(fields.title).toHaveValue("Careers Adviser");
  await expect(fields.save).toBeHidden();
  await page.goto("/Preferences");
  await expect(fields.title).toHaveValue("Careers Adviser");
  await page.goBack();
  await expect(fields.title).toHaveValue("Careers Adviser");
  await expect(fields.save).toBeHidden();
  assertSingleProfileUpdate(state);
});

test("saves other profile fields, empty clearing and directory visibility without losing session metadata", async ({ page }) => {
  const state = await fixture(page);
  const fields = profile(page);
  await seedSessionMetadata(page);
  await fields.first.fill("Grace");
  await fields.last.fill("Example");
  await fields.mobile.fill("");
  await fields.landline.fill("02012345678");
  await fields.biography.fill("");
  await fields.directory.click();
  await fields.save.click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].payload).toMatchObject({
    first_name: "Grace", last_name: "Example", mobile: "",
    landline: "02012345678", biography: "", show_in_directory: false,
  });
  await expect.poll(async () => (await cached(page)).last_name).toBe("Example");
  await expect(fields.first).toHaveValue("Grace");
  await expect(fields.last).toHaveValue("Example");
  await expect(fields.mobile).toHaveValue("");
  await expect(fields.landline).toHaveValue("02012345678");
  await expect(fields.biography).toHaveValue("");
  await expect(fields.directory).not.toBeChecked();
  await expect(fields.save).toBeHidden();
  await expect(page.getByRole("button", { name: "Save Biography" })).toBeHidden();
  const session = await cached(page);
  expect(session).toMatchObject({
    email: member.email, tenant_id: member.tenant_id,
    handle: member.handle, fixtureMetadata: { preserved: true, nested: ["a", "b"] },
    mobile: "", biography: "", show_in_directory: false,
  });
  assertSingleProfileUpdate(state);
});

test("failed save retains edited inputs and allows retry", async ({ page }) => {
  const state = await fixture(page);
  const fields = profile(page);
  state.failNext = true;
  await fields.title.fill("Retry title");
  await fields.save.click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect(page.getByText("Failed to update profile", { exact: true })).toBeVisible();
  await expect(fields.title).toHaveValue("Retry title");
  await expect(fields.save).toBeEnabled();
  expect((await cached(page)).job_title).toBe("Old title");
  await fields.save.click();
  await expect.poll(() => state.updates.length).toBe(2);
  await expect.poll(async () => (await cached(page)).job_title).toBe("Retry title");
  assertSingleProfileUpdate(state, 2);
});

test("pending save blocks repeat submission and does not erase a newer edit", async ({ page }) => {
  const state = await fixture(page);
  const fields = profile(page);
  state.gate = deferred();
  const gate = state.gate;
  await fields.title.fill("First submitted title");
  await fields.save.click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect(page.getByRole("button", { name: "Saving..." }).first()).toBeDisabled();
  await fields.title.fill("Newer unsaved title");
  expect(state.updates).toHaveLength(1);
  gate.release();
  await expect.poll(async () => (await cached(page)).job_title).toBe("First submitted title");
  await expect(fields.title).toHaveValue("Newer unsaved title");
  await expect(fields.save).toBeVisible();
  await fields.save.click();
  await expect.poll(() => state.updates.length).toBe(2);
  expect(state.updates[1].payload.job_title).toBe("Newer unsaved title");
  await expect.poll(async () => (await cached(page)).job_title).toBe("Newer unsaved title");
  assertSingleProfileUpdate(state, 2);
});

test("malformed localStorage after initialization cannot prevent successful profile save", async ({ page }) => {
  const state = await fixture(page);
  const fields = profile(page);
  await page.evaluate(() => localStorage.setItem("agcas_member", "{invalid"));
  await fields.title.fill("Recovered title");
  await fields.save.click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect.poll(async () => {
    try { return (await cached(page)).job_title; } catch { return null; }
  }).toBe("Recovered title");
  assertSingleProfileUpdate(state);
});

test("photo upload confirms the member patch before updating the cached profile", async ({ page }) => {
  const state = await fixture(page);
  await seedSessionMetadata(page);
  await page.locator("#photo-upload").setInputFiles({
    name: "portrait.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YlB2i8AAAAASUVORK5CYII=", "base64"),
  });
  await expect.poll(() => state.uploads.length).toBe(1);
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].payload).toEqual({
    profile_photo_url: expect.stringMatching(/\/storage\/v1\/object\/public\/member-photos\/profile-save-member\/.+\.png$/),
  });
  await expect.poll(async () => (await cached(page)).profile_photo_url)
    .toBe(state.updates[0].payload.profile_photo_url);
  expect((await cached(page)).fixtureMetadata).toEqual({ preserved: true, nested: ["a", "b"] });
  expect(state.blocked.filter((key) => /(?:PATCH|POST|PUT|DELETE) /.test(key))).toEqual([]);
});
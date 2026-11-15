import { test, expect } from "@playwright/test";

test("new sessions reuse current local dates without overwriting edits", async ({ page }) => {
  const writes = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const member = { id: "fixture-admin", tenant_id: "fixture-tenant", role_id: "fixture-role",
    first_name: "Fixture", last_name: "Admin", email: "admin@example.invalid", status: "active" };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.context().route(/\/(?:rest|auth)\/v1\//, route => json(route, [], 403));
  await page.context().route("**/api/**", route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === `/api/entities/Member/${member.id}` && req.method() === "PATCH"
      && Object.keys(req.postDataJSON()).join() === "last_activity") return json(route, member);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
      writes.push(`${req.method()} ${path}`);
      return json(route, { error: "Unexpected fixture write" }, 599);
    }
    if (path === "/api/auth/me") return json(route, member);
    if (path === "/api/admin/event-registration-communication") return json(route, { categories: [], category_ids: [] });
    if (path === "/api/auth/tenant-user-me") return json(route, { user: member, tenant: { id: member.tenant_id } });
    if (path.startsWith("/api/entities/Member/")) return json(route, member);
    if (path.startsWith("/api/entities/Role")) {
      const role = { id: member.role_id, name: "Administrator", excluded_features: [] };
      return json(route, path.endsWith("/Role") ? [role] : role);
    }
    return json(route, []);
  });
  await page.goto("/CreateComplexEvent", { waitUntil: "domcontentloaded" });
  const cookie = page.getByRole("dialog", { name: "Cookie consent" });
  if (await cookie.isVisible()) await cookie.getByRole("button", { name: "Decline" }).click();
  await page.getByTestId("button-section-sessions").click();
  const start = page.getByTestId("input-session-start-time");
  const title = page.getByTestId("input-session-title");
  const save = () => page.getByRole("dialog").getByRole("button", { name: /^(Add|Save) Session$/ }).click();
  const cancel = () => page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("button-add-session").click();
  await expect(start).toHaveValue("");
  await title.fill("First local session");
  await start.fill("2028-08-12T15:30");
  await save();
  await page.getByTestId("button-add-session").click();
  await expect(start).toHaveValue("2028-08-12T15:30");
  // Native picker receives the far-future value rather than an empty/current date.
  await start.evaluate(input => input.showPicker());
  await page.screenshot({ path: "/tmp/session-start-default-calendar.png" });
  await page.keyboard.press("Escape");
  await start.fill("2028-10-02T10:45");
  await title.fill("Later local session");
  await expect(start).toHaveValue("2028-10-02T10:45");
  await save();
  await page.getByTestId("button-add-session").click();
  await expect(start).toHaveValue("2028-10-02T10:45");
  await cancel();
  const cards = page.locator('[data-testid^="session-card-"]');
  const first = cards.filter({ hasText: "First local session" });
  await first.hover();
  await first.locator('[data-testid^="button-edit-session-"]').click();
  await expect(start).toHaveValue("2028-08-12T15:30");
  await cancel();
  const later = cards.filter({ hasText: "Later local session" });
  await later.hover();
  await later.locator('[data-testid^="button-delete-session-"]').click();
  await page.getByTestId("button-add-session").click();
  await expect(start).toHaveValue("2028-08-12T15:30");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

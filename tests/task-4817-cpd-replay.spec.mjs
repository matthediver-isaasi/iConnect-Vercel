import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Every API and external request is intercepted. No real awards or member data.
const TENANT = "fixture-cpd-tenant";
const ADMIN = {
  id: "fixture-admin", email: "admin@example.invalid", first_name: "Admin", last_name: "Fixture",
  tenant_id: TENANT, organization_id: null, role_id: "fixture-role", member_excluded_features: [],
  sessionRole: { status: "ready", member_id: "fixture-admin", tenant_id: TENANT, role_id: "fixture-role",
    role: { id: "fixture-role", name: "Report admin", excluded_features: [] } },
};
const EVENTS = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Simple workshop", source: "event", is_complex: false, start_date: "2026-11-10T09:00:00Z" },
  { id: "22222222-2222-4222-8222-222222222222", title: "Complex conference", source: "complex_event", is_complex: true, start_date: "2026-11-11T09:00:00Z" },
];
const REPLAY = "33333333-3333-4333-8333-333333333333";
function group(source, grouped) {
  const event = EVENTS[source === "standard" ? 0 : 1];
  const id = source === "standard" ? "44444444-4444-4444-8444-444444444444" : "55555555-5555-4555-8555-555555555555";
  return {
    isGroup: grouped, groupRef: grouped ? "GROUP-FIXTURE" : null, attendeeCount: 1,
    eventTitle: event.title, eventId: event.id, isComplexEvent: event.is_complex,
    bookingSource: source === "standard" ? "booking" : "complex_event_booking",
    eventStartDate: event.start_date, hasZoom: false, hasAttendance: false, booker: null,
    groupPayment: { ticketTotal: 0, totalCost: 0, totalAfterDiscount: 0, discount: 0, voucherAmount: 0, trainingFundAmount: 0, accountAmount: 0, paymentMethod: "free", bookingReference: id },
    attendees: [{ id, attendee_first_name: source === "standard" ? "Simple" : "Complex", attendee_last_name: "Fixture",
      attendee_email: `${source}@example.invalid`, ticket_class_name: "Admission", ticket_price: 0, price_paid: 0,
      payment_method: "free", status: "confirmed", created_at: "2026-09-01T12:00:00Z" }],
  };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function fixture(page, { denied = false, stale = false } = {}) {
  const state = { previews: [], confirmations: [], rejected: [], resultReads: 0 };
  const groups = [group("standard", false), group("complex", true)];
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.context().routeWebSocket("**/*", socket => socket.onMessage(() => {}));
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:5000") return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/admin/event-cpd-points-replay") {
      if (denied) return json(route, { error: "Administrator access required" }, 403);
      if (request.method() === "GET") {
        if (!url.searchParams.has("replay_id")) return json(route, { replays: state.confirmations.length ? [{ replay_id: REPLAY, reason: "Recover missing points", created_at: "2026-11-20T12:00:00Z", enqueued_count: 1 }] : [] });
        state.resultReads++;
        const awarded = state.resultReads > 1;
        return json(route, { replay_id: REPLAY, reason: "Recover missing points", created_at: "2026-11-20T12:00:00Z",
          complete: awarded, total: 1, page: 1, page_size: 50,
          totals: { registrations: 1, pending: awarded ? 0 : 1, awarded: awarded ? 1 : 0, unchanged: 0, retrying: 0, failed: 0, awarded_points: awarded ? "1.5" : "0" },
          rows: [{ booking_id: groups[0].attendees[0].id, booking_source: "standard", event_id: EVENTS[0].id, attendee_name: "Simple Fixture", status: awarded ? "awarded" : "pending", points: awarded ? "1.5" : "0" }],
        });
      }
      const body = request.postDataJSON();
      if (body.action === "preview") {
        state.previews.push(body);
        const identities = body.scope.mode === "selected" ? body.scope.registrations : [
          { booking_id: groups[0].attendees[0].id, booking_source: body.scope.event_type === "simple" ? "standard" : "complex", event_id: body.scope.event_id },
          { booking_id: "66666666-6666-4666-8666-666666666666", booking_source: body.scope.event_type === "simple" ? "standard" : "complex", event_id: body.scope.event_id },
        ];
        return json(route, { complete: true, cursor: null, preview_token: "fixture-reviewed-token",
          totals: { registrations: identities.length, eligible: identities.length, proposed_points: String(identities.length * 1.5) },
          rows: identities.map(identity => ({ ...identity, attendee_name: "Preview Fixture", outcome: "eligible", proposed_points: "1.5", trigger: identity.booking_source === "complex" ? "attendance" : "registration", rule: { id: "rule-fixture", points: "1.5", ticket_id: null } })),
        });
      }
      if (body.action === "confirm") {
        state.confirmations.push(body);
        return stale ? json(route, { error: "Preview changed" }, 409) : json(route, { replay_id: REPLAY, enqueued_count: 1 }, 202);
      }
    }
    if (request.method() === "PATCH" && url.pathname === `/api/entities/Member/${ADMIN.id}`) return json(route, ADMIN);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.rejected.push(`${request.method()} ${url.pathname}`);
      return json(route, { error: "Fixture blocked mutation" }, 599);
    }
    if (url.pathname === "/api/auth/me") return json(route, ADMIN);
    if (url.pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: false }, 401);
    if (url.pathname === "/api/reports/event-registration-report") return json(route, { events: EVENTS,
      ...(url.searchParams.get("generate") === "true" ? { bookingGroups: groups, organizations: {}, summary: {} } : {}) });
    if (url.pathname.startsWith("/api/entities/Role/")) return json(route, ADMIN.sessionRole.role);
    if (url.pathname === "/api/entities/Role") return json(route, [ADMIN.sessionRole.role]);
    if (url.pathname.startsWith("/api/entities/Member/")) return json(route, ADMIN);
    if (url.pathname === "/api/entities/Member") return json(route, [ADMIN]);
    if (url.pathname === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (url.pathname === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (url.pathname === "/api/public/ai-help-persona") return json(route, { enabled: false });
    if (url.pathname === "/api/tenant-canvas-theme") return json(route, { theme: null });
    if (url.pathname === "/api/public/canvas-symbols") return json(route, { symbols: [] });
    if (url.pathname.startsWith("/api/redirects/resolve")) return json(route, { found: false });
    return json(route, []);
  });
  await page.goto("/EventRegistrationReport", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("text-page-title")).toBeVisible();
  await page.getByTestId("button-generate-report").click();
  await expect(page.getByTestId(`row-booking-${groups[0].attendees[0].id}`)).toBeVisible();
  return { state, groups };
}
async function close(page) {
  await page.getByTestId("cpd-replay-dialog").getByRole("button", { name: "Close", exact: true }).first().click();
}

test("row shortcuts work in individual/simple and grouped/complex layouts; selection survives filters; all-event scope is explicit", async ({ page }) => {
  const { state, groups } = await fixture(page);
  for (const [index, source] of [[0, "standard"], [1, "complex"]]) {
    const id = groups[index].attendees[0].id;
    await page.getByTestId(`reprocess-cpd-${source}-${id}`).click();
    const dialog = page.getByTestId("cpd-replay-dialog");
    await expect(dialog).toContainText("Preview complete");
    expect(state.previews.at(-1).scope).toEqual({ mode: "selected", registrations: [{ booking_id: id, booking_source: source, event_id: EVENTS[index].id }] });
    await expect(dialog.getByTestId("confirm-cpd-reprocessing")).toBeDisabled();
    await close(page);
    await page.getByTestId(`select-cpd-${source}-${id}`).click();
  }
  await page.getByTestId("input-search").fill("Not on this page");
  await expect(page.getByTestId("reprocess-cpd-selected")).toContainText("(2)");
  await page.getByTestId("reprocess-cpd-selected").click();
  await expect(page.getByTestId("cpd-replay-dialog")).toContainText("2 unique registrations");
  expect(state.previews.at(-1).scope.registrations).toHaveLength(2);
  await close(page);
  await expect(page.getByTestId("reprocess-cpd-all-event")).toBeDisabled();
  await page.getByTestId("cpd-all-event-choice").selectOption(`complex:${EVENTS[1].id}`);
  await page.getByTestId("reprocess-cpd-all-event").click();
  const dialog = page.getByTestId("cpd-replay-dialog");
  await expect(dialog).toContainText("regardless of report filters or pagination");
  await expect(dialog).toContainText("2 unique registrations");
  expect(state.previews.at(-1).scope).toEqual({ mode: "all_event", event_id: EVENTS[1].id, event_type: "complex" });
  expect(state.confirmations).toHaveLength(0);
  expect(state.rejected).toEqual([]);
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/task-4817-cpd-preview-fixture.png", fullPage: true, animations: "disabled" });
});

test("explicit confirmation shows pending, durable reopen shows actual awards", async ({ page }) => {
  const { state, groups } = await fixture(page);
  await page.getByTestId(`reprocess-cpd-standard-${groups[0].attendees[0].id}`).click();
  const dialog = page.getByTestId("cpd-replay-dialog");
  await expect(dialog).toContainText("Preview complete");
  await dialog.getByLabel("Reason for reprocessing (required)").fill("Recover missing points");
  await dialog.getByTestId("confirm-cpd-reprocessing").click();
  await expect(dialog).toContainText("have not been awarded yet");
  expect(state.confirmations).toHaveLength(1);
  expect(state.confirmations[0]).toMatchObject({ preview_token: "fixture-reviewed-token", confirmed: true, reason: "Recover missing points" });
  expect(state.confirmations[0].request_id).toMatch(/^[0-9a-f-]{36}$/i);
  await close(page);
  await page.getByTestId("cpd-reopen-results").selectOption(REPLAY);
  await page.getByRole("button", { name: "Open results", exact: true }).click();
  await expect(page.getByTestId("cpd-replay-dialog")).toContainText("Processing finished");
  await expect(page.getByTestId("cpd-replay-dialog")).toContainText("Actual points awarded: 1.5");
  expect(state.rejected).toEqual([]);
  await page.screenshot({ path: "screenshots/task-4817-cpd-results-fixture.png", fullPage: true, animations: "disabled" });
});

test("authorization denial hides toolbar and row actions", async ({ page }) => {
  const { state } = await fixture(page, { denied: true });
  await expect(page.getByTestId("cpd-replay-toolbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reprocess CPD points…" })).toHaveCount(0);
  expect(state.previews).toEqual([]);
  expect(state.confirmations).toEqual([]);
});

test("stale preview requires a new read-only review and fresh reason", async ({ page }) => {
  const { groups, state } = await fixture(page, { stale: true });
  await page.getByTestId(`reprocess-cpd-standard-${groups[0].attendees[0].id}`).click();
  const dialog = page.getByTestId("cpd-replay-dialog");
  await dialog.getByLabel("Reason for reprocessing (required)").fill("Recover missing points");
  await dialog.getByTestId("confirm-cpd-reprocessing").click();
  await expect(dialog).toContainText("no longer current");
  await expect(dialog.getByTestId("confirm-cpd-reprocessing")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Run a new read-only preview" }).click();
  await expect(dialog.getByTestId("confirm-cpd-reprocessing")).toBeDisabled();
  await expect(dialog.getByLabel("Reason for reprocessing (required)")).toHaveValue("");
  expect(state.previews).toHaveLength(2);
});
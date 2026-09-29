import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Only local application assets are loaded. All APIs (including auth) are fixture
// routes, and unexpected writes/external requests are blocked, never forwarded.
const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000").origin;
const MEMBER = {
  id: "fixture-member-cpd-history", email: "attendee@example.invalid",
  first_name: "Real", last_name: "Attendee", tenant_id: "fixture-cpd-tenant",
  role_id: "fixture-cpd-role", member_excluded_features: [],
  sessionRole: {
    status: "ready", member_id: "fixture-member-cpd-history",
    tenant_id: "fixture-cpd-tenant", role_id: "fixture-cpd-role",
    role: { id: "fixture-cpd-role", name: "Member", excluded_features: [] },
  },
};
const ADMIN = {
  ...MEMBER, id: "fixture-cpd-admin", first_name: "Admin", last_name: "Reviewer",
  email: "admin@example.invalid", is_team_member: true,
  role_id: "fixture-cpd-admin-role",
  sessionRole: {
    status: "ready", member_id: "fixture-cpd-admin",
    tenant_id: "fixture-cpd-tenant", role_id: "fixture-cpd-admin-role",
    role: {
      id: "fixture-cpd-admin-role", name: "Administrator",
      excluded_features: ["cpd.member_cpd", "cpd.points-corrections"],
    },
  },
};
const OTHER_MEMBER = {
  ...MEMBER, id: "fixture-other-cpd-member", first_name: "Second",
  last_name: "Attendee", email: "second@example.invalid",
};
const awards = [
  { id: "standard-award", entry_kind: "event_award", points_value: 5,
    event_name: "Regular fixture conference", ticket_name_snapshot: "Member ticket",
    award_trigger: "attendance", evidence_date: "2026-10-15" },
  { id: "complex-award", entry_kind: "event_award", points_value: 3,
    event_name: "Complex fixture conference", ticket_name_snapshot: "Member ticket",
    award_trigger: "registration", evidence_date: "2026-10-14" },
  { id: "reversed-award", entry_kind: "event_award", points_value: 1,
    event_name: "Reversed fixture", is_reversed: true },
  { id: "reversal", entry_kind: "reversal", points_value: -1, event_name: "Reversal fixture" },
  { id: "no-config", entry_kind: "event_award", points_value: 2, event_name: "Unconfigured fixture" },
];
const nextPage = [{ id: "next-page-award", entry_kind: "event_award", points_value: 2,
  event_name: "Later fixture conference", ticket_name_snapshot: "Member ticket" }];
const otherAwards = [
  { id: "other-award", entry_kind: "event_award", points_value: 7,
    event_name: "Second member workshop", ticket_name_snapshot: "Workshop ticket",
    award_trigger: "attendance", evidence_date: "2026-10-16" },
  { id: "other-reversed", entry_kind: "event_award", points_value: 1,
    event_name: "Second member reversed workshop", is_reversed: true },
];

async function pdf(id) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(`Member CPD certificate ${id}`, { x: 48, y: 640, size: 20, font });
  return Buffer.from(await document.save());
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function fixture(page, { failPdfOnce = false, failMetadataOnce = false, admin = false } = {}) {
  const state = {
    metadata: [], pdf: [], rejectedWrites: [], unexpectedExternal: [],
    failPdfOnce, failMetadataRemaining: failMetadataOnce ? 1 : 0,
  };
  const session = admin ? ADMIN : MEMBER;
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.context().routeWebSocket("**/*", socket => socket.onMessage(() => {}));
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.hostname.endsWith(".supabase.co")) {
      return route.fulfill({ status: 200, contentType: "application/json",
        headers: { "content-range": "0-0/0" }, body: "[]" });
    }
    if (url.origin !== ORIGIN) {
      if (["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com",
        "js.stripe.com", "va.vercel-scripts.com", "teeone.pythonanywhere.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      state.unexpectedExternal.push(`${method} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (method === "PATCH" && url.pathname === `/api/entities/Member/${session.id}`) return json(route, session);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.rejectedWrites.push(`${method} ${url.pathname}`);
      return json(route, { error: "Fixture blocked unexpected mutation" }, 599);
    }
    if (admin && url.pathname === "/api/admin/members/paginated") {
      return json(route, { members: [MEMBER, OTHER_MEMBER], pagination: {
        page: 1, limit: 50, total: 2, totalPages: 1,
      } });
    }
    if ([MEMBER.id, OTHER_MEMBER.id].some(id => url.pathname === `/api/members/${id}/cpd-points`)) {
      const memberId = url.pathname.split("/")[3];
      const pageNumber = Number(url.searchParams.get("page") || "1");
      state.history ||= [];
      state.history.push({ memberId, page: pageNumber, method });
      return json(route, memberId === OTHER_MEMBER.id
        ? { balance: 7, total: 2, pageSize: 20, page: pageNumber, items: otherAwards }
        : { balance: 12, total: 21, pageSize: 20, page: pageNumber,
          items: pageNumber === 1 ? awards : nextPage });
    }
    if ([MEMBER.id, OTHER_MEMBER.id].some(id => url.pathname === `/api/members/${id}/cpd-certificate`)) {
      const memberId = url.pathname.split("/")[3];
      const id = url.searchParams.get("ledger_entry_id");
      if (id) {
        state.pdf.push({ memberId, id, format: url.searchParams.get("format"), method });
        if (state.failPdfOnce) {
          state.failPdfOnce = false;
          return json(route, { error: "Certificate source temporarily unavailable" }, 503);
        }
        if (!["standard-award", "complex-award", "next-page-award", "other-award"].includes(id)
          || (memberId === OTHER_MEMBER.id) !== (id === "other-award")) {
          return json(route, { error: "Certificate unavailable" }, 409);
        }
        return route.fulfill({
          status: 200, contentType: "application/pdf",
          headers: { "Cache-Control": "private, no-store", "Content-Disposition": `inline; filename="cpd-certificate-${id}.pdf"` },
          body: await pdf(id),
        });
      }
      const ids = (url.searchParams.get("ledger_entry_ids") || "").split(",").filter(Boolean);
      state.metadata.push({ memberId, ids, method });
      if (state.failMetadataRemaining) {
        state.failMetadataRemaining--;
        return json(route, { error: "Certificate details temporarily unavailable" }, 503);
      }
      return json(route, { certificates: Object.fromEntries(ids.map(id => [id, {
        available: ["standard-award", "complex-award", "next-page-award", "other-award"].includes(id)
          && ((memberId === OTHER_MEMBER.id) === (id === "other-award")),
        reason: id === "no-config" ? "Certificate unavailable: no template configured." : "Certificate unavailable.",
        retryable: false,
        filename: `cpd-certificate-${id}.pdf`,
      }])) });
    }
    if (url.pathname === "/api/auth/me") return json(route, session);
    if (url.pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: false }, 401);
    if (url.pathname.startsWith("/api/entities/Role/")) return json(route, session.sessionRole.role);
    if (url.pathname === "/api/entities/Role") return json(route, [session.sessionRole.role]);
    if (url.pathname === "/api/entities/Member") {
      const filter = url.searchParams.get("filter");
      if (filter) {
        let email;
        try { email = JSON.parse(filter).email; } catch { /* Other list filters use the full fixture list. */ }
        if (email) return json(route, [MEMBER, OTHER_MEMBER, ADMIN].filter(member => member.email === email));
      }
      return json(route, admin ? [MEMBER, OTHER_MEMBER, ADMIN] : [MEMBER]);
    }
    if (url.pathname.startsWith("/api/entities/Member/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      const found = [MEMBER, OTHER_MEMBER, ADMIN].find(member => member.id === id);
      return found ? json(route, found) : json(route, { error: "Fixture member not found" }, 404);
    }
    if (url.pathname === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (url.pathname === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (url.pathname === "/api/public/platform-defaults") return json(route, {});
    if (url.pathname === "/api/public/ai-help-persona") return json(route, { enabled: false });
    if (url.pathname === "/api/public/form-consent-message") return json(route, { message: null });
    if (url.pathname === "/api/tenant-canvas-theme") return json(route, { theme: null });
    if (url.pathname === "/api/public/canvas-symbols") return json(route, { symbols: [] });
    if (url.pathname.startsWith("/api/redirects/resolve")) return json(route, { found: false });
    return json(route, []);
  });
  await page.goto(admin ? `/members/${MEMBER.id}?tab=cpd-points` : "/cpdpoints", { waitUntil: "domcontentloaded" });
  if (admin) {
    await expect(page.getByRole("heading", { name: "Real Attendee" })).toBeVisible();
    await expect(page.getByTestId("tab-member-cpd-points")).toHaveAttribute("data-state", "active");
  } else {
    await expect(page.getByRole("heading", { name: "My CPD points" })).toBeVisible();
  }
  await expect(page.getByText("Regular fixture conference")).toBeVisible();
  const cookieNotice = page.getByRole("dialog", { name: "Cookie consent" });
  if (await cookieNotice.isVisible()) await cookieNotice.getByRole("button", { name: "Decline" }).click();
  return state;
}

test("member sees scoped certificates, real PDF canvas preview and downloadable PDF, including complex booking", async ({ page }) => {
  const state = await fixture(page);
  await expect.poll(() => state.metadata.length).toBeGreaterThan(0);
  expect(state.metadata[0].ids).toContain("standard-award");
  expect(state.metadata[0].ids).toContain("complex-award");
  const regular = page.getByRole("row").filter({ hasText: "Regular fixture conference" });
  const complex = page.getByRole("row").filter({ hasText: "Complex fixture conference" });
  await regular.getByRole("button", { name: "View certificate" }).click();
  const dialog = page.getByRole("dialog", { name: /CPD certificate/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("canvas")).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("1 page rendered");
  await expect.poll(async () => dialog.locator("canvas").evaluate(canvas => {
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    return data.some(value => value !== 0);
  })).toBe(true);
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/task-3838-cpd-history-certificate-desktop.png", fullPage: true });
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(dialog).not.toBeVisible();

  const download = page.waitForEvent("download");
  await complex.getByRole("button", { name: "Download PDF" }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe("cpd-certificate-complex-award.pdf");
  const document = await PDFDocument.load(await readFile(await result.path()));
  expect(document.getPageCount()).toBe(1);
  expect(document.getPage(0).getWidth()).toBe(612);
  expect(state.pdf.map(call => call.id)).toEqual(["standard-award", "complex-award"]);
  expect(state.pdf.every(call => call.method === "GET" && call.format === "pdf")).toBe(true);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("no download for reversed, reversal, or unconfigured awards; pagination requests the current page only", async ({ page }) => {
  const state = await fixture(page);
  await expect.poll(() => state.metadata.length).toBeGreaterThan(0);
  for (const name of ["Reversed fixture", "Reversal fixture", "Unconfigured fixture"]) {
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row.getByRole("button", { name: "Download PDF" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "View certificate" })).toHaveCount(0);
  }
  await expect(page.getByRole("row").filter({ hasText: "Unconfigured fixture" })).toContainText(/unavailable|template/i);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Later fixture conference")).toBeVisible();
  await expect.poll(() => state.metadata.at(-1)?.ids).toEqual(["next-page-award"]);
  await expect(page.getByRole("row").filter({ hasText: "Later fixture conference" })
    .getByRole("button", { name: "Download PDF" })).toBeEnabled();
  expect(state.pdf).toHaveLength(0);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("temporary generation errors and metadata errors are visible and retryable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { failPdfOnce: true, failMetadataOnce: true });
  await expect.poll(() => state.metadata.length).toBeGreaterThan(0);
  await expect(page.getByText("Could not check certificates").first()).toBeVisible();
  await page.getByRole("button", { name: "Retry certificates" }).first().click();
  const regular = page.getByRole("row").filter({ hasText: "Regular fixture conference" });
  await regular.getByRole("button", { name: "View certificate" }).click();
  const dialog = page.getByRole("dialog", { name: /CPD certificate/ });
  await expect(dialog.getByText("Certificate source temporarily unavailable")).toBeVisible();
  await dialog.getByRole("button", { name: "Retry PDF" }).click();
  await expect(dialog.locator("canvas")).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("1 page rendered");
  const size = await dialog.boundingBox();
  expect(size.x).toBeGreaterThanOrEqual(0);
  expect(size.x + size.width).toBeLessThanOrEqual(391);
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/task-3838-cpd-history-certificate-mobile.png", fullPage: true });
  expect(state.pdf.map(call => call.id)).toEqual(["standard-award", "standard-award"]);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("admin views another member's certificates without correction or self-service access, and switches member scope", async ({ page }) => {
  const state = await fixture(page, { admin: true });
  const history = page.getByRole("table", { name: "CPD points history" });
  await expect(page.getByTestId("member-cpd-points-balance")).toHaveText("12");
  await expect.poll(() => state.metadata.at(-1)).toMatchObject({
    memberId: MEMBER.id, ids: expect.arrayContaining(["standard-award", "complex-award"]), method: "GET",
  });
  await expect(history.getByRole("columnheader", { name: "Corrections" })).toHaveCount(0);
  await expect(history.getByRole("columnheader", { name: "Certificate" })).toBeVisible();
  await expect(history.getByRole("button", { name: /Adjust|Reverse/ })).toHaveCount(0);
  await expect(page.getByText("Access denied")).toHaveCount(0);
  const firstRow = history.getByRole("row").filter({ hasText: "Regular fixture conference" });
  await firstRow.getByRole("button", { name: "View certificate" }).click();
  let dialog = page.getByRole("dialog", { name: /CPD certificate/ });
  await expect(dialog.getByRole("status")).toHaveText("1 page rendered");
  await expect.poll(() => dialog.locator("canvas").evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some(value => value !== 0);
  })).toBe(true);
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/task-4844-admin-member-cpd-certificate.png", fullPage: true });
  await dialog.getByRole("button", { name: "Close" }).first().click();

  // Use the actual list/detail navigation, retaining React Query's cache across
  // members so a stale certificate cannot be mistaken for the selected member's.
  await page.getByTestId("link-back-to-members").click();
  await page.getByTestId(`member-row-${OTHER_MEMBER.id}`).click();
  await expect(page.getByRole("heading", { name: "Second Attendee" })).toBeVisible();
  await page.getByTestId("tab-member-cpd-points").click();
  await expect(page.getByTestId("member-cpd-points-balance")).toHaveText("7");
  await expect(history.getByText("Second member workshop")).toBeVisible();
  await expect(history.getByText("Regular fixture conference")).toHaveCount(0);
  await expect.poll(() => state.metadata.at(-1)).toMatchObject({
    memberId: OTHER_MEMBER.id, ids: ["other-award"], method: "GET",
  });
  const otherRow = history.getByRole("row").filter({ hasText: "Second member workshop" });
  await expect(otherRow.getByRole("button", { name: "Download PDF" })).toBeEnabled();
  const reversedRow = history.getByRole("row").filter({ hasText: "Second member reversed workshop" });
  await expect(reversedRow.getByRole("button", { name: "View certificate" })).toHaveCount(0);
  const download = page.waitForEvent("download");
  await otherRow.getByRole("button", { name: "Download PDF" }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe("cpd-certificate-other-award.pdf");
  const document = await PDFDocument.load(await readFile(await result.path()));
  expect(document.getPageCount()).toBe(1);
  expect(state.history.map(call => call.memberId)).toEqual([MEMBER.id, OTHER_MEMBER.id]);
  expect(state.pdf).toEqual([
    { memberId: MEMBER.id, id: "standard-award", format: "pdf", method: "GET" },
    { memberId: OTHER_MEMBER.id, id: "other-award", format: "pdf", method: "GET" },
  ]);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});
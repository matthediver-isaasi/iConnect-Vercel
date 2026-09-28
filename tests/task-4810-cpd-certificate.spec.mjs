import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

// All certificate and report requests are fixture-only. No real booking or
// attendee data is loaded and no provider mail request can leave this browser.
// Optional legacy-browser compatibility mode only for the workspace's
// Chromium 125. Normal verification runs real PDF.js unmodified on Chrome 153.
const useLegacyBrowserShims = process.env.CPD_CERTIFICATE_TEST_LEGACY_BROWSER_SHIMS === "true";
const legacyBrowserPolyfills = `
Promise.try ||= (fn, ...args) => new Promise(resolve => resolve(fn(...args)));
URL.parse ||= (input, base) => { try { return new URL(input, base); } catch { return null; } };
Uint8Array.prototype.toHex ||= function() {
  return Array.from(this, byte => byte.toString(16).padStart(2, "0")).join("");
};
Map.prototype.getOrInsertComputed ||= function(key, compute) {
  if (!this.has(key)) this.set(key, compute(key));
  return this.get(key);
};
Map.prototype.getOrInsert ||= function(key, value) {
  if (!this.has(key)) this.set(key, value);
  return this.get(key);
};
`;
const workerCode = useLegacyBrowserShims
  ? readFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "utf8") : null;
const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000").origin;
const TENANT = { id: "fixture-certificate-tenant", name: "Certificate fixture", slug: "certificate-fixture" };
const ADMIN = {
  id: "fixture-certificate-admin", email: "admin@example.invalid",
  first_name: "Admin", last_name: "Example", tenant_id: TENANT.id,
  organization_id: null, role_id: "fixture-certificate-role",
  member_excluded_features: [], is_team_member: true,
  sessionRole: {
    status: "ready", member_id: "fixture-certificate-admin", tenant_id: TENANT.id,
    role_id: "fixture-certificate-role",
    role: { id: "fixture-certificate-role", name: "Report administrator", excluded_features: [] },
  },
};
const EVENT = {
  id: "fixture-event", title: "Certificate Fixture Workshop",
  start_date: "2026-11-10T09:00:00.000Z", end_date: "2026-11-11T16:00:00.000Z",
  is_complex: false, internal_reference: "CERT-4810",
};
async function fixturePdf(id) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const name = id.startsWith("complex") ? "Complex Fixture" : "Regular Fixture";
  page.drawText(`CPD certificate: ${name}`, { x: 45, y: 660, size: 24, font });
  page.drawText(`${EVENT.title}, 10–11 November 2026`, { x: 45, y: 615, size: 14, font });
  return Buffer.from(await pdf.save());
}

function group(id, source = "booking", overrides = {}) {
  return {
    groupRef: null, isGroup: false, attendeeCount: 1,
    eventTitle: EVENT.title, internalReference: EVENT.internal_reference,
    eventId: source === "complex_event_booking" ? "fixture-complex-event" : EVENT.id,
    isComplexEvent: source === "complex_event_booking", bookingSource: source,
    eventStartDate: EVENT.start_date, eventEndDate: EVENT.end_date,
    hasZoom: false, hasTeams: false, hasAttendance: false, booker: null,
    groupPayment: {
      ticketTotal: 0, totalCost: 0, totalAfterDiscount: 0, discount: 0,
      offerDiscount: 0, codeDiscount: 0, voucherAmount: 0, trainingFundAmount: 0,
      accountAmount: 0, paymentMethod: "free", bookingReference: id,
    },
    attendees: [{
      id, attendee_first_name: source === "complex_event_booking" ? "Complex" : "Regular",
      attendee_last_name: "Fixture", attendee_email: `${id}@example.invalid`,
      ticket_class_name: "Workshop ticket", ticket_price: 0, price_paid: 0,
      payment_method: "free", booking_reference: id, status: "confirmed",
      created_at: "2026-09-01T12:00:00.000Z", third_party_consent: false,
      ...overrides,
    }],
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

function metadata(id, overrides = {}) {
  return {
    available: true, attendee_name: id.startsWith("complex") ? "Complex Fixture" : "Regular Fixture",
    recipient: `${id}@example.invalid`, fingerprint: `fingerprint-${id}`,
    can_send: true, can_preview_email: true, send_reason: null, reason: null, latest_delivery: null,
    email_template_id: "fixture-email-template", email_template_name: "CPD workshop message",
    email_is_default: false, email_reason: null, ...overrides,
  };
}

async function fixture(page, { groups = [group("regular-01"), group("complex-01", "complex_event_booking")], onGet, onPost } = {}) {
  const state = { metadataCalls: [], postCalls: [], rejectedWrites: [], unexpectedExternal: [] };
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  if (useLegacyBrowserShims) await page.addInitScript(legacyBrowserPolyfills);
  // Prevent Vite HMR reloads while parallel implementation edits land; fixture
  // runs load the current app once on navigation and use no live websocket.
  await page.context().routeWebSocket("**/*", socket => socket.onMessage(() => {}));
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (useLegacyBrowserShims && url.pathname.endsWith("/pdf.worker.min.mjs")) {
      return route.fulfill({ contentType: "text/javascript", body: legacyBrowserPolyfills + workerCode });
    }
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
    if (method === "PATCH" && url.pathname === `/api/entities/Member/${ADMIN.id}`) return json(route, ADMIN);

    if (url.pathname === "/api/reports/attendee-cpd-certificate") {
      if (method === "GET") {
        const identity = Object.fromEntries(url.searchParams);
        state.metadataCalls.push(identity);
        return json(route, onGet ? await onGet(identity, state) : metadata(identity.booking_id));
      }
      if (method === "POST") {
        let body;
        try { body = request.postDataJSON(); } catch { return json(route, { error: "Invalid certificate request" }, 400); }
        state.postCalls.push(body);
        if (onPost) {
          const result = await onPost(body, state);
          if (result?.status || result?.body) return json(route, result.body, result.status || 200);
        }
        if (body.action === "preview") {
          return route.fulfill({ status: 200, contentType: "application/pdf",
            headers: { "Cache-Control": "private, no-store", "Content-Disposition": "inline; filename=certificate.pdf" },
            body: await fixturePdf(body.booking_id) });
        }
        if (body.action === "test-send") {
          return json(route, { success: true, test_recipient: body.test_recipient });
        }
        if (body.action === "email-preview") {
          const selected = body.booking_id !== "default-01";
          return json(route, {
            recipient: `${body.booking_id}@example.invalid`,
            subject: selected ? "Your CPD workshop certificate" : "Your default CPD certificate",
            html: selected ? "<p>Selected workshop email body</p>" : "<p>Default certificate email body</p>",
            text: selected ? "Selected workshop email body" : "Default certificate email body",
            attachment: { filename: "cpd-certificate.pdf", content_type: "application/pdf", bytes: 476 },
            survey_links_inactive: true,
          });
        }
        if (body.action !== "send") return json(route, { error: "Unexpected certificate action" }, 400);
        return json(route, { success: true, latest_delivery: { status: "accepted" } });
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.rejectedWrites.push(`${method} ${url.pathname}`);
      return json(route, { error: "Fixture rejected unexpected mutation" }, 599);
    }
    if (url.pathname === "/api/auth/me") return json(route, ADMIN);
    if (url.pathname === "/api/auth/tenant-user-me") return json(route, { authenticated: false }, 401);
    if (url.pathname === "/api/reports/event-registration-report") {
      if (url.searchParams.get("generate") === "true") return json(route, {
        tenantId: TENANT.id, events: [EVENT], bookingGroups: groups, organizations: {}, summary: {},
        hasZoomForSelectedEvents: false, hasTeamsForSelectedEvents: false, hasAttendanceForSelectedEvents: false,
      });
      return json(route, { events: [EVENT] });
    }
    if (url.pathname.startsWith("/api/entities/Role/")) return json(route, ADMIN.sessionRole.role);
    if (url.pathname === "/api/entities/Role") return json(route, [ADMIN.sessionRole.role]);
    if (url.pathname === "/api/entities/Member") return json(route, [ADMIN]);
    if (url.pathname.startsWith("/api/entities/Member/")) return json(route, ADMIN);
    if (url.pathname === "/api/custom-objects") return json(route, { objects: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
    if (url.pathname === "/api/admin/form-submissions/stats") return json(route, {});
    if (url.pathname === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (url.pathname === "/api/public/platform-defaults") return json(route, {});
    if (url.pathname === "/api/public/ai-help-persona") return json(route, { enabled: false });
    if (url.pathname === "/api/public/form-consent-message") return json(route, { message: null });
    if (url.pathname === "/api/tenant-canvas-theme") return json(route, { theme: null });
    if (url.pathname === "/api/public/canvas-symbols") return json(route, { symbols: [] });
    if (url.pathname.startsWith("/api/redirects/resolve")) return json(route, { found: false });
    return json(route, []);
  });
  await page.goto("/EventRegistrationReport", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("text-page-title")).toHaveText("Event Registration Report");
  await page.getByTestId("button-generate-report").click();
  await expect(page.getByTestId(`row-booking-${groups[0].attendees[0].id}`)).toBeVisible();
  return state;
}

async function openCertificate(page, id) {
  await page.getByTestId(`button-cpd-certificate-${id}`).click();
  const dialog = page.getByTestId("attendee-certificate-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Checking certificate settings…")).toHaveCount(0);
  return dialog;
}

async function expectRenderedPreview(dialog) {
  const preview = dialog.getByTestId("certificate-canvas-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("status")).toHaveText("1 page rendered");
  await expect(preview.locator('canvas[aria-label="Certificate page 1 of 1"]')).toBeVisible();
}

test("regular and complex attendees preview PDFs and send only after confirming their own recipient", async ({ page }) => {
  const state = await fixture(page);
  expect(state.metadataCalls).toHaveLength(0);
  expect(state.postCalls).toHaveLength(0);
  for (const [id, source] of [["regular-01", "standard"], ["complex-01", "complex"]]) {
    const dialog = await openCertificate(page, id);
    expect(state.metadataCalls.at(-1)).toMatchObject({ booking_id: id, booking_source: source });
    await expect(dialog).toContainText(`${id}@example.invalid`);
    await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeDisabled();
    await dialog.getByTestId("button-preview-cpd-certificate").click();
    await expectRenderedPreview(dialog);
    expect(state.postCalls.at(-1)).toMatchObject({ action: "preview", booking_id: id, booking_source: source,
      expected_fingerprint: `fingerprint-${id}` });
    await dialog.getByTestId("confirm-cpd-email").click();
    await dialog.getByTestId("button-email-cpd-certificate").click();
    await expect(dialog).toContainText(`accepted for ${id}@example.invalid`);
    await expect(dialog).toContainText("does not confirm inbox delivery");
    const sent = state.postCalls.at(-1);
    expect(sent).toMatchObject({ action: "send", booking_id: id, booking_source: source,
      expected_fingerprint: `fingerprint-${id}`, confirmed: true, deliberate_resend: false });
    expect(sent.request_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sent.recipient).toBeUndefined();
    await dialog.getByRole("button", { name: "Close" }).first().click();
  }
  expect(state.metadataCalls).toHaveLength(2);
  expect(state.postCalls).toHaveLength(4);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("test email has a separate recipient and leaves real attendee send unconfirmed", async ({ page }) => {
  const state = await fixture(page);
  for (const id of ["regular-01", "complex-01"]) {
    const dialog = await openCertificate(page, id);
    const button = dialog.getByTestId("button-test-cpd-email");
    await expect(button).toBeDisabled();
    await dialog.getByLabel("Test email recipient", { exact: true }).fill("reviewer@example.test");
    await button.click();
    await expect(dialog).toContainText("Test email accepted by the provider for reviewer@example.test");
    await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeDisabled();
    await expect(dialog.getByTestId("confirm-cpd-email")).not.toBeChecked();
    await page.screenshot({ path: "/tmp/cpd-test-email-dialog.png" });
    await dialog.getByRole("button", { name: "Close" }).first().click();
  }
  expect(state.postCalls.map(call => call.action)).toEqual(["test-send", "test-send"]);
  expect(state.postCalls.every(call => call.test_recipient === "reviewer@example.test")).toBe(true);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("configured template is visible for both booking sources before confirming email", async ({ page }) => {
  const state = await fixture(page);
  for (const id of ["regular-01", "complex-01"]) {
    const dialog = await openCertificate(page, id);
    await expect(dialog).toContainText("CPD workshop message");
    await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeDisabled();
    if (id === "regular-01") {
      mkdirSync("screenshots", { recursive: true });
      await page.screenshot({ path: "screenshots/task-4813-cpd-email-dialog.png", fullPage: true });
    }
    await dialog.getByTestId("confirm-cpd-email").click();
    await dialog.getByTestId("button-email-cpd-certificate").click();
    await expect(dialog).toContainText("does not confirm inbox delivery");
    await dialog.getByRole("button", { name: "Close" }).first().click();
  }
  expect(state.postCalls).toHaveLength(2);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("distinct PDF and email previews display selected and default subject, recipient and sandboxed body without a send", async ({ page }) => {
  const state = await fixture(page, {
    groups: [group("regular-01"), group("default-01")],
    onGet: identity => identity.booking_id === "default-01"
      ? metadata(identity.booking_id, { email_template_id: null, email_template_name: null, email_is_default: true })
      : metadata(identity.booking_id),
  });
  for (const [id, subject, body] of [
    ["regular-01", "Your CPD workshop certificate", "Selected workshop email body"],
    ["default-01", "Your default CPD certificate", "Default certificate email body"],
  ]) {
    const dialog = await openCertificate(page, id);
    await expect(dialog.getByTestId("cpd-certificate-section")).toBeVisible();
    await expect(dialog.getByTestId("cpd-email-section")).toBeVisible();
    await expect(dialog.getByTestId("button-preview-cpd-certificate")).toBeVisible();
    await expect(dialog.getByTestId("button-preview-cpd-email")).toBeEnabled();
    await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeDisabled();
    await dialog.getByTestId("button-preview-cpd-email").click();
    const email = dialog.getByTestId("cpd-email-preview");
    await expect(email).toContainText(subject);
    await expect(email).toContainText(`${id}@example.invalid`);
    await expect(email.locator("iframe")).toHaveAttribute("sandbox", "");
    await expect(email.locator("iframe")).toHaveAttribute("srcdoc", `<p>${body}</p>`);
    await expect(email.locator("iframe").contentFrame().getByText(body)).toBeVisible();
    await expect(email).toContainText("cpd-certificate.pdf");
    if (id === "regular-01") {
      mkdirSync("screenshots", { recursive: true });
      await page.screenshot({ path: "screenshots/task-4810-cpd-email-and-pdf-preview.png", fullPage: true });
    }
    await dialog.getByTestId("button-preview-cpd-certificate").click();
    await expectRenderedPreview(dialog);
    await dialog.getByRole("button", { name: "Close" }).first().click();
  }
  expect(state.postCalls.map(call => call.action)).toEqual(["email-preview", "preview", "email-preview", "preview"]);
  expect(state.postCalls.every(call => call.confirmed === undefined && call.request_id === undefined)).toBe(true);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("default email is identified, and missing template blocks send without blocking PDF preview", async ({ page }) => {
  const state = await fixture(page, {
    groups: [group("default-01"), group("missing-template-01")],
    onGet: identity => identity.booking_id === "default-01"
      ? metadata(identity.booking_id, { email_template_id: null, email_template_name: null, email_is_default: true })
      : metadata(identity.booking_id, {
        email_template_id: "deleted-template", email_template_name: "Deleted template",
        email_is_default: false, email_reason: "email_template_unavailable",
        can_preview_email: false, can_send: false, send_reason: "email_template_unavailable",
      }),
  });
  let dialog = await openCertificate(page, "default-01");
  await expect(dialog).toContainText(/default/i);
  await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).first().click();

  dialog = await openCertificate(page, "missing-template-01");
  await expect(dialog).toContainText(/template/i);
  await expect(dialog.getByTestId("button-email-cpd-certificate")).toHaveCount(0);
  await expect(dialog.getByTestId("button-preview-cpd-email")).toBeDisabled();
  await expect(dialog).toContainText("Email preview unavailable:");
  await dialog.getByTestId("button-preview-cpd-certificate").click();
  await expectRenderedPreview(dialog);
  expect(state.postCalls.map(call => call.action)).toEqual(["preview"]);
  expect(state.rejectedWrites).toEqual([]);
});

test("a template change invalidates the old send confirmation and never triggers a second email", async ({ page }) => {
  const state = await fixture(page, {
    onPost: body => body.action === "send"
      ? { status: 409, body: { error: "Email template changed. Close and reopen to confirm the current message." } }
      : null,
  });
  const dialog = await openCertificate(page, "regular-01");
  await dialog.getByTestId("confirm-cpd-email").click();
  await dialog.getByTestId("button-email-cpd-certificate").click();
  await expect(dialog.getByRole("alert")).toContainText("Email template changed");
  expect(state.postCalls.map(call => call.action)).toEqual(["send"]);
  expect(state.rejectedWrites).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("unavailable certificate explains why; missing email still allows preview but not send", async ({ page }) => {
  const state = await fixture(page, {
    groups: [group("suppressed-01"), group("missing-email-01", "booking", { attendee_email: "" })],
    onGet: identity => identity.booking_id === "suppressed-01"
      ? metadata(identity.booking_id, { available: false, reason: "no_template", can_preview_email: false, can_send: false })
      : metadata(identity.booking_id, { recipient: null, can_preview_email: false, can_send: false, send_reason: "missing_recipient" }),
  });
  let dialog = await openCertificate(page, "suppressed-01");
  await expect(dialog).toContainText("No certificate template is configured");
  await expect(dialog.getByTestId("button-preview-cpd-certificate")).toHaveCount(0);
  await expect(dialog.getByTestId("button-email-cpd-certificate")).toHaveCount(0);
  await expect(dialog.getByTestId("button-preview-cpd-email")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).first().click();

  dialog = await openCertificate(page, "missing-email-01");
  await expect(dialog).toContainText("no valid email address");
  await expect(dialog.getByTestId("button-email-cpd-certificate")).toHaveCount(0);
  await expect(dialog.getByTestId("button-preview-cpd-email")).toBeDisabled();
  await dialog.getByTestId("button-preview-cpd-certificate").click();
  await expectRenderedPreview(dialog);
  expect(state.postCalls.map(call => call.action)).toEqual(["preview"]);
  expect(state.rejectedWrites).toEqual([]);
});

test("send errors are shown and retry retains request ID; deliberate resend has new ID", async ({ page }) => {
  let attempts = 0;
  const state = await fixture(page, {
    onPost: body => {
      if (body.action !== "send") return null;
      attempts += 1;
      return attempts === 1
        ? { status: 503, body: { error: "Email provider outcome unknown; retry the same request safely." } }
        : { body: { success: true, latest_delivery: { status: "accepted" } } };
    },
  });
  const dialog = await openCertificate(page, "regular-01");
  await dialog.getByTestId("confirm-cpd-email").click();
  await dialog.getByTestId("button-email-cpd-certificate").click();
  await expect(dialog.getByRole("alert")).toContainText("outcome unknown");
  await dialog.getByTestId("button-email-cpd-certificate").click();
  await expect(dialog).toContainText("does not confirm inbox delivery");
  expect(state.postCalls[0].request_id).toBe(state.postCalls[1].request_id);
  await dialog.getByTestId("button-prepare-cpd-resend").click();
  await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeDisabled();
  await dialog.getByTestId("confirm-cpd-email").click();
  await dialog.getByTestId("button-email-cpd-certificate").click();
  await expect(dialog).toContainText("does not confirm inbox delivery");
  expect(state.postCalls[2].request_id).not.toBe(state.postCalls[1].request_id);
  expect(state.postCalls[2].deliberate_resend).toBe(true);
  expect(state.rejectedWrites).toEqual([]);
});

test("double click sends once, stale metadata blocks with a visible error", async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const state = await fixture(page, {
    onPost: async body => {
      if (body.action !== "send") return null;
      await pending;
      return { status: 409, body: { error: "Certificate settings changed. Close and reopen to confirm new recipient." } };
    },
  });
  const dialog = await openCertificate(page, "regular-01");
  await dialog.getByTestId("confirm-cpd-email").click();
  await dialog.getByTestId("button-email-cpd-certificate").dblclick();
  await expect.poll(() => state.postCalls.length).toBe(1);
  await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert")).toContainText("settings changed");
  await expect(dialog.getByTestId("button-email-cpd-certificate")).toBeEnabled();
  expect(state.postCalls).toHaveLength(1);
  expect(state.rejectedWrites).toEqual([]);
});

test("save evidence of the fixture-only attendee confirmation dialog", async ({ page }) => {
  const state = await fixture(page);
  const dialog = await openCertificate(page, "regular-01");
  await dialog.getByTestId("confirm-cpd-email").click();
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/task-4810-cpd-certificate-fixture.png", fullPage: true });
  await dialog.getByTestId("button-preview-cpd-certificate").click();
  await expectRenderedPreview(dialog);
  await page.screenshot({ path: "screenshots/task-4810-cpd-certificate-fixture.png", fullPage: true });
  expect(state.postCalls.map(call => call.action)).toEqual(["preview"]);
  expect(state.rejectedWrites).toEqual([]);
});
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import surveyAssignmentHandler from "../api/public/survey-assignment/[token].js";
import { certificateSurveyTokenHash } from "../api/_lib/certificateSurveyGrants.js";

// An isolated, mounted editor suite: all entity writes and fetches stay in
// browser memory. No live tenant or email provider is contacted.
function resolveSource(base) {
  for (const candidate of [
    base, `${base}.jsx`, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`,
    path.join(base, "index.jsx"), path.join(base, "index.js"), path.join(base, "index.ts"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return base;
}
const stubs = {
  "@/api/base44Client": `export const base44 = window.__cpdEmailEditor.base44;`,
  "@/hooks/useEventTypes": `export const useEventTypes = () => ({ eventTypes: [] });`,
  "@/hooks/useAgendaItemTypes": `export const useAgendaItemTypes = () => ({ agendaItemTypes: [] }); export const inferAgendaTypeBehaviour = () => ({});`,
  "@/hooks/useSpeakerModuleName": `export const useSpeakerModuleName = () => ({ singular: "Speaker", plural: "Speakers" });`,
  "@/hooks/useMemberGroupSettings": `export const useMemberGroupSettings = () => ({ ticketTypeName: "Standard Ticket", featureName: "Groups" });`,
  "@/hooks/useServerAdminAuth": `export const useServerAdminAuth = () => ({ isAdmin: true });`,
};
let editorScript;
let dialogScript;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { BrowserRouter } from "react-router-dom";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import CreateEvent from "./client/src/pages/CreateEvent.jsx";
        import EditEvent from "./client/src/pages/EditEvent.jsx";
        import CreateComplexEvent from "./client/src/pages/CreateComplexEvent.jsx";
        function Harness() {
          const [version, setVersion] = useState(0);
          const [client, setClient] = useState(() => new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{gcTime:0}}}));
          const remount = () => {
            client.clear();
            setClient(new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{gcTime:0}}}));
            setVersion(value => value + 1);
          };
          const surface = window.__cpdEmailEditor.surface;
          return <QueryClientProvider client={client}><BrowserRouter>
            <button type="button" data-testid="fixture-remount-editor" onClick={remount}>Reload editor fixture</button>
            <div key={version}>{surface === "create-simple" ? <CreateEvent /> :
              surface === "edit-simple" ? <EditEvent /> : <CreateComplexEvent />}</div>
          </BrowserRouter></QueryClientProvider>;
        }
        createRoot(document.getElementById("root")).render(<Harness />);
      `,
      resolveDir: process.cwd(), loader: "jsx",
    },
    bundle: true, write: false, outfile: "task-4813-cpd-email-editors.js",
    jsx: "automatic",
    plugins: [{
      name: "cpd-email-editor-fixture",
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          if (stubs[args.path]) return { path: args.path, namespace: "cpd-email-stub" };
          return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
        });
        api.onResolve({ filter: /^@shared\// }, args => ({
          path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
        }));
        api.onLoad({ filter: /.*/, namespace: "cpd-email-stub" }, args => ({
          contents: stubs[args.path], loader: "jsx", resolveDir: process.cwd(),
        }));
        api.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
      },
    }],
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
  });
  editorScript = result.outputFiles.find(file => file.path.endsWith(".js"))?.text || result.outputFiles[0].text;
  const dialog = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import AttendeeCpdCertificateDialog from "./client/src/components/events/AttendeeCpdCertificateDialog.jsx";
        createRoot(document.getElementById("root")).render(
          <AttendeeCpdCertificateDialog attendee={{ id: "booking-fixture", attendee_first_name: "Booked", attendee_last_name: "Guest" }}
            bookingSource="standard" onClose={() => {}} />
        );
      `,
      resolveDir: process.cwd(), loader: "jsx",
    },
    bundle: true, write: false, outfile: "certificate-dialog-fixture.js",
    jsx: "automatic",
    plugins: [{
      name: "isolated-certificate-dialog",
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => ({
          path: resolveSource(path.resolve("client/src", args.path.slice(2))),
        }));
        api.onResolve({ filter: /^@shared\// }, args => ({
          path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
        }));
        api.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
      },
    }],
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
  });
  dialogScript = dialog.outputFiles.find(file => file.path.endsWith(".js"))?.text || dialog.outputFiles[0].text;
});

const emptyConfig = () => ({
  eventRule: { template_id: null, email_template_id: null, date_mode: "event", start_date: null, end_date: null },
  ticketRules: {},
});
const simpleEvent = {
  id: "simple-cpd-email", title: "Simple CPD email workshop", summary: "Fixture",
  description: "Fixture", status: "tbc", event_state: "active",
  start_date: null, end_date: null, timezone: "Europe/London",
  is_unlimited_registration: true,
  pricing_config: { ticket_classes: [{
    id: "simple-ticket", name: "Standard Ticket", price: 25, is_free: false,
    visibility_mode: "members_only", role_ids: [], member_group_ids: [],
    offer_type: "none", is_unlimited_tickets: true, is_default: true,
  }] },
};
const complexEvent = {
  id: "complex-cpd-email", title: "Complex CPD email workshop",
  slug: "complex-cpd-email-fixture", summary: "Fixture", description: "Fixture",
  status: "tbc", event_state: "active", start_date: null, end_date: null,
  timezone: "Europe/London", is_unlimited_registration: true, pricing_config: {},
};
async function mountEditor(page, surface, { config = emptyConfig(), emailTemplates = [
  { id: "email-active", name: "Custom CPD email", is_active: true, unavailable: false },
  { id: "email-disabled", name: "Old CPD email", is_active: false, unavailable: true },
] } = {}) {
  let documentLoaded = false;
  await page.route("**/*", async route => {
    if (route.request().resourceType() === "document") {
      if (documentLoaded) return route.abort("aborted");
      documentLoaded = true;
      return route.fulfill({ status: 200, contentType: "text/html", body: '<html><body><div id="root"></div></body></html>' });
    }
    return route.abort("blockedbyclient");
  });
  await page.goto(`http://cpd-email-editors.test/${surface}`);
  await page.evaluate(({ surface, simple, complex, config, emailTemplates }) => {
    const state = {
      surface, simple, complex, config, emailTemplates, calls: [], writes: [],
      base44: null,
    };
    const clone = value => structuredClone(value);
    const empty = async () => [];
    state.base44 = {
      entities: new Proxy({}, {
        get(_target, name) {
          if (name === "Event") return {
            get: async () => clone(state.simple), list: empty,
            create: async body => {
              state.simple = { ...state.simple, ...clone(body), id: "created-simple-cpd-email" };
              state.writes.push({ kind: "simple-create", body: clone(body) });
              return clone(state.simple);
            },
            update: async (_id, body) => {
              state.simple = { ...state.simple, ...clone(body) };
              state.writes.push({ kind: "simple-update", body: clone(body) });
              return clone(state.simple);
            },
          };
          if (name === "ComplexEvent") return {
            get: async () => clone(state.complex), list: async () => [clone(state.complex)],
            create: async body => {
              state.complex = { ...state.complex, ...clone(body), id: "created-complex-cpd-email" };
              state.writes.push({ kind: "complex-create", body: clone(body) });
              return clone(state.complex);
            },
            update: async (_id, body) => {
              state.complex = { ...state.complex, ...clone(body) };
              state.writes.push({ kind: "complex-update", body: clone(body) });
              return clone(state.complex);
            },
          };
          return {
            list: empty, filter: empty, get: async () => null,
            create: async body => ({ id: `${String(name).toLowerCase()}-fixture`, ...clone(body) }),
            update: async (_id, body) => clone(body), delete: async () => ({}),
          };
        },
      }),
      functions: { invoke: async () => ({ data: { success: true } }) },
      integrations: { Core: { UploadFile: async () => ({ file_url: "" }) } },
    };
    window.__cpdEmailEditor = state;
    window.fetch = async (url, options = {}) => {
      const requestUrl = String(url);
      const method = (options.method || "GET").toUpperCase();
      state.calls.push({ url: requestUrl, method });
      let body = [];
      if (requestUrl.startsWith("/api/admin/event-cpd-certificate-rules")) {
        if (method === "PUT") {
          const payload = JSON.parse(options.body);
          state.config = clone(payload.config);
          state.writes.push({ kind: "certificate", eventId: payload.event_id, eventType: payload.event_type, config: clone(state.config) });
        }
        body = {
          config: clone(state.config),
          templates: [],
          emailTemplates: clone(state.emailTemplates),
        };
      } else if (requestUrl.includes("check-event-slug")) body = { available: true };
      else if (requestUrl.includes("clash")) body = { hasClashes: false, clashes: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    history.replaceState({}, "", {
      "create-simple": "/CreateEvent",
      "edit-simple": "/EditEvent?id=simple-cpd-email",
      "complex-create": "/CreateComplexEvent",
      "complex-edit": "/CreateComplexEvent?id=complex-cpd-email",
    }[surface]);
  }, { surface, simple: simpleEvent, complex: complexEvent, config, emailTemplates });
  await page.addScriptTag({ content: editorScript });
  const tab = page.getByTestId(surface.startsWith("complex") ? "button-section-cpd" : "button-tab-cpd");
  await tab.click();
  await expect(page.getByTestId("select-cpd-email-template")).toBeVisible();
}

async function chooseEmail(page, name) {
  const select = page.getByTestId("select-cpd-email-template");
  await select.click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(select).toContainText(name);
}
async function savedCertificate(page, count) {
  await expect.poll(() => page.evaluate(() =>
    window.__cpdEmailEditor.writes.filter(write => write.kind === "certificate").length
  )).toBe(count);
  return page.evaluate(() => window.__cpdEmailEditor.writes.filter(write => write.kind === "certificate").at(-1));
}

for (const surface of ["edit-simple", "complex-edit"]) {
  test(`${surface} preserves, updates and clears the event-wide email independently of the PDF`, async ({ page }) => {
    await mountEditor(page, surface, {
      config: { ...emptyConfig(), eventRule: { ...emptyConfig().eventRule, email_template_id: "email-active" } },
    });
    const select = page.getByTestId("select-cpd-email-template");
    const save = page.getByTestId(surface === "edit-simple" ? "button-save-event" : "button-save");
    await expect(select).toContainText("Custom CPD email");
    await save.click();
    let persisted = await savedCertificate(page, 1);
    expect(persisted.config.eventRule.email_template_id).toBe("email-active");
    expect(persisted.config.eventRule.template_id).toBeNull();
    expect(persisted.eventType).toBe(surface === "edit-simple" ? "simple" : "complex");
    await page.getByTestId("fixture-remount-editor").click();
    await expect(select).toContainText("Custom CPD email");
    await chooseEmail(page, "Default certificate email (existing message)");
    await save.click();
    persisted = await savedCertificate(page, 2);
    expect(persisted.config.eventRule.email_template_id).toBeNull();
    await page.getByTestId("fixture-remount-editor").click();
    await expect(select).toContainText("Default certificate email (existing message)");
  });
}

for (const surface of ["create-simple", "complex-create"]) {
  test(`${surface} persists selected email after event creation`, async ({ page }) => {
    await mountEditor(page, surface);
    await chooseEmail(page, "Custom CPD email");
    if (surface === "complex-create") await page.getByTestId("button-section-details").click();
    await page.getByTestId("input-title").fill("Created CPD email fixture");
    if (surface === "create-simple") {
      await page.getByTestId("radio-timing-tbc").click();
      await page.getByRole("tabpanel", { name: "Details" }).getByText("Standard Ticket", { exact: true }).click();
      await page.locator('[data-testid^="input-ticket-price-"]').fill("25");
    }
    await page.getByRole("button", { name: "Create Event", exact: true }).click();
    const persisted = await savedCertificate(page, 1);
    expect(persisted.config.eventRule.email_template_id).toBe("email-active");
    expect(persisted.config.eventRule.template_id).toBeNull();
    expect(persisted.eventId).toBe(surface === "create-simple" ? "created-simple-cpd-email" : "created-complex-cpd-email");
    await page.evaluate(surface => {
      const simple = surface === "create-simple";
      window.__cpdEmailEditor.surface = simple ? "edit-simple" : "complex-edit";
      history.replaceState({}, "", simple
        ? "/EditEvent?id=created-simple-cpd-email"
        : "/CreateComplexEvent?id=created-complex-cpd-email");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, surface);
    await page.getByTestId("fixture-remount-editor").click();
    await expect(page.getByTestId("select-cpd-email-template")).toContainText("Custom CPD email");
  });
}

test("an unavailable email remains visible for correction while PDF selection remains independent", async ({ page }) => {
  await mountEditor(page, "edit-simple", {
    config: { ...emptyConfig(), eventRule: { ...emptyConfig().eventRule, email_template_id: "email-disabled" } },
  });
  const email = page.getByTestId("event-cpd-email-template");
  await expect(email).toContainText("Old CPD email");
  await expect(email.getByRole("alert")).toContainText(/unavailable or inactive/i);
  await chooseEmail(page, "Default certificate email (existing message)");
  await expect(email.getByRole("alert")).toHaveCount(0);
});

test("isolated certificate email preview displays inert survey text without sending", async ({ page }) => {
  await page.route("**/*", route => route.request().resourceType() === "document"
    ? route.fulfill({ status: 200, contentType: "text/html", body: '<html><body><div id="root"></div></body></html>' })
    : route.abort("blockedbyclient"));
  await page.goto("http://cpd-email-editors.test/certificate-dialog-fixture");
  await page.evaluate(() => {
    window.__certificateRequests = [];
    window.fetch = async (_url, options = {}) => {
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : null;
      window.__certificateRequests.push({ method, body });
      if (method === "GET") return new Response(JSON.stringify({
        available: true, can_send: true, fingerprint: "preview-fingerprint",
        attendee_name: "Booked Guest", recipient: "booking@example.test",
        email_is_default: false, email_template_name: "Event-wide CPD email",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (body.action !== "email-preview") throw new Error("Fixture forbids sends");
      return new Response(JSON.stringify({
        subject: "Your CPD certificate",
        html: "<p>Surveys for this event: Survey link available in the sent email</p>",
        text: "Surveys for this event: Survey link available in the sent email",
        attachment: { filename: "cpd-certificate.pdf", bytes: 1024 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  });
  await page.addScriptTag({ content: dialogScript });
  const dialog = page.getByTestId("attendee-certificate-dialog");
  await expect(dialog.getByTestId("cpd-email-template-name")).toContainText("Event-wide CPD email");
  await dialog.getByTestId("button-preview-cpd-email").click();
  await expect(dialog.getByTestId("cpd-email-preview")).toContainText("Your CPD certificate");
  await expect(dialog.frameLocator('iframe[title="Certificate email HTML preview"]')
    .getByText("Surveys for this event: Survey link available in the sent email")).toBeVisible();
  expect(await page.evaluate(() => window.__certificateRequests)).toEqual([
    { method: "GET", body: null },
    { method: "POST", body: { booking_id: "booking-fixture", booking_source: "standard",
      action: "email-preview", expected_fingerprint: "preview-fingerprint" } },
  ]);
});

test("isolated guest browser keeps fragment grant through transient failure and reaches the real assignment handler", async ({ page }) => {
  const grant = "g".repeat(43);
  const tenant = { id: "fixture-tenant" };
  const assignment = { id: "assignment-1", tenant_id: tenant.id, form_id: "form-1",
    token: "shared", status: "active", event_type: "event", event_id: "event-1",
    access_mode: "authenticated", event_title: "Fixture workshop" };
  const entitlement = { id: "entitlement-1", tenant_id: tenant.id, assignment_id: assignment.id,
    booking_source: "standard", booking_id: "booking-1", recipient_email: "booking@example.test",
    expires_at: "2099-01-01T00:00:00Z" };
  const rows = {
    event_survey_assignment: assignment,
    certificate_survey_credential: { entitlement_id: entitlement.id, delivery_id: "delivery-1",
      token_hash: certificateSurveyTokenHash(grant), expires_at: entitlement.expires_at },
    certificate_survey_entitlement: entitlement,
    attendee_cpd_certificate_delivery: { id: "delivery-1", tenant_id: tenant.id,
      booking_source: "standard", booking_id: "booking-1", status: "accepted" },
    booking: { id: "booking-1", tenant_id: tenant.id, event_id: "event-1", status: "confirmed",
      attendee_email: entitlement.recipient_email, attendee_first_name: "Booked", attendee_last_name: "Guest" },
    form: { id: "form-1", tenant_id: tenant.id, is_active: true, form_type: "survey",
      survey_settings: { status: "published", current_version: 1 } },
    survey_version: { form_id: "form-1", tenant_id: tenant.id, version_number: 1,
      fields: [{ id: "rating", type: "score", label: "Rating" }], pages: [], visibility_rules: [],
      survey_settings: { response_identity: "anonymous" } },
    event: { id: "event-1", tenant_id: tenant.id, title: "Fixture workshop" },
  };
  const db = { from(table) {
    const filters = [];
    const query = {
      select() { return query; }, eq(field, value) { filters.push([field, value]); return query; },
      async maybeSingle() {
        const row = rows[table];
        return { data: row && filters.every(([field, value]) => row[field] === value)
          ? structuredClone(row) : null, error: null };
      },
    };
    return query;
  } };
  const head = fs.readFileSync("client/index.html", "utf8").match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(head).toBeTruthy();
  let offline = true;
  const requests = [];
  await page.route("**/*", async route => {
    const req = route.request();
    if (req.resourceType() === "document") return route.fulfill({
      status: 200, contentType: "text/html",
      body: `<html><head><script>${head}</script></head><body>Guest invitation fixture</body></html>`,
    });
    if (new URL(req.url()).pathname !== "/api/public/survey-assignment/shared") return route.abort("blockedbyclient");
    requests.push({ url: req.url(), grant: req.headers()["x-certificate-survey-grant"] });
    if (offline) return route.abort("failed");
    const output = { code: 200, headers: {}, body: {} };
    const res = { setHeader(key, value) { output.headers[key] = value; },
      status(code) { output.code = code; return res; },
      json(body) { output.body = body; return res; } };
    await surveyAssignmentHandler({
      method: "GET", query: { token: "shared" },
      headers: { "x-certificate-survey-grant": req.headers()["x-certificate-survey-grant"] },
    }, res, { supabase: db, resolveTenant: async () => tenant,
      getSessionMember: async () => null, getSession: async () => null });
    return route.fulfill({ status: output.code, contentType: "application/json",
      headers: output.headers, body: JSON.stringify(output.body) });
  });
  await page.goto(`http://cpd-email-editors.test/survey/shared#certificate_grant=${grant}`);
  const requestAssignment = () => page.evaluate(async () => {
    const capability = sessionStorage.getItem(`certificate-survey:${location.pathname}`);
    try {
      const response = await fetch("/api/public/survey-assignment/shared", {
        headers: { "X-Certificate-Survey-Grant": capability },
      });
      return { status: response.status, data: await response.json(), capability,
        location: location.href };
    } catch {
      return { error: "network", capability, location: location.href };
    }
  });
  const failed = await requestAssignment();
  expect(failed.error).toBe("network");
  expect(failed.capability).toBe(grant);
  expect(failed.location).not.toContain(grant);
  await page.reload();
  offline = false;
  const active = await requestAssignment();
  expect(active.status).toBe(200);
  expect(active.data.invitation_prefill.email).toBe("booking@example.test");
  expect(active.data.form.fields[0].id).toBe("rating");
  expect(active.capability).toBe(grant);
  expect(requests.every(request => request.grant === grant && !request.url.includes(grant))).toBe(true);
  entitlement.completed_at = "2026-01-01T00:00:00Z";
  const completed = await requestAssignment();
  expect(completed.data.invitation_completed).toBe(true);
  expect(completed.data.invitation_prefill).toBeUndefined();
});
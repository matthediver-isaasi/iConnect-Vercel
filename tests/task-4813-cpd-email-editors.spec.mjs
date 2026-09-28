import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";

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
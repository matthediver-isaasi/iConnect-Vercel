import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";

/*
 * Mounted actual-editor fixtures for task 4575. The real EditEvent and
 * CreateComplexEvent components are bundled below, while every entity/fetch
 * dependency is supplied in memory. No running tenant or database is used.
 */
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
  "@/api/base44Client": `export const base44 = window.__task4575Editor.base44;`,
  "@/hooks/useEventTypes": `export const useEventTypes = () => ({ eventTypes: [] });`,
  "@/hooks/useInternalEventTypes": `export const useInternalEventTypes = () => ({ internalEventTypes: [] });`,
  "@/hooks/useAgendaItemTypes": `
    export const useAgendaItemTypes = () => ({ agendaItemTypes: [] });
    export const inferAgendaTypeBehaviour = () => ({});
  `,
  "@/hooks/useSpeakerModuleName": `export const useSpeakerModuleName = () => ({ singular: "Speaker", plural: "Speakers" });`,
  "@/hooks/useMemberGroupSettings": `export const useMemberGroupSettings = () => ({ ticketTypeName: "Standard Ticket", featureName: "Groups" });`,
  "@/hooks/useServerAdminAuth": `export const useServerAdminAuth = () => ({ isAdmin: true });`,
};

function fixturePlugin() {
  return {
    name: "task4575-editor-fixture",
    setup(api) {
      api.onResolve({ filter: /^@\// }, args => {
        if (stubs[args.path]) return { path: args.path, namespace: "task4575-editor-stub" };
        return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
      });
      api.onResolve({ filter: /^@shared\// }, args => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      api.onLoad({ filter: /.*/, namespace: "task4575-editor-stub" }, args => ({
        contents: stubs[args.path], loader: "jsx", resolveDir: process.cwd(),
      }));
      api.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
    },
  };
}

let editorScript;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { BrowserRouter } from "react-router-dom";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import EditEvent from "./client/src/pages/EditEvent.jsx";
        import CreateComplexEvent from "./client/src/pages/CreateComplexEvent.jsx";
        function Harness() {
          const [version, setVersion] = useState(0);
          const [client, setClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
          const remount = () => {
            client.clear();
            setClient(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
            setVersion(v => v + 1);
          };
          return <QueryClientProvider client={client}>
            <BrowserRouter>
              <button data-testid="fixture-remount-editor" onClick={remount}>Reload editor fixture</button>
              <div key={version}>
                {window.__task4575Editor.mode === "simple" ? <EditEvent /> : <CreateComplexEvent />}
              </div>
            </BrowserRouter>
          </QueryClientProvider>;
        }
        createRoot(document.getElementById("root")).render(<Harness />);
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    outfile: "task4575-editor-fixture.js",
    jsx: "automatic",
    plugins: [fixturePlugin()],
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
  });
  editorScript = result.outputFiles.find(file => file.path.endsWith(".js"))?.text || result.outputFiles[0].text;
});

const simpleEvent = {
  id: "simple-task4575", title: "Simple public PO fixture", summary: "Fixture",
  description: "Fixture", status: "published", event_state: "active",
  start_date: "2027-06-10T09:00:00.000Z", end_date: "2027-06-10T10:00:00.000Z",
  timezone: "Europe/London", allow_public_invoice_po: false, is_unlimited_registration: true,
  pricing_config: { ticket_classes: [{
    id: "simple-ticket-task4575", name: "Public ticket", price: 125, is_free: false,
    visibility_mode: "members_and_public", role_ids: [], member_group_ids: [],
    offer_type: "none", is_unlimited_tickets: true, is_default: true,
  }] },
};

const complexEvent = {
  id: "complex-task4575", title: "Complex public PO fixture", slug: "complex-public-po-fixture",
  summary: "Fixture", description: "Fixture", status: "published", event_state: "active",
  start_date: "2027-07-10T09:00:00.000Z", end_date: "2027-07-10T17:00:00.000Z",
  timezone: "Europe/London", allow_public_invoice_po: false, is_unlimited_registration: true,
  pricing_config: {},
};

async function mountEditor(page, mode) {
  await page.route("**/__task4575-editor-fixture", route => route.fulfill({
    status: 200, contentType: "text/html", body: '<html><body><div id="root"></div></body></html>',
  }));
  await page.goto("/__task4575-editor-fixture");
  await page.evaluate(({ mode, simple, complex }) => {
    const state = {
      mode, simple: structuredClone(simple), complex: structuredClone(complex), writes: [],
    };
    const empty = async () => [];
    const entities = new Proxy({}, {
      get(_target, name) {
        if (name === "Event") return {
          get: async () => structuredClone(state.simple),
          update: async (_id, body) => {
            state.writes.push({ kind: "simple", body: structuredClone(body) });
            state.simple = { ...state.simple, ...body };
            return structuredClone(state.simple);
          },
          list: empty,
        };
        if (name === "ComplexEvent") return {
          get: async () => structuredClone(state.complex),
          update: async (_id, body) => {
            state.writes.push({ kind: "complex", body: structuredClone(body) });
            state.complex = { ...state.complex, ...body };
            return structuredClone(state.complex);
          },
          list: async () => [structuredClone(state.complex)],
        };
        if (name === "ComplexEventTicketClass") return {
          list: async () => [{
            id: "complex-ticket-task4575", complex_event_id: state.complex.id, name: "Public pass",
            price: 250, is_free: false, visibility_mode: "members_and_public", role_ids: [],
            linked_track_ids: [], all_tracks: true, is_unlimited_tickets: true, display_order: 0,
          }],
          create: async body => ({ id: "complex-ticket-task4575", ...body }),
          update: async (_id, body) => ({ id: "complex-ticket-task4575", ...body }),
          delete: async () => ({}),
        };
        return { list: empty, filter: empty, get: async () => null, create: async body => body, update: async (_id, body) => body, delete: async () => ({}) };
      },
    });
    state.base44 = { entities, functions: { invoke: async () => ({ data: { success: true } }) } };
    window.__task4575Editor = state;
    window.fetch = async (url, options = {}) => {
      const method = options.method || "GET";
      if (method !== "GET") state.writes.push({ kind: "fetch", url: String(url), body: options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify(String(url).includes("clash") ? { clashes: [] } : []), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
    history.replaceState({}, "", mode === "simple" ? "/EditEvent?id=simple-task4575" : "/CreateComplexEvent?id=complex-task4575");
  }, { mode, simple: simpleEvent, complex: complexEvent });
  await page.addScriptTag({ content: editorScript });
}

test("simple actual editor defaults off, saves on, and reloads persisted fixture state", async ({ page }) => {
  await mountEditor(page, "simple");
  await page.getByTestId("button-tab-tickets").click();
  const toggle = page.getByTestId("switch-allow-public-invoice-po");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.getByTestId("button-save-event").click();
  await expect.poll(() => page.evaluate(() => window.__task4575Editor.writes.filter(w => w.kind === "simple").length)).toBe(1);
  expect(await page.evaluate(() => window.__task4575Editor.writes.find(w => w.kind === "simple").body.allow_public_invoice_po)).toBe(true);
  await page.getByTestId("fixture-remount-editor").click();
  await page.getByTestId("button-tab-tickets").click();
  await expect(page.getByTestId("switch-allow-public-invoice-po")).toBeChecked();
});

test("complex actual editor defaults off, saves on, and reloads persisted fixture state", async ({ page }) => {
  await mountEditor(page, "complex");
  const toggle = page.getByTestId("switch-allow-public-invoice-po");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.getByTestId("button-save").click();
  await expect.poll(() => page.evaluate(() => window.__task4575Editor.writes.filter(w => w.kind === "complex").length)).toBe(1);
  expect(await page.evaluate(() => window.__task4575Editor.writes.find(w => w.kind === "complex").body.allow_public_invoice_po)).toBe(true);
  await page.getByTestId("fixture-remount-editor").click();
  await expect(page.getByTestId("switch-allow-public-invoice-po")).toBeChecked();
});
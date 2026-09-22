import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";

/*
 * Mounted-editor verification for the private internal event type field.
 * Every Base44 entity and browser fetch is an in-memory fixture; the suite
 * never reaches an application API or tenant database.
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
  "@/api/base44Client": `export const base44 = window.__internalTypeEditor.base44;`,
  "@/hooks/useEventTypes": `export const useEventTypes = () => ({ eventTypes: [] });`,
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
    name: "internal-event-type-editor-fixture",
    setup(api) {
      api.onResolve({ filter: /^@\// }, args => {
        if (stubs[args.path]) return { path: args.path, namespace: "internal-type-stub" };
        return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
      });
      api.onResolve({ filter: /^@shared\// }, args => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      api.onLoad({ filter: /.*/, namespace: "internal-type-stub" }, args => ({
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
        import CreateEvent from "./client/src/pages/CreateEvent.jsx";
        import EditEvent from "./client/src/pages/EditEvent.jsx";
        import CreateComplexEvent from "./client/src/pages/CreateComplexEvent.jsx";

        function Harness() {
          const [version, setVersion] = useState(0);
          const [client, setClient] = useState(() => new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          }));
          const remount = () => {
            client.clear();
            setClient(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
            setVersion(value => value + 1);
          };
          const surface = window.__internalTypeEditor.surface;
          return <QueryClientProvider client={client}>
            <BrowserRouter>
              <button data-testid="fixture-remount-editor" type="button" onClick={remount}>Reload editor fixture</button>
              <div key={version}>
                {surface === "create-simple" && <CreateEvent />}
                {surface === "edit-simple" && <EditEvent />}
                {surface.startsWith("complex-") && <CreateComplexEvent />}
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
    outfile: "internal-event-types-editors.js",
    jsx: "automatic",
    plugins: [fixturePlugin()],
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
  });
  editorScript = result.outputFiles.find(file => file.path.endsWith(".js"))?.text
    || result.outputFiles[0].text;
});

const simpleEvent = {
  id: "simple-internal-type", title: "Simple editor fixture", summary: "Fixture",
  description: "Fixture", status: "tbc", event_state: "active",
  start_date: null, end_date: null, timezone: "Europe/London",
  internal_event_type: "Finance", is_unlimited_registration: true,
  pricing_config: { ticket_classes: [{
    id: "simple-ticket", name: "Standard Ticket", price: 25, is_free: false,
    visibility_mode: "members_only", role_ids: [], member_group_ids: [],
    offer_type: "none", is_unlimited_tickets: true, is_default: true,
  }] },
};

const complexEvent = {
  id: "complex-internal-type", title: "Complex editor fixture",
  slug: "complex-editor-fixture", summary: "Fixture", description: "Fixture",
  status: "tbc", event_state: "active", start_date: null, end_date: null,
  timezone: "Europe/London", internal_event_type: "Finance",
  is_unlimited_registration: true, pricing_config: {},
};

async function mountEditor(page, surface, simpleOverrides = {}, options = {}) {
  let documentLoaded = false;
  await page.route("**/*", async route => {
    if (route.request().resourceType() === "document") {
      // Keep the isolated harness alive when an editor schedules its normal
      // post-save redirect. Reloads here explicitly remount with a fresh cache.
      if (documentLoaded) return route.abort("aborted");
      documentLoaded = true;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>',
      });
      return;
    }
    await route.abort("blockedbyclient");
  });
  await page.goto(`http://internal-event-types.test/${surface}`);
  await page.evaluate(() => {
    window.__selectChanges = [];
    document.addEventListener("change", event => {
      if (event.target.tagName === "SELECT") {
        window.__selectChanges.push({
          value: event.target.value,
          options: [...event.target.options].map(option => option.value),
        });
      }
    });
  });
  await page.evaluate(({ surface, simple, complex, options }) => {
    const state = {
      surface,
      simple: structuredClone(simple),
      complex: structuredClone(complex),
      writes: [],
      calls: [],
    };
    const empty = async () => [];
    const clone = value => structuredClone(value);
    const entities = new Proxy({}, {
      get(_target, name) {
        const record = (operation, body) => {
          state.calls.push({ entity: String(name), operation, body: body ? clone(body) : null });
        };
        if (name === "SystemSettings") return {
          list: async () => {
            if (options.settingsDelay) await new Promise(resolve => setTimeout(resolve, options.settingsDelay));
            return [{
              id: "internal-types-setting",
              setting_key: "internal_event_types",
              setting_value: JSON.stringify(options.internalTypes || ["Finance", "Member Engagement"]),
            }];
          },
        };
        if (name === "Event") return {
          get: async () => clone(state.simple),
          list: empty,
          create: async body => {
            record("create", body);
            state.simple = { ...state.simple, ...clone(body), id: "created-simple-internal-type" };
            state.writes.push({ kind: "simple-create", body: clone(body) });
            sessionStorage.setItem("internal-type-last-write", JSON.stringify(state.writes.at(-1)));
            return clone(state.simple);
          },
          update: async (_id, body) => {
            record("update", body);
            state.simple = { ...state.simple, ...clone(body) };
            state.writes.push({ kind: "simple-update", body: clone(body) });
            return clone(state.simple);
          },
        };
        if (name === "ComplexEvent") return {
          get: async () => clone(state.complex),
          list: async () => [clone(state.complex)],
          create: async body => {
            record("create", body);
            state.complex = { ...state.complex, ...clone(body), id: "created-complex-internal-type" };
            state.writes.push({ kind: "complex-create", body: clone(body) });
            sessionStorage.setItem("internal-type-last-write", JSON.stringify(state.writes.at(-1)));
            return clone(state.complex);
          },
          update: async (_id, body) => {
            record("update", body);
            state.complex = { ...state.complex, ...clone(body) };
            state.writes.push({ kind: "complex-update", body: clone(body) });
            return clone(state.complex);
          },
        };
        return {
          list: empty,
          filter: empty,
          get: async () => null,
          create: async body => ({ id: `${String(name).toLowerCase()}-fixture`, ...clone(body) }),
          update: async (_id, body) => clone(body),
          delete: async () => ({}),
        };
      },
    });
    state.base44 = {
      entities,
      functions: { invoke: async () => ({ data: { success: true } }) },
      integrations: { Core: { UploadFile: async () => ({ file_url: "" }) } },
    };
    window.__internalTypeEditor = state;
    window.fetch = async (url, options = {}) => {
      state.calls.push({ fetch: String(url), method: options.method || "GET" });
      const requestUrl = String(url);
      const body = requestUrl.includes("check-event-slug")
        ? { available: true }
        : requestUrl.includes("clash")
          ? { hasClashes: false, clashes: [] }
          : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const urls = {
      "create-simple": "/CreateEvent",
      "edit-simple": "/EditEvent?id=simple-internal-type",
      "complex-create": "/CreateComplexEvent",
      "complex-edit": "/CreateComplexEvent?id=complex-internal-type",
    };
    history.replaceState({}, "", urls[surface]);
  }, { surface, simple: { ...simpleEvent, ...simpleOverrides }, complex: { ...complexEvent, ...options.complexOverrides }, options });
  await page.addScriptTag({ content: editorScript });
}

async function chooseInternalType(page, type) {
  const select = page.getByTestId("select-internal-event-type");
  await expect(select).toBeVisible();
  await select.click();
  await page.getByRole("option", { name: type, exact: true }).click();
  await expect(select).toContainText(type);
}

test("CreateEvent saves the selected internal event type", async ({ page }) => {
  await mountEditor(page, "create-simple");
  await page.getByTestId("input-title").fill("Created simple fixture");
  await page.getByTestId("radio-timing-tbc").click();
  await page.getByRole("tabpanel", { name: "Details" })
    .getByText("Standard Ticket", { exact: true })
    .click();
  await page.locator('[data-testid^="input-ticket-price-"]').fill("25");
  await chooseInternalType(page, "Member Engagement");
  await page.getByRole("button", { name: "Create Event", exact: true }).click();

  await expect.poll(() => page.evaluate(() => {
    const write = JSON.parse(sessionStorage.getItem("internal-type-last-write") || "null");
    return write?.kind === "simple-create" ? write.body.internal_event_type : null;
  })).toBe("Member Engagement");
});

test("EditEvent saves and reloads the selected internal event type", async ({ page }) => {
  await mountEditor(page, "edit-simple");
  await chooseInternalType(page, "Member Engagement");
  await page.getByTestId("button-save-event").click();
  await expect.poll(() => page.evaluate(() =>
    window.__internalTypeEditor.writes.find(write => write.kind === "simple-update")?.body.internal_event_type
  )).toBe("Member Engagement");

  await page.getByTestId("fixture-remount-editor").click();
  await expect(page.getByTestId("select-internal-event-type")).toContainText("Member Engagement");
});

test("EditEvent restores a published free event classification before settings arrive", async ({ page }) => {
  await mountEditor(page, "edit-simple", {
    internal_event_type: "GFI Free",
    member_group_id: null,
    status: "published",
    event_type: "GFI Supported Event",
    start_date: "2026-09-24T11:00:00+00:00",
    end_date: "2026-09-24T11:45:00+00:00",
    cta_override_url: "https://example.test/book",
    cta_override_mode: "card",
    pricing_config: { ticket_classes: [{
      id: "free-ticket", name: "Standard Ticket", price: 0, is_free: true,
      visibility_mode: "members_only", role_ids: [], member_group_ids: [],
      offer_type: "none", is_unlimited_tickets: true, is_default: true,
    }] },
  }, { settingsDelay: 250, internalTypes: ["GFI Free", "CoP Free", "L&D", "Conference", "Awards", "GFI Supported Events"] });
  await expect(page.getByTestId("select-internal-event-type")).toContainText("GFI Free");
  // Exercise the real Radix/native-select race, not a mocked successful
  // dropdown: the empty event must occur without clearing the stored value.
  await expect.poll(() => page.evaluate(() =>
    window.__selectChanges.some(change => change.value === "" && change.options.includes("__none__"))
  )).toBe(true);
  await page.getByTestId("fixture-remount-editor").click();
  await expect(page.getByTestId("select-internal-event-type")).toContainText("GFI Free");
});

for (const surface of ["edit-simple", "complex-edit"]) {
  for (const delayedSettings of [false, true]) {
    test(`${surface} preserves, changes and explicitly clears a stored type with ${delayedSettings ? "late" : "missing"} settings options`, async ({ page }) => {
      await mountEditor(page, surface, { internal_event_type: "GFI Free" }, {
        complexOverrides: { internal_event_type: "GFI Free" },
        settingsDelay: delayedSettings ? 250 : 0,
        internalTypes: delayedSettings ? ["GFI Free", "Finance"] : ["Finance"],
      });
      const select = page.getByTestId("select-internal-event-type");
      const save = page.getByTestId(surface === "edit-simple" ? "button-save-event" : "button-save");
      const writeKind = surface === "edit-simple" ? "simple-update" : "complex-update";
      const saveAndReload = async expected => {
        const before = await page.evaluate(() => window.__internalTypeEditor.writes.length);
        await save.click();
        await expect.poll(() => page.evaluate(({ before, writeKind }) =>
          window.__internalTypeEditor.writes.slice(before).find(write => write.kind === writeKind)?.body.internal_event_type,
          { before, writeKind }
        )).toBe(expected);
        await page.getByTestId("fixture-remount-editor").click();
        await expect(select).toContainText(expected || "No internal type");
      };
      await expect(select).toContainText("GFI Free");
      await page.getByTestId("input-title").fill("Unrelated title edit");
      await saveAndReload("GFI Free");
      await chooseInternalType(page, "Finance");
      await saveAndReload("Finance");
      await chooseInternalType(page, "No internal type");
      await saveAndReload(null);
    });
  }
}

test("CreateComplexEvent create mode saves the selected internal event type", async ({ page }) => {
  await mountEditor(page, "complex-create");
  await page.getByTestId("input-title").fill("Created complex fixture");
  await chooseInternalType(page, "Member Engagement");
  await page.getByTestId("button-save").click();

  await expect.poll(() => page.evaluate(() => {
    const write = JSON.parse(sessionStorage.getItem("internal-type-last-write") || "null");
    return write?.kind === "complex-create" ? write.body.internal_event_type : null;
  })).toBe("Member Engagement");
});

test("CreateComplexEvent edit mode saves and reloads the selected internal event type", async ({ page }) => {
  await mountEditor(page, "complex-edit");
  await chooseInternalType(page, "Member Engagement");
  await page.getByTestId("button-save").click();
  await expect.poll(() => page.evaluate(() =>
    window.__internalTypeEditor.writes.find(write => write.kind === "complex-update")?.body.internal_event_type
  )).toBe("Member Engagement");

  await page.getByTestId("fixture-remount-editor").click();
  await expect(page.getByTestId("select-internal-event-type")).toContainText("Member Engagement");
});
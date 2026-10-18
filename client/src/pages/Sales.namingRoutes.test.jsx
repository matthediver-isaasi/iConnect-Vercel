import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { unlink } from "node:fs/promises";
import path from "node:path";

// Mounted route integration: production Sales, settings/query hook, role hook,
// LayoutProvider, and naming helpers. Expensive destination workspaces are
// stubbed except the final test, which mounts real QuotesWorkspace with isolated
// read-only resource responses and a tax-options hook stub. The editor stub owns
// dirty state so a remount is observable. No app server/auth bypass is used.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/sales/quotes",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
for (const key of ["Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "DocumentFragment", "HTMLInputElement"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes, useLocation, useNavigate } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const bundlePath = path.join(process.cwd(), `.sales-naming-routes-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export { default as Sales } from "./client/src/pages/Sales.jsx";
      export { LayoutProvider, useLayoutContext } from "./client/src/contexts/LayoutContext.jsx";
      export { useSalesSettings, useQuoteNaming } from "./client/src/hooks/useSalesSettings.js";
    `,
    resolveDir: process.cwd(),
    loader: "jsx",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") },
  define: { "import.meta.env": "{}" },
  loader: { ".css": "empty" },
  logLevel: "silent",
  plugins: [{
    name: "stateful-destination-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /pages\/sales\/useCatalogue$/ }, () => ({ path: "tax-options", namespace: "tax-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "tax-fixture" }, () => ({
        contents: "export const useCatalogueTaxOptions = () => ({ data: [], isPending: false, isError: false });",
      }));
      builder.onResolve(
        { filter: /(pages\/sales\/Catalogue|components\/sales\/(OpportunitiesWorkspace|QuotesWorkspace|SalesTasksWorkspace|SalesReportingWorkspace))$/ },
        args => ({ path: args.path, namespace: "destination-fixture" }),
      );
      builder.onLoad({ filter: /.*/, namespace: "destination-fixture" }, args => {
        if (args.path.endsWith("QuotesWorkspace")) return {
          loader: "jsx",
          resolveDir: process.cwd(),
          contents: `
            import { useState } from "react";
            import { useParams } from "react-router-dom";
            import { useQuoteNaming } from "@/hooks/useSalesSettings";
            import { useSalesSettings as useCatalogueSettings } from "@/components/sales/useSalesSettings";
            import RealWorkspace from ${JSON.stringify(path.resolve("client/src/components/sales/QuotesWorkspace.jsx"))};
            export default function Editor() {
              const [draft, setDraft] = useState("");
              const { id } = useParams();
              const naming = useQuoteNaming();
              const catalogue = useCatalogueSettings();
              if (globalThis.__realQuoteWorkspace) return <RealWorkspace />;
              return <section data-testid="quote-workspace">
                <span data-testid="quote-route-id">{id || "list"}</span>
                <span data-testid="editor-naming">{naming.singular} / {naming.plural}</span>
                <span data-testid="catalogue-visibility">{JSON.stringify({
                  showInternalCode: catalogue.data?.showInternalCode,
                  showSku: catalogue.data?.showSku,
                  quoteTaskListName: catalogue.data?.quoteTaskListName,
                })}</span>
                <input aria-label="Dirty editor value" value={draft} onChange={event => setDraft(event.target.value)} />
              </section>;
            }
          `,
        };
        if (args.path.endsWith("SalesReportingWorkspace")) return {
          loader: "jsx",
          contents: `
            export const SalesDashboard = () => <div data-testid="dashboard-workspace">dashboard</div>;
            export const SalesReports = () => <div data-testid="reports-workspace">reports</div>;
          `,
        };
        return {
          loader: "jsx",
          contents: 'export default ({ destination }) => <div data-testid="other-workspace">{destination || "catalogue/tasks"}</div>;',
        };
      });
    },
  }],
});
const { Sales, LayoutProvider, useLayoutContext, useSalesSettings, useQuoteNaming } = await import(pathToFileURL(bundlePath).href);
after(async () => {
  await unlink(bundlePath).catch(() => {});
  dom.window.close();
});

const proposal = {
  quoteSingularName: "Proposal", quotePluralName: "Proposals", quoteUrlSegment: "proposals",
  showInternalCode: false, showSku: true, quoteTaskListName: "Delivery preparation", version: 1,
};
const salesPlan = {
  quoteSingularName: "Sales Plan", quotePluralName: "Sales Plans", quoteUrlSegment: "sales-plans",
  showInternalCode: true, showSku: false, quoteTaskListName: "Delivery preparation", version: 2,
};
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const member = (suffix = "a") => ({ id: `member-${suffix}`, tenant_id: `tenant-${suffix}`, role_id: `role-${suffix}`, member_excluded_features: [] });
const snapshot = (suffix = "a", exclusions = []) => ({
  status: "ready", member_id: `member-${suffix}`, tenant_id: `tenant-${suffix}`,
  role_id: `role-${suffix}`, session_key: `session-${suffix}`,
  role: { id: `role-${suffix}`, tenant_id: `tenant-${suffix}`, name: "Member", excluded_features: exclusions },
});
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
}
async function until(check, message) {
  for (let attempt = 0; attempt < 30 && !check(); attempt += 1) await settle();
  assert.ok(check(), message);
}

async function mount({ initialEntries = ["/sales/quotes"], initialIndex, load = async () => response(proposal), resources } = {}) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.ok(url === "/api/sales/settings" || resources, "only explicitly isolated endpoints may request fixture data");
    assert.equal(options.credentials, "include");
    requests.push({ url, options });
    return url === "/api/sales/settings" ? load(url, options) : resources(url, options);
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let layout, location, navigate, settings, naming;
  function Capture() {
    layout = useLayoutContext();
    location = useLocation();
    navigate = useNavigate();
    settings = useSalesSettings();
    naming = useQuoteNaming();
    return null;
  }
  // Mirrors production's fixed legacy routes and generic naming discovery.
  // It intentionally does not import the full application index/Layout tree.
  await act(async () => root.render(
    <QueryClientProvider client={cache}>
      <LayoutProvider>
        <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}>
          <Capture />
          <Routes>
            <Route path="/sales/quotes" element={<Sales destination="quotes" />} />
            <Route path="/sales/quotes/:id" element={<Sales destination="quotes" />} />
            {["dashboard", "pipeline", "opportunities", "catalogue", "products", "bundles", "tasks", "reports", "settings"].map(destination =>
              <Route key={destination} path={`/sales/${destination}`} element={<Sales destination={destination} />} />)}
            <Route path="/sales/:destination" element={<Sales />} />
            <Route path="/sales/:destination/:id" element={<Sales />} />
            <Route path="/Preferences" element={<div data-testid="preferences">preferences</div>} />
            <Route path="*" element={<div data-testid="outside-sales">outside sales</div>} />
          </Routes>
        </MemoryRouter>
      </LayoutProvider>
    </QueryClientProvider>,
  ));
  return {
    container, requests, cache,
    get layout() { return layout; },
    get location() { return location; },
    get settings() { return settings; },
    get naming() { return naming; },
    get url() { return `${location.pathname}${location.search}${location.hash}`; },
    get editor() { return container.querySelector('[aria-label="Dirty editor value"]'); },
    async authenticate(suffix = "a", exclusions = []) {
      await act(async () => {
        layout.setMemberInfo(member(suffix));
        layout.setSessionRoleSnapshot(snapshot(suffix, exclusions));
        layout.setSessionValidated(true);
        layout.setAuthResolved(true);
      });
    },
    async go(to) { await act(async () => navigate(to)); await settle(); },
    async publish(data) { await act(async () => settings.publish(data)); await settle(); },
    async edit(value) {
      const input = container.querySelector('[aria-label="Dirty editor value"]');
      assert.ok(input, "editor is mounted");
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      cache.clear();
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

for (const configured of [proposal, salesPlan]) {
  test(`${configured.quotePluralName}: configured/legacy list, new and detail cold entries preserve query/hash and refresh`, async t => {
    for (const alias of ["quotes", configured.quoteUrlSegment]) {
      for (const tail of ["", "/new", "/quote-123"]) {
        await t.test(`${alias}${tail || " list"}`, async () => {
          const suffix = "?opportunityId=opp%2F18&filter=draft#commercial-details";
          const canonical = `/sales/${configured.quoteUrlSegment}${tail}${suffix}`;
          let view = await mount({ initialEntries: [`/sales/${alias}${tail}${suffix}`], load: async () => response(configured) });
          try {
            assert.equal(view.requests.length, 0, "unvalidated sessions never fetch settings");
            await view.authenticate();
            await until(() => view.editor && view.url === canonical, "canonical destination and editor should be ready");
            assert.equal(view.container.querySelector("h1").textContent, configured.quotePluralName);
            assert.equal(view.container.querySelector('[data-testid="quote-route-id"]').textContent, tail.slice(1) || "list");
            assert.equal(view.container.querySelector('[data-testid="editor-naming"]').textContent, `${configured.quoteSingularName} / ${configured.quotePluralName}`);
            assert.equal(view.requests.length, 1, "real hook shares one scoped query across observers");
          } finally {
            await view.cleanup();
          }
          // Fresh tree and cache represent a direct refresh, not cached routing.
          view = await mount({ initialEntries: [canonical], load: async () => response(configured) });
          try {
            await view.authenticate();
            await until(() => Boolean(view.editor), "fresh direct route should load");
            assert.equal(view.url, canonical);
            assert.equal(view.requests.length, 1);
          } finally {
            await view.cleanup();
          }
        });
      }
    }
  });
}

test("legacy canonicalization replaces history; memory back/forward preserves parameters and fragments", async () => {
  const view = await mount({
    initialEntries: ["/sales/dashboard?before=1#home", "/sales/quotes/new?opportunityId=opp-3#notes"],
    initialIndex: 1,
  });
  try {
    await view.authenticate();
    await until(() => view.url === "/sales/proposals/new?opportunityId=opp-3#notes" && view.editor, "legacy new route canonicalizes");
    await view.go("/sales/proposals/quote-4?version=2#history");
    assert.equal(view.url, "/sales/proposals/quote-4?version=2#history");
    await view.go(-1);
    assert.equal(view.url, "/sales/proposals/new?opportunityId=opp-3#notes");
    await view.go(-1);
    assert.equal(view.url, "/sales/dashboard?before=1#home", "replacement did not add a legacy entry");
    await view.go(1);
    assert.equal(view.url, "/sales/proposals/new?opportunityId=opp-3#notes");
    await view.go(1);
    assert.equal(view.url, "/sales/proposals/quote-4?version=2#history");
    assert.equal(view.requests.length, 1);
  } finally {
    await view.cleanup();
  }
});

test("unknown and former aliases cannot open quotes; reserved Sales destinations keep their own workspaces", async t => {
  for (const route of ["/sales/unknown", "/sales/proposals", "/sales/proposals/new", "/sales/reports/new", "/sales/settings/quote-1"]) {
    await t.test(route, async () => {
      const view = await mount({ initialEntries: [route], load: async () => response(salesPlan) });
      try {
        await view.authenticate();
        await until(() => view.container.textContent.includes("Sales page not found"), "unrecognized alias should be rejected");
        assert.equal(view.url, route);
        assert.equal(view.editor, null);
      } finally {
        await view.cleanup();
      }
    });
  }
  for (const destination of ["reports", "settings", "pipeline"]) {
    await t.test(`reserved ${destination}`, async () => {
      const view = await mount({ initialEntries: [`/sales/${destination}`], load: async () => response(salesPlan) });
      try {
        await view.authenticate();
        await settle();
        assert.equal(view.url, `/sales/${destination}`);
        assert.equal(view.editor, null);
        assert.equal(view.container.querySelector("h1").textContent, destination[0].toUpperCase() + destination.slice(1));
      } finally {
        await view.cleanup();
      }
    });
  }
});

test("settings loading/failure never opens or redirects an alias; Retry recovers the requested route", async () => {
  const first = deferred();
  let attempts = 0;
  const view = await mount({
    initialEntries: ["/sales/sales-plans/new?opportunityId=opp-1#draft"],
    load: async () => ++attempts === 1 ? first.promise : response(salesPlan),
  });
  try {
    await view.authenticate();
    assert.match(view.container.textContent, /Loading Sales settings/);
    assert.equal(view.editor, null);
    assert.equal(view.url, "/sales/sales-plans/new?opportunityId=opp-1#draft");
    await act(async () => first.resolve(response({ error: "Settings unavailable" }, 503)));
    await until(() => view.container.textContent.includes("Sales settings could not be loaded"), "settings failure is visible");
    assert.equal(view.editor, null);
    assert.equal(view.url, "/sales/sales-plans/new?opportunityId=opp-1#draft");
    await act(async () => view.container.querySelector("button").click());
    await until(() => Boolean(view.editor), "retry recovers actual settings hook");
    assert.equal(attempts, 2);
    assert.equal(view.url, "/sales/sales-plans/new?opportunityId=opp-1#draft");
  } finally {
    await view.cleanup();
  }
});

test("denied base and quote access never reveals the configured or legacy editor", async t => {
  for (const alias of ["quotes", "proposals"]) {
    for (const denied of ["sales.view", "sales.quotes", "sales"]) {
      await t.test(`${alias} denies ${denied}`, async () => {
        const view = await mount({ initialEntries: [`/sales/${alias}/quote-1?x=1#history`] });
        try {
          await view.authenticate("a", [denied]);
          await until(() => view.location.pathname === "/Preferences", "denied routes redirect to preferences");
          assert.equal(view.editor, null);
          assert.ok(view.container.querySelector('[data-testid="preferences"]'));
          if (denied !== "sales.quotes") assert.equal(view.requests.length, 0, "module denial prevents settings reads");
        } finally {
          await view.cleanup();
        }
      });
    }
  }
});

test("publishing settings immediately relabels/replaces an open dirty editor without remounting it", async () => {
  const view = await mount({ initialEntries: ["/sales/proposals/quote-8?version=3#lines"] });
  try {
    await view.authenticate();
    await until(() => Boolean(view.editor), "initial editor is ready");
    await view.edit("Unsaved negotiated customer prices");
    const input = view.editor;
    await view.publish(salesPlan);
    assert.equal(view.url, "/sales/sales-plans/quote-8?version=3#lines");
    assert.equal(view.container.querySelector("h1").textContent, "Sales Plans");
    assert.equal(view.container.querySelector('[data-testid="editor-naming"]').textContent, "Sales Plan / Sales Plans");
    assert.equal(view.editor, input, "URL replacement retains the same mounted input");
    assert.equal(view.editor.value, "Unsaved negotiated customer prices");
    assert.deepEqual(JSON.parse(view.container.querySelector('[data-testid="catalogue-visibility"]').textContent), {
      showInternalCode: true, showSku: false, quoteTaskListName: "Delivery preparation",
    }, "canonical catalogue observer immediately sees naming publish and visibility changes without losing unrelated fields");
    assert.equal(view.settings.data.quoteTaskListName, "Delivery preparation");
    assert.equal(view.requests.length, 1, "publish updates shared cache immediately without another network read");
    await act(async () => view.settings.accept({ ...view.settings.data, showSku: true, version: 3 }));
    await settle();
    assert.equal(view.naming.slug, "sales-plans", "catalogue visibility acceptance preserves published naming");
    assert.equal(view.editor, input);
    assert.equal(view.editor.value, "Unsaved negotiated customer prices");
    assert.deepEqual(JSON.parse(view.container.querySelector('[data-testid="catalogue-visibility"]').textContent), {
      showInternalCode: true, showSku: true, quoteTaskListName: "Delivery preparation",
    }, "visibility-only authoritative response shares the same query as naming");
    await view.publish(proposal);
    assert.equal(view.naming.slug, "sales-plans", "older settings versions cannot replace the published result");
    assert.equal(view.editor.value, "Unsaved negotiated customer prices");
    await view.go("/sales/proposals/quote-8");
    assert.match(view.container.textContent, /Sales page not found/, "prior alias is not generally retained");
    assert.equal(view.editor, null);
  } finally {
    await view.cleanup();
  }
});

test("identity changes isolate settings and reject a late publish from the previous session", async () => {
  const second = deferred();
  let loads = 0;
  const view = await mount({ initialEntries: ["/sales/quotes/new?opportunityId=opp-2#details"], load: async () => ++loads === 1 ? response(proposal) : second.promise });
  try {
    await view.authenticate();
    await until(() => Boolean(view.editor), "first identity loads naming");
    assert.equal(view.url, "/sales/proposals/new?opportunityId=opp-2#details");
    const oldSettings = view.settings;
    await view.authenticate("b");
    assert.equal(view.editor, null, "previous identity's editor is hidden during scope discovery");
    assert.equal(view.naming.singular, "Quote", "old tenant naming does not leak into the new hook scope");
    assert.match(view.container.textContent, /Loading Sales settings/);
    await act(async () => oldSettings.publish({ ...proposal, quotePluralName: "Stale tenant labels", version: 99 }));
    assert.equal(view.naming.singular, "Quote");
    await act(async () => second.resolve(response(salesPlan)));
    await until(() => view.settings.ready, "second identity loads its own settings");
    assert.equal(view.naming.slug, "sales-plans");
    assert.match(view.container.textContent, /Sales page not found/, "previous tenant's alias is not authorized for this tenant");
    assert.equal(view.editor, null);
    await view.go("/sales/quotes/new?opportunityId=opp-2#details");
    await until(() => view.url === "/sales/sales-plans/new?opportunityId=opp-2#details" && view.editor, "legacy route resolves under new identity");
    assert.equal(loads, 2);
  } finally {
    await view.cleanup();
  }
});

test("an in-flight settings response from an old identity cannot populate the new identity", async () => {
  const first = deferred();
  const second = deferred();
  let loads = 0;
  const view = await mount({ load: async () => ++loads === 1 ? first.promise : second.promise });
  try {
    await view.authenticate();
    assert.equal(view.editor, null);
    await view.authenticate("b");
    assert.equal(loads, 2);
    await act(async () => first.resolve(response(proposal)));
    await settle();
    assert.equal(view.editor, null);
    assert.equal(view.naming.singular, "Quote");
    await act(async () => second.resolve(response(salesPlan)));
    await until(() => view.url === "/sales/sales-plans" && view.editor, "only the second identity's response opens its editor");
    assert.equal(view.naming.plural, "Sales Plans");
    assert.equal(view.requests[0].options.signal.aborted, true, "old identity query is cancelled");
  } finally {
    await view.cleanup();
  }
});

test("real QuotesWorkspace list navigation and dirty editor retain domain identity across a live rename", async () => {
  globalThis.__realQuoteWorkspace = true;
  const quote = {
    id: "quote-8", quote_number: "Q-1049", status: "draft",
    permissions: { canEdit: true },
    currentVersion: { version_number: 1, row_version: 3, currency: "GBP", notes: "Original authored quote notes", lines: [] },
  };
  const view = await mount({
    initialEntries: ["/sales/proposals?status=draft#list"],
    resources: async (url, options) => {
      assert.equal(options.method || "GET", "GET", "integration never writes or sends");
      if (url.startsWith("/api/sales/quotes?")) return response({ items: [quote], total: 1 });
      if (url === "/api/sales/quotes/quote-8") return response(quote);
      if (["/api/sales/catalogue/products", "/api/sales/catalogue/bundles"].includes(url)) return response([]);
      throw new Error(`Unexpected isolated resource: ${url}`);
    },
  });
  try {
    await view.authenticate();
    await until(() => view.container.textContent.includes("Q-1049"), "production quotes list loads fixture data");
    assert.match(view.container.textContent, /Create Proposal/);
    assert.equal(view.container.querySelector("th").textContent, "Proposal");
    const row = [...view.container.querySelectorAll("tbody tr")].find(node => node.textContent.includes("Q-1049"));
    await act(async () => row.click());
    await until(() => Boolean(view.container.querySelector("textarea")), "production detail editor loads");
    assert.equal(view.url, "/sales/proposals/quote-8");
    assert.match(view.container.textContent, /Q-1049/);
    assert.match(view.container.textContent, /Issue Proposal/);
    const notes = view.container.querySelector("textarea");
    assert.equal(notes.value, "Original authored quote notes");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(notes, "Unsaved authored quote notes");
      notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await view.publish(salesPlan);
    assert.equal(view.url, "/sales/sales-plans/quote-8");
    assert.equal(view.container.querySelector("textarea"), notes, "real editor was not remounted");
    assert.equal(notes.value, "Unsaved authored quote notes", "live rename preserves actual unsaved form data");
    assert.match(view.container.textContent, /Issue Sales Plan/);
    assert.match(view.container.textContent, /Q-1049/, "quote number is never renamed");
    assert.ok(view.requests.some(request => request.url === "/api/sales/quotes/quote-8"), "API domain remains quotes");
    assert.ok(view.requests.every(request => !request.url.includes("/sales/sales-plans")), "configured URL aliases never reach API calls");
  } finally {
    await view.cleanup();
    delete globalThis.__realQuoteWorkspace;
  }
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// All data is local to this test: no requests, auth, workflow, or live database.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://sponsor.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = Module.createRequire(import.meta.url)("@tanstack/react-query");
const fixture = { queries: [], mode: "success" };
globalThis.__eventSponsorFixture = fixture;
const result = await build({
  entryPoints: ["client/src/components/events/EventSponsorSelector.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "sponsor-isolation",
    setup(builder) {
      builder.onResolve({ filter: /^@\/api\/base44Client$/ }, () => ({ path: "api", namespace: "fixture" }));
      builder.onResolve({ filter: /^@\/lib\/useSponsorTenant$/ }, () => ({ path: "tenant", namespace: "fixture" }));
      builder.onResolve({ filter: /^sonner$/ }, () => ({ path: "toast", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        contents: args.path === "tenant" ? 'export const useSponsorTenant = () => "tenant-a";' :
          args.path === "toast" ? 'export const toast = {success(){}, error(){}};' : `
            const fixture = globalThis.__eventSponsorFixture;
            export const base44 = { entities: {
              EventSponsor: { async listAll() { return [{id:"shared", name:"Shared Sponsor", category_id:"obsolete-global"}]; } },
              EventSponsorCategory: { async listAll(options) {
                fixture.queries.push(options);
                if (fixture.mode === "loading") return new Promise(() => {});
                if (fixture.mode === "error") throw new Error("Categories unavailable");
                return [{ id:options.filter.event_id + "-category", name:options.filter.event_id + " Partner", display_order:1 }];
              } }
            }};`,
      }));
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/client/src/sponsor-selector-test.cjs`);
compiled.filename = `${process.cwd()}/client/src/sponsor-selector-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(result.outputFiles[0].text, compiled.filename);
const Selector = compiled.exports.default;

after(() => { delete globalThis.__eventSponsorFixture; dom.window.close(); });

async function mount(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const changes = [];
  const render = () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Selector, {
    selectedSponsorIds: ["shared"], onSelectedSponsorIdsChange: () => {},
    sponsorCategories: { shared: props.eventId + "-category" },
    onSponsorCategoryChange: (...args) => changes.push(args),
    ...props,
  })));
  await act(async () => { render(); await new Promise(resolve => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return { container, changes, client, async close() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

test("categories and query cache keys belong to the exact tenant/event/type", async () => {
  fixture.mode = "success"; fixture.queries = [];
  const first = await mount({ eventId: "event-a", eventType: "simple" });
  const second = await mount({ eventId: "event-b", eventType: "complex" });
  try {
    assert.match(first.container.textContent, /event-a Partner/);
    assert.doesNotMatch(first.container.textContent, /event-b Partner/);
    assert.match(second.container.textContent, /event-b Partner/);
    assert.deepEqual(fixture.queries.map(q => q.filter), [
      { event_id: "event-a", event_type: "simple" }, { event_id: "event-b", event_type: "complex" },
    ]);
    assert.ok(first.client.getQueryCache().find({ queryKey: ["/api/entities/EventSponsorCategory", "tenant-a", "simple", "event-a"], exact: true }));
    assert.deepEqual(first.changes, []);
    assert.deepEqual(second.changes, []);
  } finally { await first.close(); await second.close(); }
});

for (const mode of ["loading", "error"]) {
  test(`${mode} categories preserve assignment and disable category changes`, async () => {
    fixture.mode = mode;
    const view = await mount({ eventId: "event-a" });
    try {
      const select = view.container.querySelector('[data-testid="select-sponsor-category-shared"]');
      assert.ok(select.disabled);
      assert.deepEqual(view.changes, []);
      assert.match(view.container.textContent, /Shared Sponsor/);
      if (mode === "error") {
        assert.match(view.container.textContent, /Existing selections are preserved/);
        assert.ok([...view.container.querySelectorAll("button")].some(b => b.textContent === "Retry"));
      }
    } finally { await view.close(); }
  });
}

test("unsaved events allow standalone sponsors but explain category save-first requirement", async () => {
  fixture.mode = "success"; fixture.queries = [];
  const view = await mount({ eventId: null, selectedSponsorIds: [], sponsorCategories: {} });
  try {
    assert.match(view.container.textContent, /Save this event first/);
    assert.equal(view.container.querySelector('[data-testid="button-select-sponsors"]').disabled, false);
    assert.equal(view.container.querySelector('[data-testid="button-create-category"]').disabled, true);
    assert.deepEqual(fixture.queries, []);
  } finally { await view.close(); }
});

test("explicit uncategorised selection never uses a sponsor-wide legacy category", async () => {
  fixture.mode = "success";
  const view = await mount({ eventId: "event-a", sponsorCategories: { shared: null } });
  try {
    assert.match(view.container.querySelector('[data-testid="select-sponsor-category-shared"]').textContent, /Uncategorised/);
    assert.doesNotMatch(view.container.textContent, /obsolete-global/);
    assert.deepEqual(view.changes, []);
  } finally { await view.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { unlink } from "node:fs/promises";
import path from "node:path";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/members/member-1",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = handle => clearTimeout(handle);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@radix-ui/react-tooltip");
// Bundle the view and its local contexts together while leaving package
// dependencies external. This supplies Vite's import.meta.env without starting
// a dev server or creating duplicate React/router package instances.
const bundlePath = path.join(process.cwd(), `.member-detail-related-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export { default as MemberDetailView } from "./client/src/components/MemberDetailView.jsx";
      export { LayoutProvider, useLayoutContext } from "./client/src/contexts/LayoutContext.jsx";
    `,
    resolveDir: process.cwd(),
    loader: "jsx",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  alias: { "@": path.join(process.cwd(), "client/src") },
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
});
const bundled = await import(pathToFileURL(bundlePath).href);
const { MemberDetailView, LayoutProvider, useLayoutContext } = bundled;

function Identity({ children }) {
  const layout = useLayoutContext();
  useEffect(() => {
    layout.setMemberInfo({ id: "viewer-1", tenant_id: "tenant-1" });
    layout.setSessionValidated(true);
    layout.setAuthResolved(true);
  }, []);
  return children;
}

const member = id => ({
  id,
  first_name: id === "member-1" ? "First" : "Second",
  last_name: "Member",
  email: `${id}@example.test`,
  capabilities: { edit_records: false },
});

const definition = {
  id: "member-organisations",
  status: "active",
  cardinality: "many_to_many",
  source_kind: "member",
  target_kind: "organization",
  source_label: "Organisations",
  target_label: "Members",
  can_edit: false,
  edit_from_source: false,
};

const edgeRows = label => ({
  data: [{
    relationship_id: `edge-${label}`,
    related_kind: "organization",
    related_record_id: `org-${label}`,
    related: {
      id: `org-${label}`,
      kind: "organization",
      primary_label: label,
    },
  }],
  total: 1,
  pageSize: 10,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const unrelatedResponse = path => path.includes("/api/entities/SystemSettings")
  ? json([{ setting_key: "role_segmentation_field_id", setting_value: "" }])
  : json([]);

function deferred() {
  let resolve;
  const promise = new Promise(res => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle(delay = 20) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delay));
  });
}

async function mount(child) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const render = async next => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <TooltipProvider>
              <LayoutProvider><Identity>{next}</Identity></LayoutProvider>
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };
  await render(child);
  return {
    container,
    render,
    async cleanup() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const propsFor = (value, extra = {}) => ({
  member: value,
  memberCustomFields: [],
  organizations: [],
  roles: [],
  ...extra,
});

async function selectTab(tab) {
  await act(async () => {
    tab.dispatchEvent(new dom.window.MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
    }));
  });
  await settle();
}

test("discovers delayed definitions on overview, then loads the selected relationship tab", async () => {
  const definitions = deferred();
  const rows = deferred();
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("/core/relationship-definitions")) return definitions.promise;
    if (path.includes("/core/relationships")) return rows.promise;
    return unrelatedResponse(path);
  };

  const view = await mount(<MemberDetailView {...propsFor(member("member-1"))} />);
  assert.ok(view.container.querySelector('[data-testid="related-records-loading"]'));
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);

  definitions.resolve(json({
    data: [{ definition, side: "source", count: 1 }],
    total: 1,
  }));
  await settle();
  const tab = view.container.querySelector('[data-testid="tab-relationship-member-organisations-source"]');
  assert.ok(tab);
  await selectTab(tab);
  assert.equal(tab.getAttribute("data-state"), "active");
  assert.ok(view.container.querySelector('[data-testid="related-records-loading"]'));

  rows.resolve(json(edgeRows("Loaded organisation")));
  await settle();
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);
  assert.match(view.container.textContent, /Loaded organisation/);
  const panel = view.container.querySelector('[role="tabpanel"][data-state="active"]');
  assert.ok(panel);
  assert.ok(panel.getAttribute("aria-labelledby"));
  await view.cleanup();
});

test("prop identity changes never retain the previous tab rows and reset for new or id-less members", async () => {
  const secondDefinitions = deferred();
  const secondRows = deferred();
  let firstDefinitionsDone = false;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("/core/relationship-definitions")) {
      const recordId = new URL(path, "https://tenant.example.test").searchParams.get("recordId");
      if (recordId === "member-2") return secondDefinitions.promise;
      firstDefinitionsDone = true;
      return json({ data: [{ definition, side: "source" }], total: 1 });
    }
    if (path.includes("/core/relationships")) {
      const recordId = new URL(path, "https://tenant.example.test").searchParams.get("recordId");
      return recordId === "member-2"
        ? secondRows.promise
        : json(edgeRows("Old organisation"));
    }
    return unrelatedResponse(path);
  };

  const view = await mount(<MemberDetailView {...propsFor(member("member-1"))} />);
  assert.equal(firstDefinitionsDone, true);
  const tab = view.container.querySelector('[data-testid^="tab-relationship-"]');
  await selectTab(tab);
  assert.match(view.container.textContent, /Old organisation/);

  await view.render(<MemberDetailView {...propsFor(member("member-2"))} />);
  assert.doesNotMatch(view.container.textContent, /Old organisation/);
  assert.ok(view.container.querySelector("[data-relationship-discovery]"));
  assert.equal(
    view.container.querySelector('[role="tabpanel"][aria-labelledby*="relationship"]'),
    null,
  );

  await view.render(<MemberDetailView {...propsFor({}, { isNew: true })} />);
  assert.ok(view.container.querySelector('[data-testid="tab-member-overview"][data-state="active"]'));
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);
  assert.equal(view.container.querySelector('[data-testid="related-records-loading"]'), null);

  await view.render(<MemberDetailView {...propsFor({})} />);
  assert.ok(view.container.querySelector('[data-testid="tab-member-overview"][data-state="active"]'));
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);
  assert.equal(view.container.querySelector('[data-testid="related-records-loading"]'), null);
  await view.cleanup();
});

test("definition failure on the reusable view exposes Retry and recovers", async () => {
  let definitionCalls = 0;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("/core/relationship-definitions")) {
      definitionCalls += 1;
      return definitionCalls === 1
        ? json({ error: "Definitions unavailable" }, 503)
        : json({ data: [], total: 0 });
    }
    return unrelatedResponse(path);
  };

  const view = await mount(<MemberDetailView {...propsFor(member("member-1"))} />);
  const alert = [...view.container.querySelectorAll('[role="alert"]')]
    .find(item => item.textContent.includes("Records could not be loaded"));
  assert.ok(alert);
  const retry = [...alert.querySelectorAll("button")]
    .find(button => button.textContent.includes("Retry"));
  await act(async () => retry.click());
  await settle();
  assert.equal(definitionCalls, 2);
  assert.equal(
    [...view.container.querySelectorAll('[role="alert"]')]
      .some(item => item.textContent.includes("Records could not be loaded")),
    false,
  );
  assert.equal(view.container.querySelector('[data-testid="related-records-loading"]'), null);
  await view.cleanup();
});

test.after(async () => {
  await unlink(bundlePath).catch(() => {});
});
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Bundle the actual pages with real routing, query state and UI. Only access,
// realtime and the independently tested integration components are fixtures.
// All requests below stay inside this process; no backend or database is used.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://isolated.example.test/",
});
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, {
    configurable: true, value: key === "window" ? dom.window : dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
const childNames = [
  "SalesTasksWorkspace", "ProjectBoardOpportunityPanel", "ProjectBoardTaskDeepLink",
  "ProjectsSalesTasksLink", "ProjectCardDetailModal", "OpportunitiesWorkspace",
  "QuotesWorkspace", "SalesReportingWorkspace",
];
async function loadPage(name) {
  const bundle = await build({
    entryPoints: [`client/src/pages/${name}.jsx`],
    bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
    loader: { ".css": "empty" }, jsx: "automatic", logLevel: "silent",
    plugins: [{
      name: "sales-project-page-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /^@\/hooks\/useMemberAccess$/ }, () => ({ path: "access", namespace: "fixture" }));
        builder.onResolve({ filter: /^@\/hooks\/useProjectBoardRealtime$/ }, () => ({ path: "realtime", namespace: "fixture" }));
        builder.onResolve({ filter: /^@\/lib\/queryClient$/ }, () => ({ path: "requests", namespace: "fixture" }));
        builder.onResolve({ filter: /^@\/components\/sales\// }, (args) => {
          const child = args.path.split("/").at(-1);
          if (childNames.includes(child)) return { path: child, namespace: "fixture" };
        });
        builder.onResolve({ filter: /^\.\/sales\/Catalogue$/ }, () => ({ path: "Catalogue", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => {
          if (path === "access") return { contents: "export function useMemberAccess() { return globalThis.__salesProjectsFixture.access; }", loader: "js" };
          if (path === "realtime") return { contents: "export function useProjectBoardRealtime() {}", loader: "js" };
          if (path === "requests") return { contents: "export async function apiRequest(...args) { return globalThis.__salesProjectsFixture.request(...args); }", loader: "js" };
          if (path === "SalesReportingWorkspace") return { contents: "export function SalesDashboard() { return null; } export function SalesReports() { return null; }", loader: "js" };
          return {
            contents: `export default function Boundary(props) {
                globalThis.__salesProjectsFixture.children[${JSON.stringify(path)}] = props;
                if (${JSON.stringify(path)} === "ProjectCardDetailModal") return null;
                return globalThis.React.createElement("div", { "data-integration": ${JSON.stringify(path)} });
              }`, loader: "js",
          };
        });
      },
    }],
  });
  const bundled = new Module(`${process.cwd()}/${name}-isolated.cjs`);
  bundled.filename = `${process.cwd()}/${name}-isolated.cjs`;
  bundled.paths = Module._nodeModulePaths(process.cwd());
  bundled._compile(bundle.outputFiles[0].text, bundled.filename);
  return { Page: bundled.exports.default, require: bundled.require.bind(bundled) };
}
const sales = await loadPage("Sales");
const boards = await loadPage("ProjectBoards");
const board = await loadPage("ProjectBoard");
const h = React.createElement;
let active;
function fixture(excluded = []) {
  return globalThis.__salesProjectsFixture = {
    access: {
      roleStatus: "ready", isAccessReady: true,
      isFeatureExcluded: (permission) => excluded.includes(permission),
    },
    children: {}, calls: [],
    request: async (...args) => {
      globalThis.__salesProjectsFixture.calls.push(args);
      return { card: { id: "card-17", ...args[2] } };
    },
  };
}
const boardData = (role = "owner") => ({
  board: { id: "board-7", name: "Partner follow-up", user_role: role, color: "#6366f1" },
  lists: [{ id: "list-3", name: "In progress", position: 0 }],
  cards: [{ id: "card-17", list_id: "list-3", title: "Confirm sponsor brief", position: 0, priority: "medium" }],
  members: [], labels: [],
});
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
async function mount(loaded, path, props = {}, response = boardData()) {
  const { MemoryRouter, Routes, Route } = loaded.require("react-router-dom");
  const { QueryClient, QueryClientProvider } = loaded.require("@tanstack/react-query");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  globalThis.fetch = async () => response instanceof Response ? response.clone() : json(response);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  active = { root, container, queryClient };
  await act(async () => {
    root.render(h(QueryClientProvider, { client: queryClient },
      h(MemoryRouter, { initialEntries: [path] },
        h(Routes, null,
          h(Route, { path: loaded === board ? "/ProjectBoard/:id" : path.split("?")[0], element: h(loaded.Page, props) }),
          h(Route, { path: "/Preferences", element: h("p", null, "Preferences destination") }),
        ),
      ),
    ));
  });
  return container;
}
async function waitFor(predicate) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  assert.fail("Page did not settle into expected state");
}
async function cleanup() {
  if (!active) return;
  await act(async () => active.root.unmount());
  active.queryClient.clear();
  active.container.remove();
  active = null;
}
after(async () => {
  await cleanup();
  globalThis.fetch = originalFetch;
  delete globalThis.__salesProjectsFixture;
  dom.window.close();
});

test("Sales tasks destination mounts the workspace after permission checks", async () => {
  fixture();
  const container = await mount(sales, "/sales/tasks", { destination: "tasks" });
  assert.ok(container.querySelector('[data-integration="SalesTasksWorkspace"]'));
  assert.equal(container.querySelector('[data-integration="OpportunitiesWorkspace"]'), null);
  await cleanup();
});

test("Sales tasks permission denial does not mount the workspace", async () => {
  fixture(["sales.tasks"]);
  const container = await mount(sales, "/sales/tasks", { destination: "tasks" });
  assert.match(container.textContent, /Preferences destination/);
  assert.equal(container.querySelector('[data-integration="SalesTasksWorkspace"]'), null);
  await cleanup();
});

test("Project boards actions mount the permission-aware Sales link without losing controls", async () => {
  fixture();
  const container = await mount(boards, "/ProjectBoards", {}, { boards: [] });
  assert.ok(container.querySelector('[data-integration="ProjectsSalesTasksLink"]'));
  assert.ok(container.querySelector('[data-testid="button-toggle-archived"]'));
  assert.ok(container.querySelector('[data-testid="button-create-board"]'));
  await cleanup();
});

test("Authorized board mounts integrations and only the shared card editor", async () => {
  const state = fixture(["projects.board-view.assign-cards", "projects.board-view.manage-labels"]);
  const container = await mount(board, "/ProjectBoard/board-7?card=card-17");
  await waitFor(() => container.querySelector('[data-testid="text-board-name"]'));
  assert.equal(state.children.ProjectBoardOpportunityPanel.boardId, "board-7");
  assert.equal(state.children.ProjectBoardTaskDeepLink.boardId, "board-7");
  assert.ok(container.querySelector('[data-testid="button-board-settings"]'));
  assert.ok(container.querySelector('[data-testid="button-add-card-list-3"]'));
  await act(async () => container.querySelector('[data-testid="card-card-17"]').click());
  const editor = state.children.ProjectCardDetailModal;
  assert.equal(editor.open, true);
  assert.equal(editor.card.id, "card-17");
  assert.equal(editor.canManage, true);
  assert.equal(editor.canAssign, false);
  assert.equal(editor.canManageLabels, false);
  let resolveUpdate;
  state.request = (...args) => {
    state.calls.push(args);
    return new Promise((resolve) => { resolveUpdate = resolve; });
  };
  let completed = false;
  const pending = editor.onUpdate({ title: "Send sponsor brief" }).then(() => { completed = true; });
  await act(async () => { await Promise.resolve(); });
  assert.equal(completed, false, "editor must await the real mutation");
  assert.deepEqual(state.calls[0], ["PATCH", "/api/projects/cards/card-17", { title: "Send sponsor brief" }]);
  await act(async () => { resolveUpdate({ card: { title: "Send sponsor brief" } }); await pending; });
  assert.equal(completed, true);
  state.request = async () => { throw new Error("Update denied"); };
  await act(async () => { await assert.rejects(state.children.ProjectCardDetailModal.onUpdate({ priority: "high" }), /Update denied/); });
  assert.equal(state.children.ProjectCardDetailModal.open, true);
  await cleanup();
});

test("Viewer retains read-only editor capabilities", async () => {
  const state = fixture();
  const container = await mount(board, "/ProjectBoard/board-7", {}, boardData("viewer"));
  await waitFor(() => container.querySelector('[data-testid="card-card-17"]'));
  await act(async () => container.querySelector('[data-testid="card-card-17"]').click());
  const editor = state.children.ProjectCardDetailModal;
  for (const permission of ["canEdit", "canManage", "canAssign", "canManageLabels"]) assert.equal(editor[permission], false);
  assert.equal(container.querySelector('[data-testid="button-add-card-list-3"]'), null);
  await cleanup();
});

test("Unauthorized board error never mounts Sales integration children", async () => {
  const state = fixture();
  const container = await mount(board, "/ProjectBoard/board-7?card=card-17", {}, json({}, 403));
  await waitFor(() => container.textContent.includes("Not authorized"));
  assert.equal(state.children.ProjectBoardOpportunityPanel, undefined);
  assert.equal(state.children.ProjectBoardTaskDeepLink, undefined);
  assert.equal(state.children.ProjectCardDetailModal, undefined);
  await cleanup();
});

test("Page imports one shared editor with no independent local editor or label palette", async () => {
  const source = await readFile(new URL("./ProjectBoard.jsx", import.meta.url), "utf8");
  assert.match(source, /import CardDetailModal from "@\/components\/sales\/ProjectCardDetailModal"/);
  assert.doesNotMatch(source, /function CardDetailModal|const LABEL_COLORS/);
});

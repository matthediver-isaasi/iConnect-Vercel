import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "MouseEvent", "getComputedStyle", "DocumentFragment", "HTMLInputElement", "KeyboardEvent", "PointerEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const { MemoryRouter } = createRequire(import.meta.url)("react-router-dom");

async function load(entry, name) {
  const built = await build({
    entryPoints: [entry], bundle: true, write: false, loader: { ".css": "empty" }, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
    alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
    plugins: [{
      name: "isolated-hooks",
      setup(build) {
        // Isolate the panel from the board editor and task-list workspaces.
        const fixtures = {
          naming: 'export const useQuoteNaming = () => ({ singular: "Quote", plural: "Quotes", slug: "quotes" });',
          board: 'export const useSalesProjectBoard = () => ({ data: { lists: [] }, canCreate: true, canCreateLists: true, isLoading: false, dataUpdatedAt: 0 });',
          results: 'export const SalesTaskResults = () => null;',
        };
        build.onResolve({ filter: /^@\/hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
        build.onResolve({ filter: /^\.\/SalesProjectCardEditor$/ }, () => ({ path: "board", namespace: "fixture" }));
        build.onResolve({ filter: /^\.\/SalesTasksWorkspace$/ }, () => ({ path: "results", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: fixtures[args.path], loader: "js" }));
      },
    }],
  });
  const mod = new Module(`${process.cwd()}/${name}.cjs`);
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(built.outputFiles[0].text, `${process.cwd()}/${name}.cjs`);
  return mod.exports;
}
const choiceModule = await load("client/src/components/sales/OpportunityTaskChoice.jsx", "task-choice-fixture");
const panelModule = await load("client/src/components/sales/OpportunityProjectTasksPanel.jsx", "task-panel-fixture");
after(() => dom.window.close());

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
async function mount(element, responses) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const params = new URL(String(url), "https://isolated.example.test").searchParams;
    const body = responses(params, options);
    return { ok: true, status: 200, json: async () => body };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(QueryClientProvider, { client }, element)));
    await pause();
  });
  await act(async () => { await pause(); });
  return { host, calls, async cleanup() { await act(async () => root.unmount()); client.clear(); host.remove(); globalThis.fetch = originalFetch; } };
}

function ChoiceHarness({ onState }) {
  const [choice, setChoice] = React.useState(choiceModule.DEFAULT_TASK_CHOICE);
  const [board, setBoard] = React.useState(null);
  const options = choiceModule.useOpportunityTaskOptions(true);
  onState({ choice, board, ready: choiceModule.taskChoiceReady(choice, board, options) });
  return React.createElement(choiceModule.default, { open: true, choice, onChoice: setChoice, board, onBoard: setBoard, options });
}
const radio = (host, value) => host.querySelector(`#opp-task-${value}`);

test("task choice defaults to standard tasks and disables options the user lacks permission for", async () => {
  let state;
  const view = await mount(React.createElement(ChoiceHarness, { onState: (s) => { state = s; } }),
    (params) => params.get("view") === "create-options" ? { canLinkBoard: true, canCreateBoard: false } : { items: [], total: 0 });
  try {
    assert.equal(state.choice, "standard");
    assert.equal(state.ready, true);
    assert.match(view.host.textContent, /fixed once the opportunity is created/);
    assert.equal(radio(view.host, "create").disabled, true);
    assert.match(view.host.textContent, /need permission to create project boards/);
    assert.equal(radio(view.host, "link").disabled, false);
  } finally { await view.cleanup(); }
});

test("linking requires a picked eligible board before the opportunity can be created", async () => {
  let state;
  const view = await mount(React.createElement(ChoiceHarness, { onState: (s) => { state = s; } }), (params) =>
    params.get("view") === "create-options" ? { canLinkBoard: true, canCreateBoard: true }
      : { items: [{ id: "board-1", name: "Existing board" }], total: 1 });
  try {
    await act(async () => { radio(view.host, "link").click(); await pause(); });
    await act(async () => { await pause(); });
    assert.equal(state.choice, "link");
    assert.equal(state.ready, false);
    const boards = view.calls.filter((call) => call.url.includes("view=boards"));
    assert.ok(boards.length, "board picker loaded");
    assert.equal(boards.some((call) => call.url.includes("opportunityId")), false, "no opportunity is needed");
    const option = view.host.querySelector('input[name="eligible-board"]');
    await act(async () => { option.click(); await pause(); });
    assert.equal(state.board.id, "board-1");
    assert.equal(state.ready, true);
    await act(async () => { radio(view.host, "create").click(); await pause(); });
    assert.equal(state.board, null);
    assert.equal(state.ready, true);
  } finally { await view.cleanup(); }
});

test("without Projects access both board options are disabled", async () => {
  const view = await mount(React.createElement(ChoiceHarness, { onState: () => {} }),
    () => ({ canLinkBoard: false, canCreateBoard: false }));
  try {
    assert.equal(radio(view.host, "create").disabled, true);
    assert.equal(radio(view.host, "link").disabled, true);
    assert.match(view.host.textContent, /need access to Projects to link a board/);
  } finally { await view.cleanup(); }
});

const metadata = (overrides) => ({ taskMode: "project", expectedVersion: 2, board: { id: "board-1", name: "Deal board", is_archived: false },
  boardUnavailable: false, needsBoard: false, permissions: { canManage: true, canCreateBoard: true, canViewBoard: true },
  summary: { total: 0 }, ...overrides });
function panelResponses(meta) {
  return (params) => params.get("view") === "tasks" ? { items: [], total: 0, summary: {} }
    : params.get("view") === "automation" ? { taskMode: meta.taskMode, boardId: meta.board?.id || null, requests: [], total: 0, canManage: true }
      : params.get("view") ? { items: [], total: 0 } : meta;
}
const buttons = (host) => [...host.querySelectorAll("button")].map((b) => b.textContent);

test("Tasks tab shows the fixed choice read-only with no mode, create, link or unlink controls", async () => {
  for (const meta of [metadata(), metadata({ taskMode: "standard", board: null })]) {
    const view = await mount(React.createElement(panelModule.default, { opportunityId: "opp", standardTasks: React.createElement("p", null, "STANDARD LIST") }), panelResponses(meta));
    try {
      assert.match(view.host.textContent, /cannot be changed/);
      assert.equal(view.host.querySelector('[aria-label="Task mode"]'), null);
      for (const label of ["Create project board", "Link existing board", "Unlink"]) {
        assert.equal(buttons(view.host).some((text) => text.includes(label)), false, label);
      }
      if (meta.taskMode === "project") {
        assert.match(view.host.textContent, /Deal board/);
        assert.ok(view.host.querySelector('a[href="/ProjectBoard/board-1"]'), "Open board link");
        assert.doesNotMatch(view.host.textContent, /STANDARD LIST/);
      } else {
        assert.match(view.host.textContent, /STANDARD LIST/);
      }
      assert.equal(view.calls.some((call) => call.options.method === "POST"), false);
    } finally { await view.cleanup(); }
  }
});

test("legacy project-mode opportunity without a board can still create or link one", async () => {
  const view = await mount(React.createElement(panelModule.default, { opportunityId: "opp", standardTasks: null }),
    panelResponses(metadata({ board: null, needsBoard: true })));
  try {
    assert.ok(buttons(view.host).some((text) => text.includes("Create project board")));
    assert.ok(buttons(view.host).some((text) => text.includes("Link existing board")));
    assert.equal(buttons(view.host).some((text) => text.includes("Unlink")), false);
  } finally { await view.cleanup(); }
});

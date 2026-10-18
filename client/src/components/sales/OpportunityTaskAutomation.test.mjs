import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "MouseEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const built = await build({
  entryPoints: ["client/src/components/sales/OpportunityTaskAutomation.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{
    name: "isolated-naming",
    setup(build) {
      build.onResolve({ filter: /^@\/hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'export const useQuoteNaming = () => globalThis.automationNaming || { singular: "Quote", plural: "Quotes", slug: "quotes" };',
        loader: "js",
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/automation-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(built.outputFiles[0].text, mod.filename || `${process.cwd()}/automation-fixture.cjs`);
const Automation = mod.exports.default;
after(() => dom.window.close());

const base = {
  taskMode: "standard", boardId: "board", canManage: true, canConfigureBoard: true,
  lists: [{ id: "delivery", name: "Delivery" }], configuration: null,
  requests: [
    { id: "first", title: "Workshop delivery", quantity: 7, task_mode: "project", status: "pending", last_error: "Choose a list" },
    { id: "second", title: "Training materials", quantity: 3, task_mode: "standard", status: "completed" },
  ], total: 2,
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
async function mounted(data, run, { getError, postError, seed = true, waitForGet = false } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (waitForGet && options.method !== "POST") await new Promise(() => {});
    const error = options.method === "POST" ? postError : getError;
    return { ok: !error, status: error ? 403 : 200, json: async () => error ? { message: error } : data };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  for (const key of [["opportunity", "opportunity"], ["sales-project-tasks", { view: "tasks", source: "standard" }], ["project-board", "board"]]) client.setQueryData(key, {});
  if (seed) client.setQueryData(["sales-project-tasks", { view: "automation", opportunityId: "opportunity" }], data);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Automation, { opportunityId: "opportunity" }))); await pause(); });
    await act(async () => { await pause(); });
    await run(host, calls, client);
  } finally {
    await act(async () => root.unmount());
    client.clear(); host.remove(); globalThis.fetch = originalFetch;
  }
}
const button = (host, text) => [...host.querySelectorAll("button")].find((item) => item.textContent === text);
const click = async (element) => act(async () => { element.click(); await pause(); });

test("standard mode shows automation, captured modes and quantities, without mutations on load", async () => {
  await mounted(base, async (host, calls) => {
    assert.match(host.textContent, /Standard tasks need no board configuration/);
    assert.match(host.textContent, /Quantity: 7 · Project mode at acceptance/);
    assert.match(host.textContent, /Quantity: 3 · Standard mode at acceptance/);
    assert.match(host.textContent, /Choose a list/);
    assert.match(host.textContent, /no past quote backfill/);
    assert.equal(host.querySelector("select"), null);
    assert.equal(calls.some((call) => call.options.method === "POST"), false);
    assert.match(calls[0].url, /view=automation&opportunityId=opportunity/);
  });
});

test("retry uses version-free commands and invalidates existing task views", async () => {
  await mounted(base, async (host, calls, client) => {
    await click(button(host, "Retry pending tasks"));
    const post = calls.find((call) => call.options.method === "POST");
    assert.deepEqual(JSON.parse(post.options.body), { opportunityId: "opportunity", action: "automation-retry" });
    assert.equal(post.options.credentials, "include");
    for (const key of [["opportunity", "opportunity"], ["sales-project-tasks", { view: "tasks", source: "standard" }], ["project-board", "board"]]) assert.equal(client.getQueryState(key).isInvalidated, true);
    await click(button(host, "Retry pending tasks"));
    assert.deepEqual(JSON.parse(calls.filter((call) => call.options.method === "POST").at(-1).options.body), { opportunityId: "opportunity", action: "automation-retry" });
  });
});

test("automatic lists use the tenant setting, not the old manual selector", async () => {
  await mounted({ ...base, taskMode: "project", quoteTaskListName: "Fulfilment", configuration: { board_id: "board", list_id: "delivery" } }, async (host) => {
    assert.match(host.textContent, /Fulfilment/);
    assert.match(host.textContent, /created automatically/);
    assert.equal(host.querySelector("select"), null);
  });
});

test("retry uses opportunity management permission, not board configuration permission", async () => {
  await mounted({ ...base, canConfigureBoard: false }, async (host) => {
    assert.equal(host.querySelector("select"), null);
    assert.equal(button(host, "Retry pending tasks").disabled, false);
  });
  await mounted({ ...base, canManage: false }, async (host, calls) => {
    assert.equal(button(host, "Retry pending tasks").disabled, true);
    assert.equal(calls.some((call) => call.options.method === "POST"), false);
  });
});

test("project mode clearly reports missing board/list and unavailable saved list", async () => {
  for (const [data, message] of [
    [{ ...base, taskMode: "project", boardId: null, canConfigureBoard: false }, /No project board linked/],
    [{ ...base, taskMode: "project" }, /Quote tasks/],
    [{ ...base, taskMode: "project", configuration: { board_id: "board", list_id: "removed" } }, /created automatically/],
  ]) await mounted(data, async (host) => assert.match(host.textContent, message));
});

test("empty requests compose an empty state and disable retry", async () => {
  await mounted({ ...base, requests: [], total: 0 }, async (host) => {
    assert.match(host.textContent, /No acceptance requests yet/);
    assert.equal(button(host, "Retry pending tasks").disabled, true);
  });
});

test("tenant terminology updates internal prose but preserves authored task list names", async () => {
  globalThis.automationNaming = { singular: "Proposal", plural: "Proposals", slug: "proposals" };
  try {
    await mounted({ ...base, quoteTaskListName: "Quote delivery" }, async host => {
      assert.match(host.textContent, /Accepted proposal task automation/);
      assert.match(host.textContent, /product proposal line/);
      assert.match(host.textContent, /issued proposal/);
      assert.match(host.textContent, /past proposals/);
      assert.match(host.textContent, /Cards are added to “Quote delivery”/);
      assert.match(host.textContent, /does not send emails or perform financial actions/);
    });
    await mounted({ ...base, requests: [], total: 0 }, async host => {
      assert.match(host.textContent, /future issued proposals/);
      assert.match(host.textContent, /qualifying proposal is accepted/);
      assert.match(host.textContent, /Cards are added to “Quote tasks”/);
    });
  } finally {
    delete globalThis.automationNaming;
  }
});

test("mutation failures remain visible without losing existing requests", async () => {
  await mounted(base, async (host) => {
    await click(button(host, "Retry pending tasks"));
    assert.match(host.querySelector('[role="alert"]').textContent, /Board permission changed/);
    assert.match(host.textContent, /Workshop delivery/);
  }, { postError: "Board permission changed" });
});

test("query failure shows an accessible error and a working retry", async () => {
  await mounted(base, async (host, calls) => {
    assert.match(host.querySelector('[role="alert"]').textContent, /Unable to load automation/);
    const before = calls.length;
    await click(host.querySelector("button"));
    assert.ok(calls.length > before);
    assert.equal(calls.some((call) => call.options.method === "POST"), false);
  }, { seed: false, getError: "Unable to load automation" });
});

test("unresolved query shows skeletons without exposing mutation controls", async () => {
  await mounted(base, async (host, calls) => {
    assert.ok(host.querySelector(".animate-pulse"));
    assert.equal(host.querySelector("button"), null);
    assert.equal(calls.some((call) => call.options.method === "POST"), false);
  }, { seed: false, waitForGet: true });
});

import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://fixture.invalid" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, DocumentFragment: dom.window.DocumentFragment, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
const bundle = await build({
  entryPoints: ["client/src/components/sales/ProjectBoardOpportunityPanel.jsx"], bundle: true, write: false,
  format: "cjs", platform: "node", packages: "external", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{ name: "controlled-metadata", setup(b) {
    b.onResolve({ filter: /\/useMemberAccess$/ }, () => ({ path: "access", namespace: "fixture" }));
    b.onResolve({ filter: /\/useSalesProjectTasks$/ }, () => ({ path: "data", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents: path === "access"
      ? "export const useMemberAccess = () => ({isAccessReady: true, isFeatureExcluded: () => globalThis.__denied});"
      : "export const useSalesProjectTasks = () => ({data: globalThis.__boardMetadata}); export const projectTaskRequest = () => { throw new Error('Unexpected mutation'); }; export const refreshSalesProjects = () => {};" }));
  } }],
});
const mod = new Module(`${process.cwd()}/board-opportunity-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, `${process.cwd()}/board-opportunity-test.cjs`);
const React = mod.require("react");
globalThis.React = React;
const { act } = React;
const { createRoot } = mod.require("react-dom/client");
const { MemoryRouter, useLocation } = mod.require("react-router-dom");
const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
test("header link navigates to its linked opportunity and keeps status and access distinct", async () => {
  const client = new QueryClient();
  const root = createRoot(document.getElementById("root"));
  function Location() { return React.createElement("output", null, useLocation().pathname); }
  const render = () => act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(MemoryRouter, { initialEntries: ["/ProjectBoard/board"] },
      React.createElement(mod.exports.default, { boardId: "board" }), React.createElement(Location)))));
  try {
    for (const [stage, status] of [[{}, "Open"], [{ is_won: true }, "Won"], [{ is_lost: true }, "Lost"]]) {
      globalThis.__boardMetadata = { opportunity: { id: "opportunity-linked", name: "Example opportunity", stage }, stages: [] };
      await render();
      const link = [...document.querySelectorAll("a")].find(a => a.textContent === "Open opportunity");
      assert.equal(link.getAttribute("href"), "/sales/opportunities/opportunity-linked");
      assert.ok(document.body.textContent.includes(`Status: ${status}`));
      await act(async () => link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
      assert.equal(document.querySelector("output").textContent, "/sales/opportunities/opportunity-linked");
    }
    globalThis.__denied = true;
    await render();
    assert.equal(document.querySelector("a"), null);
  } finally { await act(async () => root.unmount()); client.clear(); dom.window.close(); }
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const calls = [];
globalThis.__popupAuthoringRequest = async (query) => { calls.push(query); return query.includes("id=") ? { popup: { id: "popup-a", design: {} } } : { popups: [{ id: "popup-a", name: "Notice", config: {} }] }; };
const bundle = await build({
  stdin: { contents: `import {useCmsPopups} from '@/hooks/useCmsPopups'; export default function Harness(props) { useCmsPopups(props.id, true, props.editor); return null; }`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
  plugins: [{
    name: "isolated-authoring-api",
    setup(builder) {
      builder.onResolve({ filter: /^@\/(api\/base44Client|lib\/cmsPopups)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path.includes("base44Client") ? "export const getActiveTenantId = () => 'tenant-fixture';" : "export const popupRequest = (...args) => globalThis.__popupAuthoringRequest(...args);",
        loader: "js",
      }));
    },
  }],
});
const module = new Module(`${process.cwd()}/popup-authoring-isolated.cjs`);
module.filename = `${process.cwd()}/popup-authoring-isolated.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(bundle.outputFiles[0].text, module.filename);
const { QueryClient, QueryClientProvider } = module.require("@tanstack/react-query");
after(() => { dom.window.close(); delete globalThis.__popupAuthoringRequest; });
test("management can list configuration but an id/design read requires an explicit editor-capability opt-in", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById("root"));
  const render = async (id, editor) => React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(module.exports.default, { id, editor })));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  try {
    await render("popup-a", false);
    assert.deepEqual(calls, [], "management-only callers must not fetch any design");
    await render(null, false);
    assert.deepEqual(calls, [""], "management list uses the configuration-only endpoint");
    await render("popup-a", true);
    assert.deepEqual(calls, ["", "id=popup-a&preview=1"], "design reads use the server-verified editor preview endpoint");
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
  }
});

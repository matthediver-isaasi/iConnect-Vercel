import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "navigator"]) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const bundle = await build({
  stdin: {
    contents: `export * from "./client/src/hooks/useSubmissionForwards.js";
      export {requests} from "@/lib/adminFetch";`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  plugins: [{
    name: "mock-scoped-transport",
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: "transport", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: `export const requests = [];
          export async function adminFetch(url, options, tenantId) {
            requests.push({url,tenantId,signal:options.signal});
            const params = new URL(url,"https://admin.example.test").searchParams;
            return {ok:true,json:async()=>params.has("submission_ids")
              ? {forwards:[{id:"forward-1",submission_id:"submission-1",recipient_name:"Priya Shah",status:"sent"}]}
              : {forwards:[],can_forward:true}};
          }`,
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/submission-forward-hooks-test.cjs`);
mod.filename = `${process.cwd()}/submission-forward-hooks-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { requests, useSubmissionForwardListHistory, useSubmissionForwardHistory } = mod.exports;
after(() => dom.window.close());

test("100 visible rows use one bulk request; only an opened dialog fetches single history and can_forward", async () => {
  const submissions = Array.from({ length: 100 }, (_, index) => ({ id: `submission-${index}` }));
  const scope = { tenantId: "tenant-a", scopeKey: "tenant-a-session", status: "ready", assertCurrent() {} };
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let list;
  let permission;
  function Row({ id, opened }) {
    const single = useSubmissionForwardHistory(scope, id, opened);
    if (opened) permission = single.data?.can_forward;
    return null;
  }
  function Report({ openedId }) {
    list = useSubmissionForwardListHistory(scope, submissions);
    return submissions.map(submission => React.createElement(Row, {
      key: submission.id, id: submission.id, opened: openedId === submission.id,
    }));
  }
  const draw = async openedId => {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(Report, { openedId }))));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  };
  try {
    await draw(null);
    assert.equal(requests.length, 1, "closed rows must not fetch individual histories");
    const batch = new URL(requests[0].url, "https://example.test").searchParams;
    assert.equal(batch.get("submission_ids").split(",").length, 100);
    assert.equal(batch.has("submission_id"), false);
    assert.equal(requests[0].tenantId, "tenant-a");
    assert.equal(list.data["submission-1"][0].recipient_name, "Priya Shah");
    assert.equal(list.data["submission-2"], undefined);
    await draw("submission-1");
    assert.equal(requests.length, 2);
    const single = new URL(requests[1].url, "https://example.test").searchParams;
    assert.equal(single.get("submission_id"), "submission-1");
    assert.equal(permission, true);
    await draw(null);
    assert.equal(requests.length, 2, "closing never fetches remaining rows");
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";

test("real popup transport records timing headers and failures without retaining response content", async () => {
  const bundle = await build({
    entryPoints: ["client/src/lib/cmsPopups.js"], bundle: true, write: false,
    packages: "external", platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "transport-boundaries", setup(b) {
      b.onResolve({ filter: /^@\/(lib\/adminFetch|api\/publicClient)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path.includes("adminFetch") ? "export const adminFetch = () => { throw Error('Not an admin test'); }"
          : "export const getTenantSlugFromLocation = () => 'private-tenant';",
      }));
    } }],
  });
  const mod = new Module(import.meta.filename);
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(bundle.outputFiles[0].text, import.meta.filename);
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  globalThis.window = { location: { search: "" } };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ viewer_key: "private-member", design: "private-design" }), {
      status: 200, headers: { "Server-Timing": "page;dur=2.50, total;dur=10.25" },
    });
    await mod.exports.popupRequest("page_id=private-id&id=private-popup", { publicRequest: true });
    let trace = JSON.parse(window.iconnectPopupDiagnostics());
    assert.equal(trace.at(-1).kind, "selected_content");
    assert.equal(trace.at(-1).status, 200);
    assert.equal(trace.at(-1).serverMs.total, 10.25);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "private-server-error" }), { status: 503 });
    await assert.rejects(mod.exports.popupRequest("page_id=x", { publicRequest: true }));
    globalThis.fetch = async () => { throw new Error("private-network-error"); };
    await assert.rejects(mod.exports.popupRequest("", { publicRequest: true, method: "POST" }));
    trace = window.iconnectPopupDiagnostics();
    assert.match(trace, /request_failed/);
    assert.match(trace, /503/);
    assert.doesNotMatch(trace, /private-|design|viewer_key/);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});

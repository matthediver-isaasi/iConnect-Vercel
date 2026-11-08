import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import Module from "node:module";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "NodeFilter"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/membership/ExtendMemberDateTerm.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "extension-test-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/adminFetch$|^sonner$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "sonner"
          ? "export const toast = { success: message => globalThis.extensionSuccess = message };"
          : "export const adminFetch = (...args) => globalThis.extensionFetch(...args);",
        loader: "js",
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/extension-test.cjs`);
compiled.filename = `${process.cwd()}/extension-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { default: Component, extensionError } = compiled.exports;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const record = { id: "history-date", term_start_date: "2026-01-01", term_end_date: "2026-06-14", term_source_snapshot: { type: "member_date_field", end_date: "2026-06-14" } };
after(() => { dom.window.close(); delete globalThis.extensionFetch; delete globalThis.extensionSuccess; });

async function mounted(props, run) {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidations = [];
  client.invalidateQueries = async options => { invalidations.push(options.queryKey); };
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(Component, { record, memberId: "member-1", tenantId: "tenant-1", canAdmin: true, ...props }))));
    await run(node, invalidations);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    node.remove();
  }
}
async function open(node) {
  await act(async () => node.querySelector("button").click());
}
async function fill(newEnd, reason) {
  await act(async () => {
    for (const [selector, value, prototype] of [
      ["input[type=date]", newEnd, window.HTMLInputElement.prototype],
      ["textarea", reason, window.HTMLTextAreaElement.prototype],
    ]) {
      const input = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
  });
}
async function submit() {
  await act(async () => {
    document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

test("only administrators with evidenced member-date terms see the action", async () => {
  for (const props of [{ canAdmin: false }, { record: { ...record, term_source_snapshot: null } }, { record: { ...record, term_source_snapshot: { type: "standard" } } }]) {
    await mounted(props, async node => assert.equal(node.querySelector("button"), null));
  }
  await mounted({}, async node => assert.equal(node.querySelector("button").textContent, "Extend membership"));
});

test("date and mandatory reason validation rejects equal, earlier and invalid dates", () => {
  for (const date of ["2026-06-14", "2026-06-13", "2026-02-30", "invalid", ""]) {
    assert.match(extensionError(record, date, "Course extended"), /later than/);
  }
  assert.match(extensionError(record, "2026-07-01", "   "), /administrator reason/);
  assert.match(extensionError({ ...record, term_end_date: null }, "2026-07-01", "Reason"), /existing membership term dates/);
  assert.equal(extensionError(record, "2026-07-01", "Course extended"), "");
});

test("extension submits exact optimistic-lock evidence and refreshes existing membership queries", async () => {
  const calls = [];
  globalThis.extensionFetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ history_id: record.id, audit_id: "audit-1", term_end_date: "2026-07-01" }), { status: 200 });
  };
  await mounted({}, async (node, invalidations) => {
    await open(node);
    assert.match(document.querySelector('[role="dialog"]').textContent, /original term evidence remains/);
    assert.match(document.querySelector('[role="dialog"]').textContent, /does not automatically extend/);
    assert.ok(document.querySelector('[role="dialog"]').textContent.includes(record.term_start_date));
    assert.ok(document.querySelector('[role="dialog"]').textContent.includes(record.term_end_date));
    await fill("2026-07-01", "  Course extended  ");
    await submit();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/api/membership/member-start");
    assert.equal(calls[0][2], "tenant-1");
    assert.equal(calls[0][1].credentials, "include");
    assert.deepEqual(JSON.parse(calls[0][1].body), {
      action: "extend-date-term", memberId: "member-1", historyId: record.id,
      expectedEnd: "2026-06-14", newEnd: "2026-07-01", reason: "Course extended",
    });
    assert.deepEqual(invalidations, [
      ["member-membership", "member-1"], ["member-start", "tenant-1", "member-1"], ["member-amendments", "tenant-1", "member-1"],
    ]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});

test("server conflict is visible and retains entered dates and reason", async () => {
  globalThis.extensionFetch = async () => new Response(JSON.stringify({ error: "The membership end date changed. Reload before extending." }), { status: 409 });
  await mounted({}, async (node, invalidations) => {
    await open(node);
    await fill("2026-07-01", "Course extended");
    await submit();
    assert.match(document.querySelector('[role="alert"]').textContent, /end date changed/);
    assert.equal(document.querySelector("input[type=date]").value, "2026-07-01");
    assert.equal(document.querySelector("textarea").value, "Course extended");
    assert.deepEqual(invalidations, []);
  });
});

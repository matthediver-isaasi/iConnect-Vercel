import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build, transform } from "esbuild";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { JSDOM } from "jsdom";

const { QueryClient, QueryClientProvider } = Module.createRequire(import.meta.url)("@tanstack/react-query");
const dom = new JSDOM("<html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
after(() => dom.window.close());
const bundle = await build({
  stdin: { contents: 'export {default} from "./client/src/components/surveys/SurveyLifecycleDialog.jsx";', resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
  external: ["react", "react-dom", "@tanstack/react-query"],
  plugins: [{
    name: "lifecycle-test-ui",
    setup(builder) {
      builder.onResolve({ filter: /^@\/(hooks|lib)\// }, args => ({ path: `${process.cwd()}/client/src/${args.path.slice(2)}.js` }));
      builder.onResolve({ filter: /^@\/components\/ui\/|^lucide-react$|^sonner$/ }, args => ({ path: args.path, namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({
        loader: "js",
        contents: args.path === "sonner" ? "export const toast={success(){},error(){}};"
          : args.path === "lucide-react" ? "export const AlertTriangle=()=>null; export const ArrowLeft=()=>null;"
          : `import React from "react";
            export function Button({children,...props}) { return React.createElement("button",props,children); }
            export function Input(props) {return React.createElement("input",props);}
            export function Label(props) {return React.createElement("label",props);}
            export function Checkbox({checked,onCheckedChange,...props}) {return React.createElement("input",{...props,type:"checkbox",checked,onChange:e=>onCheckedChange(e.target.checked)});}
            export function Dialog({children}) {return React.createElement("div",null,children);}
            export function DialogContent({children,onInteractOutside,onEscapeKeyDown,...props}) {return React.createElement("section",props,children);}
            export function DialogHeader({children}) {return React.createElement("header",null,children);}
            export function DialogTitle({children}) {return React.createElement("h2",null,children);}
            export function DialogDescription({children}) {return React.createElement("p",null,children);}
            export function DialogFooter({children}) {return React.createElement("footer",null,children);}`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/survey-lifecycle-dialog-test.cjs`);
compiled.filename = `${process.cwd()}/survey-lifecycle-dialog-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Dialog = compiled.exports.default;
const defaultImpact = {
  form_id: "survey", name: "Post-event feedback", state: "active", action: "pause",
  events: [{ id: "event", title: "Annual meeting", status: "attached" }],
  response_count: 17, invitation_count: 42, assignment_count: 1,
  reversible: true, stops_submissions: true, deletion_allowed: false,
};

async function mounted({ action = "pause", impact = defaultImpact, stale = false, assignmentId, changes } = {}, callback) {
  const request = { form_id: "survey", action, ...(assignmentId ? { assignment_id: assignmentId } : {}), ...(changes ? { changes } : {}) };
  const originalFetch = globalThis.fetch;
  const calls = [];
  let previews = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/surveys/lifecycle");
    assert.equal(options.credentials, "include");
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.operation === "preview") return { ok: true, json: async () => ({ impact: { ...impact, action, ...(assignmentId ? { assignment_id: assignmentId } : {}) }, confirmation_token: `preview-${++previews}` }) };
    if (stale) return { ok: false, status: 409, json: async () => ({ error: "Impact changed", code: "STALE_IMPACT" }) };
    return { ok: true, json: async () => ({ success: true }) };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let closed = false;
  try {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Dialog, { request, onClose: () => { closed = true; } })));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await callback({ container, calls, isClosed: () => closed });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}
const button = (container, text) => [...container.querySelectorAll("button")].find(node => node.textContent === text);
async function click(node) {
  assert.ok(node, "Expected interactive element");
  await act(async () => { node.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
}

test("disruptive action requires review then explicit acknowledgement and sends bound server token", async () => {
  await mounted({}, async ({ container, calls, isClosed }) => {
    assert.match(container.textContent, /Annual meeting/);
    assert.match(container.textContent, /17/);
    assert.match(container.textContent, /42/);
    assert.match(container.textContent, /Unrecorded shared links/);
    assert.equal(calls.length, 1);
    await click(button(container, "Continue to acknowledgement"));
    assert.equal(button(container, "Pause Survey").disabled, true);
    await click(container.querySelector('input[type="checkbox"]'));
    assert.equal(button(container, "Pause Survey").disabled, false);
    await click(button(container, "Pause Survey"));
    assert.deepEqual(calls.at(-1), { operation: "execute", form_id: "survey", action: "pause", confirmation_token: "preview-1", acknowledged: true });
    assert.equal(isClosed(), true);
  });
});

test("dependency-blocked deletion cannot continue and never executes", async () => {
  await mounted({ action: "delete" }, async ({ container, calls }) => {
    assert.match(container.textContent, /Permanent deletion is blocked/);
    assert.equal(button(container, "Continue to acknowledgement").disabled, true);
    assert.equal(calls.length, 1);
  });
});

test("permanent deletion requires both acknowledgement and exact DELETE phrase", async () => {
  await mounted({ action: "delete", impact: { ...defaultImpact, deletion_allowed: true, reversible: false, stops_submissions: false } }, async ({ container, calls }) => {
    await click(button(container, "Continue to acknowledgement"));
    await click(container.querySelector('input[type="checkbox"]'));
    assert.equal(button(container, "Permanently Delete Survey").disabled, true);
    const input = container.querySelector("#survey-delete-confirmation");
    await act(async () => { Simulate.change(input, { target: { value: "delete" } }); });
    assert.equal(button(container, "Permanently Delete Survey").disabled, true);
    await act(async () => { Simulate.change(input, { target: { value: "DELETE" } }); });
    assert.equal(button(container, "Permanently Delete Survey").disabled, false);
    await click(button(container, "Permanently Delete Survey"));
    assert.equal(calls.at(-1).delete_confirmation, "DELETE");
  });
});

test("stale impact refreshes server preview and resets to stage one without reusing acknowledgement", async () => {
  await mounted({ stale: true }, async ({ container, calls, isClosed }) => {
    await click(button(container, "Continue to acknowledgement"));
    await click(container.querySelector('input[type="checkbox"]'));
    await click(button(container, "Pause Survey"));
    assert.match(container.textContent, /Step 1 of 2/);
    assert.equal(calls.filter(call => call.operation === "execute").length, 1);
    assert.equal(calls.filter(call => call.operation === "preview").length, 2);
    assert.equal(isClosed(), false);
    await click(button(container, "Continue to acknowledgement"));
    assert.equal(container.querySelector('input[type="checkbox"]').checked, false);
  });
});

test("assignment configuration is reviewed explicitly and sent identically in preview and execution", async () => {
  const changes = { opens_at: "2026-10-22T09:30:00.000Z", closes_at: "2026-11-02T17:45:00.000Z", access_mode: "authenticated" };
  await mounted({ action: "update_assignment", assignmentId: "assignment", changes }, async ({ container, calls }) => {
    assert.match(container.textContent, /Update Event Survey Access/);
    const proposed = container.querySelector('[data-testid="assignment-proposed-changes"]');
    assert.ok(proposed);
    assert.match(proposed.textContent, /Members only · sign-in required/);
    assert.match(proposed.textContent, /Dates are shown in your local time/);
    assert.match(proposed.textContent, /Existing tokens are retained/);
    assert.match(proposed.textContent, /2026/);
    assert.deepEqual(calls[0].changes, changes);
    await click(button(container, "Continue to acknowledgement"));
    assert.equal(button(container, "Update Event Survey Access").disabled, true);
    await click(container.querySelector('input[type="checkbox"]'));
    await click(button(container, "Update Event Survey Access"));
    assert.deepEqual(calls.at(-1), {
      operation: "execute", form_id: "survey", action: "update_assignment", assignment_id: "assignment",
      changes, confirmation_token: "preview-1", acknowledged: true,
    });
    assert.deepEqual(calls[0].changes, calls.at(-1).changes);
  });
});

test("cleared dates and public access are shown explicitly and survive preview/execute unchanged", async () => {
  const changes = { opens_at: null, closes_at: null, access_mode: "public" };
  await mounted({ action: "update_assignment", assignmentId: "assignment", changes }, async ({ container, calls }) => {
    const proposed = container.querySelector('[data-testid="assignment-proposed-changes"]');
    assert.match(proposed.textContent, /Immediately/);
    assert.match(proposed.textContent, /No close date/);
    assert.match(proposed.textContent, /Public · anyone with the link/);
    await click(button(container, "Continue to acknowledgement"));
    await click(container.querySelector('input[type="checkbox"]'));
    await click(button(container, "Update Event Survey Access"));
    assert.deepEqual(calls[0].changes, changes);
    assert.deepEqual(calls.at(-1).changes, changes);
  });
});

test("all integrated JSX parses and legacy destructive assignment paths are absent", async () => {
  for (const path of [
    "client/src/components/surveys/SurveyLifecycleControls.jsx",
    "client/src/components/surveys/SurveyAvailabilityBadge.jsx",
    "client/src/components/surveys/EventSurveysSection.jsx",
    "client/src/components/surveys/SurveyEventAssignmentsPanel.jsx",
    "client/src/pages/FormBuilder.jsx",
    "client/src/pages/FormManagement.jsx",
    "client/src/pages/FormView.jsx",
  ]) {
    const source = await readFile(path, "utf8");
    await transform(source, { loader: "jsx" });
    if (/EventSurveysSection|SurveyEventAssignmentsPanel/.test(path)) {
      assert.doesNotMatch(source, /method: ["']DELETE["']/);
      assert.doesNotMatch(source, /method: ["']PATCH["']/);
      assert.doesNotMatch(source, /status: ["'](?:active|archived)["']/);
      assert.match(source, /<SurveyLifecycleDialog /);
    }
  }
});

test("both assignment and ordinary FormView routes share state-only unavailable handling", async () => {
  const view = await readFile("client/src/pages/FormView.jsx", "utf8");
  const routes = await readFile("client/src/pages/index.jsx", "utf8");
  assert.match(routes, /<FormView assignmentToken=\{token\}/);
  assert.match(view, /formError\?\.errorData\?\.errorstate/);
  assert.match(view, /assignmentMeta\?\.errorstate/);
  assert.match(view, /publicSurveyUnavailableMessage\(unavailableState\)/);
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import Module from "node:module";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { captureFormEditorBaseline, prepareFormEditorUpdate, formEditorPatch } from "../../lib/formEditorSave.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLSelectElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act, useState } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/forms/DateMembershipSubmissionSettings.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "date-membership-settings-test-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/components\/ui\/|^@\/lib\/adminFetch$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (...args) => globalThis.dateScheduleFetch(...args);"
          : `import React from "react";
            const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
            export const Card = wrap("section"), CardHeader = wrap("header"), CardTitle = wrap("h2"), CardContent = wrap("div");
            export const Label = wrap("label"), Button = wrap("button");
            export const SelectItem = () => null, SelectContent = wrap("div"), SelectTrigger = wrap("div"), SelectValue = () => null;
            export function Select({children, value, disabled, onValueChange}) {
              const options = [];
              const visit = items => React.Children.forEach(items, item => {
                if (!React.isValidElement(item)) return;
                if (item.type === SelectItem) options.push(React.createElement("option", {key:item.props.value, value:item.props.value, disabled:item.props.disabled}, item.props.children));
                else if (item.props.children) visit(item.props.children);
              });
              visit(children);
              return React.createElement("select", {value, disabled, onChange: e => onValueChange(e.target.value)}, options);
            }`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/date-membership-settings-test.cjs`);
compiled.filename = `${process.cwd()}/date-membership-settings-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { default: Settings, dateMembershipUnavailableReason } = compiled.exports;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const id = "5940b277-3080-4290-b572-026d72dc2784";
const tenantContext = { status: "ready", tenantId: "tenant-1", scopeKey: "scope-1", assertCurrent() {} };
after(() => { dom.window.close(); delete globalThis.dateScheduleFetch; });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

async function mounted(form, respond, run) {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls = [];
  globalThis.dateScheduleFetch = async (...args) => { calls.push(args); return respond(...args); };
  let latest;
  function Editor() {
    const [current, setCurrent] = useState(form);
    latest = current;
    return React.createElement(Settings, { form: current, tenantContext, onChange: value => setCurrent(prev => ({ ...prev, date_membership_config_id: value })) });
  }
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Editor))));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    await run(node, calls, () => latest);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    node.remove();
  }
}

test("optional control defaults off and edits only local form draft", async () => {
  await mounted({ fields: [], date_membership_config_id: null }, () => json({ schedules: [{ id, name: "Course delegate term" }] }), async (node, calls, current) => {
    const select = node.querySelector("select");
    assert.equal(select.value, "none");
    await act(async () => { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(current().date_membership_config_id, id);
    await act(async () => { select.value = "none"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(current().date_membership_config_id, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/api/membership/tiers?action=date_term_schedules");
    assert.equal(calls[0][2], "tenant-1");
    assert.ok(!calls[0][1].method || calls[0][1].method === "GET");
    assert.match(node.textContent, /mapped end date after submission processing/);
    assert.match(node.textContent, /only after approval/);
    assert.match(node.textContent, /cannot extend an existing active term/);
  });
});

test("discovery failure is visible, preserves saved ID and supports retry", async () => {
  let failed = true;
  await mounted({ fields: [], date_membership_config_id: id }, () => failed ? json({}, 503) : json({ schedules: [{ id, name: "Course delegate term" }] }), async (node, calls, current) => {
    assert.match(node.querySelector('[role="alert"]').textContent, /could not be loaded/);
    assert.equal(node.querySelector("select").value, id);
    assert.equal(current().date_membership_config_id, id);
    failed = false;
    await act(async () => node.querySelector("button").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(calls.length, 2);
    assert.equal(node.querySelector("select").disabled, false);
    assert.equal(current().date_membership_config_id, id);
  });
});

test("survey and either payment field disable without clearing saved configuration", async () => {
  for (const form of [{ form_type: "survey" }, { fields: [{ type: "payment" }] }, { fields: [{ type: "membership_payment" }] }]) {
    assert.ok(dateMembershipUnavailableReason(form));
    await mounted({ ...form, date_membership_config_id: id }, () => json({ schedules: [{ id, name: "Saved schedule" }] }), async (node, _calls, current) => {
      assert.equal(node.querySelector("select").disabled, true);
      assert.equal(current().date_membership_config_id, id);
      assert.match(node.querySelector('[role="status"]').textContent, /saved selection is kept/);
    });
  }
});

test("empty and unavailable schedule states are visible and non-destructive", async () => {
  await mounted({ fields: [], date_membership_config_id: id }, () => json({ schedules: [] }), async (node, _calls, current) => {
    assert.match(node.textContent, /No active member date-based schedules/);
    assert.match(node.querySelector('[role="alert"]').textContent, /saved schedule is unavailable/);
    assert.equal(current().date_membership_config_id, id);
  });
});

test("actual form save helpers roundtrip explicit choices and avoid stale unrelated writes", () => {
  const persisted = { name: "Course registration", date_membership_config_id: id, fields: [] };
  const editor = { ...persisted, structured_actions: { version: 1, actions: [] } };
  const baseline = captureFormEditorBaseline(persisted, editor);
  const patch = next => formEditorPatch(prepareFormEditorUpdate(next, baseline), baseline);
  assert.equal(Object.hasOwn(patch({ ...editor, name: "Updated title" }), "date_membership_config_id"), false);
  assert.equal(patch({ ...editor, date_membership_config_id: null }).date_membership_config_id, null);
  const old = { name: "Legacy form", fields: [] };
  const hydrated = { ...old, date_membership_config_id: null };
  const legacyBaseline = captureFormEditorBaseline(old, hydrated);
  assert.equal(Object.hasOwn(formEditorPatch(prepareFormEditorUpdate(hydrated, legacyBaseline), legacyBaseline), "date_membership_config_id"), false);
  assert.equal(formEditorPatch(prepareFormEditorUpdate({ ...hydrated, date_membership_config_id: id }, legacyBaseline), legacyBaseline).date_membership_config_id, id);
});

test("FormBuilder hydrates property and uses existing form save pipeline", () => {
  const source = readFileSync(new URL("../../pages/FormBuilder.jsx", import.meta.url), "utf8");
  assert.match(source, /date_membership_config_id: existingForm.date_membership_config_id \?\? null/);
  assert.match(source, /date_membership_config_id: null/);
  assert.match(source, /onChange=\{value => setFormData\(current => \(\{ \.\.\.current, date_membership_config_id: value \}\)\)\}/);
  assert.match(source, /prepareFormEditorUpdate\(formData, editorBaseline.current\)/);
});

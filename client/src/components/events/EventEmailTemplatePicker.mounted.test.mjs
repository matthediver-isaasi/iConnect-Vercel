import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Real editor, picker, cmdk and Radix controls. Only unrelated editors and
// preview integrations are stubbed; no server, database or credentials needed.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from "react";
      import Editor from "@/components/events/EventEmailSettingsEditor";
      export {default as Picker} from "@/components/events/EventEmailTemplatePicker";
      export function EditorFixture({initial, templates, onRowEdited}) {
        const [emails, setEmails] = useState(initial);
        return <><Editor emails={emails} setEmails={setEmails} emailTemplates={templates} onRowEdited={onRowEdited}/>
          <output data-testid="rows">{JSON.stringify(emails)}</output></>;
      }`,
    resolveDir: process.cwd(), loader: "jsx",
  },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "template-picker-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^(sonner|react-quill.*|@\/components\/CampaignEventSurveySettings|@\/components\/events\/TimezoneAwareDateTimeInput)$|^\.\/EmailPreviewAttendees$/ },
        args => ({ path: args.path, namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
        contents: path === "sonner" ? "export const toast = {success() {}};"
          : path.endsWith("TimezoneAwareDateTimeInput") ? "export const TimezoneAwareDateTimeInput = () => null;"
          : "export default () => null;",
      }));
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`, `${base}.tsx`, `${base}.ts`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/email-template-picker-fixture.cjs`);
compiled.filename = `${process.cwd()}/email-template-picker-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { Picker, EditorFixture } = compiled.exports;

const templates = Object.freeze([
  { id: "id-alpha-but-zulu", name: "Zulu reminder", subject: "Alpha in subject only", body: "Zulu body" },
  { id: "id-zulu-but-alpha", name: "alpha confirmation", subject: "Confirmed", body: "Confirmation body" },
  { id: "middle", name: "Bravo follow-up", subject: "Thanks", body: "Follow-up body" },
]);
const byId = id => document.querySelector(`[data-testid="${id}"]`);
const options = () => [...document.querySelectorAll('[role="option"]')];
const names = () => options().map(option => option.textContent);
const click = async element => {
  assert.ok(element);
  await act(async () => element.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
};
const search = () => document.querySelector('input[role="combobox"]');
async function type(value) {
  assert.ok(search());
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(search(), value);
    search().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function key(element, value) {
  await act(async () => element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
async function mount(Component, props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async next => act(async () => root.render(React.createElement(Component, next)));
  await render(props);
  return { render, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const pickerProps = { emailId: "row", templates, onSelect: () => assert.fail("Unexpected selection") };

test("alphabetizes names without mutating the supplied templates and filters names case-insensitively as typed", async () => {
  const fixture = await mount(Picker, pickerProps);
  try {
    await click(byId("select-template-row"));
    assert.equal(document.activeElement, search());
    assert.deepEqual(names(), ["alpha confirmation", "Bravo follow-up", "Zulu reminder"]);
    assert.deepEqual(templates.map(template => template.id), ["id-alpha-but-zulu", "id-zulu-but-alpha", "middle"]);
    await type("A");
    assert.deepEqual(names(), ["alpha confirmation", "Bravo follow-up"]);
    await type("aLpHa");
    assert.deepEqual(names(), ["alpha confirmation"]);
    await type("FOLLOW");
    assert.deepEqual(names(), ["Bravo follow-up"]);
    await type("");
    assert.deepEqual(names(), ["alpha confirmation", "Bravo follow-up", "Zulu reminder"]);
  } finally { await fixture.cleanup(); }
});

test("empty results are explicit and recover when search is cleared; IDs and subjects are not searchable", async () => {
  const fixture = await mount(Picker, pickerProps);
  try {
    await click(byId("select-template-row"));
    for (const query of ["does not exist", "id-alpha-but-zulu", "Alpha in subject only"]) {
      await type(query);
      assert.deepEqual(names(), []);
      assert.match(document.body.textContent, /No templates found\./);
    }
    await type("");
    assert.equal(options().length, 3);
  } finally { await fixture.cleanup(); }
});

test("selection preserves original ID type, shows selected name, closes and resets search", async () => {
  const calls = [];
  const props = { ...pickerProps, templates: [{ id: 42, name: "Numeric ID" }, { id: "other", name: "Other" }], onSelect: id => calls.push(id) };
  const fixture = await mount(Picker, props);
  try {
    await click(byId("select-template-row"));
    await type("numeric");
    await click(options()[0]);
    assert.deepEqual(calls, [42]);
    assert.equal(search(), null);
    await fixture.render({ ...props, value: 42 });
    assert.equal(byId("select-template-row").textContent, "Numeric ID");
    await click(byId("select-template-row"));
    assert.equal(search().value, "");
    assert.equal(options().length, 2);
    await key(search(), "Escape");
    assert.equal(search(), null);
    assert.equal(document.activeElement, byId("select-template-row"));
    assert.deepEqual(calls, [42]);
  } finally { await fixture.cleanup(); }
});

test("keyboard arrows and Enter select the correct ID even for duplicate names", async () => {
  const calls = [];
  const fixture = await mount(Picker, { ...pickerProps, templates: [
    { id: "first", name: "Same name" }, { id: "second", name: "Same name" },
  ], onSelect: id => calls.push(id) });
  try {
    await click(byId("select-template-row"));
    await key(search(), "ArrowDown");
    await key(search(), "Enter");
    assert.deepEqual(calls, ["second"]);
    assert.equal(search(), null);
  } finally { await fixture.cleanup(); }
});

test("real editor loads content and metadata only into the chosen confirmation, reminder or follow-up row", async () => {
  const edits = [];
  const initial = ["booking_confirmation", "reminder", "follow_up"].map((email_type, index) => ({
    id: `row-${index}`, email_type, subject: "Original subject", body: "Original body",
    is_enabled: true, timing_type: "1_day_before", cc: "team@example.test",
  }));
  const fixture = await mount(EditorFixture, { initial, templates, onRowEdited: id => edits.push(id) });
  const rows = () => JSON.parse(byId("rows").textContent);
  try {
    for (let index = 0; index < initial.length; index++) {
      const before = rows();
      await click(byId(`select-template-row-${index}`));
      assert.equal(search().value, "");
      await type("bRaVo");
      await click(options()[0]);
      const after = rows();
      assert.deepEqual(after[index], {
        ...initial[index], subject: "Thanks", body: "Follow-up body",
        loaded_template_id: "middle", loaded_template_name: "Bravo follow-up",
      });
      before.forEach((row, other) => { if (other !== index) assert.deepEqual(after[other], row); });
      assert.equal(byId(`select-template-row-${index}`).textContent, "Bravo follow-up");
    }
    assert.deepEqual(edits, initial.map(row => row.id));
    assert.equal(document.querySelectorAll("output").length, 1);
  } finally { await fixture.cleanup(); }
});

test("empty supplied eligibility list keeps the editor's template picker hidden", async () => {
  const fixture = await mount(EditorFixture, { initial: [{ id: "row", email_type: "booking_confirmation", subject: "", body: "" }], templates: [] });
  try { assert.equal(byId("select-template-row"), null); }
  finally { await fixture.cleanup(); }
});

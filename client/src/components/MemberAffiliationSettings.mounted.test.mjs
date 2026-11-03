import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { affiliationFixture } from "./memberAffiliationSettings.fixtures.js";
import { EMPTY_CONFIG } from "./memberAffiliationSettingsModel.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = Module.createRequire(import.meta.url);
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");
after(() => dom.window.close());
const bundle = await build({
  entryPoints: ["client/src/components/MemberAffiliationSettings.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{ name: "local-alias", setup(builder) {
    builder.onResolve({ filter: /^@\// }, args => {
      const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
      return { path: [base, `${base}.jsx`, `${base}.js`, `${base}.tsx`, `${base}.ts`].find(existsSync) };
    });
  } }],
});
const compiled = new Module(`${process.cwd()}/affiliation-settings-fixture.cjs`);
compiled.filename = `${process.cwd()}/affiliation-settings-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Settings = compiled.exports.default;
const select = key => document.getElementById(`affiliation-${key}`);
const button = text => [...document.querySelectorAll("button")].find(el => el.textContent === text);
async function click(element) { assert.ok(element); await act(async () => element.click()); }
async function change(element, value, event = "change") {
  assert.ok(element);
  await act(async () => {
    const proto = element.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : dom.window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
  });
}
async function mount(initial) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const calls = [];
  let saved = structuredClone(initial);
  let failure = null;
  // In-memory transport only. Never make requests to an application or DB.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/member-affiliation-settings");
    assert.equal(options.credentials, "include");
    calls.push({ ...options, body: options.body && JSON.parse(options.body) });
    if (failure) return { ok: false, status: 409, json: async () => ({ error: { message: failure } }) };
    if (options.method === "PUT") saved = { ...saved, config: JSON.parse(options.body).config, version: saved.version + 1 };
    return { ok: true, json: async () => structuredClone(saved) };
  };
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(React.StrictMode, null, React.createElement(Settings)))));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return {
    calls, client,
    setSaved: data => { saved = structuredClone(data); },
    fail: message => { failure = message; },
    cleanup: async () => { await act(async () => root.unmount()); client.clear(); host.remove(); globalThis.fetch = originalFetch; },
  };
}
const data = () => { const { config, metadata } = affiliationFixture(); return { config, metadata, version: 7 }; };

test("default is off, optional setup is collapsed, suggestions require confirmation and do not save", async () => {
  const initial = data();
  initial.config = { ...EMPTY_CONFIG };
  const fixture = await mount(initial);
  try {
    assert.match(document.body.textContent, /Let members update their organisation and departments/);
    assert.equal(document.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
    assert.equal([...document.querySelectorAll("details")][0].open, false);
    assert.equal(select("memberDepartmentDefinitionId").value, "");
    assert.equal(select("departmentOrganizationDefinitionId").disabled, true);
    assert.equal(fixture.calls.filter(call => call.method === "PUT").length, 0);
    await click(button("Confirm suggestion"));
    assert.equal(select("memberDepartmentDefinitionId").value, "department-member");
    assert.equal(select("departmentOrganizationDefinitionId").value, "");
    await click(button("Confirm suggestion"));
    assert.equal(select("departmentOrganizationDefinitionId").value, "department-org");
    assert.equal(fixture.calls.filter(call => call.method === "PUT").length, 0);
    await click(button("Save affiliation settings"));
    assert.equal(fixture.calls.at(-1).body.version, 7);
    assert.equal(fixture.calls.at(-1).body.config.enabled, false);
  } finally { await fixture.cleanup(); }
});

test("search filters names, keeps selected choices, and duplicate choices stay independently selectable", async () => {
  const initial = data();
  initial.metadata.relationships.push({ ...initial.metadata.relationships[0], id: "duplicate" });
  initial.metadata.relationships[0].label = "Member teams";
  const fixture = await mount(initial);
  try {
    const input = document.querySelector('input[aria-label="Search how are members linked to departments?"]');
    await change(input, "no matching name", "input");
    assert.match(document.body.textContent, /No matches/);
    assert.equal(select("memberDepartmentDefinitionId").value, "department-member");
    await change(input, "Connection", "input");
    assert.equal([...select("memberDepartmentDefinitionId").options].some(option => option.value === "duplicate"), true);
    await change(select("memberDepartmentDefinitionId"), "duplicate");
    assert.equal(select("memberDepartmentDefinitionId").value, "duplicate");
    await click(button("Cancel settings edits"));
    assert.equal(select("memberDepartmentDefinitionId").value, "department-member");
  } finally { await fixture.cleanup(); }
});

test("unavailable saved UUIDs survive load, background refresh, unrelated edits, disabled save and cancel", async () => {
  const initial = data();
  const unknown = "a93e928c-aad5-4e89-a42f-e8406c0b8822";
  Object.assign(initial.config, { enabled: false, secondaryMemberDefinitionId: unknown, secondaryOrganizationDefinitionId: "missing-org", secondaryLabelFieldId: "missing-field" });
  const fixture = await mount(initial);
  try {
    assert.equal(select("secondaryMemberDefinitionId").value, unknown);
    assert.equal([...document.querySelectorAll("details")][0].open, true);
    assert.ok(![...document.querySelectorAll("option")].some(option => option.textContent.includes(unknown)));
    assert.match(document.querySelectorAll("details")[1].textContent, new RegExp(unknown));
    await act(async () => fixture.client.setQueryData(["member-affiliation-settings"], { ...data(), version: 29 }));
    assert.equal(select("secondaryMemberDefinitionId").value, unknown);
    await change(select("departmentOrganizationDefinitionId"), "");
    assert.equal(select("secondaryLabelFieldId").value, "missing-field");
    await act(async () => fixture.client.setQueryData(["member-affiliation-settings"], { ...data(), version: 31 }));
    assert.equal(select("departmentOrganizationDefinitionId").value, "");
    assert.equal(select("secondaryMemberDefinitionId").value, unknown);
    await click(button("Cancel settings edits"));
    assert.equal(select("departmentOrganizationDefinitionId").value, "department-org");
    await change(select("departmentOrganizationDefinitionId"), "");
    await click(button("Save affiliation settings"));
    const payload = fixture.calls.at(-1).body;
    assert.equal(payload.version, 7);
    assert.equal(payload.config.secondaryMemberDefinitionId, unknown);
    assert.equal(payload.config.secondaryOrganizationDefinitionId, "missing-org");
    assert.equal(payload.config.secondaryLabelFieldId, "missing-field");
  } finally { await fixture.cleanup(); }
});

test("changing a parent preserves dependent choices and shows actionable validation", async () => {
  const initial = data();
  Object.assign(initial.config, { secondaryMemberDefinitionId: "assignment-member", secondaryOrganizationDefinitionId: "assignment-org", secondaryLabelFieldId: "assignment-name" });
  const fixture = await mount(initial);
  try {
    await change(select("memberDepartmentDefinitionId"), "");
    assert.equal(select("departmentOrganizationDefinitionId").value, "department-org");
    assert.equal(select("secondaryMemberDefinitionId").value, "assignment-member");
    assert.equal(select("secondaryLabelFieldId").value, "assignment-name");
    assert.equal(button("Save affiliation settings").disabled, true);
    assert.match(document.body.textContent, /Choose how members are linked to departments/);
    assert.match(document.body.textContent, /This saved choice is not available/);
    await click(button("Cancel settings edits"));
    assert.equal(select("memberDepartmentDefinitionId").value, "department-member");
    assert.equal(select("secondaryOrganizationDefinitionId").value, "assignment-org");
  } finally { await fixture.cleanup(); }
});

test("save errors retain the draft; reload requires confirmation and deliberately replaces it", async () => {
  const fixture = await mount(data());
  const originalConfirm = dom.window.confirm;
  try {
    await click(document.querySelector('[role="switch"]'));
    fixture.fail("Settings changed. Reload and try again.");
    await click(button("Save affiliation settings"));
    assert.match(document.body.textContent, /Settings changed. Reload and try again/);
    assert.equal(document.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
    fixture.fail(null);
    fixture.setSaved({ ...data(), version: 12 });
    dom.window.confirm = () => false;
    const count = fixture.calls.length;
    await click(button("Reload saved settings"));
    assert.equal(fixture.calls.length, count);
    dom.window.confirm = () => true;
    await click(button("Reload saved settings"));
    assert.equal(document.querySelector('[role="switch"]').getAttribute("aria-checked"), "true");
    assert.match(document.body.textContent, /Saved version: 12/);
  } finally { dom.window.confirm = originalConfirm; await fixture.cleanup(); }
});

test("removing optional setup is explicit, confirmed, and stays a draft until save", async () => {
  const initial = data();
  Object.assign(initial.config, { secondaryMemberDefinitionId: "assignment-member", secondaryOrganizationDefinitionId: "assignment-org" });
  const fixture = await mount(initial);
  const originalConfirm = dom.window.confirm;
  try {
    dom.window.confirm = () => false;
    await click(button("Remove additional organisation setup"));
    assert.equal(select("secondaryMemberDefinitionId").value, "assignment-member");
    dom.window.confirm = () => true;
    await click(button("Remove additional organisation setup"));
    assert.equal(select("secondaryMemberDefinitionId").value, "");
    assert.equal(select("secondaryOrganizationDefinitionId").value, "");
    assert.equal(fixture.calls.filter(call => call.method === "PUT").length, 0);
    await click(button("Cancel settings edits"));
    assert.equal(select("secondaryMemberDefinitionId").value, "assignment-member");
  } finally { dom.window.confirm = originalConfirm; await fixture.cleanup(); }
});

test("invalid retained selections cannot be enabled or implicitly replaced by the only compatible suggestion", async () => {
  const initial = data();
  initial.config.enabled = false;
  initial.config.memberDepartmentDefinitionId = "missing-saved-connection";
  const fixture = await mount(initial);
  try {
    assert.equal(select("memberDepartmentDefinitionId").value, "missing-saved-connection");
    await click(document.querySelector('[role="switch"]'));
    assert.equal(select("memberDepartmentDefinitionId").value, "missing-saved-connection");
    assert.equal(button("Save affiliation settings").disabled, true);
    assert.match(document.body.textContent, /This saved choice is not available/);
    await click(button("Confirm suggestion"));
    assert.equal(select("memberDepartmentDefinitionId").value, "department-member");
    assert.equal(select("departmentOrganizationDefinitionId").value, "department-org");
    assert.equal(button("Save affiliation settings").disabled, false);
    await click(button("Save affiliation settings"));
    assert.equal(fixture.calls.at(-1).body.config.memberDepartmentDefinitionId, "department-member");
    assert.match(document.body.textContent, /Affiliation settings saved/);
  } finally { await fixture.cleanup(); }
});

test("a failed save can be retried without losing selections; later saves use the returned version", async () => {
  const fixture = await mount(data());
  try {
    await click(document.querySelector('[role="switch"]'));
    fixture.fail("Unable to save now. Please retry.");
    await click(button("Save affiliation settings"));
    assert.match(document.body.textContent, /Please retry/);
    fixture.fail(null);
    await click(button("Save affiliation settings"));
    assert.equal(fixture.calls.at(-1).body.version, 7);
    assert.match(document.body.textContent, /Saved version: 8/);
    await click(document.querySelector('[role="switch"]'));
    await click(button("Save affiliation settings"));
    assert.equal(fixture.calls.at(-1).body.version, 8);
    assert.equal(fixture.calls.at(-1).body.config.enabled, true);
  } finally { await fixture.cleanup(); }
});

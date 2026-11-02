import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node",
  "DocumentFragment", "Event", "CustomEvent", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const bundle = await build({
  entryPoints: ["client/src/components/forms/MemberAffiliationSettings.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  logLevel: "silent",
  plugins: [{
    name: "mock-authenticated-request",
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: "request", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: "export const adminFetch = (...args) => globalThis.affiliationRequest(...args);",
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/affiliation-settings-test.cjs`);
mod.filename = `${process.cwd()}/affiliation-settings-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { default: Settings, emptyAffiliationConfig, affiliationRelationshipOptions } = mod.exports;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => { dom.window.close(); delete globalThis.affiliationRequest; });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const context = { status: "ready", scopeKey: "session-a", tenantId: "tenant-a", assertCurrent() {} };
async function mount(t, overrides = {}, handler = async () => ({ ok: true, json: async () => ({ config: null }) })) {
  const calls = [];
  globalThis.affiliationRequest = async (...args) => { calls.push(args); return handler(...args); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    formId: "saved-form", tenantContext: context,
    persistedForm: { fields: [{ id: "org", type: "organisation_dropdown", label: "Primary workplace" }] },
    metadata: { objects: [], fields: {}, relationships: [] }, ...overrides,
  };
  await act(async () => { root.render(React.createElement(Settings, props)); await tick(); });
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { calls, container, root, props };
}
async function click(element) {
  assert.ok(element);
  await act(async () => { element.click(); await tick(); });
}
const button = (container, text) => [...container.querySelectorAll("button")].find(item => item.textContent === text);

test("unsaved forms make no requests and render no settings", async t => {
  const { container, calls } = await mount(t, { formId: null });
  assert.equal(container.textContent, "");
  assert.equal(calls.length, 0);
});

test("loading is read-only; enabling requires saved authenticated-owner access", async t => {
  const { container, calls } = await mount(t);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /form_id=saved-form/);
  assert.equal(calls[0][2], "tenant-a");
  assert.equal(container.querySelector('[role="switch"]').disabled, true);
  assert.equal(button(container, "Save affiliation settings").disabled, true);
  assert.match(container.textContent, /Existing join forms remain add-only/);
});

test("explicit save sends complete config; disabling retains mappings and changes no member data", async t => {
  const initial = { ...emptyAffiliationConfig(), enabled: true, primaryOrganizationFieldIds: ["org"] };
  const { container, calls } = await mount(t, {
    persistedForm: { require_authentication: true, mutation_access_policy: { mode: "authenticated_owner" }, fields: [
      { id: "org", type: "organisation_dropdown", label: "Primary workplace" },
    ] },
  }, async (url, options) => ({ ok: true, json: async () => ({ config: options.method === "PUT" ? JSON.parse(options.body).config : initial }) }));
  assert.equal(calls.length, 1);
  await click(container.querySelector('[role="switch"]'));
  assert.equal(calls.length, 1, "editing must not autosave");
  await click(button(container, "Save affiliation settings"));
  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1][1].body);
  assert.equal(payload.form_id, "saved-form");
  assert.equal(payload.config.enabled, false);
  assert.deepEqual(payload.config.primaryOrganizationFieldIds, ["org"]);
  assert.equal(payload.config.version, 1);
  assert.match(container.textContent, /No member data was changed/);
});

test("load failure offers retry; missing mappings are retained, not silently cleared", async t => {
  let attempt = 0;
  const config = { ...emptyAffiliationConfig(), primaryOrganizationFieldIds: ["removed-field"] };
  const { container, calls } = await mount(t, {}, async () => ({
    ok: ++attempt > 1,
    json: async () => attempt > 1 ? { config } : { error: "Access unavailable" },
  }));
  assert.match(container.textContent, /Access unavailable/);
  await click(button(container, "Retry loading settings"));
  assert.equal(calls.length, 2);
  assert.match(container.textContent, /Unavailable organisation field — selection retained/);
  assert.equal(button(container, "Save affiliation settings").disabled, true);
});

test("failed save preserves draft and allows retry", async t => {
  const { container } = await mount(t, {}, async (url, options) => ({
    ok: options.method !== "PUT",
    json: async () => options.method === "PUT" ? { error: "Validation failed" } : { config: null },
  }));
  await click(container.querySelector('[role="checkbox"]'));
  await click(button(container, "Save affiliation settings"));
  assert.match(container.textContent, /Validation failed/);
  assert.equal(container.querySelector('[role="checkbox"]').getAttribute("aria-checked"), "true");
  assert.equal(button(container, "Save affiliation settings").disabled, false);
});

test("relationship discovery filters endpoints and selected custom object without UUID entry", () => {
  const definitions = [
    { id: "member-site", name: "Works at", source_kind: "member", target_kind: "custom_object", target_custom_object_id: "site" },
    { id: "member-other", source_kind: "custom_object", source_custom_object_id: "other", target_kind: "member" },
    { id: "org-site", source_kind: "organization", target_kind: "custom_object", target_custom_object_id: "site" },
    { id: "inactive", status: "archived", source_kind: "member", target_kind: "custom_object", target_custom_object_id: "site" },
  ];
  assert.deepEqual(affiliationRelationshipOptions(definitions, "member", "site"), [{ value: "member-site", label: "Works at" }]);
  assert.equal(affiliationRelationshipOptions(definitions, "organization", "site")[0].value, "org-site");
});

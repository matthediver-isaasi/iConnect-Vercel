import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = Module.createRequire(import.meta.url)("@tanstack/react-query");
const bundle = await build({
  stdin: { contents: 'export {default as MemberAffiliations} from "@/components/MemberAffiliations"; export {default as MemberAffiliationSettings} from "@/components/MemberAffiliationSettings";', resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "aliases",
    setup(builder) {
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/affiliation-fixtures.cjs`);
compiled.filename = `${process.cwd()}/affiliation-fixtures.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { MemberAffiliations, MemberAffiliationSettings } = compiled.exports;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const snapshot = {
  active: true, token: "snapshot-one", primary: { id: "org-one", label: "North Institute" },
  secondary: [{ id: "org-two", label: "West College" }], secondaryEnabled: true,
  departments: [
    { id: "protected", label: "Advisory Team", organizationLabel: "North Institute", protected: true },
    { id: "unavailable", label: "Archived Service", organizationLabel: "Old College", protected: false },
  ],
};
function reply(value, status = 200) { return { ok: status < 400, status, json: async () => value }; }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); }); }
async function mount(Component, props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component, props))));
  await settle();
  return async () => { await act(async () => root.unmount()); client.clear(); host.remove(); };
}
const button = text => [...document.querySelectorAll("button")].find(item => item.textContent.trim() === text);
async function click(text) {
  const item = typeof text === "string" ? button(text) : text;
  assert.ok(item, `Missing button: ${text}`);
  await act(async () => item.click());
  await settle();
}

test("retains unavailable/protected links and cancel performs zero affiliation writes", async () => {
  const writes = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === "PATCH") writes.push(JSON.parse(options.body));
    return reply(options.method === "GET" ? snapshot : { items: [], hasMore: false });
  };
  const cleanup = await mount(MemberAffiliations);
  try {
    assert.match(document.body.textContent, /Archived Service/);
    assert.match(document.body.textContent, /Protected link/);
    assert.equal(button("Remove Advisory Team"), undefined);
    await click("Clear primary");
    assert.match(document.body.textContent, /Archived Service/);
    await click("Cancel affiliation edits");
    await click("Discard affiliation draft");
    assert.ok(document.body.textContent.includes("North Institute"));
    assert.equal(writes.length, 0);
    assert.ok(button("Review affiliation changes").disabled);
  } finally { await cleanup(); }
});

test("removal requires review and explicit confirmation; errors retain draft for retry", async () => {
  const writes = [];
  let fail = true;
  let saved = false;
  let refreshed = 0;
  let reads = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === "GET") { reads++; return reply(saved ? { ...snapshot, token: "snapshot-two", primary: null } : snapshot); }
    if (options.method === "PATCH") {
      writes.push(JSON.parse(options.body));
      if (fail) return reply({ message: "Snapshot expired. Draft retained." }, 409);
      saved = true;
      return reply({ committed: true, replayed: false });
    }
    return reply({ items: [], hasMore: false });
  };
  const cleanup = await mount(MemberAffiliations, { onSaved: () => { refreshed++; } });
  try {
    await click("Clear primary");
    await click("Review affiliation changes");
    assert.ok(button("Confirm and save affiliations").disabled);
    assert.equal(writes.length, 0);
    await click(document.querySelector('input[type="checkbox"]'));
    await click("Confirm and save affiliations");
    assert.match(document.querySelector('[role="dialog"]').textContent, /Snapshot expired/);
    assert.equal(writes[0].primary, null);
    assert.deepEqual(writes[0].departments, ["protected", "unavailable"]);
    assert.equal(refreshed, 0);
    fail = false;
    await click("Confirm and save affiliations");
    assert.equal(refreshed, 1);
    assert.equal(reads, 2);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.body.textContent, /Affiliations saved/);
  } finally { await cleanup(); }
});

test("failed snapshot loads fail closed, reload requires explicit discard", async () => {
  let fail = false;
  let gets = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === "GET") { gets++; return fail ? reply({ message: "Access denied" }, 403) : reply(snapshot); }
    return reply({ items: [], hasMore: false });
  };
  const cleanup = await mount(MemberAffiliations);
  try {
    await click("Clear primary");
    await click("Reload affiliation snapshot");
    assert.equal(gets, 1);
    await click("Keep editing");
    assert.match(document.body.textContent, /No primary organisation/);
    fail = true;
    await click("Reload affiliation snapshot");
    await click("Discard and reload");
    assert.equal(gets, 2);
    assert.match(document.body.textContent, /Access denied/);
    assert.ok(button("Review affiliation changes").disabled);
  } finally { await cleanup(); }
});

test("inactive and failed member snapshots never expose editing", async () => {
  globalThis.fetch = async () => reply({ active: false });
  let cleanup = await mount(MemberAffiliations);
  try { assert.equal(document.body.textContent, ""); } finally { await cleanup(); }
  globalThis.fetch = async () => reply({ message: "Unavailable" }, 503);
  cleanup = await mount(MemberAffiliations);
  try {
    assert.match(document.querySelector('[role="alert"]').textContent, /Unavailable/);
    assert.equal(button("Review affiliation changes"), undefined);
  } finally { await cleanup(); }
});

test("settings show definition direction, save separately with version and retain draft on errors", async () => {
  const data = {
    version: 7,
    config: { enabled: false, memberDepartmentDefinitionId: "md", departmentOrganizationDefinitionId: "do", secondaryMemberDefinitionId: null, secondaryOrganizationDefinitionId: null, secondaryLabelFieldId: null },
    metadata: {
      objects: [{ id: "dept", plural_label: "Departments" }],
      relationships: [
        { id: "md", name: "Member departments", source_kind: "member", target_kind: "custom_object", target_custom_object_id: "dept" },
        { id: "do", name: "Department organisations", source_kind: "custom_object", source_custom_object_id: "dept", target_kind: "organization" },
      ],
      fields: {},
    },
  };
  const writes = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === "PUT") { writes.push(JSON.parse(options.body)); return reply({ message: "Version conflict" }, 409); }
    return reply(data);
  };
  const cleanup = await mount(MemberAffiliationSettings);
  try {
    assert.match(document.body.textContent, /Source: member → Target: Departments/);
    await click(document.querySelector('[role="switch"]'));
    await click("Save affiliation settings");
    assert.equal(writes[0].version, 7);
    assert.equal(writes[0].config.enabled, true);
    assert.match(document.querySelector('[role="alert"]').textContent, /Version conflict/);
    assert.equal(document.querySelector('[role="switch"]').getAttribute("aria-checked"), "true");
    await click("Cancel settings edits");
    assert.equal(document.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
  } finally { await cleanup(); }
});

test("integration invalidates only affiliation-dependent reads, preserving field-wise profile reconciliation", () => {
  const source = readFileSync("client/src/pages/Preferences.jsx", "utf8");
  const integration = source.match(/<MemberAffiliations[\s\S]*?\/>/)?.[0];
  assert.match(integration, /queryKey: \["organization"\]/);
  assert.match(integration, /profileQueryKey\(memberRecord.id\)/);
  assert.doesNotMatch(integration, /setFirstName|setLastName|setHasUnsavedProfile|setAdditionalInfoValues/);
  assert.match(source, /current === profileValue\(key, previous\[key\]\)/);
});

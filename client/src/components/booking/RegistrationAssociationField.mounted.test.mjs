import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "location", "history", "HTMLElement", "HTMLInputElement", "Element", "Node",
  "Event", "MouseEvent", "DocumentFragment", "MutationObserver", "CustomEvent", "NodeFilter", "HTMLButtonElement"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act, useState } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  stdin: { contents: `
    export {default as Field} from './client/src/components/booking/RegistrationAssociationField.jsx';
    export {default as Config} from './client/src/components/events/RegistrationAssociationConfig.jsx';
    export {publicClient} from './client/src/api/publicClient.js';
    export {base44} from './client/src/api/base44Client.js';
    export {normalizeRegistrationAssociationConfig,validateRegistrationAssociationConfig} from './client/src/lib/registrationAssociations.js';
    export {purchaseIdentity} from './client/src/utils/publicTicketMembers.js';
    export {normalizePublicInvoicePurchaser} from './client/src/lib/publicInvoicePo.mjs';
    export {QueryClient, QueryClientProvider} from '@tanstack/react-query';
  `, resolveDir: process.cwd(), loader: "js" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", logLevel: "silent",
});
const compiled = new Module(`${process.cwd()}/registration-association-isolated.cjs`);
compiled.filename = `${process.cwd()}/registration-association-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { Field, Config, publicClient, base44, normalizeRegistrationAssociationConfig, validateRegistrationAssociationConfig,
  purchaseIdentity, normalizePublicInvoicePurchaser, QueryClient, QueryClientProvider } = compiled.exports;
const h = React.createElement;
after(() => dom.window.close());
const settle = async (ms = 20) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
async function mount(Component, props, initial = {}) {
  let current;
  function Harness() {
    const [value, setValue] = useState(initial);
    current = value;
    return h(Component, { ...props, value, onChange: patch => setValue(prev => ({ ...prev, ...patch })) });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(h(QueryClientProvider, { client }, h(Harness))));
  await settle();
  return { container, value: () => current, async close() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
async function click(node) {
  assert.ok(node, "click target exists");
  await act(async () => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}
async function input(node, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent.trim() === text);

test("guest selection shows names only, keeps kind/id, searches, and Other clears selection", async () => {
  const calls = [];
  publicClient.getEventRegistrationAssociations = async (...args) => {
    calls.push(args);
    return { enabled: true, options: [
      { kind: "organization", id: "org-1", name: "Northfield Institute" },
      { kind: "group", id: "group-1", name: "Regional Research Network" },
    ], hasMore: true };
  };
  const app = await mount(Field, { eventId: "event-1", eventKind: "complex" });
  try {
    await click(document.querySelector('[role="combobox"]'));
    assert.ok(button("Northfield Institute"));
    assert.ok(button("Regional Research Network"));
    assert.equal(document.body.textContent.includes("group-1"), false);
    await input(document.querySelector('[aria-label="Search organisations and groups"]'), "Regional");
    await settle(300); await settle();
    assert.deepEqual(calls.at(-1), ["event-1", "complex", "Regional"]);
    await click(button("Regional Research Network"));
    assert.deepEqual(app.value(), { organization: "Regional Research Network", registration_association: { kind: "group", id: "group-1" } });
    await click(document.querySelector('[role="combobox"]'));
    await click(button("Other"));
    assert.equal(app.value().registration_association, null);
    assert.equal(app.value().organization, "");
    await input(app.container.querySelector("input"), "Independent practice");
    assert.equal(app.value().organization, "Independent practice");
    assert.equal(app.value().registration_association, null);
  } finally { await app.close(); }
});

test("disabled feature and unavailable API retain original organisation entry", async () => {
  for (const response of [() => ({ enabled: false, options: [], hasMore: false }), () => { throw new Error("Unavailable"); }]) {
    publicClient.getEventRegistrationAssociations = async () => response();
    const app = await mount(Field, { eventId: "event-2", placeholder: "Original organisation" });
    try {
      assert.equal(app.container.querySelector('[role="combobox"]'), null);
      await input(app.container.querySelector("input"), "Original flow");
      assert.equal(app.value().organization, "Original flow");
    } finally { await app.close(); }
  }
});

test("configuration defaults off, toggles are independent, real metadata is scoped", async () => {
  const calls = [];
  base44.entities.PreferenceField.list = async options => {
    calls.push(options);
    return [{ id: "field-1", label: "Region", entity_scope: options.filter.entity_scope, is_active: true }];
  };
  const app = await mount(Config, { roles: [{ id: "role-1", name: "Event contact" }] }, normalizeRegistrationAssociationConfig());
  try {
    assert.ok(app.container.querySelector("section").classList.contains("bg-white"));
    const switches = app.container.querySelectorAll('[role="switch"]');
    assert.equal(switches[0].getAttribute("aria-checked"), "false");
    assert.equal(switches[1].getAttribute("aria-checked"), "false");
    await click(switches[1]);
    assert.equal(app.value().groups.enabled, true);
    assert.equal(app.value().organizations.enabled, false);
    assert.equal(calls[0].filter.entity_scope, "organization_group");
    await click(switches[0]);
    assert.equal(calls[1].filter.entity_scope, "organization");
    assert.match(validateRegistrationAssociationConfig(app.value(), [])[0], /eligible role/);
  } finally { await app.close(); }
});

test("saved config round-trips and serializers retain associations without changing ordinary identities", () => {
  const config = { organizations: { enabled: true, field_id: "field-1", value: "North" }, groups: { enabled: false, field_id: null, value: "" }, role_id: "role-1" };
  assert.deepEqual(normalizeRegistrationAssociationConfig(JSON.stringify(config)), config);
  assert.deepEqual(validateRegistrationAssociationConfig(config, [{ id: "role-1" }]), []);
  for (const role of [{ is_admin: true }, { is_tenant_admin: true }, { requires_effective_from_date: true }, { max_members: 0 }, { max_members: 14 }]) {
    assert.equal(validateRegistrationAssociationConfig(config, [{ id: "role-1", ...role }]).length, 1);
  }
  const registration_association = { kind: "organization", id: "org-1" };
  const person = { first_name: "Maya", last_name: "Ellis", email: "maya@example.test", organization: "Northfield Institute", registration_association };
  assert.deepEqual(purchaseIdentity(person).registration_association, registration_association);
  assert.deepEqual(normalizePublicInvoicePurchaser(person).registration_association, registration_association);
  assert.equal("registration_association" in purchaseIdentity({ organization: "Original" }), false);
});

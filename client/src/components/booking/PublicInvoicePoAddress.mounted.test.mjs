import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { INVOICING_ADDRESS_FIELDS } from "../../../../shared/invoicingAddress.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test/booking" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "NodeFilter", "MutationObserver", "Node"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const h = React.createElement;

async function load(entry) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, packages: "external",
    platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    plugins: [{
      name: "billing-hook-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^@\/hooks\/usePublicInvoicePoBilling$/ }, () => ({ path: "billing", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export function usePublicInvoicePoBilling() { return globalThis.__addressBillingFixture; }",
          loader: "js",
        }));
      },
    }],
  });
  const module = new Module(`${process.cwd()}/invoice-address-test.cjs`);
  module.filename = `${process.cwd()}/invoice-address-test.cjs`;
  module.paths = Module._nodeModulePaths(process.cwd());
  module._compile(result.outputFiles[0].text, module.filename);
  return module.exports.default;
}
const AddressFields = await load("client/src/components/booking/PublicInvoicePoAddressFields.jsx");
const Billing = await load("client/src/components/events/PublicInvoicePoBilling.jsx");
async function mount(Component, props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(Component, props)));
  return async () => { await act(async () => root.unmount()); host.remove(); };
}
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
after(() => { delete globalThis.__addressBillingFixture; dom.window.close(); });

test("invoice address fields have associated labels, required flags, limits and invoice-only helper copy", async () => {
  const changes = [];
  function Form() {
    const [value, setValue] = React.useState({});
    return h("form", null, h(AddressFields, {
      value, onChange: patch => { changes.push(patch); setValue(previous => ({ ...previous, ...patch })); },
    }));
  }
  const close = await mount(Form);
  try {
    const fields = document.querySelectorAll("input");
    assert.equal(fields.length, INVOICING_ADDRESS_FIELDS.length);
    for (const { key, label, maxLength } of INVOICING_ADDRESS_FIELDS) {
      const input = document.getElementById(`public-invoice-${key}`);
      assert.ok(input.labels[0].textContent.startsWith(label));
      assert.equal(input.maxLength, maxLength);
      assert.equal(input.required, !["invoicing_address_line2", "invoicing_region"].includes(key));
      assert.ok(document.getElementById(input.getAttribute("aria-describedby")));
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, `Value for ${key}`);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      assert.equal(input.value, `Value for ${key}`);
      assert.deepEqual(changes.at(-1), { [key]: `Value for ${key}` });
    }
    assert.match(document.body.textContent, /does not create or update organisation records/);
    assert.match(document.body.textContent, /emailed to the booker/);
    assert.equal(document.querySelector("form").checkValidity(), true);
  } finally { await close(); }
});

const booker = { first_name: "Leila", last_name: "Hassan", email: "leila@example.test" };
const address = {
  invoicing_address_line1: "21 Beacon Road", invoicing_address_line2: "Finance office",
  invoicing_city: "Leeds", invoicing_region: "Yorkshire",
  invoicing_postal_code: "LS1 7AB", invoicing_country: "United Kingdom",
};
test("admin preview and confirmation show the returned organisation address separately from delivery recipient", async () => {
  const generated = [];
  globalThis.__addressBillingFixture = {
    billing: { data: { booker, billingContact: {
      name: "Beacon Learning Trust", isOrganization: true, invoicingAddress: { source: "structured", address },
    }, member: { id: "booker-member" }, canGenerate: true, fingerprint: "approved-fingerprint", amount: 173.42 } },
    generate: { reset() {}, async mutateAsync(fingerprint) { generated.push(fingerprint); } },
  };
  const close = await mount(Billing, { bookingId: "booking-a" });
  try {
    assert.match(document.body.textContent, /Billed to · organisationBeacon Learning Trust/);
    for (const value of Object.values(address)) assert.ok(document.body.textContent.includes(value));
    assert.match(document.body.textContent, /Original booker · email recipientLeila Hassanleila@example.test/);
    await act(async () => button("Generate invoice").click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog.textContent.includes("Beacon Learning Trust"));
    for (const value of Object.values(address)) assert.ok(dialog.textContent.includes(value));
    assert.match(dialog.textContent, /Invoice emailed to the booker:leila@example.test/);
    assert.deepEqual(generated, [], "preview and opening confirmation never generate an invoice");
    await act(async () => button("Confirm generate invoice").click());
    assert.deepEqual(generated, ["approved-fingerprint"]);
  } finally { await close(); }
});

test("legacy personal billing contact needs no address and falls back to booker only when contact is absent", async () => {
  for (const contact of [{ name: "Legacy approved contact", isOrganization: false }, undefined]) {
    globalThis.__addressBillingFixture = {
      billing: { data: { booker, billingContact: contact, member: { id: "booker-member" }, canGenerate: true } },
      generate: { reset() {} },
    };
    const close = await mount(Billing, { bookingId: "legacy-booking" });
    try {
      assert.ok(document.body.textContent.includes(contact?.name || "Leila Hassan"));
      assert.equal(document.querySelector("address"), null);
      assert.ok(!document.body.textContent.includes("Billed to · organisation"));
      await act(async () => button("Generate invoice").click());
      assert.ok(document.querySelector('[role="dialog"]').textContent.includes(contact?.name || "Leila Hassan"));
    } finally { await close(); }
  }
});

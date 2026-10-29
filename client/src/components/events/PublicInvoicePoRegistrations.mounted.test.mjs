import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test/report" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "NodeFilter", "MutationObserver", "Node"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = (await import("react")).default;
const React = globalThis.React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/events/PublicInvoicePoRegistrations.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  jsx: "automatic", logLevel: "silent",
  plugins: [{
    name: "invoice-panel-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^@\/components\/events\/PublicInvoicePoBilling$/ }, () => ({ path: "billing", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `export default function Billing(props) {
            globalThis.__invoicePanelProps = props;
            return globalThis.React.createElement("section", { "data-testid": "billing-panel" }, "Invoice controls");
          }`, loader: "js",
      }));
    },
  }],
});
const bundled = new Module(`${process.cwd()}/registrations-test.cjs`);
bundled.filename = `${process.cwd()}/registrations-test.cjs`;
bundled.paths = Module._nodeModulePaths(process.cwd());
bundled._compile(bundle.outputFiles[0].text, bundled.filename);
const Registrations = bundled.exports.default;
const h = React.createElement;
const group = {
  eventId: "event-a", eventTitle: "Annual Assembly", bookingSource: "complex_event_booking",
  isPublicInvoicePo: true, groupRef: "group-a", groupPayment: { purchaseOrderNumber: "PO-731" },
  publicInvoicePurchaser: { first_name: "Leila", last_name: "Hassan", email: "booker@example.test" },
  attendees: [
    { id: "booking-a", attendee_first_name: "Maya", attendee_email: "maya@example.test" },
    { id: "booking-b", attendee_first_name: "Ravi", attendee_email: "ravi@example.test" },
  ],
};
const button = (text, parent = document) => [...parent.querySelectorAll("button")].find(node => node.textContent === text);
const click = async node => { assert.ok(node, "button exists"); await act(async () => node.click()); };
async function mount({ permitted = true, groupRef = group.groupRef } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const full = { ...group, groupRef };
  const onCreateMember = () => {};
  delete globalThis.__invoicePanelProps;
  await act(async () => root.render(h(Registrations, {
    groups: [{ ...full, attendees: [group.attendees[1]] }], allGroups: [full],
    canManageInvoice: permitted, canCreateGuestMember: true, onCreateMember,
    tenantId: "tenant-a", viewerId: "viewer-a",
    renderFormAnswers: () => h("p", { "data-testid": "form-answers" }, "Purchaser form answers"),
  })));
  return {
    host, onCreateMember,
    async closeDialog() {
      await click(document.querySelector('[role="dialog"] button:has(.sr-only)') || button("Close"));
    },
    async close() { await act(async () => root.unmount()); host.remove(); },
  };
}
after(() => { delete globalThis.__invoicePanelProps; dom.window.close(); });

test("each row has a separate direct action opening invoice controls before purchaser answers with the full booking", async () => {
  for (const groupRef of ["group-a", null]) {
    const view = await mount({ groupRef });
    try {
      const action = button("Manage invoice", view.host);
      assert.ok(action, "visible row action");
      assert.equal(action.closest("button button"), null, "no nested buttons");
      assert.equal(document.querySelector('[data-testid="billing-panel"]'), null);
      await click(action);
      const dialog = document.querySelector('[role="dialog"]');
      const panel = dialog.querySelector('[data-testid="billing-panel"]');
      assert.ok(panel);
      assert.ok(button("Hide invoice", dialog));
      assert.ok(dialog.textContent.includes("Maya"), "filtered-out attendee is included");
      assert.ok(dialog.textContent.includes("Ravi"));
      assert.equal(globalThis.__invoicePanelProps.bookingId, "booking-a", "canonical booking identity, not filtered first attendee");
      assert.equal(globalThis.__invoicePanelProps.isComplex, true);
      assert.equal(globalThis.__invoicePanelProps.tenantId, "tenant-a");
      assert.equal(globalThis.__invoicePanelProps.viewerId, "viewer-a");
      assert.equal(globalThis.__invoicePanelProps.canCreateGuestMember, true);
      assert.equal(globalThis.__invoicePanelProps.onCreateMember, view.onCreateMember);
      assert.ok(panel.compareDocumentPosition(dialog.querySelector('[data-testid="form-answers"]')) & Node.DOCUMENT_POSITION_FOLLOWING);
      await view.closeDialog();
      await click([...view.host.querySelectorAll("button")].find(node => node.textContent.includes("Leila Hassan")));
      assert.equal(document.querySelector('[data-testid="billing-panel"]'), null, "ordinary details resets expanded state");
      assert.ok(button("Manage invoice", document.querySelector('[role="dialog"]')));
    } finally { await view.close(); }
  }
});

test("ordinary details is lazy and invoice permission hides both entry points", async () => {
  for (const permitted of [true, false]) {
    const view = await mount({ permitted });
    try {
      assert.equal(!!button("Manage invoice", view.host), permitted);
      await click([...view.host.querySelectorAll("button")].find(node => node.textContent.includes("Leila Hassan")));
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog.textContent.includes("Maya"));
      assert.equal(document.querySelector('[data-testid="billing-panel"]'), null);
      assert.equal(globalThis.__invoicePanelProps, undefined, "billing never mounts from ordinary details");
      assert.equal(!!button("Manage invoice", dialog), permitted);
      if (permitted) {
        await click(button("Manage invoice", dialog));
        assert.ok(document.querySelector('[data-testid="billing-panel"]'));
        await click(button("Hide invoice", dialog));
        assert.equal(document.querySelector('[data-testid="billing-panel"]'), null);
      }
    } finally { await view.close(); }
  }
});

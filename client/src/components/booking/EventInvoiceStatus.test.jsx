import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { default: EventInvoiceStatus } = await import("./EventInvoiceStatus.jsx");
const record = { total_cost: 50, payment_method: "card", status: "confirmed", invoice_recovery_status: "retry", xero_invoice_error: "SECRET_PROVIDER_ERROR" };

test("mounted member/admin labels are neutral, accessible and change immediately after linkage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("This status must never make a request"); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async props => act(async () => root.render(<EventInvoiceStatus {...props} />));
  try {
    await render({ record });
    assert.equal(container.textContent, "Invoice awaited");
    assert.match(container.querySelector("[tabindex]").getAttribute("aria-label"), /No action is needed/);
    assert.doesNotMatch(document.body.textContent, /SECRET_PROVIDER_ERROR/);
    await render({ record: { ...record, invoice_recovery_status: "needs_review" } });
    assert.equal(container.textContent, "Invoice awaited");
    await render({ record: { ...record, invoice_recovery_status: "needs_review" }, admin: true });
    assert.equal(container.textContent, "Needs attention");
    await render({ record: { ...record, invoice_recovery_next_attempt_at: "2026-12-01T12:00:00Z" }, admin: true });
    assert.match(container.textContent, /Invoice awaitedNext retry:/);
    assert.equal(container.querySelector("time").dateTime, "2026-12-01T12:00:00.000Z");
    await render({ record: { ...record, accounting_invoice_id: "linked", accounting_invoice_number: "INV-READY" }, showInvoice: true });
    assert.equal(container.textContent, "INV-READY");
    assert.equal(container.querySelector("[tabindex]"), null);
    await render({ record: { ...record, accounting_invoice_id: "linked", accounting_invoice_number: "INV-READY", invoice_recovery_next_attempt_at: "2026-12-01T12:00:00Z" }, admin: true, showInvoice: true });
    assert.match(container.textContent, /INV-READYNext retry:/);
    assert.doesNotMatch(container.textContent, /Invoice awaited/);
    for (const excluded of [{ status: "cancelled" }, { payment_method: "public_invoice_po" }, { invoice_recovery_status: null }]) {
      await render({ record: { ...record, ...excluded } });
      assert.equal(container.textContent, "");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});
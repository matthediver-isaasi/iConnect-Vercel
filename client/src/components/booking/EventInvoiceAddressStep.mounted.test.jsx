import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node",
  "NodeFilter", "Event", "CustomEvent", "MouseEvent", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
});
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { EventInvoiceAddressForm, useEventInvoiceAddress } = await import("./EventInvoiceAddressStep.jsx");
after(() => dom.window.close());

async function mount(element, run) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  try { await run(container, root); }
  finally { await act(async () => root.unmount()); container.remove(); }
}
const click = async node => act(async () => node.click());

test("missing personal/org addresses collect editable personal fields; populated personal selection is emitted only once", async () => {
  const choices = [];
  const state = { data: { personalAddress: null, organizationAddress: null } };
  await mount(<EventInvoiceAddressForm state={state} onChoose={s => choices.push(s)} onCancel={() => {}} />, async container => {
    assert.equal(container.querySelectorAll('input[type="radio"]').length, 1);
    assert.equal(container.querySelectorAll('input:not([type="radio"])').length, 6);
    assert.equal(container.querySelector('input[name="invoicing_address_line1"]').value, "");
    await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.match(container.textContent, /Please enter invoicing address line 1/);
    assert.equal(choices.length, 0);
  });
  const filled = { data: { personalAddress: { source: "structured", address: {
    invoicing_address_line1: "1 Member Road", invoicing_city: "London",
    invoicing_postal_code: "SW1A 1AA", invoicing_country: "United Kingdom",
  } } } };
  await mount(<EventInvoiceAddressForm state={filled} onChoose={s => choices.push(s)} onCancel={() => {}} />, async container => {
    await click(container.querySelector('button[type="submit"]'));
    await click(container.querySelector('button[type="submit"]'));
    assert.equal(choices.length, 1);
    assert.equal(choices[0].address.invoicing_address_line1, "1 Member Road");
  });
});

test("linked legacy/structured organisation is read-only and only the organisation mode is submitted", async () => {
  for (const organizationAddress of [
    { source: "legacy", address: "Legacy office\nLondon" },
    { source: "structured", address: { invoicing_address_line1: "Office Road", invoicing_city: "London" } },
  ]) {
    let choice;
    await mount(<EventInvoiceAddressForm state={{ data: { organizationAddress, organizationLabel: "My organisation" } }}
      onChoose={s => { choice = s; }} onCancel={() => {}} />, async container => {
      await click(container.querySelector('input[value="organization"]'));
      assert.equal(container.querySelectorAll('input:not([type="radio"])').length, 0);
      assert.match(container.textContent, /London/);
      await click(container.querySelector('button[type="submit"]'));
      assert.deepEqual(choice, { mode: "organization" });
    });
  }
});

test("mounted discovery bypasses existing customers, errors require retry, cancellation and scope changes reject stale work", async () => {
  let response = { required: false, applicable: true }, fail = false, resolveNetwork;
  let deferred = false, result = "pending", calls = 0;
  const request = async () => {
    calls++;
    if (deferred) await new Promise(resolve => { resolveNetwork = resolve; });
    if (fail) throw new Error("Network unavailable");
    return { ok: true, json: async () => response };
  };
  function Harness({ scope = "member-1", forceRequired = false }) {
    const address = useEventInvoiceAddress({ scopeKey: scope, eventId: "event", source: "simple", request });
    return <><button onClick={() => address.collect({ forceRequired }).then(
      value => { result = value; }, error => { result = error.name; })}>Start</button>{address.step}</>;
  }
  await mount(<Harness />, async (container, root) => {
    await click(container.querySelector("button"));
    assert.equal(result, undefined);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    response = { required: false, applicable: false };
    await click(container.querySelector("button"));
    assert.equal(result, undefined);
    fail = true;
    await click(container.querySelector("button"));
    assert.match(document.body.textContent, /Network unavailable/);
    const previousCalls = calls;
    fail = false;
    response = { required: true, applicable: true, personalAddress: null, organizationAddress: null };
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Retry address check"));
    assert.equal(calls, previousCalls + 1);
    assert.match(document.body.textContent, /Personal address/);
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Cancel"));
    assert.equal(result, "AbortError");
    response = { required: false, applicable: true };
    await act(async () => root.render(<Harness forceRequired />));
    await click(container.querySelector("button"));
    assert.match(document.body.textContent, /Invoice requirements changed/);
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Cancel"));
    assert.equal(result, "AbortError");
    await act(async () => root.render(<Harness />));
    deferred = true;
    await click(container.querySelector("button"));
    await act(async () => root.render(<Harness scope="member-2" />));
    assert.equal(result, "AbortError");
    await act(async () => resolveNetwork());
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});

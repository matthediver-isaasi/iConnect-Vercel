import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import Module from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { JSDOM } from "jsdom";
const require = Module.createRequire(import.meta.url);
const dom = new JSDOM("<html><body></body></html>", { url: "https://test.example" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
after(() => dom.window.close());
const bundle = await build({
  entryPoints: ["client/src/components/events/RegistrationBulkActionDialog.jsx"],
  bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic", external: ["react"],
  plugins: [{
    name: "fixtures", setup(b) {
      b.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path, namespace: "ui" }));
      b.onLoad({ filter: /.*/, namespace: "ui" }, () => ({ contents: `
        import React from "react";
        export const Button=({children,variant,...props})=>React.createElement('button',props,children);
        export const Dialog=({children})=>React.createElement('div',null,children);
        export const DialogContent=({children,className})=>React.createElement('div',{className},children);
        export const DialogHeader=({children})=>React.createElement('header',null,children);
        export const DialogTitle=({children})=>React.createElement('h2',null,children);
        export const DialogDescription=({children})=>React.createElement('p',null,children);` }));
    },
  }],
});
const mod = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, mod, mod.exports);
const Component = mod.exports.default;
const rows = [
  { booking_id: "same-id", booking_source: "standard", event_id: "e1", attendee_name: "Alice", event_title: "First event", status: "confirmed" },
  { booking_id: "same-id", booking_source: "complex", event_id: "e2", attendee_name: "Bob", event_title: "Second event", status: "confirmed" },
];
const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => data });
async function mount(action, registrations = rows) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Component, { action, registrations, onClose() {} })));
  return { host, async close() { await act(async () => root.unmount()); host.remove(); } };
}
const button = (host, text) => [...host.querySelectorAll("button")].find(el => el.textContent.includes(text));
const click = async el => { assert.ok(el); await act(async () => el.click()); };

test("bulk cancellation preserves source, skips cancelled rows, and reports partial failure without retry", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const input = JSON.parse(options.body); calls.push({ url, input });
    return input.booking_source === "booking" ? reply({ success: true }) : reply({ error: "Not permitted" }, false);
  };
  const view = await mount("cancel", [...rows, { ...rows[0], booking_id: "cancelled", status: "cancelled", attendee_name: "C" }]);
  try {
    assert.equal(calls.length, 0);
    await click(button(view.host, "Confirm cancellation requests"));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.input.booking_source), ["booking", "complex_event_booking"]);
    assert.ok(calls.every(c => c.input.request_type === "individual" && c.input.booking_ids.length === 1));
    assert.match(view.host.textContent, /Cancellation request submitted/);
    assert.match(view.host.textContent, /Not permitted/);
    assert.match(view.host.textContent, /already cancelled/);
    assert.equal(button(view.host, "Confirm cancellation requests").disabled, true);
  } finally { await view.close(); }
});

test("survey preview excludes ineligible rows and requires attendance acknowledgement before explicit send", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (!options.body) return reply({ tracking: false, surveys: [{ id: "survey", name: "Feedback" }] });
    const input = JSON.parse(options.body); calls.push(input);
    if (input.action === "send") return reply({ success: true });
    return input.booking_source === "complex" ? reply({ error: "Qualifying attendance required" }, false)
      : reply({ fingerprint: "fp", attendance_warning: true, subject: "Feedback", recipient: "alice@example.test", html: "<p>Preview</p>" });
  };
  const view = await mount("survey");
  try {
    await click(button(view.host, "Review recipients"));
    assert.equal(calls.length, 2);
    assert.match(view.host.textContent, /1 eligible; 1 excluded/);
    assert.match(view.host.textContent, /Qualifying attendance required/);
    assert.ok(view.host.querySelector('iframe[sandbox=""]'));
    assert.equal(button(view.host, "Confirm and send").disabled, true);
    await act(async () => Simulate.change(view.host.querySelector('input[type="checkbox"]'), { target: { checked: true } }));
    await click(button(view.host, "Confirm and send"));
    const sends = calls.filter(c => c.action === "send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].expected_fingerprint, "fp");
    assert.equal(sends[0].acknowledge_unverified, true);
    assert.ok(sends[0].request_id);
    assert.equal(button(view.host, "Confirm and send").disabled, true);
  } finally { await view.close(); }
});

test("certificate bulk mode exposes PDF preview and recipient review without awarding points or auto sending", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return reply({ available: true, can_send: true, fingerprint: "cert", recipient: "alice@example.test" });
  };
  const view = await mount("certificate");
  try {
    assert.equal(calls.length, 0);
    assert.ok(button(view.host, "Preview certificate PDF"));
    assert.ok(!view.host.textContent.includes("Recheck missing badge awards"));
    await click(button(view.host, "Review recipients"));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => !c.options.body && c.url.includes("attendee-cpd-certificate")));
    assert.match(view.host.textContent, /Confirm/);
  } finally { await view.close(); }
});

test("report keeps selectors outside actions and requested action ordering and sticky offsets", () => {
  const source = readFileSync("client/src/pages/EventRegistrationReport.jsx", "utf8");
  const actions = source.slice(source.indexOf("const renderActionIcons"), source.indexOf("const renderSelection"));
  const markers = ['linked-member-', 'button-cancel-', 'button-transfer-', 'reprocess-cpd-', 'button-cpd-certificate-', '<RegistrantSurveyEmailAction'];
  assert.deepEqual(markers.map(m => actions.indexOf(m)), markers.map(m => actions.indexOf(m)).sort((a,b) => a-b));
  assert.ok(markers.every(m => actions.includes(m)));
  assert.ok(!actions.includes("<Checkbox"));
  assert.equal((source.match(/renderSelection\(attendee, group\)/g) || []).length, 2);
  const css = readFileSync("client/src/pages/EventRegistrationReport.css", "utf8");
  assert.match(css, /data-pinned="selection"[\s\S]*?border-right:/);
  assert.match(css, /calc\(var\(--report-selection-width\) \+ var\(--report-actions-width\)\)/);
});

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://tenant.example.test/sales-ticket-registration" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
const bundle = await build({
  entryPoints: ["client/src/pages/PublicSalesTicketRegistration.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  alias: { "@": `${process.cwd()}/client/src` }, jsx: "automatic", logLevel: "silent",
});
const mod = new Module(`${process.cwd()}/ticket-registration-test.cjs`);
mod.filename = `${process.cwd()}/ticket-registration-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const Page = mod.exports.default;
const { safeRegistrationUrl } = mod.exports;
const fixture = {
  customerName: "Hawthorn Learning",
  allocations: [{ id: "allocation-1", eventName: "Practice leadership forum", ticketName: "Delegate", eventKind: "simple", remaining: 3, registered: 1, allocated: 4 }],
  expiresAt: "2099-06-12T12:00:00Z",
};
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
async function until(predicate) {
  for (let index = 0; index < 80; index++) { if (predicate()) return; await settle(); }
  assert.fail(`Timed out: ${document.body.textContent}`);
}
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
const click = async node => { assert.ok(node, "expected action"); await act(async () => node.click()); };
async function fill(id, value) {
  const input = document.getElementById(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fillDelegate(email = "asha@hawthorn.example") {
  await fill("delegate-first-name", "Asha");
  await fill("delegate-last-name", "Patel");
  await fill("delegate-email", email);
}
async function submit() {
  await act(async () => document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function mount(fetcher = () => response(fixture), fragment = "#token=private-fixture-token") {
  window.history.replaceState(null, "", `/sales-ticket-registration${fragment}`);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/public/sales-ticket-registration", "no real messages or unrelated API calls");
    const body = JSON.parse(options.body);
    calls.push({ body, options });
    return fetcher(body, calls);
  };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Page))));
  return { calls, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

test("only same-origin normal event routes are accepted", () => {
  const origin = window.location.origin;
  for (const url of ["/events/forum?allocationToken=abc", "/session-events/congress", "/EventDetails?id=event-1", "/ComplexEventDetail?id=event-2"]) {
    assert.ok(safeRegistrationUrl(url, origin));
  }
  for (const url of ["javascript:alert(1)", "//elsewhere.test/events/forum", "https://elsewhere.test/EventDetails", "/admin", "/events/forum/settings", "/events/../admin", "/events\\evil", "/events/forum\n", "", null]) {
    assert.equal(safeRegistrationUrl(url, origin), null, String(url));
  }
});

test("fragment survives StrictMode, remains private, and purchased counts are shown", async () => {
  const view = await mount();
  try {
    await until(() => document.body.textContent.includes("Hawthorn Learning"));
    assert.ok(view.calls.every(call => call.body.token === "private-fixture-token"));
    assert.ok(view.calls.every(call => call.options.referrerPolicy === "no-referrer"));
    assert.equal(window.location.hash, "#token=private-fixture-token");
    assert.equal(window.sessionStorage.length, 0);
    assert.equal(window.localStorage.length, 0);
    assert.equal(document.querySelector('meta[name="referrer"]').content, "no-referrer");
    assert.ok(!document.body.textContent.includes("private-fixture-token"));
    assert.match(document.body.textContent, /4 purchased · 1 registered/);
    assert.match(document.body.textContent, /3 remaining/);
  } finally { await view.close(); }
  assert.equal(document.querySelector('meta[name="referrer"]'), null);
});

test("query token is not accepted and no request is made", async () => {
  const view = await mount(undefined, "?token=query-secret");
  try {
    assert.match(document.body.textContent, /Open your secure invitation/);
    assert.equal(view.calls.length, 0);
  } finally { await view.close(); }
});

test("context errors retry, expired links stop, and exhausted allocations have an empty state", async () => {
  let failed = true;
  const view = await mount(() => failed ? response({}, 503) : response(fixture));
  try {
    await until(() => button("Try again"));
    failed = false;
    await click(button("Try again"));
    await until(() => document.body.textContent.includes("Hawthorn Learning"));
  } finally { await view.close(); }
  const expired = await mount(() => response({}, 410));
  try { await until(() => document.body.textContent.includes("This link is no longer available")); assert.equal(document.querySelector("form"), null); }
  finally { await expired.close(); }
  const sold = await mount(() => response({ ...fixture, allocations: [{ ...fixture.allocations[0], remaining: 0, registered: 4 }] }));
  try { await until(() => document.body.textContent.includes("All places have been assigned")); assert.equal(document.querySelector("form"), null); }
  finally { await sold.close(); }
});

test("pending blocks duplicate creates; retries reuse key, changed data gets new key", async () => {
  let resolveFirst;
  let registrations = 0;
  const view = await mount(body => {
    if (body.action === "context") return response(fixture);
    registrations++;
    if (registrations === 1) return new Promise(resolve => { resolveFirst = resolve; });
    if (registrations === 2) return response({}, 503);
    return response({ registrationUrl: "/events/forum?allocationToken=delegate-link" });
  });
  try {
    await until(() => document.querySelector("form"));
    await fillDelegate();
    await submit();
    await submit();
    assert.equal(registrations, 1);
    assert.ok(button("Creating registration link…").disabled);
    await act(async () => resolveFirst(response({}, 503)));
    await until(() => button("Retry registration link"));
    await submit();
    await until(() => registrations === 2);
    const creates = () => view.calls.filter(call => call.body.action === "register");
    assert.equal(creates()[0].body.idempotencyKey, creates()[1].body.idempotencyKey);
    await fill("delegate-email", "ren@hawthorn.example");
    await submit();
    await until(() => document.querySelector('a[target="_blank"]'));
    assert.notEqual(creates()[1].body.idempotencyKey, creates()[2].body.idempotencyKey);
    const link = document.querySelector('a[target="_blank"]');
    assert.equal(link.rel, "noopener noreferrer");
    assert.equal(link.getAttribute("referrerpolicy"), "no-referrer");
    assert.ok(!link.href.includes("private-fixture-token"));
    await click(button("Add another colleague"));
    await until(() => document.querySelector("form"));
    await fillDelegate("nell@hawthorn.example");
    await until(() => !button("Create registration link").disabled);
    await submit();
    await until(() => creates().length === 4);
    assert.notEqual(creates()[2].body.idempotencyKey, creates()[3].body.idempotencyKey);
  } finally { await view.close(); }
});

test("unsafe destination is not rendered and retry retains the same request key", async () => {
  const view = await mount(body => body.action === "context" ? response(fixture) : response({ registrationUrl: "https://evil.example/events/forum" }));
  try {
    await until(() => document.querySelector("form"));
    await fillDelegate();
    await submit();
    await until(() => document.body.textContent.includes("could not be verified"));
    assert.equal(document.querySelector('a[target="_blank"]'), null);
    await submit();
    const creates = view.calls.filter(call => call.body.action === "register");
    assert.equal(creates.length, 2);
    assert.equal(creates[0].body.idempotencyKey, creates[1].body.idempotencyKey);
  } finally { await view.close(); }
});

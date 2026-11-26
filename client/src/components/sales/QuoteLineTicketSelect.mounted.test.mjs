import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "CustomEvent", "DocumentFragment"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
Object.assign(globalThis, {
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: callback => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const compiled = await build({
  stdin: {
    contents: 'export { default as Picker } from "./client/src/components/sales/QuoteEventSelect.jsx"; export { default as Allocation } from "./client/src/components/sales/QuoteLineTicketSelect.jsx";',
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
});
const filename = `${process.cwd()}/client/src/components/sales/ticket-picker-fixture.cjs`;
const mod = new Module(filename);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, filename);
const { Picker, Allocation } = mod.exports;
const h = React.createElement;
const wait = (ms = 30) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const future = { id: "future", kind: "complex", name: "Learning forum", eligible: true, ticketOptions: [{ id: "team", name: "Team pass", delegateCapacity: 4, isGroupTicket: true, groupSize: 4 }] };
const saved = { id: "saved", kind: "simple", name: "Previous forum", eligible: false, unavailableReason: "This event has ended.", ticketOptions: [{ id: "saved-team", name: "Saved team pass", delegateCapacity: 3 }] };
const reference = { kind: "simple", eventId: "saved", ticketTypeId: "saved-team" };

async function mount(Component, props) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = next => act(async () => root.render(h(QueryClientProvider, { client }, h(Component, next))));
  await render(props);
  await wait();
  return {
    host, render,
    close: async () => { await act(async () => root.unmount()); client.clear(); host.remove(); },
  };
}
const button = label => [...document.querySelectorAll("button")].find(el => el.getAttribute("aria-label") === label || el.textContent === label);
async function click(label) {
  assert.ok(button(label), label);
  await act(async () => button(label).click());
  await wait();
}
async function choose(name) {
  const option = [...document.querySelectorAll("[cmdk-item]")].find(el => el.textContent.includes(name));
  assert.ok(option, name);
  await act(async () => option.click());
  await wait();
}
after(() => dom.window.close());

test("ticket picker uses future-only paged search and prevents selecting ineligible events", async () => {
  const calls = [], changes = [];
  const fixture = await mount(Picker, {
    ticketOnly: true, value: undefined, request: async url => {
      calls.push(url);
      return { items: [future, saved], hasMore: !url.includes("page=2") };
    }, onChange: item => changes.push(item),
  });
  try {
    assert.equal(calls.length, 0, "no selected hydration or list request before opening");
    await click("Event");
    assert.match(calls.at(-1), /ticketEvents=true/);
    assert.doesNotMatch(calls.at(-1), /quoteEvents|excludePast/);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
    assert.match(document.body.textContent, /Only future events/);
    await choose("Previous forum");
    assert.deepEqual(changes, []);
    await click("Next events");
    assert.match(calls.at(-1), /page=2/);
    const input = document.querySelector('[aria-label="Search events"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "Learning");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await wait(300); await wait();
    assert.match(calls.at(-1), /search=Learning&page=1/);
    await choose("Learning forum");
    assert.equal(changes[0].kind, "complex");
    await click("Event");
    await choose("No event");
    assert.equal(changes[1], null);
  } finally { await fixture.close(); }
});

test("ticket line hydrates its event, preserves same-event choice and passes the chosen ticket terms", async () => {
  const calls = [], changes = [];
  function Harness() {
    const [eventReference, setReference] = React.useState(null);
    return h(Allocation, {
      line: { type: "ticket", quantity: 2, eventReference }, currency: "GBP", request: async url => {
        calls.push(url);
        return { items: [future], hasMore: false };
      },
      onChange: (next, ticket) => { changes.push([next, ticket]); setReference(next); },
    });
  }
  const fixture = await mount(Harness, {});
  try {
    assert.equal(calls.length, 0);
    assert.match(fixture.host.textContent, /description, price and VAT come from the ticket/);
    assert.doesNotMatch(fixture.host.textContent, /for this product/);
    await click("Event");
    await choose("Learning forum");
    assert.deepEqual(changes[0], [{ kind: "complex", eventId: "future", ticketTypeId: "" }, null]);
    assert.ok(calls.some(url => url.includes("ticketEvents=true&selectedId=future&kind=complex&currency=GBP")));
    await click("Event");
    await choose("Learning forum");
    assert.equal(changes.length, 1, "reselecting the current event does not clear tickets");
  } finally { await fixture.close(); }
});

test("a populated ticket selection survives event reselection and resets on a different event", async () => {
  const changes = [];
  function Harness() {
    const [eventReference, setReference] = React.useState({ kind: "complex", eventId: "future", ticketTypeId: "team" });
    return h(Allocation, {
      line: { quantity: 2, eventReference },
      request: async url => ({ items: url.includes("selectedId=") ? [future] : [future, { ...future, id: "another", name: "Next learning forum" }] }),
      onChange: next => { changes.push(next); setReference(next); },
    });
  }
  const fixture = await mount(Harness, {});
  try {
    assert.match(fixture.host.textContent, /Team pass/);
    assert.match(fixture.host.textContent, /2 tickets × 4 delegates per ticket = 8 places/);
    await click("Event");
    await choose("Learning forum");
    assert.deepEqual(changes, []);
    assert.match(fixture.host.textContent, /Team pass/);
    await click("Event");
    await choose("Next learning forum");
    assert.deepEqual(changes, [{ kind: "complex", eventId: "another", ticketTypeId: "" }]);
  } finally { await fixture.close(); }
});

test("saved ineligible allocation displays ticket and group capacity without mutating", async () => {
  const changes = [];
  const fixture = await mount(Allocation, {
    line: { quantity: 2, eventReference: reference },
    request: async () => ({ items: [saved] }), onChange: next => changes.push(next),
  });
  try {
    assert.match(fixture.host.textContent, /Previous forum/);
    assert.match(fixture.host.textContent, /Saved team pass/);
    assert.match(fixture.host.textContent, /This event has ended/);
    assert.match(fixture.host.textContent, /2 tickets × 3 delegates per ticket = 6 places/);
    assert.deepEqual(changes, []);
  } finally { await fixture.close(); }
});

test("loading and failed hydration retain saved reference and historical capacity fallback", async () => {
  const changes = [], calls = [];
  let reject;
  const fixture = await mount(Allocation, {
    disabled: true,
    line: { quantity: 3, eventReference: reference, catalogue_snapshot: { capacity_metadata: { delegate_capacity: 5 } } },
    request: url => { calls.push(url); return new Promise((resolve, fail) => { reject = fail; }); },
    onChange: next => changes.push(next),
  });
  try {
    assert.match(fixture.host.textContent, /Saved ticket type \(unavailable\)/);
    assert.match(fixture.host.textContent, /3 tickets × 5 delegates per ticket = 15 places/);
    await act(async () => reject(new Error("Ticket service unavailable")));
    await wait();
    assert.match(fixture.host.textContent, /Ticket service unavailable/);
    assert.match(fixture.host.textContent, /Saved ticket type \(unavailable\)/);
    assert.deepEqual(changes, []);
    await click("Retry ticket types");
    assert.ok(calls.length >= 3);
  } finally { await fixture.close(); }
});

test("default header mode retains quoteEvents and exclude-past toggle", async () => {
  const calls = [];
  const fixture = await mount(Picker, { value: null, request: async url => { calls.push(url); return { items: [], hasMore: false }; }, onChange: () => {} });
  try {
    await click("Event");
    assert.match(calls.at(-1), /quoteEvents=true/);
    assert.match(calls.at(-1), /excludePast=true/);
    assert.ok(document.querySelector('input[type="checkbox"]'));
  } finally { await fixture.close(); }
});

test("direct Ticket selection cannot clear its required event and resets type only for a different event", async () => {
  const changes = [];
  const fixture = await mount(Allocation, {
    line: { type: "ticket", quantity: 2, eventReference: { kind: "complex", eventId: "future", ticketTypeId: "team" } },
    request: async () => ({ items: [future, { ...future, id: "another", name: "Next learning forum" }] }),
    onChange: next => changes.push(next),
  });
  try {
    assert.match(fixture.host.textContent, /Event ticket/);
    assert.doesNotMatch(fixture.host.textContent, /for this product/);
    await click("Event"); await choose("No event");
    assert.deepEqual(changes, []);
    await click("Event"); await choose("Learning forum");
    assert.deepEqual(changes, []);
    await click("Event"); await choose("Next learning forum");
    assert.deepEqual(changes, [{ kind: "complex", eventId: "another", ticketTypeId: "" }]);
  } finally { await fixture.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test/events" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = (await import("react")).default;
const React = globalThis.React;
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Certificates } = await import("./EventCpdCertificatesSection.jsx");
const {
  emptyEventCpdCertificateConfig, remapEventCpdCertificateTicketReferences, putEventCpdCertificateRules,
} = await import("../../lib/eventCpdCertificateRules.js");

const templates = [
  { id: "active-template", name: "Course certificate", status: "active" },
  { id: "archived-template", name: "Old certificate", status: "archived", unavailable: true },
];
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

async function mount({ eventId = null, eventType = "simple", tickets = [], initial = null, onSnapshot = () => {}, remap = null }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Fixture() {
    const [config, setConfig] = useState(initial);
    const [shownTickets, setShownTickets] = useState(tickets);
    onSnapshot(config);
    return <>
      <Certificates eventId={eventId} eventType={eventType} tickets={shownTickets}
        eventDates={{ start_date: "2026-03-01T11:00:00Z", end_date: "2026-03-04T11:00:00Z", timezone: "Europe/London" }}
        value={config} onChange={setConfig} />
      <button type="button" data-testid="edit-draft" onClick={() => setConfig(previous => ({
        ...previous, eventRule: { ...previous.eventRule, template_id: "active-template" },
      }))}>Edit draft</button>
      <button type="button" data-testid="save-draft" disabled={!config} onClick={() =>
        putEventCpdCertificateRules(eventId || "event-1", eventType, config, shownTickets)
      }>Save draft</button>
      {remap && <button type="button" data-testid="persist-tickets" onClick={() => {
        setConfig(current => remapEventCpdCertificateTicketReferences(current, remap.references));
        setShownTickets(remap.tickets);
      }}>Persist tickets</button>}
    </>;
  }
  await act(async () => root.render(<Fixture />));
  return {
    container,
    click: async selector => act(async () => container.querySelector(selector).click()),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("create discovery preserves edits made while template discovery is pending", async () => {
  let resolveDiscovery;
  const requests = [];
  globalThis.fetch = (url) => {
    requests.push(url);
    return new Promise(resolve => { resolveDiscovery = resolve; });
  };
  let config;
  const view = await mount({ initial: emptyEventCpdCertificateConfig(), onSnapshot: value => { config = value; } });
  assert.match(requests[0], /event_type=simple/);
  assert.doesNotMatch(requests[0], /event_id=/);
  await view.click('[data-testid="edit-draft"]');
  await act(async () => resolveDiscovery(response({ config: emptyEventCpdCertificateConfig(), templates })));
  await tick();
  assert.equal(config.eventRule.template_id, "active-template");
  assert.match(view.container.textContent, /Course certificate · 1 March 2026 – 4 March 2026/);
  await view.cleanup();
});

test("edit hydration blocks save until GET resolves and flags archived selections without silently replacing them", async () => {
  let resolveLoad;
  const stored = emptyEventCpdCertificateConfig();
  stored.eventRule.template_id = "archived-template";
  stored.ticketRules.t1 = { template_mode: "none", template_id: null, date_mode: "inherit", start_date: null, end_date: null };
  globalThis.fetch = () => new Promise(resolve => { resolveLoad = resolve; });
  let config;
  const view = await mount({ eventId: "event-1", tickets: [{ id: "t1", name: "Member" }], onSnapshot: value => { config = value; } });
  assert.equal(view.container.querySelector('[data-testid="save-draft"]').disabled, true);
  await act(async () => resolveLoad(response({ config: stored, templates })));
  await tick();
  assert.equal(config.eventRule.template_id, "archived-template");
  assert.equal(config.ticketRules.t1.template_mode, "none");
  assert.equal(view.container.querySelector('[data-testid="save-draft"]').disabled, false);
  assert.match(view.container.textContent, /Old certificate/);
  assert.match(view.container.textContent, /template is unavailable/);
  assert.match(view.container.textContent, /Member/);
  await view.cleanup();
});

test("complex ticket remap saves hydrated draft, then a fresh mount reloads the persisted config", async () => {
  const requests = [];
  let persisted = emptyEventCpdCertificateConfig();
  const draft = emptyEventCpdCertificateConfig();
  draft.eventRule.template_id = "active-template";
  draft.ticketRules.local1 = {
    template_mode: "none", template_id: null, date_mode: "custom",
    start_date: "2026-02-02", end_date: "2026-02-03",
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (options?.method === "PUT") {
      persisted = JSON.parse(options.body).config;
      return response({ config: persisted });
    }
    return response({ config: persisted, templates });
  };
  const options = {
    eventType: "complex", tickets: [{ _localId: "local1", name: "Premium" }],
    initial: draft, remap: { references: { local1: "db1" }, tickets: [{ _dbId: "db1", name: "Premium" }] },
  };
  const view = await mount(options);
  await tick();
  // Simulate the complex-event editor persisting tickets and remapping the
  // in-progress draft before its independent certificate PUT.
  await view.click('[data-testid="persist-tickets"]');
  assert.ok(view.container.querySelector('[data-testid="certificate-ticket-db1"]'));
  await view.click('[data-testid="save-draft"]');
  assert.equal(requests.at(-1).options.method, "PUT");
  const sent = JSON.parse(requests.at(-1).options.body);
  assert.equal(sent.event_type, "complex");
  assert.deepEqual(Object.keys(sent.config.ticketRules), ["db1"]);
  assert.equal(sent.config.eventRule.template_id, "active-template");
  await view.cleanup();
  const reloaded = await mount({ ...options, eventId: "event-1", tickets: options.remap.tickets, remap: null, initial: null });
  await tick();
  assert.match(reloaded.container.textContent, /Premium/);
  assert.match(reloaded.container.textContent, /Course certificate · 1 March 2026 – 4 March 2026/);
  assert.equal(persisted.ticketRules.db1.date_mode, "custom");
  await reloaded.cleanup();
});

test("editing a mounted custom date field changes the effective formatted range and saved payload", async () => {
  let saved;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT") {
      saved = JSON.parse(options.body).config;
      return response({ config: saved });
    }
    return response({ config: emptyEventCpdCertificateConfig(), templates });
  };
  const initial = emptyEventCpdCertificateConfig();
  initial.eventRule = {
    template_id: "active-template", date_mode: "custom",
    start_date: "2026-05-10", end_date: "2026-05-11",
  };
  let config;
  const view = await mount({ initial, onSnapshot: value => { config = value; } });
  await tick();
  const input = view.container.querySelector('input[type="date"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "2026-05-08");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(config.eventRule.start_date, "2026-05-08");
  assert.match(view.container.textContent, /Course certificate · 8 May 2026 – 11 May 2026/);
  await view.click('[data-testid="save-draft"]');
  assert.equal(saved.eventRule.start_date, "2026-05-08");
  await view.cleanup();
});

test("an active template flagged unavailable is not treated as selectable or effective", async () => {
  const unavailable = [{ id: "missing-source", name: "Missing source PDF", status: "active", unavailable: true }];
  globalThis.fetch = async () => response({ config: emptyEventCpdCertificateConfig(), templates: unavailable });
  const initial = emptyEventCpdCertificateConfig();
  initial.eventRule.template_id = "missing-source";
  const view = await mount({ initial });
  await tick();
  assert.match(view.container.textContent, /Missing source PDF/);
  assert.match(view.container.textContent, /template is unavailable/);
  assert.match(view.container.textContent, /Certificate unavailable: template inactive/);
  await view.cleanup();
});
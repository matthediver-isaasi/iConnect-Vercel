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
  serverNow: new Date().toISOString(),
  settings: {
    terms: "<p>Booking terms</p><script>window.policyExecuted = true</script>",
    codeOfConduct: { required: true, content: "<p>Respect fellow attendees.</p>" },
    requireJobTitle: true, collectOptions: true,
  },
  allocations: [{
    id: "allocation-1", eventName: "Practice leadership forum", ticketName: "Delegate", eventKind: "simple", remaining: 3, registered: 1, allocated: 4,
    closesAt: null, closed: false, reason: null, timezone: "Europe/London",
    options: { dietary_options: ["Vegetarian"], allergy_options: ["Peanuts"], accessibility_options: ["Step-free access"] },
    slots: [],
  }],
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
  const input = document.getElementById(id) || document.querySelector(`[id$="-${id}"]`);
  assert.ok(input, `expected input ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fillDelegate(email = "asha@hawthorn.example") {
  await fill("first_name", "Asha");
  await fill("last_name", "Patel");
  await fill("email", email);
  await fill("job_title", "Practice manager");
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

test("only invalid_token context errors offer private, generic link renewal", async () => {
  let finishRenewal;
  let renewals = 0;
  const view = await mount(body => {
    if (body.action === "context") return response({ code: "invalid_token" }, 410);
    assert.deepEqual(body, { action: "renew", token: "private-fixture-token" });
    renewals++;
    if (renewals === 1) return new Promise(resolve => { finishRenewal = resolve; });
    return response({ message: "If this expired link can be renewed, a new link will be emailed to the original purchaser." });
  });
  try {
    await until(() => button("Request a new link"));
    const renewButton = button("Request a new link");
    await click(renewButton);
    assert.ok(button("Requesting new link…").disabled);
    await click(renewButton);
    assert.equal(renewals, 1);
    await act(async () => finishRenewal(response({ message: "Sensitive server error: private-fixture-token" }, 503)));
    await until(() => document.body.textContent.includes("We couldn’t request a new link."));
    assert.ok(!document.body.textContent.includes("Sensitive server error"));
    await click(button("Request a new link"));
    await until(() => document.body.textContent.includes("If this expired link can be renewed, a new link will be emailed to the original purchaser."));
    assert.equal(renewals, 2);
    assert.equal(document.querySelector("input"), null, "no email or token requested or displayed");
    assert.ok(!document.body.textContent.includes("private-fixture-token"));
    assert.equal(window.location.hash, "#token=private-fixture-token");
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
    assert.ok(view.calls.every(call => call.options.referrerPolicy === "no-referrer"));
  } finally { await view.close(); }
  for (const code of ["expired", "revoked"]) {
    const unavailable = await mount(() => response({ code }, 410));
    try {
      await until(() => document.body.textContent.includes("This link is no longer available"));
      assert.equal(button("Request a new link"), undefined);
    } finally { await unavailable.close(); }
  }
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

test("partial draft saves, completion acknowledgements, options, and amendments use slot versions", async () => {
  let current = structuredClone(fixture);
  const view = await mount(body => {
    if (body.action === "context") return response(current);
    const slot = { id: body.slotId, version: body.expectedVersion + 1, details: body.details, status: body.complete ? "registered" : "draft" };
    current = { ...current, allocations: [{ ...current.allocations[0], slots: [slot], remaining: 0, registered: body.complete ? 2 : 1 }] };
    return response(slot);
  });
  try {
    await until(() => button("Add attendee"));
    await click(button("Add attendee"));
    await fill("first_name", "Asha");
    await click(button("Save draft"));
    await until(() => document.body.textContent.includes("Draft saved."));
    const writes = () => view.calls.filter(call => call.body.action === "saveSlot");
    assert.equal(writes()[0].body.complete, false);
    assert.equal(writes()[0].body.expectedVersion, 0);
    assert.equal(writes()[0].body.details.last_name, "");
    assert.match(writes()[0].body.slotId, /^[0-9a-f-]{36}$/);
    await until(() => button("Refresh places") && !button("Refresh places").disabled);
    await fillDelegate();
    assert.ok(button("Complete registration").disabled, "both acknowledgements required");
    const check = text => [...document.querySelectorAll("label")].find(node => node.textContent.includes(text)).querySelector("input");
    await click(check("registration terms for this attendee"));
    assert.ok(button("Complete registration").disabled);
    await click(check("code of conduct for this attendee"));
    await click(check("Vegetarian"));
    await click(check("Peanuts"));
    await click(check("Step-free access"));
    const severity = document.querySelector("select");
    await act(async () => {
      severity.value = "severe";
      severity.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(window.policyExecuted, undefined);
    assert.equal(document.querySelector("script"), null);
    await submit();
    await until(() => button("Save registration changes"));
    assert.equal(writes()[1].body.complete, true);
    assert.equal(writes()[1].body.expectedVersion, 1);
    assert.equal(writes()[1].body.slotId, writes()[0].body.slotId);
    assert.equal(writes()[1].body.termsContent, fixture.settings.terms);
    assert.equal(writes()[1].body.codeOfConductAccepted, true);
    assert.deepEqual(writes()[1].body.details.allergy_selections, [{ name: "Peanuts", severity: "severe" }]);
    assert.deepEqual(writes()[1].body.details.dietary_selections, ["Vegetarian"]);
    assert.deepEqual(writes()[1].body.details.accessibility_selections, ["Step-free access"]);
    assert.equal(button("Save draft"), undefined, "registered slots cannot be demoted");
    await fill("phone", "020 7123 4556");
    await submit();
    await until(() => writes().length === 3 && button("Save registration changes") && !button("Save registration changes").disabled);
    assert.equal(writes()[2].body.expectedVersion, 2);
    assert.equal(writes()[2].body.complete, true);
    assert.equal(writes()[2].body.details.phone, "020 7123 4556");
    assert.ok(view.calls.filter(call => call.body.action === "context").length >= 4, "each save refreshes context");
    assert.equal(button("Add attendee"), undefined, "no new capacity but existing records remain editable");
  } finally { await view.close(); }
});

test("pending blocks duplicate saves; identical retries reuse commandId and deliberate changes reset it", async () => {
  let resolveFirst;
  let registrations = 0;
  const view = await mount(body => {
    if (body.action === "context") return response(fixture);
    registrations++;
    if (registrations === 1) return new Promise(resolve => { resolveFirst = resolve; });
    if (registrations === 2) return response({}, 503);
    return response({}, 503);
  });
  try {
    await until(() => button("Add attendee"));
    await click(button("Add attendee"));
    await fill("first_name", "Asha");
    const draftButton = button("Save draft");
    await click(draftButton);
    await click(draftButton);
    assert.equal(registrations, 1);
    assert.ok([...document.querySelectorAll("button")].filter(node => node.textContent === "Saving…").every(node => node.disabled));
    await act(async () => resolveFirst(response({}, 503)));
    await until(() => button("Save draft"));
    await click(button("Save draft"));
    await until(() => registrations === 2);
    const creates = () => view.calls.filter(call => call.body.action === "saveSlot");
    assert.deepEqual(creates()[0].body, creates()[1].body);
    await fill("email", "ren@hawthorn.example");
    await click(button("Save draft"));
    await until(() => creates().length === 3);
    assert.notEqual(creates()[1].body.commandId, creates()[2].body.commandId);
    assert.equal(creates()[1].body.slotId, creates()[2].body.slotId);
  } finally { await view.close(); }
});

test("deadlines are independent and server-derived; null deadline has no countdown", async () => {
  const time = Date.parse("2040-01-02T12:00:00Z");
  const slot = { id: "saved-attendee", version: 3, status: "registered", details: { first_name: "Mira", last_name: "Shah", email: "mira@example.test", job_title: "Lead" } };
  const view = await mount(() => response({
    ...fixture, serverNow: new Date(time).toISOString(),
    allocations: [
      { ...fixture.allocations[0], id: "closed", eventName: "Closed forum", closesAt: new Date(time - 1000).toISOString(), remaining: 0, slots: [slot] },
      { ...fixture.allocations[0], id: "closing", eventName: "Closing forum", closesAt: new Date(time + 1200).toISOString(), slots: [] },
      { ...fixture.allocations[0], id: "open", eventName: "Open forum" },
      { ...fixture.allocations[0], id: "manual", eventName: "Manual closure", closed: true, reason: "Roster finalised." },
    ],
  }));
  try {
    await until(() => document.querySelectorAll("section").length === 4);
    const [closed, closing, open, manual] = document.querySelectorAll("section");
    assert.match(closed.textContent, /read-only/);
    assert.ok(closed.querySelector("fieldset").disabled);
    assert.equal(closed.querySelector("button[type=submit]"), null);
    assert.ok(closing.querySelector('[role="timer"]'));
    assert.equal(open.querySelector('[role="timer"]'), null);
    assert.match(manual.textContent, /Roster finalised/);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
    assert.match(closing.textContent, /read-only/);
    assert.ok([...open.querySelectorAll("button")].some(node => node.textContent === "Add attendee"));
    assert.ok(!open.textContent.includes("read-only"));
    assert.equal(view.calls.filter(call => call.body.action !== "context").length, 0);
  } finally { await view.close(); }
});

test("refresh retains dirty details and explains legacy registrations", async () => {
  const slot = { id: "saved-attendee", version: 1, status: "draft", details: { first_name: "Original" } };
  let current = { ...fixture, allocations: [{ ...fixture.allocations[0], slots: [slot] }] };
  const view = await mount(() => response(current));
  try {
    await until(() => document.querySelector("form"));
    assert.match(document.body.textContent, /not available to edit in this workspace/);
    await fill("first_name", "Unsaved work");
    current = { ...current, allocations: [{ ...current.allocations[0], slots: [{ ...slot, version: 2, details: { first_name: "Remote edit" } }] }] };
    await click(button("Refresh places"));
    await until(() => button("Refresh places") && !button("Refresh places").disabled);
    assert.equal(document.querySelector('[id$="-first_name"]').value, "Unsaved work");
    assert.match(document.body.textContent, /Unsaved changes/);
    assert.equal(document.querySelector('a[target="_blank"]'), null);
    assert.ok(view.calls.every(call => call.body.action === "context"));
  } finally { await view.close(); }
});

test("member-group allocations use private attendee invitations with stable retries, not roster saves", async () => {
  const group = { ...fixture.allocations[0], id: "group-allocation", requiresSelfRegistration: true, remaining: 0, availableToAdd: 2 };
  let current = { ...fixture, branding: { name: "Hawthorn Events", primaryColor: "#125544" }, allocations: [group, { ...fixture.allocations[0], id: "ordinary-allocation" }] };
  let finishFirst;
  let registrations = 0;
  const view = await mount(body => {
    if (body.action === "context") return response(current);
    assert.equal(body.action, "register", "group flow must not call saveSlot");
    registrations++;
    if (registrations === 1) return new Promise(resolve => { finishFirst = resolve; });
    if (registrations === 2) return response({ registrationUrl: "https://elsewhere.test/events/forum" });
    if (registrations === 3) return response({ registrationUrl: "/events/forum?allocation=private-fixture-token" });
    current = { ...current, allocations: [{ ...group, availableToAdd: 0 }, current.allocations[1]] };
    return response({ registrationUrl: "/events/forum?allocation=attendee-only-link" });
  });
  let clipboardValue;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { clipboardValue = value; } } });
  try {
    await until(() => button("Create attendee registration link"));
    const section = document.querySelector("section");
    assert.match(section.textContent, /Group rules require attendees to register themselves/);
    assert.equal([...section.querySelectorAll("button")].find(node => node.textContent === "Add attendee"), undefined);
    assert.equal(section.querySelector('[id$="-job_title"]'), null);
    assert.match(document.querySelector("header").textContent, /Hawthorn Events/);
    await fill("invite-group-allocation-firstName", "Asha");
    await fill("invite-group-allocation-lastName", "Patel");
    await fill("invite-group-allocation-email", "asha@hawthorn.example");
    const create = button("Create attendee registration link");
    await click(create);
    await click(create);
    assert.equal(registrations, 1);
    assert.ok(button("Creating attendee link…").disabled);
    await act(async () => finishFirst(response({}, 503)));
    await until(() => button("Retry attendee link"));
    await click(button("Retry attendee link"));
    await until(() => section.textContent.includes("could not be verified"));
    assert.equal(document.querySelector('input[readonly]'), null);
    const writes = () => view.calls.filter(call => call.body.action === "register");
    assert.deepEqual(writes()[0].body, writes()[1].body);
    assert.deepEqual(Object.keys(writes()[0].body).sort(), ["action", "token", "allocationId", "firstName", "lastName", "email", "idempotencyKey"].sort());
    assert.equal(writes()[0].body.firstName, "Asha");
    assert.equal(writes()[0].body.lastName, "Patel");
    await click(button("Retry attendee link"));
    await until(() => writes().length === 3 && button("Retry attendee link"));
    assert.equal(writes()[1].body.idempotencyKey, writes()[2].body.idempotencyKey);
    assert.equal(document.querySelector('input[readonly]'), null, "purchaser credential must never be shown as an attendee link");
    await fill("invite-group-allocation-email", "ren@hawthorn.example");
    await click(button("Create attendee registration link"));
    await until(() => button("Copy attendee registration link"));
    assert.notEqual(writes()[2].body.idempotencyKey, writes()[3].body.idempotencyKey);
    const link = section.querySelector('input[readonly]');
    assert.equal(link.value, "https://tenant.example.test/events/forum?allocation=attendee-only-link");
    assert.match(section.textContent, /Asha Patel/);
    assert.match(section.textContent, /ren@hawthorn.example/);
    assert.match(section.textContent, /for this attendee only/);
    await click(button("Copy attendee registration link"));
    assert.equal(clipboardValue, link.value);
    assert.ok(!clipboardValue.includes("private-fixture-token"));
    await until(() => button("Refresh places") && !button("Refresh places").disabled);
    assert.ok(button("Invite another attendee").disabled);
    await click(button("Add attendee"));
    assert.ok(button("Save draft"), "ordinary allocation keeps roster editing");
    assert.ok(button("Complete registration"));
    assert.equal(window.location.hash, "#token=private-fixture-token");
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete navigator.clipboard;
    await view.close();
  }
});

test("group invitation creation respects closure and availableToAdd with remaining fallback", async () => {
  for (const changes of [
    { availableToAdd: 0, remaining: 3 },
    { closed: true, availableToAdd: 2 },
    { closesAt: "2039-12-31T12:00:00Z", availableToAdd: 2 },
    { remaining: 0 },
  ]) {
    const view = await mount(() => response({
      ...fixture, serverNow: "2040-01-02T12:00:00Z",
      allocations: [{ ...fixture.allocations[0], requiresSelfRegistration: true, ...changes }],
    }));
    try {
      await until(() => button("Create attendee registration link"));
      assert.ok(button("Create attendee registration link").disabled);
      assert.ok(document.querySelector("fieldset").disabled);
      await submit();
      assert.ok(view.calls.every(call => call.body.action === "context"));
    } finally { await view.close(); }
  }
  const view = await mount(() => response({ ...fixture, allocations: [{ ...fixture.allocations[0], requiresSelfRegistration: true }] }));
  try {
    await until(() => button("Create attendee registration link"));
    assert.equal(document.querySelector("fieldset").disabled, false, "remaining is used when availableToAdd is absent");
  } finally { await view.close(); }
});

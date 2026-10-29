import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eventEmailSurfaceFixtureSource } from "./eventEmailSurfaceFixtures.mjs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Mounted email-card fixtures: the JSX and edit save/reschedule handlers below
// come from the actual surfaces, not reimplementations. Unrelated event forms,
// auth, survey lookups, Quill and visual primitives are deliberately isolated.
// Creation orchestration is represented only by the existing putEventEmails
// helper after a synthetic event ID is assigned; no event/entity API is called.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/events" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "MutationObserver", "DocumentFragment"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
globalThis.emailFixtureToasts = [];
after(() => { globalThis.fetch = originalFetch; delete globalThis.emailFixtureToasts; dom.window.close(); });

const ui = `
import React, { createContext, useContext } from "react";
const Box = ({children, ...props}) => <div {...props}>{children}</div>;
export const Card = Box, CardHeader = Box, CardTitle = Box, CardContent = Box, CardDescription = Box;
export const Badge = ({children, variant, ...props}) => <span {...props}>{children}</span>;
export const Button = ({children, variant, size, ...props}) => <button {...props}>{children}</button>;
export const Input = props => <input {...props}/>;
export const Textarea = props => <textarea {...props}/>;
export const Label = props => <label {...props}/>;
export const Switch = ({checked, onCheckedChange, ...props}) => <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...props}/>;
export const Select = ({children, value, onValueChange}) => {
  const trigger = React.Children.toArray(children).find(child => child.props?.["data-testid"] || child.props?.id);
  return <select value={value} onChange={event => onValueChange(event.target.value)} data-testid={trigger?.props["data-testid"]} id={trigger?.props.id}>{children}</select>;
};
export const SelectTrigger = () => null, SelectValue = () => null;
export const SelectContent = ({children}) => <>{children}</>;
export const SelectItem = props => <option {...props}/>;
const DialogState = createContext(false);
export const Dialog = ({open, children}) => <DialogState.Provider value={open}>{open ? children : null}</DialogState.Provider>;
export const DialogContent = ({children, ...props}) => useContext(DialogState) ? <section role="dialog" {...props}>{children}</section> : null;
export const DialogHeader = Box, DialogTitle = Box, DialogDescription = Box;
`;
const bundle = await build({
  stdin: {
    contents: eventEmailSurfaceFixtureSource() + "\nexport {EventEmailSettingsEditor};",
    resolveDir: process.cwd(), sourcefile: "email-follow-up-fixtures.jsx", loader: "jsx",
  },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
  plugins: [{
    name: "email-fixture-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^(sonner|react-quill.*|@\/components\/ui\/.*|@\/components\/CampaignEventSurveySettings|@\/components\/events\/TimezoneAwareDateTimeInput)$/ },
        args => ({ path: args.path, namespace: "fixture" }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: `${process.cwd()}/client/src/${args.path.slice(2)}.jsx` }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({path}) => ({
        contents: path === "sonner" ? `export const toast = {success: message => globalThis.emailFixtureToasts.push(message), error: message => globalThis.emailFixtureToasts.push(message)};`
          : path.startsWith("@/components/ui/") ? ui
          : path.endsWith("TimezoneAwareDateTimeInput") ? `export const TimezoneAwareDateTimeInput = () => null;`
          : `export default () => null;`,
        loader: "jsx",
      }));
    },
  }],
});
const fixtureModule = new Module(`${process.cwd()}/email-follow-up-fixtures.cjs`);
fixtureModule.filename = `${process.cwd()}/email-follow-up-fixtures.cjs`;
fixtureModule.paths = Module._nodeModulePaths(process.cwd());
fixtureModule._compile(bundle.outputFiles[0].text, fixtureModule.filename);
const { createEmptyEmail, putEventEmails, getEmailRowLabel, ...surfaces } = fixtureModule.exports;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: {"Content-Type": "application/json"} });
const byId = id => document.querySelector(`[data-testid="${id}"]`);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const click = async element => { assert.ok(element); await act(async () => element.click()); await settle(); };
const change = async (element, value) => {
  assert.ok(element);
  await act(async () => {
    const prototype = element.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype
      : element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", {bubbles: true}));
  });
};
const rows = () => JSON.parse(byId("fixture-emails").textContent);
async function mount(Surface, props = {}, previewResponse = null, schedulingResult = null) {
  let saved = [], calls = [], previewHandler = previewResponse;
  globalThis.emailFixtureToasts = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({url, ...options, payload});
    if (url === "/api/event-emails/fixture-event" && options.method === "PUT") {
      saved = payload.emails.map((email, index) => ({...email, id: `saved-${index}`, isNew: false}));
      return json(saved);
    }
    if (/^\/api\/event-emails\/[^/]+\/preview$/.test(url) && options.method === "POST") {
      return previewHandler ? previewHandler(payload) : json({subject: "Thank you", html: "<p>Sample target</p>"});
    }
    if (url === "/api/event-emails/fixture-event/reschedule" && options.method === "POST") {
      return json(schedulingResult || {requeued: 3, bookingsScheduled: 2, preserved: 1, cancelled: 1});
    }
    assert.fail(`Unexpected transport: ${options.method} ${url}`);
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Surface, props)));
  return {
    calls, saved: () => saved,
    preview: handler => { previewHandler = handler; },
    render: async nextProps => { await act(async () => root.render(React.createElement(Surface, nextProps))); },
    cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

test("factories preserve legacy timing and default follow-ups independently; PUT validates and never schedules", async () => {
  assert.equal(createEmptyEmail("reminder").timing_type, "1_day_before");
  assert.equal(createEmptyEmail("booking_confirmation").timing_type, null);
  assert.match(createEmptyEmail("booking_confirmation", "session").body, /\{\{session_schedule\}\}/);
  const first = createEmptyEmail("follow_up"), second = createEmptyEmail("follow_up");
  assert.notEqual(first.id, second.id);
  assert.equal(first.follow_up_delay, 0);
  assert.equal(first.follow_up_unit, "hours");
  assert.equal(first.follow_up_scope, "event");
  assert.match(getEmailRowLabel(first), /Follow-up.*0 hours after event/);
  globalThis.fetch = () => assert.fail("Invalid input must not reach transport");
  for (const delay of [-1, Infinity, "not-a-number"]) {
    await assert.rejects(putEventEmails("fixture-event", [{...first, follow_up_delay: delay}]), /nonnegative/);
  }
  for (const invalid of [{follow_up_scope: "week"}, {follow_up_unit: "weeks"}]) {
    await assert.rejects(putEventEmails("fixture-event", [{...first, ...invalid}]), /invalid follow-up/);
  }
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    return json([]);
  };
  await putEventEmails("fixture-event", [{id: "old-follow-up", email_type: "follow_up"}]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body).emails[0], {
    id: "old-follow-up", email_type: "follow_up", follow_up_scope: "event", follow_up_delay: 0, follow_up_unit: "hours",
  });
});

for (const name of ["CreateEvent", "EditEvent", "CreateComplexEvent"]) {
  for (const editing of name === "CreateEvent" ? [false] : name === "EditEvent" ? [true] : [false, true]) {
    test(`${name} ${editing ? "edit" : "create"} card: independent configs, templates, save and reopen`, async () => {
      const Surface = surfaces[`${name}Fixture`];
      let fixture = await mount(Surface, {editing, programme: true, templates: [{id: "template-1", name: "Thank you note", subject: "A personal thank you", body: "Your session has ended."}]});
      try {
        await click(byId("button-add-follow-up-email"));
        await click(byId("button-add-follow-up-email"));
        const [first, second] = rows();
        await change(byId(`input-follow-up-delay-${first.id}`), "1.5");
        await change(byId(`select-follow-up-unit-${first.id}`), "days");
        await change(byId(`select-follow-up-scope-${first.id}`), "day");
        await change(byId(`select-template-${first.id}`), "template-1");
        await click(byId(`switch-email-enabled-${second.id}`));
        assert.equal(rows()[0].subject, "A personal thank you");
        assert.equal(rows()[1].follow_up_delay, 0);
        assert.equal(rows()[1].is_enabled, false);
        assert.match(document.body.textContent, /regardless of the attendee's ticket entitlement/);
        assert.match(document.body.textContent, /Overnight sessions belong to their start day/);
        assert.match(document.body.textContent, /separately timed daily programme entries/);
        assert.match(document.body.textContent, /\{\{follow_up_target\}\}.*\{\{follow_up_end\}\}.*\{\{follow_up_scope\}\}/s);
        assert.equal(fixture.calls.length, 0);
        await click(byId(editing ? "button-save-emails" : "fixture-create"));
        assert.equal(fixture.calls.length, 1);
        assert.equal(fixture.calls[0].method, "PUT");
        assert.equal(fixture.calls[0].payload.emails[0].follow_up_delay, 1.5);
        assert.equal(fixture.calls[0].payload.emails[0].follow_up_unit, "days");
        assert.equal(fixture.calls[0].payload.emails[0].follow_up_scope, "day");
        assert.equal(!!fixture.calls[0].payload.is_complex_event, name === "CreateComplexEvent");
        const saved = fixture.saved();
        await fixture.cleanup();
        const Reopen = name === "CreateComplexEvent" ? Surface : surfaces.EditEventFixture;
        fixture = await mount(Reopen, {editing: true, initial: saved, programme: true});
        assert.equal(byId("input-follow-up-delay-saved-0").value, "1.5");
        assert.equal(byId("select-follow-up-scope-saved-0").value, "day");
        assert.equal(rows()[1].is_enabled, false);
        await click(byId("button-requeue-reminders"));
        assert.equal(fixture.calls[0].url, "/api/event-emails/fixture-event/reschedule");
        assert.match(globalThis.emailFixtureToasts.at(-1), /reminder\/follow-up email/);
      } finally { await fixture.cleanup(); }
    });
  }
}

test("ordinary events offer after-event only; programme sessions stay separate from reminder timing", async () => {
  const fixture = await mount(surfaces.EditEventFixture, {initial: [createEmptyEmail("follow_up"), createEmptyEmail("reminder")]});
  try {
    const [followUp, reminder] = rows();
    assert.equal(byId(`select-follow-up-scope-${followUp.id}`).options.length, 1);
    assert.equal(byId(`select-timing-${reminder.id}`).value, "1_day_before");
    await click(byId("button-add-confirmation-email"));
    assert.equal(rows()[2].email_type, "booking_confirmation");
    await click(byId("button-save-emails"));
    assert.equal(fixture.calls[0].payload.emails[1].timing_type, "1_day_before");
    assert.equal(fixture.calls[0].payload.emails[1].follow_up_scope, undefined);
    for (const row of rows()) await click(byId(`button-remove-email-${row.id}`));
    await click(byId("button-save-emails"));
    assert.deepEqual(fixture.calls.at(-1).payload.emails, []);
  } finally { await fixture.cleanup(); }
});

test("preview uses target keys and sample ticket entitlement, including empty targets, warnings and retry", async () => {
  const email = {...createEmptyEmail("follow_up"), follow_up_scope: "session"};
  const target = key => ({sessionId: key, sessionDate: "2036-06-12T18:00:00Z", description: key});
  const fixture = await mount(surfaces.CreateComplexEventFixture, {editing: true, initial: [email]}, payload => json({
    subject: "Sample follow-up", html: "<p>Sample entitlement</p>",
    reminderContext: {
      isFollowUp: true, scope: "session", timezone: "Europe/London",
      ticketClasses: [{id: "ticket-a", name: "Single-track pass"}, {id: "ticket-b", name: "Full programme"}],
      selectedTicketClassId: payload.ticketClassId,
      entries: payload.ticketClassId ? [target("session:a"), target("session:b")] : [],
      selectedId: payload.ticketClassId ? payload.sessionId || "session:a" : null,
      sendAt: payload.ticketClassId ? "2036-06-12T19:00:00Z" : null,
      emptyReason: payload.ticketClassId ? null : "Choose a sample ticket class",
      warnings: [{reason: "Missing explicit end for another session"}],
    },
  }));
  try {
    await click(byId(`button-preview-email-${email.id}`));
    assert.equal(fixture.calls[0].payload.reminder.email_type, "follow_up");
    assert.equal(fixture.calls[0].payload.ticketClassId, null);
    assert.match(document.body.textContent, /Choose a sample ticket class/);
    assert.match(document.body.textContent, /Missing explicit end/);
    assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent, /Legacy date-only/);
    await change(document.getElementById("email-preview-ticket"), "ticket-b");
    assert.equal(fixture.calls.at(-1).payload.ticketClassId, "ticket-b");
    await change(document.getElementById("training-reminder-session"), "session:b");
    assert.equal(fixture.calls.at(-1).payload.sessionId, "session:b");
    assert.equal(fixture.calls.at(-1).payload.ticketClassId, "ticket-b");
    assert.match(byId("email-preview-frame").getAttribute("srcdoc"), /Sample entitlement/);
    assert.equal(byId("email-preview-frame").getAttribute("sandbox"), "");
    assert.ok(fixture.calls.every(call => call.url.endsWith("/preview")));
    fixture.preview(() => json({error: "Preview temporarily unavailable"}, 503));
    await change(document.getElementById("training-reminder-session"), "session:a");
    assert.match(byId("email-preview-error").textContent, /temporarily unavailable/);
    fixture.preview(() => json({subject: "Retry succeeded", html: "<p>Sample</p>"}));
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Retry preview"));
    assert.match(byId("email-preview-subject").textContent, /Retry succeeded/);
  } finally { await fixture.cleanup(); }
});

test("reschedule failure and skip results explicitly include follow-ups", async () => {
  for (const result of [
    {schedulingFailures: [{failed_booking_count: 2, reason: "Missing end"}]},
    {requeued: 0, skipped: [{reason: "Elapsed send time"}]},
  ]) {
    const fixture = await mount(surfaces.EditEventFixture, {initial: [createEmptyEmail("follow_up")]}, null, result);
    try {
      await click(byId("button-requeue-reminders"));
      assert.match(globalThis.emailFixtureToasts.at(-1), /follow-up/);
      assert.equal(fixture.calls.length, 1);
    } finally { await fixture.cleanup(); }
  }
});

test("legacy reminder preview retains agenda explanation and id selection", async () => {
  const email = createEmptyEmail("reminder");
  const fixture = await mount(surfaces.EditEventFixture, {initial: [email], programme: true}, payload => json({
    subject: "Reminder", html: "<p>Full agenda</p>",
    reminderContext: {
      timezone: "Europe/London",
      entries: [{id: "agenda-a", sessionDate: "2036-06-12T09:00:00Z", description: "First day", legacyTime: true},
        {id: "agenda-b", sessionDate: "2036-06-13T09:00:00Z", description: "Second day", legacyTime: true}],
      selectedId: payload.sessionId || "agenda-a", sendAt: null, warnings: [],
    },
  }));
  try {
    await click(byId(`button-preview-email-${email.id}`));
    assert.match(document.querySelector('[role="dialog"]').textContent, /Legacy date-only entries/);
    assert.match(document.querySelector('[role="dialog"]').textContent, /Not scheduled for this target/);
    assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent, /1970/);
    await change(document.getElementById("training-reminder-session"), "agenda-b");
    assert.equal(fixture.calls.at(-1).payload.sessionId, "agenda-b");
    assert.equal(fixture.calls.at(-1).payload.reminder.timing_type, "1_day_before");
  } finally { await fixture.cleanup(); }
});

test("preview loading and stale responses never overwrite the latest target", async () => {
  const email = createEmptyEmail("follow_up");
  let finishFirst;
  const fixture = await mount(surfaces.EditEventFixture, {initial: [email]}, () => new Promise(resolve => { finishFirst = resolve; }));
  try {
    await click(byId(`button-preview-email-${email.id}`));
    assert.ok(byId("email-preview-loading"));
    fixture.preview(() => json({subject: "Latest draft", html: "<p>Latest</p>"}));
    await click(byId(`button-preview-email-${email.id}`));
    assert.equal(byId("email-preview-subject").textContent, "Latest draft");
    await act(async () => finishFirst(json({subject: "Stale draft", html: "<p>Stale</p>"})));
    await settle();
    assert.equal(byId("email-preview-subject").textContent, "Latest draft");
  } finally { await fixture.cleanup(); }
});

const attendee = (id, first = "Priya") => ({
  id, attendee_first_name: first, attendee_last_name: "Shah", attendee_email: `${id}@example.test`,
});
const buttonNamed = text => [...document.querySelectorAll("button")].find(button => button.textContent.includes(text));
const selectAttendee = id => click(buttonNamed(`${id}@example.test`));
const previewResult = payload => ({
  subject: payload.bookingId ? `For ${payload.bookingId}` : "Sample",
  html: "<p>Preview only</p>",
  ...(payload.bookingId ? {attendee: {name: "Priya Shah", email: `${payload.bookingId}@example.test`}} : {}),
  previewNotice: "No Zoom registration is created.",
  reminderContext: {
    timezone: "Europe/London", selectedId: payload.sessionId || "agenda-a",
    entries: [{id: "agenda-a", description: "First session"}, {id: "agenda-b", description: "Second session"}],
  },
});

for (const type of ["booking_confirmation", "reminder"]) {
  test(`${type}: attendee preview keeps selection through target changes and retry; sample remains available`, async () => {
    const email = createEmptyEmail(type);
    let fail = false;
    const fixture = await mount(surfaces.EditEventFixture, {initial: [email]}, payload =>
      payload.action === "attendees" ? json({items: [attendee("booking-a")], hasMore: false})
        : fail ? json({error: "Temporarily unavailable"}, 503) : json(previewResult(payload)));
    try {
      await click(byId(`button-preview-email-${email.id}`));
      const sample = fixture.calls.find(call => !call.payload.action);
      assert.equal(sample.payload.bookingId, undefined);
      assert.match(document.body.textContent, /live Zoom join links are omitted/);
      await selectAttendee("booking-a");
      assert.equal(fixture.calls.at(-1).payload.bookingId, "booking-a");
      assert.match(byId("email-preview-attendee").textContent, /booking-a@example.test/);
      assert.match(byId("email-preview-notice").textContent, /No Zoom registration/);
      await change(document.getElementById("training-reminder-session"), "agenda-b");
      assert.equal(fixture.calls.at(-1).payload.bookingId, "booking-a");
      assert.equal(fixture.calls.at(-1).payload.sessionId, "agenda-b");
      fail = true;
      await change(document.getElementById("training-reminder-session"), "agenda-a");
      assert.ok(byId("email-preview-error"));
      assert.match(byId("email-preview-selected-attendee").textContent, /Priya Shah/);
      fail = false;
      await click(buttonNamed("Retry preview"));
      assert.equal(fixture.calls.at(-1).payload.bookingId, "booking-a");
      await click(buttonNamed("Use sample attendee"));
      assert.equal(fixture.calls.at(-1).payload.bookingId, undefined);
      assert.equal(byId("email-preview-selected-attendee"), null);
      assert.ok(fixture.calls.every(call => call.url.endsWith("/preview") && call.method === "POST"));
    } finally { await fixture.cleanup(); }
  });
}

test("attendee list searches, paginates and retries without losing the selection", async () => {
  const email = createEmptyEmail("reminder");
  let failMore = true;
  const fixture = await mount(surfaces.EditEventFixture, {initial: [email]}, payload => {
    if (!payload.action) return json(previewResult(payload));
    if (payload.search) return json({items: payload.search === "missing" ? [] : [attendee("booking-c", "Mara")], hasMore: false});
    if (payload.offset && failMore) return json({error: "Lookup temporarily unavailable"}, 503);
    return json({items: [attendee(payload.offset ? "booking-b" : "booking-a")], hasMore: !payload.offset});
  });
  try {
    await click(byId(`button-preview-email-${email.id}`));
    await selectAttendee("booking-a");
    await click(buttonNamed("Load more attendees"));
    assert.match(document.body.textContent, /Lookup temporarily unavailable/);
    assert.match(byId("email-preview-selected-attendee").textContent, /booking-a/);
    failMore = false;
    await click(buttonNamed("Retry attendees"));
    assert.equal(fixture.calls.at(-1).payload.offset, 1);
    assert.ok(buttonNamed("booking-a@example.test"));
    assert.ok(buttonNamed("booking-b@example.test"));
    assert.equal(buttonNamed("Load more attendees"), undefined);
    await change(document.getElementById("email-preview-attendee-search"), "Mara");
    assert.deepEqual(fixture.calls.at(-1).payload, {action: "attendees", search: "Mara", offset: 0});
    assert.equal(buttonNamed("booking-a@example.test"), undefined);
    assert.match(byId("email-preview-selected-attendee").textContent, /booking-a/);
    await selectAttendee("booking-c");
    assert.equal(fixture.calls.at(-1).payload.bookingId, "booking-c");
    await change(document.getElementById("email-preview-attendee-search"), "missing");
    assert.match(document.body.textContent, /No confirmed attendees match/);
    await click(buttonNamed("Use sample attendee"));
    assert.equal(fixture.calls.at(-1).payload.bookingId, undefined);
  } finally { await fixture.cleanup(); }
});

test("stale searches and preview renders cannot replace the latest attendee", async () => {
  const email = createEmptyEmail("booking_confirmation");
  let finishLookup, finishPreview;
  const fixture = await mount(surfaces.EditEventFixture, {initial: [email]}, payload => {
    if (payload.action) {
      if (payload.search === "old") return new Promise(resolve => { finishLookup = resolve; });
      return json({items: [attendee("booking-a"), attendee("booking-b", "Nadia")], hasMore: false});
    }
    if (payload.bookingId === "booking-a") return new Promise(resolve => { finishPreview = resolve; });
    return json(previewResult(payload));
  });
  try {
    await click(byId(`button-preview-email-${email.id}`));
    await change(document.getElementById("email-preview-attendee-search"), "old");
    await change(document.getElementById("email-preview-attendee-search"), "new");
    await act(async () => finishLookup(json({items: [attendee("stale")], hasMore: true})));
    assert.equal(buttonNamed("stale@example.test"), undefined);
    await selectAttendee("booking-a");
    assert.ok(byId("email-preview-loading"));
    await selectAttendee("booking-b");
    await act(async () => finishPreview(json({subject: "Stale attendee", html: "<p>Stale</p>"})));
    assert.equal(byId("email-preview-subject").textContent, "For booking-b");
    assert.match(byId("email-preview-selected-attendee").textContent, /Nadia/);
  } finally { await fixture.cleanup(); }
});

test("new email/event resets attendee; follow-ups never request attendee lookup", async () => {
  const first = createEmptyEmail("reminder"), second = createEmptyEmail("booking_confirmation"), followUp = createEmptyEmail("follow_up");
  const props = {emails: [first, second, followUp], setEmails: () => {}, eventId: "fixture-event"};
  const fixture = await mount(surfaces.EventEmailSettingsEditor, props, payload =>
    payload.action ? json({items: [attendee("booking-a")], hasMore: false}) : json(previewResult(payload)));
  try {
    await click(byId(`button-preview-email-${first.id}`));
    await selectAttendee("booking-a");
    await click(byId(`button-preview-email-${second.id}`));
    assert.equal(byId("email-preview-selected-attendee"), null);
    assert.equal(fixture.calls.filter(call => !call.payload.action).at(-1).payload.bookingId, undefined);
    await selectAttendee("booking-a");
    await fixture.render({...props, eventId: "another-event"});
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await click(byId(`button-preview-email-${first.id}`));
    assert.equal(byId("email-preview-selected-attendee"), null);
    assert.ok(fixture.calls.at(-1).url.includes("/another-event/"));
    const count = fixture.calls.length;
    await click(byId(`button-preview-email-${followUp.id}`));
    assert.equal(fixture.calls.length, count + 1);
    assert.equal(document.getElementById("email-preview-attendee-search"), null);
    assert.equal(fixture.calls.at(-1).payload.bookingId, undefined);
  } finally { await fixture.cleanup(); }
});

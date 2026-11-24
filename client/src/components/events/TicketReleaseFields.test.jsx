import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import ts from "typescript";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const {
  default: TicketReleaseFields, hydrateTicketRelease, serializeTicketRelease,
  ticketReleaseError, validateTicketReleases,
} = await import("./TicketReleaseFields.jsx");
const {
  TimezoneAwareDateTimeInput, resolveStrictLocalDateTime, dateTimeLocalToIso,
} = await import("./TimezoneAwareDateTimeInput.jsx");
after(() => dom.window.close());

async function mountTicket(initial = {}, eventTimezone) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current;
  let setEventTimezone;
  let setVisible;
  function Harness() {
    const [ticket, setTicket] = React.useState({ id: "ticket", ...hydrateTicketRelease(), ...initial });
    const [timezone, updateTimezone] = React.useState(eventTimezone);
    const [visible, updateVisible] = React.useState(true);
    current = ticket;
    setEventTimezone = updateTimezone;
    setVisible = updateVisible;
    return visible && <TicketReleaseFields ticket={ticket} eventTimezone={timezone}
      onChange={patch => setTicket(previous => ({ ...previous, ...patch }))} />;
  }
  await act(async () => root.render(<Harness />));
  return {
    container,
    ticket: () => current,
    timezone: value => act(async () => setEventTimezone(value)),
    visible: value => act(async () => setVisible(value)),
    async click(selector) {
      const element = container.querySelector(selector);
      assert.ok(element, selector);
      await act(async () => element.click());
    },
    async date(value, selector = 'input[type="datetime-local"]') {
      const input = container.querySelector(selector);
      assert.ok(input);
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("strict resolver rejects DST gaps and requires choice for overlaps, including half-hour DST", () => {
  assert.equal(resolveStrictLocalDateTime("2026-03-29T01:30", "Europe/London").candidates.length, 0);
  assert.match(resolveStrictLocalDateTime("2026-03-29T01:30", "Europe/London").error, /does not exist/);
  assert.deepEqual(resolveStrictLocalDateTime("2026-10-25T01:30", "Europe/London").candidates, [
    "2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z",
  ]);
  assert.equal(resolveStrictLocalDateTime("2026-04-05T01:45", "Australia/Lord_Howe").candidates.length, 2);
  assert.equal(resolveStrictLocalDateTime("2026-10-04T02:15", "Australia/Lord_Howe").candidates.length, 0);
  assert.equal(resolveStrictLocalDateTime("2026-02-30T12:00", "Europe/London").candidates.length, 0);
  assert.equal(resolveStrictLocalDateTime("2026-06-10T12:00", "Invalid/Zone").candidates.length, 0);
  assert.deepEqual(resolveStrictLocalDateTime("2026-06-10T12:00", "Asia/Kolkata").candidates, ["2026-06-10T06:30:00.000Z"]);
});

test("legacy timezone conversion remains unchanged unless strict mode is opted in", async () => {
  assert.ok(dateTimeLocalToIso("2026-03-29T01:30", "Europe/London"));
  const container = document.createElement("div");
  const root = createRoot(container);
  let result;
  await act(async () => root.render(<TimezoneAwareDateTimeInput tz="Europe/London"
    value="2026-06-10T11:00:00.000Z" onChange={iso => { result = iso; }} />));
  const input = container.querySelector("input");
  assert.equal(input.value, "2026-06-10T12:00");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "2026-06-10T13:00");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(result, "2026-06-10T12:00:00.000Z");
  await act(async () => root.unmount());
});

test("hydrate and serialize preserve saved release timezone and normalize explicit offsets to UTC", () => {
  const noClose = { close_at: null, close_timezone: null };
  assert.deepEqual(serializeTicketRelease(hydrateTicketRelease()), { release_at: null, release_timezone: null, ...noClose });
  const saved = { release_at: "2026-10-25T01:30:00+01:00", release_timezone: "Europe/London" };
  assert.deepEqual(hydrateTicketRelease(saved), { ...saved, ...noClose });
  assert.deepEqual(serializeTicketRelease(saved), { release_at: "2026-10-25T00:30:00.000Z", release_timezone: "Europe/London", ...noClose });
  for (const invalid of [
    { release_at: saved.release_at },
    { release_timezone: saved.release_timezone },
    { ...saved, release_at: "2026-10-25T01:30:00" },
    { ...saved, release_at: "2026-02-30T01:30:00Z" },
    { ...saved, release_timezone: "Invalid/Zone" },
    { ...saved, release_timezone: "GMT" },
    { ...saved, _releaseError: "Unresolved pending input" },
  ]) {
    assert.equal(validateTicketReleases([invalid]).length, 1);
    assert.throws(() => serializeTicketRelease(invalid));
  }
});

test("enabling defaults timezone, freezes it against event changes, and clearing serializes both null", async () => {
  for (const [eventTimezone, expected] of [[undefined, "Europe/London"], ["Asia/Tokyo", "Asia/Tokyo"]]) {
    const ui = await mountTicket({}, eventTimezone);
    try {
      await ui.click('[role="switch"]');
      assert.equal(ui.ticket().release_timezone, expected);
      assert.ok(ticketReleaseError(ui.ticket()), "enabled without a date must block save");
      await ui.timezone("America/New_York");
      assert.equal(ui.ticket().release_timezone, expected);
      await ui.date("2026-06-10T12:00");
      assert.equal(ticketReleaseError(ui.ticket()), "");
      await ui.click('[role="switch"]');
      assert.deepEqual(serializeTicketRelease(ui.ticket()), { release_at: null, release_timezone: null, close_at: null, close_timezone: null });
    } finally { await ui.close(); }
  }
});

test("timezone changes preserve saved instant and saved timezone is not replaced on hydration", async () => {
  const ui = await mountTicket({ release_at: "2026-10-25T00:30:00.000Z", release_timezone: "Europe/London" }, "Asia/Tokyo");
  try {
    assert.equal(ui.container.querySelector('input[type="datetime-local"]').value, "2026-10-25T01:30");
    assert.equal(ui.container.querySelectorAll('input[type="radio"]').length, 0, "persisted occurrence is already resolved");
    assert.equal(ticketReleaseError(ui.ticket()), "");
    await ui.click('[role="combobox"]');
    await ui.click('[data-testid="option-timezone-America/New_York"]');
    assert.equal(ui.ticket().release_at, "2026-10-25T00:30:00.000Z");
    assert.equal(ui.ticket().release_timezone, "America/New_York");
    assert.equal(ui.container.querySelector('input[type="datetime-local"]').value, "2026-10-24T20:30");
  } finally { await ui.close(); }
});

test("pending gap/overlap/cleared inputs block save even when collapsed; overlap needs explicit occurrence", async () => {
  const ui = await mountTicket({ release_at: "2026-06-10T11:00:00.000Z", release_timezone: "Europe/London" });
  try {
    await ui.date("2026-03-29T01:30");
    assert.equal(ui.ticket().release_at, null, "never keep stale valid instant");
    assert.match(ticketReleaseError(ui.ticket()), /does not exist/);
    await ui.visible(false);
    assert.throws(() => serializeTicketRelease(ui.ticket()));
    await ui.visible(true);
    assert.equal(ui.container.querySelector('input[type="datetime-local"]').value, "2026-03-29T01:30");
    await ui.date("2026-10-25T01:30");
    assert.match(ticketReleaseError(ui.ticket()), /occurs twice/);
    assert.equal(ui.container.querySelectorAll('input[type="radio"]').length, 2);
    assert.throws(() => serializeTicketRelease(ui.ticket()));
    await ui.click('input[type="radio"][value="2026-10-25T01:30:00.000Z"]');
    assert.equal(ticketReleaseError(ui.ticket()), "");
    assert.equal(serializeTicketRelease(ui.ticket()).release_at, "2026-10-25T01:30:00.000Z");
    await ui.date("");
    assert.ok(ticketReleaseError(ui.ticket()));
    assert.equal(ui.ticket().release_at, null);
    await ui.click('[role="switch"]');
    assert.deepEqual(validateTicketReleases([ui.ticket()]), []);
    assert.deepEqual(serializeTicketRelease(ui.ticket()), { release_at: null, release_timezone: null, close_at: null, close_timezone: null });
  } finally { await ui.close(); }
});

test("auto close is optional, independently enabled, frozen against event timezone changes, and explicitly cleared", async () => {
  for (const [eventTimezone, expected] of [[undefined, "Europe/London"], ["Asia/Tokyo", "Asia/Tokyo"]]) {
    const ui = await mountTicket({}, eventTimezone);
    try {
      assert.equal(ui.ticket().close_at, null, "no invented deadline");
      await ui.click('[data-testid="switch-ticket-close-ticket"]');
      assert.equal(ui.ticket().close_timezone, expected);
      assert.equal(ui.ticket().release_timezone, null, "close never enables release");
      assert.match(ticketReleaseError(ui.ticket()), /auto close/);
      assert.throws(() => serializeTicketRelease(ui.ticket()));
      await ui.timezone("America/New_York");
      assert.equal(ui.ticket().close_timezone, expected);
      await ui.date("2026-06-10T12:00", '[data-testid="input-ticket-close-ticket"]');
      assert.equal(ticketReleaseError(ui.ticket()), "");
      assert.ok(serializeTicketRelease(ui.ticket()).close_at);
      await ui.click('[data-testid="switch-ticket-close-ticket"]');
      assert.equal(ui.ticket()._closeLocalValue, undefined);
      assert.equal(ui.ticket()._closeError, "");
      assert.deepEqual(serializeTicketRelease(ui.ticket()), {
        release_at: null, release_timezone: null, close_at: null, close_timezone: null,
      });
    } finally { await ui.close(); }
  }
});

test("auto close hydration and timezone edits preserve its instant and do not alter release", async () => {
  const saved = {
    release_at: "2026-06-10T11:00:00.000Z", release_timezone: "Europe/London",
    close_at: "2026-10-25T01:30:00+01:00", close_timezone: "Europe/London",
  };
  assert.deepEqual(hydrateTicketRelease(saved), saved);
  assert.equal(serializeTicketRelease(saved).close_at, "2026-10-25T00:30:00.000Z");
  const ui = await mountTicket(saved, "Asia/Tokyo");
  try {
    const input = () => ui.container.querySelector('[data-testid="input-ticket-close-ticket"]');
    assert.equal(input().value, "2026-10-25T01:30");
    assert.equal(ui.container.querySelectorAll('input[type="radio"]').length, 0);
    await ui.click('[data-testid="ticket-close-ticket"] [role="combobox"]');
    await ui.click('[data-testid="option-timezone-America/New_York"]');
    assert.equal(ui.ticket().close_at, saved.close_at);
    assert.equal(ui.ticket().close_timezone, "America/New_York");
    assert.equal(input().value, "2026-10-24T20:30");
    assert.equal(ui.ticket().release_at, saved.release_at);
    assert.equal(ui.ticket().release_timezone, saved.release_timezone);
  } finally { await ui.close(); }
});

test("auto close DST gaps, overlaps and cleared input block serialization even after unmount", async () => {
  const ui = await mountTicket({ close_at: "2026-06-10T11:00:00.000Z", close_timezone: "Europe/London" });
  const selector = '[data-testid="input-ticket-close-ticket"]';
  try {
    await ui.date("2026-03-29T01:30", selector);
    assert.equal(ui.ticket().close_at, null);
    assert.match(ticketReleaseError(ui.ticket()), /does not exist/);
    await ui.visible(false);
    assert.throws(() => serializeTicketRelease(ui.ticket()));
    await ui.visible(true);
    assert.equal(ui.container.querySelector(selector).value, "2026-03-29T01:30");
    await ui.date("2026-10-25T01:30", selector);
    assert.match(ticketReleaseError(ui.ticket()), /occurs twice/);
    assert.equal(validateTicketReleases([ui.ticket()]).length, 1);
    await ui.click('input[type="radio"][value="2026-10-25T01:30:00.000Z"]');
    assert.equal(serializeTicketRelease(ui.ticket()).close_at, "2026-10-25T01:30:00.000Z");
    await ui.date("", selector);
    assert.ok(ticketReleaseError(ui.ticket()));
    await ui.click('[data-testid="switch-ticket-close-ticket"]');
    assert.deepEqual(validateTicketReleases([ui.ticket()]), []);
  } finally { await ui.close(); }
});

test("changing close timezone clears unresolved wall-clock input without resolving it", async () => {
  const ui = await mountTicket({ close_timezone: "Europe/London" });
  try {
    await ui.date("2026-10-25T01:30", '[data-testid="input-ticket-close-ticket"]');
    await ui.click('[data-testid="ticket-close-ticket"] [role="combobox"]');
    await ui.click('[data-testid="option-timezone-America/New_York"]');
    assert.equal(ui.ticket().close_at, null);
    assert.equal(ui.ticket()._closeLocalValue, undefined);
    assert.equal(ui.ticket()._closeError, "");
    assert.equal(ui.container.querySelector('[data-testid="input-ticket-close-ticket"]').value, "");
    assert.throws(() => serializeTicketRelease(ui.ticket()));
  } finally { await ui.close(); }
});

test("close validation rejects malformed schedules and close times at or before release", () => {
  const close = { close_at: "2026-06-10T12:00:00Z", close_timezone: "Europe/London" };
  for (const invalid of [
    { close_at: close.close_at },
    { close_timezone: close.close_timezone },
    { ...close, close_at: "2026-06-10T12:00" },
    { ...close, close_at: "2026-02-30T12:00:00Z" },
    { ...close, close_timezone: "Invalid/Zone" },
    { ...close, close_timezone: "GMT" },
    { ...close, _closeError: "Unresolved pending input" },
    { ...close, release_at: close.close_at, release_timezone: "UTC" },
    { ...close, release_at: "2026-06-10T13:00:00Z", release_timezone: "UTC" },
  ]) {
    assert.ok(ticketReleaseError(invalid));
    assert.equal(validateTicketReleases([{ ...invalid, name: "Member admission" }]).length, 1);
    assert.throws(() => serializeTicketRelease(invalid));
  }
  assert.equal(ticketReleaseError({
    ...close, release_at: "2026-06-10T11:59:00Z", release_timezone: "UTC",
  }), "");
});

test("all active editors wire hydration, pre-save validation, and serialization and parse as JSX", () => {
  for (const file of ["CreateEvent", "EditEvent", "CreateComplexEvent"]) {
    const source = readFileSync(new URL(`../../pages/${file}.jsx`, import.meta.url), "utf8");
    assert.match(source, /<TicketReleaseFields/);
    assert.match(source, /\.\.\.hydrateTicketRelease\(/);
    assert.match(source, /\.\.\.serializeTicketRelease\(ticket\)/);
    assert.match(source, /validateTicketReleases\(/);
    if (file !== "CreateEvent") assert.match(source, /\.\.\.hydrateTicketRelease\(tc\)/);
    const compiled = ts.transpileModule(source, {
      fileName: `${file}.jsx`, reportDiagnostics: true,
      compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    });
    assert.deepEqual(compiled.diagnostics, [], `${file} syntax`);
  }
});
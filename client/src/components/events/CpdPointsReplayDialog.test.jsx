import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { canConfirmCpdPreview, cpdRegistrationIdentity, cpdRegistrationKey } from "../../lib/cpdPointsReplay.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test/report" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "NodeFilter", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID } });
globalThis.React = (await import("react")).default;
const React = globalThis.React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { default: ReplayDialog } = await import("./CpdPointsReplayDialog.jsx");
const identity = { booking_id: "booking-1", booking_source: "standard", event_id: "event-1" };
const scope = { mode: "selected", registrations: [identity] };
const row = { ...identity, attendee_name: "Example Attendee", rule: { id: "rule-1", points: "1.5", trigger: "registration" }, trigger: "registration", proposed_points: "1.5", outcome: "eligible" };
const preview = { rows: [row], totals: { registrations: 1, eligible: 1, proposed_points: "1.5" }, complete: true, preview_token: "approved-preview", cursor: null };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const button = name => [...document.querySelectorAll("button")].find(item => item.textContent === name);
const click = name => act(async () => button(name).click());
async function reason(value = "Recover missing awards") {
  await act(async () => {
    const input = document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function mount(props = {}, strict = false) {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let invalidations = 0;
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = options => { if (options?.predicate) invalidations++; return invalidate(options); };
  const content = <QueryClientProvider client={client}><ReplayDialog scope={scope} scopeLabel="One selected registration" onClose={() => {}} {...props} /></QueryClientProvider>;
  await act(async () => root.render(strict ? <React.StrictMode>{content}</React.StrictMode> : content));
  return { invalidations: () => invalidations, cleanup: async () => { await act(async () => root.unmount()); node.remove(); client.clear(); } };
}

test("stable identity includes source and event, and incomplete/duplicate/error previews cannot confirm", () => {
  const standard = cpdRegistrationIdentity({ id: "same" }, { eventId: "a", bookingSource: "booking" });
  const complex = cpdRegistrationIdentity({ id: "same" }, { eventId: "a", bookingSource: "complex_event_booking" });
  assert.notEqual(cpdRegistrationKey(standard), cpdRegistrationKey(complex));
  assert.notEqual(cpdRegistrationKey(standard), cpdRegistrationKey({ ...standard, event_id: "b" }));
  assert.equal(canConfirmCpdPreview(preview, [row]), true);
  for (const value of [{ ...preview, complete: false }, { ...preview, preview_token: null }, { ...preview, totals: { eligible: 0, registrations: 1 } }]) assert.equal(canConfirmCpdPreview(value, [row]), false);
  assert.equal(canConfirmCpdPreview(preview, [{ ...row, outcome: "evaluation_error" }]), false);
  assert.equal(canConfirmCpdPreview({ ...preview, totals: { registrations: 2, eligible: 2 } }, [row, row]), false);
});

test("opening performs only preview; reason required; queued results are not award success", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ url, body });
    if (body?.action === "preview") return json(preview);
    if (body?.action === "confirm") return json({ replay_id: "replay-1", enqueued_count: 1 }, 202);
    return json({ replay_id: "replay-1", reason: "Recover", rows: [{ ...identity, status: "pending", points: "0" }], page: 1, total: 1, complete: false,
      totals: { registrations: 1, pending: 1, awarded: 0, unchanged: 0, retrying: 0, failed: 0, awarded_points: "0" } });
  };
  const view = await mount();
  try {
    await tick();
    assert.deepEqual(calls.map(item => item.body.action), ["preview"]);
    assert.deepEqual(calls[0].body.scope, scope);
    assert.equal(button("Confirm reprocessing").disabled, true);
    await reason();
    await click("Confirm reprocessing");
    await tick();
    assert.equal(calls[1].body.confirmed, true);
    assert.equal(calls[1].body.preview_token, preview.preview_token);
    assert.match(document.body.textContent, /have not been awarded yet/);
    assert.equal(view.invalidations(), 0);
  } finally { await view.cleanup(); }
});

test("ambiguous confirmation retry reuses request and reason; stale response requires new review", async () => {
  const confirmations = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "preview") return json(preview);
    confirmations.push(body);
    return json({ error: "Ambiguous network response" }, confirmations.length === 1 ? 503 : 409);
  };
  const view = await mount();
  try {
    await tick();
    await reason();
    await click("Confirm reprocessing");
    assert.equal(document.querySelector("textarea").disabled, true);
    await click("Retry confirmation safely");
    assert.deepEqual(confirmations[0], confirmations[1]);
    assert.match(document.body.textContent, /no longer current/);
    assert.equal(button("Confirm reprocessing"), undefined);
    await click("Run a new read-only preview");
    assert.equal(document.querySelector("textarea").value, "");
  } finally { await view.cleanup(); }
});

test("preview automatically traverses bounded pages, aggregates unique rows and stops after errors", async () => {
  let count = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    count++;
    if (count > 1) assert.equal(body.cursor, `cursor-${count - 1}`);
    return json({ rows: [{ ...row, booking_id: String(count) }], totals: { registrations: count, eligible: count, proposed_points: String(count) }, cursor: `cursor-${count}`, complete: false, preview_token: null });
  };
  const view = await mount();
  try {
    await tick();
    assert.equal(count, 20);
    assert.match(document.body.textContent, /Preview incomplete/);
    assert.equal(button("Confirm reprocessing"), undefined);
    globalThis.fetch = async () => json({ error: "Provider unavailable" }, 503);
    await click("Continue read-only preview");
    assert.match(document.body.textContent, /Provider unavailable/);
    assert.equal(button("Confirm reprocessing"), undefined);
  } finally { await view.cleanup(); }
});

test("reopening uses server results and invalidates caches only on genuine awards", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return json({ rows: [{ ...identity, attendee_name: "Example Attendee", status: "awarded", points: "1.5" }], reason: "Recovered", complete: true, total: 1,
      totals: { registrations: 1, pending: 0, awarded: 1, unchanged: 0, retrying: 0, failed: 0, awarded_points: "1.5" } });
  };
  const view = await mount({ replayId: "durable-replay-id" });
  try {
    await tick();
    assert.match(calls[0].url, /replay_id=durable-replay-id/);
    assert.equal(calls[0].options.method, undefined);
    assert.equal(view.invalidations(), 1);
    await click("Refresh results");
    assert.equal(view.invalidations(), 1);
    assert.match(document.body.textContent, /Processing finished/);
  } finally { await view.cleanup(); }
});

test("failed evaluation retains registration error rows and requires a fresh review", async () => {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return json({
      rows: [{ ...row, outcome: "evaluation_error", detail: "Attendance provider unavailable", proposed_points: "0" }],
      totals: { registrations: 1, eligible: 0, proposed_points: "0" },
      complete: false, evaluation_failed: true, error: "Evaluation failed; start a new preview.",
      cursor: null, preview_token: null,
    });
  };
  const view = await mount();
  try {
    await tick();
    assert.match(document.body.textContent, /Example Attendee/);
    assert.match(document.body.textContent, /Evaluation error/);
    assert.match(document.body.textContent, /Attendance provider unavailable/);
    assert.match(document.body.textContent, /Evaluation failed; start a new preview/);
    assert.equal(button("Confirm reprocessing"), undefined);
    assert.equal(button("Continue read-only preview"), undefined);
    assert.ok(button("Run a new read-only preview"));
    assert.deepEqual(calls.map(call => call.action), ["preview"]);
    await click("Run a new read-only preview");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].cursor, undefined);
    assert.equal(document.querySelectorAll("tbody tr").length, 1, "fresh review replaces failed rows");
  } finally { await view.cleanup(); }
});

test("unmatched attendee member explains why points cannot be confirmed without substituting purchaser", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).action, "preview");
    calls++;
    return json({
      rows: [{ ...row, outcome: "unmatched_member", proposed_points: "0" }],
      totals: { registrations: 1, eligible: 0, proposed_points: "0" },
      complete: true, preview_token: null, cursor: null,
    });
  };
  const view = await mount();
  try {
    await tick();
    assert.match(document.querySelector("[data-testid=cpd-unmatched-member-guidance]").textContent, /attendee email/);
    assert.match(document.body.textContent, /purchaser.*not a substitute/);
    assert.equal(button("Confirm reprocessing"), undefined);
    assert.equal(calls, 1, "unmatched preview makes no confirmation request");
  } finally { await view.cleanup(); }
});

test("strict-mode remount still produces a complete read-only preview", async () => {
  globalThis.fetch = async () => json(preview);
  const view = await mount({}, true);
  try {
    await tick();
    assert.match(document.body.textContent, /Preview complete/);
    assert.ok(button("Confirm reprocessing"));
  } finally { await view.cleanup(); }
});

const checkbox = label => [...document.querySelectorAll("label")].find(node => node.textContent === label)?.querySelector("input");
const toggle = label => act(async () => checkbox(label).click());
const certificateOption = "Send/resend CPD certificate emails";

test("zero-new-points explanations and outcome counts preserve the distinction from earned points", async () => {
  const outcomes = ["already_awarded", "registration_only_hold", "no_rule", "missing_attendance"];
  globalThis.fetch = async () => json({
    ...preview, preview_token: null,
    rows: outcomes.map((outcome, index) => ({ ...row, booking_id: `booking-${index}`, outcome, proposed_points: "0" })),
    totals: { registrations: 4, eligible: 0, proposed_points: "0" },
  });
  const view = await mount();
  try {
    await tick();
    assert.match(document.body.textContent, /0 additional \/ new points/);
    assert.doesNotMatch(document.body.textContent, /Proposed points|registration_only_hold/);
    assert.match(document.body.textContent, /does not mean zero points were earned/);
    assert.match(document.body.textContent, /administrator must review and authorise release/);
    const counts = document.querySelector('[aria-label="Preview outcome counts"]');
    assert.match(counts.textContent, /Already awarded:1/);
    assert.match(counts.textContent, /Imported registration on hold:1/);
    assert.match(document.body.textContent, /qualifying verified attendance is required/);
    assert.equal(button("Confirm reprocessing"), undefined);
    assert.ok(checkbox(certificateOption), "follow-up options remain available with no additional points");
  } finally { await view.cleanup(); }
});

test("certificate option exposes real selected-attendee PDF; preview never sends or awards; deliberate send stays separate", async () => {
  const calls = [];
  const revoked = [];
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:selected-attendee";
  URL.revokeObjectURL = url => revoked.push(url);
  const second = { ...row, booking_id: "booking-2", attendee_name: "Samira Walsh", booking_source: "complex" };
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ url, options, body });
    if (url.includes("event-cpd-points-replay")) return json({ ...preview, rows: [row, second], totals: { registrations: 2, eligible: 2, proposed_points: "3" } });
    if (!body) return json({ available: true, can_send: true, fingerprint: url.includes("booking-2") ? "snapshot-2" : "snapshot-1" });
    if (body.action === "preview") return new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
    if (body.action === "send") return json({ success: true });
    throw new Error("Unexpected action");
  };
  const view = await mount();
  try {
    await tick();
    assert.equal(button("Preview certificate PDF"), undefined);
    await toggle("Send/resend badge notification emails");
    assert.equal(button("Preview certificate PDF"), undefined, "badge-only option has no PDF");
    await toggle("Send/resend badge notification emails");
    await toggle(certificateOption);
    assert.ok(button("Preview certificate PDF"));
    assert.equal(calls.length, 1, "selecting certificate does not send, award, or even request a PDF");
    await act(async () => {
      const select = document.querySelector("select");
      select.value = cpdRegistrationKey(second);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Preview certificate PDF");
    await tick();
    const post = calls.find(item => item.body?.action === "preview" && item.url.includes("attendee-cpd-certificate"));
    assert.deepEqual(post.body, { booking_id: "booking-2", booking_source: "complex", action: "preview", expected_fingerprint: "snapshot-2" });
    assert.equal(post.options.credentials, "include");
    assert.match(calls[1].url, /booking_id=booking-2&booking_source=complex/);
    assert.equal(calls[1].options.credentials, "include");
    assert.match(document.querySelector("iframe").title, /Samira Walsh/);
    assert.equal(document.querySelector("iframe").src, "blob:selected-attendee");
    assert.ok(calls.every(item => !item.body || item.body.action === "preview"), "PDF inspection cannot send or confirm awards");
    assert.equal(button("Confirm send/resend to 2 eligible email deliveries"), undefined);
    await click("Review recipients and eligibility");
    await tick();
    assert.equal(calls.filter(item => item.body?.action === "send").length, 0);
    await click("Confirm send/resend to 2 eligible email deliveries");
    await tick();
    const sends = calls.filter(item => item.body?.action === "send");
    assert.equal(sends.length, 2);
    assert.equal(sends[1].body.expected_fingerprint, "snapshot-2");
    assert.equal(sends[1].body.confirmed, true);
    assert.equal(sends[1].body.deliberate_resend, true);
    assert.ok(sends[1].body.request_id);
    assert.equal(sends[1].body.award_confirmed, undefined);
    await toggle(certificateOption);
    assert.equal(document.querySelector("iframe"), null);
    assert.deepEqual(revoked, ["blob:selected-attendee"]);
  } finally {
    await view.cleanup();
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
  }
});

test("changing attendees aborts pending PDF requests and discards stale responses; unmount revokes the current PDF", async () => {
  let resolvePdf, oldSignal;
  let created = 0;
  const revoked = [];
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:pdf-${++created}`;
  URL.revokeObjectURL = url => revoked.push(url);
  const second = { ...row, booking_id: "booking-2", attendee_name: "Samira Walsh" };
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (url.includes("event-cpd-points-replay")) return json({ ...preview, rows: [row, second], totals: { registrations: 2, eligible: 2, proposed_points: "3" } });
    if (!body) return json({ available: true, fingerprint: "current" });
    if (body.booking_id === row.booking_id) {
      oldSignal = options.signal;
      return new Promise(resolve => { resolvePdf = resolve; });
    }
    return new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
  };
  const view = await mount();
  try {
    await toggle(certificateOption);
    await click("Preview certificate PDF");
    await tick();
    assert.match(document.body.textContent, /Preparing the selected attendee/);
    await act(async () => {
      const select = document.querySelector("select");
      select.value = cpdRegistrationKey(second);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(oldSignal.aborted, true);
    await act(async () => resolvePdf(new Response("%PDF-old", { headers: { "Content-Type": "application/pdf" } })));
    await tick();
    assert.equal(created, 0, "stale response must not create an object URL");
    assert.equal(document.querySelector("iframe"), null);
    await click("Preview certificate PDF");
    await tick();
    assert.equal(created, 1);
    assert.match(document.querySelector("iframe").title, /Samira Walsh/);
  } finally {
    await view.cleanup();
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
  }
  assert.deepEqual(revoked, ["blob:pdf-1"]);
});

test("PDF errors have a retry that reloads authenticated metadata and the fingerprint", async () => {
  let metadataReads = 0;
  const fingerprints = [];
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:retry";
  URL.revokeObjectURL = () => {};
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (url.includes("event-cpd-points-replay")) return json(preview);
    if (!body) return json({ available: true, fingerprint: `revision-${++metadataReads}` });
    assert.equal(body.action, "preview");
    fingerprints.push(body.expected_fingerprint);
    return fingerprints.length === 1 ? json({ error: "Certificate data changed. Reload and preview." }, 409)
      : new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
  };
  const view = await mount();
  try {
    await toggle(certificateOption);
    await click("Preview certificate PDF");
    await tick();
    assert.match(document.querySelector('[role="alert"]').textContent, /Certificate data changed/);
    assert.equal(document.querySelector("iframe"), null);
    await click("Retry certificate PDF preview");
    await tick();
    assert.deepEqual(fingerprints, ["revision-1", "revision-2"]);
    assert.ok(document.querySelector("iframe"));
  } finally {
    await view.cleanup();
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
  }
});

test("switching away from a displayed PDF revokes it immediately; unavailable attendees cannot request a PDF", async () => {
  const revoked = [], actions = [];
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:first-attendee";
  URL.revokeObjectURL = url => revoked.push(url);
  const second = { ...row, booking_id: "booking-2", attendee_name: "Samira Walsh" };
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (url.includes("event-cpd-points-replay")) return json({ ...preview, rows: [row, second], totals: { registrations: 2, eligible: 2, proposed_points: "3" } });
    if (!body) return json(url.includes("booking-2")
      ? { available: false, reason: "No certificate template is configured." }
      : { available: true, fingerprint: "current" });
    actions.push(body);
    return new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
  };
  const view = await mount();
  try {
    await toggle(certificateOption);
    await click("Preview certificate PDF");
    await tick();
    assert.ok(document.querySelector("iframe"));
    await act(async () => {
      const select = document.querySelector("select");
      select.value = cpdRegistrationKey(second);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(document.querySelector("iframe"), null);
    assert.deepEqual(revoked, ["blob:first-attendee"]);
    await click("Preview certificate PDF");
    await tick();
    assert.match(document.querySelector('[role="alert"]').textContent, /No certificate template/);
    assert.equal(actions.length, 1, "unavailable metadata must not proceed to a PDF POST");
    assert.equal(document.querySelector("iframe"), null);
  } finally {
    await view.cleanup();
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
  }
});
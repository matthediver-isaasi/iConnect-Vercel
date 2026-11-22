import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { DEFAULT_LIFECYCLE_POLICY } from "../../../../shared/memberLifecyclePolicy.mjs";

// Entire page and real UI components mounted in an isolated DOM. Every request
// below is intercepted in-process; no server, live tenant or workflow is used.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

const bundle = await build({
  entryPoints: ["client/src/pages/MemberLifecycle.jsx"], bundle: true, write: false,
  packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": path.resolve("client/src") }, loader: { ".css": "empty" },
});
const compiled = new Module(path.resolve("client/src/components/member-lifecycle/isolated-test.cjs"));
compiled.filename = path.resolve("client/src/components/member-lifecycle/isolated-test.cjs");
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const MemberLifecycle = compiled.exports.default;

const roleId = "12345678-1234-4234-8234-123456789abc";
const memberId = "isolated-member-a";
function configuration(overrides = {}) {
  return {
    policy: { ...DEFAULT_LIFECYCLE_POLICY, activities: [...DEFAULT_LIFECYCLE_POLICY.activities],
      guestRoleIds: [], eventOnlyRoleIds: [] },
    revision: 7, enabled: false, executionReady: true,
    permissions: { view: true, configure: true, review: true, archive: true, minimise: true, delete: true },
    roles: [{ id: roleId, name: "Tenant review destination" }], readinessIssues: [], ...overrides,
  };
}
function snapshot(id = memberId, revision = 3) {
  return { memberId: id, revision, state: "archived", evidence: { historyKind: "former", membershipComplete: true }, audit: [], blockers: [] };
}
const preview = (extra = {}) => ({ previewId: "isolated-preview", revision: 7, complete: true, counts: { archive: 1 }, items: [], nextCursor: null, ...extra });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const button = text => [...document.querySelectorAll("button")].find(el => el.textContent.trim() === text);
async function click(text) {
  const node = typeof text === "string" ? button(text) : text;
  assert.ok(node, `Missing button ${text}`);
  assert.equal(node.disabled, false, `Disabled button ${node.textContent}`);
  await act(async () => node.click());
}
async function change(node, value) {
  assert.ok(node);
  const prototype = node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype
    : node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function mount(handler, initial = configuration()) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials, "include");
    assert.ok(String(url).startsWith("/api/admin/member-lifecycle"));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, method: options.method });
    const handled = await handler?.({ url, body, method: options.method, calls });
    if (handled !== undefined) return handled;
    if (body) throw new Error(`Unintercepted mutation ${JSON.stringify(body)}`);
    if (url.includes("section=operations")) return response({ items: [], limited: false });
    if (url.includes("section=cleanup")) return response({ items: [], limited: false });
    if (url.includes("section=review")) return response({ items: [{ memberId, state: "archived", reason: "archive_retention_elapsed", eligibleOn: "2025-02-28", hold: false, exempt: false, reviewAfter: null }], nextCursor: null });
    if (url.includes("section=detail")) return response(snapshot(new URL(url, "https://isolated.example.test").searchParams.get("memberId")));
    return response(initial);
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(MemberLifecycle))));
  return { calls, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function openReview() { await click([...document.querySelectorAll("button")].find(el => el.textContent.startsWith("Review member"))); }
const dialog = () => document.querySelector('[role="dialog"]');

test("executionReady false blocks approval even for a complete, version-matched preview", async () => {
  const fixture = await mount(({ body }) => body?.action === "preview" ? response(preview()) : undefined,
    configuration({ executionReady: false, readinessIssues: ["Session revocation integration unavailable"] }));
  try {
    assert.match(document.body.textContent, /Execution blocked/);
    assert.match(document.body.textContent, /Session revocation integration unavailable/);
    assert.match(document.body.textContent, /Preparation only/);
    assert.equal(fixture.calls.some(call => call.url.includes("section=review") || call.url.includes("section=detail")), false);
    await click("Generate impact preview");
    assert.equal(button("Approve preview & enable rules").disabled, true);
    const acknowledge = [...document.querySelectorAll('input[type="checkbox"]')].find(el => el.parentElement.textContent.includes("authorise the server"));
    assert.equal(acknowledge.disabled, true);
    assert.equal(fixture.calls.some(call => call.body?.action === "approve"), false);
  } finally { await fixture.cleanup(); }
});

test("initial revision can be saved without manufacturing an edit, while preview waits", async () => {
  const fixture = await mount(null, configuration({ revision: 0, executionReady: false }));
  try {
    assert.equal(button("Save policy & pause").disabled, false);
    assert.equal(button("Generate impact preview").disabled, true);
    assert.equal(fixture.calls.some(call => /section=(review|detail)/.test(call.url)), false);
  } finally { await fixture.cleanup(); }
});

test("preparation previews expose evidence gaps without enabling member-detail requests", async () => {
  const fixture = await mount(({ body }) => body?.action === "preview"
    ? response(preview({ items: [{ memberId, action: "evidence_review", reason: "activity_source_incomplete", unavailableSources: ["Genuine portal login history"] }] }))
    : undefined, configuration({ executionReady: false }));
  try {
    await click("Generate impact preview");
    assert.match(document.body.textContent, /Genuine portal login history/);
    const reviewButton = [...document.querySelectorAll("button")].find(el => el.textContent.startsWith("Review member"));
    assert.ok(reviewButton);
    assert.equal(reviewButton.disabled, true);
    assert.equal(fixture.calls.some(call => /section=(review|detail)/.test(call.url)), false);
  } finally { await fixture.cleanup(); }
});

test("a changed policy revision invalidates a preview rather than offering approval", async () => {
  let changed = false;
  const fixture = await mount(({ url, body }) => {
    if (body?.action === "preview") { changed = true; return response(preview()); }
    if (changed && !body && !url.includes("?")) return response(configuration({ revision: 8 }));
  });
  try {
    await click("Generate impact preview");
    assert.match(document.body.textContent, /impact preview is incomplete, stale or invalid/);
    assert.equal(button("Approve preview & enable rules"), undefined);
    assert.equal(fixture.calls.some(call => call.body?.action === "approve"), false);
  } finally { await fixture.cleanup(); }
});

test("approval requires all preview pages, explicit acknowledgement and current revision", async () => {
  let enabled = false;
  const fixture = await mount(({ url, body }) => {
    if (body?.action === "preview") return response(preview(body.cursor
      ? { items: [], complete: true }
      : { items: [], complete: false, nextCursor: "isolated-cursor" }));
    if (body?.action === "approve") { enabled = true; return response(configuration({ enabled })); }
    if (!body && !url.includes("?")) return response(configuration({ enabled }));
  });
  try {
    await click("Generate impact preview");
    assert.equal(button("Approve preview & enable rules").disabled, true);
    await click("Load next preview page");
    assert.equal(button("Approve preview & enable rules").disabled, true);
    assert.equal(fixture.calls.some(call => call.body?.action === "approve"), false);
    const acknowledge = [...document.querySelectorAll('input[type="checkbox"]')].find(el => el.parentElement.textContent.includes("authorise the server"));
    await click(acknowledge);
    await click("Approve preview & enable rules");
    const call = fixture.calls.find(item => item.body?.action === "approve");
    assert.deepEqual(call.body, { action: "approve", confirmed: true, previewId: "isolated-preview", expectedRevision: 7 });
    assert.ok(fixture.calls.filter(item => !item.body && !item.url.includes("?")).length >= 4);
    assert.match(document.body.textContent, /Automation enabled/);
  } finally { await fixture.cleanup(); }
});

test("API unavailability is explicit and cannot appear as an empty queue", async () => {
  let unavailable = true;
  const fixture = await mount(() => unavailable ? response({ error: "Lifecycle storage not prepared" }, 503) : undefined);
  try {
    assert.match(document.body.textContent, /Lifecycle storage not prepared/);
    assert.equal(button("Generate impact preview"), undefined);
    assert.doesNotMatch(document.body.textContent, /No records on this review page/);
    unavailable = false;
    await click("Retry loading");
    assert.ok(button("Generate impact preview"));
  } finally { await fixture.cleanup(); }
});

test("permissions hide all unauthorised decisions and dynamic roles use server IDs", async () => {
  const fixture = await mount(null, configuration({ permissions: { view: true } }));
  try {
    assert.equal(button("Save policy & pause"), undefined);
    assert.equal(button("Generate impact preview"), undefined);
    assert.ok([...document.querySelectorAll("option")].some(option => option.value === roleId && option.textContent === "Tenant review destination"));
    await openReview();
    assert.equal(dialog().querySelector("select"), null);
    assert.match(dialog().textContent, /no authorised decisions/);
  } finally { await fixture.cleanup(); }
});

test("saving serialises every shared policy field, uses revision and reloads server state", async () => {
  let saved;
  const fixture = await mount(({ url, body, method }) => {
    if (method === "PUT") {
      saved = body;
      return response(configuration({ policy: body.policy, revision: 8 }));
    }
    if (saved && !body && !url.includes("?")) return response(configuration({ policy: saved.policy, revision: 8 }));
  });
  try {
    const former = [...document.querySelectorAll("label")].find(el => el.textContent.startsWith("Former-member destination")).querySelector("select");
    await change(former, roleId);
    await click("Save policy & pause");
    assert.equal(saved.expectedRevision, 7);
    assert.equal(saved.policy.formerRoleId, roleId);
    assert.deepEqual(Object.keys(saved.policy).sort(), Object.keys(DEFAULT_LIFECYCLE_POLICY).sort());
    assert.match(document.body.textContent, /Policy revision 8/);
    assert.match(document.body.textContent, /Automation paused/);
  } finally { await fixture.cleanup(); }
});

test("deletion needs impact token, explicit word and reason; result is reloaded", async () => {
  let deleted = false;
  const fixture = await mount(({ url, body }) => {
    if (body?.action === "delete_preview") return response({ impactToken: "isolated-impact", revision: 3, fieldsRemoved: ["name", "email"], fieldsRetained: [{ field: "internal_id", reason: "Audit reference" }, { field: "financial_history", reason: "Protected history" }], unresolvedFields: [], blockers: [] });
    if (body?.action === "delete") { deleted = true; return response({ state: "deleted" }); }
    if (!body && url.includes("section=detail")) return response({ ...snapshot(), state: deleted ? "deleted" : "archived" });
  });
  try {
    await openReview();
    await change(dialog().querySelector("select"), "delete");
    await change(dialog().querySelector("textarea"), "Retention and financial evidence reviewed.");
    await click("Generate field-level impact preview");
    assert.match(dialog().textContent, /financial_history/);
    assert.equal(button("Confirm delete").disabled, true);
    await change(dialog().querySelector('input[autocomplete="off"]'), "DELETE");
    await click("Confirm delete");
    const mutation = fixture.calls.find(call => call.body?.action === "delete");
    assert.equal(mutation.body.impactToken, "isolated-impact");
    assert.equal(mutation.body.confirmation, "DELETE");
    assert.equal(mutation.body.expectedRevision, 3);
    assert.match(dialog().textContent, /State: Deleted/);
    assert.equal(dialog().querySelector("select"), null);
  } finally { await fixture.cleanup(); }
});

test("field-level blockers prevent confirmation and failed actions show inside the dialog", async () => {
  const fixture = await mount(({ body }) => {
    if (body?.action === "minimise_preview") return response({ impactToken: null, revision: 3, fieldsRemoved: ["name"], fieldsRetained: [{ field: "member_id", reason: "Audit reference" }], unresolvedFields: [], blockers: ["Unresolved legal retention"] });
    if (body?.action === "retain") return response({ error: "Concurrent renewal; review current evidence" }, 409);
  });
  try {
    await openReview();
    await change(dialog().querySelector("select"), "minimise");
    await change(dialog().querySelector("textarea"), "Review retention.");
    await click("Generate field-level impact preview");
    assert.match(dialog().textContent, /Unresolved legal retention/);
    assert.equal(button("Confirm minimise").disabled, true);
    await change(dialog().querySelector("select"), "retain");
    await click("Confirm: Retain with durable hold");
    assert.match(dialog().textContent, /Concurrent renewal; review current evidence/);
  } finally { await fixture.cleanup(); }
});

test("closed member request is fenced so late evidence cannot populate a reopened review", async () => {
  let release;
  let detailCalls = 0;
  const fixture = await mount(({ url, body }) => {
    if (!body && url.includes("section=detail") && ++detailCalls === 1) return new Promise(resolve => { release = resolve; });
    if (!body && url.includes("section=detail")) return response(snapshot(memberId, 9));
  });
  try {
    await openReview();
    await click("Close review");
    await openReview();
    assert.match(dialog().textContent, /Record revision 9/);
    await act(async () => release(response(snapshot(memberId, 2))));
    assert.match(dialog().textContent, /Record revision 9/);
    assert.doesNotMatch(dialog().textContent, /Record revision 2/);
  } finally { await fixture.cleanup(); }
});

test("review readiness allows safe decisions while execution and disposal stay blocked", async () => {
  const fixture = await mount(({ body }) => body?.action === "preview" ? response(preview())
    : ["retain", "extend", "exempt"].includes(body?.action) ? response({ memberId, revision: 4 }) : undefined,
  configuration({ reviewReady: true, executionReady: false, readinessIssues: ["Runtime unavailable"] }));
  try {
    assert.match(document.body.textContent, /Non-destructive decisions are available/);
    await click("Generate impact preview");
    assert.equal(button("Approve preview & enable rules").disabled, true);
    await openReview();
    const select = dialog().querySelector("select");
    const choices = [...select.options].map(option => option.value);
    for (const action of ["retain", "release_hold", "extend", "exempt", "clear_exemption"]) assert.ok(choices.includes(action));
    for (const action of ["archive", "restore", "minimise", "delete"]) assert.equal(choices.includes(action), false);
    await change(select, "retain");
    assert.equal(button("Confirm: Retain with durable hold").disabled, true);
    await change(dialog().querySelector("textarea"), "Documented legal retention review.");
    await click("Confirm: Retain with durable hold");
    await change(dialog().querySelector("select"), "extend");
    await change(dialog().querySelector("textarea"), "Review after the outstanding obligation.");
    await change(dialog().querySelector('input[type="date"]'), "2098-07-16");
    await click("Confirm: Extend retention");
    await change(dialog().querySelector("select"), "exempt");
    await change(dialog().querySelector("textarea"), "Documented exemption for ongoing obligations.");
    await click("Confirm: Exempt from automation");
    assert.deepEqual(fixture.calls.filter(call => call.body).map(call => call.body.action), ["preview", "retain", "extend", "exempt"]);
    assert.equal(fixture.calls.find(call => call.body?.action === "extend").body.reviewAfter, "2098-07-16");
    assert.ok(fixture.calls.filter(call => call.url.includes("section=detail")).length >= 4);
  } finally { await fixture.cleanup(); }
});

const labelledControl = (scope, text) => [...scope.querySelectorAll("label")]
  .find(label => label.textContent.startsWith(text))?.querySelector("select, textarea, input");

test("documented membership evidence requires explicit history and submits current API fields", async () => {
  let revision = 3;
  const fixture = await mount(({ url, body }) => {
    if (body?.action === "record_evidence") return response({ memberId, revision: ++revision });
    if (!body && url.includes("section=detail")) return response({ ...snapshot(memberId, revision),
      evidence: { membershipRows: 0, membershipFingerprint: "isolated-membership-fingerprint" } });
  }, configuration({ reviewReady: true, executionReady: false }));
  try {
    await openReview();
    const evidence = dialog().querySelector("details");
    await act(async () => evidence.querySelector("summary").click());
    assert.match(evidence.textContent, /No membership rows is not proof/);
    const source = labelledControl(evidence, "Evidence source");
    await change(source, "membership");
    const history = labelledControl(evidence, "Verified membership history");
    assert.equal(history.value, "");
    await change(labelledControl(evidence, "Evidence reference"), "  Reviewed archived register, reference M-417.  ");
    assert.equal(button("Record verified evidence").disabled, true);
    await act(async () => evidence.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(fixture.calls.some(call => call.body?.action === "record_evidence"), false);
    await change(history, "never");
    await click("Record verified evidence");
    assert.deepEqual(fixture.calls.find(call => call.body?.action === "record_evidence").body, {
      action: "record_evidence", memberId, expectedRevision: 3, source: "membership", historyKind: "never",
      graceEndDate: null, reference: "Reviewed archived register, reference M-417.",
    });
    await change(source, "membership");
    assert.equal(labelledControl(evidence, "Verified membership history").value, "");
    await change(labelledControl(evidence, "Verified membership history"), "former");
    await change(labelledControl(evidence, "Evidence reference"), "Documented former membership term M-492.");
    assert.equal(button("Record verified evidence").disabled, true);
    await change(labelledControl(evidence, "Verified membership grace end date"), "2018-04-19");
    await click("Record verified evidence");
    const mutation = fixture.calls.filter(call => call.body?.action === "record_evidence").at(-1);
    assert.deepEqual(mutation.body, {
      action: "record_evidence", memberId, expectedRevision: 4, source: "membership", historyKind: "former",
      graceEndDate: "2018-04-19", reference: "Documented former membership term M-492.",
    });
    assert.match(dialog().textContent, /Record revision 5/);
  } finally { await fixture.cleanup(); }
});

test("login evidence explains absent history, preserves failed edits and records nullable occurrence", async () => {
  let fail = true;
  const fixture = await mount(({ url, body }) => {
    if (body?.action === "record_evidence") return fail
      ? response({ error: "Evidence changed; review again" }, 409) : response({ memberId, revision: 4 });
    if (!body && url.includes("section=detail")) return response({ ...snapshot(),
      evidence: { activity: { portal_login: { source: "member_lifecycle_login_evidence", lastOccurredAt: null } } } });
  }, configuration({ reviewReady: true, executionReady: false }));
  try {
    await openReview();
    const evidence = dialog().querySelector("details");
    await act(async () => evidence.querySelector("summary").click());
    await change(labelledControl(evidence, "Evidence source"), "portal_login");
    assert.match(evidence.textContent, /does not prove there were no logins/);
    assert.match(evidence.textContent, /documented review explanation/);
    await change(labelledControl(evidence, "Evidence reference"), "Reviewed login coverage export L-274.");
    await click("Record verified evidence");
    assert.match(dialog().textContent, /Evidence changed; review again/);
    assert.equal(labelledControl(evidence, "Evidence reference").value, "Reviewed login coverage export L-274.");
    assert.equal(labelledControl(evidence, "Evidence source").value, "portal_login");
    fail = false;
    await click("Record verified evidence");
    assert.deepEqual(fixture.calls.filter(call => call.body?.action === "record_evidence").at(-1).body, {
      action: "record_evidence", memberId, expectedRevision: 3, source: "portal_login",
      reference: "Reviewed login coverage export L-274.", lastOccurredAt: null,
    });
    await change(labelledControl(evidence, "Evidence source"), "portal_login");
    await change(labelledControl(evidence, "Last verified portal login"), "2019-08-24");
    await change(labelledControl(evidence, "Evidence reference"), "Verified occurrence L-301.");
    await click("Record verified evidence");
    assert.equal(fixture.calls.filter(call => call.body?.action === "record_evidence").at(-1).body.lastOccurredAt, "2019-08-24");
  } finally { await fixture.cleanup(); }
});

test("runtime operation history is read-only and reports server runtime values without preparation copy", async () => {
  const fixture = await mount(({ url, body }) => {
    if (!body && url.includes("section=operations")) return response({ items: [
      { id: "operation-7", memberId, action: "archive", status: "failed", reason: "Retention elapsed",
        createdAt: "2026-03-18T14:26:12Z", error: "Session revocation failed" },
      { id: "operation-8", memberId, action: "restore", status: "pending", reason: null, createdAt: null, error: null },
    ], limited: false });
  }, configuration({ runtime: { lastRunAt: "2026-03-18T14:26:12Z", paused: false, remaining: 17 } }));
  try {
    const section = [...document.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent === "Runtime operation history");
    assert.ok(section);
    assert.match(section.textContent, /Session revocation failed/);
    assert.match(section.textContent, /Status: Failed/);
    assert.match(section.textContent, /Status: Pending/);
    assert.match(section.textContent, /operation-7/);
    assert.match(section.textContent, /2026-03-18T14:26:12Z/);
    assert.equal(section.querySelector("button, input, select, textarea"), null);
    const runtime = document.querySelector('[aria-label="Reported runtime state"]');
    assert.match(runtime.textContent, /Runtime pausedNo/);
    assert.match(runtime.textContent, /Remaining \(server reported\)17/);
    assert.doesNotMatch(document.body.textContent, /Preparation only|Execution is not ready|Execution blocked/);
    assert.equal(fixture.calls.some(call => call.body), false);
    assert.ok(fixture.calls.some(call => call.url.endsWith("?section=operations") && call.method === "GET"));
  } finally { await fixture.cleanup(); }
});

test("unavailable operation history shows retry, not a successful run or an empty queue", async () => {
  let unavailable = true;
  const fixture = await mount(({ url, body }) => !body && url.includes("section=operations")
    ? unavailable ? response({ error: "Operation storage unavailable" }, 503) : response({ items: [], limited: false })
    : undefined, configuration({ runtime: { lastRunAt: null, paused: true } }));
  try {
    assert.match(document.body.textContent, /Operation storage unavailable/);
    assert.doesNotMatch(document.body.textContent, /No runtime operations reported/);
    assert.match(document.body.textContent, /No run reported/);
    assert.doesNotMatch(document.querySelector('[aria-label="Reported runtime state"]').textContent, /Remaining/);
    unavailable = false;
    await click("Retry loading");
    assert.match(document.body.textContent, /No runtime operations reported/);
    assert.match(document.body.textContent, /not proof that automation has run/);
    assert.equal(fixture.calls.some(call => call.body), false);
  } finally { await fixture.cleanup(); }
});

test("pausing automation sends the authoritative policy revision", async () => {
  let enabled = true;
  const fixture = await mount(({ url, body }) => {
    if (body?.action === "pause") { enabled = false; return response(configuration({ enabled })); }
    if (!body && !url.includes("?")) return response(configuration({ enabled }));
  }, configuration({ enabled }));
  try {
    await click("Pause automation");
    assert.deepEqual(fixture.calls.find(call => call.body?.action === "pause").body, {
      action: "pause", expectedRevision: 7,
    });
    assert.match(document.body.textContent, /Automation paused/);
  } finally { await fixture.cleanup(); }
});

test("capped operation history discloses its limit without offering cursor pagination or claiming completeness", async () => {
  const fixture = await mount(({ url, body }) => !body && url.includes("section=operations")
    ? response({ items: Array.from({ length: 100 }, (_, index) => ({
      id: `capped-operation-${index}`, memberId, action: "archive", status: "pending",
      reason: "Retention review", createdAt: "2026-03-18T14:26:12Z", error: null,
    })), limited: true }) : undefined);
  try {
    const section = [...document.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent === "Runtime operation history");
    assert.match(section.textContent, /100 operations loaded/);
    assert.match(section.textContent, /Limited to 100 operations/);
    assert.match(section.textContent, /Older operations may not be shown; this is not the full operation history/);
    assert.doesNotMatch(section.textContent, /End of available pages|All operations|Complete history/);
    assert.equal(section.querySelector("button"), null);
    assert.equal(fixture.calls.some(call => call.url.includes("section=operations&cursor")), false);
    assert.equal(fixture.calls.some(call => call.body), false);
  } finally { await fixture.cleanup(); }
});

for (const action of ["minimise", "delete"]) {
  test(`${action} requires explicit documented field decisions and a new server token`, async () => {
    let decisionPreviews = 0;
    const unresolvedFields = [
      { name: "profile_notes", label: "Profile notes", canRemove: true },
      { name: "legacy_reference", label: "Legacy reference", canRemove: false },
    ];
    const fixture = await mount(({ body }) => {
      if (body?.action === `${action}_preview`) {
        if (body.retentionDecisions) decisionPreviews++;
        return response({
          revision: 3, impactToken: decisionPreviews >= 2 ? "reviewed-field-impact" : null,
          fieldsRemoved: ["email"], fieldsRetained: [{ field: "financial_history", reason: "Statutory retention" }],
          unresolvedFields: decisionPreviews >= 2 ? [] : unresolvedFields,
          blockers: decisionPreviews >= 2 ? [] : ["retention_decision_required:profile_notes", "retention_decision_required:legacy_reference"],
          expiresAt: "2099-06-12T10:21:00Z",
        });
      }
      if (body?.action === action) return response({ memberId, state: action === "delete" ? "deleted" : "minimised" });
    });
    try {
      await openReview();
      await change(labelledControl(dialog(), "Decision"), action);
      await change(labelledControl(dialog(), "Reason for this decision"), "Reviewed obligations and field-level evidence.");
      await click("Generate field-level impact preview");
      assert.match(dialog().textContent, /Statutory retention/);
      assert.match(dialog().textContent, /separate accounts, protected history, external-provider records or backups/);
      assert.equal(button(`Confirm ${action}`).disabled, true);
      assert.equal(button("Re-run field-level impact preview").disabled, true);
      await change(labelledControl(dialog(), "Retention decision: Profile notes"), "retain");
      await change(labelledControl(dialog(), "Documented reason: Profile notes"), "Draft choice to discard on action change.");
      await change(labelledControl(dialog(), "Decision"), "retain");
      await change(labelledControl(dialog(), "Decision"), action);
      await click("Generate field-level impact preview");
      assert.equal(Object.hasOwn(fixture.calls.filter(call => call.body?.action === `${action}_preview`).at(-1).body, "retentionDecisions"), false);
      const notes = labelledControl(dialog(), "Retention decision: Profile notes");
      const reference = labelledControl(dialog(), "Retention decision: Legacy reference");
      assert.equal(notes.value, "");
      assert.equal(reference.value, "");
      assert.equal([...reference.options].some(option => option.value === "remove"), false);
      await change(notes, "remove");
      await change(reference, "retain");
      assert.equal(button("Re-run field-level impact preview").disabled, true);
      await change(labelledControl(dialog(), "Documented reason: Profile notes"), "  No ongoing purpose for notes.  ");
      await change(labelledControl(dialog(), "Documented reason: Legacy reference"), "Required to reconcile protected history.");
      assert.equal(button(`Confirm ${action}`).disabled, true);
      await click("Re-run field-level impact preview");
      assert.equal(labelledControl(dialog(), "Retention decision: Profile notes").value, "remove");
      assert.equal(labelledControl(dialog(), "Retention decision: Legacy reference").value, "retain");
      assert.equal(button(`Confirm ${action}`).disabled, true);
      const expectedDecisions = {
        profile_notes: { disposition: "remove", reason: "No ongoing purpose for notes." },
        legacy_reference: { disposition: "retain", reason: "Required to reconcile protected history." },
      };
      assert.deepEqual(fixture.calls.filter(call => call.body?.action === `${action}_preview`).at(-1).body, {
        action: `${action}_preview`, memberId, expectedRevision: 3, reason: "Reviewed obligations and field-level evidence.", retentionDecisions: expectedDecisions,
      });
      await click("Re-run field-level impact preview");
      assert.equal(button(`Confirm ${action}`).disabled, true);
      await change(dialog().querySelector('input[autocomplete="off"]'), action.toUpperCase());
      await click(`Confirm ${action}`);
      assert.deepEqual(fixture.calls.find(call => call.body?.action === action).body, {
        action, memberId, expectedRevision: 3, reason: "Reviewed obligations and field-level evidence.",
        confirmation: action.toUpperCase(), impactToken: "reviewed-field-impact",
      });
      await change(labelledControl(dialog(), "Decision"), action);
      await change(labelledControl(dialog(), "Reason for this decision"), "Fresh review.");
      await click("Generate field-level impact preview");
      assert.equal(Object.hasOwn(fixture.calls.filter(call => call.body?.action === `${action}_preview`).at(-1).body, "retentionDecisions"), false);
    } finally { await fixture.cleanup(); }
  });
}

test("expired, absent or stale impact tokens cannot enable irreversible confirmation", async () => {
  let variant = 0;
  const fixture = await mount(({ body }) => body?.action === "delete_preview" ? response({
    revision: variant === 2 ? 2 : 3, impactToken: variant === 1 ? null : "expired-impact",
    fieldsRemoved: ["name"], fieldsRetained: [], unresolvedFields: [], blockers: [],
    expiresAt: variant === 0 ? "2001-01-01T00:00:00Z" : "2099-06-12T10:21:00Z",
  }) : undefined);
  try {
    await openReview();
    await change(labelledControl(dialog(), "Decision"), "delete");
    await change(labelledControl(dialog(), "Reason for this decision"), "Review obligations.");
    await click("Generate field-level impact preview");
    assert.match(dialog().textContent, /Expired or invalid expiry/);
    assert.equal(button("Confirm delete").disabled, true);
    for (variant of [1, 2]) {
      await click("Re-run field-level impact preview");
      assert.equal(button("Confirm delete").disabled, true);
      assert.equal(dialog().querySelector('input[autocomplete="off"]').disabled, true);
    }
    assert.equal(fixture.calls.some(call => call.body?.action === "delete"), false);
  } finally { await fixture.cleanup(); }
});

const cleanupEntry = {
  id: "cleanup-417", memberId, kind: "stored_media", state: "pending", reason: "Independent storage review required",
  createdAt: "2026-03-18T14:26:12Z",
};
const cleanupPanel = () => [...document.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent === "Stored-media cleanup review");

test("cleanup verification requires independent review, reason and exact confirmation; posts safe payload", async () => {
  let resolved = false;
  const fixture = await mount(({ url, body }) => {
    if (!body && url.includes("section=cleanup")) return response({
      items: [{ ...cleanupEntry, state: resolved ? "resolved" : "pending", storageReference: "private-bucket/secret-object.pdf" }], limited: true,
    });
    if (body?.action === "resolve_cleanup") { resolved = true; return response({ id: cleanupEntry.id, state: "resolved" }); }
  });
  try {
    assert.match(cleanupPanel().textContent, /Independently verify storage removal/);
    assert.match(cleanupPanel().textContent, /not the full cleanup history/);
    assert.doesNotMatch(document.body.textContent, /private-bucket\/secret-object/);
    await click("Record independent removal verification");
    assert.equal(button("Confirm independently verified removal").disabled, true);
    await change(labelledControl(cleanupPanel(), "Documented independent removal verification"), "  Verified absence in authorised storage console, review C-417.  ");
    await change(labelledControl(cleanupPanel(), "Type VERIFIED REMOVED"), "REMOVED");
    assert.equal(button("Confirm independently verified removal").disabled, true);
    await change(labelledControl(cleanupPanel(), "Type VERIFIED REMOVED"), "VERIFIED REMOVED");
    await click("Confirm independently verified removal");
    assert.deepEqual(fixture.calls.find(call => call.body?.action === "resolve_cleanup").body, {
      action: "resolve_cleanup", cleanupId: cleanupEntry.id,
      reason: "Verified absence in authorised storage console, review C-417.", confirmation: "VERIFIED REMOVED",
    });
    assert.match(cleanupPanel().textContent, /State: Resolved/);
    assert.equal(button("Record independent removal verification"), undefined);
    assert.ok(fixture.calls.filter(call => call.url.includes("section=cleanup")).length >= 2);
  } finally { await fixture.cleanup(); }
});

test("cleanup is hidden without disposal permissions and read-only without execution readiness", async () => {
  let fixture = await mount(null, configuration({ permissions: { view: true, review: true } }));
  try {
    assert.equal(cleanupPanel(), undefined);
    assert.equal(fixture.calls.some(call => call.url.includes("section=cleanup")), false);
  } finally { await fixture.cleanup(); }
  fixture = await mount(({ url, body }) => !body && url.includes("section=cleanup")
    ? response({ items: [cleanupEntry], limited: false }) : undefined,
  configuration({ reviewReady: true, executionReady: false }));
  try {
    assert.match(cleanupPanel().textContent, /Recording verification is unavailable/);
    assert.equal(button("Record independent removal verification").disabled, true);
    assert.equal(fixture.calls.some(call => call.body), false);
  } finally { await fixture.cleanup(); }
});

test("supplied runtime errors are prominent and nextRunAt is only a scheduled check", async () => {
  const fixture = await mount(null, configuration({ runtime: {
    lastRunAt: "2026-03-18T14:26:12Z", nextRunAt: "2026-03-18T15:11:12Z",
    lastError: "Provider outcome unknown; verify delivery before retrying", paused: true, remaining: 8,
  } }));
  try {
    const runtime = document.querySelector('[aria-label="Reported runtime state"]');
    const alert = runtime.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent, /Runtime error reported/);
    assert.match(alert.textContent, /Provider outcome unknown; verify delivery before retrying/);
    assert.match(alert.textContent, /does not confirm successful processing/);
    assert.match(runtime.textContent, /Next scheduled check \(server timestamp\)2026-03-18T15:11:12Z/);
    assert.equal(fixture.calls.some(call => call.body), false);
  } finally { await fixture.cleanup(); }
});

const notificationOperation = {
  id: "notice-274", memberId, action: "notification", status: "needs_attention",
  reason: "provider_outcome_unknown", createdAt: "2026-03-18T14:26:12Z", error: null,
};
const operationsPanel = () => [...document.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent === "Runtime operation history");

for (const resolution of ["sent", "retry"]) {
  test(`notification ${resolution} recovery requires independent verification and exact confirmation`, async () => {
    let resolved = false;
    const fixture = await mount(({ url, body }) => {
      if (!body && url.includes("section=operations")) return response({
        items: [{ ...notificationOperation, status: resolved ? resolution === "sent" ? "sent" : "pending" : "needs_attention" },
          { ...notificationOperation, id: "read-only-archive", action: "archive" },
          { ...notificationOperation, id: "read-only-notice", status: "sent" }], limited: false,
      });
      if (body?.action === "resolve_notice") { resolved = true; return response({ id: notificationOperation.id, resolution }); }
    });
    try {
      const panel = operationsPanel();
      assert.equal(panel.querySelectorAll("button").length, 1);
      assert.match(panel.textContent, /Outcome codeprovider_outcome_unknown/);
      assert.equal(fixture.calls.some(call => call.body), false);
      await click("Review notification outcome");
      const form = panel.querySelector('form[aria-label="Independently verified notification recovery"]');
      assert.match(form.textContent, /Retry only after independently verifying the notification was not sent, to avoid duplicate emails/);
      assert.match(form.textContent, /Ambiguous sends are not automatically retried/);
      assert.equal(labelledControl(form, "Verified notification outcome").value, "");
      await change(labelledControl(form, "Verified notification outcome"), resolution);
      const confirmation = resolution === "sent" ? "VERIFIED DELIVERY" : "VERIFIED NOT SENT";
      const submitLabel = resolution === "sent" ? "Record verified delivery" : "Request verified retry";
      assert.equal(button(submitLabel).disabled, true);
      await change(labelledControl(form, `Type ${confirmation}`), confirmation);
      assert.equal(button(submitLabel).disabled, true);
      await change(labelledControl(form, "Documented provider verification"), "  Independently reviewed provider records, case N-274.  ");
      await change(labelledControl(form, `Type ${confirmation}`), confirmation.toLowerCase());
      assert.equal(button(submitLabel).disabled, true);
      await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
      assert.equal(fixture.calls.some(call => call.body?.action === "resolve_notice"), false);
      await change(labelledControl(form, `Type ${confirmation}`), confirmation);
      await click(submitLabel);
      assert.deepEqual(fixture.calls.find(call => call.body?.action === "resolve_notice").body, {
        action: "resolve_notice", noticeId: notificationOperation.id, resolution,
        reason: "Independently reviewed provider records, case N-274.", confirmation,
      });
      assert.equal(fixture.calls.filter(call => call.body?.action === "resolve_notice").length, 1);
      assert.ok(fixture.calls.filter(call => call.url.includes("section=operations")).length >= 2);
      assert.equal(button("Review notification outcome"), undefined);
    } finally { await fixture.cleanup(); }
  });
}

test("notification recovery remains read-only without review permission or execution readiness", async () => {
  for (const settings of [
    { permissions: { view: true, configure: true, minimise: true, delete: true } },
    { executionReady: false, reviewReady: true },
  ]) {
    const fixture = await mount(({ url, body }) => !body && url.includes("section=operations")
      ? response({ items: [notificationOperation], limited: false }) : undefined, configuration(settings));
    try {
      assert.match(operationsPanel().textContent, /Status: Needs attention/);
      assert.equal(operationsPanel().querySelector("button, select, input, textarea"), null);
      assert.equal(fixture.calls.some(call => call.body), false);
    } finally { await fixture.cleanup(); }
  }
});

test("cleanup sanitized reference labels are rendered as plain text, never links or HTML", async () => {
  const referenceLabel = "member-media/<img src=x onerror=alert(1)>/portrait.jpg";
  const fixture = await mount(({ url, body }) => !body && url.includes("section=cleanup") ? response({
    items: [{ ...cleanupEntry, referenceLabel, storageReference: "https://private.invalid/object?token=DO_NOT_RENDER" }], limited: false,
  }) : undefined);
  try {
    const panel = cleanupPanel();
    assert.match(panel.textContent, /Stored media \(sanitized location\)/);
    assert.ok(panel.textContent.includes(referenceLabel));
    assert.equal(panel.querySelector("a, img, script"), null);
    assert.doesNotMatch(panel.textContent, /DO_NOT_RENDER|private\.invalid/);
    assert.equal(fixture.calls.some(call => call.body), false);
  } finally { await fixture.cleanup(); }
});

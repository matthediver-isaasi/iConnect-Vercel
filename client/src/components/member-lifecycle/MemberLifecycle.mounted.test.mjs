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
    assert.equal(fixture.calls.some(call => call.url.includes("section=")), false);
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
    assert.equal(fixture.calls.some(call => call.url.includes("section=")), false);
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
    const acknowledge = [...document.querySelectorAll('input[type="checkbox"]')].find(el => el.parentElement.textContent.includes("authorise the server"));
    await click(acknowledge);
    await click("Approve preview & enable rules");
    const call = fixture.calls.find(item => item.body?.action === "approve");
    assert.deepEqual(call.body, { action: "approve", previewId: "isolated-preview", expectedRevision: 7 });
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
    if (body?.action === "delete_preview") return response({ impactToken: "isolated-impact", fieldsRemoved: ["name", "email"], fieldsRetained: ["internal_id", "financial_history"], blockers: [] });
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
    if (body?.action === "minimise_preview") return response({ impactToken: "blocked-impact", fieldsRemoved: ["name"], fieldsRetained: ["member_id"], blockers: ["Unresolved legal retention"] });
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

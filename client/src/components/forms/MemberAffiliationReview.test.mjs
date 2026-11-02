import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node",
  "DocumentFragment", "Event", "CustomEvent", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const bundle = await build({
  entryPoints: ["client/src/components/forms/MemberAffiliationReview.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  logLevel: "silent",
  plugins: [{
    name: "isolated-authenticated-adapters",
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: "request", namespace: "test" }));
      builder.onResolve({ filter: /^@\/hooks\/useFormAlerts$/ }, () => ({ path: "context", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, args => ({
        contents: args.path === "context" ? "export const useFormAlertTenant = () => globalThis.reviewContext;"
          : "export const adminFetch = (...args) => globalThis.affiliationRequest(...args);",
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/affiliation-review-test.cjs`);
mod.filename = `${process.cwd()}/affiliation-review-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { MemberAffiliationReviewPanel: Panel, normalizeAffiliationResolution, hasLinkedAffiliationReview } = mod.exports;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => { dom.window.close(); delete globalThis.affiliationRequest; });
const tick = () => new Promise(resolve => setTimeout(resolve, 8));
const org = "11111111-1111-4111-8111-111111111111";
const secondary = "22222222-2222-4222-8222-222222222222";
const department = "33333333-3333-4333-8333-333333333333";
const anotherDepartment = "44444444-4444-4444-8444-444444444444";
const proposal = { primary: org, departments: [department], secondary: [] };
const envelope = (patch = {}) => ({
  active: true,
  review: { id: "review", status: "pending", version: 0,
    details: [{ kind: "department", fieldId: "departments", rowKey: null, requestedName: "Imaging team" }],
    proposal, resolution: null, ...patch },
  options: { complete: true,
    organizations: [{ id: org, label: "North Hospital" }, { id: secondary, label: "West Hospital" }],
    departments: [{ id: department, label: "Radiology", organizationId: org },
      { id: anotherDepartment, label: "Clinical imaging", organizationId: secondary }] },
});
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const button = (container, text) => [...container.querySelectorAll("button")].find(element => element.textContent === text);
async function click(element) {
  assert.ok(element);
  await act(async () => { element.click(); await tick(); });
}
async function mount(t, handler, context = { status: "ready", scopeKey: "one", tenantId: "tenant", assertCurrent() {} }) {
  const calls = [], approvals = [];
  globalThis.affiliationRequest = (...args) => { calls.push(args); return handler(...args); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Panel, { submissionId: "dd-one", context,
      onApprovalReadyChange: value => approvals.push(value) }));
    await tick();
  });
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, calls, approvals };
}

test("review uses labelled existing records and requires explicit complete-set confirmation", async t => {
  const { container, calls, approvals } = await mount(t, async (url, options) => response(
    options.method === "PUT" ? envelope({ version: 1, resolution: JSON.parse(options.body).resolution }) : envelope(),
  ));
  assert.match(container.textContent, /Imaging team/);
  assert.match(container.textContent, /North Hospital/);
  assert.match(container.textContent, /Radiology/);
  assert.doesNotMatch(container.textContent, /Clinical imaging/, "only final-org departments are eligible");
  assert.equal(button(container, "Save resolution").disabled, true);
  assert.equal(approvals.at(-1), false);
  const checks = [...container.querySelectorAll('[role="checkbox"]')];
  await click(checks.at(-1));
  await click(button(container, "Save resolution"));
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "/api/forms/member-affiliation-review");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    submission_id: "dd-one", expectedVersion: 0, resolution: proposal,
  });
  assert.equal(calls[1][2], "tenant");
  assert.equal(approvals.at(-1), true);
  assert.match(container.textContent, /Affiliations have not changed/);
});

test("changing final organisations retains departments for explicit review, never silently removes them", async t => {
  const { container, approvals } = await mount(t, async () => response(envelope({ version: 2, resolution: proposal })));
  assert.equal(approvals.at(-1), true);
  const checks = [...container.querySelectorAll('[role="checkbox"]')];
  await click(checks[1]); // Add West Hospital as a secondary organisation.
  assert.equal(approvals.at(-1), false);
  assert.match(container.textContent, /Clinical imaging/);
  assert.equal(container.querySelectorAll('[aria-checked="true"]').length, 2);
  assert.equal(button(container, "Save resolution").disabled, true, "new confirmation is required");
});

test("version conflicts preserve selections and prevent approval until reloaded", async t => {
  const { container, approvals } = await mount(t, async (url, options) => options.method === "PUT"
    ? response({ error: "Resolution changed. Reload before saving." }, 409) : response(envelope()));
  await click([...container.querySelectorAll('[role="checkbox"]')].at(-1));
  await click(button(container, "Save resolution"));
  assert.match(container.textContent, /Resolution changed/);
  assert.match(container.textContent, /North Hospital/);
  assert.equal(approvals.at(-1), false);
  assert.ok(button(container, "Reload review"));
});

test("missing canonical proposal or incomplete discovery fails closed", async t => {
  const bad = envelope({ proposal: undefined });
  const { container, approvals } = await mount(t, async () => response(bad));
  assert.match(container.textContent, /incomplete/);
  assert.equal(approvals.at(-1), false);
  assert.equal(container.querySelector('[role="combobox"]'), null);
});

test("unverified contexts make no requests; terminal decisions are not editable", async t => {
  const unverified = await mount(t, async () => response(envelope()), { status: "loading", scopeKey: "loading" });
  assert.equal(unverified.calls.length, 0);
  assert.match(unverified.container.textContent, /Verifying/);
  const terminal = await mount(t, async () => response(envelope({ status: "rejected", resolution: proposal, version: 2 })));
  assert.match(terminal.container.textContent, /This review is rejected/);
  assert.equal(terminal.approvals.at(-1), false);
  assert.equal(button(terminal.container, "Save resolution"), undefined);
});

test("canonical resolution has only known-target IDs and deduplicated sets", () => {
  assert.deepEqual(normalizeAffiliationResolution({ ...proposal, departments: [department, department] }), proposal);
  assert.throws(() => normalizeAffiliationResolution({ ...proposal, departments: ["new name"] }), /incomplete/);
});

test("ordinary or unlinked submissions cannot activate the review request gate", () => {
  const config = { affiliation_review: { enabled: true } };
  const marker = { active: true, review_id: org, due_diligence_submission_id: "dd-one" };
  assert.equal(hasLinkedAffiliationReview(marker, config, "dd-one"), true);
  assert.equal(hasLinkedAffiliationReview(undefined, config, "dd-one"), false);
  assert.equal(hasLinkedAffiliationReview(marker, {}, "dd-one"), false);
  assert.equal(hasLinkedAffiliationReview(marker, config, "dd-other"), false);
  assert.equal(hasLinkedAffiliationReview({ ...marker, active: false }, config, "dd-one"), false);
});

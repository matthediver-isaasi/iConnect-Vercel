import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const bundle = await build({
  entryPoints: ["client/src/components/forms/useMemberAffiliations.js"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  logLevel: "silent",
  plugins: [{
    name: "mock-authenticated-request",
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: "request", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: "export const adminFetch = (...args) => globalThis.affiliationRequest(...args);",
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/member-affiliation-prefill-test.cjs`);
mod.filename = `${process.cwd()}/member-affiliation-prefill-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { useMemberAffiliations, normalizeMemberAffiliations, memberAffiliationSubmissionValues, MEMBER_AFFILIATION_SNAPSHOT, affiliationCommitConfirmed } = mod.exports;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { combinePrefillStates } = await import("../../lib/formPrefillBarrier.js");
const { prepareFormSubmissionValues } = await import("../../lib/formSubmissionPayload.js");
after(() => { dom.window.close(); delete globalThis.affiliationRequest; });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const snapshot = (token = "snapshot-one", values = { org: "current-org", departments: [], sites: [] }) => ({
  active: true, snapshotToken: token, values, managedFieldIds: Object.keys(values),
});
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function mount(t, handler, initialProps = {}) {
  const calls = [];
  globalThis.affiliationRequest = (...args) => { calls.push(args); return handler(...args); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest;
  const props = { formId: "form-one", principalId: "local-viewer", tenantId: "tenant-one", ...initialProps };
  function Harness(input) {
    const [values, setValues] = React.useState({ note: "Keep me", org: "default-org", ...input.initialValues });
    const state = useMemberAffiliations({ ...input, setFormValues: setValues });
    latest = { values, state, setValues, barrier: combinePrefillStates(state) };
    return null;
  }
  async function render(patch = {}) {
    Object.assign(props, patch);
    await act(async () => { root.render(React.createElement(Harness, props)); await tick(); });
  }
  await render();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { calls, latest: () => latest, render };
}

test("blocks before discovery and applies active baseline only after defaults/draft initialization", async t => {
  const pending = deferred();
  const harness = await mount(t, () => pending.promise, { ready: false,
    initialValues: { org: "restored-draft-org", [MEMBER_AFFILIATION_SNAPSHOT]: "old-draft-token" },
  });
  assert.equal(harness.latest().barrier.locked, true);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0][0], "/api/forms/member-affiliations?form_id=form-one");
  assert.equal(harness.calls[0][1].credentials, "include");
  assert.equal(harness.calls[0][1].body, undefined, "never send browser member IDs");
  await act(async () => { pending.resolve(response(snapshot())); await tick(); });
  assert.equal(harness.latest().values.org, "restored-draft-org");
  assert.equal(harness.latest().barrier.locked, true);
  await harness.render({ ready: true });
  assert.equal(harness.latest().barrier.locked, false);
  assert.deepEqual(harness.latest().values, {
    org: "current-org", departments: [], sites: [], note: "Keep me",
    [MEMBER_AFFILIATION_SNAPSHOT]: "snapshot-one",
  });
});

test("rerenders and callback identity changes never replace edits, including empty removals", async t => {
  const harness = await mount(t, async () => response(snapshot()));
  await act(async () => harness.latest().setValues(previous => ({
    ...previous, org: "edited-org", departments: [], sites: [{ _row_id: "new-row", label: "My site" }],
  })));
  await harness.render();
  await harness.render({ ready: false });
  await harness.render({ ready: true });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.latest().values.org, "edited-org");
  assert.equal(harness.latest().values.sites[0]._row_id, "new-row");
  const prepared = memberAffiliationSubmissionValues(
    prepareFormSubmissionValues([{ id: "org", type: "organisation_dropdown" }], harness.latest().values),
    harness.latest().state,
  );
  assert.equal(prepared[MEMBER_AFFILIATION_SNAPSHOT], "snapshot-one");
  assert.deepEqual(prepared.departments, []);
});

test("ordinary public forms return inactive without requiring a member or changing answers", async t => {
  const harness = await mount(t, async () => response({ active: false }), {
    principalId: null, initialValues: { [MEMBER_AFFILIATION_SNAPSHOT]: "old-draft-token" },
  });
  assert.equal(harness.latest().barrier.locked, false);
  assert.equal(harness.latest().state.active, false);
  assert.equal(harness.latest().values.org, "default-org");
  assert.equal(memberAffiliationSubmissionValues(harness.latest().values, harness.latest().state)[MEMBER_AFFILIATION_SNAPSHOT], undefined);
});

test("authorization failure remains locked with retry, then applies the fresh token", async t => {
  let requests = 0;
  const harness = await mount(t, async () => ++requests === 1
    ? response({ error: "No session" }, 401) : response(snapshot("retried-token")));
  assert.equal(harness.latest().barrier.locked, true);
  assert.match(harness.latest().state.error.message, /Sign in with your member account/);
  await act(async () => { harness.latest().state.error.retry(); await tick(); });
  assert.equal(harness.latest().barrier.locked, false);
  assert.equal(harness.latest().values[MEMBER_AFFILIATION_SNAPSHOT], "retried-token");
});

test("rejects incomplete snapshots instead of unlocking a destructive partial baseline", async t => {
  const harness = await mount(t, async () => response({ ...snapshot(), values: { org: "org" } }));
  assert.equal(harness.latest().barrier.locked, true);
  assert.match(harness.latest().state.error.message, /missing/);
  assert.equal(harness.latest().values.org, "default-org");
  assert.throws(() => normalizeMemberAffiliations({ active: true }), /could not be verified/);
});

test("ignores a stale form response and isolates viewer changes", async t => {
  const stale = deferred();
  const harness = await mount(t, async url => url.includes("form-one") ? stale.promise : response(snapshot("form-two-token")));
  await harness.render({ formId: "form-two" });
  await act(async () => { stale.resolve(response(snapshot("stale-token"))); await tick(); });
  assert.equal(harness.latest().values[MEMBER_AFFILIATION_SNAPSHOT], "form-two-token");
  globalThis.affiliationRequest = async () => response({ active: false });
  await harness.render({ principalId: null });
  assert.equal(harness.latest().values.org, undefined);
  assert.equal(harness.latest().values[MEMBER_AFFILIATION_SNAPSHOT], undefined);
  assert.equal(harness.latest().values.note, "Keep me");
});

test("standalone hook stays dormant when disabled and composes with other prefill barriers", async t => {
  const harness = await mount(t, async () => response(snapshot()), { enabled: false });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.latest().state.pending, false);
  assert.equal(harness.latest().barrier.locked, false);
  assert.equal(harness.latest().values.org, "default-org");
  assert.equal(combinePrefillStates(harness.latest().state, { pending: true }).locked, true);
  const otherError = { message: "Another prefill failed", retry() {} };
  assert.equal(combinePrefillStates(harness.latest().state, { error: otherError }).error, otherError);
  await harness.render({ enabled: true });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.latest().values.org, "current-org");
});

test("submission acknowledgement distinguishes protected completion from ordinary submit success", () => {
  assert.equal(affiliationCommitConfirmed({ id: "submission" }), false);
  assert.equal(affiliationCommitConfirmed({ member_affiliations: { status: "pending" } }), false);
  for (const status of ["applied", "already_applied", "awaiting_review"]) {
    assert.equal(affiliationCommitConfirmed({ member_affiliations: { status } }), true);
  }
});

test("an explicitly opted-in form cannot silently fall back when its configuration disappears", async t => {
  const harness = await mount(t, async () => response({ active: false }), { requireActive: true });
  assert.equal(harness.latest().barrier.locked, true);
  assert.match(harness.latest().state.error.message, /settings changed/);
});

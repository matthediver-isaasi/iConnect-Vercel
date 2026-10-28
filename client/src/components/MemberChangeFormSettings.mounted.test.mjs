import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Run through scripts/run-isolated-tests.mjs; all HTTP is replaced before mount.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/MemberChangeFormSettings.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "member-change-settings-isolated-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      // Bundle the REAL settings helper: exercise URL, credentials and payload.
      builder.onResolve({ filter: /^@\/lib\/memberChangeFormSettings$/ }, () => ({
        path: `${process.cwd()}/client/src/lib/memberChangeFormSettings.js`,
      }));
      builder.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        loader: "js",
        contents: `import React from "react";
          const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
          export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div"), Button = wrap("button");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/member-change-settings-mounted-isolated.cjs`);
compiled.filename = `${process.cwd()}/member-change-settings-mounted-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
const fixture = (overrides = {}) => ({
  formId: "form-settings", enabled: false, targetConfigIds: [], revision: 3,
  targetOptions: [{ id: "professional", name: "Professional" }, { id: "associate", name: "Associate" }],
  requiresAuthentication: true, formActive: true, executionEnabled: false, ...overrides,
});
const context = (scopeKey = "tenant-a", status = "ready") => ({
  scopeKey, status, tenantId: scopeKey, assertCurrent() {},
});
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(predicate) {
  for (let i = 0; i < 65; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.fail(`Timed out: ${document.body.textContent}`);
}
const button = text => [...document.querySelectorAll("button")].find(item => item.textContent === text);
const checkbox = name => [...document.querySelectorAll("label")].find(item => item.textContent.includes(name))?.querySelector("input");
async function click(element) {
  assert.ok(element, "interactive element exists");
  assert.equal(element.disabled, false);
  await act(async () => element.click());
}
async function mount({ data = fixture(), get, post, props = {} } = {}) {
  const calls = [];
  let stored = data;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, payload });
    if (!payload) {
      assert.match(url, /^\/api\/membership\/member-amendments\?action=form_change_settings&formId=/);
      return get ? get(url, options) : json(stored);
    }
    assert.equal(url, "/api/membership/member-amendments");
    assert.equal(options.method, "POST");
    if (post) return post(payload);
    stored = { ...stored, ...payload, revision: stored.revision + 1 };
    return json(stored);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let currentProps = { formId: "form-settings", tenantContext: context(), ...props };
  const render = async updates => {
    currentProps = { ...currentProps, ...updates };
    await act(async () => root.render(React.createElement(Component, currentProps)));
  };
  await render({});
  return {
    calls, container, render,
    async cleanup() { await act(async () => root.unmount()); container.remove(); },
  };
}
const loaded = () => !!checkbox("Enable membership-change configuration");

test("unsaved forms and unverified tenant sessions never request protected settings", async () => {
  const view = await mount({ props: { formId: null } });
  try {
    assert.match(view.container.textContent, /Save this form first/);
    assert.equal(view.calls.length, 0);
    await view.render({ formId: "saved", tenantContext: context("tenant-a", "loading") });
    assert.match(view.container.textContent, /Verifying your tenant/);
    assert.equal(view.calls.length, 0);
    await view.render({ tenantContext: context("tenant-a", "error") });
    assert.match(view.container.textContent, /could not be verified/);
    assert.equal(view.calls.length, 0);
  } finally { await view.cleanup(); }
});

test("loading skeleton, GET error and retry reach the real settings editor", async () => {
  const gate = defer();
  let attempt = 0;
  const view = await mount({ get: () => ++attempt === 1 ? gate.promise : json(fixture()) });
  try {
    assert.ok(view.container.querySelector('[aria-label="Loading membership-change settings"]'));
    await act(async () => gate.resolve(json({ error: "Discovery unavailable" }, 503)));
    await waitFor(() => view.container.textContent.includes("Discovery unavailable"));
    await click(button("Retry loading settings"));
    await waitFor(loaded);
    assert.equal(view.calls.length, 2);
    assert.equal(button("Save membership-change settings").disabled, true);
  } finally { await view.cleanup(); }
});

test("enabled configuration requires persisted authentication and an active selection; saves only separate settings", async () => {
  let server = fixture({ requiresAuthentication: false });
  const view = await mount({
    get: () => json(server),
    post: payload => { server = { ...server, ...payload, revision: 4 }; return json(server); },
    props: { persistedAuthentication: false },
  });
  try {
    await waitFor(loaded);
    await click(checkbox("Enable membership-change configuration"));
    await click(checkbox("Professional"));
    assert.equal(button("Save membership-change settings").disabled, true);
    assert.match(view.container.textContent, /authentication must already be saved/);
    assert.equal(view.calls.filter(call => call.payload).length, 0);
    server = { ...server, requiresAuthentication: true };
    await view.render({ persistedAuthentication: true });
    await waitFor(() => !button("Save membership-change settings").disabled);
    assert.equal(checkbox("Professional").checked, true);
    await click(checkbox("Professional"));
    assert.equal(button("Save membership-change settings").disabled, true);
    await click(checkbox("Associate"));
    await click(button("Save membership-change settings"));
    await waitFor(() => view.container.textContent.includes("Membership-change settings saved."));
    assert.deepEqual(view.calls.find(call => call.payload).payload, {
      action: "form_change_settings", formId: "form-settings",
      enabled: true, targetConfigIds: ["associate"], revision: 3,
    });
    assert.equal(button("Save membership-change settings").disabled, true);
    assert.match(view.container.textContent, /does not yet enable the member journey or financial operations/);
  } finally { await view.cleanup(); }
});

test("enabled settings block every unavailable target even with an active selection; explicit removal allows saving", async () => {
  const view = await mount({ data: fixture({ targetConfigIds: ["retired-structure", "inactive-structure"] }) });
  try {
    await waitFor(loaded);
    assert.match(view.container.textContent, /Unavailable saved targetretired-structure/);
    await click(checkbox("Enable membership-change configuration"));
    assert.equal(button("Save membership-change settings").disabled, true);
    await click(checkbox("Professional"));
    assert.equal(button("Save membership-change settings").disabled, true);
    assert.match(view.container.textContent, /even when an active structure is selected/);
    assert.equal(view.calls.filter(call => call.payload).length, 0);
    await click(view.container.querySelector('[aria-label="Remove unavailable target retired-structure"]'));
    assert.equal(button("Save membership-change settings").disabled, true, "one missing target still blocks saving");
    await click(button("Remove unavailable targets"));
    assert.equal(checkbox("Professional").checked, true);
    await click(button("Save membership-change settings"));
    await waitFor(() => view.container.textContent.includes("Membership-change settings saved."));
    assert.deepEqual(view.calls.find(call => call.payload).payload.targetConfigIds, ["professional"]);
  } finally { await view.cleanup(); }
});

test("disabling works without saved authentication or active structures and does not clear targets", async () => {
  const view = await mount({ data: fixture({
    enabled: true, requiresAuthentication: false, targetOptions: [],
    targetConfigIds: ["retired"], formActive: false,
  }) });
  try {
    await waitFor(loaded);
    assert.match(view.container.textContent, /No active member structures/);
    assert.match(view.container.textContent, /does not activate it/);
    await click(checkbox("Enable membership-change configuration"));
    assert.equal(button("Remove unavailable targets"), undefined);
    assert.match(view.container.textContent, /Unavailable saved targetretired/);
    assert.equal(button("Save membership-change settings").disabled, false);
    await click(button("Save membership-change settings"));
    await waitFor(() => view.container.textContent.includes("Membership-change settings saved."));
    assert.equal(view.calls.find(call => call.payload).payload.enabled, false);
    assert.deepEqual(view.calls.find(call => call.payload).payload.targetConfigIds, ["retired"]);
  } finally { await view.cleanup(); }
});

test("GET permission errors expose no editor and can retry; POST denial locks the existing draft", async () => {
  for (const status of [401, 403]) {
    let permitted = false;
    const view = await mount({
      get: () => permitted ? json(fixture()) : json({ error: "Forbidden" }, status),
      post: () => json({ error: "Forbidden" }, status),
    });
    try {
      await waitFor(() => view.container.textContent.includes("Permission denied"));
      assert.equal(loaded(), false);
      permitted = true;
      await click(button("Retry loading settings"));
      await waitFor(loaded);
      await click(checkbox("Professional"));
      await click(button("Save membership-change settings"));
      await waitFor(() => view.container.textContent.includes("Permission denied"));
      assert.equal(view.container.querySelector("fieldset").disabled, true);
      assert.equal(checkbox("Professional").checked, true);
      assert.equal(button("Save membership-change settings").disabled, true);
    } finally { await view.cleanup(); }
  }
});

test("stale revisions require explicit reload, preserving unsaved choices against newer discovery", async () => {
  let latest = fixture();
  let attempts = 0;
  const view = await mount({
    get: () => json(latest),
    post: payload => {
      if (++attempts === 1) {
        latest = fixture({ revision: 9, enabled: false, targetConfigIds: ["associate"], targetOptions: [{ id: "associate", name: "Associate" }] });
        return json({ error: "Revision conflict" }, 409);
      }
      latest = { ...latest, ...payload, revision: 10 };
      return json(latest);
    },
  });
  try {
    await waitFor(loaded);
    await click(checkbox("Enable membership-change configuration"));
    await click(checkbox("Professional"));
    await click(button("Save membership-change settings"));
    await waitFor(() => !!button("Reload latest settings"));
    assert.equal(button("Save membership-change settings").disabled, true);
    assert.equal(view.calls.filter(call => !call.payload).length, 1, "no silent auto-reload");
    await click(button("Reload latest settings"));
    await waitFor(() => view.container.textContent.includes("Latest settings loaded."));
    assert.equal(checkbox("Enable membership-change configuration").checked, true);
    assert.equal(checkbox("Associate").checked, false, "server choices do not replace draft");
    assert.match(view.container.textContent, /Unavailable saved targetprofessional/);
    assert.equal(button("Save membership-change settings").disabled, true);
    await click(checkbox("Associate"));
    assert.equal(button("Save membership-change settings").disabled, true);
    await click(button("Remove unavailable targets"));
    await click(button("Save membership-change settings"));
    await waitFor(() => view.container.textContent.includes("Membership-change settings saved."));
    assert.deepEqual(view.calls.filter(call => call.payload)[1].payload, {
      action: "form_change_settings", formId: "form-settings",
      enabled: true, targetConfigIds: ["associate"], revision: 9,
    });
  } finally { await view.cleanup(); }
});

test("ordinary save errors keep choices and permit a deliberate retry", async () => {
  const view = await mount({ post: () => json({ error: "Temporary save outage" }, 503) });
  try {
    await waitFor(loaded);
    await click(checkbox("Professional"));
    await click(button("Save membership-change settings"));
    await waitFor(() => view.container.textContent.includes("Temporary save outage"));
    assert.equal(checkbox("Professional").checked, true);
    assert.equal(button("Save membership-change settings").disabled, false);
  } finally { await view.cleanup(); }
});

test("422 validation errors retain the draft without entering the stale-revision workflow", async () => {
  const view = await mount({ post: () => json({ error: "Selected member structure is no longer active." }, 422) });
  try {
    await waitFor(loaded);
    await click(checkbox("Enable membership-change configuration"));
    await click(checkbox("Professional"));
    await click(button("Save membership-change settings"));
    await waitFor(() => view.container.textContent.includes("Selected member structure is no longer active."));
    assert.equal(checkbox("Professional").checked, true);
    assert.equal(button("Reload latest settings"), undefined);
    assert.equal(view.calls.filter(call => !call.payload).length, 1, "validation errors must not silently reload");
    assert.equal(button("Save membership-change settings").disabled, false);
  } finally { await view.cleanup(); }
});

test("form and tenant switches abort GETs and suppress late results even when transport ignores abort", async () => {
  const first = defer();
  const second = defer();
  const third = defer();
  let requests = 0;
  const view = await mount({ get: () => [first, second, third][requests++].promise });
  try {
    const initialSignal = view.calls[0].options.signal;
    await view.render({ formId: "other-form" });
    assert.equal(initialSignal.aborted, true);
    const nextSignal = view.calls[1].options.signal;
    await view.render({ tenantContext: context("tenant-b") });
    assert.equal(nextSignal.aborted, true);
    await act(async () => first.resolve(json(fixture({ targetOptions: [{ id: "old", name: "OLD TENANT DATA" }] }))));
    assert.doesNotMatch(view.container.textContent, /OLD TENANT DATA/);
    await act(async () => second.resolve(json(fixture({ formId: "other-form", targetOptions: [{ id: "old", name: "OLD FORM DATA" }] }))));
    assert.doesNotMatch(view.container.textContent, /OLD FORM DATA/);
    assert.equal(loaded(), false);
    await act(async () => third.resolve(json(fixture({ formId: "other-form" }))));
    await waitFor(loaded);
    assert.match(view.container.textContent, /Professional/);
  } finally { await view.cleanup(); }
});

test("unmount aborts pending reads and rejects late data", async () => {
  const gate = defer();
  const view = await mount({ get: () => gate.promise });
  const signal = view.calls[0].options.signal;
  await view.cleanup();
  assert.equal(signal.aborted, true);
  await act(async () => gate.resolve(json(fixture())));
  assert.equal(document.body.textContent, "");
});

test("live tenant guard blocks saving before the new tenant renders", async () => {
  let valid = true;
  const tenantContext = {
    ...context(),
    assertCurrent() { if (!valid) throw new Error("Tenant switched. Reopen this form."); },
  };
  const view = await mount({ props: { tenantContext } });
  try {
    await waitFor(loaded);
    await click(checkbox("Professional"));
    valid = false;
    await click(button("Save membership-change settings"));
    assert.equal(view.calls.filter(call => call.payload).length, 0);
    assert.equal(checkbox("Professional").checked, true);
  } finally { await view.cleanup(); }
});

test("late POST results after a tenant switch cannot report success or reload in the new scope", async () => {
  const gate = defer();
  const view = await mount({ post: () => gate.promise });
  try {
    await waitFor(loaded);
    await click(checkbox("Professional"));
    await click(button("Save membership-change settings"));
    await waitFor(() => !!button("Saving settings…"));
    await view.render({ tenantContext: context("tenant-b") });
    await waitFor(loaded);
    const count = view.calls.length;
    await act(async () => gate.resolve(json(fixture({ revision: 4 }))));
    assert.equal(view.calls.length, count, "old POST must not trigger GET in new scope");
    assert.doesNotMatch(view.container.textContent, /Membership-change settings saved/);
    assert.equal(checkbox("Professional").checked, false);
  } finally { await view.cleanup(); }
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://isolated.example.test/FormView?slug=ordinary", pretendToBeVisual: true,
});
const { window } = dom;
for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "location", "history",
  "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "DocumentFragment", "MutationObserver", "Text"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] });
}
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.localStorage.setItem("tenant_slug", "isolated");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
// Bundle the real availability component, session fence, transport helper and
// FormView. Only HTTP and ordinary form data dependencies are replaced.
const bundle = await build({
  stdin: { contents: [
    "export {default as Component} from './client/src/components/MemberChangeFormLink.jsx';",
    "export {default as FormView} from './client/src/pages/FormView.jsx';",
    "export {default as LayoutContext} from './client/src/contexts/LayoutContext.jsx';",
    "export {publicClient} from './client/src/api/publicClient.js';",
    "export {base44,setActiveTenantId} from './client/src/api/base44Client.js';",
    "export {invalidateViewerProtectedWork,setViewerProtectedWorkPaused} from './client/src/lib/viewerProtectedWorkGate.js';",
    "export {MemoryRouter} from 'react-router-dom';",
    "export {QueryClient,QueryClientProvider} from '@tanstack/react-query';",
  ].join("\n"), resolveDir: process.cwd(), loader: "js" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", logLevel: "silent",
  plugins: [{ name: "ignore-css", setup(builder) {
    builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "css" }));
    builder.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
  } }],
});
const compiled = new Module(`${process.cwd()}/member-change-form-link-isolated.cjs`);
compiled.filename = `${process.cwd()}/member-change-form-link-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { Component, FormView, LayoutContext, publicClient, base44, setActiveTenantId,
  invalidateViewerProtectedWork, setViewerProtectedWorkPaused, MemoryRouter, QueryClient, QueryClientProvider } = compiled.exports;
const h = React.createElement;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const formId = "e7019952-b991-4f60-8caf-b71efdbfe661";
const otherFormId = "f7019952-b991-4f60-8caf-b71efdbfe662";
const member = { id: "own-member", tenant_id: "tenant-a", role_id: "member-role" };
const session = overrides => ({
  authResolved: true, sessionValidated: true, memberInfo: member, organizationInfo: null,
  sessionRoleSnapshot: { member_id: member.id, tenant_id: member.tenant_id, role_id: member.role_id,
    session_key: "session-a", status: "ready", role: { id: member.role_id, excluded_features: [] } },
  setForceBlankLayout() {}, setMemberInfo() {}, setOrganizationInfo() {}, retrySessionRole() {},
  ...overrides,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
async function mount({ auth = session(), props = {}, transport = () => json({ available: true }), definition, search = "" } = {}) {
  setActiveTenantId(null);
  setViewerProtectedWorkPaused(false);
  const calls = [], submissions = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === "/api/auth/me") return json(auth.memberInfo);
    if (url === "/api/forms/send-submission-email") return json({ success: true });
    assert.match(url, /^\/api\/membership\/member-amendments\?action=member_change_availability&formId=/);
    assert.equal(options.credentials, "include");
    assert.equal(options.body, undefined);
    assert.notEqual(options.method, "POST");
    assert.equal(new Headers(options.headers).has("X-Tenant-Id"), false);
    assert.equal(new URL(url, window.location.origin).searchParams.has("memberId"), false);
    calls.push({ url, options });
    return transport(url, options);
  };
  publicClient.getForm = async () => definition;
  publicClient.getFormConsentMessage = async () => ({ message: "" });
  publicClient.submitForm = async payload => { submissions.push(payload); return { success: true, id: "ordinary-submission" }; };
  base44.entities.MemberPreferenceValue.list = async () => [];
  base44.entities.MemberResourceCategory.list = async () => [];
  base44.entities.Member.get = async () => member;
  base44.entities.Form.update = async () => definition;
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 },
  } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let currentProps = { formId, ...props }, context = auth;
  const render = async (next = {}, nextContext) => {
    currentProps = { ...currentProps, ...next };
    if (nextContext) context = nextContext;
    await act(async () => root.render(h(QueryClientProvider, { client },
      h(LayoutContext.Provider, { value: context }, h(MemoryRouter,
        { initialEntries: [`/FormView?slug=ordinary${search}`] },
        definition ? h(FormView, { slug: "ordinary" }) : h(Component, currentProps))))));
    await settle();
  };
  await render();
  return { calls, submissions, container, render, async cleanup() {
    await act(async () => root.unmount()); client.clear(); container.remove();
    setActiveTenantId(null); setViewerProtectedWorkPaused(false);
  } };
}

test("only an explicit server availability grant reveals a separate own-member review link", async () => {
  const view = await mount();
  try {
    assert.equal(view.calls.length, 1);
    assert.equal(view.calls[0].url, `/api/membership/member-amendments?action=member_change_availability&formId=${formId}`);
    assert.equal(view.container.querySelector("a").getAttribute("href"), `/MembershipChange?formId=${formId}`);
    assert.match(view.container.textContent, /ordinary submission are unchanged/);
    assert.match(view.container.textContent, /No payment or membership change runs automatically/);
    assert.equal(window.location.pathname, "/FormView");
  } finally { await view.cleanup(); }
  for (const result of [{ available: false }, {}, { available: "true" }, { available: 1 }]) {
    const hidden = await mount({ transport: () => json(result) });
    try { assert.equal(hidden.container.textContent, ""); assert.equal(hidden.calls.length, 1); }
    finally { await hidden.cleanup(); }
  }
});

test("guest, dashboard-only, unvalidated, paused and mismatched member sessions never request availability", async () => {
  for (const auth of [
    session({ memberInfo: null, sessionValidated: false }),
    session({ memberInfo: null, tenantUser: { id: "administrator" } }),
    session({ sessionValidated: false }),
    session({ authResolved: false }),
    session({ sessionWorkPaused: true }),
    session({ sessionRoleSnapshot: { session_key: "wrong", member_id: "another-member", tenant_id: "tenant-a" } }),
  ]) {
    const view = await mount({ auth });
    try { assert.equal(view.calls.length, 0); assert.equal(view.container.textContent, ""); }
    finally { await view.cleanup(); }
  }
});

test("unsaved/invalid forms and on-behalf-of or management suppression never call the endpoint", async () => {
  for (const props of [{ formId: null }, { formId: "unsaved" }, { disabled: true }]) {
    const view = await mount({ props });
    try { assert.equal(view.calls.length, 0); assert.equal(view.container.textContent, ""); }
    finally { await view.cleanup(); }
  }
});

test("availability errors and unreadable responses stay hidden without retries or login navigation", async () => {
  for (const transport of [
    () => json({ error: "Sign in" }, 401), () => json({ error: "Forbidden" }, 403),
    () => json({ error: "Unavailable" }, 503), () => new Response("invalid JSON"),
    () => { throw new Error("Network unavailable"); },
  ]) {
    const view = await mount({ transport });
    try {
      await view.render();
      assert.equal(view.calls.length, 1);
      assert.equal(view.container.textContent, "");
      assert.equal(window.location.pathname, "/FormView");
    } finally { await view.cleanup(); }
  }
});

test("form and member/session changes abort old requests and fence late availability grants", async () => {
  for (const boundary of ["form", "member", "session"]) {
    const gate = defer();
    let reads = 0;
    const view = await mount({ transport: () => ++reads === 1 ? gate.promise : json({ available: false }) });
    try {
      const nextContext = boundary === "member" ? session({ memberInfo: null, sessionValidated: false })
        : boundary === "session" ? session({ sessionRoleSnapshot: { ...session().sessionRoleSnapshot, session_key: "session-b" } }) : undefined;
      await view.render(boundary === "form" ? { formId: otherFormId } : {}, nextContext);
      assert.equal(view.calls[0].options.signal.aborted, true);
      assert.equal(view.calls.length, boundary === "member" ? 1 : 2);
      // The new scope has independently received false. A late true from the
      // previous scope must not overwrite that authoritative hidden state.
      await act(async () => gate.resolve(json({ available: true })));
      assert.equal(view.container.textContent, "");
    } finally { await view.cleanup(); }
  }
});

test("tenant switches and protected-work pauses remove discovery and fence pending responses", async () => {
  for (const change of [() => setActiveTenantId("tenant-other"), () => setViewerProtectedWorkPaused(true)]) {
    const gate = defer();
    const view = await mount({ transport: () => gate.promise });
    try {
      await act(async () => change());
      assert.equal(view.calls[0].options.signal.aborted, true);
      await act(async () => gate.resolve(json({ available: true })));
      assert.equal(view.container.textContent, "");
    } finally { await view.cleanup(); }
  }
  const visible = await mount();
  try {
    assert.ok(visible.container.querySelector("a"));
    await act(async () => invalidateViewerProtectedWork());
    await settle();
    assert.equal(visible.calls.length, 2);
    // Each generation gets an independent server grant, never a cached
    // availability assumption from ordinary form settings.
    assert.ok(visible.container.querySelector("a"));
  } finally { await visible.cleanup(); }
});

const ordinaryForm = layout => ({
  id: formId, slug: "ordinary", name: "Ordinary application", is_active: true,
  submit_button_text: "Submit",
  layout_type: layout, prefill_source: "none", entity_pipelines: {},
  pages: [{ id: "details", title: "Details" }], fields: [],
});
for (const layout of ["standard", "card_swipe"]) {
  test(`actual FormView ${layout} mounts discovery without redirecting or replacing ordinary submission`, async () => {
    const view = await mount({ definition: ordinaryForm(layout) });
    try {
      assert.equal(view.calls.length, 1);
      assert.ok(view.container.querySelector('[aria-label="Membership change review"] a'));
      assert.match(view.container.textContent, /Ordinary application/);
      const submit = [...view.container.querySelectorAll("button")].find(node => node.textContent === "Submit");
      assert.ok(submit, "ordinary form submit control remains");
      await act(async () => submit.click());
      for (let i = 0; i < 20 && !view.submissions.length; i++) await settle();
      assert.equal(view.submissions.length, 1);
      assert.equal(view.submissions[0].form_id, formId);
      for (let i = 0; i < 20 && !view.container.textContent.includes("Success!"); i++) await settle();
      assert.match(view.container.textContent, /Success!/);
      assert.equal(view.calls.length, 1, "ordinary submission never sends a membership mutation");
      assert.equal(window.location.pathname, "/FormView");
    } finally { await view.cleanup(); }
  });
}

test("actual FormView on-behalf-of member parameter does not trigger own-member discovery", async () => {
  const view = await mount({ definition: ordinaryForm("standard"), search: "&member_id=another-member" });
  try {
    assert.equal(view.calls.length, 0);
    assert.equal(view.container.querySelector('[aria-label="Membership change review"]'), null);
  } finally { await view.cleanup(); }
});

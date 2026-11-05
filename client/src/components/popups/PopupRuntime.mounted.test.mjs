import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build, transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// Isolated transport and modal seam: no DB, tenant, provider or live API calls.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://popup.example.test/notice" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/popups/PopupRuntime.jsx"], bundle: true, write: false,
  packages: "external", platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
  plugins: [{
    name: "isolated-popup-runtime",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/|$)/ }, (args) => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^(react-router-dom|@\/hooks\/useCookieConsent|@\/api\/publicClient|@\/lib\/cmsPopups|\.\/PopupModal)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "react-router-dom" ? "export const useLocation = () => globalThis.__popupTest.location;"
          : path.includes("useCookieConsent") ? "export const useCookieConsent = () => globalThis.__popupTest.consent;"
            : path.includes("publicClient") ? "export const getTenantSlugFromLocation = () => 'tenant-fixture';"
              : path.includes("cmsPopups") ? "export const popupRequest = (...args) => globalThis.__popupTest.request(...args);"
                : `import React from 'react';
export default function PopupModal({onClose,children}) {
 const [count,setCount] = React.useState(0);
 return <section role="dialog" data-cms-popup-modal><button id="counter" onClick={()=>setCount(count+1)}>Count {count}</button><button id="close" onClick={onClose}>Close</button>{children}</section>;
}`,
        loader: "jsx",
      }));
    },
  }],
});
const module = new Module(`${process.cwd()}/popup-runtime-isolated.cjs`);
module.filename = `${process.cwd()}/popup-runtime-isolated.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(bundle.outputFiles[0].text, module.filename);
const PopupRuntime = module.exports.default;
const homeSource = readFileSync(new URL("../../pages/HomePageRedirect.jsx", import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "")
  .replace("export default function HomePageRedirect", "function HomePageRedirect");
const homeCode = transformSync(`${homeSource}\nmodule.exports = HomePageRedirect;`, { loader: "jsx", jsx: "transform", format: "cjs" }).code;
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
const originalTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
after(() => { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClearTimeout; dom.window.close(); delete globalThis.__popupTest; });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
let sequence = 0;
async function mount({ member = false, pendingConsent = false, selectedError = false, otherDialog = false, slowRead = false,
  home = null, trigger = { type: "immediate", value: 0 }, prefetch = null,
  frequency = "day", durableState, sessionState, actualViewer, expectedViewer,
  categories = { analytics: true, functional: true }, hasConsented = true } = {}) {
  sequence += 1;
  const timers = new Map();
  globalThis.setInterval = (fn, ms) => { timers.set(ms, fn); return ms; };
  globalThis.clearInterval = (id) => timers.delete(id);
  const deadlines = new Map();
  let deadlineId = -1;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 10000) { const id = deadlineId--; deadlines.set(id, { fn, ms }); return id; }
    return originalTimeout(fn, ms, ...args);
  };
  globalThis.clearTimeout = (id) => { if (deadlines.has(id)) deadlines.delete(id); else originalClearTimeout(id); };
  const calls = [];
  let release;
  const readGate = new Promise((resolve) => { release = resolve; });
  const popup = { id: `popup-${sequence}`, revision: 3, dismissal_generation: 2,
    config: { priority: 8, trigger, frequency: { type: frequency, days: 1 }, allow_session: true, allow_permanent: true }, design: { version: 1, root: { sections: [] } } };
  const context = { tenant_id: "tenant-fixture", viewer_key: actualViewer || (member ? `member:person-${sequence}` : "guest"), timezone: "UTC" };
  const fixture = {
    location: { key: `entry-${sequence}`, pathname: `/notice-${sequence}` },
    context, selectedError, hangRevalidation: false, hangSelectedRevalidation: false,
    consent: { isLoaded: true, isPending: pendingConsent, hasConsented, categories },
    request: async (query, options = {}) => {
      calls.push({ query, options });
      if (options.method === "POST") return { success: true };
      if (fixture.hangRevalidation && new URLSearchParams(query).get("revalidate") === "1") return new Promise(() => {});
      if (fixture.hangSelectedRevalidation && new URLSearchParams(query).get("revalidate") === "1" && new URLSearchParams(query).has("id")) return new Promise(() => {});
      if (new URLSearchParams(query).has("id")) {
        if (slowRead) await readGate;
        if (fixture.selectedError) throw new Error("Authorization unavailable");
        return { ...context, popup };
      }
      return { ...context, candidates: [popup] };
    },
  };
  globalThis.__popupTest = fixture;
  const storageKey = `cms-popup:${context.tenant_id}:${context.viewer_key}:${popup.id}:${popup.dismissal_generation}`;
  if (durableState) window.localStorage.setItem(storageKey, JSON.stringify(durableState));
  if (sessionState) window.sessionStorage.setItem(storageKey, JSON.stringify(sessionState));
  document.body.innerHTML = `<div id="root"></div>${otherDialog ? '<div id="competing" role="dialog"></div>' : ""}${home?.stripeTelemetry ? '<iframe src="https://js.stripe.com/v3/m-outer.html" style="visibility:hidden;height:1px"></iframe>' : ""}`;
  const root = createRoot(document.getElementById("root"));
  const props = { page: { id: `page-${sequence}`, slug: `page-${sequence}`, microsite_id: "microsite-fixture" }, viewerIdentity: expectedViewer || (member ? context.viewer_key : "guest") };
  if (prefetch) props.initialDiscovery = {
    pageSlug: props.page.slug, viewerIdentity: props.viewerIdentity,
    promise: Promise.resolve({ receivedAt: Date.now() - (prefetch.age || 0),
      data: { ...context, page_id: prefetch.pageId || props.page.id, viewer_key: prefetch.viewer || context.viewer_key, candidates: [popup] } }),
  };
  let MountedRuntime = PopupRuntime;
  if (home) {
    const exports = { exports: {} };
    vm.runInNewContext(homeCode, {
      module: exports, React, useRef: React.useRef, useEffect: React.useEffect, popupDiagnostic: () => {}, window, URLSearchParams, PopupRuntime,
      useLocation: () => ({ ...fixture.location, search: home.preview ? "?_canvasPreview=1" : "" }),
      useMemberAccess: () => ({ authResolved: home.authResolved !== false, sessionValidated: member,
        isAccessReady: home.accessReady !== false, memberInfo: member ? { id: context.viewer_key.slice(7) } : null }),
      useTenantBranding: () => ({ branding: { id: context.tenant_id }, loading: false, error: null, tenantSlug: "tenant-fixture" }),
      usePageLayoutDecision: () => {},
      useQuery: ({ queryKey }) => queryKey[0] === "home-page-setting"
        ? { data: "homely", isSuccess: true, isFetching: false }
        : { data: { page: { ...props.page, status: home.status || "published", builder_type: home.type }, elements: [] }, isSuccess: true, isFetching: false },
      IEditElementRenderer: () => null, CanvasPageRenderer: () => null,
      StaticHtmlPageRenderer: () => null, Events: () => null,
    });
    MountedRuntime = exports.exports;
  }
  let currentProps = props;
  await act(async () => root.render(React.createElement(MountedRuntime, props)));
  await settle();
  return { root, fixture, calls, popup, release, props, storageKey, deadlines,
    tick: async (ms = 500) => { await act(async () => { await timers.get(ms)?.(); }); await settle(); },
    startTick: async (ms) => { await act(async () => { void timers.get(ms)?.(); }); await settle(); },
    expireRequests: async () => { await act(async () => { for (const { fn } of [...deadlines.values()]) fn(); }); await settle(); },
    rerender: async (updates = {}, location) => {
      if (location) fixture.location = location;
      currentProps = { ...currentProps, ...updates };
      await act(async () => root.render(React.createElement(PopupRuntime, currentProps)));
      await settle();
    },
    unmount: async () => { await act(async () => root.unmount()); },
  };
}
test("member impression includes microsite and daily revalidation preserves interactive state", async () => {
  const app = await mount({ member: true });
  assert.ok(document.querySelector("[data-cms-popup-modal]"));
  const shown = app.calls.find((call) => call.options.method === "POST");
  assert.equal(JSON.parse(shown.options.body).microsite_id, "microsite-fixture");
  await act(async () => document.getElementById("counter").click());
  await app.tick(30000);
  assert.equal(document.getElementById("counter").textContent, "Count 1");
  const refresh = app.calls.filter((call) => new URLSearchParams(call.query).get("revalidate") === "1");
  assert.equal(refresh.length, 2, "batched eligibility and selected authorization both bypass shown frequency");
  await app.unmount();
});
test("prefetched discovery skips a duplicate batch but still freshly authorizes selected content", async () => {
  const app = await mount({ member: true, prefetch: {} });
  try {
    assert.ok(document.querySelector("[data-cms-popup-modal]"));
    const gets = app.calls.filter(c => c.options.method !== "POST");
    assert.equal(gets.length, 1);
    assert.ok(new URLSearchParams(gets[0].query).has("id"));
    await app.tick(30000);
    assert.ok(app.calls.some(c => new URLSearchParams(c.query).get("revalidate") === "1"));
  } finally { await app.unmount(); }
});
test("old, wrong-page and wrong-member discoveries fall back to current eligibility", async () => {
  for (const prefetch of [{ age: 20000 }, { pageId: "different-page" }, { viewer: "guest" }]) {
    const app = await mount({ member: true, prefetch });
    try {
      const gets = app.calls.filter(c => c.options.method !== "POST");
      assert.equal(gets.length, 2);
      assert.equal(new URLSearchParams(gets[0].query).has("id"), false);
      assert.ok(document.querySelector("[data-cms-popup-modal]"));
    } finally { await app.unmount(); }
  }
});
test("canonical Canvas homepage requests and opens a member popup after two seconds despite hidden Stripe telemetry", async () => {
  const app = await mount({ member: true, home: { type: "canvas", stripeTelemetry: true }, trigger: { type: "delay", value: 2 } });
  const realNow = Date.now;
  try {
    assert.ok(app.calls.some(c => !new URLSearchParams(c.query).has("id")), "homepage starts candidate discovery");
    assert.equal(document.querySelector("[data-cms-popup-modal]"), null, "delay is honoured");
    assert.equal(app.calls.some(c => new URLSearchParams(c.query).has("id")), false);
    Date.now = () => realNow() + 2100;
    await app.tick();
    assert.ok(app.calls.some(c => new URLSearchParams(c.query).has("id")), "selected popup is freshly authorized");
    assert.ok(document.querySelector("[data-cms-popup-modal]"), "homepage displays the popup");
  } finally { Date.now = realNow; await app.unmount(); }
});
test("static and legacy homepages also mount popup delivery for resolved guests", async () => {
  for (const type of ["ai_static", "legacy"]) {
    const app = await mount({ home: { type } });
    try { assert.ok(document.querySelector("[data-cms-popup-modal]")); }
    finally { await app.unmount(); }
  }
});
test("homepage previews, drafts, unresolved auth and unready member roles never start popup requests", async () => {
  for (const gate of [{ preview: true }, { status: "draft" }, { authResolved: false }, { accessReady: false }]) {
    const app = await mount({ member: true, home: { type: "canvas", ...gate } });
    try {
      assert.equal(app.calls.length, 0);
      assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
    } finally { await app.unmount(); }
  }
});
test("competing dialog defers without consuming; closing never opens another candidate", async () => {
  const app = await mount({ otherDialog: true });
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  assert.equal(app.calls.length, 1);
  assert.ok(JSON.parse(window.iconnectPopupDiagnostics()).some(e => e.event === "waiting" && e.reason === "other_dialog"));
  document.getElementById("competing").remove();
  await app.tick();
  assert.ok(document.querySelector("[data-cms-popup-modal]"));
  assert.ok(JSON.parse(window.iconnectPopupDiagnostics()).some(e => e.event === "popup_opened"));
  await act(async () => document.getElementById("close").click());
  await app.tick();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  assert.ok(JSON.parse(window.iconnectPopupDiagnostics()).some(e => e.event === "waiting" && e.reason === "visit_already_used"));
  assert.equal(app.calls.filter((call) => new URLSearchParams(call.query).has("id")).length, 1);
  await app.unmount();
});
test("MutationObserver immediately yields to a later external dialog, excluding own descendants", async () => {
  const app = await mount();
  const popup = document.querySelector("[data-cms-popup-modal]");
  await act(async () => {
    const nested = document.createElement("div");
    nested.setAttribute("role", "dialog");
    nested.setAttribute("aria-busy", "true");
    nested.setAttribute("data-popup-critical-flow", "");
    popup.append(nested);
  });
  await settle();
  await app.tick();
  assert.ok(document.querySelector("[data-cms-popup-modal]"), "own Canvas dialog/busy descendants must not self-dismiss");
  const external = document.createElement("section");
  external.setAttribute("role", "dialog");
  await act(async () => document.body.append(external));
  await settle();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null, "no trigger tick or authorization refresh is needed");
  external.remove();
  await app.tick();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null, "the view remains consumed after yielding");
  await app.unmount();
});
test("MutationObserver yields when a critical-flow attribute becomes active after opening", async () => {
  const app = await mount();
  const flow = document.createElement("section");
  await act(async () => document.body.append(flow));
  assert.ok(document.querySelector("[data-cms-popup-modal]"));
  await act(async () => flow.setAttribute("data-popup-critical-flow", ""));
  await settle();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  flow.remove();
  await app.unmount();
});
test("consent decision defers presentation and selected authorization fails closed", async () => {
  const app = await mount({ pendingConsent: true, selectedError: true });
  assert.equal(app.calls.length, 1);
  app.fixture.consent.isPending = false;
  await app.tick();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  assert.equal(app.calls.filter((call) => call.options.method === "POST").length, 0);
  await app.unmount();
});
test("late selected read cannot open after unmount", async () => {
  const app = await mount({ slowRead: true });
  await app.unmount();
  app.release();
  await settle();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  assert.equal(app.calls.filter((call) => call.options.method === "POST").length, 0);
});
test("new browser session ignores durable session-frequency timestamps and legacy session flags", async () => {
  const app = await mount({ frequency: "session", durableState: { last: new Date().toISOString(), session: true, permanent: false } });
  assert.ok(document.querySelector("[data-cms-popup-modal]"));
  const durable = JSON.parse(window.localStorage.getItem(app.storageKey));
  assert.equal(Object.hasOwn(durable, "session"), false, "session suppression must never be copied to disk");
  assert.equal(Object.hasOwn(durable, "last"), false, "session impressions are session-only");
  await act(async () => document.getElementById("close").click());
  await app.rerender({}, { key: `new-session-view-${sequence}`, pathname: `/another-session-view-${sequence}` });
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null, "same-tab session impression still suppresses on a genuinely new page view");
  await app.unmount();
});
test("durable permanent suppression wins over a newer session record with false", async () => {
  const app = await mount({ durableState: { permanent: true }, sessionState: { permanent: false, session: false, last: new Date().toISOString() } });
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  assert.equal(app.calls.length, 1, "no design is requested for a permanently dismissed popup");
  await app.unmount();
});
test("login and logout do not reset the one-popup-per-history-view allowance", async () => {
  const app = await mount({ frequency: "page_view" });
  assert.ok(document.querySelector("[data-cms-popup-modal]"));
  await act(async () => document.getElementById("close").click());
  app.fixture.context.viewer_key = "member:now-signed-in";
  await app.rerender({ viewerIdentity: "member:now-signed-in" });
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  app.fixture.context.viewer_key = "guest";
  await app.rerender({ viewerIdentity: "guest" });
  await app.tick();
  assert.equal(app.calls.filter((call) => new URLSearchParams(call.query).has("id")).length, 1);
  await app.unmount();
});
test("first eligibility response must match the expected member, guest or account identity", async () => {
  for (const options of [
    { actualViewer: "member:old-account", expectedViewer: "member:new-account" },
    { actualViewer: "account:tenant-user", expectedViewer: "guest" },
    { actualViewer: "guest", expectedViewer: "account:tenant-user" },
  ]) {
    const app = await mount(options);
    assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
    assert.equal(app.calls.length, 1, "mismatched identity must not request a design");
    await app.unmount();
  }
});
test("auth transition fences a pending old-account design read", async () => {
  const app = await mount({ member: true, slowRead: true });
  app.fixture.context.viewer_key = "member:new-account";
  await app.rerender({ viewerIdentity: "member:new-account" });
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  app.release();
  await settle();
  // The fresh generation may open its own authorized response, never the old
  // generation. Only that generation may send an impression.
  assert.equal(app.calls.filter((call) => call.options.method === "POST").length, 1);
  await app.unmount();
});
test("failed selected authorization is dropped until the next eligibility batch", async () => {
  const app = await mount({ selectedError: true });
  for (let i = 0; i < 6; i++) await app.tick();
  assert.equal(app.calls.filter((call) => new URLSearchParams(call.query).has("id")).length, 1);
  await app.tick(30000);
  assert.equal(app.calls.filter((call) => new URLSearchParams(call.query).has("id")).length, 2);
  await app.unmount();
});
test("hanging open revalidation closes at its 10-second deadline even if transport ignores abort", async () => {
  const app = await mount();
  assert.ok(document.querySelector("[data-cms-popup-modal]"));
  app.fixture.hangRevalidation = true;
  await app.startTick(30000);
  assert.ok([...app.deadlines.values()].every(({ ms }) => ms <= 15000));
  await app.expireRequests();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  assert.equal(app.calls.at(-1).options.signal.aborted, true);
  await app.unmount();
});
test("functional-only consent and a broad consent boolean never authorize durable storage", async () => {
  const app = await mount({ frequency: "page_view", hasConsented: true, categories: { functional: true, analytics: false },
    durableState: { permanent: true } });
  assert.ok(document.querySelector("[data-cms-popup-modal]"), "durable preferences are not read without analytics policy consent");
  assert.deepEqual(JSON.parse(window.localStorage.getItem(app.storageKey)), { permanent: true }, "impression must not overwrite disk");
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "Don't show again");
  await act(async () => button.click());
  assert.match(document.querySelector("[role=alert]").textContent, /storage consent/);
  assert.ok(document.querySelector("[data-cms-popup-modal]"), "must not claim permanent dismissal succeeded");
  await app.unmount();
});
test("selected-document revalidation also has a bounded deadline after a successful eligibility batch", async () => {
  const app = await mount();
  app.fixture.hangSelectedRevalidation = true;
  await app.startTick(30000);
  assert.ok(document.querySelector("[data-cms-popup-modal]"));
  const last = app.calls.at(-1);
  assert.equal(new URLSearchParams(last.query).get("revalidate"), "1");
  assert.equal(new URLSearchParams(last.query).has("id"), true);
  await app.expireRequests();
  assert.equal(document.querySelector("[data-cms-popup-modal]"), null);
  assert.equal(last.options.signal.aborted, true);
  await app.unmount();
});
test("denied browser storage falls back safely and does not pretend permanent dismissal succeeded", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage denied"); } });
  let app;
  try {
    app = await mount();
    assert.ok(document.querySelector("[data-cms-popup-modal]"));
    const permanent = [...document.querySelectorAll("button")].find((node) => node.textContent === "Don't show again");
    await act(async () => permanent.click());
    assert.match(document.querySelector("[role=alert]").textContent, /storage is unavailable/);
    assert.ok(document.querySelector("[data-cms-popup-modal]"));
  } finally {
    if (app) await app.unmount();
    Object.defineProperty(window, "localStorage", descriptor);
  }
});

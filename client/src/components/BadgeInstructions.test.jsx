import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://badge.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "MutationObserver", "FileReader", "File", "Event", "CustomEvent", "HTMLInputElement", "HTMLButtonElement"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { setActiveTenantId } = await import("../api/base44Client.js");
const { default: Settings } = await import("./BadgeInstructionsSettings.jsx");
const { default: HelpLink } = await import("./BadgeInstructionsHelpLink.jsx");
const { readBadgePdf, previewBadgePdf, badgeInstructionsRequest, badgeInstructionsKey } = await import("../hooks/useBadgeInstructions.js");

const pdf = () => new File(["%PDF-1.4\nfixture"], "sharing.pdf", { type: "application/pdf" });
const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
async function settle(fn = () => {}) {
  await act(async () => { await fn(); await wait(); });
  await act(async () => { await wait(); });
}

async function fixture() {
  const originalFetch = globalThis.fetch;
  const states = new Map();
  const requests = [];
  let failNext = null;
  let warning;
  let gate;
  const initial = (tenantId) => ({ tenantId, mode: "standard", revision: null, document: null, canManage: true });
  globalThis.fetch = async (url, options) => {
    const tenant = options.headers["X-Tenant-Id"];
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, ...options, body });
    if (gate) { const pending = gate; gate = null; await pending; }
    if (failNext) {
      const status = failNext; failNext = null;
      return { ok: false, status, json: async () => ({ error: "Fixture failure. Retry this action." }) };
    }
    let state = states.get(tenant) || initial(tenant);
    if (options.method !== "GET") {
      assert.equal(body.revision, state.revision);
      if (options.method === "POST") {
        assert.equal(body.action, "upload");
        assert.equal(body.mimeType, "application/pdf");
        assert.match(Buffer.from(body.contentBase64, "base64").toString(), /^%PDF/);
        state = { ...state, document: { filename: body.filename, size: 16 } };
      } else if (options.method === "PATCH") {
        assert.ok(body.mode !== "pdf" || state.document);
        state = { ...state, mode: body.mode };
      } else {
        assert.equal(body.confirm, true);
        state = { ...state, mode: "standard", document: null };
      }
      state.revision = `r${requests.length}`;
      states.set(tenant, state);
    }
    return { ok: true, json: async () => ({ ...state, ...(warning ? { warning } : {}) }) };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  setActiveTenantId("tenant-a");
  await settle(() => root.render(<QueryClientProvider client={client}><MemoryRouter><Settings /><HelpLink /></MemoryRouter></QueryClientProvider>));
  const button = (text) => Array.from(document.querySelectorAll("button")).find((el) => el.textContent === text);
  const click = async (text) => { const el = button(text); assert.ok(el, text); assert.equal(el.disabled, false, text); await settle(() => el.click()); };
  const choose = async (file) => settle(() => {
    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return {
    container, client, states, requests, click, button, choose,
    fail(status = 500) { failNext = status; },
    warning(value) { warning = value; },
    hold(promise) { gate = promise; },
    async cleanup() {
      await settle(() => root.unmount());
      container.remove(); client.clear(); setActiveTenantId(null); globalThis.fetch = originalFetch;
    },
  };
}

test("badge instruction UI: complete lifecycle, retained file, confirmed deletion and unchanged standard link", async () => {
  const f = await fixture();
  try {
    assert.equal(f.container.querySelector('a').getAttribute("href"), "/help/sharing-your-membership-badge");
    await settle(() => f.container.querySelector('input[value="pdf"]').click());
    assert.equal(f.button("Save instructions").disabled, true);
    await f.choose(pdf());
    await f.click("Upload PDF");
    assert.match(f.container.textContent, /sharing.pdf/);
    assert.equal(f.container.querySelector('input[value="pdf"]').checked, true, "upload keeps chosen mode");
    assert.equal(f.container.querySelector('a').target, "_blank");
    assert.equal(f.container.querySelector('a').getAttribute("href"), "/api/badge-instructions?document=true&tenantId=tenant-a");
    await f.click("Save instructions");
    assert.equal(f.states.get("tenant-a").mode, "pdf");
    assert.equal(f.container.querySelectorAll('a[target="_blank"]').length, 2);
    await f.click("Remove PDF from use");
    assert.equal(f.states.get("tenant-a").mode, "standard");
    assert.ok(f.states.get("tenant-a").document);
    const replacement = new File(["%PDF-1.4\nreplacement"], "replacement.pdf", { type: "application/pdf" });
    await f.choose(replacement);
    await f.click("Upload replacement");
    assert.equal(f.states.get("tenant-a").document.filename, "replacement.pdf");
    await f.click("Permanently delete PDF");
    assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 0);
    await f.click("Cancel");
    assert.ok(f.states.get("tenant-a").document);
    await f.click("Permanently delete PDF");
    await f.click("Confirm permanent deletion");
    assert.equal(f.states.get("tenant-a").document, null);
    assert.equal(f.states.get("tenant-a").mode, "standard");
    assert.match(f.container.textContent, /PDF permanently deleted/);
    assert.ok(f.requests.every((request) => request.credentials === "include"));
  } finally { await f.cleanup(); }
});

test("failed upload/save/delete keep working state; conflict reload, warnings and tenant cache isolation", async () => {
  const f = await fixture();
  try {
    await f.choose(pdf());
    f.fail();
    await f.click("Upload PDF");
    assert.match(f.container.textContent, /Fixture failure/);
    assert.match(f.container.textContent, /Selected: sharing.pdf/);
    await f.click("Upload PDF");
    await settle(() => f.container.querySelector('input[value="pdf"]').click());
    f.fail(409);
    await f.click("Save instructions");
    assert.equal(f.container.querySelector('input[value="pdf"]').checked, true);
    assert.match(f.container.textContent, /changed elsewhere/);
    assert.equal(f.states.get("tenant-a").mode, "standard");
    await f.click("Reload saved settings");
    await settle(() => f.container.querySelector('input[value="pdf"]').click());
    f.warning("Preview may take a moment.");
    await f.click("Save instructions");
    assert.match(f.container.textContent, /Preview may take a moment/);
    f.fail();
    await f.click("Permanently delete PDF");
    await f.click("Confirm permanent deletion");
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.ok(f.states.get("tenant-a").document);
    await f.click("Confirm permanent deletion");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await f.choose(pdf());
    let release;
    f.hold(new Promise((resolve) => { release = resolve; }));
    await settle(() => f.button("Upload PDF").click());
    assert.equal(f.button("Save instructions").disabled, true);
    assert.match(f.container.textContent, /Please wait/);
    await settle(() => setActiveTenantId("tenant-b"));
    assert.doesNotMatch(f.container.textContent, /Selected: sharing.pdf/);
    await settle(() => release());
    assert.equal(f.client.getQueryData(badgeInstructionsKey("tenant-b")).document, null);
    assert.ok(f.client.getQueryData(badgeInstructionsKey("tenant-a")).document);
    assert.match(f.container.textContent, /No PDF uploaded/);
  } finally { await f.cleanup(); }
});

test("file boundaries, malformed response, initial retry, and non-manager restrictions", async () => {
  await assert.rejects(readBadgePdf(new File(["text"], "notes.txt", { type: "text/plain" })), /Choose a PDF/);
  await assert.rejects(readBadgePdf(new File([], "empty.pdf", { type: "application/pdf" })), /non-empty/);
  await assert.rejects(readBadgePdf(new File([new Uint8Array(2097153)], "large.pdf", { type: "application/pdf" })), /2 MB/);
  assert.ok(await readBadgePdf(new File([new Uint8Array(2097152)], "boundary.pdf", { type: "application/pdf" })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tenantId: "other" }) });
  await assert.rejects(badgeInstructionsRequest("tenant-a"), /invalid/);
  globalThis.fetch = originalFetch;
  const f = await fixture();
  try {
    f.fail();
    await settle(() => setActiveTenantId("tenant-c"));
    assert.match(f.container.textContent, /Fixture failure/);
    await f.click("Retry loading instructions");
    assert.ok(f.button("Save instructions"));
    await settle(() => f.client.setQueryData(badgeInstructionsKey("tenant-c"), { tenantId: "tenant-c", mode: "standard", revision: null, document: null, canManage: false }));
    assert.match(f.container.textContent, /do not have permission/);
    assert.equal(f.button("Save instructions"), undefined);
  } finally { await f.cleanup(); }
});

test("PDF preview sends tenant header and renders safe standard fallback on failure", async () => {
  const originalOpen = window.open;
  const originalFetch = globalThis.fetch;
  const preview = new JSDOM("<!doctype html><body></body>", { url: "about:blank" }).window;
  window.open = () => preview;
  let prevented = false;
  let error;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/badge-instructions?document=true&tenantId=tenant-a");
    assert.equal(options.headers["X-Tenant-Id"], "tenant-a");
    return { ok: false, headers: new Headers({ "content-type": "text/html" }) };
  };
  try {
    await previewBadgePdf({ preventDefault() { prevented = true; } }, "tenant-a", (value) => { error = value; });
    assert.ok(prevented);
    assert.match(error, /unavailable/);
    assert.equal(preview.document.querySelector("a").href, "https://badge.test/help/sharing-your-membership-badge");
    window.open = () => null;
    await previewBadgePdf({ preventDefault() {} }, "tenant-a", (value) => { error = value; });
    assert.match(error, /Allow popups/);
  } finally { window.open = originalOpen; globalThis.fetch = originalFetch; }
});

test("successful preview opens a PDF blob, not HTML, and revokes the URL", async () => {
  const originalOpen = window.open;
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalTimer = window.setTimeout;
  let destination;
  let revoked;
  let cleanup;
  const tab = {
    opener: window, closed: false,
    document: { title: "", body: { textContent: "" } },
    location: { replace(url) { destination = url; } },
  };
  window.open = () => tab;
  window.setTimeout = (fn) => { cleanup = fn; return 1; };
  URL.createObjectURL = () => "blob:fixture-pdf";
  URL.revokeObjectURL = (url) => { revoked = url; };
  globalThis.fetch = async () => ({
    ok: true, headers: new Headers({ "content-type": "application/pdf" }),
    blob: async () => new Blob(["%PDF-1.4"], { type: "application/pdf" }),
  });
  try {
    await previewBadgePdf({ preventDefault() {} }, "tenant-a", () => assert.fail("preview should succeed"));
    assert.equal(tab.opener, null);
    assert.equal(destination, "blob:fixture-pdf");
    cleanup();
    assert.equal(revoked, destination);
  } finally {
    window.open = originalOpen; globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; window.setTimeout = originalTimer;
  }
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter, HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  CustomEvent: dom.window.CustomEvent, DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.Image = dom.window.Image;
// JSDOM has no canvas renderer. Keep the real mounted SignatureField and its
// change/invalidation behavior; only replace the canvas drawing primitives.
dom.window.HTMLCanvasElement.prototype.getContext = () => ({
  scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  clearRect() {}, drawImage() {}, setTransform() {}, fillText() {},
});
dom.window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,c2lnbmF0dXJl";
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const result = await build({
  entryPoints: ["client/src/components/sales/SendQuoteDialog.jsx"],
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  jsx: "automatic", alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{
    name: "quote-naming-fixture",
    setup(builder) {
      builder.onResolve({ filter: /hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'export const useQuoteNaming = () => globalThis.__sendQuoteNaming || ({ singular: "quote", plural: "quotes", slug: "quotes" });',
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/quote-send-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, `${process.cwd()}/quote-send-fixture.cjs`);
const Dialog = mod.exports.default;
after(() => dom.window.close());
const response = (body, subject = "Your training quote") => ({
  subject, recipient: body.recipient, html: `<p>${body.personalMessage.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p><a href="https://example.test/quote">View quote</a>`,
  text: body.personalMessage, attachPdf: body.attachPdf, version: body.version, expiresAt: "2026-06-30T12:00:00Z",
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const button = label => [...document.querySelectorAll("button")].find(item => item.textContent === label);
async function click(label) {
  assert.ok(button(label), `button: ${label}`);
  await act(async () => button(label).click());
}
async function input(id, value) {
  const el = document.getElementById(id);
  const proto = el.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function selectSender(value) {
  await act(async () => {
    const el = document.getElementById("quote-sender");
    el.value = value;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
async function signAgreement() {
  const canvas = document.querySelector('[data-testid="signature-canvas-sales-sender"]');
  await act(async () => canvas.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true })));
  await act(async () => canvas.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true })));
  await act(async () => document.querySelector('[aria-label="Sender agreement signature"] [role="checkbox"]').click());
}
const agreementQuote = {
  legalHtml: "<p>Agreement terms</p>",
  agreement: { contact: { name: "Priya Shah", role: "Training director", email: "client@example.test" } },
};
async function mount(extra = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let props = { open: true, quoteId: "quote-18", version: 3, initialRecipient: "client@example.test", onOpenChange() {}, onSend: async () => {}, request: async (_, options) => response(JSON.parse(options.body)), ...extra };
  const originalRequest = props.request;
  props.request = (url, options) => url.includes("sender-options")
    ? Promise.resolve(extra.senderOptions || { items: [
      { key: "member:self", name: "Current User", email: "self@example.test" },
      { key: "member:other", name: "Colleague", email: "other@example.test" },
    ], defaultSenderKey: "member:self" })
    : originalRequest(url, options);
  const render = async changes => {
    props = { ...props, ...changes };
    await act(async () => root.render(React.createElement(Dialog, props)));
  };
  await render();
  return { render, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("sender defaults to self; changing it invalidates preview and sends the selected key", async () => {
  const sends = [];
  const view = await mount({ onSend: async body => sends.push(body) });
  try {
    const select = document.getElementById("quote-sender");
    assert.equal(select.value, "member:self");
    await click("Preview email");
    assert.equal(button("Send quote").disabled, false);
    await act(async () => {
      select.value = "member:other";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(button("Send quote").disabled, true);
    await click("Preview email");
    await click("Send quote");
    assert.equal(sends[0].senderKey, "member:other");
  } finally { await view.cleanup(); }
});

test("agreement with signature and consent explains blank sender role; role enables preview, not send until preview, and edits invalidate", async () => {
  const requests = [], sends = [];
  const view = await mount({
    quote: agreementQuote,
    request: async (url, options) => { requests.push({ url, options }); return response(JSON.parse(options.body)); },
    onSend: async payload => sends.push(payload),
  });
  try {
    await signAgreement();
    assert.equal(button("Preview email").disabled, true);
    assert.equal(button("Send quote").disabled, true);
    assert.equal(requests.length, 0);
    const role = document.getElementById("agreement-sender-role");
    assert.equal(role.value, "");
    assert.equal(role.required, true);
    assert.equal(role.getAttribute("aria-required"), "true");
    assert.equal(role.getAttribute("aria-describedby"), "agreement-sender-role-help");
    assert.match(document.getElementById("agreement-sender-role-help").textContent, /Enter your role/);
    assert.match(document.getElementById("quote-preview-requirements").textContent, /Enter your role/);
    assert.equal(button("Preview email").getAttribute("aria-describedby"), "quote-preview-requirements");
    for (const id of ["quote-recipient-email", "agreement-contact-name", "agreement-contact-role", "agreement-sender-name"]) {
      assert.equal(document.getElementById(id).required, true, id);
      assert.match(document.querySelector(`label[for="${id}"]`).textContent, /required/);
    }
    await input("agreement-sender-role", "Managing director");
    assert.equal(document.getElementById("agreement-sender-role-help"), null);
    assert.equal(document.getElementById("quote-preview-requirements"), null);
    assert.equal(button("Preview email").disabled, false);
    assert.equal(button("Send quote").disabled, true);
    await click("Preview email");
    assert.equal(button("Send quote").disabled, false);
    assert.equal(sends.length, 0, "preview does not send");
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.senderRole, "Managing director");
    assert.equal(payload.senderConsent, true);
    assert.deepEqual(payload.senderSignature, { mode: "drawn", data: "data:image/png;base64,c2lnbmF0dXJl" });
    assert.equal(document.querySelector("iframe").getAttribute("sandbox"), "");
    for (const [id, value] of [
      ["agreement-sender-role", "Chief executive"],
      ["agreement-sender-name", "Morgan Ellis"],
      ["agreement-contact-role", "Operations director"],
      ["agreement-contact-name", "Ravi Shah"],
      ["quote-personal-message", "Please review this version."],
    ]) {
      await input(id, value);
      assert.equal(button("Send quote").disabled, true, id);
      assert.equal(document.querySelector("iframe"), null, id);
      await click("Preview email");
      assert.equal(button("Send quote").disabled, false, id);
    }
    const consent = document.querySelector('[aria-label="Sender agreement signature"] [role="checkbox"]');
    await act(async () => consent.click());
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(button("Preview email").disabled, true);
    assert.equal(button("Send quote").disabled, true);
    assert.match(document.getElementById("quote-preview-requirements").textContent, /signing consent/);
    await act(async () => consent.click());
    await click("Preview email");
    assert.equal(button("Send quote").disabled, false);
    await act(async () => document.querySelector('[data-testid="button-clear-signature-sales-sender"]').click());
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(button("Preview email").disabled, true);
    assert.equal(button("Send quote").disabled, true);
    assert.match(document.getElementById("quote-preview-requirements").textContent, /Add your signature/);
    await selectSender("member:other");
    await selectSender("member:self");
    assert.equal(document.querySelector('[aria-label="Sender agreement signature"] [role="checkbox"]').getAttribute("aria-checked"), "false");
    assert.match(document.getElementById("quote-preview-requirements").textContent, /Add your signature/);
    assert.match(document.getElementById("quote-preview-requirements").textContent, /signing consent/);
    assert.equal(button("Preview email").disabled, true);
  } finally { await view.cleanup(); }
});

test("agreement preview lists all missing requirements, not only sender role", async () => {
  const view = await mount({ quote: { legalHtml: "<p>Terms</p>" }, initialRecipient: "" });
  try {
    await input("agreement-sender-name", "");
    const requirements = document.getElementById("quote-preview-requirements").textContent;
    for (const pattern of [/valid recipient email/, /customer signatory’s name/, /customer signatory’s role/, /your full name/, /your role/, /Add your signature/, /signing consent/]) assert.match(requirements, pattern);
    assert.equal(button("Preview email").disabled, true);
    await input("agreement-sender-role", "Director");
    assert.equal(button("Preview email").disabled, true, "other requirements still block");
  } finally { await view.cleanup(); }
});

test("disabled actions expose missing-role and fresh-preview help on hover and keyboard focus without invoking actions", async () => {
  const requests = [], sends = [];
  const view = await mount({
    quote: agreementQuote,
    request: async (url, options) => { requests.push(url); return response(JSON.parse(options.body)); },
    onSend: async payload => sends.push(payload),
  });
  const helpFor = label => document.querySelector(`[role="group"][aria-label^="${label} unavailable."]`);
  const hover = async el => {
    await act(async () => {
      const event = new dom.window.MouseEvent("pointermove", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      el.dispatchEvent(event);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  };
  try {
    await signAgreement();
    assert.equal(document.querySelector('label[for="quote-recipient-contact"]').textContent.includes("required"), false);
    assert.match(document.querySelector('label[for="quote-personal-message"]').textContent, /optional/);
    assert.match(document.querySelector('label[for="quote-link-expiry"]').textContent, /required/);
    assert.equal(document.getElementById("quote-link-expiry").getAttribute("aria-required"), "true");
    const previewHelp = helpFor("Preview email");
    assert.equal(previewHelp.tabIndex, 0);
    assert.match(previewHelp.getAttribute("aria-label"), /Enter your role/);
    await hover(previewHelp);
    assert.match(document.querySelector('[role="tooltip"]').textContent, /Enter your role/);
    await act(async () => previewHelp.focus());
    assert.match(document.querySelector('[role="tooltip"]').textContent, /Enter your role/);
    await click("Preview email");
    await click("Send quote");
    await act(async () => {
      previewHelp.click();
      previewHelp.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(requests.length, 0);
    assert.equal(sends.length, 0);
    await input("agreement-sender-role", "Managing director");
    assert.equal(helpFor("Preview email"), null, "enabled preview has no extra tab stop");
    const sendHelp = helpFor("Send quote");
    assert.equal(sendHelp.tabIndex, 0);
    await act(async () => sendHelp.focus());
    assert.match(document.querySelector('[role="tooltip"]').textContent, /Preview the email before sending/);
    await click("Send quote");
    await act(async () => sendHelp.click());
    assert.equal(requests.length, 0);
    assert.equal(sends.length, 0);
    await act(async () => sendHelp.blur());
    await click("Preview email");
    assert.equal(requests.length, 1);
    assert.equal(helpFor("Send quote"), null, "enabled send has no extra tab stop");
    await input("quote-personal-message", "Updated message");
    await act(async () => helpFor("Send quote").focus());
    assert.match(document.querySelector('[role="tooltip"]').textContent, /Any changes require a new preview/);
    assert.equal(sends.length, 0);
  } finally { await view.cleanup(); }
});

test("colleague requests explain delivery blockers without requiring the current user's signature", async () => {
  const requests = [], sends = [];
  const view = await mount({
    quote: agreementQuote, initialRecipient: "",
    onRequestSignature: async payload => requests.push(payload),
    onSend: async payload => sends.push(payload),
  });
  try {
    await selectSender("member:other");
    assert.equal(button("Preview email"), undefined);
    assert.equal(document.getElementById("agreement-sender-role"), null);
    assert.equal(button("Request colleague signature").disabled, true);
    assert.match(document.getElementById("quote-colleague-requirements").textContent, /valid recipient email/);
    assert.equal(button("Request colleague signature").getAttribute("aria-describedby"), "quote-colleague-requirements");
    assert.match(button("Request colleague signature").parentElement.getAttribute("aria-label"), /valid recipient email/);
    await input("quote-recipient-email", "client@example.test");
    assert.equal(button("Request colleague signature").disabled, false);
    await click("Request colleague signature");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].senderKey, "member:other");
    assert.equal("senderSignature" in requests[0], false);
    assert.equal("senderRole" in requests[0], false);
    assert.equal(sends.length, 0);
    await view.render({ onRequestSignature: undefined });
    assert.equal(button("Request colleague signature").disabled, true);
    assert.match(document.getElementById("quote-colleague-requirements").textContent, /unavailable here/);
  } finally { await view.cleanup(); }
});

test("frozen agreement resends keep readonly details and require a fresh preview without a new signature", async () => {
  const sends = [];
  const view = await mount({
    quote: { ...agreementQuote, agreement: { ...agreementQuote.agreement, sender: { name: "Colleague", role: "Director", email: "other@example.test", signedAt: "2026-06-01T12:00:00Z" } } },
    onSend: async payload => sends.push(payload),
  });
  try {
    assert.equal(document.getElementById("quote-sender").value, "member:other");
    for (const id of ["quote-sender", "quote-recipient-email", "agreement-contact-name", "agreement-contact-role"]) assert.equal(document.getElementById(id).disabled, true);
    assert.equal(document.getElementById("agreement-sender-role"), null);
    assert.equal(button("Request colleague signature"), undefined);
    assert.equal(button("Preview email").disabled, false);
    assert.equal(button("Send quote").disabled, true);
    await click("Preview email");
    assert.equal(button("Send quote").disabled, false);
    await input("quote-personal-message", "Signed version reminder");
    assert.equal(button("Send quote").disabled, true);
    assert.equal(document.querySelector("iframe"), null);
    await click("Preview email");
    await click("Send quote");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].senderKey, "member:other");
    assert.equal("senderSignature" in sends[0], false);
    assert.equal("senderRole" in sends[0], false);
  } finally { await view.cleanup(); }
});

test("outsiders must explicitly choose a sender; empty lists prevent preview", async () => {
  const view = await mount({ senderOptions: { items: [], defaultSenderKey: null } });
  try {
    assert.equal(button("Preview email").disabled, true);
    assert.match(document.body.textContent, /No eligible owner/);
  } finally { await view.cleanup(); }
});

test("configured internal naming preserves the public email subject/body and API identity", async () => {
  globalThis.__sendQuoteNaming = { singular: "Training Proposal", plural: "Training Proposals", slug: "training-proposals" };
  const view = await mount();
  try {
    assert.ok(button("Send Training Proposal"));
    assert.match(document.body.textContent, /this exact Training Proposal version/);
    await click("Preview email");
    assert.match(document.body.textContent, /Your training quote/);
    assert.match(document.querySelector("iframe").srcdoc, /View quote/);
    assert.equal(document.querySelector("iframe").title, "Training Proposal email preview");
  } finally {
    await view.cleanup();
    delete globalThis.__sendQuoteNaming;
  }
});

test("preview uses the authenticated preview endpoint only; safe iframe and complete send payload", async () => {
  const requests = [], sends = [];
  const view = await mount({
    request: async (url, options) => { requests.push({ url, options }); return response(JSON.parse(options.body)); },
    onSend: async payload => sends.push(payload),
  });
  try {
    assert.equal(button("Send quote").disabled, true);
    await input("quote-personal-message", "Hello <script>alert(1)</script>\nThank you & see you soon.");
    assert.equal(document.getElementById("quote-personal-message").maxLength, 5000);
    await click("Preview email");
    assert.equal(sends.length, 0, "preview never sends");
    assert.equal(requests[0].url, "/api/sales/quotes/quote-18?action=preview-email");
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.credentials, "include");
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body, { recipient: "client@example.test", expiresInDays: 30, attachPdf: true, personalMessage: "Hello <script>alert(1)</script>\nThank you & see you soon.", version: 3, senderKey: "member:self" });
    const iframe = document.querySelector("iframe");
    assert.equal(iframe.getAttribute("sandbox"), "");
    assert.equal(iframe.tabIndex, 0);
    assert.notEqual(iframe.style.pointerEvents, "none");
    assert.equal(iframe.closest("[inert]"), null);
    assert.equal(iframe.getAttribute("referrerpolicy"), "no-referrer");
    assert.match(iframe.srcdoc, /&lt;script&gt;/);
    assert.doesNotMatch(iframe.srcdoc, /<script>/);
    assert.doesNotMatch(iframe.srcdoc, /\bhref=/);
    assert.equal(document.querySelector("script"), null, "HTML is never inserted into the parent document");
    assert.match(document.body.textContent, /Preview links are disabled/);
    assert.match(document.body.textContent, /PDF attachmentYes/);
    assert.equal(button("Send quote").disabled, false);
    await click("Send quote");
    assert.deepEqual(sends, [body]);
    assert.equal(button("Send quote").disabled, true, "successful delivery consumes preview");
  } finally { await view.cleanup(); }
});

test("long preview remains readable, formatted and scrollable without navigation or executable content", async () => {
  const longMessage = Array.from({ length: 65 }, (_, index) => `Message line ${index + 1}`).join("\n");
  const rawHtml = `<html><head><style>p { white-space: pre-wrap; }</style><base href="https://example.test"><meta http-equiv="refresh" content="0;url=https://example.test"></head><body><h1>Quote details</h1><p>${longMessage}</p><p>&lt;script&gt;plain text, not executable&lt;/script&gt;</p><a href="https://example.test/quote" target="_top">View quote</a><form action="https://example.test" target="_top"><button formaction="https://example.test">Submit</button><input name="secret"></form><script>alert(1)</script><iframe src="https://example.test"></iframe><object data="https://example.test"></object><embed src="https://example.test"><img src="https://example.test/logo.png" onerror="alert(1)"><footer>Final footer after all message lines</footer></body></html>`;
  const view = await mount({ request: async (_, options) => ({ ...response(JSON.parse(options.body)), html: rawHtml }) });
  try {
    await input("quote-personal-message", longMessage);
    await click("Preview email");
    const iframe = document.querySelector("iframe");
    const parsed = new JSDOM(iframe.srcdoc);
    try {
      assert.equal(iframe.getAttribute("sandbox"), "");
      assert.equal(iframe.getAttribute("referrerpolicy"), "no-referrer");
      assert.equal(iframe.tabIndex, 0, "keyboard can focus and scroll the preview");
      assert.notEqual(iframe.style.pointerEvents, "none", "wheel/touch scrolling is available");
      assert.equal(iframe.closest("[inert]"), null);
      assert.match(parsed.window.document.body.textContent, /Message line 65/);
      assert.match(parsed.window.document.body.textContent, /Final footer after all message lines/);
      assert.match(parsed.window.document.body.textContent, /<script>plain text, not executable<\/script>/);
      assert.equal(parsed.window.document.querySelector("h1").textContent, "Quote details");
      assert.match(parsed.window.document.querySelector("style").textContent, /white-space: pre-wrap/);
      assert.equal(parsed.window.document.querySelector("a").hasAttribute("href"), false);
      assert.equal(parsed.window.document.querySelector("[href],[action],[formaction],[target],[onerror]"), null);
      assert.equal(parsed.window.document.querySelector("script,form,input,button,base,meta,iframe,object,embed"), null);
      assert.ok(rawHtml.includes('href="https://example.test/quote"'), "only preview copy is sanitized");
      assert.equal(document.getElementById("quote-personal-message").value, longMessage);
    } finally { parsed.window.close(); }
  } finally { await view.cleanup(); }
});

test("late initial recipient fills an untouched draft without replacing an edited recipient", async () => {
  const view = await mount({ initialRecipient: "" });
  try {
    await view.render({ initialRecipient: "loaded@example.test" });
    assert.equal(document.getElementById("quote-recipient-email").value, "loaded@example.test");
    await input("quote-recipient-email", "chosen@example.test");
    await view.render({ initialRecipient: "different@example.test" });
    assert.equal(document.getElementById("quote-recipient-email").value, "chosen@example.test");
  } finally { await view.cleanup(); }
});

test("edits, attachment, expiry and version changes immediately invalidate preview", async () => {
  const view = await mount();
  try {
    for (const [id, value] of [["quote-personal-message", "Updated note"], ["quote-recipient-email", "other@example.test"]]) {
      await click("Preview email");
      assert.ok(document.querySelector("iframe"));
      await input(id, value);
      assert.equal(document.querySelector("iframe"), null);
      assert.equal(button("Send quote").disabled, true);
    }
    await click("Preview email");
    await act(async () => document.querySelector('[role="checkbox"]').click());
    assert.equal(document.querySelector("iframe"), null);
    await click("Preview email");
    assert.match(document.body.textContent, /PDF attachmentNo/);
    await view.render({ version: 4 });
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(button("Send quote").disabled, true);
    await click("Preview email");
    await act(async () => {
      document.getElementById("quote-link-expiry").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === "7 days");
    assert.ok(option);
    await act(async () => option.click());
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(button("Send quote").disabled, true);
  } finally { await view.cleanup(); }
});

test("loading, failure and retry; old responses cannot replace a newer preview", async () => {
  const requests = [];
  const view = await mount({ request: (url, options) => {
    const wait = deferred();
    requests.push({ ...wait, body: JSON.parse(options.body) });
    return wait.promise;
  } });
  try {
    await click("Preview email");
    assert.match(document.querySelector('[role="status"]').textContent, /Preparing/);
    assert.equal(button("Preparing preview…").disabled, true);
    assert.match(button("Preparing preview…").parentElement.getAttribute("aria-label"), /being prepared/);
    assert.match(button("Send quote").parentElement.getAttribute("aria-label"), /finish preparing/);
    await input("quote-personal-message", "New message");
    assert.equal(document.querySelector('[role="status"]'), null);
    await click("Preview email");
    await act(async () => requests[1].resolve(response(requests[1].body, "New preview")));
    assert.match(document.body.textContent, /New preview/);
    await act(async () => requests[0].resolve(response(requests[0].body, "Stale preview")));
    assert.doesNotMatch(document.body.textContent, /Stale preview/);
    assert.match(document.body.textContent, /New preview/);
    await input("quote-personal-message", "Retry this");
    await click("Preview email");
    await act(async () => requests[2].reject(new Error("Email preview unavailable")));
    assert.match(document.querySelector('[role="alert"]').textContent, /Email preview unavailable/);
    assert.equal(button("Send quote").disabled, true);
    await click("Retry preview");
    await act(async () => requests[3].resolve(response(requests[3].body)));
    assert.ok(document.querySelector("iframe"));
    await click("Preview email");
    await view.render({ version: 5 });
    await act(async () => requests[4].resolve(response(requests[4].body, "Old version")));
    assert.equal(document.querySelector("iframe"), null);
  } finally { await view.cleanup(); }
});

test("send locks duplicates, retains draft on failure and resets the next session", async () => {
  let sends = 0;
  const wait = deferred();
  const view = await mount({ onSend: () => { sends++; return wait.promise; } });
  try {
    await input("quote-personal-message", "Keep this note");
    await click("Preview email");
    await act(async () => { button("Send quote").click(); button("Send quote")?.click(); });
    assert.equal(sends, 1);
    assert.equal(button("Sending…").disabled, true);
    assert.match(button("Sending…").parentElement.getAttribute("aria-label"), /current delivery action/);
    assert.equal(document.getElementById("quote-personal-message").disabled, true);
    await act(async () => wait.reject(new Error("Delivery failed")));
    assert.equal(document.getElementById("quote-personal-message").value, "Keep this note");
    assert.equal(document.getElementById("quote-recipient-email").value, "client@example.test");
    assert.match(document.querySelector('[role="alert"]').textContent, /Delivery failed/);
    assert.equal(button("Send quote").disabled, false);
    await view.render({ open: false });
    await view.render({ open: true, initialRecipient: "" });
    assert.equal(document.getElementById("quote-personal-message").value, "");
    assert.equal(document.getElementById("quote-recipient-email").value, "");
    assert.equal(document.querySelector("iframe"), null);
  } finally { await view.cleanup(); }
});

test("workspace passes current version and retains its send-success-only close behavior", async () => {
  const source = await readFile("client/src/components/sales/QuotesWorkspace.jsx", "utf8");
  assert.match(source, /import SendQuoteDialog from "\.\/SendQuoteDialog"/);
  assert.match(source, /quoteId=\{id\} version=\{quote\.versionNumber/);
  assert.match(source, /onSend=\{\(extra\) => deliveryAction\.mutateAsync\(\{ action: "send", extra \}\)\}/);
  assert.match(source, /if \(variables\.action === "send"\) setSendOpen\(false\)/);
});

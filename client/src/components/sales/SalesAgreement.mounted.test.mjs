import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
  HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  CustomEvent: dom.window.CustomEvent, DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
const png = "data:image/png;base64,c2lnbmF0dXJl";
dom.window.HTMLCanvasElement.prototype.getContext = () => ({
  scale() {}, setTransform() {}, clearRect() {}, drawImage() {}, fillText() {},
  beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
});
dom.window.HTMLCanvasElement.prototype.toDataURL = () => png;
globalThis.Image = class {
  naturalWidth = 600; naturalHeight = 180;
  set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
  get src() { return this._src; }
};
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
URL.createObjectURL = () => "blob:signature-fixture";
URL.revokeObjectURL = () => {};
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = Module.createRequire(import.meta.url)("@tanstack/react-query");
const { MemoryRouter, Routes, Route } = Module.createRequire(import.meta.url)("react-router-dom");

const result = await build({
  stdin: {
    contents: `export {default as Editor} from "./client/src/components/sales/AgreementLegalEditor.jsx";
      export {default as Signer} from "./client/src/components/sales/AgreementDecisionForm.jsx";
      export {default as Send} from "./client/src/components/sales/SendQuoteDialog.jsx";
      export {default as Public} from "./client/src/pages/PublicSalesQuote.jsx";
      export {default as Finalization} from "./client/src/components/sales/AgreementFinalizationPanel.jsx";
      export {default as Requests} from "./client/src/components/sales/AgreementSignatureRequests.jsx";
      export {default as Signature} from "./client/src/components/forms/SignatureField.jsx";
      export {signaturePayload,legalHtmlOf} from "./client/src/components/sales/agreementSignature.js";`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{ name: "naming", setup(builder) {
    builder.onResolve({ filter: /hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export const useQuoteNaming = () => ({singular:"quote",plural:"quotes"});' }));
  } }],
});
const mod = new Module(`${process.cwd()}/sales-agreement-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, `${process.cwd()}/sales-agreement-fixture.cjs`);
const { Editor, Signer, Send, Signature, Public, Finalization, Requests, signaturePayload, legalHtmlOf } = mod.exports;
after(() => { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; dom.window.close(); });

async function mount(Component, props = {}) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const render = async next => {
    props = { ...props, ...next };
    let element = React.createElement(Component, props);
    if (Component === Public) element = React.createElement(MemoryRouter, { initialEntries: ["/agreement/fixture-token"] }, React.createElement(Routes, null, React.createElement(Route, { path: "/agreement/:token", element })));
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, element)));
  };
  await render();
  return { node, render, cleanup: async () => { await act(async () => root.unmount()); client.clear(); node.remove(); } };
}
const button = label => [...document.querySelectorAll("button")].find(el => el.textContent.trim() === label);
async function click(label) { assert.ok(button(label), label); await act(async () => button(label).click()); }
async function input(id, value) {
  const el = document.getElementById(id);
  assert.ok(el, id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function wait(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }

test("mounted legal editor inserts approved clauses and a real editable cancellation table, without source customer data", async () => {
  let html = "<h2>Agreement terms</h2><p></p>";
  const view = await mount(Editor, { value: html, onChange: value => { html = value; }, fields: [{ label: "Customer reference", value: "<PO-24>" }] });
  try {
    await click("Insert standard partnership terms");
    assert.equal(document.querySelectorAll(".tiptap table").length, 0);
    await click("Insert approved clauses");
    for (const percent of ["25%", "50%", "75%", "100%"]) assert.ok(html.includes(percent), percent);
    for (const detail of ["Access", "Elliot", "Jeremy Swan", "3,000", "11-13 January", "6 October"]) assert.ok(!html.includes(detail), detail);
    assert.equal(document.querySelectorAll(".tiptap table").length, 1);
    assert.equal(document.querySelectorAll(".tiptap table tr").length, 5);
    assert.ok(html.includes("Data Protection Act 2018"));
    assert.ok(html.includes("Bank of England base rate"));
    await click("Customer reference");
    assert.ok(html.includes("&lt;PO-24&gt;"));
    await view.render({ value: html });
    await click("Preview terms");
    assert.ok(document.body.textContent.includes("More than 90 days"));
    await view.render({ value: html, disabled: true });
    await click("Edit terms");
    assert.equal(document.querySelector(".tiptap").getAttribute("contenteditable"), "false");
  } finally { await view.cleanup(); }
});

test("signature upload is opt-in and normalized PNG; typed mode clears stale signature before its debounce", async () => {
  let value = null;
  const view = await mount(Signature, { fieldId: "fixture", onChange: next => { value = next; } });
  try {
    assert.equal(button("Upload"), undefined);
    await view.render({ allowUpload: true });
    await click("Upload");
    const file = new dom.window.File(["image"], "signature.png", { type: "image/png" });
    const el = document.getElementById("signature-upload-fixture");
    Object.defineProperty(el, "files", { value: [file], configurable: true });
    await act(async () => el.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.deepEqual(signaturePayload(value), { mode: "uploaded", data: png });
    await click("Type");
    const typed = document.querySelector('[data-testid="input-signature-typed-name-fixture"]');
    typed.id = "typed-fixture";
    await input("typed-fixture", "Mara Finch");
    assert.equal(value, null);
    await wait(340);
    assert.deepEqual(signaturePayload(value), { mode: "typed", data: png, typedName: "Mara Finch" });
    await input("typed-fixture", "Mara F");
    assert.equal(value, null);
    await view.render({ value: null, onChange: next => { value = next; } });
    await wait(340);
    assert.equal(value.typedName, "Mara F");
    await click("Upload");
    const upload = document.getElementById("signature-upload-fixture");
    Object.defineProperty(upload, "files", { value: [new dom.window.File(["bad"], "bad.svg", { type: "image/svg+xml" })], configurable: true });
    await act(async () => upload.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.equal(value, null);
    assert.ok(document.body.textContent.includes("smaller than 2 MB"));
  } finally { await view.cleanup(); }
});

test("public agreement acceptance is gated by signature, consent and recipient email code verification", async () => {
  const calls = [];
  const submits = [];
  const view = await mount(Signer, {
    agreement: { contact: { name: "Asha Moreau", role: "Director", email: "asha@example.test" } },
    path: "/public-fixture", request: async (path, options) => { calls.push([path, JSON.parse(options.body)]); return { verified: true, verificationProof: "private-proof-secret", expiresInSeconds: 600 }; },
    onSubmit: data => submits.push(data), onCancel() {},
  });
  try {
    assert.equal(button("Sign and accept agreement").disabled, true);
    await click("Type");
    const typed = document.querySelector('[data-testid="input-signature-typed-name-sales-customer"]');
    typed.id = "typed-customer";
    await input("typed-customer", "Asha Moreau");
    await wait(340);
    const consent = document.querySelector('[role="checkbox"]');
    await act(async () => consent.click());
    assert.equal(button("Sign and accept agreement").disabled, true);
    await click("Send verification code");
    await wait();
    await input("agreement-email-code", "814263");
    await click("Verify code");
    await wait();
    assert.equal(button("Sign and accept agreement").disabled, false);
    await click("Sign and accept agreement");
    assert.deepEqual(calls, [["/public-fixture/send-otp", {}], ["/public-fixture/verify-otp", { code: "814263" }]]);
    assert.equal(submits[0].consent, true);
    assert.equal(submits[0].verificationProof, "private-proof-secret");
    assert.equal(submits[0].agreement, true);
    assert.deepEqual(submits[0].signature, { mode: "typed", data: png, typedName: "Asha Moreau" });
    await click("Send a new code");
    assert.equal(button("Sign and accept agreement").disabled, true);
  } finally { await view.cleanup(); }
});

test("agreement send requires self signature and role and payload retains frozen contact details", async () => {
  const sends = [];
  const view = await mount(Send, {
    open: true, quoteId: "q-1", version: 2, quote: { legalHtml: "<h2>Approved terms</h2>", lines: [] },
    initialRecipient: "customer@example.test", contacts: [{ email: "customer@example.test", name: "Asha Moreau", role: "Director" }],
    onOpenChange() {}, onSend: async data => sends.push(data),
    request: async (path, options) => path.includes("sender-options") ? {
      defaultSenderKey: "member:self", items: [{ key: "member:self", name: "Mara Finch", email: "mara@example.test" }, { key: "member:other", name: "Colleague", email: "other@example.test" }],
    } : { ...JSON.parse(options.body), subject: "Agreement", html: "<p>Review agreement</p>" },
  });
  try {
    assert.equal(document.querySelector('option[value="member:other"]').disabled, false);
    assert.equal(button("Preview email").disabled, true);
    await input("agreement-sender-role", "Partnerships manager");
    await click("Type");
    const typed = document.querySelector('[data-testid="input-signature-typed-name-sales-sender"]');
    typed.id = "typed-sender";
    await input("typed-sender", "Mara Finch");
    await wait(340);
    const checks = document.querySelectorAll('[role="checkbox"]');
    await act(async () => checks[checks.length - 1].click());
    await click("Preview email");
    await click("Send quote");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].contactEmail, "customer@example.test");
    assert.equal(sends[0].senderConsent, true);
    assert.equal(sends[0].senderName, "Mara Finch");
    assert.deepEqual(sends[0].senderSignature, { mode: "typed", data: png, typedName: "Mara Finch" });
  } finally { await view.cleanup(); }
});

test("strict Sales signature mapping leaves DD fields outside the Sales payload", () => {
  assert.deepEqual(signaturePayload({ type: "signature", mode: "drawn", data: png, signed_at: "audit" }), { mode: "drawn", data: png });
  assert.equal(signaturePayload({ mode: "uploaded", data: "data:image/svg+xml;base64,eA==" }), null);
  assert.equal(signaturePayload({ mode: "typed", data: png, typedName: " " }), null);
  assert.equal(legalHtmlOf({ terms_snapshot: { legalHtml: "<h2>Terms</h2>" } }), "<h2>Terms</h2>");
});

test("selecting a colleague requests their signature without signing; colleague hydration enables only their own signature", async () => {
  const requests = [];
  const draft = { recipient: "asha@example.test", contactEmail: "asha@example.test", contactName: "Asha Moreau", contactRole: "Director", personalMessage: "Please review", expiresInDays: 14, attachPdf: false };
  const senders = [{ key: "member:self", name: "Mara Finch", email: "mara@example.test" }, { key: "member:colleague", name: "Tariq Bell", email: "tariq@example.test" }];
  const props = { open: true, quoteId: "q-1", version: 4, quote: { legalHtml: "<p>Approved legal terms</p>", lines: [] }, initialRecipient: draft.recipient, contacts: [{ name: draft.contactName, email: draft.contactEmail, role: draft.contactRole }], onOpenChange() {}, onSend() {}, onRequestSignature: async payload => requests.push(payload), request: async () => ({ defaultSenderKey: "member:self", items: senders }) };
  let view = await mount(Send, props);
  try {
    await act(async () => {
      const select = document.getElementById("quote-sender");
      select.value = "member:colleague";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(document.querySelector('[aria-label="Sender agreement signature"]'), null);
    assert.equal(button("Send quote"), undefined);
    await click("Request colleague signature");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].senderKey, "member:colleague");
    assert.equal(requests[0].senderSignature, undefined);
    assert.equal(requests[0].senderConsent, undefined);
  } finally { await view.cleanup(); }
  view = await mount(Send, { ...props, initialRecipient: "", signingRequest: { id: "sr-42", senderKey: "member:colleague", draft }, request: async () => ({ defaultSenderKey: "member:colleague", items: senders }) });
  try {
    assert.equal(document.getElementById("quote-sender").value, "member:colleague");
    assert.equal(document.getElementById("quote-sender").disabled, true);
    assert.equal(document.getElementById("quote-recipient-email").value, draft.recipient);
    assert.equal(document.getElementById("quote-personal-message").value, draft.personalMessage);
    assert.equal(document.getElementById("agreement-sender-name").value, "Tariq Bell");
    assert.equal(button("Request colleague signature"), undefined);
    assert.equal(button("Preview email").disabled, true);
  } finally { await view.cleanup(); }
});

test("authenticated signing request deep link opens only a current request for the selected colleague", async () => {
  const opened = [];
  const view = await mount(Requests, { quoteId: "q-1", requestedId: "sr-42", onSign: item => opened.push(item), request: async () => ({ items: [{ id: "sr-42", version: 4, senderName: "Tariq Bell", status: "pending", notificationStatus: "sent", canSign: true, draft: { recipient: "asha@example.test" } }] }) });
  try {
    await wait(20);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].id, "sr-42");
    await view.render({});
    assert.equal(opened.length, 1);
  } finally { await view.cleanup(); }
});

test("mounted public page shows exact saved commercial details, sender image, OTP proof acceptance and retryable final PDF", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let finalizations = 0;
  let agreement = { required: true, status: "awaiting_customer", sender: { name: "Mara Finch", role: "Partnerships manager", email: "mara@example.test", signedAt: "2026-06-02T10:00:00Z", signature: { mode: "typed", typedName: "Mara Finch", data: png } }, contact: { name: "Asha Moreau", role: "Director", email: "asha@example.test" }, finalizationStatus: "pending", downloadAvailable: false };
  const quote = { quoteNumber: "Q-284", version: 4, status: "issued", currency: "GBP", terms: { text: "Payment due within 37 days of invoice." }, legalHtml: "<h2>Approved agreement terms</h2>", address: { addressee: "Accounts team", line1: "28 Mill Lane", city: "York", postalCode: "YO1 4QD" }, lines: [{ description: "Conference partnership", quantity: 1, quotedUnitPriceMinor: 287500, netMinor: 287500, taxMinor: 57500, grossMinor: 345000, taxRateBps: 2000, bundleComponents: [{ name: "Delegate places", quantity: 2 }, { name: "Exhibition space", quantity: 1 }] }], netMinor: 287500, taxMinor: 57500, grossMinor: 345000 };
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    let payload; let status = 200;
    if (!options.method) payload = { quote, agreement, branding: { name: "Institute" } };
    else if (url.endsWith("/send-otp")) payload = { sent: true };
    else if (url.endsWith("/verify-otp")) payload = { verified: true, verificationProof: "proof-for-this-signing-session", expiresInSeconds: 600 };
    else if (url.endsWith("/accept")) { agreement = { ...agreement, status: "accepted", finalizationStatus: "failed", customer: { name: body.name, role: body.role, signature: body.signature } }; payload = { status: "accepted", agreement }; }
    else if (url.endsWith("/finalize")) {
      finalizations += 1;
      if (finalizations === 1) { status = 503; payload = { message: "PDF service temporarily unavailable" }; }
      else { agreement = { ...agreement, finalizationStatus: "complete", downloadAvailable: true }; payload = { agreement }; }
    } else throw new Error(`Unexpected fixture URL ${url}`);
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };
  const view = await mount(Public);
  try {
    await wait(25);
    const text = document.body.textContent;
    for (const expected of ["Version 4", "37 days", "28 Mill Lane", "Delegate places", "Exhibition space", "Approved agreement terms"]) assert.ok(text.includes(expected), expected);
    assert.equal(document.querySelector('img[alt="Sender signature of Mara Finch"]').getAttribute("src"), png);
    await click("Review and sign agreement");
    await click("Send verification code"); await wait(10);
    await input("agreement-email-code", "814263");
    await click("Verify code"); await wait(10);
    assert.ok(!document.body.textContent.includes("proof-for-this-signing-session"));
    await click("Type");
    const typed = document.querySelector('[data-testid="input-signature-typed-name-sales-customer"]');
    typed.id = "public-typed";
    await input("public-typed", "Asha Moreau"); await wait(340);
    await act(async () => document.querySelector('[role="checkbox"]').click());
    await click("Sign and accept agreement"); await wait(15);
    const accept = calls.find(call => call.url.endsWith("/accept"));
    assert.equal(accept.body.verificationProof, "proof-for-this-signing-session");
    assert.equal(accept.body.signature.mode, "typed");
    assert.ok(document.body.textContent.includes("Agreement accepted"));
    assert.equal(button("Sign and accept agreement"), undefined);
    await click("Retry / check signed PDF"); await wait(15);
    assert.ok(document.body.textContent.includes("PDF service temporarily unavailable"));
    await click("Retry / check signed PDF"); await wait(15);
    const download = [...document.querySelectorAll("a")].find(el => el.textContent === "Download signed agreement PDF");
    assert.equal(download.getAttribute("href"), "/api/public/sales-quote/fixture-token/agreement-download");
    assert.equal(calls.filter(call => call.url.endsWith("/accept")).length, 1);
  } finally { await view.cleanup(); globalThis.fetch = originalFetch; }
});

test("admin finalization keeps acceptance intact, retries failure, and supports completion email retry after PDF retention", async () => {
  let attempts = 0;
  let refreshed = 0;
  let downloads = 0;
  const view = await mount(Finalization, { agreement: { finalizationStatus: "failed", downloadAvailable: false }, onFinalize: async () => { attempts += 1; if (attempts === 1) throw new Error("Retry later"); return {}; }, onRefresh: () => { refreshed += 1; }, onDownload: () => { downloads += 1; } });
  try {
    await click("Retry / check signed PDF"); await wait();
    assert.ok(document.body.textContent.includes("Retry later"));
    await click("Retry / check signed PDF"); await wait();
    assert.equal(refreshed, 1);
    await view.render({ agreement: { finalizationStatus: "complete", downloadAvailable: true, completionNotifications: { sender: "sent", customer: "failed" } } });
    await click("Download signed agreement");
    assert.equal(downloads, 1);
    await click("Retry completion emails"); await wait();
    assert.equal(refreshed, 2);
  } finally { await view.cleanup(); }
});

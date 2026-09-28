import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test/report" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Element = dom.window.Element;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = (await import("react")).default;
const React = globalThis.React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CertificateDialog, CertificatePdfCanvasPreview } = await import("./AttendeeCpdCertificateDialog.jsx");

const attendee = { id: "booking-1", attendee_first_name: "Ari", attendee_last_name: "Lee" };
const details = { attendee_name: "Ari Lee", recipient: "ari@example.test", available: true, can_send: true, fingerprint: "snapshot-a", latest_delivery: null };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const click = async selector => act(async () => document.querySelector(selector).click());

async function mount(source = "standard", pdfEngine) {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  await act(async () => root.render(<CertificateDialog attendee={attendee} bookingSource={source} onClose={() => {}} pdfEngine={pdfEngine} />));
  return async () => {
    await act(async () => root.unmount());
    node.remove();
  };
}

test("metadata is fetched only when opened, with the selected booking source; unavailable means no PDF or email", async () => {
  const calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve(json({ ...details, available: false, reason: "no_template", can_send: false }));
  };
  const cleanup = await mount("complex");
  await tick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /booking_id=booking-1/);
  assert.match(calls[0].url, /booking_source=complex/);
  assert.match(document.body.textContent, /No certificate template is configured/);
  assert.equal(document.querySelector('[data-testid="button-preview-cpd-certificate"]'), null);
  assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]'), null);
  await cleanup();
});

test("personalized PDF renders every page to canvases without blob navigation or an iframe", async () => {
  const requests = [];
  const oldCreate = URL.createObjectURL;
  const oldContext = dom.window.HTMLCanvasElement.prototype.getContext;
  URL.createObjectURL = () => { throw new Error("Blob navigation is not allowed"); };
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ setTransform() {} });
  let destroyed = 0;
  const rendered = [];
  const engine = {
    getDocument({ data }) {
      assert.equal(new TextDecoder().decode(data), "%PDF-1.7");
      return {
        promise: Promise.resolve({
          numPages: 2,
          getPage: async number => ({
            getViewport: ({ scale }) => ({ width: 120 * scale, height: 80 * scale }),
            render: ({ canvasContext, transform }) => {
              assert.ok(canvasContext);
              assert.deepEqual(transform, [1, 0, 0, 1, 0, 0]);
              rendered.push(number);
              return { promise: Promise.resolve(), cancel() {} };
            },
          }),
        }),
        destroy: () => { destroyed++; },
      };
    },
  };
  globalThis.fetch = (url, options) => {
    requests.push({ url, options });
    return Promise.resolve(options?.method === "POST"
      ? new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf" } })
      : json(details));
  };
  try {
    const cleanup = await mount("standard", engine);
    await tick();
    await click('[data-testid="button-preview-cpd-certificate"]');
    await tick();
    assert.equal(JSON.parse(requests[1].options.body).action, "preview");
    assert.equal(JSON.parse(requests[1].options.body).expected_fingerprint, "snapshot-a");
    assert.equal(document.querySelector("iframe"), null);
    assert.deepEqual(rendered, [1, 2]);
    assert.equal(document.querySelectorAll('[data-testid="certificate-canvas-preview"] canvas').length, 2);
    assert.equal(document.querySelector('[data-testid="certificate-canvas-preview"] canvas').style.height, "auto");
    assert.match(document.body.textContent, /2 pages rendered/);
    await cleanup();
    assert.equal(destroyed, 1);
    assert.equal(document.querySelectorAll('[data-testid="certificate-canvas-preview"] canvas').length, 0);
  } finally {
    URL.createObjectURL = oldCreate;
    dom.window.HTMLCanvasElement.prototype.getContext = oldContext;
  }
});

test("canvas renderer shows loading then errors, and cancels pending rendering on unmount", async () => {
  const oldContext = dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ setTransform() {} });
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  let rejectRender;
  let cancelled = 0;
  let destroyed = 0;
  const engine = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: () => ({ width: 120, height: 80 }),
          render: () => ({
            promise: new Promise((_resolve, reject) => { rejectRender = reject; }),
            cancel: () => { cancelled++; rejectRender(new Error("Rendering cancelled")); },
          }),
        }),
      }),
      destroy: () => { destroyed++; },
    }),
  };
  try {
    await act(async () => root.render(<CertificatePdfCanvasPreview bytes={new Uint8Array([37, 80, 68, 70])} pdfEngine={engine} />));
    await tick();
    assert.match(document.body.textContent, /Rendering certificate pages/);
    await act(async () => root.unmount());
    node.remove();
    assert.equal(cancelled, 1);
    assert.equal(destroyed, 1);

    const errorNode = document.createElement("div");
    document.body.appendChild(errorNode);
    const errorRoot = createRoot(errorNode);
    const brokenEngine = { getDocument: () => ({ promise: Promise.reject(new Error("Corrupt PDF")), destroy() {} }) };
    await act(async () => errorRoot.render(<CertificatePdfCanvasPreview bytes={new Uint8Array([1])} pdfEngine={brokenEngine} />));
    await tick();
    assert.match(errorNode.textContent, /Preview could not be displayed: Corrupt PDF/);
    await act(async () => errorRoot.unmount());
    errorNode.remove();
  } finally {
    dom.window.HTMLCanvasElement.prototype.getContext = oldContext;
  }
});

test("email requires explicit recipient confirmation; retry retains ID, deliberate resend uses a new ID", async () => {
  const sends = [];
  let failOnce = true;
  globalThis.fetch = (_url, options) => {
    if (!options?.method) return Promise.resolve(json(details));
    const body = JSON.parse(options.body);
    sends.push(body);
    if (failOnce) { failOnce = false; return Promise.resolve(json({ error: "Email provider timed out" }, 502)); }
    return Promise.resolve(json({ success: true, latest_delivery: { status: "accepted" } }));
  };
  const cleanup = await mount();
  await tick();
  assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]').disabled, true);
  await click('[data-testid="confirm-cpd-email"]');
  await click('[data-testid="button-email-cpd-certificate"]');
  await tick();
  assert.match(document.body.textContent, /Email provider timed out/);
  assert.equal(sends[0].confirmed, true);
  assert.equal(sends[0].expected_fingerprint, "snapshot-a");
  assert.equal(sends[0].deliberate_resend, false);
  await click('[data-testid="button-email-cpd-certificate"]');
  await tick();
  assert.equal(sends[1].request_id, sends[0].request_id);
  assert.match(document.body.textContent, /does not confirm inbox delivery/);
  await click('[data-testid="button-prepare-cpd-resend"]');
  await click('[data-testid="confirm-cpd-email"]');
  await click('[data-testid="button-email-cpd-certificate"]');
  await tick();
  assert.notEqual(sends[2].request_id, sends[1].request_id);
  assert.equal(sends[2].deliberate_resend, true);
  await cleanup();
});

test("preview remains available without a valid recipient, but sending is disabled with reason", async () => {
  globalThis.fetch = () => Promise.resolve(json({ ...details, recipient: null, can_send: false, send_reason: "missing_recipient" }));
  const cleanup = await mount();
  await tick();
  assert.ok(document.querySelector('[data-testid="button-preview-cpd-certificate"]'));
  assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]'), null);
  assert.match(document.body.textContent, /no valid email address/i);
  await cleanup();
});

test("an unknown provider outcome disables sending instead of offering a blind retry", async () => {
  globalThis.fetch = (_url, options) => options?.method
    ? Promise.resolve(json({ error: "Provider outcome unknown", latest_delivery: { status: "unknown" } }, 502))
    : Promise.resolve(json(details));
  const cleanup = await mount();
  await tick();
  await click('[data-testid="confirm-cpd-email"]');
  await click('[data-testid="button-email-cpd-certificate"]');
  await tick();
  assert.match(document.body.textContent, /Provider outcome unknown/);
  assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]'), null);
  assert.match(document.body.textContent, /Reconcile it before sending again/);
  await cleanup();
});
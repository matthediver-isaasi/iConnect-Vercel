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
const details = { attendee_name: "Ari Lee", recipient: "ari@example.test", available: true, can_preview_email: true, can_send: true, fingerprint: "snapshot-a", latest_delivery: null };
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
  assert.match(document.querySelector('[data-testid="cpd-email-template-name"]').textContent, /Default certificate email/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /booking_id=booking-1/);
  assert.match(calls[0].url, /booking_source=complex/);
  assert.match(document.body.textContent, /No certificate template is configured/);
  assert.equal(document.querySelector('[data-testid="button-preview-cpd-certificate"]'), null);
  assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]'), null);
  await cleanup();
});

test("email preview shows selected subject, safe HTML and matching PDF attachment without sending", async () => {
  const requests = [];
  globalThis.fetch = (_url, options) => {
    if (!options?.method) return Promise.resolve(json({
      ...details, email_is_default: false, email_template_name: "Autumn Meeting 2026 CPD",
    }));
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.action !== "email-preview") throw new Error("Preview cannot send");
    return Promise.resolve(json({
      recipient: "ari@example.test", subject: "Your certificate", html: "<p>Survey list preview</p>",
      text: "Survey list preview", survey_links_inactive: true,
      omitted_surveys: [{ title: "Autumn Meeting Feedback", reason: "Survey is not published." }],
      attachment: { filename: "cpd-certificate.pdf", bytes: 432, content_type: "application/pdf" },
    }));
  };
  const cleanup = await mount();
  try {
    await tick();
    assert.ok(document.querySelector('[data-testid="cpd-certificate-section"]'));
    assert.ok(document.querySelector('[data-testid="cpd-email-section"]'));
    assert.ok(document.querySelector('[data-testid="button-preview-cpd-certificate"]'));
    assert.equal(document.querySelector('[data-testid="button-preview-cpd-email"]').disabled, false);
    await click('[data-testid="button-preview-cpd-email"]');
    await tick();
    assert.deepEqual(requests.map(request => request.action), ["email-preview"]);
    assert.match(document.querySelector('[data-testid="cpd-email-preview"]').textContent, /Your certificate/);
    assert.match(document.querySelector('[data-testid="cpd-email-preview"]').textContent, /To: ari@example.test/);
    assert.match(document.querySelector('[data-testid="cpd-email-preview"]').textContent, /Body:/);
    assert.match(document.querySelector('[data-testid="cpd-email-preview"]').textContent, /cpd-certificate.pdf/);
    assert.match(document.querySelector('[data-testid="cpd-email-preview"]').textContent, /Plain-text version/);
    assert.match(document.querySelector('[data-testid="cpd-omitted-surveys"]').textContent,
      /Autumn Meeting Feedback: Survey is not published/);
    assert.equal(document.querySelector('[data-testid="cpd-email-preview"] iframe').getAttribute("sandbox"), "");
    assert.equal(document.querySelector('[data-testid="cpd-email-preview"] iframe').getAttribute("srcdoc"), "<p>Survey list preview</p>");
    assert.match(document.body.textContent, /Autumn Meeting 2026 CPD/);
  } finally {
    await cleanup();
  }
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

test("guest metadata explains certificate evidence, previewed bytes can be downloaded, and email keeps attendee destination", async () => {
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  const oldContext = dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  let downloaded, blob, sent;
  URL.createObjectURL = value => { blob = value; return "blob:guest-certificate"; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloaded = { href: this.href, filename: this.download };
  };
  const engine = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1,
    getPage: async () => ({ getViewport: () => ({ width: 100, height: 80 }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }) }) }), destroy() {} }) };
  globalThis.fetch = (_url, options) => {
    if (!options?.method) return Promise.resolve(json({ ...details, certificate_points: "5",
      certificate_points_source: "guest_rule" }));
    const body = JSON.parse(options.body);
    if (body.action === "send") {
      sent = body;
      return Promise.resolve(json({ success: true, latest_delivery: { status: "accepted" } }));
    }
    return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      { headers: { "Content-Type": "application/pdf" } }));
  };
  let cleanup;
  try {
    cleanup = await mount("complex", engine);
    await tick();
    assert.match(document.querySelector('[data-testid="guest-certificate-points"]').textContent, /Guest certificate points: 5/);
    assert.match(document.body.textContent, /does not create a member CPD ledger award/);
    assert.equal(document.querySelector('[data-testid="button-download-cpd-certificate"]'), null);
    await click('[data-testid="button-preview-cpd-certificate"]');
    await tick();
    await click('[data-testid="button-download-cpd-certificate"]');
    assert.deepEqual(downloaded, { href: "blob:guest-certificate", filename: "cpd-certificate.pdf" });
    assert.equal(await blob.text(), "%PDF-1.7");
    await click('[data-testid="confirm-cpd-email"]');
    await click('[data-testid="button-email-cpd-certificate"]');
    await tick();
    assert.equal(sent.booking_source, "complex");
    assert.match(document.body.textContent, /accepted for ari@example.test/);
  } finally {
    if (cleanup) await cleanup();
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
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
  globalThis.fetch = () => Promise.resolve(json({ ...details, recipient: null, can_preview_email: false, can_send: false, send_reason: "missing_recipient" }));
  const cleanup = await mount();
  await tick();
  assert.ok(document.querySelector('[data-testid="button-preview-cpd-certificate"]'));
  assert.equal(document.querySelector('[data-testid="button-preview-cpd-email"]').disabled, true);
  assert.match(document.body.textContent, /Email preview unavailable:.*valid email address/i);
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
  assert.equal(document.querySelector('[data-testid="button-preview-cpd-email"]').disabled, false);
  assert.match(document.body.textContent, /Reconcile it before sending again/);
  await cleanup();
});

test("selected certificate email is named in consent and unavailable email blocks send but not PDF preview", async () => {
  globalThis.fetch = () => Promise.resolve(json({
    ...details, email_is_default: false, email_template_id: "old-email",
    email_template_name: "Retired course email", can_preview_email: false, can_send: false, email_reason: "email_template_inactive",
  }));
  const cleanup = await mount();
  await tick();
  assert.match(document.querySelector('[data-testid="cpd-email-template-name"]').textContent, /Retired course email/);
  assert.match(document.body.textContent, /selected certificate email template is inactive/);
  assert.ok(document.querySelector('[data-testid="button-preview-cpd-certificate"]'));
  assert.equal(document.querySelector('[data-testid="button-preview-cpd-email"]').disabled, true);
  assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]'), null);
  await cleanup();
});

test("pending delivery blocks another send but not a no-send email preview", async () => {
  const calls = [];
  globalThis.fetch = (_url, options) => {
    if (!options?.method) return Promise.resolve(json({
      ...details, can_send: false, send_reason: "A previous send is pending",
      latest_delivery: { status: "pending" },
    }));
    calls.push(JSON.parse(options.body));
    return Promise.resolve(json({
      recipient: details.recipient, subject: "Pending delivery preview", html: "<p>Current email body</p>",
      attachment: { filename: "cpd-certificate.pdf", bytes: 123 },
    }));
  };
  const cleanup = await mount();
  try {
    await tick();
    assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]'), null);
    assert.equal(document.querySelector('[data-testid="button-preview-cpd-email"]').disabled, false);
    await click('[data-testid="button-preview-cpd-email"]');
    await tick();
    assert.deepEqual(calls.map(call => call.action), ["email-preview"]);
    assert.equal(calls[0].confirmed, undefined);
    assert.equal(calls[0].request_id, undefined);
    assert.match(document.querySelector('[data-testid="cpd-email-preview"]').textContent, /Pending delivery preview/);
  } finally {
    await cleanup();
  }
});

test("changing template content or selection forces new explicit consent with the new fingerprint", async () => {
  const sends = [];
  let first = true;
  globalThis.fetch = (_url, options) => {
    if (!options?.method) return Promise.resolve(json({
      ...details, email_template_id: "selected", email_template_name: "Course email", email_is_default: false,
    }));
    const body = JSON.parse(options.body);
    sends.push(body);
    if (first) {
      first = false;
      return Promise.resolve(json({
        ...details, fingerprint: "snapshot-b", email_template_id: "replacement",
        email_template_name: "Updated course email", email_is_default: false,
        error: "Certificate data or recipient changed. Reload and preview before confirming.",
      }, 409));
    }
    return Promise.resolve(json({ success: true, latest_delivery: { status: "accepted" } }));
  };
  const cleanup = await mount();
  await tick();
  await click('[data-testid="confirm-cpd-email"]');
  await click('[data-testid="button-email-cpd-certificate"]');
  await tick();
  assert.match(document.body.textContent, /Updated course email/);
  assert.equal(document.querySelector('[data-testid="button-email-cpd-certificate"]').disabled, true);
  await click('[data-testid="confirm-cpd-email"]');
  await click('[data-testid="button-email-cpd-certificate"]');
  await tick();
  assert.equal(sends[0].expected_fingerprint, "snapshot-a");
  assert.equal(sends[1].expected_fingerprint, "snapshot-b");
  assert.notEqual(sends[0].request_id, sends[1].request_id);
  await cleanup();
});
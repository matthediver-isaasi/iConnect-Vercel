import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const Schedule = (await import("./MonthlyCollectionSchedule.jsx")).default;

async function renderSchedule(commitment, request = async () => {
  throw new Error("Unexpected request");
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Schedule commitment={commitment} request={request} />));
  return {
    container,
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.innerHTML = "";
    },
  };
}

const base = {
  id: "commitment-1",
  paymentFrequency: "monthly",
  collectionSchedule: {
    provider: "gocardless",
    regularDay: 12,
    nextConfirmedDate: "2026-10-12",
    evidence: "provider",
    canEdit: true,
    planId: "plan-1",
    version: 3,
  },
};

test("shows honest schedule evidence and only offers supported GoCardless editing", async () => {
  const rendered = await renderSchedule(base);
  try {
    assert.match(rendered.container.textContent, /Day 12 of each month/);
    assert.match(rendered.container.textContent, /12 Oct 2026/);
    assert.match(rendered.container.textContent, /Confirmed by the payment provider/);
    assert.ok(rendered.container.querySelector('[data-testid="button-edit-collection-day-commitment-1"]'));
  } finally {
    await rendered.cleanup();
  }

  const stripe = await renderSchedule({
    ...base,
    collectionSchedule: {
      provider: "stripe",
      regularDay: null,
      nextConfirmedDate: null,
      evidence: "unknown",
      canEdit: false,
      reason: "Stripe schedule changes are not supported here.",
    },
  });
  try {
    assert.match(stripe.container.textContent, /Not confirmed/);
    assert.match(stripe.container.textContent, /Schedule evidence unavailable/);
    assert.match(stripe.container.textContent, /Stripe schedule changes are not supported here/);
    assert.equal(stripe.container.querySelector('[data-testid^="button-edit-collection-day-"]'), null);
  } finally {
    await stripe.cleanup();
  }
});

test("previews before confirmation and preserves the pending collection explanation", async () => {
  const calls = [];
  const request = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return {
      ok: true,
      json: async () => body.action === "preview_collection_day"
        ? { preview: { effectiveDate: "2026-11-20", nextConfirmedDate: "2026-10-12", requestId: "11111111-1111-1111-1111-111111111111" } }
        : { ok: true },
    };
  };
  const rendered = await renderSchedule(base, request);
  try {
    await act(async () => rendered.container.querySelector('[data-testid="button-edit-collection-day-commitment-1"]').click());
    const input = document.body.querySelector('[data-testid="input-collection-day-commitment-1"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "20");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const previewButton = [...document.body.querySelectorAll("button")].find((button) => /Preview change/.test(button.textContent));
    await act(async () => previewButton.click());
    assert.equal(calls[0].action, "preview_collection_day");
    assert.equal(calls[0].collectionDay, 20);
    assert.match(document.body.textContent, /already pending collection on 12 Oct 2026 will not change/);
    const confirmButton = [...document.body.querySelectorAll("button")].find((button) => /Confirm change/.test(button.textContent));
    await act(async () => confirmButton.click());
    assert.equal(calls[1].action, "change_collection_day");
    assert.equal(calls[1].preview.requestId, "11111111-1111-1111-1111-111111111111");
    assert.match(calls[1].idempotencyKey, /^collection-day:plan-1:20:/);
  } finally {
    await rendered.cleanup();
  }
});
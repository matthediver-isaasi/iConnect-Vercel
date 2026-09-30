import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.example.test/admin",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: FormInvoiceSettlementControl } = await import("./FormInvoiceSettlementControl.jsx");

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <FormInvoiceSettlementControl
        recordId="history-1"
        table="member_membership_history"
      />,
    );
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      document.body.innerHTML = "";
    },
  };
}

test("permits retry settlement despite explanatory preview error after confirmations", async () => {
  const requests = [];
  const providerContext = { quickbooks_realm_id: "realm-123", environment: "production" };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (!body.execute) {
      return jsonResponse({
        ok: true,
        dryRun: true,
        planToken: "plan-token",
        result: {
          invoice_id: "invoice-1",
          invoice_number: "INV-1",
          stripe_payment_intent_id: "pi_full_reference_123456789",
          settlement_state: "retry",
          payment_recorded: false,
          annotation_recorded: false,
          error: "Previous attempt needs retry",
          account: "Stripe Clearing",
          balance: 120,
          provider_context: providerContext,
        },
      });
    }
    return jsonResponse({
      ok: true,
      dryRun: false,
      result: { payment_recorded: true, annotation_recorded: true, provider_context: providerContext },
    });
  };

  const view = await mount();
  await click(view.container.querySelector('[data-testid="button-inspect-stripe-settlement-history-1"]'));

  assert.match(document.body.textContent, /pi_full_reference_123456789/);
  assert.match(document.body.textContent, /Previous attempt needs retry/);
  const accountInput = document.querySelector('[data-testid="input-settlement-account-history-1"]');
  const accountSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    accountSetter.call(accountInput, "Stripe Clearing");
    accountInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(document.querySelector('[data-testid="checkbox-provider-context-history-1"]'));

  const executeButton = document.querySelector('[data-testid="button-execute-stripe-settlement-history-1"]');
  assert.equal(executeButton.disabled, false);
  await click(executeButton);
  assert.deepEqual(requests[1], {
    recordId: "history-1",
    table: "member_membership_history",
    execute: true,
    planToken: "plan-token",
    expectedProviderContext: providerContext,
    expectedAccount: "Stripe Clearing",
  });
  await view.cleanup();
});

test("offers annotation-only recovery when settlement is blocked and account is missing", async () => {
  const requests = [];
  const providerContext = { xero_tenant_id: "company-456" };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (!body.execute) {
      return jsonResponse({
        ok: true,
        dryRun: true,
        planToken: "settlement-plan",
        annotationPlanToken: "annotation-plan",
        result: {
          stripe_payment_intent_id: "pi_annotation_reference",
          settlement_state: "blocked",
          payment_recorded: false,
          annotation_recorded: false,
          error: "Clearing account is not configured",
          account: null,
          provider_context: providerContext,
        },
      });
    }
    return jsonResponse({
      ok: true,
      dryRun: false,
      result: { payment_recorded: false, annotation_recorded: true, provider_context: providerContext },
    });
  };

  const view = await mount();
  await click(view.container.querySelector('[data-testid="button-inspect-stripe-settlement-history-1"]'));
  assert.equal(document.querySelector('[data-testid="button-execute-stripe-settlement-history-1"]'), null);

  const annotationButton = document.querySelector('[data-testid="button-annotate-stripe-reference-history-1"]');
  assert.ok(annotationButton);
  await click(document.querySelector('[data-testid="checkbox-provider-context-history-1"]'));
  assert.equal(annotationButton.disabled, false);
  await click(annotationButton);
  assert.deepEqual(requests[1], {
    recordId: "history-1",
    table: "member_membership_history",
    execute: true,
    planToken: "annotation-plan",
    expectedProviderContext: providerContext,
    annotationOnly: true,
  });
  await view.cleanup();
});
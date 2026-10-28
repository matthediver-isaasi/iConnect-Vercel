import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// node scripts/run-isolated-tests.mjs node --test client/src/components/MemberChangeRequestSummary.mounted.test.mjs
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/MemberChangeRequestSummary.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "request-progress-isolated",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/lib\/memberChangeRequests$/ }, () => ({ path: `${process.cwd()}/client/src/lib/memberChangeRequests.js` }));
      builder.onResolve({ filter: /^@\/components\/ui\/badge$/ }, () => ({ path: "badge", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'import React from "react"; export const Badge = ({children}) => React.createElement("span", {"data-testid":"status-badge"}, children);',
        loader: "js",
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/request-progress-mounted.cjs`);
compiled.filename = `${process.cwd()}/request-progress-mounted.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { MemberChangeRequestRecord } = compiled.exports;
after(() => dom.window.close());

async function mount(record) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(MemberChangeRequestRecord, { record },
    React.createElement("p", null, "Existing review controls"))));
  return {
    badge: container.querySelector('[data-testid="status-badge"]').textContent,
    text: container.textContent,
    container,
    async cleanup() { await act(async () => root.unmount()); container.remove(); },
  };
}
const record = state => ({
  id: "request-progress", state: "approved", summary: { targetName: "Professional", currency: "GBP" },
  progress: { state, providerId: "PRIVATE-PROVIDER-ID", error: "PRIVATE-PROVIDER-ERROR",
    paymentUrl: "https://private.example.test/payment", evidence: { bankReference: "PRIVATE-BANK-REFERENCE" } },
});
const cases = [
  ["approved", "Approved for processing", /financial processing has not started/],
  ["processing", "Processing change", /processing is in progress/],
  ["applying", "Applying membership change", /Settlement is recorded, but membership application is not yet confirmed/],
  ["awaiting_payment", "Awaiting payment", /Payment settlement is still awaited/],
  ["awaiting_refund", "Awaiting refund", /Refund settlement is still awaited/],
  ["awaiting_reconciliation", "Awaiting reconciliation", /verify the existing processing outcome/],
  ["applied", "Membership change applied", /Membership application is confirmed/],
  ["unavailable", "Processing status unavailable", /latest processing status could not be verified/],
];
for (const [state, badge, helper] of cases) {
  test(`${state} has truthful copy without provider details or invented payment links`, async () => {
    const view = await mount(record(state));
    try {
      assert.equal(view.badge, badge);
      assert.match(view.text, helper);
      assert.match(view.text, /Existing review controls/);
      assert.doesNotMatch(view.text, /PRIVATE-|private\.example|Payment received|Refund complete|Refund sent|successfully refunded/i);
      assert.equal(view.container.querySelector("a"), null);
      assert.equal(view.container.querySelector("button"), null);
      if (state !== "applied") {
        assert.doesNotMatch(view.text, /Membership application is confirmed|Membership change applied/);
      } else {
        assert.doesNotMatch(view.text, /Approval authorises separate|not evidence of.*applied membership change/);
        assert.match(view.text, /does not by itself confirm a cash refund/);
      }
      if (state === "awaiting_payment") assert.match(view.text, /Payment and membership application are not yet confirmed/);
      if (state === "awaiting_refund") assert.match(view.text, /completed refund and membership application are not yet confirmed/);
    } finally { await view.cleanup(); }
  });
}

test("old approved records without progress retain the approval-only wording", async () => {
  const oldRecord = record("applied");
  delete oldRecord.progress;
  const view = await mount(oldRecord);
  try {
    assert.equal(view.badge, "Approved for processing");
    assert.match(view.text, /Approval authorises separate administrator financial processing/);
    assert.match(view.text, /not evidence of payment, refund or an applied membership change/);
  } finally { await view.cleanup(); }
});

test("unknown or malformed progress fails closed without exposing raw status", async () => {
  for (const state of ["PRIVATE-NEW-PROVIDER-STATE", "toString", undefined]) {
    const view = await mount(record(state));
    try {
      assert.equal(view.badge, "Processing status unavailable");
      assert.match(view.text, /Do not assume payment, refund or membership application is complete/);
      assert.doesNotMatch(view.text, /PRIVATE-|toString/);
    } finally { await view.cleanup(); }
  }
});

test("progress cannot override pending, rejected or withdrawn request states", async () => {
  for (const [state, badge] of [["pending", "Pending review"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"]]) {
    const view = await mount({ ...record("applied"), state });
    try {
      assert.equal(view.badge, badge);
      assert.doesNotMatch(view.text, /Membership application is confirmed|Membership change applied|PRIVATE-/);
    } finally { await view.cleanup(); }
  }
});

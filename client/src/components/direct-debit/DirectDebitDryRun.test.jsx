import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DryRunReport } from "./DirectDebitDryRun.jsx";

const result = {
  evaluatedAt: "2027-01-10T09:30:00.000Z",
  plan: { id: "plan-1", ownerLabel: "Ada Member" },
  jobs: [{
    id: "automatic-retry",
    label: "Automatic payment retry",
    evidence: [{
      method: "payments.get",
      status: "failed",
      evidenceAt: "2027-01-10T09:29:30.000Z",
    }],
    stages: [{
      stage: "Eligibility",
      status: "conditional",
      reason: "A failed payment is currently eligible.",
      evidenceAt: "2027-01-10T09:29:00.000Z",
      operations: [{
        type: "retry_payment",
        description: "Ask GoCardless to retry payment",
        amountMinor: 1250,
        currency: "GBP",
        date: "2027-01-12",
        conditional: true,
        continuation: "If GoCardless accepts the retry, update arrears state and send the payment recovery email.",
      }, {
        type: "legacy_conditional",
        description: "Evaluate a legacy continuation",
        conditional: "Create an accounting invoice and activate membership after confirmed payment.",
      }],
    }],
  }],
  limitations: ["Provider state can change before the scheduled job runs."],
};

test("dry-run report clearly describes non-execution, conditional operations and limitations", () => {
  const html = renderToStaticMarkup(<DryRunReport result={result} />);
  assert.match(html, /No changes were made/);
  assert.match(html, /did not collect money/);
  assert.match(html, /Automatic payment retry/);
  assert.match(html, /Fresh evidence/);
  assert.match(html, /payments\.get/);
  assert.match(html, /checked 10 Jan 2027, 09:29/);
  assert.match(html, /A failed payment is currently eligible/);
  assert.match(html, /£12\.50/);
  assert.match(html, /conditional/);
  assert.match(html, /Downstream intention: If GoCardless accepts the retry, update arrears state and send the payment recovery email/);
  assert.match(html, /Downstream intention: Create an accounting invoice and activate membership after confirmed payment/);
  assert.match(html, /Scheduled jobs run independently/);
  assert.match(html, /does not guarantee their order/);
  assert.match(html, /successful claims/);
  assert.match(html, /Provider state can change/);
});

test("dry-run report has labelled job and limitation regions and no execution control", () => {
  const html = renderToStaticMarkup(<DryRunReport result={result} />);
  assert.match(html, /aria-label="Scheduled job results"/);
  assert.match(html, /aria-labelledby="dry-run-limitations-title"/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, />Execute</);
});
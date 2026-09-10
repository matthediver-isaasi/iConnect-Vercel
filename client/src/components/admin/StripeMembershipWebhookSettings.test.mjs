import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./StripeMembershipWebhookSettings.jsx", import.meta.url),
  "utf8",
);

test("membership webhook settings expose URL, secret, save, check, and result controls", () => {
  assert.match(source, /data-testid="card-stripe-membership-webhook"/);
  assert.match(source, /data-testid="input-stripe-membership-webhook-url"/);
  assert.match(source, /input-stripe-membership-webhook-secret-\$\{mode\}/);
  assert.match(source, /button-save-stripe-membership-webhook-secrets/);
  assert.match(source, /button-check-stripe-membership-webhook-\$\{mode\}/);
  assert.match(source, /stripe-membership-webhook-result-\$\{mode\}/);
});

test("membership webhook settings use authenticated admin endpoints and only submit entered secrets", () => {
  assert.match(source, /adminFetch\("\/api\/admin\/integrations"/);
  assert.match(source, /adminFetch\("\/api\/admin\/stripe-membership-webhooks"/);
  assert.match(source, /if \(secrets\.live\.trim\(\)\) credentials\.membership_webhook_secret/);
  assert.match(source, /if \(secrets\.test\.trim\(\)\) credentials\.test_membership_webhook_secret/);
  assert.match(source, /setSecrets\(\{ live: "", test: "" \}\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("configuration checks explain their read-only limitations", () => {
  assert.match(source, /only read your saved Stripe settings/);
  assert.match(source, /do not create a webhook endpoint/);
  assert.match(source, /prove that Stripe has delivered an event/);
  assert.match(source, /href="\/guides\/stripe-membership-payments\.html"/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noreferrer"/);
});
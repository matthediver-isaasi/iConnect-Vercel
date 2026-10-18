import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["client/src/components/sales/QuotesWorkspace.jsx"], bundle: true, write: false,
  platform: "node", format: "cjs", packages: "external", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
});
const mod = new Module(`${process.cwd()}/quote-billing-hydration-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, `${process.cwd()}/quote-billing-hydration-fixture.cjs`);
const { normalizeQuote } = mod.exports;

test("legacy draft hydration never opts into scheduled billing or picks remainder payment terms", () => {
  const quote = normalizeQuote({ id: "legacy", currentVersion: { version_number: 2, lines: [] } });
  assert.equal(quote.scheduledBilling, false);
  assert.equal(quote.remainderPaymentTermsId, "");
  assert.equal(quote.billingSchedule, null);
});

test("immutable schedules and explicit remainder terms hydrate from both API naming conventions", () => {
  const schedule = { timezone: "Europe/London", timezoneFallback: false, recipient: { name: "Mara Singh", email: "mara@example.test" }, groups: [
    { id: "line-one-travel", linePosition: 0, position: 0, name: "Travel", grossMinor: 1731, contents: ["Train"], timing: { kind: "acceptance", days: 7 }, paymentTerms: { id: "terms", name: "Two weeks", days: 14 } },
    { id: "line-two-travel", linePosition: 1, position: 0, name: "Travel", grossMinor: 1731, contents: ["Train"], timing: { kind: "acceptance", days: 7 }, paymentTerms: { id: "terms", name: "Two weeks", days: 14 } },
  ] };
  for (const fields of [
    { scheduled_billing: true, remainder_payment_terms_id: "remainder-terms", billing_schedule: schedule },
    { scheduledBilling: true, remainderPaymentTermsId: "remainder-terms", billingSchedule: schedule },
  ]) {
    const quote = normalizeQuote({ id: "quote", currentVersion: { version_number: 3, ...fields } });
    assert.equal(quote.scheduledBilling, true);
    assert.equal(quote.remainderPaymentTermsId, "remainder-terms");
    assert.deepEqual(quote.billingSchedule, schedule);
    assert.notEqual(quote.billingSchedule.groups[0].id, quote.billingSchedule.groups[1].id);
  }
});

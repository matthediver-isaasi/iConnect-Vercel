import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";

const compiled = await build({
  stdin: { contents: 'export {salesSettingsRequest} from "./useSalesSettings.js"; export {scheduleCustomerMatch} from "./scheduleOperations.js";', resolveDir: `${process.cwd()}/client/src/components/sales`, loader: "js" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
});
const mod = new Module(`${process.cwd()}/schedule-operations-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/schedule-operations-fixture.cjs`);
const { salesSettingsRequest, scheduleCustomerMatch } = mod.exports;

test("Sales requests preserve structured candidate errors without treating details objects as arrays", async () => {
  const original = globalThis.fetch;
  const payload = { code: "AMBIGUOUS_CUSTOMER_MATCH", message: "Select the accounting customer", details: { candidates: [{ provider_customer_id: "customer-2", display_name: "Harbour Events", email: "billing@example.test" }] } };
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.credentials, "include");
    return { ok: false, status: 409, json: async () => payload };
  };
  try {
    await assert.rejects(salesSettingsRequest("/fixture-only"), error => {
      assert.equal(error.status, 409);
      assert.equal(error.payload, payload);
      assert.equal(error.message, payload.message);
      assert.deepEqual(scheduleCustomerMatch(error).candidates, [{ providerCustomerId: "customer-2", name: "Harbour Events", email: "billing@example.test" }]);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test("stored ambiguity accepts nested and top-level candidates but never guesses a customer for other errors", () => {
  for (const value of [
    { code: "AMBIGUOUS_CUSTOMER_MATCH", details: { candidates: [{ id: "c1", name: "Harbour" }] } },
    { code: "AMBIGUOUS_CUSTOMER_MATCH", candidates: [{ id: "c1", name: "Harbour" }] },
    { details: { candidates: [{ id: "c1", name: "Harbour" }] } },
  ]) {
    assert.equal(scheduleCustomerMatch(value).ambiguous, true);
    assert.equal(scheduleCustomerMatch(value).candidates[0].providerCustomerId, "c1");
  }
  assert.equal(scheduleCustomerMatch({ code: "PROVIDER_UNAVAILABLE", details: { candidates: [{ id: "c1" }] } }).ambiguous, false);
  assert.deepEqual(scheduleCustomerMatch({ code: "AMBIGUOUS_CUSTOMER_MATCH" }).candidates, []);
  assert.equal(scheduleCustomerMatch("An error occurred").ambiguous, false);
});

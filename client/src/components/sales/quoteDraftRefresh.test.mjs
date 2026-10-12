import test from "node:test";
import assert from "node:assert/strict";
import { refreshSavedQuoteDraft } from "./quoteDraftRefresh.js";

const address = { addressee: "Accounts", line1: "10 Main Street", line2: "Floor 2", city: "Leeds", region: "Yorkshire", postalCode: "LS1 1AA", country: "United Kingdom" };
function state() {
  const value = { form: { address, rowVersion: 1 }, saved: "" };
  return { value, setForm: fn => { value.form = fn(value.form); }, setSavedFingerprint: next => { value.saved = next; } };
}
test("saving waits for the fresh address instead of restoring a stale cached blank address", async () => {
  const harness = state();
  const submittedFingerprint = JSON.stringify(harness.value.form);
  let resolve;
  const pending = refreshSavedQuoteDraft({ ...harness, submittedFingerprint, normalize: data => data,
    refetch: () => new Promise(done => { resolve = done; }) });
  assert.deepEqual(harness.value.form.address, address);
  resolve({ data: { address, rowVersion: 2 }, error: null });
  await pending;
  assert.deepEqual(harness.value.form, { address, rowVersion: 2 });
  assert.equal(harness.value.saved, JSON.stringify(harness.value.form));
});
test("edits made during the refresh remain unsaved instead of being overwritten", async () => {
  const harness = state();
  const submittedFingerprint = JSON.stringify(harness.value.form);
  let resolve;
  const pending = refreshSavedQuoteDraft({ ...harness, submittedFingerprint, normalize: data => data,
    refetch: () => new Promise(done => { resolve = done; }) });
  harness.value.form = { ...harness.value.form, address: { ...address, line1: "Edited again" } };
  resolve({ data: { address, rowVersion: 2 } });
  await pending;
  assert.equal(harness.value.form.address.line1, "Edited again");
  assert.notEqual(harness.value.saved, JSON.stringify(harness.value.form));
});
test("refresh failure never clears the saved inputs", async () => {
  const harness = state();
  for (const result of [{ error: new Error("Network error") }, { data: null }]) {
    await assert.rejects(refreshSavedQuoteDraft({ ...harness, submittedFingerprint: JSON.stringify(harness.value.form),
      normalize: data => data, refetch: async () => result }));
    assert.deepEqual(harness.value.form.address, address);
  }
});

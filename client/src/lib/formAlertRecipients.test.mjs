import test from "node:test";
import assert from "node:assert/strict";
import { alertRecipientsError, normalizeAlertRecipients } from "./formAlertRecipients.js";

test("alert recipients are trimmed, lowercased and deduplicated across separators", () => {
  assert.deepEqual(normalizeAlertRecipients(" Admin@Example.org,\nadmin@example.org; Other@Example.org \n"), [
    "admin@example.org", "other@example.org",
  ]);
});

test("disabled settings allow no recipients; enabled settings require one", () => {
  assert.deepEqual(normalizeAlertRecipients(" \n,; "), []);
  assert.equal(alertRecipientsError(false, []), null);
  assert.match(alertRecipientsError(true, []), /at least one/);
  assert.equal(alertRecipientsError(true, ["admin@example.org"]), null);
});

test("both enabled and disabled settings reject invalid addresses", () => {
  for (const enabled of [true, false]) {
    for (const email of ["invalid", "a@b", "a b@example.org", "a@@example.org"]) {
      assert.match(alertRecipientsError(enabled, [email]), /valid email/);
    }
  }
});

test("twenty unique recipients are accepted but twenty-one are rejected", () => {
  const recipients = Array.from({ length: 21 }, (_, index) => `admin${index}@example.org`);
  assert.equal(alertRecipientsError(true, recipients.slice(0, 20)), null);
  assert.match(alertRecipientsError(true, recipients), /up to 20/);
  assert.match(alertRecipientsError(false, recipients), /up to 20/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { certificateAwardState, validCertificateOverrideReason } from "./attendeeCertificateAwardState.js";

test("unconfirmed legacy metadata fails closed instead of assuming an award", () => {
  assert.deepEqual(certificateAwardState({ can_send: true }), {
    guest: false, awarded: false, required: false, supported: false,
  });
});

test("prospective rule points require an explicit server capability", () => {
  const prospective = { certificate_points_source: "member_rule", certificate_points: "6.25", award_required: true };
  assert.equal(certificateAwardState(prospective).supported, false);
  assert.deepEqual(certificateAwardState({ ...prospective, manual_award_supported: true }), {
    guest: false, awarded: false, required: true, supported: true,
  });
});

test("guests never need a member award; existing awards never require another award", () => {
  assert.deepEqual(certificateAwardState({ certificate_points_source: "guest_rule" }), {
    guest: true, awarded: false, required: false, supported: true,
  });
  assert.deepEqual(certificateAwardState({ certificate_points_source: "member_ledger", award_required: true }), {
    guest: false, awarded: true, required: false, supported: true,
  });
});

test("reason cannot be blank, a default, punctuation, or repeated short tokens", () => {
  for (const reason of [null, "", "  ", "default", "test test test", "........ ........ .......", "a a a a a a a a a a", "x".repeat(2001)]) {
    assert.equal(validCertificateOverrideReason(reason), false, String(reason));
  }
  assert.equal(validCertificateOverrideReason("Approved early credit for the attendee’s completed preparatory assessment."), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { popupDiagnostic, popupDiagnosticSnapshot, popupRequestKind, popupFailureReason } from "./popupDiagnostics.js";

test("bounded popup trace excludes identifiers, URLs, bodies and unrecognised timing metadata", () => {
  popupDiagnostic("request_finished", { request: 1, status: 200, kind: "selected_content",
    reason: "person@example.test", viewer_key: "member:private-id", url: "https://private.example.test",
    body: { secret: "private-token" },
    serverTiming: 'page;dur=3.25, total;dur=5.75, secret;dur=123, audience;desc="private-token";dur=1' });
  const trace = popupDiagnosticSnapshot();
  assert.doesNotMatch(trace, /person@|private|secret|viewer_key/);
  assert.deepEqual(JSON.parse(trace).at(-1).serverMs, { page: 3.25, total: 5.75 });
  for (let n = 0; n < 300; n++) popupDiagnostic("runtime_mounted", { instance: n });
  assert.equal(JSON.parse(popupDiagnosticSnapshot()).length, 250);
});

test("request types distinguish early checks, content authorisation, rechecks and writes", () => {
  assert.equal(popupRequestKind("page_slug=home"), "early_eligibility");
  assert.equal(popupRequestKind("page_id=x"), "eligibility");
  assert.equal(popupRequestKind("page_id=x&id=y"), "selected_content");
  assert.equal(popupRequestKind("page_id=x&revalidate=1"), "eligibility_recheck");
  assert.equal(popupRequestKind("page_id=x&id=y&revalidate=1"), "content_recheck");
  assert.equal(popupRequestKind("", "POST"), "preference_write");
  assert.equal(popupFailureReason(new Error("Popup eligibility request timed out.")), "timeout");
  assert.equal(popupFailureReason(new Error("private error")), "request_failed");
});

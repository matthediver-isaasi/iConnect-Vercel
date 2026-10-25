// A send is immutable once attempted. Network errors and unknown/sending receipts
// never permit a new key or automatic resending.
export function createSubmissionForwardSession(submissionId, request, uuid = () => crypto.randomUUID()) {
  let payload = null;
  let receipt = null;
  let pending = false;
  return {
    get payload() { return payload; },
    get receipt() { return receipt; },
    get pending() { return pending; },
    async send(memberId, messageHtml, sendRequest = request) {
      if (pending) throw new Error("This request is already in progress.");
      if (receipt?.status === "sent") return { forward: receipt };
      if (!payload) {
        if (!memberId) throw new Error("Choose a member with an email address.");
        payload = Object.freeze({
          submission_id: submissionId, member_id: memberId,
          message_html: messageHtml, idempotency_key: uuid(),
        });
      }
      pending = true;
      try {
        const data = await sendRequest(payload);
        if (!data?.forward?.id || !["sent", "failed", "unknown", "sending"].includes(data.forward.status)) {
          throw new Error("Delivery could not be confirmed. Check the original request; do not send a new email.");
        }
        receipt = data.forward;
        return data;
      } finally {
        pending = false;
      }
    },
  };
}

export function submissionForwardBatchIds(submissions) {
  return [...new Set(submissions.map(submission => submission?.id).filter(Boolean))].sort().slice(0, 100);
}

export function groupSubmissionForwards(forwards = []) {
  const grouped = Object.create(null);
  for (const forward of forwards) {
    if (!forward.submission_id) continue;
    (grouped[forward.submission_id] ||= []).push(forward);
  }
  return grouped;
}

export function forwardDisplayStatus(forward, now = Date.now()) {
  if (forward.revoked_at) return "Revoked";
  if (forward.expires_at && new Date(forward.expires_at).getTime() <= now) return "Expired";
  return { sent: "Sent", failed: "Failed", unknown: "Delivery unconfirmed", sending: "Sending" }[forward.status] || "Delivery unconfirmed";
}

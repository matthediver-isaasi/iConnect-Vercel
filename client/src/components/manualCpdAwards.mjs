const ENDPOINT = "/api/admin/manual-cpd-awards";

export function validManualCpdAward(fields) {
  return Boolean(fields.template_id && fields.activity_title.trim()
    && /^\d{4}-\d{2}-\d{2}$/.test(fields.activity_date)
    && Number.isFinite(Number(fields.points_value)) && Number(fields.points_value) > 0);
}

export async function loadManualCpdOptions(memberId) {
  const response = await fetch(`${ENDPOINT}?member_id=${encodeURIComponent(memberId)}`, { credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not load certificate templates");
  return data;
}

export async function postManualCpd(payload) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    const error = new Error("The server response could not be confirmed. Retry the same request to check its outcome.");
    error.ambiguous = true;
    throw error;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || "The CPD request could not be completed");
    error.ambiguous = response.status >= 500 || response.status === 408;
    throw error;
  }
  if (payload.action === "preview") {
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) {
      throw new Error("The certificate response was not a PDF");
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  try {
    const data = await response.json();
    if (payload.action === "award" && !data.entry?.id) throw new Error("Missing award receipt");
    if (payload.action === "email" && !["sent", "pending", "unknown", "failed"].includes(data.status)) {
      throw new Error("Missing email receipt");
    }
    return data;
  } catch {
    const error = new Error("The server response could not be confirmed. Retry the same request to check its outcome.");
    error.ambiguous = true;
    throw error;
  }
}

// Each session keeps the exact payload and key for every retry. An email request
// can only reference a confirmed ledger entry; it can never call award again.
export function createManualCpdSession(memberId, uuid = () => crypto.randomUUID()) {
  let awardPayload = null;
  let awardUncertain = false;
  let entry = null;
  let emailPayload = null;
  return {
    get locked() { return Boolean(awardPayload); },
    get entry() { return entry; },
    get emailLocked() { return Boolean(emailPayload); },
    async award(fields) {
      if (entry) return { entry, email_status: "not_sent" };
      if (!awardPayload) {
        if (!validManualCpdAward(fields)) throw new Error("Complete the certificate, positive points, activity and date fields.");
        awardPayload = { action: "award", member_id: memberId, ...fields, idempotency_key: uuid() };
      }
      try {
        const result = await postManualCpd(awardPayload);
        entry = result.entry;
        return result;
      } catch (error) {
        awardUncertain = awardUncertain || Boolean(error.ambiguous);
        if (!awardUncertain) awardPayload = null;
        throw error;
      }
    },
    async email(messageHtml) {
      if (!entry) throw new Error("Save the award before emailing its certificate.");
      if (!emailPayload) emailPayload = {
        action: "email", member_id: memberId, ledger_entry_id: entry.id,
        message_html: messageHtml, idempotency_key: uuid(),
      };
      return postManualCpd(emailPayload);
    },
  };
}

export const memberChangeEndpoint = "/api/membership/member-amendments";

export async function readMemberChangeResponse(response) {
  let body;
  try { body = await response.json(); } catch {
    throw Object.assign(new Error("The server response could not be read. The outcome is not confirmed."), { status: response.status });
  }
  if (!response.ok) throw Object.assign(new Error(
    typeof body?.error === "string" ? body.error : body?.error?.message || "Membership request failed."
  ), { status: response.status });
  return body;
}

// Member calls deliberately never use adminFetch or accept a member identifier.
export async function memberChangeRequest(action, formId, payload = {}, signal) {
  const read = action === "member_change_context" || action === "member_change_availability";
  return readMemberChangeResponse(await fetch(read
    ? `${memberChangeEndpoint}?action=${action}&formId=${encodeURIComponent(formId)}`
    : memberChangeEndpoint, {
    credentials: "include", cache: "no-store", signal,
    ...(read ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, action, formId }),
    }),
  }));
}

export function requestDate(value) {
  if (!value) return "Not supplied";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Not supplied" : parsed.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

export function requestMoney(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not supplied";
  if (!currency) return `${(value / 100).toFixed(2)} (currency not supplied)`;
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value / 100); }
  catch { return `${(value / 100).toFixed(2)} ${currency}`; }
}

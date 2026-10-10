export const BOUNCE_QUERY_KEY = "communication-bounces";
export const bounceListKey = (view, page, search) => [BOUNCE_QUERY_KEY, "list", view, page, search];
export const memberBounceKey = (memberId, email) => [BOUNCE_QUERY_KEY, "member", memberId, email || ""];
export const canQueryMemberBounce = (memberId, email) => Boolean(memberId && email?.trim());

export function bounceListParams(view, page, search) {
  return new URLSearchParams({ view, page: String(page), search: search.trim() }).toString();
}

export function resolutionPayload(item, reason) {
  if (!reason?.trim()) throw new Error("Enter a reason for resuming campaign eligibility.");
  if (!item?.id || !item.last_bounced_at) throw new Error("Refresh the report before resolving this bounce.");
  return { id: item.id, expectedLastBouncedAt: item.last_bounced_at, reason: reason.trim() };
}

export async function readBounceResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : "";
    const error = new Error(response.status === 409
      ? `The address could not be resolved. If the email provider still suppresses it, an administrator must resolve that suppression with the provider first. Refresh this report before trying again.${message ? ` ${message}` : ""}`
      : message || "Bounce information could not be loaded. Please try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export function formatBounceDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

export const DELIVERY_OUTCOME_FILTERS = [
  { value: "hard_bounce", label: "Hard bounce" },
  { value: "soft_bounce", label: "Soft bounce · retrying" },
  { value: "delivery_failed", label: "Delivery failed after retries" },
];

export function recipientDeliveryStatus(recipient) {
  const outcome = DELIVERY_OUTCOME_FILTERS.find(({ value }) => value === recipient.delivery_outcome);
  if (outcome) return { label: outcome.label, className: outcome.value === "soft_bounce" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-red-300 bg-red-50 text-red-700" };
  const status = recipient.status;
  return {
    label: status,
    className: ["delivered", "opened", "clicked"].includes(status) ? "border-green-500 text-green-600"
      : ["bounced", "failed"].includes(status) ? "border-red-500 text-red-600"
      : status === "complained" ? "border-rose-500 text-rose-600"
      : status === "unsubscribed" ? "border-warning/50 text-warning" : "",
  };
}

export function matchesDeliveryOutcome(recipient, filter) {
  return recipient.delivery_outcome === filter;
}

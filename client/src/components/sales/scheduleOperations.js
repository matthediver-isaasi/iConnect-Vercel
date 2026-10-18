import { ambiguousCustomerCandidates } from "@/lib/invoiceStatus";

// Stored schedule errors omit the transport's HTTP status. Adapt only the
// explicit ambiguity contract (or its candidate list) to the existing helper.
export function scheduleCustomerMatch(value) {
  const payload = value?.payload || (value && typeof value === "object" ? value : {});
  const details = payload.details && typeof payload.details === "object" ? payload.details : {};
  const candidates = Array.isArray(details.candidates) ? details.candidates : payload.candidates;
  const code = payload.code || details.code || payload.error?.code
    || (Array.isArray(candidates) && candidates.length ? "AMBIGUOUS_CUSTOMER_MATCH" : null);
  const ambiguous = code === "AMBIGUOUS_CUSTOMER_MATCH";
  return {
    ambiguous,
    candidates: ambiguous ? ambiguousCustomerCandidates({
      status: 409,
      payload: { ...payload, code, details: { ...details, candidates: Array.isArray(candidates) ? candidates : [] } },
    }) : [],
  };
}

export const scheduleCommandId = value => typeof value === "string" ? value : value?.scheduleId;

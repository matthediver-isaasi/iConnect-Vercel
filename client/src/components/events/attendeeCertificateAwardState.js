// This is an API capability contract, not a client-side award decision.
// The server must authorize and atomically enforce every award.
export function certificateAwardState(metadata) {
  const guest = metadata?.certificate_points_source === "guest_rule";
  const awarded = metadata?.award_status === "awarded"
    || metadata?.certificate_points_source === "member_ledger";
  const required = !guest && !awarded && metadata?.award_required === true;
  const supported = guest || awarded
    || (required && metadata?.manual_award_supported === true);
  return { guest, awarded, required, supported };
}

export function validCertificateOverrideReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  return reason.length >= 15 && reason.length <= 2000
    && reason.split(/\s+/).length >= 3
    && new Set(reason.toLowerCase().split(/\s+/)).size >= 3
    && (reason.match(/\p{L}/gu) || []).length >= 10
    && !/^(test|testing|override|admin|n\/a|none|reason|default)(\s|[.!-])*$/i.test(reason);
}

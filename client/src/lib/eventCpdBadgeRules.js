export const CPD_TRIGGER_REGISTRATION = "registration";
export const CPD_TRIGGER_ATTENDANCE = "attendance";

export function emptyEventCpdBadgeConfig() {
  return { eventRule: null, ticketRules: {} };
}

export function ticketStableReference(ticket) {
  return String(ticket?._dbId || ticket?.id || ticket?._localId || "");
}

export function normalizeEventCpdBadgeConfig(raw) {
  const config = emptyEventCpdBadgeConfig();
  const rules = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : []);
  for (const rule of rules) {
    if (!rule || (rule.trigger !== CPD_TRIGGER_REGISTRATION && rule.trigger !== CPD_TRIGGER_ATTENDANCE)) continue;
    const normalized = {
      badge_id: rule.badge_id || null,
      trigger: rule.trigger,
      no_award: rule.no_award === true || rule.is_no_award === true,
      ticket_name_snapshot: rule.ticket_name_snapshot || null,
    };
    if (rule.scope === "event") {
      if (!normalized.no_award && normalized.badge_id) config.eventRule = normalized;
    } else if (rule.scope === "ticket") {
      const ref = String(rule.ticket_reference || rule.ticket_class_id || "");
      if (ref && (normalized.no_award || normalized.badge_id)) config.ticketRules[ref] = normalized;
    }
  }
  return config;
}

export function eventCpdConfigToPayload(config, tickets = []) {
  const rules = [];
  if (config?.eventRule?.badge_id) {
    rules.push({
      scope: "event",
      badge_id: config.eventRule.badge_id,
      trigger: config.eventRule.trigger || CPD_TRIGGER_REGISTRATION,
      no_award: false,
    });
  }
  const ticketMap = new Map(tickets.map((ticket) => [ticketStableReference(ticket), ticket]));
  for (const [reference, rule] of Object.entries(config?.ticketRules || {})) {
    const ticket = ticketMap.get(String(reference));
    if (!ticket || (!rule?.no_award && !rule?.badge_id)) continue;
    rules.push({
      scope: "ticket",
      ticket_reference: String(reference),
      ticket_class_id: ticket?._dbId || null,
      ticket_name_snapshot: ticket?.name || rule.ticket_name_snapshot || null,
      badge_id: rule.no_award ? null : rule.badge_id,
      trigger: rule.trigger || CPD_TRIGGER_REGISTRATION,
      no_award: rule.no_award === true,
    });
  }
  return { rules };
}

export function remapEventCpdTicketReferences(config, referenceMap) {
  const next = { ...config, ticketRules: {} };
  for (const [reference, rule] of Object.entries(config?.ticketRules || {})) {
    next.ticketRules[referenceMap?.[reference] || reference] = rule;
  }
  return next;
}

export async function putEventCpdBadgeRules(eventId, eventType, config, tickets) {
  const response = await fetch("/api/admin/event-cpd-badge-rules", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: eventId,
      event_type: eventType,
      ...eventCpdConfigToPayload(config, tickets),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Failed to save CPD badge rules");
  return result;
}

// Provider probe messages are deliberately supplied by the server. The API
// returns one capability object per source (`qr`, `zoom`, `teams`), while
// retaining support for the former top-level warnings array. Keep only concise
// strings so the editor never has to infer deployment/schema details.
export function attendanceCapabilityWarnings(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return [];
  const warnings = [
    ...(Array.isArray(capabilities.warnings) ? capabilities.warnings : []),
    ...["qr", "zoom", "teams"].flatMap((provider) => {
      const capability = capabilities[provider];
      if (!capability || typeof capability !== "object") return [];
      return Array.isArray(capability.warnings)
        ? capability.warnings
        : [capability.warning];
    }),
  ]
    .filter((warning) => typeof warning === "string" && warning.trim())
    .map((warning) => warning.trim());
  return [...new Set(warnings)];
}

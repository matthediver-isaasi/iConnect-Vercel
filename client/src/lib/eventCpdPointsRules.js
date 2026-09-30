import {
  CPD_TRIGGER_ATTENDANCE,
  CPD_TRIGGER_REGISTRATION,
  ticketStableReference,
} from "./eventCpdBadgeRules.js";

export { CPD_TRIGGER_ATTENDANCE, CPD_TRIGGER_REGISTRATION };

export function emptyEventCpdPointsConfig() {
  return { eventRule: null, ticketRules: {} };
}

export function normalizeCpdPoints(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction] = text.split(".");
  const trimmedFraction = fraction?.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

function normalizeRule(rule) {
  if (!rule || ![CPD_TRIGGER_REGISTRATION, CPD_TRIGGER_ATTENDANCE].includes(rule.trigger)) return null;
  const noAward = rule.no_award === true || rule.is_no_award === true;
  const points = normalizeCpdPoints(rule.points);
  if (!noAward && points === null) return null;
  return {
    points: noAward ? null : points,
    trigger: rule.trigger,
    no_award: noAward,
    ticket_name_snapshot: rule.ticket_name_snapshot || null,
  };
}

export function normalizeEventCpdPointsConfig(raw) {
  const config = emptyEventCpdPointsConfig();
  const rules = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : []);
  for (const rule of rules) {
    const normalized = normalizeRule(rule);
    if (!normalized) continue;
    if (rule.scope === "event" && !normalized.no_award) {
      config.eventRule = normalized;
    } else if (rule.scope === "ticket") {
      const reference = String(rule.ticket_reference || rule.ticket_class_id || "");
      if (reference) config.ticketRules[reference] = normalized;
    }
  }
  return config;
}

export function validateEventCpdPointsConfig(config, tickets = []) {
  const errors = [];
  const validTriggers = new Set([CPD_TRIGGER_REGISTRATION, CPD_TRIGGER_ATTENDANCE]);
  const ticketMap = new Map(tickets.map((ticket) => [ticketStableReference(ticket), ticket]));
  const validateRule = (rule, label, allowNoAward) => {
    if (!rule) return;
    if (rule.no_award) {
      if (!allowNoAward) errors.push(`${label} cannot be an explicit no-award rule`);
    } else if (normalizeCpdPoints(rule.points) === null) {
      errors.push(`${label} points must fit numeric(20,6): up to 14 whole and 6 decimal digits`);
    }
    if (!validTriggers.has(rule.trigger)) {
      errors.push(`${label} must use registration or verified attendance`);
    }
  };
  validateRule(config?.eventRule, "Event-wide CPD", false);
  for (const [reference, rule] of Object.entries(config?.ticketRules || {})) {
    if (!ticketMap.has(String(reference))) continue;
    const ticket = ticketMap.get(String(reference));
    validateRule(rule, `${ticket?.name || "Ticket"} CPD override`, true);
  }
  return errors;
}

export function eventCpdPointsConfigToPayload(config, tickets = []) {
  const errors = validateEventCpdPointsConfig(config, tickets);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.validationErrors = errors;
    throw error;
  }
  const rules = [];
  if (config?.eventRule) {
    rules.push({
      scope: "event",
      points: normalizeCpdPoints(config.eventRule.points),
      trigger: config.eventRule.trigger,
      no_award: false,
    });
  }
  const ticketMap = new Map(tickets.map((ticket) => [ticketStableReference(ticket), ticket]));
  for (const [reference, rule] of Object.entries(config?.ticketRules || {})) {
    const ticket = ticketMap.get(String(reference));
    if (!ticket || !rule) continue;
    rules.push({
      scope: "ticket",
      ticket_reference: String(reference),
      ticket_class_id: ticket._dbId || null,
      ticket_name_snapshot: ticket.name || rule.ticket_name_snapshot || null,
      points: rule.no_award ? null : normalizeCpdPoints(rule.points),
      trigger: rule.trigger || config?.eventRule?.trigger || CPD_TRIGGER_REGISTRATION,
      no_award: rule.no_award === true,
    });
  }
  return { rules };
}

export function remapEventCpdPointsTicketReferences(config, referenceMap) {
  const next = { ...config, ticketRules: {} };
  for (const [reference, rule] of Object.entries(config?.ticketRules || {})) {
    next.ticketRules[referenceMap?.[reference] || reference] = rule;
  }
  return next;
}

export async function putEventCpdPointsRules(eventId, eventType, config, tickets) {
  const response = await fetch("/api/admin/event-cpd-points-rules", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: eventId,
      event_type: eventType,
      ...eventCpdPointsConfigToPayload(config, tickets),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Failed to save CPD points rules");
  return result;
}
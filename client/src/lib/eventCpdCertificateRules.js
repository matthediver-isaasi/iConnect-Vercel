import { ticketStableReference } from "./eventCpdBadgeRules.js";
import {
  emptyEventCpdCertificateConfig,
  validateEventCpdCertificateConfig as validatePolicy,
} from "../../../shared/eventCpdCertificatePolicy.js";

export { emptyEventCpdCertificateConfig };
export function validateEventCpdCertificateConfig(config, tickets = []) {
  const valid = new Set(tickets.map(ticketStableReference));
  return validatePolicy(config && {
    ...config,
    ticketRules: Object.fromEntries(Object.entries(config.ticketRules || {}).filter(([ref]) => valid.has(ref))),
  }, [...valid]);
}

export function normalizeEventCpdCertificateConfig(raw) {
  const event = raw?.eventRule || {};
  return {
    eventRule: {
      template_id: event.template_id || null,
      email_template_id: event.email_template_id ?? null,
      date_mode: event.date_mode === "custom" ? "custom" : "event",
      start_date: event.date_mode === "custom" ? event.start_date || null : null,
      end_date: event.date_mode === "custom" ? event.end_date || null : null,
    },
    ticketRules: Object.fromEntries(Object.entries(raw?.ticketRules || {}).map(([ref, rule]) => [
      ref, {
        template_mode: ["inherit", "override", "none"].includes(rule?.template_mode) ? rule.template_mode : "inherit",
        template_id: rule?.template_mode === "override" ? rule?.template_id || null : null,
        date_mode: rule?.date_mode === "custom" ? "custom" : "inherit",
        start_date: rule?.date_mode === "custom" ? rule?.start_date || null : null,
        end_date: rule?.date_mode === "custom" ? rule?.end_date || null : null,
      },
    ])),
  };
}

export function remapEventCpdCertificateTicketReferences(config, referenceMap) {
  return {
    ...config,
    ticketRules: Object.fromEntries(Object.entries(config?.ticketRules || {}).map(([ref, rule]) => [
      referenceMap?.[ref] || ref, rule,
    ])),
  };
}

export function eventCpdCertificateConfigToPayload(config, tickets = []) {
  const ticketMap = new Map(tickets.map(ticket => [ticketStableReference(ticket), ticket]));
  const normalized = normalizeEventCpdCertificateConfig(config);
  const filtered = {
    ...normalized,
    ticketRules: Object.fromEntries(Object.entries(normalized.ticketRules)
      .filter(([ref]) => ticketMap.has(ref))
      .map(([ref, rule]) => [ticketStableReference(ticketMap.get(ref)), rule])),
  };
  const errors = validateEventCpdCertificateConfig(filtered, tickets);
  if (errors.length) throw new Error(errors[0]);
  return filtered;
}

export async function putEventCpdCertificateRules(eventId, eventType, config, tickets = []) {
  const response = await fetch("/api/admin/event-cpd-certificate-rules", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: eventId, event_type: eventType,
      config: eventCpdCertificateConfigToPayload(config, tickets),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Failed to save CPD certificate settings");
  return result;
}
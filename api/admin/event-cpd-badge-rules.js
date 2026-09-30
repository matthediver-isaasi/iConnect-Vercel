import { supabase } from "../_lib/database.js";
import { getTenantContext, hasAdminAccess } from "../_lib/tenantContext.js";
import { detectEventCpdAttendanceCapabilities } from "../_lib/eventCpdAttendanceCapabilities.js";

const EVENT_TYPES = new Set(["simple", "complex"]);
const DB_EVENT_TYPE = { simple: "event", complex: "complex_event" };
const TRIGGERS = new Set(["registration", "attendance"]);

async function authorize(req, res) {
  const context = await getTenantContext(req);
  if (!context?.tenantId || !context.isAuthenticated) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (!(await hasAdminAccess(context))) {
    res.status(403).json({ error: "Event administrator permission is required" });
    return null;
  }
  return context;
}

async function loadEvent(tenantId, eventType, eventId) {
  const table = eventType === "complex" ? "complex_event" : "event";
  const { data, error } = await supabase.from(table).select("id, pricing_config").eq("id", eventId).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  if (!["GET", "PUT"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  if (!supabase) return res.status(500).json({ error: "Database not configured" });
  const context = await authorize(req, res);
  if (!context) return;

  const eventType = String(req.method === "GET" ? req.query?.event_type : req.body?.event_type || "");
  const eventId = String(req.method === "GET" ? req.query?.event_id || "" : req.body?.event_id || "");
  if (!EVENT_TYPES.has(eventType)) return res.status(400).json({ error: "event_type must be simple or complex" });

  try {
    const { data: badges, error: badgeError } = await supabase
      .from("badge").select("id, name, description, image_url").eq("tenant_id", context.tenantId).eq("is_active", true).order("name");
    if (badgeError) throw badgeError;

    if (req.method === "GET") {
      // Schema capability checks are deliberately best-effort.  In particular,
      // older DEST databases can lack the Teams relation/columns; that must
      // produce a safe unavailable warning rather than breaking the CPD tab.
      const attendanceCapabilities = await detectEventCpdAttendanceCapabilities(supabase);
      if (!eventId) return res.status(200).json({
        badges: badges || [], rules: [], attendance_capabilities: attendanceCapabilities,
      });
      if (!(await loadEvent(context.tenantId, eventType, eventId))) return res.status(404).json({ error: "Event not found" });
      const { data: storedRules, error } = await supabase.from("event_cpd_badge_rule").select("*")
        .eq("tenant_id", context.tenantId).eq("event_id", eventId).eq("event_type", DB_EVENT_TYPE[eventType]).eq("active", true);
      if (error) throw error;
      const rules = (storedRules || []).map((rule) => ({
        ...rule,
        scope: rule.ticket_id ? "ticket" : "event",
        ticket_class_id: rule.ticket_id,
        ticket_reference: rule.ticket_id,
        trigger: rule.trigger_type,
        no_award: rule.is_no_award === true,
      }));
      return res.status(200).json({
        badges: badges || [],
        rules,
        attendance_capabilities: attendanceCapabilities,
      });
    }

    if (!eventId) return res.status(400).json({ error: "event_id is required" });
    const event = await loadEvent(context.tenantId, eventType, eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });
    const rules = Array.isArray(req.body?.rules) ? req.body.rules : null;
    if (!rules || rules.length > 501) return res.status(400).json({ error: "rules must be an array of at most 501 items" });
    if (rules.filter((rule) => rule?.scope === "event").length > 1) return res.status(400).json({ error: "Only one event-wide rule is allowed" });

    const activeBadgeIds = new Set((badges || []).map((badge) => badge.id));
    let validTicketIds = new Set();
    if (eventType === "complex") {
      const { data, error } = await supabase.from("complex_event_ticket_class").select("id")
        .eq("complex_event_id", eventId).eq("tenant_id", context.tenantId);
      if (error) throw error;
      validTicketIds = new Set((data || []).map((ticket) => String(ticket.id)));
    } else {
      validTicketIds = new Set((event.pricing_config?.ticket_classes || []).map((ticket) => String(ticket.id)));
    }

    const seenTickets = new Set();
    const rows = rules.map((rule) => {
      if (!rule || !["event", "ticket"].includes(rule.scope)) throw new Error("Each rule requires a valid scope");
      if (!TRIGGERS.has(rule.trigger)) throw new Error("Each rule requires a valid trigger");
      const noAward = rule.no_award === true;
      if (rule.scope === "event" && noAward) throw new Error("The event-wide rule cannot be a no-award rule");
      if (!noAward && !activeBadgeIds.has(rule.badge_id)) throw new Error("Each award rule must reference an active tenant badge");
      const reference = rule.scope === "ticket" ? String(rule.ticket_class_id || rule.ticket_reference || "") : null;
      if (rule.scope === "ticket") {
        if (!reference || !validTicketIds.has(reference)) throw new Error("A ticket override references a ticket that does not belong to this event");
        if (seenTickets.has(reference)) throw new Error("Only one override is allowed per ticket");
        seenTickets.add(reference);
      }
      return {
        tenant_id: context.tenantId,
        event_id: eventId,
        event_type: DB_EVENT_TYPE[eventType],
        ticket_id: reference,
        ticket_name_snapshot: rule.scope === "ticket" ? String(rule.ticket_name_snapshot || "").slice(0, 250) || null : null,
        badge_id: noAward ? null : rule.badge_id,
        badge_name_snapshot: noAward ? null : (badges || []).find((badge) => badge.id === rule.badge_id)?.name,
        trigger_type: rule.trigger,
        is_no_award: noAward,
        active: true,
      };
    });

    // This RPC validates and replaces under one advisory lock.  It soft-deletes
    // prior rows only after all input checks pass, preserving award provenance.
    const { data: savedRules, error: replaceError } = await supabase.rpc(
      "replace_event_cpd_badge_rules",
      {
        p_tenant_id: context.tenantId,
        p_event_type: DB_EVENT_TYPE[eventType],
        p_event_id: eventId,
        p_rules: rows,
      },
    );
    if (replaceError) throw replaceError;
    return res.status(200).json({ rules: savedRules || [] });
  } catch (error) {
    const validation = /^(Each |Only |The event|A ticket|invalid CPD|at most |event does not|complex event does not|badge does not|no-award)/i
      .test(error.message || "");
    console.error("[event-cpd-badge-rules]", error.message);
    return res.status(validation ? 400 : 500).json({
      error: validation ? error.message : (req.method === "GET" ? "Failed to load CPD badge rules" : "Failed to save CPD badge rules"),
    });
  }
}

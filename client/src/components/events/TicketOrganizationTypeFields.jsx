import { useEffect, useState, useSyncExternalStore } from "react";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import { ORGANIZATION_TYPE_ALIASES } from "../../../../shared/ticketOrganizationType.js";

export default function TicketOrganizationTypeFields({ ticket, onChange, eventId, eventType = "simple", groupId }) {
  const tenantId = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const [state, setState] = useState({ fields: [], loading: true, error: "" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ fields: [], loading: true, error: "" });
    const params = new URLSearchParams({ organization_types: "true", event_type: eventType });
    if (eventId) params.set("event_id", eventId);
    if (groupId) params.set("group_id", groupId);
    fetch(`/api/events/ticket-members?${params}`, { credentials: "include", signal: controller.signal,
      headers: tenantId ? { "X-Tenant-Id": tenantId } : {} })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load Organisation Types.");
        setState({ fields: body.fields || [], loading: false, error: "" });
      }).catch(error => {
        if (error.name !== "AbortError") setState({ fields: [], loading: false, error: error.message });
      });
    return () => controller.abort();
  }, [tenantId, eventId, eventType, groupId, retry]);
  if (ticket.audience_mode === "selected_members") return null;
  const enabled = ticket.organization_type_enabled === true;
  const field = ticket.organization_type_field_id
    ? state.fields.find(f => f.id === ticket.organization_type_field_id)
    : ORGANIZATION_TYPE_ALIASES.map(name => state.fields.find(f => f.name === name)).find(Boolean);
  const values = Array.isArray(ticket.organization_type_values) ? ticket.organization_type_values : [];
  const stale = values.filter(v => !field?.options.some(o => o.value === v));
  const warning = state.error || (!state.loading && (!field
    ? "The saved Organisation Type field is missing or inactive. Restore it or explicitly select an available field."
    : field.warning || (!field.options.length ? "Configure options on the organisation-scoped Organisation Type field." : "")));
  return <div className="space-y-2 rounded-lg border border-slate-200 p-4">
    <label className="flex items-center gap-2 font-medium">
      <input type="checkbox" checked={enabled} onChange={e => onChange({
        organization_type_enabled: e.target.checked,
        organization_type_field_id: ticket.organization_type_field_id || field?.id || null,
      })} />
      Restrict by Organisation Type
    </label>
    <p className="text-xs text-slate-500">Members must have one of the selected types on their primary organisation. If role or member-group restrictions are enabled, they must also satisfy that audience rule. Guests cannot qualify.</p>
    {state.loading && <p role="status">Loading Organisation Types…</p>}
    {warning && <p role="alert" className="text-sm text-amber-700">{warning} <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
    {enabled && <>
      <select aria-label="Organisation Type field" disabled={state.loading || !!state.error}
        value={ticket.organization_type_field_id || field?.id || ""}
        onChange={e => onChange({ organization_type_field_id: e.target.value })}>
        <option value="">Select Organisation Type field</option>
        {ticket.organization_type_field_id && !field && <option value={ticket.organization_type_field_id}>Unavailable saved field</option>}
        {state.fields.map(f => <option key={f.id} value={f.id}>{f.label || f.name}</option>)}
      </select>
      {!values.length && <p role="alert" className="text-sm text-amber-700">Select at least one type before saving.</p>}
      {(field?.options || []).map(option => <label key={option.value} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={values.includes(option.value)} onChange={e => onChange({
          organization_type_field_id: field.id,
          organization_type_values: e.target.checked ? [...values, option.value] : values.filter(v => v !== option.value),
        })} />{option.label}
      </label>)}
      {!state.loading && !state.error && stale.map(value => <p key={value} role="alert" className="text-sm text-amber-700">
        Unavailable saved type: {value}. <button type="button" onClick={() => onChange({ organization_type_values: values.filter(v => v !== value) })}>Remove selection</button>
      </p>)}
    </>}
  </div>;
}

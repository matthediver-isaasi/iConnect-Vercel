import { useEffect, useState, useSyncExternalStore } from "react";
import { updateTicketMemberField } from "@/utils/publicTicketMembers";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";

export default function SelectedMemberAudience({ ticket, onChange, eventId, eventType = "simple", groupId }) {
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState([]);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState("");
  const tenantId = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const privateMode = ticket.audience_mode === "selected_members";
  const ids = ticket.selected_member_ids || [];
  const idsKey = ids.join(",");
  useEffect(() => {
    if (!privateMode) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ event_type: eventType });
        if (eventId) params.set("event_id", eventId);
        if (groupId) params.set("group_id", groupId);
        if (query.trim().length >= 2) params.set("q", query.trim());
        if (idsKey) params.set("ids", idsKey);
        if (!params.has("q") && !idsKey) { setMembers([]); setSelected([]); return; }
        const activeTenant = getActiveTenantId();
        const response = await fetch(`/api/events/ticket-members?${params}`, { credentials: "include", signal: controller.signal, headers: activeTenant ? { "X-Tenant-Id": activeTenant } : {} });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to search members");
        setMembers(body.results || []);
        setSelected(body.selected || []);
        setError("");
      } catch (err) {
        if (err.name !== "AbortError") setError(err.message);
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, idsKey, eventId, eventType, groupId, privateMode, tenantId]);
  return <div className="space-y-3 rounded-lg border border-slate-200 p-4">
    <label className="flex items-center gap-2 font-medium">
      <input type="checkbox" checked={privateMode} onChange={e => onChange(updateTicketMemberField(ticket, "audience_mode", e.target.checked ? "selected_members" : "legacy"))} />
      Selected members only
    </label>
    {privateMode && <>
      <p className="text-xs text-slate-500">Only these members can see and purchase this ticket. Role, group and public access do not apply.</p>
      {!ids.length && <p role="alert" className="text-sm text-amber-700">No members selected. This ticket will be hidden from everyone.</p>}
      <input aria-label="Search selected ticket members" placeholder="Search members (at least 2 characters)" value={query} onChange={e => setQuery(e.target.value)} className="w-full rounded border p-2" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <ul>{ids.map(id => {
        const member = selected.find(m => String(m.id) === String(id));
        return <li key={id} className="flex items-center justify-between py-1"><span>{member ? `${member.first_name || ""} ${member.last_name || ""} (${member.email || ""})` : "Selected member"}</span><button type="button" onClick={() => onChange({ selected_member_ids: ids.filter(value => value !== id) })}>Remove</button></li>;
      })}</ul>
      {ids.length >= 100 && <p role="alert">A maximum of 100 members can be selected.</p>}
      <ul>{members.filter(m => !ids.includes(m.id)).map(member => <li key={member.id}><button type="button" disabled={ids.length >= 100} className="w-full rounded p-2 text-left hover:bg-slate-100" onClick={() => onChange({ selected_member_ids: [...ids, member.id] })}>Add {member.first_name} {member.last_name} ({member.email})</button></li>)}</ul>
    </>}
  </div>;
}

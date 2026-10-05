import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isProvisionableRole } from "@/utils/publicTicketMembers";

export default function PublicTicketMemberFields({ ticket, roles = [], onChange, loading = false }) {
  if (!["public_only", "members_and_public"].includes(ticket.visibility_mode)) return null;
  const eligibleRoles = roles.filter(isProvisionableRole);
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={`create-members-${ticket.id || ticket._localId}`}>Create member records upon purchase</Label>
          <p className="text-xs text-slate-500 mt-1">Create contact records for the purchaser and attendees after a successful paid or free booking. This does not enable login or buy a membership.</p>
        </div>
        <Switch id={`create-members-${ticket.id || ticket._localId}`} checked={ticket.create_member_records === true}
          onCheckedChange={(enabled) => onChange({ create_member_records: enabled, new_member_role_id: enabled ? ticket.new_member_role_id || null : null })} />
      </div>
      {ticket.create_member_records === true && (
        <div className="space-y-2">
          <Label>Role for new members *</Label>
          <Select value={ticket.new_member_role_id ? String(ticket.new_member_role_id) : ""} disabled={loading}
            onValueChange={(id) => onChange({ new_member_role_id: id })}>
            <SelectTrigger aria-label="Role for new members"><SelectValue placeholder={loading ? "Loading roles..." : "Select a role"} /></SelectTrigger>
            <SelectContent>{eligibleRoles.map(role => <SelectItem key={role.id} value={String(role.id)}>{role.name}</SelectItem>)}</SelectContent>
          </Select>
          {!loading && eligibleRoles.length === 0 && <p className="text-sm text-amber-700">No eligible roles are available. A role without administrator, organisation, capacity or effective-date requirements is needed.</p>}
          <p className="text-xs text-slate-500">Separate from ticket eligibility roles. Unpaid Invoice / PO registrations do not create member records.</p>
        </div>
      )}
    </div>
  );
}

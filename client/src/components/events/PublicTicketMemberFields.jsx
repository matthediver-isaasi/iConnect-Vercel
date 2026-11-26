import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { isProvisionableRole } from "@/utils/publicTicketMembers";
import SelectedMemberAudience from "./SelectedMemberAudience";
import TicketOrganizationTypeFields from "./TicketOrganizationTypeFields";

function MemberSettingInfo({ label, title, summary, children }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
        >
          <Info aria-hidden="true" className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(85dvh,42rem)] overflow-y-auto">
        <DialogHeader className="pr-6">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm leading-relaxed text-slate-600">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PublicTicketMemberFields({ ticket, roles = [], onChange, loading = false, eventId, eventType, groupId }) {
  const audience = <><SelectedMemberAudience ticket={ticket} onChange={onChange} eventId={eventId} eventType={eventType} groupId={groupId} />
    <TicketOrganizationTypeFields ticket={ticket} onChange={onChange} eventId={eventId} eventType={eventType} groupId={groupId} /></>;
  if (ticket.audience_mode === "selected_members" || !["public_only", "members_and_public"].includes(ticket.visibility_mode)) return audience;
  const eligibleRoles = roles.filter(isProvisionableRole);
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      {audience}
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={`guest-accounts-${ticket.id || ticket._localId}`}>Automatically create accounts for guests</Label>
          <p className="mt-1 text-xs text-slate-500">Creates contact records and sign-in accounts for bookers and attendees, including Invoice / PO bookings.</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <MemberSettingInfo
            label="About automatically creating guest accounts"
            title="Guest accounts and contact records"
            summary="This option creates booker and attendee contact records plus sign-in accounts, including for Invoice / PO bookings before payment."
          >
            <p>Turning this on includes contact-record creation and hides the separate contact-only setting; it does not create a second set of records.</p>
            <p>Neither contact records nor guest accounts grant paid membership or marketing consent. A typed “other” organisation name is retained as entered, without creating or linking an organisation or group.</p>
            <p>Known organisation or group selections follow the event’s association settings regardless of this toggle. The selected role applies to guests without an associated organisation or group; associated guests use the role set in the event’s organisation/group settings.</p>
          </MemberSettingInfo>
          <Switch id={`guest-accounts-${ticket.id || ticket._localId}`} checked={ticket.auto_create_guest_accounts === true}
            onCheckedChange={enabled => onChange({ auto_create_guest_accounts: enabled, create_member_records: enabled, new_member_role_id: enabled ? ticket.new_member_role_id || null : null })} />
        </div>
      </div>
      {ticket.auto_create_guest_accounts !== true && <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={`create-members-${ticket.id || ticket._localId}`}>Create member records upon purchase</Label>
          <p className="text-xs text-slate-500 mt-1">Creates contact records without sign-in after paid or free bookings. Excludes unpaid Invoice / PO bookings.</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <MemberSettingInfo
            label="About creating member contact records"
            title="Contact records only"
            summary="Creates CRM contact records for the booker and attendees after a paid or free booking."
          >
            <p>These are contact records, not portal accounts: they do not provide sign-in. Unpaid Invoice / PO bookings do not create records under this setting.</p>
            <p>Neither this setting nor guest account creation grants paid membership or marketing consent. A typed “other” organisation name is retained as entered, without creating or linking an organisation or group.</p>
            <p>Known organisation or group selections follow the event’s association settings regardless of this toggle. The selected role is for unassociated guests; guests associated with an organisation or group use the role in the event’s association settings.</p>
          </MemberSettingInfo>
          <Switch id={`create-members-${ticket.id || ticket._localId}`} checked={ticket.create_member_records === true}
            onCheckedChange={(enabled) => onChange({ create_member_records: enabled, new_member_role_id: enabled ? ticket.new_member_role_id || null : null })} />
        </div>
      </div>
      </>}
      {(ticket.create_member_records === true || ticket.auto_create_guest_accounts === true) && (
        <div className="space-y-2">
          <Label>Role for new members *</Label>
          <Select value={ticket.new_member_role_id ? String(ticket.new_member_role_id) : ""} disabled={loading}
            onValueChange={(id) => onChange({ new_member_role_id: id })}>
            <SelectTrigger aria-label="Role for new members"><SelectValue placeholder={loading ? "Loading roles..." : "Select a role"} /></SelectTrigger>
            <SelectContent>{eligibleRoles.map(role => <SelectItem key={role.id} value={String(role.id)}>{role.name}</SelectItem>)}</SelectContent>
          </Select>
          {!loading && eligibleRoles.length === 0 && <p className="text-sm text-amber-700">No eligible roles are available. A role without administrator, organisation, capacity or effective-date requirements is needed.</p>}
          <p className="text-xs text-slate-500">{ticket.auto_create_guest_accounts ? "Used for guests without a known organisation or group selection. Associated guests use the role in the event’s organisation/group settings." : "Separate from ticket eligibility roles. Unpaid Invoice / PO registrations do not create member records."}</p>
        </div>
      )}
    </div>
  );
}

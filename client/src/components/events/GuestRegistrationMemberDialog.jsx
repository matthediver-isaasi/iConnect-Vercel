import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemberTerminology } from "@/contexts/MemberTerminologyContext";

export const MEMBER_ENDPOINT = "/api/admin/event-registration-member";

export async function readMemberResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Unable to review or create this member. Please try again.");
  return data;
}

// The parent mounts a new dialog for each frozen registration identity.
export default function GuestRegistrationMemberDialog({ bookingId, isComplex, tenantId, viewerId, onClose, onSuccess }) {
  const { getMemberDetailUrl } = useMemberTerminology();
  const [form, setForm] = useState(null);
  const [organisationSearch, setOrganisationSearch] = useState("");
  const [search, setSearch] = useState("");
  const [organisation, setOrganisation] = useState(null);
  const [roleId, setRoleId] = useState("");
  const [roleEffectiveFrom, setRoleEffectiveFrom] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const params = new URLSearchParams({ bookingId, isComplex: String(!!isComplex) });
  const url = `${MEMBER_ENDPOINT}?${params}`;
  const details = useQuery({
    queryKey: ["event-registration-member", tenantId, viewerId, bookingId, !!isComplex],
    queryFn: async ({ signal }) => {
      const data = await readMemberResponse(await fetch(url, { credentials: "include", signal }));
      if (!data.registration || !Array.isArray(data.roles) || !Array.isArray(data.organisations)) {
        throw new Error("Registration details could not be loaded. Please retry.");
      }
      return data;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const registration = details.data?.registration;
  useEffect(() => {
    if (!registration) return;
    setForm(previous => previous || {
      first_name: registration.first_name || "",
      last_name: registration.last_name || "",
      email: registration.email || "",
      supplied_organization_name: registration.supplied_organization_name || "",
    });
  }, [registration]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(organisationSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [organisationSearch]);
  const organisationResults = useQuery({
    queryKey: ["event-registration-member-organisations", tenantId, viewerId, bookingId, !!isComplex, search],
    queryFn: async ({ signal }) => readMemberResponse(await fetch(`${url}&organisationSearch=${encodeURIComponent(search)}`, { credentials: "include", signal })),
    enabled: !!registration && !!search,
    retry: false,
  });
  const searching = organisationSearch.trim() !== search || (!!search && organisationResults.isFetching);
  const organisations = search ? organisationResults.data?.organisations || [] : details.data?.organisations || [];
  const roles = details.data?.roles || [];
  const selectedRole = roles.find(role => role.id === roleId);
  const submit = async event => {
    event.preventDefault();
    if (pending.current || !form || registration?.member_id || details.isFetching) return;
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !roles.some(role => role.id === roleId)) {
      setError("First name, last name, email and an RBAC role are required.");
      return;
    }
    if (selectedRole?.requires_effective_from_date && !roleEffectiveFrom) {
      setError("An effective from date is required for the selected role.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await readMemberResponse(await fetch(MEMBER_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId, isComplex: !!isComplex,
          ...Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])),
          organization_id: organisation?.id || null, role_id: roleId,
          ...(selectedRole?.requires_effective_from_date ? { role_effective_from: roleEffectiveFrom } : {}),
        }),
      }));
      if (!data.member?.id) throw new Error("The member link could not be confirmed. Reload the registration before trying again.");
      if (mounted.current) await onSuccess(data);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[90dvh] overflow-y-auto" onEscapeKeyDown={event => { if (pending.current) event.preventDefault(); }} onPointerDownOutside={event => { if (pending.current) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Create member from guest registration</DialogTitle>
          <DialogDescription>Review the registrant’s details and choose their access role before creating a member.</DialogDescription>
        </DialogHeader>
        {details.isFetching && <div role="status" aria-live="polite" className="space-y-3">
          <span className="text-sm text-muted-foreground">Loading authoritative registration details…</span>
          <div className="h-16 rounded-md bg-muted animate-pulse" />
          <div className="h-10 rounded-md bg-muted animate-pulse" />
        </div>}
        {details.isError && <div role="alert" className="space-y-3">
          <p className="text-sm text-destructive">{details.error.message}</p>
          <Button variant="outline" onClick={() => details.refetch()}>Retry loading details</Button>
        </div>}
        {!details.isFetching && !details.isError && registration && <>
          <dl className="rounded-md border bg-muted/30 p-3 text-sm space-y-2">
            <div><dt className="text-muted-foreground">Event</dt><dd>{registration.eventTitle || "Not supplied"}</dd></div>
            <div><dt className="text-muted-foreground">Ticket</dt><dd>{registration.ticketName || "Not supplied"}</dd></div>
            <div><dt className="text-muted-foreground">Registration</dt><dd className="break-all">{registration.bookingId} · {registration.isComplex ? "Complex event" : "Standard event"}</dd></div>
            <div><dt className="text-muted-foreground">Guest-entered organisation (reference)</dt><dd>{registration.supplied_organization_name || "Not supplied"}</dd></div>
          </dl>
          {registration.member_id ? <div className="space-y-3">
            <p role="status" className="text-sm">This registration is already linked to a member. No new member will be created.</p>
            <Link className="text-primary underline text-sm" to={getMemberDetailUrl(registration.member_id)}>View linked member profile</Link>
            <Button className="block" onClick={() => onSuccess({ member: { id: registration.member_id }, alreadyLinked: true })}>Update report and close</Button>
          </div> : form && <form onSubmit={submit} className="space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[["first_name", "First name"], ["last_name", "Last name"], ["email", "Email address"], ["supplied_organization_name", "Organisation/company name"]].map(([key, label]) => <div key={key} className="space-y-1.5">
                  <Label htmlFor={`guest-member-${key}`}>{label}{key !== "supplied_organization_name" && " *"}</Label>
                  <Input id={`guest-member-${key}`} type={key === "email" ? "email" : "text"} required={key !== "supplied_organization_name"} value={form[key]} onChange={event => setForm(previous => ({ ...previous, [key]: event.target.value }))} />
                </div>)}
              </div>
              <div className="space-y-2">
                <Label htmlFor="guest-member-org-search">Tenant organisation (optional)</Label>
                <Input id="guest-member-org-search" placeholder="Search existing tenant organisations" value={organisationSearch} onChange={event => setOrganisationSearch(event.target.value)} aria-describedby="guest-member-org-help" />
                <p id="guest-member-org-help" className="text-xs text-muted-foreground">Typing or editing an organisation name does not link it. Select an existing tenant organisation explicitly.</p>
                {organisation && <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"><span>Selected: {organisation.name}</span><Button type="button" variant="ghost" size="sm" onClick={() => setOrganisation(null)}>Clear selection</Button></div>}
                <div aria-live="polite" className="text-sm">
                  {searching ? <p role="status">Searching organisations…</p> : search && organisationResults.isError ? <div role="alert"><p className="text-destructive">{organisationResults.error.message}</p><Button type="button" variant="outline" size="sm" onClick={() => organisationResults.refetch()}>Retry search</Button></div> : <div className="max-h-32 overflow-y-auto space-y-1">
                    {!organisations.length && <p className="text-muted-foreground">No organisations found. You can continue without selecting one.</p>}
                    {organisations.map(org => <Button key={org.id} type="button" variant={organisation?.id === org.id ? "secondary" : "ghost"} className="w-full justify-start" aria-pressed={organisation?.id === org.id} onClick={() => setOrganisation(org)}>{org.name}</Button>)}
                  </div>}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="guest-member-role">RBAC role *</Label>
                <Select value={roleId} onValueChange={value => { setRoleId(value); setRoleEffectiveFrom(""); }} disabled={busy}>
                  <SelectTrigger id="guest-member-role" aria-required="true"><SelectValue placeholder="Choose a tenant role" /></SelectTrigger>
                  <SelectContent>{roles.map(role => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent>
                </Select>
                {!roles.length && <p role="alert" className="text-sm text-destructive">No tenant roles are available. A role is required to create a member.</p>}
              </div>
              {selectedRole?.requires_effective_from_date && <div className="space-y-1.5">
                <Label htmlFor="guest-member-role-effective-from">Role effective from *</Label>
                <Input id="guest-member-role-effective-from" type="date" required value={roleEffectiveFrom} onChange={event => setRoleEffectiveFrom(event.target.value)} />
                <p className="text-xs text-muted-foreground">Choose the effective date for this role. No date is selected automatically.</p>
              </div>}
            </fieldset>
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              Login/access will be enabled. This does not create a paid membership or login credentials, and no email will be sent. Existing ticket, payment and registration information will remain unchanged.
              <p className="mt-2 text-muted-foreground">An existing member with the same email will not be attached or overwritten. Resolve any duplicate email before creating a member.</p>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {busy && <p role="status" aria-live="polite" className="text-sm">Creating and linking member… Please keep this dialog open.</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy || !roleId || !roles.length} data-testid="button-create-guest-member">{busy ? "Creating member…" : "Create Member"}</Button>
            </DialogFooter>
          </form>}
        </>}
      </DialogContent>
    </Dialog>
  );
}

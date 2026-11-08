import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { adminFetch } from "@/lib/adminFetch";

export function dateMembershipUnavailableReason(form) {
  if (form.form_type === "survey") return "No-charge membership creation is not available in survey mode. The saved selection is kept.";
  if ((form.fields || []).some(field => ["payment", "membership_payment"].includes(field.type))) {
    return "This form contains a payment or membership payment field. Remove those fields to use no-charge membership creation. The saved selection is kept.";
  }
  return "";
}

export default function DateMembershipSubmissionSettings({ form, onChange, tenantContext }) {
  const value = form.date_membership_config_id || null;
  const blocked = dateMembershipUnavailableReason(form);
  const ready = tenantContext?.status === "ready";
  const { data: schedules = [], isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["form-date-term-schedules", tenantContext?.tenantId, tenantContext?.scopeKey],
    enabled: ready && (!blocked || !!value),
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      tenantContext.assertCurrent();
      const response = await adminFetch("/api/membership/tiers?action=date_term_schedules", { signal }, tenantContext.tenantId);
      if (!response.ok) throw new Error("Could not load date-based membership schedules");
      const result = await response.json();
      tenantContext.assertCurrent();
      if (!Array.isArray(result.schedules)) throw new Error("Invalid membership schedule response");
      return result.schedules;
    },
  });
  const selected = schedules.find(schedule => schedule.id === value);
  return (
    <Card className="border-slate-200 mb-6" data-testid="date-membership-submission-settings">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg">No-charge membership</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="date-membership-config">Create a no-charge membership on submission</Label>
          <Select value={value || "none"} onValueChange={id => onChange(id === "none" ? null : id)}
            disabled={!!blocked || !ready || isPending || isError || isFetching}>
            <SelectTrigger id="date-membership-config" data-testid="select-date-membership-config">
              <SelectValue placeholder="Do not create a membership" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Do not create a membership</SelectItem>
              {value && !selected && <SelectItem value={value} disabled>Saved schedule ({value}) — {isPending || isError || !ready ? "not verified" : "unavailable"}</SelectItem>}
              {schedules.map(schedule => <SelectItem key={schedule.id} value={schedule.id}>{schedule.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-slate-500">
          Optional. Choose an active member date-based schedule for a no-charge membership. Uses the member's mapped end date after submission processing. If this form requires approval, the term starts only after approval. Resubmitting a form cannot extend an existing active term.
        </p>
        <p className="text-xs text-slate-500">Changes take effect when you save the form; this setting does not update existing memberships.</p>
        {blocked && <p className="text-sm text-muted-foreground" role="status">{blocked}</p>}
        {!ready && !blocked && <p className="text-sm text-muted-foreground" role="status">
          {tenantContext?.status === "loading" ? "Verifying tenant and access…" : tenantContext?.error || "Tenant access could not be verified. Reload this page."}
        </p>}
        {ready && !blocked && isPending && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" role="status" aria-label="Loading date-based schedules" />}
        {isError && <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive">Date-based schedules could not be loaded. Your saved selection has been kept.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => refetch()} disabled={!ready || isFetching}>
            {isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>}
        {ready && !blocked && !isPending && !isError && schedules.length === 0 && <p className="text-sm text-muted-foreground">
          No active member date-based schedules are available. Configure a supported flat zero-cost member date schedule in Membership Tier Management, then reload this form.
        </p>}
        {ready && !blocked && value && !selected && !isPending && !isError && <p className="text-sm text-destructive" role="alert">
          The saved schedule is unavailable. Its ID has been kept. Choose an available schedule or explicitly choose not to create a membership.
        </p>}
      </CardContent>
    </Card>
  );
}

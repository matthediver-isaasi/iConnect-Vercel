import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useSalesSettingsScope } from "./useSalesSettings";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export default function ProductMembershipSchedule({ value, onChange }) {
  const { scopeKey, ready } = useSalesSettingsScope();
  const query = useQuery({
    queryKey: ["sales-membership-options", scopeKey],
    enabled: ready,
    queryFn: async () => {
      const result = await base44._apiRequest("/api/sales/catalogue/membership-options");
      return result?.data ?? result;
    },
  });
  const items = query.data?.items || [];
  return <div className="space-y-2 sm:col-span-2">
    <Label htmlFor="product-membership-schedule">Included organisational membership</Label>
    <select id="product-membership-schedule" className="w-full rounded-md border bg-white p-2 text-sm"
      value={value || ""} disabled={query.isPending || query.isError || query.data?.enabled !== true}
      onChange={event => onChange(event.target.value || null)}>
      <option value="">No membership included</option>
      {value && !items.some(item => item.id === value) && <option value={value}>Saved schedule (unavailable)</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    {query.isPending && <p role="status" className="text-xs">Loading organisational schedules…</p>}
    {query.data?.enabled === false && <p className="text-xs">Proposal membership products are awaiting rollout.</p>}
    {query.isError && <p role="alert" className="text-sm text-red-700">Membership schedules could not be loaded.
      <Button type="button" variant="link" onClick={() => query.refetch()}>Retry</Button></p>}
    {value && <p className="text-sm text-slate-600">Includes the base fee for one newly created period of this exact schedule.
      Add-ons remain payable. Acceptance grants eligibility; it does not create membership or prove payment.
      Use quantity 1, including within bundles, and include this schedule only once per proposal. Later renewals are not covered.</p>}
  </div>;
}

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DELIVERY_OUTCOME_FILTERS } from "./bounceModel.mjs";

export default function RecipientDeliveryOutcomeFilter({ value, onChange }) {
  return <div className="space-y-1">
    <Label htmlFor="recipient-delivery-outcome">Delivery outcome</Label>
    <Select value={value || "all"} onValueChange={(next) => onChange(next === "all" ? null : next)}>
      <SelectTrigger id="recipient-delivery-outcome" className="w-full sm:w-64"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="all">All delivery outcomes</SelectItem>{DELIVERY_OUTCOME_FILTERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

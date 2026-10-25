import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export default function WaitingListTimingField({ checked, onCheckedChange }) {
  return <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 mb-4">
    <div>
      <Label htmlFor="waiting-list-enabled" className="font-medium">Waiting List</Label>
      <p className="text-xs text-slate-600 mt-1">Collect expressions of interest, not confirmed bookings. Ticket prices remain visible; no payment is collected. Independent of event timing.</p>
    </div>
    <Switch id="waiting-list-enabled" data-testid="switch-waiting-list" checked={checked} onCheckedChange={onCheckedChange} />
  </div>;
}

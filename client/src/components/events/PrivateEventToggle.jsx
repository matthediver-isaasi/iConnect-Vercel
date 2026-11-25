import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Private (unlisted) event toggle. A private event stays fully active — direct
 * links, booking, emails and reports are unchanged — but is left out of the
 * /Events calendar, group event lists, site search and the sitemap. Canvas
 * page event widgets still show it so tenants can promote it on their own pages.
 */
export default function PrivateEventToggle({ checked, onCheckedChange }) {
  return (
    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
      <div className="space-y-0.5">
        <Label htmlFor="private-event-toggle" className="text-base font-medium">Private Event</Label>
        <p className="text-sm text-slate-500">
          {checked
            ? "Hidden from the Events calendar, group event lists, site search and sitemap. Still bookable from its direct link and shown in Canvas page event widgets."
            : "Listed on the Events calendar as normal."}
        </p>
      </div>
      <Switch
        id="private-event-toggle"
        checked={checked === true}
        onCheckedChange={onCheckedChange}
        data-testid="switch-is-private"
      />
    </div>
  );
}

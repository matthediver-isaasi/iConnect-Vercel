import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Per-event "Members can register others" setting. On (default) keeps the
 * normal booking form; off limits signed-in members to booking their own
 * place. Non-members and admin booking tools are not affected.
 */
export default function MembersRegisterOthersToggle({ checked, onCheckedChange }) {
  const allowed = checked !== false;
  return (
    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
      <div className="space-y-0.5">
        <Label htmlFor="members-register-others-toggle" className="text-base font-medium">Members can register others</Label>
        <p className="text-sm text-slate-500">
          {allowed
            ? "Members can add colleagues and external attendees to their booking."
            : "Members can only book their own place. Admin booking tools are unaffected."}
        </p>
      </div>
      <Switch
        id="members-register-others-toggle"
        checked={allowed}
        onCheckedChange={onCheckedChange}
        data-testid="switch-members-can-register-others"
      />
    </div>
  );
}

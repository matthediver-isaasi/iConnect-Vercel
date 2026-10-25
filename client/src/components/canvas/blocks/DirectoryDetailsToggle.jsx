import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

// Both Canvas directory presentations persist the same strict opt-in.
export default function DirectoryDetailsToggle({ content, onChange, testId }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-slate-600">Hover and click details</Label>
      <div className="flex items-center gap-2">
        <Switch checked={content.enableDetails === true} onCheckedChange={enableDetails => onChange({ enableDetails })}
          data-testid={testId} aria-label="Hover and click details" />
        <span className="text-xs text-slate-600">{content.enableDetails === true ? "On" : "Off"}</span>
      </div>
      <p className="text-[11px] text-slate-500">Enable directory card hover effects and detail dialogs in preview and on the published page. Directory visibility settings still apply.</p>
    </div>
  );
}

import { Switch } from "@/components/ui/switch";

export default function DirectoryFilterToggle({ label, checked, disabled, onCheckedChange }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={`Use ${label} as filter`}
      />
      <span>Use as filter</span>
    </label>
  );
}
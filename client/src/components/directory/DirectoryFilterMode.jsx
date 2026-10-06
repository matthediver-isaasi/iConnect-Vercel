export default function DirectoryFilterMode({ field, modes, disabled, onChange }) {
  if (!field || !["choice", "source-choice"].includes(field.control)) return null;
  return (
    <select
      aria-label={`${field.label} filter selection mode`}
      className="h-7 max-w-full rounded-md border border-slate-200 bg-background px-2 text-xs text-slate-700"
      value={modes[field.key] || (field.multi_select ? "multi" : "single")}
      disabled={disabled}
      onChange={event => onChange(field.key, event.target.value)}
    >
      <option value="single">Single selection</option>
      <option value="multi">Multiple selections</option>
    </select>
  );
}

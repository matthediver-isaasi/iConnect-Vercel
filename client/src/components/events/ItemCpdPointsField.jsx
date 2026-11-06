import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateItemCpdPoints } from "@/lib/itemCpdPoints";

export default function ItemCpdPointsField({ value, onChange, id, validationError, helperText }) {
  const error = validationError || validateItemCpdPoints(value);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">CPD points (optional)</Label>
      <Input id={id} type="text" inputMode="decimal" value={value ?? ''}
        placeholder="Leave blank for existing event CPD"
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        aria-invalid={!!error} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        data-testid={id} />
      <p id={`${id}-help`} className="text-xs text-slate-500">
        Blank keeps existing event CPD behaviour. Enter 0 for no points. Use up to 6 decimal places (maximum 10000).
        Setting points on any item replaces the event-wide award with awards for attended items only; points are not added on top.
        {helperText && <> {helperText}</>}
      </p>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

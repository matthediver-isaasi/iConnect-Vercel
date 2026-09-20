import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export const EVENT_PEOPLE_DISPLAY_MODES = Object.freeze({
  HIDDEN: "hidden",
  COLLAPSED: "collapsed",
  EXPANDED: "expanded",
});

const OPTIONS = [
  { value: EVENT_PEOPLE_DISPLAY_MODES.HIDDEN, label: "Hide on event registration page" },
  { value: EVENT_PEOPLE_DISPLAY_MODES.COLLAPSED, label: "Show but open collapsed" },
  { value: EVENT_PEOPLE_DISPLAY_MODES.EXPANDED, label: "Show and open expanded" },
];

export function normalizeEventPeopleDisplayMode(value) {
  return OPTIONS.some((option) => option.value === value)
    ? value
    : EVENT_PEOPLE_DISPLAY_MODES.EXPANDED;
}

export default function EventPeopleDisplayModeField({
  field,
  label,
  value,
  onChange,
}) {
  const normalizedValue = normalizeEventPeopleDisplayMode(value);

  return (
    <fieldset
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4"
      data-testid={`${field}-display-mode`}
    >
      <legend className="px-1 text-sm font-medium text-slate-800">
        {label} display
      </legend>
      <p className="text-xs text-slate-500">
        Choose how this section appears on the event registration page.
      </p>
      <RadioGroup
        value={normalizedValue}
        onValueChange={onChange}
        className="space-y-2"
        aria-label={`${label} display on event registration page`}
      >
        {OPTIONS.map((option) => {
          const id = `${field}-display-mode-${option.value}`;
          return (
            <div key={option.value} className="flex items-center gap-2">
              <RadioGroupItem
                id={id}
                value={option.value}
                data-testid={id}
              />
              <Label htmlFor={id} className="cursor-pointer font-normal">
                {option.label}
              </Label>
            </div>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}

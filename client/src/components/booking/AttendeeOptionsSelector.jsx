import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const toArray = (v) => (Array.isArray(v) ? v : []);

const SEVERITIES = [
  { value: "mild", label: "Mild" },
  { value: "moderate", label: "Moderate" },
  { value: "severe", label: "Severe" },
];

/**
 * Registrant-facing per-attendee selector for dietary requirements, allergies
 * (with a Mild/Moderate/Severe severity each) and accessibility needs.
 *
 * Reads the admin-defined option lists off `eventOptions`; any group with no
 * options is hidden. Renders nothing when no groups have options.
 *
 * @param {object} props
 * @param {object} props.eventOptions - { dietary_options, allergy_options, accessibility_options }
 * @param {object} props.value - { dietary_selections, allergy_selections, accessibility_selections }
 * @param {(value: object) => void} props.onChange
 * @param {string} [props.idPrefix] - unique prefix so multiple selectors on one page have unique ids
 */
export default function AttendeeOptionsSelector({
  eventOptions,
  value,
  onChange,
  idPrefix = "attendee",
}) {
  const opts = eventOptions || {};
  const dietaryOptions = toArray(opts.dietary_options);
  const allergyOptions = toArray(opts.allergy_options);
  const accessibilityOptions = toArray(opts.accessibility_options);

  const hasDietary = dietaryOptions.length > 0;
  const hasAllergy = allergyOptions.length > 0;
  const hasAccessibility = accessibilityOptions.length > 0;

  if (!hasDietary && !hasAllergy && !hasAccessibility) return null;

  const dietarySelections = toArray(value?.dietary_selections);
  const accessibilitySelections = toArray(value?.accessibility_selections);
  const allergySelections = toArray(value?.allergy_selections);

  const emit = (patch) => {
    onChange({
      dietary_selections: dietarySelections,
      allergy_selections: allergySelections,
      accessibility_selections: accessibilitySelections,
      ...patch,
    });
  };

  const toggleStringSelection = (key, current, option, checked) => {
    const next = checked
      ? [...current, option]
      : current.filter((v) => v !== option);
    emit({ [key]: next });
  };

  const toggleAllergy = (option, checked) => {
    const next = checked
      ? [...allergySelections, { name: option, severity: "mild" }]
      : allergySelections.filter((a) => a?.name !== option);
    emit({ allergy_selections: next });
  };

  const setAllergySeverity = (option, severity) => {
    const next = allergySelections.map((a) =>
      a?.name === option ? { ...a, severity } : a
    );
    emit({ allergy_selections: next });
  };

  const isAllergyChecked = (option) =>
    allergySelections.some((a) => a?.name === option);
  const allergySeverity = (option) =>
    allergySelections.find((a) => a?.name === option)?.severity || "mild";

  return (
    <div className="space-y-4" data-testid={`section-attendee-options-${idPrefix}`}>
      {hasDietary && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Dietary requirements</Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {dietaryOptions.map((option, i) => {
              const id = `${idPrefix}-dietary-${i}`;
              return (
                <div key={option} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={dietarySelections.includes(option)}
                    onCheckedChange={(checked) =>
                      toggleStringSelection("dietary_selections", dietarySelections, option, checked === true)
                    }
                    data-testid={`checkbox-${id}`}
                  />
                  <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
                    {option}
                  </Label>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hasAllergy && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Allergies</Label>
          <div className="space-y-2">
            {allergyOptions.map((option, i) => {
              const id = `${idPrefix}-allergy-${i}`;
              const checked = isAllergyChecked(option);
              return (
                <div key={option} className="flex items-center gap-2 flex-wrap">
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={(c) => toggleAllergy(option, c === true)}
                    data-testid={`checkbox-${id}`}
                  />
                  <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
                    {option}
                  </Label>
                  {checked && (
                    <Select
                      value={allergySeverity(option)}
                      onValueChange={(severity) => setAllergySeverity(option, severity)}
                    >
                      <SelectTrigger
                        className="h-8 w-32"
                        data-testid={`select-severity-${id}`}
                        aria-label={`Severity for ${option}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SEVERITIES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hasAccessibility && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Accessibility needs</Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {accessibilityOptions.map((option, i) => {
              const id = `${idPrefix}-accessibility-${i}`;
              return (
                <div key={option} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={accessibilitySelections.includes(option)}
                    onCheckedChange={(checked) =>
                      toggleStringSelection("accessibility_selections", accessibilitySelections, option, checked === true)
                    }
                    data-testid={`checkbox-${id}`}
                  />
                  <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
                    {option}
                  </Label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

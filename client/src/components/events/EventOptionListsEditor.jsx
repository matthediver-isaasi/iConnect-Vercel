import { Plus, Trash2, Utensils, Accessibility, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const toArray = (v) => (Array.isArray(v) ? v : []);

function OptionList({ label, description, options, onChange, placeholder, testPrefix }) {
  const items = toArray(options);

  const updateItem = (index, value) => {
    const next = [...items];
    next[index] = value;
    onChange(next);
  };

  const removeItem = (index) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const addItem = () => {
    onChange([...items, ""]);
  };

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-sm font-medium">{label}</Label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={item}
                onChange={(e) => updateItem(index, e.target.value)}
                placeholder={placeholder}
                maxLength={120}
                data-testid={`input-${testPrefix}-option-${index}`}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => removeItem(index)}
                aria-label={`Remove ${label} option`}
                data-testid={`button-remove-${testPrefix}-option-${index}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addItem}
        data-testid={`button-add-${testPrefix}-option`}
      >
        <Plus className="w-4 h-4 mr-1" />
        Add option
      </Button>
    </div>
  );
}

/**
 * Admin editor for the per-event option lists registrants choose from:
 *   - Dietary Requirements
 *   - Allergies (a subsection of Dietary; each selection gets a severity at booking)
 *   - Accessibility Needs
 *
 * Each list is a string[]. Empty lists mean the group is hidden from registrants.
 */
export default function EventOptionListsEditor({
  dietaryOptions,
  allergyOptions,
  accessibilityOptions,
  onDietaryChange,
  onAllergyChange,
  onAccessibilityChange,
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Utensils className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Dietary Requirements</h4>
        </div>
        <OptionList
          label="Dietary requirement options"
          description="Options registrants can select for each attendee (e.g. Vegetarian, Vegan, Halal). Leave empty to hide this section."
          options={dietaryOptions}
          onChange={onDietaryChange}
          placeholder="e.g. Vegetarian"
          testPrefix="dietary"
        />
        <div className="rounded-md border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Allergies</span>
          </div>
          <OptionList
            label="Allergy options"
            description="A subsection of dietary requirements. Registrants can select multiple allergies per attendee, each with a Mild / Moderate / Severe severity. Leave empty to hide."
            options={allergyOptions}
            onChange={onAllergyChange}
            placeholder="e.g. Nuts"
            testPrefix="allergy"
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Accessibility className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Accessibility Needs</h4>
        </div>
        <OptionList
          label="Accessibility need options"
          description="Options registrants can select for each attendee (e.g. Wheelchair access, Hearing loop). Leave empty to hide this section."
          options={accessibilityOptions}
          onChange={onAccessibilityChange}
          placeholder="e.g. Wheelchair access"
          testPrefix="accessibility"
        />
      </div>
    </div>
  );
}

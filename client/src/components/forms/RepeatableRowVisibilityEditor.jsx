import React, { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle } from "lucide-react";
import {
  repeatableRowVisibilityOptions,
  repeatableRowVisibilitySources,
  validateRepeatableRowVisibilityConfiguration,
} from "../../../../shared/formRepeatableRows.js";

const VISIBILITY_MODES = [
  { value: "always", label: "Always visible" },
  { value: "show_when", label: "Show when…" },
  { value: "hide_when", label: "Hide when…" },
];

const normaliseMode = (rowVisibility) => (
  rowVisibility?.mode === "show_when" || rowVisibility?.mode === "hide_when"
    ? rowVisibility.mode
    : "always"
);

const sourceLabel = (source) => source?.label || source?.name || "Untitled field";

/**
 * Edit the visibility rule for one child of a repeatable row.
 *
 * Visibility deliberately has its own small editor rather than reusing the
 * form-level visibility rules: these conditions are evaluated independently
 * for every row and can only read an eligible static, single-select sibling.
 */
export default function RepeatableRowVisibilityEditor({ field, child, onChange }) {
  const mode = normaliseMode(child?.row_visibility);
  const sources = useMemo(
    () => repeatableRowVisibilitySources(field, child) || [],
    [field, child],
  );
  const sourceId = child?.row_visibility?.source_field_id || "";
  const source = sources.find(item => String(item.id) === String(sourceId));
  const options = source ? (repeatableRowVisibilityOptions(source) || []) : [];
  const selectedValue = child?.row_visibility?.value;
  const hasSelectedOption = options.some(option => String(option.value) === String(selectedValue));
  const validationError = useMemo(
    () => validateRepeatableRowVisibilityConfiguration(field)
      .find(error => String(error?.child_id) === String(child?.id)),
    [field, child?.id],
  );

  const updateVisibility = (updates) => {
    const next = { ...(child?.row_visibility || {}), ...updates };
    if (next.mode === "always") {
      onChange(undefined);
      return;
    }
    onChange({
      mode: next.mode,
      source_field_id: next.source_field_id || "",
      value: next.value ?? "",
    });
  };

  return (
    <div
      className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3"
      data-testid={`repeatable-visibility-editor-${child?.id}`}
    >
      <div>
        <Label className="text-xs font-medium">Child visibility</Label>
        <p className="mt-0.5 text-xs text-slate-500">
          Conditions are evaluated separately in each row. Only a static,
          single-select Dropdown or Select from this row can be used as a source.
        </p>
      </div>
      <Select
        value={mode}
        onValueChange={nextMode => updateVisibility({ mode: nextMode })}
      >
        <SelectTrigger
          className="h-9"
          data-testid={`select-repeatable-visibility-mode-${child?.id}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VISIBILITY_MODES.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {mode !== "always" && (
        <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr] md:items-center">
          <Select
            value={source ? String(source.id) : (sourceId ? "__invalid_source__" : "")}
            onValueChange={nextSourceId => {
              if (nextSourceId === "__invalid_source__") return;
              const nextSource = sources.find(item => String(item.id) === String(nextSourceId));
              const nextOptions = nextSource ? (repeatableRowVisibilityOptions(nextSource) || []) : [];
              const nextValue = nextOptions.some(option => String(option.value) === String(selectedValue))
                ? selectedValue
                : "";
              updateVisibility({ source_field_id: nextSourceId, value: nextValue });
            }}
          >
            <SelectTrigger
              className="h-9"
              data-testid={`select-repeatable-visibility-source-${child?.id}`}
            >
              <SelectValue placeholder="Choose source field…" />
            </SelectTrigger>
            <SelectContent>
              {sourceId && !source && (
                <SelectItem value="__invalid_source__">
                  Unavailable source ({sourceId})
                </SelectItem>
              )}
              {sources.map(item => (
                <SelectItem key={item.id} value={String(item.id)}>
                  {sourceLabel(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-slate-500">equals</span>
          <Select
            value={hasSelectedOption ? String(selectedValue) : ""}
            onValueChange={value => updateVisibility({ value })}
            disabled={!source}
          >
            <SelectTrigger
              className="h-9"
              data-testid={`select-repeatable-visibility-value-${child?.id}`}
            >
              <SelectValue placeholder={source ? "Choose option…" : "Choose a source first"} />
            </SelectTrigger>
            <SelectContent>
              {options.map(option => (
                <SelectItem key={String(option.value)} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {validationError && (
        <p
          className="flex items-center gap-1 text-xs text-red-700"
          role="alert"
          data-testid={`repeatable-visibility-guidance-${child?.id}`}
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {validationError.message || "Choose an eligible source and one of its options before saving."}
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import OrganisationDirectorySourceChoice from "@/components/directory/OrganisationDirectorySourceChoice";

function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function TextFilter({ field, filter, onChange }) {
  const [value, setValue] = useState(filter?.value ?? "");
  const [operator, setOperator] = useState(filter?.operator || "contains");
  const debounced = useDebouncedValue(value);
  useEffect(() => setValue(filter?.value ?? ""), [filter?.value]);
  useEffect(() => {
    if (filter?.operator) setOperator(filter.operator);
  }, [filter?.operator]);
  useEffect(() => {
    if (operator === "present" || operator === "absent") return;
    if (debounced === (filter?.value ?? "") && operator === (filter?.operator || "contains")) return;
    onChange(debounced === "" ? null : { operator, value: debounced });
  }, [debounced, operator, filter?.operator, filter?.value, onChange]);
  const changeOperator = (next) => {
    setOperator(next);
    if (next === "present" || next === "absent") onChange({ operator: next, value: true });
    else onChange(value === "" ? null : { operator: next, value });
  };
  return (
    <div className="flex gap-2">
      <select
        aria-label={`${field.label} operator`}
        className="h-10 rounded-md border border-input bg-background px-2 text-sm"
        value={operator}
        onChange={(event) => changeOperator(event.target.value)}
      >
        <option value="contains">Contains</option>
        <option value="eq">Equals</option>
        <option value="present">Present</option>
        <option value="absent">Absent</option>
      </select>
      {operator !== "present" && operator !== "absent" && (
        <Input aria-label={field.label} value={value} onChange={(event) => setValue(event.target.value)} />
      )}
    </div>
  );
}

function RangeFilter({ field, filter, onChange }) {
  const [operator, setOperator] = useState(filter?.operator || "eq");
  const [draft, setDraft] = useState(() => (
    Array.isArray(filter?.value) ? filter.value.map(String) : [filter?.value ?? "", ""]
  ));
  useEffect(() => {
    if (filter?.operator) setOperator(filter.operator);
  }, [filter?.operator]);
  useEffect(() => {
    if (filter?.value === undefined) return;
    setDraft(Array.isArray(filter.value)
      ? [String(filter.value[0] ?? ""), String(filter.value[1] ?? "")]
      : [String(filter.value), ""]);
  }, [filter?.value]);
  const type = field.control === "date" ? "date" : "number";
  const validValue = (value) => value !== "" && (type === "date" || Number.isFinite(Number(value)));
  const emitDraft = (nextOperator, nextDraft) => {
    if (nextOperator === "present" || nextOperator === "absent") {
      onChange({ operator: nextOperator, value: true });
      return;
    }
    if (nextOperator === "between") {
      const lower = type === "number" ? Number(nextDraft[0]) : nextDraft[0];
      const upper = type === "number" ? Number(nextDraft[1]) : nextDraft[1];
      if (!validValue(nextDraft[0]) || !validValue(nextDraft[1]) || lower > upper) {
        onChange(null);
        return;
      }
      onChange({ operator: nextOperator, value: [nextDraft[0], nextDraft[1]] });
      return;
    }
    onChange(validValue(nextDraft[0]) ? { operator: nextOperator, value: nextDraft[0] } : null);
  };
  const updateOperator = (next) => {
    setOperator(next);
    emitDraft(next, draft);
  };
  const updateValue = (index, value) => {
    const next = [...draft];
    next[index] = value;
    setDraft(next);
    emitDraft(operator, next);
  };
  return (
    <div className="flex gap-2">
      <select
        aria-label={`${field.label} operator`}
        className="h-10 rounded-md border border-input bg-background px-2 text-sm"
        value={operator}
        onChange={(event) => updateOperator(event.target.value)}
      >
        <option value="eq">Equals</option>
        <option value="gte">At least</option>
        <option value="lte">At most</option>
        <option value="between">Between</option>
        <option value="present">Present</option>
        <option value="absent">Absent</option>
      </select>
      {operator !== "present" && operator !== "absent" && (
        <Input type={type} aria-label={field.label} value={draft[0]} onChange={(event) => updateValue(0, event.target.value)} />
      )}
      {operator === "between" && (
        <Input type={type} aria-label={`${field.label} maximum`} value={draft[1]} onChange={(event) => updateValue(1, event.target.value)} />
      )}
      {operator === "between" && validValue(draft[0]) && validValue(draft[1])
        && (type === "number" ? Number(draft[0]) > Number(draft[1]) : draft[0] > draft[1]) && (
        <span role="alert" className="text-xs text-red-600">Minimum must not exceed maximum</span>
      )}
    </div>
  );
}

export default function OrganisationDirectoryFilters({ fields, filters, onChange, onClear }) {
  const [clearEpoch, setClearEpoch] = useState(0);
  const setField = (key, value) => {
    const next = { ...filters };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  if (!fields.length) return null;
  return (
    <div className="flex flex-wrap items-end gap-4 pt-3 border-t border-slate-200">
      {fields.map((field) => {
        const filter = filters[field.key];
        return (
          <div key={`${field.key}:${clearEpoch}`} className="space-y-1 min-w-[200px]">
            <label className="block text-sm font-medium text-slate-700">{field.label}</label>
            {field.control === "source-choice" ? (
              <OrganisationDirectorySourceChoice
                field={field}
                selected={Array.isArray(filter?.value) ? filter.value : []}
                onChange={(value) => setField(field.key, value.length ? { operator: "eq", value } : null)}
              />
            ) : field.control === "choice" && field.multi_select ? (
              <MultiSelectFilter
                options={field.options || []}
                selected={Array.isArray(filter?.value) ? filter.value : []}
                onChange={(value) => setField(field.key, value.length ? { operator: "eq", value } : null)}
                placeholder={`All ${field.label}`}
                className="w-full"
                data-testid={`filter-${field.key}`}
              />
            ) : field.control === "choice" ? (
              <select
                aria-label={field.label}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={Array.isArray(filter?.value) ? (filter.value[0] || "") : ""}
                onChange={(event) => setField(field.key, event.target.value === "" ? null : { operator: "eq", value: [event.target.value] })}
              >
                <option value="">All</option>
                {(field.options || []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : field.control === "presence" ? (
              <select
                aria-label={field.label}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={filter?.operator || ""}
                onChange={(event) => setField(field.key, event.target.value ? { operator: event.target.value, value: true } : null)}
              >
                <option value="">Any</option>
                <option value="present">Present</option>
                <option value="absent">Absent</option>
              </select>
            ) : field.control === "number" || field.control === "date" ? (
              <RangeFilter field={field} filter={filter} onChange={(value) => setField(field.key, value)} />
            ) : (
              <TextFilter field={field} filter={filter} onChange={(value) => setField(field.key, value)} />
            )}
          </div>
        );
      })}
      {Object.keys(filters).length > 0 && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            // Remount draft controls first so pending debounce timers are
            // cancelled and cannot restore a filter after the global clear.
            setClearEpoch(epoch => epoch + 1);
            onClear();
          }}
        >
          Clear all
        </Button>
      )}
    </div>
  );
}
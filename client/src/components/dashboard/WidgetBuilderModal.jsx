import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Loader2, Plus, Trash2 } from "lucide-react";
// Recharts + chart container primitives — used by the inline preview body.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

const CHART_COLOURS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

const WIDGET_TYPES = [
  { value: "stat", label: "Stat / KPI" },
  { value: "bar", label: "Bar chart" },
  { value: "pie", label: "Pie chart" },
  { value: "donut", label: "Donut chart" },
  { value: "line", label: "Line chart" },
];

const WIDTHS = [
  { value: "fifth", label: "1/5" },
  { value: "third", label: "1/3" },
  { value: "half", label: "1/2" },
  { value: "full", label: "Full" },
];

const AGGREGATORS = [
  { value: "count", label: "Count" },
  { value: "count_distinct", label: "Count distinct" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
];

const TIME_GRANULARITIES = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

const FILTER_OPERATORS = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "in", label: "is one of" },
  { value: "gt", label: "is greater than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "is_null", label: "is empty" },
  { value: "is_not_null", label: "is not empty" },
];

// Operators that operate on the saved tenant value list rather than a
// user-entered value — currently just "LMIC only", which expands at
// query time to `country IN (tenant LMIC list)`.
const TENANT_LIST_OPERATORS = [
  { value: "lmic", label: "LMIC only (tenant list)" },
];

// A field is considered country-shaped (and so eligible for the LMIC
// operator) when its name or label contains "country". This deliberately
// matches both the system `country` column and any custom country
// preference field admins may have created.
function isCountryField(option) {
  if (!option) return false;
  const haystack = `${option.field || ""} ${option.label || ""}`.toLowerCase();
  return haystack.includes("country");
}

const COLOUR_OPTIONS = [
  { value: "default", label: "Default", swatch: "hsl(var(--chart-1))" },
  { value: "emerald", label: "Emerald", swatch: "hsl(var(--chart-2))" },
  { value: "amber", label: "Amber", swatch: "hsl(var(--chart-3))" },
  { value: "violet", label: "Violet", swatch: "hsl(var(--chart-4))" },
  { value: "rose", label: "Rose", swatch: "hsl(var(--chart-5))" },
];

const DEFAULT_DRAFT = {
  title: "",
  widget_type: "stat",
  width: "third",
  scope: "personal",
  config: {
    source: "organization",
    color: "default",
    measure: { aggregator: "count", field: null, fieldKind: null, fieldId: null },
    groupBy: null,
    timeBucket: null,
    filters: [],
  },
};

function cloneDraft(draft) {
  return JSON.parse(JSON.stringify(draft));
}

function buildFieldOptions(source) {
  if (!source) return [];
  const system = (source.systemFields || []).map(f => ({
    value: `system:${f.name}`,
    label: f.label,
    fieldKind: "system",
    field: f.name,
    fieldId: null,
    type: f.type,
    aggregatable: !!f.aggregatable,
  }));
  const custom = (source.customFields || []).map(f => ({
    value: `custom:${f.id}`,
    label: `${f.label} (custom)`,
    fieldKind: "custom",
    field: null,
    fieldId: f.id,
    type: f.type,
    aggregatable: !!f.aggregatable,
  }));
  return [...system, ...custom];
}

export default function WidgetBuilderModal({
  open,
  onClose,
  onSave,
  initialWidget = null,
  prefillWidget = null,
  defaultScope = "personal",
  canSaveShared = false,
  canSavePersonal = true,
  isSaving = false,
}) {
  const [draft, setDraft] = useState(() => cloneDraft(DEFAULT_DRAFT));
  const [previewData, setPreviewData] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Reset draft whenever the modal opens. `prefillWidget` (used by
  // Duplicate) seeds a brand-new draft from another widget's config without
  // flipping the modal into "edit" mode — only `initialWidget` controls
  // that. If both are provided, `initialWidget` wins.
  useEffect(() => {
    if (!open) return;
    const seed = initialWidget || prefillWidget;
    if (seed) {
      setDraft({
        title: seed.title,
        widget_type: seed.widget_type,
        width: seed.width || "third",
        scope: seed.scope,
        config: {
          source: seed.config?.source || "organization",
          color: seed.config?.color || "default",
          measure: seed.config?.measure || cloneDraft(DEFAULT_DRAFT).config.measure,
          groupBy: seed.config?.groupBy || null,
          timeBucket: seed.config?.timeBucket || null,
          filters: seed.config?.filters || [],
        },
      });
    } else {
      setDraft({
        ...cloneDraft(DEFAULT_DRAFT),
        scope: defaultScope === "shared" && canSaveShared ? "shared" : "personal",
      });
    }
    setPreviewData(null);
    setPreviewError(null);
  }, [open, initialWidget, prefillWidget, defaultScope, canSaveShared]);

  const { data: sourcesPayload } = useQuery({
    queryKey: ["/api/dashboard/sources"],
    enabled: open,
    queryFn: async () => {
      const res = await fetch("/api/dashboard/sources", { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body;
    },
  });
  const sources = sourcesPayload?.sources || [];
  const currentSource = sources.find(s => s.id === draft.config.source) || null;
  const fieldOptions = useMemo(() => buildFieldOptions(currentSource), [currentSource]);

  // Debounced preview.
  useEffect(() => {
    if (!open) return;
    setPreviewError(null);
    if (!draft.config.source) return;

    const handle = setTimeout(async () => {
      try {
        setPreviewLoading(true);
        const res = await fetch("/api/dashboard/widgets/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ config: draft.config }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || "Preview failed");
        }
        setPreviewData(body.data);
        setPreviewError(null);
      } catch (err) {
        setPreviewError(err.message);
        setPreviewData(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 350);

    return () => clearTimeout(handle);
  }, [draft.config, open]);

  const updateConfig = patch => {
    setDraft(prev => ({ ...prev, config: { ...prev.config, ...patch } }));
  };

  const updateMeasure = patch => {
    setDraft(prev => ({
      ...prev,
      config: { ...prev.config, measure: { ...prev.config.measure, ...patch } },
    }));
  };

  const updateFilter = (index, patch) => {
    setDraft(prev => {
      const filters = [...(prev.config.filters || [])];
      filters[index] = { ...filters[index], ...patch };
      return { ...prev, config: { ...prev.config, filters } };
    });
  };

  const addFilter = () => {
    setDraft(prev => ({
      ...prev,
      config: {
        ...prev.config,
        filters: [
          ...(prev.config.filters || []),
          { fieldKind: "system", field: null, fieldId: null, operator: "eq", value: "" },
        ],
      },
    }));
  };

  const removeFilter = idx => {
    setDraft(prev => ({
      ...prev,
      config: {
        ...prev.config,
        filters: (prev.config.filters || []).filter((_, i) => i !== idx),
      },
    }));
  };

  // Only plain "count" allows a null field; count_distinct and the
  // numeric aggregators all require one.
  const requireMeasureField = draft.config.measure.aggregator !== "count";

  // Derived validation: surfaces inline errors and gates the Save button so
  // the user can never submit a configuration that would fail to render.
  const validationErrors = useMemo(() => {
    const errs = [];
    if (!draft.title.trim()) errs.push("Add a widget title.");
    if (!draft.config.source) errs.push("Choose a data source.");
    if (requireMeasureField && !draft.config.measure.field && !draft.config.measure.fieldId) {
      const agg = draft.config.measure.aggregator;
      const reqText = agg === "count_distinct" ? "needs a field" : "needs a numeric field";
      errs.push(`${agg} ${reqText}.`);
    }
    if (draft.config.groupBy && draft.config.timeBucket?.field) {
      errs.push("Pick either group-by or a time bucket, not both.");
    }
    if (draft.widget_type === "line" && !draft.config.timeBucket?.field) {
      errs.push("Line charts need a time bucket field.");
    }
    if (
      ["bar", "pie"].includes(draft.widget_type) &&
      !draft.config.groupBy &&
      !draft.config.timeBucket?.field
    ) {
      errs.push("Bar and pie charts need a group-by or time bucket.");
    }
    (draft.config.filters || []).forEach((f, i) => {
      if (!f.field && !f.fieldId) errs.push(`Filter ${i + 1}: choose a field.`);
      if (f.operator === "in") {
        const list = Array.isArray(f.value)
          ? f.value
          : String(f.value || "").split(",").map(s => s.trim()).filter(Boolean);
        if (list.length === 0) errs.push(`Filter ${i + 1}: list cannot be empty.`);
      } else if (
        !["is_null", "is_not_null", "lmic"].includes(f.operator) &&
        (f.value === null || f.value === undefined || f.value === "")
      ) {
        errs.push(`Filter ${i + 1}: enter a value.`);
      }
    });
    return errs;
  }, [draft, requireMeasureField]);

  const canSave = validationErrors.length === 0;

  const handleSave = () => {
    if (!canSave) return;
    // Normalise `in` filter values to arrays before persisting.
    const normalisedFilters = (draft.config.filters || []).map(f => {
      if (f.operator === "in" && !Array.isArray(f.value)) {
        return {
          ...f,
          value: String(f.value || "").split(",").map(s => s.trim()).filter(Boolean),
        };
      }
      return f;
    });
    onSave({
      title: draft.title.trim(),
      widget_type: draft.widget_type,
      width: draft.width,
      scope: draft.scope,
      config: { ...draft.config, filters: normalisedFilters },
    });
  };

  const previewWidget = useMemo(
    () => ({
      id: "__preview__",
      title: draft.title || "Preview",
      widget_type: draft.widget_type,
      width: draft.width,
      config: draft.config,
    }),
    [draft],
  );

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose?.()}>
      <DialogContent
        className="max-h-[90vh] max-w-5xl overflow-y-auto"
        data-testid="dialog-widget-builder"
      >
        <DialogHeader>
          <DialogTitle>{initialWidget ? "Edit widget" : "New widget"}</DialogTitle>
          <DialogDescription>
            Compose a chart or stat from your organisation and member data.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Builder */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="widget-title">Title</Label>
              <Input
                id="widget-title"
                value={draft.title}
                onChange={e => setDraft(prev => ({ ...prev, title: e.target.value }))}
                placeholder="My new chart"
                data-testid="input-widget-title"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Chart type</Label>
                <Select
                  value={draft.widget_type}
                  onValueChange={value => setDraft(prev => ({ ...prev, widget_type: value }))}
                >
                  <SelectTrigger data-testid="select-widget-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WIDGET_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Width</Label>
                <Select
                  value={draft.width}
                  onValueChange={value => setDraft(prev => ({ ...prev, width: value }))}
                >
                  <SelectTrigger data-testid="select-widget-width">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WIDTHS.map(w => (
                      <SelectItem key={w.value} value={w.value}>
                        {w.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Colour</Label>
              <div className="flex flex-wrap gap-2" data-testid="widget-colour-options">
                {COLOUR_OPTIONS.map(opt => {
                  const selected = (draft.config.color || "default") === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-label={opt.label}
                      aria-pressed={selected}
                      onClick={() => updateConfig({ color: opt.value })}
                      data-testid={`button-widget-colour-${opt.value}`}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover-elevate",
                        selected && "border-primary",
                      )}
                    >
                      <span
                        className="h-3 w-3 rounded-sm"
                        style={{ backgroundColor: opt.swatch }}
                      />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {(canSaveShared || canSavePersonal) && (
              <div className="space-y-2">
                <Label>Visibility</Label>
                <RadioGroup
                  value={draft.scope}
                  onValueChange={value => setDraft(prev => ({ ...prev, scope: value }))}
                  className="flex flex-wrap gap-3"
                >
                  {canSavePersonal && (
                    <Label
                      htmlFor="scope-personal"
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2"
                    >
                      <RadioGroupItem
                        id="scope-personal"
                        value="personal"
                        data-testid="radio-scope-personal"
                      />
                      Just me
                    </Label>
                  )}
                  {canSaveShared && (
                    <Label
                      htmlFor="scope-shared"
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2"
                    >
                      <RadioGroupItem
                        id="scope-shared"
                        value="shared"
                        data-testid="radio-scope-shared"
                      />
                      Everyone in this organisation
                    </Label>
                  )}
                </RadioGroup>
              </div>
            )}

            <Separator />

            <div className="space-y-2">
              <Label>Data source</Label>
              <Select
                value={draft.config.source}
                onValueChange={value =>
                  setDraft(prev => ({
                    ...prev,
                    config: {
                      source: value,
                      measure: { aggregator: "count", field: null, fieldKind: null, fieldId: null },
                      groupBy: null,
                      timeBucket: null,
                      filters: [],
                    },
                  }))
                }
              >
                <SelectTrigger data-testid="select-widget-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sources.map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Aggregation</Label>
                <Select
                  value={draft.config.measure.aggregator}
                  onValueChange={value => updateMeasure({ aggregator: value })}
                >
                  <SelectTrigger data-testid="select-widget-aggregator">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AGGREGATORS.map(a => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Field</Label>
                <Select
                  value={
                    draft.config.measure.fieldKind
                      ? `${draft.config.measure.fieldKind}:${
                          draft.config.measure.field || draft.config.measure.fieldId
                        }`
                      : ""
                  }
                  disabled={!requireMeasureField && draft.config.measure.aggregator === "count"}
                  onValueChange={value => {
                    const opt = fieldOptions.find(o => o.value === value);
                    if (!opt) return;
                    updateMeasure({
                      fieldKind: opt.fieldKind,
                      field: opt.field,
                      fieldId: opt.fieldId,
                    });
                  }}
                >
                  <SelectTrigger data-testid="select-widget-field">
                    <SelectValue
                      placeholder={
                        draft.config.measure.aggregator === "count"
                          ? "(records)"
                          : "Select field"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {fieldOptions
                      .filter(opt => {
                        // count / count_distinct accept any field type
                        // (e.g. count_distinct on country); numeric
                        // aggregators are restricted to aggregatable fields.
                        const agg = draft.config.measure.aggregator;
                        if (agg === 'count' || agg === 'count_distinct') return true;
                        return opt.aggregatable;
                      })
                      .map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Group by</Label>
              <Select
                value={
                  draft.config.groupBy
                    ? `${draft.config.groupBy.kind}:${
                        draft.config.groupBy.field || draft.config.groupBy.fieldId
                      }`
                    : "__none__"
                }
                onValueChange={value => {
                  if (value === "__none__") {
                    updateConfig({ groupBy: null });
                    return;
                  }
                  const opt = fieldOptions.find(o => o.value === value);
                  if (!opt) return;
                  updateConfig({
                    groupBy: { kind: opt.fieldKind, field: opt.field, fieldId: opt.fieldId },
                    timeBucket: null,
                  });
                }}
              >
                <SelectTrigger data-testid="select-widget-groupby">
                  <SelectValue placeholder="No grouping" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No grouping</SelectItem>
                  {fieldOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Time bucket — date field</Label>
                <Select
                  value={(() => {
                    // Re-derive the option key (system:<name> or
                    // custom:<id>) from the saved config so existing
                    // widgets — including seeded ones that bucket on
                    // a custom date field like member.go_live —
                    // prefill correctly when re-opened in the builder.
                    const tb = draft.config.timeBucket;
                    if (!tb?.field && !tb?.fieldId) return "__none__";
                    if (tb.fieldKind === "custom" && tb.fieldId) {
                      return `custom:${tb.fieldId}`;
                    }
                    return `system:${tb.field}`;
                  })()}
                  onValueChange={value => {
                    if (value === "__none__") {
                      updateConfig({ timeBucket: null });
                      return;
                    }
                    const opt = fieldOptions.find(o => o.value === value);
                    if (!opt) return;
                    updateConfig({
                      timeBucket: {
                        // Persist all three keys so the engine can
                        // hydrate via the preference store for custom
                        // date fields and read directly off the row
                        // for system date columns.
                        field: opt.field || opt.fieldId,
                        fieldKind: opt.fieldKind,
                        fieldId: opt.fieldId,
                        granularity: draft.config.timeBucket?.granularity || "month",
                      },
                      groupBy: null,
                    });
                  }}
                >
                  <SelectTrigger data-testid="select-widget-timebucket-field">
                    <SelectValue placeholder="No bucket" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No bucket</SelectItem>
                    {fieldOptions
                      .filter(opt => opt.type === "date")
                      .map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Granularity</Label>
                <Select
                  value={draft.config.timeBucket?.granularity || "month"}
                  onValueChange={value =>
                    updateConfig({
                      timeBucket: draft.config.timeBucket
                        ? { ...draft.config.timeBucket, granularity: value }
                        : null,
                    })
                  }
                  disabled={!draft.config.timeBucket?.field}
                >
                  <SelectTrigger data-testid="select-widget-timebucket-granularity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_GRANULARITIES.map(g => (
                      <SelectItem key={g.value} value={g.value}>
                        {g.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Filters</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addFilter}
                  data-testid="button-add-filter"
                >
                  <Plus className="mr-1 h-4 w-4" /> Add filter
                </Button>
              </div>
              {(draft.config.filters || []).length === 0 && (
                <p className="text-xs text-muted-foreground">No filters applied.</p>
              )}
              <div className="space-y-2">
                {(draft.config.filters || []).map((filter, idx) => {
                  const opt = fieldOptions.find(o =>
                    filter.fieldKind === "system"
                      ? o.fieldKind === "system" && o.field === filter.field
                      : o.fieldKind === "custom" && o.fieldId === filter.fieldId,
                  );
                  return (
                    <div
                      key={idx}
                      className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
                      data-testid={`filter-row-${idx}`}
                    >
                      <Select
                        value={opt?.value || ""}
                        onValueChange={value => {
                          const sel = fieldOptions.find(o => o.value === value);
                          if (!sel) return;
                          updateFilter(idx, {
                            fieldKind: sel.fieldKind,
                            field: sel.field,
                            fieldId: sel.fieldId,
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Field" />
                        </SelectTrigger>
                        <SelectContent>
                          {fieldOptions.map(o => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={filter.operator}
                        onValueChange={value => {
                          // Tenant-list operators (e.g. LMIC) ignore the
                          // user-entered value, so clear it on switch to
                          // avoid stale values being re-sent on save.
                          const patch = { operator: value };
                          if (TENANT_LIST_OPERATORS.some(o => o.value === value)) {
                            patch.value = null;
                          }
                          updateFilter(idx, patch);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FILTER_OPERATORS.map(op => (
                            <SelectItem key={op.value} value={op.value}>
                              {op.label}
                            </SelectItem>
                          ))}
                          {isCountryField(opt) &&
                            TENANT_LIST_OPERATORS.map(op => (
                              <SelectItem key={op.value} value={op.value}>
                                {op.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      {!["is_null", "is_not_null", "lmic"].includes(filter.operator) ? (
                        <Input
                          value={
                            Array.isArray(filter.value)
                              ? filter.value.join(", ")
                              : filter.value ?? ""
                          }
                          onChange={e => updateFilter(idx, { value: e.target.value })}
                          placeholder={
                            filter.operator === "in"
                              ? "value1, value2, value3"
                              : filter.operator === "contains"
                                ? "Substring"
                                : "Value"
                          }
                          data-testid={`input-filter-value-${idx}`}
                        />
                      ) : (
                        <div />
                      )}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeFilter(idx)}
                        aria-label="Remove filter"
                        data-testid={`button-remove-filter-${idx}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <Label>Live preview</Label>
            <div
              className="rounded-md border bg-muted/30 p-3"
              data-testid="widget-preview-pane"
            >
              {previewLoading && !previewData && (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-32 w-full" />
                </div>
              )}
              {previewError && (
                <p className="text-sm text-destructive">{previewError}</p>
              )}
              {!previewError && (
                <PreviewWidget widget={previewWidget} payload={previewData} />
              )}
            </div>
          </div>
        </div>

        {validationErrors.length > 0 && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            data-testid="widget-validation-errors"
          >
            <p className="mb-1 font-medium">Fix these before saving:</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {validationErrors.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} data-testid="button-cancel-widget">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || !canSave}
            data-testid="button-save-widget"
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {initialWidget ? "Save changes" : "Create widget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewWidget({ widget, payload }) {
  // Reuse WidgetCard rendering by injecting fake query data via a thin wrapper.
  // The card component fetches data on its own; in preview we render a minimal
  // version using the same body components inline for instant updates.
  if (!payload) {
    return (
      <p className="text-sm text-muted-foreground">
        Preview will appear here once the configuration is valid.
      </p>
    );
  }
  return (
    <PreviewBody widget={widget} payload={payload} />
  );
}

function PreviewBody({ widget, payload }) {
  const rows = payload.rows || [];
  switch (widget.widget_type) {
    case "stat": {
      const value = payload.type === "scalar" ? payload.value : rows[0]?.value;
      return (
        <div className="space-y-1">
          <p className="text-3xl font-semibold tracking-tight">
            {value === null || value === undefined ? "—" : Number(value).toLocaleString()}
          </p>
          <p className="text-xs uppercase text-muted-foreground">
            {widget.config.measure?.aggregator || "count"} · {payload.total ?? 0} record
            {payload.total === 1 ? "" : "s"}
          </p>
        </div>
      );
    }
    case "bar":
      if (rows.length === 0) return <EmptyPreview />;
      return (
        <ChartContainer
          config={{ value: { label: "Value", color: CHART_COLOURS[0] } }}
          className="h-56 w-full"
        >
          <BarChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 30 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="key" tickLine={false} axisLine={false} angle={-25} textAnchor="end" height={50} interval={0} />
            <YAxis tickLine={false} axisLine={false} width={40} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="value" fill={CHART_COLOURS[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartContainer>
      );
    case "line":
      if (rows.length === 0) return <EmptyPreview />;
      return (
        <ChartContainer
          config={{ value: { label: "Value", color: CHART_COLOURS[0] } }}
          className="h-56 w-full"
        >
          <LineChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="key" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} width={40} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line type="monotone" dataKey="value" stroke={CHART_COLOURS[0]} strokeWidth={2} dot={false} />
          </LineChart>
        </ChartContainer>
      );
    case "pie":
    case "donut":
      if (rows.length === 0) return <EmptyPreview />;
      return (
        <ChartContainer
          config={Object.fromEntries(
            rows.map((r, i) => [
              r.key,
              { label: r.key, color: CHART_COLOURS[i % CHART_COLOURS.length] },
            ]),
          )}
          className="h-56 w-full"
        >
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey="key" />} />
            <Pie
              data={rows}
              dataKey="value"
              nameKey="key"
              innerRadius={widget.widget_type === "donut" ? 50 : 0}
              outerRadius={80}
              paddingAngle={widget.widget_type === "donut" ? 2 : 0}
            >
              {rows.map((row, idx) => (
                <Cell key={row.key} fill={CHART_COLOURS[idx % CHART_COLOURS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
      );
    default:
      return <EmptyPreview />;
  }
}

function EmptyPreview() {
  return (
    <p className="text-sm text-muted-foreground">No data to plot for this configuration yet.</p>
  );
}

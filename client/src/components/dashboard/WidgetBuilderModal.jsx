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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ChevronsUpDown, Loader2, Plus, Trash2 } from "lucide-react";
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
import { formatNumber } from "@/components/dashboard/WidgetCard";

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
  { value: "list", label: "List" },
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
// operator) when its name or label contains "country" or the plural
// "countries". This deliberately matches both the system `country`
// column, single-pick custom country preference fields, and plural
// list-typed fields like `countries_of_operation`.
function isCountryField(option) {
  if (!option) return false;
  const haystack = `${option.field || ""} ${option.label || ""}`.toLowerCase();
  return haystack.includes("country") || haystack.includes("countries");
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
    // DD-only stage-transition mode; null for every other source.
    transition: null,
    // Form-conversion only; null for every other source.
    conversion: null,
    // Stat/KPI-only number format; null = legacy compact style (1.5M).
    numberFormat: null,
    filters: [],
  },
};

function cloneDraft(draft) {
  return JSON.parse(JSON.stringify(draft));
}

// Old widgets stored a single conversion targetFormId; normalise either
// shape to a `targetFormIds` list when seeding the draft.
function normalizeConversion(conv) {
  if (!conv) return null;
  const targetFormIds = Array.isArray(conv.targetFormIds)
    ? conv.targetFormIds.filter(Boolean)
    : conv.targetFormId
      ? [conv.targetFormId]
      : [];
  return {
    sourceFormId: conv.sourceFormId || null,
    targetFormIds,
    matchBy: conv.matchBy === "member" ? "member" : "organization",
  };
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
    options: Array.isArray(f.options) ? f.options : null,
    // DD-only synthetic date dimension ("Date moved to stage …") needs a
    // stage picked alongside it; carry the marker + canonical stage list.
    stageField: !!f.stageField,
    stageOptions: Array.isArray(f.stageOptions) ? f.stageOptions : null,
    // Derived dimensions (e.g. organisation Region) have no stored column
    // and are only valid as a Group-by — the measure and filter pickers
    // exclude them.
    groupOnly: !!f.groupOnly,
    // Derived Region dimension: available classification schemes (app /
    // World Bank), each with its own bucket list. Drives the scheme
    // picker rendered under the Group-by select.
    regionSchemes: Array.isArray(f.regionSchemes) ? f.regionSchemes : null,
  }));
  const custom = (source.customFields || []).map(f => ({
    value: `custom:${f.id}`,
    label: `${f.label} (custom)`,
    fieldKind: "custom",
    field: null,
    fieldId: f.id,
    type: f.type,
    aggregatable: !!f.aggregatable,
    options: Array.isArray(f.options) ? f.options : null,
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
          cumulative: !!seed.config?.cumulative,
          transition: seed.config?.transition || null,
          conversion: normalizeConversion(seed.config?.conversion),
          numberFormat: seed.config?.numberFormat || null,
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

  // DD stage-transition capability (surfaced via the source's `isDd` flag so
  // we don't hard-code the source id here). The From/To pickers reuse the
  // canonical DD status list already published on the `workflow_status` field.
  const isDdSource = !!currentSource?.isDd;
  const transition = draft.config.transition || null;
  const transitionActive = isDdSource && !!transition?.mode;

  // Form-conversion capability (surfaced via the source's `isConversion`
  // flag). The source/target pickers use the tenant's forms published on
  // the source descriptor. Conversion widgets always render as a stat.
  const isConversionSource = !!currentSource?.isConversion;
  const conversion = draft.config.conversion || null;
  const conversionForms = currentSource?.forms || [];
  const ddStageOptions = useMemo(() => {
    const f = (currentSource?.systemFields || []).find(s => s.name === "workflow_status");
    return Array.isArray(f?.options) ? f.options : [];
  }, [currentSource]);

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
          body: JSON.stringify({ config: draft.config, widgetType: draft.widget_type }),
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
  }, [draft.config, draft.widget_type, open]);

  const updateConfig = patch => {
    setDraft(prev => ({ ...prev, config: { ...prev.config, ...patch } }));
  };

  const updateMeasure = patch => {
    setDraft(prev => ({
      ...prev,
      config: { ...prev.config, measure: { ...prev.config.measure, ...patch } },
    }));
  };

  // Toggle DD stage-transition mode on/off. Turning it on forces a count
  // measure (transitions are event counts), clears group-by / time-bucket
  // (they don't apply), and defaults to the breakdown bar chart. Turning it
  // off restores a plain count widget.
  const setTransitionEnabled = on => {
    setDraft(prev => {
      if (on) {
        return {
          ...prev,
          widget_type: "bar",
          config: {
            ...prev.config,
            transition: { mode: "breakdown", fromStage: null, toStage: null },
            measure: { aggregator: "count", field: null, fieldKind: null, fieldId: null },
            groupBy: null,
            timeBucket: null,
            cumulative: false,
          },
        };
      }
      return { ...prev, config: { ...prev.config, transition: null } };
    });
  };

  // Breakdown -> bar (one bar per "From → To"); single -> stat (one count).
  const setTransitionMode = mode => {
    setDraft(prev => ({
      ...prev,
      widget_type: mode === "single" ? "stat" : "bar",
      config: {
        ...prev.config,
        transition: { ...(prev.config.transition || {}), mode },
      },
    }));
  };

  const updateTransition = patch => {
    setDraft(prev => ({
      ...prev,
      config: {
        ...prev.config,
        transition: { ...(prev.config.transition || {}), ...patch },
      },
    }));
  };

  const updateConversion = patch => {
    setDraft(prev => ({
      ...prev,
      config: {
        ...prev.config,
        conversion: { ...(prev.config.conversion || {}), ...patch },
      },
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
    if (isConversionSource) {
      // Conversion widgets validate their own picker set; the measure /
      // group-by / chart-type rules below don't apply.
      const conv = draft.config.conversion || {};
      const convTargets = Array.isArray(conv.targetFormIds)
        ? conv.targetFormIds
        : conv.targetFormId
          ? [conv.targetFormId]
          : [];
      if (!conv.sourceFormId) errs.push("Choose a source form.");
      if (convTargets.length === 0) errs.push("Choose at least one target form.");
      if (conv.sourceFormId && convTargets.includes(conv.sourceFormId)) {
        errs.push("The source form cannot also be a target form.");
      }
      (draft.config.filters || []).forEach((f, i) => {
        if (!f.field && !f.fieldId) errs.push(`Filter ${i + 1}: choose a field.`);
        if (
          !["is_null", "is_not_null", "lmic"].includes(f.operator) &&
          (f.value === null || f.value === undefined || f.value === "")
        ) {
          errs.push(`Filter ${i + 1}: enter a value.`);
        }
      });
      return errs;
    }
    const tActive = !!draft.config.transition?.mode;
    if (tActive) {
      // Stage transitions count history events; group-by / time-bucket
      // don't apply, so only validate the single-transition picker.
      if (
        draft.config.transition.mode === "single" &&
        (!draft.config.transition.fromStage || !draft.config.transition.toStage)
      ) {
        errs.push("Pick a From stage and a To stage for the transition.");
      }
    } else {
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
      if (draft.widget_type === "list" && !draft.config.groupBy) {
        errs.push("List widgets need a group-by field.");
      }
      // "Date moved to stage …" needs a stage chosen alongside it.
      const tbOpt = draft.config.timeBucket?.field
        ? fieldOptions.find(o => o.fieldKind === "system" && o.field === draft.config.timeBucket.field)
        : null;
      if (tbOpt?.stageField && !draft.config.timeBucket?.stage) {
        errs.push("Pick a stage for the time bucket.");
      }
    }
    (draft.config.filters || []).forEach((f, i) => {
      if (!f.field && !f.fieldId) errs.push(`Filter ${i + 1}: choose a field.`);
      const fOpt = f.field
        ? fieldOptions.find(o => o.fieldKind === "system" && o.field === f.field)
        : null;
      if (fOpt?.stageField && !f.stage) errs.push(`Filter ${i + 1}: choose a stage.`);
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
  }, [draft, requireMeasureField, fieldOptions, isConversionSource]);

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
                  onValueChange={value =>
                    setDraft(prev => ({
                      ...prev,
                      widget_type: value,
                      // Cumulative only applies to line charts; clear the
                      // flag when switching to any other type so an invalid
                      // combination can never be saved.
                      config:
                        value === "line"
                          ? prev.config
                          : { ...prev.config, cumulative: false },
                    }))
                  }
                >
                  <SelectTrigger data-testid="select-widget-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WIDGET_TYPES
                      // Conversion widgets only render as a stat card.
                      .filter(t => !isConversionSource || t.value === "stat")
                      .map(t => (
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

            {draft.widget_type === "stat" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Number format</Label>
                  <Select
                    value={draft.config.numberFormat?.mode === "full" ? "full" : "compact"}
                    onValueChange={value =>
                      updateConfig({
                        numberFormat:
                          value === "full"
                            ? {
                                mode: "full",
                                decimals: Number.isInteger(
                                  draft.config.numberFormat?.decimals,
                                )
                                  ? draft.config.numberFormat.decimals
                                  : 0,
                              }
                            : null,
                      })
                    }
                  >
                    <SelectTrigger data-testid="select-widget-number-format">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="compact">Compact (e.g. 1.5M)</SelectItem>
                      <SelectItem value="full">Full number (e.g. 1,534,207)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.config.numberFormat?.mode === "full" && (
                  <div className="space-y-2">
                    <Label>Decimal places</Label>
                    <Select
                      value={String(
                        Number.isInteger(draft.config.numberFormat?.decimals)
                          ? draft.config.numberFormat.decimals
                          : 0,
                      )}
                      onValueChange={value =>
                        updateConfig({
                          numberFormat: { mode: "full", decimals: Number(value) },
                        })
                      }
                    >
                      <SelectTrigger data-testid="select-widget-decimals">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[0, 1, 2, 3, 4].map(d => (
                          <SelectItem key={d} value={String(d)}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

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
                onValueChange={value => {
                  const sel = sources.find(s => s.id === value);
                  const toConversion = !!sel?.isConversion;
                  setDraft(prev => ({
                    ...prev,
                    // Conversion widgets only render as a stat card.
                    widget_type: toConversion ? "stat" : prev.widget_type,
                    config: {
                      source: value,
                      measure: { aggregator: "count", field: null, fieldKind: null, fieldId: null },
                      groupBy: null,
                      timeBucket: null,
                      cumulative: false,
                      conversion: toConversion
                        ? { sourceFormId: null, targetFormIds: [], matchBy: "organization" }
                        : null,
                      // Display-only settings survive a source change.
                      color: prev.config.color || "default",
                      numberFormat: prev.config.numberFormat || null,
                      filters: [],
                    },
                  }));
                }}
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

            {isConversionSource && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1">
                  <Label>Form conversion</Label>
                  <p className="text-xs text-muted-foreground">
                    Counts how many distinct organisations or members submitted
                    the source form and any of the target forms. Date filters
                    apply to the target forms' submissions.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Source form</Label>
                    <Select
                      value={conversion?.sourceFormId || ""}
                      onValueChange={value => updateConversion({ sourceFormId: value })}
                    >
                      <SelectTrigger data-testid="select-conversion-source-form">
                        <SelectValue placeholder="Choose form" />
                      </SelectTrigger>
                      <SelectContent>
                        {conversionForms.map(f => (
                          <SelectItem key={f.value} value={f.value}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Target forms</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className="w-full justify-between font-normal"
                          data-testid="select-conversion-target-forms"
                        >
                          <span className="truncate">
                            {(() => {
                              const ids = conversion?.targetFormIds || [];
                              if (ids.length === 0) return "Choose forms";
                              if (ids.length === 1) {
                                return (
                                  conversionForms.find(f => f.value === ids[0])?.label ||
                                  "1 form"
                                );
                              }
                              return `${ids.length} forms selected`;
                            })()}
                          </span>
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 max-h-72 overflow-y-auto p-2" align="start">
                        {conversionForms.length === 0 ? (
                          <p className="p-2 text-sm text-muted-foreground">No forms found.</p>
                        ) : (
                          conversionForms.map(f => {
                            const ids = conversion?.targetFormIds || [];
                            const checked = ids.includes(f.value);
                            return (
                              <label
                                key={f.value}
                                className="hover-elevate flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                                data-testid={`option-conversion-target-${f.value}`}
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={on =>
                                    updateConversion({
                                      targetFormIds: on
                                        ? [...ids, f.value]
                                        : ids.filter(id => id !== f.value),
                                    })
                                  }
                                />
                                <span className="truncate">{f.label}</span>
                              </label>
                            );
                          })
                        )}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Match by</Label>
                  <Select
                    value={conversion?.matchBy || "organization"}
                    onValueChange={value => updateConversion({ matchBy: value })}
                  >
                    <SelectTrigger data-testid="select-conversion-matchby">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="organization">
                        Organisation (submission's organisation)
                      </SelectItem>
                      <SelectItem value="member">
                        Member (submitter's email)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {isDdSource && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="switch-dd-transition">Count stage transitions</Label>
                    <p className="text-xs text-muted-foreground">
                      Count moves between Due Diligence stages (e.g. New → Incomplete)
                      instead of current submissions.
                    </p>
                  </div>
                  <Switch
                    id="switch-dd-transition"
                    data-testid="switch-dd-transition"
                    checked={transitionActive}
                    onCheckedChange={setTransitionEnabled}
                  />
                </div>

                {transitionActive && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>Mode</Label>
                      <Select
                        value={transition.mode || "breakdown"}
                        onValueChange={setTransitionMode}
                      >
                        <SelectTrigger data-testid="select-transition-mode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="breakdown">All transitions (bar chart)</SelectItem>
                          <SelectItem value="single">Single transition (stat)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {transition.mode === "single" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>From stage</Label>
                          <Select
                            value={transition.fromStage || ""}
                            onValueChange={value => updateTransition({ fromStage: value })}
                          >
                            <SelectTrigger data-testid="select-transition-from">
                              <SelectValue placeholder="Choose stage" />
                            </SelectTrigger>
                            <SelectContent>
                              {ddStageOptions.map(o => (
                                <SelectItem key={o.value} value={String(o.value)}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>To stage</Label>
                          <Select
                            value={transition.toStage || ""}
                            onValueChange={value => updateTransition({ toStage: value })}
                          >
                            <SelectTrigger data-testid="select-transition-to">
                              <SelectValue placeholder="Choose stage" />
                            </SelectTrigger>
                            <SelectContent>
                              {ddStageOptions.map(o => (
                                <SelectItem key={o.value} value={String(o.value)}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Each stage change counts once — if a submission moves to a stage,
                      back, then forward again, that counts as two transitions. Date
                      filters apply to when the transition happened.
                    </p>
                  </div>
                )}
              </div>
            )}

            {!transitionActive && !isConversionSource && (
            <>
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
                        // Derived group-only dimensions (e.g. Region) have
                        // no stored column to measure over.
                        if (opt.groupOnly) return false;
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
              {(() => {
                // Derived Region group-by: offer the classification-scheme
                // picker. Absent scheme = app regions (legacy behaviour),
                // so existing widgets prefill to "App regions".
                const gb = draft.config.groupBy;
                if (!gb) return null;
                const selected = fieldOptions.find(
                  o => o.value === `${gb.kind}:${gb.field || gb.fieldId}`,
                );
                if (!selected?.regionSchemes) return null;
                return (
                  <div className="space-y-2 pt-1">
                    <Label>Region scheme</Label>
                    <Select
                      value={gb.regionScheme || "app"}
                      onValueChange={value => {
                        updateConfig({
                          groupBy: { ...gb, regionScheme: value },
                        });
                      }}
                    >
                      <SelectTrigger data-testid="select-widget-region-scheme">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {selected.regionSchemes.map(s => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })()}
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
                      // Clearing the bucket invalidates a cumulative line, so
                      // drop the flag alongside it.
                      updateConfig({ timeBucket: null, cumulative: false });
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

            {(() => {
              // When the chosen time-bucket field is the synthetic "Date moved
              // to stage …" DD field, surface a stage picker — the count is
              // bucketed by when each submission first entered that stage.
              const tb = draft.config.timeBucket;
              const opt = tb?.field
                ? fieldOptions.find(o => o.fieldKind === "system" && o.field === tb.field)
                : null;
              if (!opt?.stageField) return null;
              return (
                <div className="space-y-2">
                  <Label>Stage</Label>
                  <Select
                    value={tb.stage || ""}
                    onValueChange={value =>
                      updateConfig({ timeBucket: { ...tb, stage: value } })
                    }
                  >
                    <SelectTrigger data-testid="select-widget-timebucket-stage">
                      <SelectValue placeholder="Choose stage" />
                    </SelectTrigger>
                    <SelectContent>
                      {(opt.stageOptions || []).map(o => (
                        <SelectItem key={o.value} value={String(o.value)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Counts each submission once, in the period it first reached
                    this stage. Submissions that never reached it are excluded.
                  </p>
                </div>
              );
            })()}

            {draft.widget_type === "line" && draft.config.timeBucket?.field && (
              <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                <div className="space-y-1">
                  <Label htmlFor="switch-widget-cumulative">
                    Cumulative (running total)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Plot a running total across buckets instead of the
                    value per bucket.
                  </p>
                </div>
                <Switch
                  id="switch-widget-cumulative"
                  data-testid="switch-widget-cumulative"
                  checked={!!draft.config.cumulative}
                  onCheckedChange={checked =>
                    updateConfig({ cumulative: checked })
                  }
                />
              </div>
            )}
            </>
            )}

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
                      className="space-y-2 rounded-md border p-2"
                      data-testid={`filter-row-${idx}`}
                    >
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                      <Select
                        value={opt?.value || ""}
                        onValueChange={value => {
                          const sel = fieldOptions.find(o => o.value === value);
                          if (!sel) return;
                          updateFilter(idx, {
                            fieldKind: sel.fieldKind,
                            field: sel.field,
                            fieldId: sel.fieldId,
                            // Stage only applies to the synthetic DD stage
                            // field; drop it when switching to anything else.
                            stage: sel.stageField ? (filter.stage || null) : null,
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Field" />
                        </SelectTrigger>
                        <SelectContent>
                          {fieldOptions
                            // Derived group-only dimensions (e.g. Region)
                            // can't be filtered — no stored column.
                            .filter(o => !o.groupOnly)
                            .map(o => (
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
                      {["is_null", "is_not_null", "lmic"].includes(filter.operator) ? (
                        <div />
                      ) : opt?.options?.length &&
                        ["eq", "neq"].includes(filter.operator) ? (
                        <Select
                          value={
                            filter.value === null || filter.value === undefined
                              ? ""
                              : String(filter.value)
                          }
                          onValueChange={value => updateFilter(idx, { value })}
                        >
                          <SelectTrigger data-testid={`select-filter-value-${idx}`}>
                            <SelectValue placeholder="Choose value" />
                          </SelectTrigger>
                          <SelectContent>
                            {opt.options.map(o => (
                              <SelectItem key={o.value} value={String(o.value)}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
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
                    {opt?.stageField && (
                      <Select
                        value={filter.stage || ""}
                        onValueChange={value => updateFilter(idx, { stage: value })}
                      >
                        <SelectTrigger data-testid={`select-filter-stage-${idx}`}>
                          <SelectValue placeholder="Choose stage to scope by" />
                        </SelectTrigger>
                        <SelectContent>
                          {(opt.stageOptions || []).map(o => (
                            <SelectItem key={o.value} value={String(o.value)}>
                              {o.label}
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
  if (payload.type === "conversion") {
    const rate = payload.conversionRate;
    return (
      <div className="space-y-1">
        <p className="text-3xl font-semibold tracking-tight">
          {formatNumber(payload.convertedCount, widget.config.numberFormat)}
          {rate !== null && rate !== undefined && (
            <span className="ml-2 text-base font-normal text-muted-foreground">
              ({rate.toFixed(1)}% converted)
            </span>
          )}
        </p>
        <p className="text-xs uppercase text-muted-foreground">
          {payload.sourceEntityCount ?? payload.sourceSubmissionCount ?? 0}{" "}
          source ·{" "}
          {payload.notConvertedCount ??
            Math.max(
              0,
              (payload.sourceEntityCount ?? payload.sourceSubmissionCount ?? 0) -
                (payload.convertedCount ?? 0),
            )}{" "}
          not converted{" "}
          {payload.matchBy === "member" ? "members" : "organisations"}
        </p>
      </div>
    );
  }
  switch (widget.widget_type) {
    case "stat": {
      const value = payload.type === "scalar" ? payload.value : rows[0]?.value;
      return (
        <div className="space-y-1">
          <p className="text-3xl font-semibold tracking-tight">
            {widget.config.numberFormat?.mode === "full"
              ? formatNumber(value, widget.config.numberFormat)
              : value === null || value === undefined
                ? "—"
                : Number(value).toLocaleString()}
          </p>
          <p className="text-xs uppercase text-muted-foreground">
            {widget.config.transition?.mode
              ? `${payload.total ?? 0} transition${payload.total === 1 ? "" : "s"}`
              : `${widget.config.measure?.aggregator || "count"} · ${payload.total ?? 0} record${
                  payload.total === 1 ? "" : "s"
                }`}
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
    case "list": {
      if (rows.length === 0) return <EmptyPreview />;
      const listTotal = rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0);
      return (
        <div className="flex flex-col gap-2">
          <div className="max-h-56 overflow-y-auto rounded-md border" data-testid="preview-list">
            {rows.map((row, idx) => (
              <div
                key={`${row.key}-${idx}`}
                className={cn(
                  "flex items-center justify-between gap-3 px-3 py-1.5 text-sm",
                  idx > 0 && "border-t",
                )}
              >
                <span className="min-w-0 flex-1 truncate" title={row.key}>{row.key}</span>
                <span className="shrink-0 tabular-nums font-medium">{formatNumber(row.value)}</span>
              </div>
            ))}
          </div>
          <p className="text-right text-xs text-muted-foreground">
            {rows.length} group{rows.length === 1 ? "" : "s"} · Total: {formatNumber(listTotal)}
          </p>
        </div>
      );
    }
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
